//! Wicklee local metrics store — DuckDB three-tier columnar schema.
//!
//! Tier 0 (metrics_raw):   1 Hz samples,       24-hour retention
//! Tier 1 (metrics_1min):  1-minute aggregates, 30-day  retention
//! Tier 2 (metrics_1hr):   1-hour  aggregates,  90-day  retention
//!
//! Aggregated tiers (1min/1hr) are keyed by (ts_ms, node_id) — i.e. node-level,
//! not per-model — because `model` is nullable during idle and so cannot be part
//! of the primary key. Each aggregated bucket is labelled with its dominant model
//! (most raw samples). Per-model breakdowns are exact only from the raw tier
//! (≤24 h); model-attributed history beyond that is approximate for buckets that
//! straddle a model switch.
//!
//! All timestamps are stored as INTEGER (Unix milliseconds) so serialisation
//! to JSON never requires format negotiation.
//!
//! The `Store` handle is `Clone`-cheap (Arc inside) and `Send + Sync` — safe to
//! share between the broadcast-writer task and the Axum `/api/history` handler.
//!
//! # Threading model
//! DuckDB's `Connection` is `Send` but not `Sync`; the `Mutex<Connection>`
//! wrapper makes the store `Sync`. Writes from the async broadcast subscriber
//! are quick (single-row inserts at 1 Hz), but the same mutex also serialises
//! the read-side queries (`/api/history`, SLA, profile, audit export) and the
//! hourly aggregation — so any blocking DB call MUST run inside
//! `tokio::task::spawn_blocking` to keep the async executor free.

use std::path::Path;
use std::sync::{Arc, Mutex};

use duckdb::{params, Connection};
use serde::{Deserialize, Serialize};

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Convert Unix milliseconds to an ISO 8601 UTC string: `YYYY-MM-DDTHH:MM:SS.mmmZ`.
/// Hand-rolled to avoid pulling in the chrono crate.
fn millis_to_iso8601(ms: i64) -> String {
    let total_secs = ms.div_euclid(1000);
    let frac_ms    = ms.rem_euclid(1000) as u32;

    // Days since Unix epoch using the civil-from-days algorithm (Howard Hinnant).
    let mut days  = total_secs.div_euclid(86400);
    let day_secs  = total_secs.rem_euclid(86400) as u32;
    let hh        = day_secs / 3600;
    let mm        = (day_secs % 3600) / 60;
    let ss        = day_secs % 60;

    days += 719_468; // shift epoch from 1970-01-01 to 0000-03-01
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let doe = (days - era * 146_097) as u32; // day of era [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y   = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp  = (5 * doy + 2) / 153;
    let d   = doy - (153 * mp + 2) / 5 + 1;
    let m   = if mp < 10 { mp + 3 } else { mp - 9 };
    let y   = if m <= 2 { y + 1 } else { y };

    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", y, m, d, hh, mm, ss, frac_ms)
}

// ── Sample ────────────────────────────────────────────────────────────────────

/// A single 1-Hz metric snapshot extracted from a MetricsPayload broadcast frame.
/// Only the fields we persist — keeps the schema focused and easy to extend.
pub struct Sample {
    pub ts_ms:            i64,
    pub node_id:          String,
    pub model:            Option<String>,
    pub tps:              Option<f64>,
    pub cpu_usage_pct:    f64,
    pub mem_used_mb:      i64,
    pub mem_total_mb:     i64,
    pub cpu_power_w:      Option<f64>,
    pub gpu_power_w:      Option<f64>,
    pub gpu_util_pct:     Option<f64>,
    pub vram_used_mb:     Option<i64>,
    pub vram_total_mb:    Option<i64>,
    pub thermal_state:    Option<String>,
    pub mem_pressure_pct: Option<f64>,
    pub swap_write_mb_s:  Option<f64>,
    pub clock_throttle_pct: Option<f64>,
    // Phase 4: inference latency metrics
    pub ttft_ms:          Option<f64>,
    pub avg_latency_ms:   Option<f64>,
    pub queue_depth:      Option<i64>,
    // Phase 2: backend pattern evaluation fields
    pub penalty_avg:           Option<f64>,
    pub nvidia_gpu_temp_c:     Option<i32>,
    pub vllm_cache_usage_perc: Option<f64>,
}

/// Minimal subset of MetricsPayload for JSON deserialization.
/// `#[serde(default)]` handles fields omitted by `skip_serializing_if` guards.
#[derive(Deserialize)]
struct BroadcastFrame {
    node_id:                         String,
    timestamp_ms:                    u64,
    cpu_usage_percent:               f32,
    used_memory_mb:                  u64,
    total_memory_mb:                 u64,
    #[serde(default)] ollama_tokens_per_second:        Option<f32>,
    #[serde(default)] vllm_tokens_per_sec:             Option<f32>,
    #[serde(default)] ollama_active_model:             Option<String>,
    #[serde(default)] vllm_model_name:                 Option<String>,
    #[serde(default)] cpu_power_w:                     Option<f32>,
    #[serde(default)] apple_soc_power_w:               Option<f32>,
    #[serde(default)] nvidia_power_draw_w:             Option<f32>,
    #[serde(default)] nvidia_gpu_utilization_percent:  Option<f32>,
    #[serde(default)] gpu_utilization_percent:         Option<f32>,
    #[serde(default)] nvidia_vram_used_mb:             Option<u64>,
    #[serde(default)] nvidia_vram_total_mb:            Option<u64>,
    #[serde(default)] thermal_state:                   Option<String>,
    #[serde(default)] memory_pressure_percent:         Option<f32>,
    #[serde(default)] swap_write_mb_s:                 Option<f32>,
    #[serde(default)] clock_throttle_pct:              Option<f32>,
    // Phase 4: latency metrics (best available from vLLM, Ollama probe, or proxy)
    #[serde(default)] vllm_avg_ttft_ms:               Option<f32>,
    #[serde(default)] ollama_ttft_ms:                  Option<f32>,
    #[serde(default)] ollama_proxy_avg_ttft_ms:        Option<f32>,
    #[serde(default)] vllm_avg_e2e_latency_ms:         Option<f32>,
    #[serde(default)] ollama_proxy_avg_latency_ms:     Option<f32>,
    #[serde(default)] vllm_requests_waiting:           Option<u32>,
    // Phase 2: backend pattern evaluation fields
    #[serde(default)] penalty_avg:                     Option<f32>,
    #[serde(default)] nvidia_gpu_temp_c:               Option<u32>,
    #[serde(default)] vllm_cache_usage_perc:           Option<f32>,
}

impl BroadcastFrame {
    fn into_sample(self) -> Sample {
        Sample {
            ts_ms:            self.timestamp_ms as i64,
            node_id:          self.node_id,
            // Prefer Ollama model name; fall back to vLLM.
            model:            self.ollama_active_model.or(self.vllm_model_name),
            // Prefer Ollama tok/s; add vLLM if both active simultaneously.
            tps:              match (self.ollama_tokens_per_second, self.vllm_tokens_per_sec) {
                (Some(o), Some(v)) => Some((o + v) as f64),
                (Some(o), None)    => Some(o as f64),
                (None,    Some(v)) => Some(v as f64),
                (None,    None)    => None,
            },
            cpu_usage_pct:    self.cpu_usage_percent as f64,
            mem_used_mb:      self.used_memory_mb  as i64,
            mem_total_mb:     self.total_memory_mb as i64,
            cpu_power_w:      self.cpu_power_w.map(|v| v as f64),
            // NVIDIA: nvidia_power_draw_w. Apple: apple_soc_power_w (Combined CPU+GPU+ANE).
            // Priority: NVIDIA board power → Apple SoC total → None.
            gpu_power_w:      self.nvidia_power_draw_w
                                  .or(self.apple_soc_power_w)
                                  .map(|v| v as f64),
            // NVIDIA preferred; fall back to Apple Silicon iogpu utilization.
            gpu_util_pct:     self.nvidia_gpu_utilization_percent
                                  .or(self.gpu_utilization_percent)
                                  .map(|v| v as f64),
            vram_used_mb:     self.nvidia_vram_used_mb.map(|v| v as i64),
            vram_total_mb:    self.nvidia_vram_total_mb.map(|v| v as i64),
            thermal_state:    self.thermal_state,
            mem_pressure_pct: self.memory_pressure_percent.map(|v| v as f64),
            swap_write_mb_s:  self.swap_write_mb_s.map(|v| v as f64),
            clock_throttle_pct: self.clock_throttle_pct.map(|v| v as f64),
            // Best-available TTFT: vLLM histogram avg > proxy rolling avg > Ollama probe
            ttft_ms:          self.vllm_avg_ttft_ms
                                  .or(self.ollama_proxy_avg_ttft_ms)
                                  .or(self.ollama_ttft_ms)
                                  .map(|v| v as f64),
            // Best-available E2E latency: vLLM histogram > proxy rolling avg
            avg_latency_ms:   self.vllm_avg_e2e_latency_ms
                                  .or(self.ollama_proxy_avg_latency_ms)
                                  .map(|v| v as f64),
            // Queue depth: vLLM waiting requests
            queue_depth:           self.vllm_requests_waiting.map(|v| v as i64),
            // Phase 2: backend pattern evaluation fields
            penalty_avg:           self.penalty_avg.map(|v| v as f64),
            nvidia_gpu_temp_c:     self.nvidia_gpu_temp_c.map(|v| v as i32),
            vllm_cache_usage_perc: self.vllm_cache_usage_perc.map(|v| v as f64),
        }
    }
}

impl Sample {
    /// Parse a MetricsPayload JSON broadcast frame into a storable Sample.
    pub fn from_broadcast_json(json: &str) -> Result<Self, serde_json::Error> {
        let frame: BroadcastFrame = serde_json::from_str(json)?;
        Ok(frame.into_sample())
    }
}

// ── Resolution ────────────────────────────────────────────────────────────────

/// Which tier to query.  `auto` picks the best tier for the requested window.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Resolution {
    Raw,
    OneMin,
    OneHr,
}

impl Resolution {
    /// Auto-select based on window width.
    ///  < 2 h  → Raw (full 1-Hz resolution)
    ///  < 7 d  → 1-minute aggregates
    ///  else   → 1-hour aggregates
    pub fn auto(from_ms: i64, to_ms: i64) -> Self {
        let w = to_ms.saturating_sub(from_ms).max(0);
        if w < 2 * 3_600_000 {
            Self::Raw
        } else if w < 7 * 86_400_000 {
            Self::OneMin
        } else {
            Self::OneHr
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Raw    => "raw",
            Self::OneMin => "1min",
            Self::OneHr  => "1hr",
        }
    }
}

impl std::str::FromStr for Resolution {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, ()> {
        match s {
            "raw"  => Ok(Self::Raw),
            "1min" => Ok(Self::OneMin),
            "1hr"  => Ok(Self::OneHr),
            _      => Err(()),
        }
    }
}

// ── Response types ─────────────────────────────────────────────────────────────

/// One data point in a history response.
/// Raw samples carry `tps`; aggregated tiers carry `tps_avg` / `tps_max`.
/// Fields absent in the queried tier are omitted from the JSON payload.
#[derive(Debug, Serialize)]
pub struct HistorySample {
    pub ts_ms:         i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model:         Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tps:           Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tps_avg:       Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tps_max:       Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tps_p95:       Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_usage_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_util_pct:  Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_power_w:   Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vram_used_mb:  Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thermal_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_power_w:    Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mem_pressure_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swap_write_mb_s: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clock_throttle_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttft_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avg_latency_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_depth: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct HistoryResponse {
    pub node_id:    String,
    pub resolution: &'static str,
    pub from_ms:    i64,
    pub to_ms:      i64,
    pub samples:    Vec<HistorySample>,
}

// ── Inference Traces ──────────────────────────────────────────────────────────

/// Internal write struct for an inference trace captured by the Ollama proxy.
/// `Clone` so a test can vary one field of a row; the writer moves it.
#[derive(Clone)]
pub(crate) struct TraceRow {
    pub id: String,
    pub ts_ms: i64,
    pub node_id: String,
    pub model: String,
    pub latency_ms: i64,
    pub ttft_ms: i64,
    pub tpot_ms: f64,
    pub status: i32,
    pub eval_count: Option<i64>,
    pub eval_duration_ns: Option<i64>,
    // ── Step 5 ───────────────────────────────────────────────────────────────
    // The spec widens this row with the first three. The last two are a
    // deviation worth stating: `latency_ms` and `ttft_ms` above are the same
    // numbers rounded to milliseconds, and a receipt is the one artifact in
    // Phase 1 that claims to be exact, so it needs the nanoseconds the
    // runtime actually reported. Carrying them here rather than on a parallel
    // channel means one row describes one request, and the proxy sends the
    // done packet's contents once.
    pub load_duration_ns: Option<i64>,
    pub prompt_eval_count: Option<i64>,
    /// Prompt tokens served from the KV cache rather than recomputed. A high
    /// share of these is why a repeated prompt looks impossibly fast.
    pub prompt_eval_cached_count: Option<i64>,
    pub prompt_eval_duration_ns: Option<i64>,
    pub total_duration_ns: Option<i64>,
}

/// JSON-serialisable trace record returned by `GET /api/traces`.
#[derive(Serialize)]
pub(crate) struct TraceRecord {
    pub id: String,
    pub timestamp: String,        // ISO 8601
    #[serde(rename = "nodeId")]
    pub node_id: String,
    pub model: String,
    pub latency: i64,             // ms
    pub ttft: i64,                // ms
    pub tpot: f64,                // ms/tok
    pub status: i32,
}

/// A persisted Live Activity event record returned by `query_events`.
#[derive(Debug, Serialize)]
pub struct EventRecord {
    pub ts_ms:      i64,
    pub timestamp:  String,   // ISO 8601
    pub node_id:    String,
    pub level:      String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_type: Option<String>,
    pub message:    String,
}

/// A single persisted dismiss record returned by `query_active_dismissals`.
#[derive(Debug, Serialize)]
pub struct Dismissal {
    pub pattern_id:      String,
    /// Empty string means fleet-wide (no specific node).
    pub node_id:         String,
    pub dismissed_at_ms: i64,
    pub expires_at_ms:   i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note:            Option<String>,
}

// ── SLA Monitor types ───────────────────────────────────────────────────────

/// p50/p95/p99/max for one latency dimension.  Returned by `query_sla()`.
#[derive(Debug, Serialize)]
pub struct SlaPercentiles {
    pub p50: f64,
    pub p95: f64,
    pub p99: f64,
    pub max: f64,
}

/// Per-model breakdown row for the SLA summary.
#[derive(Debug, Serialize)]
pub struct SlaModelRow {
    pub model:        String,
    pub count:        i64,
    pub p95_ttft_ms:  f64,
    pub p95_e2e_ms:   f64,
}

/// One TTFT-violation row for the recent-violations list.
#[derive(Debug, Serialize)]
pub struct SlaViolation {
    pub ts_ms:      i64,
    pub model:      String,
    pub ttft_ms:    i64,
    pub latency_ms: i64,
}

/// SLA compliance + violations against a configured TTFT target.
#[derive(Debug, Serialize)]
pub struct SlaCompliance {
    pub target_ttft_ms:    i64,
    pub compliance_pct:    f64,
    pub violations_count:  i64,
    pub violations:        Vec<SlaViolation>,
}

/// Aggregated SLA summary returned by `GET /api/sla`.
#[derive(Debug, Serialize)]
pub struct SlaSummary {
    pub window_minutes:   i64,
    pub window_start_ms:  i64,
    pub request_count:    i64,
    pub error_count:      i64,
    pub error_rate_pct:   f64,
    pub ttft:             SlaPercentiles,
    pub e2e:              SlaPercentiles,
    pub tpot:             SlaPercentiles,
    pub sla:              SlaCompliance,
    pub by_model:         Vec<SlaModelRow>,
}

// ── Store ─────────────────────────────────────────────────────────────────────

/// Shared DuckDB metrics store.  Clone-cheap (Arc inside).
/// All methods are synchronous — use `tokio::task::spawn_blocking` for
/// long-running operations (aggregation, large history queries) in async code.
#[derive(Clone)]
pub struct Store(Arc<Mutex<Connection>>);

impl Store {
    /// Open (or create) the DuckDB database at `path` and initialise the schema.
    /// Creating the parent directory is the caller's responsibility.
    pub fn open(path: &Path) -> Result<Self, duckdb::Error> {
        let conn = Connection::open(path)?;
        let store = Self(Arc::new(Mutex::new(conn)));
        store.init_schema()?;
        Ok(store)
    }

    fn init_schema(&self) -> Result<(), duckdb::Error> {
        // ── Baseline schema (CREATE TABLE) ───────────────────────────────────
        // These are the foundational tables. If any one of them fails, the
        // store cannot operate — propagate the error so Store::open returns
        // Err and main.rs disables the DuckDB-gated routes. ALTER statements
        // (additive column migrations) are split into a tolerant pass below
        // so a single bad migration cannot strip the whole feature surface.
        self.0.lock().unwrap().execute_batch("
            -- Tier 0: raw 1-Hz samples, 24-hour retention.
            -- PRIMARY KEY enforces uniqueness; ON CONFLICT DO NOTHING in write_sample
            -- silently drops clock-adjustment or restart duplicates.
            CREATE TABLE IF NOT EXISTS metrics_raw (
                ts_ms            BIGINT  NOT NULL,
                node_id          TEXT    NOT NULL,
                model            TEXT,
                tps              DOUBLE,
                cpu_usage_pct    DOUBLE  NOT NULL,
                mem_used_mb      BIGINT  NOT NULL,
                mem_total_mb     BIGINT  NOT NULL,
                cpu_power_w      DOUBLE,
                gpu_power_w      DOUBLE,
                gpu_util_pct     DOUBLE,
                vram_used_mb     BIGINT,
                vram_total_mb    BIGINT,
                thermal_state    TEXT,
                mem_pressure_pct DOUBLE,
                swap_write_mb_s  DOUBLE,
                clock_throttle_pct DOUBLE,
                PRIMARY KEY (ts_ms, node_id)
            );

            -- Tier 1: 1-minute aggregates, 30-day retention.
            CREATE TABLE IF NOT EXISTS metrics_1min (
                ts_ms         BIGINT   NOT NULL,
                node_id       TEXT     NOT NULL,
                model         TEXT,
                tps_avg       DOUBLE,
                tps_max       DOUBLE,
                tps_min       DOUBLE,
                cpu_usage_avg DOUBLE,
                gpu_util_avg  DOUBLE,
                gpu_power_avg DOUBLE,
                vram_used_avg BIGINT,
                sample_count  INTEGER  NOT NULL,
                PRIMARY KEY (ts_ms, node_id)
            );

            -- Tier 2: 1-hour aggregates, 90-day retention.
            -- tps_p95 uses PERCENTILE_CONT — only available once DuckDB aggregates
            -- from the 1-minute tier (not from raw directly).
            CREATE TABLE IF NOT EXISTS metrics_1hr (
                ts_ms         BIGINT   NOT NULL,
                node_id       TEXT     NOT NULL,
                model         TEXT,
                tps_avg       DOUBLE,
                tps_max       DOUBLE,
                tps_p95       DOUBLE,
                cpu_usage_avg DOUBLE,
                gpu_util_avg  DOUBLE,
                gpu_power_avg DOUBLE,
                vram_used_avg BIGINT,
                sample_count  INTEGER  NOT NULL,
                PRIMARY KEY (ts_ms, node_id)
            );

            -- Insight dismissals: persists operator suppress decisions across
            -- page refreshes and agent restarts.
            -- node_id uses '' (empty string) as sentinel for fleet-wide dismissals
            -- (avoids NULL primary-key semantics).
            -- expires_at_ms: epoch ms — frontend and agent both respect this.
            -- Re-dismissing the same pattern+node upserts and resets the expiry.
            CREATE TABLE IF NOT EXISTS accepted_states (
                pattern_id      TEXT    NOT NULL,
                node_id         TEXT    NOT NULL DEFAULT '',
                dismissed_at_ms BIGINT  NOT NULL,
                expires_at_ms   BIGINT  NOT NULL,
                note            TEXT,
                PRIMARY KEY (pattern_id, node_id)
            );

            -- Inference traces: per-request timing from the Ollama proxy.
            -- 24-hour retention, pruned alongside metrics_raw.
            CREATE TABLE IF NOT EXISTS inference_traces (
                id                TEXT    PRIMARY KEY,
                ts_ms             BIGINT  NOT NULL,
                node_id           TEXT    NOT NULL,
                model             TEXT    NOT NULL DEFAULT '',
                latency_ms        BIGINT  NOT NULL,
                ttft_ms           BIGINT  NOT NULL,
                tpot_ms           DOUBLE  NOT NULL,
                status            INTEGER NOT NULL,
                eval_count        BIGINT,
                eval_duration_ns  BIGINT,
                load_duration_ns         BIGINT,
                prompt_eval_count        BIGINT,
                prompt_eval_cached_count BIGINT,
                prompt_eval_duration_ns  BIGINT,
                total_duration_ns        BIGINT
            );

            -- Node events: persisted Live Activity events for the Observability tab.
            -- 7-day retention, pruned alongside metrics.  Composite PK deduplicates
            -- naturally (same timestamp + node + message = same event).
            CREATE TABLE IF NOT EXISTS node_events (
                ts_ms       BIGINT  NOT NULL,
                node_id     TEXT    NOT NULL,
                level       TEXT    NOT NULL DEFAULT 'info',
                event_type  TEXT,
                message     TEXT    NOT NULL,
                PRIMARY KEY (ts_ms, node_id, message)
            );

            -- Model catalog: cached HuggingFace GGUF model metadata for fit scoring.
            -- 24h TTL, refreshed on demand or by background task.
            CREATE TABLE IF NOT EXISTS model_catalog (
                model_id    TEXT    NOT NULL,
                filename    TEXT    NOT NULL,
                quant_level TEXT    NOT NULL,
                file_size   BIGINT  NOT NULL,
                downloads   BIGINT  NOT NULL DEFAULT 0,
                likes       BIGINT  NOT NULL DEFAULT 0,
                fetched_at  BIGINT  NOT NULL,
                PRIMARY KEY (model_id, filename)
            );

            -- Residency transition log: one row per observed change in what the
            -- runtime holds. Written by the residency tracker, which is fed by
            -- the harvester's existing /api/ps poll -- no new poller.
            --
            -- Append-only, and deliberately without a primary key. `id` is
            -- unique within one agent process and restarts at 1, so it is not a
            -- durable key; the durable identity of a row is
            -- (node_id, ts_ms, model, kind). before_state and after_state hold
            -- the serialised ModelState, so a reader can reconstruct the whole
            -- transition without this schema having to grow a column for every
            -- field a later rule wants.
            CREATE TABLE IF NOT EXISTS model_transitions (
                id           BIGINT  NOT NULL,
                ts_ms        BIGINT  NOT NULL,
                node_id      TEXT    NOT NULL,
                model        TEXT    NOT NULL,
                kind         TEXT    NOT NULL,
                cause        TEXT    NOT NULL,
                co_resident  TEXT    NOT NULL DEFAULT '',
                before_state TEXT,
                after_state  TEXT
            );

            -- Open and resolved findings.
            --
            -- Unlike model_transitions this one HAS a durable key: a finding's
            -- id is content-derived from its rule and the models it names, so
            -- the same condition keeps the same row across restarts. That is
            -- the whole reason the id is not a counter — step 6's `verify`
            -- compares two runs of one finding and needs to find the earlier
            -- one.
            --
            -- A row is open while resolved_at_ms IS NULL. Resolution is
            -- observed rather than scheduled: an evaluation that no longer
            -- produces a finding resolves it, so the column records when
            -- Wicklee last looked and did not see it, not when the condition
            -- actually stopped.
            --
            -- statements holds the serialised Vec<Statement>, for the same
            -- reason before_state does above: a later rule's new field must not
            -- need a schema change.
            -- One exact measurement of one request. See receipts.rs for
            -- what each source is worth; the column set is that struct.
            --
            -- Durations stay in nanoseconds, in the runtime's own field
            -- names. Converting on the way in would mean every reader
            -- converting back to compare against a raw response, and a unit
            -- converted twice is a unit converted wrong.
            --
            -- The primary key is content-derived, so a caller that retries a
            -- POST stores one receipt rather than two. That matters more than
            -- it sounds: a double-counted receipt pulls a median toward
            -- whichever request happened to be retried.
            CREATE TABLE IF NOT EXISTS receipts (
                node_id                  TEXT   NOT NULL,
                id                       TEXT   NOT NULL,
                ts_ms                    BIGINT NOT NULL,
                source                   TEXT   NOT NULL,
                model                    TEXT   NOT NULL,
                digest                   TEXT,
                context_length           BIGINT,
                size_bytes               BIGINT,
                size_vram_bytes          BIGINT,
                start_state              TEXT   NOT NULL,
                load_ns                  BIGINT,
                prompt_eval_count        BIGINT,
                prompt_eval_cached_count BIGINT,
                prompt_eval_ns           BIGINT,
                eval_count               BIGINT,
                eval_ns                  BIGINT,
                total_ns                 BIGINT,
                wall_ms                  BIGINT,
                co_resident              TEXT   NOT NULL DEFAULT '',
                thermal_state            TEXT,
                test_id                  TEXT,
                finding_id               TEXT,
                PRIMARY KEY (node_id, id)
            );

            -- A stored run of a finding's test. Step 6's `verify` compares
            -- two of these.
            --
            -- config holds the serialised Vec<ModelState> from when the run
            -- started, for the same reason findings.statements is JSON: the
            -- only consumer is a diff between two snapshots, and a column per
            -- field would need a migration every time ModelState grows.
            --
            -- Kept as long as a resolved finding, 30 days. A baseline that
            -- expires before the operator changes the thing it measured is
            -- not a baseline.
            CREATE TABLE IF NOT EXISTS verify_runs (
                node_id    TEXT   NOT NULL,
                id         TEXT   NOT NULL,
                finding_id TEXT   NOT NULL,
                ts_ms      BIGINT NOT NULL,
                config     TEXT,
                models     TEXT   NOT NULL DEFAULT '',
                receipts   TEXT   NOT NULL DEFAULT '',
                median     DOUBLE NOT NULL,
                low        DOUBLE NOT NULL,
                high       DOUBLE NOT NULL,
                PRIMARY KEY (node_id, id)
            );

            CREATE TABLE IF NOT EXISTS findings (
                node_id        TEXT   NOT NULL,
                id             TEXT   NOT NULL,
                rule           TEXT   NOT NULL,
                severity       TEXT   NOT NULL,
                title          TEXT   NOT NULL,
                models         TEXT   NOT NULL DEFAULT '',
                statements     TEXT,
                first_seen_ms  BIGINT NOT NULL,
                last_seen_ms   BIGINT NOT NULL,
                resolved_at_ms BIGINT,
                PRIMARY KEY (node_id, id)
            );
        ")?;

        // ── Additive column migrations (tolerant) ────────────────────────────
        // Each ALTER runs in its own execute() call so a single statement
        // failure cannot abort the batch and kill Store::open. The whole
        // feature surface (~12 routes — model-candidates, sla, profile,
        // history, traces, events/history, observations, cost-by-model,
        // model-comparison, …) is gated on Store being Some(_) in main.rs;
        // one bad ALTER previously stripped all of them silently. Now any
        // ALTER failure is logged but ignored — the column was either
        // already there, or the DuckDB version doesn't support the syntax,
        // either of which is recoverable: query code uses .unwrap_or
        // defaults when a column is absent.
        //
        // Note: a literal `ALTER TABLE ... ADD COLUMN ... NOT NULL` on a
        // table with existing rows is rejected by DuckDB even with a
        // DEFAULT. Always omit NOT NULL on additive migrations.
        let migrations: &[&str] = &[
            "ALTER TABLE metrics_raw ADD COLUMN IF NOT EXISTS swap_write_mb_s      DOUBLE",
            "ALTER TABLE metrics_raw ADD COLUMN IF NOT EXISTS clock_throttle_pct   DOUBLE",
            "ALTER TABLE metrics_raw ADD COLUMN IF NOT EXISTS ttft_ms              DOUBLE",
            "ALTER TABLE metrics_raw ADD COLUMN IF NOT EXISTS avg_latency_ms       DOUBLE",
            "ALTER TABLE metrics_raw ADD COLUMN IF NOT EXISTS queue_depth          BIGINT",
            // Phase 2 — backend pattern evaluation (C/I/M/N)
            "ALTER TABLE metrics_raw ADD COLUMN IF NOT EXISTS penalty_avg          DOUBLE",
            "ALTER TABLE metrics_raw ADD COLUMN IF NOT EXISTS nvidia_gpu_temp_c    INTEGER",
            "ALTER TABLE metrics_raw ADD COLUMN IF NOT EXISTS vllm_cache_usage_perc DOUBLE",
            // HF likes — nullable so existing-row tables accept the migration.
            "ALTER TABLE model_catalog ADD COLUMN IF NOT EXISTS likes BIGINT DEFAULT 0",
            // Step 5: the proxy's done packet, in full. An existing database
            // has the old ten columns, so these arrive by migration.
            "ALTER TABLE inference_traces ADD COLUMN IF NOT EXISTS load_duration_ns         BIGINT",
            "ALTER TABLE inference_traces ADD COLUMN IF NOT EXISTS prompt_eval_count        BIGINT",
            "ALTER TABLE inference_traces ADD COLUMN IF NOT EXISTS prompt_eval_cached_count BIGINT",
            "ALTER TABLE inference_traces ADD COLUMN IF NOT EXISTS prompt_eval_duration_ns  BIGINT",
            "ALTER TABLE inference_traces ADD COLUMN IF NOT EXISTS total_duration_ns        BIGINT",
        ];
        {
            let conn = self.0.lock().unwrap();
            for sql in migrations {
                if let Err(e) = conn.execute(sql, []) {
                    eprintln!("[store] migration skipped ({e}): {sql}");
                }
            }
        }
        Ok(())
    }

    // ── Write ─────────────────────────────────────────────────────────────────

    /// Insert one raw sample.
    /// Conflicts (same ts_ms + node_id) are silently discarded — safe on restart
    /// within the same wall-clock second or minor clock adjustments.
    pub fn write_sample(&self, s: Sample) -> Result<(), duckdb::Error> {
        // 1 Hz hot path: prepare_cached reuses the parsed/planned statement
        // instead of re-parsing this 22-column INSERT every second.
        self.0.lock().unwrap().prepare_cached(
            "INSERT INTO metrics_raw
             (ts_ms, node_id, model, tps,
              cpu_usage_pct, mem_used_mb, mem_total_mb,
              cpu_power_w, gpu_power_w, gpu_util_pct,
              vram_used_mb, vram_total_mb, thermal_state, mem_pressure_pct,
              swap_write_mb_s, clock_throttle_pct,
              ttft_ms, avg_latency_ms, queue_depth,
              penalty_avg, nvidia_gpu_temp_c, vllm_cache_usage_perc)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (ts_ms, node_id) DO NOTHING",
        )?.execute(
            params![
                s.ts_ms,
                s.node_id.as_str(),
                s.model.as_deref(),
                s.tps,
                s.cpu_usage_pct,
                s.mem_used_mb,
                s.mem_total_mb,
                s.cpu_power_w,
                s.gpu_power_w,
                s.gpu_util_pct,
                s.vram_used_mb,
                s.vram_total_mb,
                s.thermal_state.as_deref(),
                s.mem_pressure_pct,
                s.swap_write_mb_s,
                s.clock_throttle_pct,
                s.ttft_ms,
                s.avg_latency_ms,
                s.queue_depth,
                s.penalty_avg,
                s.nvidia_gpu_temp_c,
                s.vllm_cache_usage_perc,
            ],
        )?;
        Ok(())
    }

    // ── Aggregation + Pruning ─────────────────────────────────────────────────

    /// Called once per hour (dispatched via `spawn_blocking`).
    ///
    /// Aggregates the last 2 hours of raw samples into complete 1-minute buckets,
    /// then aggregates the last 2 hours of 1-minute rows into complete 1-hour
    /// buckets.  Only *complete* buckets are written (current bucket excluded) so
    /// a partial minute/hour is never mistakenly finalised.
    ///
    /// UPSERT semantics on both tiers mean re-running aggregation is idempotent —
    /// safe if the agent is restarted mid-aggregation or within the same window.
    ///
    /// Prunes raw rows older than 24 h, 1-min rows older than 30 d, and
    /// 1-hr rows older than 90 d.
    pub fn run_aggregation(&self, now_ms: i64) -> Result<(), duckdb::Error> {
        // Bucket boundaries — never aggregate the currently-open bucket.
        let cur_min_ms = (now_ms / 60_000)    * 60_000;
        let cur_hr_ms  = (now_ms / 3_600_000) * 3_600_000;

        // Lookback windows for re-aggregation — catches restarts / gaps.
        let raw_lookback = now_ms - 7_200_000;     // 2 h
        let min_lookback = now_ms - 7_200_000;     // 2 h of 1-min rows for 1-hr tier

        // Retention cutoffs.
        let raw_cutoff   = now_ms - 86_400_000_i64;           // 24 h
        let min_cutoff   = now_ms - 30_i64 * 86_400_000_i64;  // 30 d
        let hr_cutoff    = now_ms - 90_i64 * 86_400_000_i64;  // 90 d
        let event_cutoff = now_ms - 7_i64 * 86_400_000_i64;   // 7 d
        // Transitions are the evidence the diagnostic rules cite. The longest
        // window any Phase 1 rule looks back over is a day (`expiry_reload`
        // counts reloads per day), so a week leaves room for a rule to be
        // re-evaluated over history without keeping it indefinitely.
        let transition_cutoff = now_ms - 7_i64 * 86_400_000_i64;
        // Resolved findings outlive the transitions they were built from: the
        // point of keeping them is "this used to happen and stopped", which is
        // worth more than the log that proved it. Open findings are never
        // pruned — an open finding with no evidence left in the window is
        // still true, and the next evaluation will resolve it if it is not.
        let finding_cutoff = now_ms - 30_i64 * 86_400_000_i64;
        // Receipts are the only exact numbers on the host, and a fingerprint
        // baseline is worth nothing if it expires before the operator changes
        // the thing it was measuring. Thirty days, same as a resolved
        // finding — step 6 compares a run against a baseline taken "before
        // the change", and a week is not long enough for that to mean a
        // configuration change someone actually made.
        let receipt_cutoff = now_ms - 30_i64 * 86_400_000_i64;

        let conn = self.0.lock().unwrap();

        // ── Tier 0 → Tier 1 ──────────────────────────────────────────────────
        conn.execute_batch(&format!("
            INSERT INTO metrics_1min
              (ts_ms, node_id, model,
               tps_avg, tps_max, tps_min,
               cpu_usage_avg, gpu_util_avg, gpu_power_avg,
               vram_used_avg, sample_count)
            SELECT
              (ts_ms / 60000) * 60000                           AS ts_ms,
              node_id,
              -- Aggregated tiers are node-level (PK is ts_ms+node_id, and `model`
              -- is nullable during idle so it can't join the key). Label each
              -- bucket with its DOMINANT model (most raw samples) instead of an
              -- arbitrary MAX(); a minute spanning a model switch is still blended
              -- in tps/util but at least carries the model that ran longest.
              mode(model)                                       AS model,
              AVG(tps)                                          AS tps_avg,
              MAX(tps)                                          AS tps_max,
              MIN(CASE WHEN tps > 0 THEN tps ELSE NULL END)     AS tps_min,
              AVG(cpu_usage_pct)                                AS cpu_usage_avg,
              AVG(gpu_util_pct)                                 AS gpu_util_avg,
              AVG(gpu_power_w)                                  AS gpu_power_avg,
              CAST(AVG(vram_used_mb) AS BIGINT)                 AS vram_used_avg,
              COUNT(*)                                          AS sample_count
            FROM metrics_raw
            WHERE ts_ms >= {raw_lookback} AND ts_ms < {cur_min_ms}
            GROUP BY 1, 2
            ON CONFLICT (ts_ms, node_id) DO UPDATE SET
              model         = excluded.model,
              tps_avg       = excluded.tps_avg,
              tps_max       = excluded.tps_max,
              tps_min       = excluded.tps_min,
              cpu_usage_avg = excluded.cpu_usage_avg,
              gpu_util_avg  = excluded.gpu_util_avg,
              gpu_power_avg = excluded.gpu_power_avg,
              vram_used_avg = excluded.vram_used_avg,
              sample_count  = excluded.sample_count;
        "))?;

        // ── Tier 1 → Tier 2 ──────────────────────────────────────────────────
        // Each per-minute row carries `sample_count` (raw 1 Hz samples folded
        // into it). Minutes with gaps/restarts have fewer samples, so we weight
        // every average by sample_count — an unweighted AVG(avg) would treat a
        // 3-sample minute the same as a full 60-sample minute and skew the hour.
        // NULLIF guards divide-by-zero when a column was NULL across the window.
        // Note: tps_p95 is the p95 of the per-minute *averages*, not of raw
        // samples (raw rows are pruned at 24 h, so true sample-level p95 isn't
        // available at the 1-hr tier).
        conn.execute_batch(&format!("
            INSERT INTO metrics_1hr
              (ts_ms, node_id, model,
               tps_avg, tps_max, tps_p95,
               cpu_usage_avg, gpu_util_avg, gpu_power_avg,
               vram_used_avg, sample_count)
            SELECT
              (ts_ms / 3600000) * 3600000                                AS ts_ms,
              node_id,
              mode(model)                                                 AS model,
              SUM(tps_avg * sample_count)
                / NULLIF(SUM(CASE WHEN tps_avg IS NOT NULL THEN sample_count ELSE 0 END), 0)         AS tps_avg,
              MAX(tps_max)                                                AS tps_max,
              PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY tps_avg)       AS tps_p95,
              SUM(cpu_usage_avg * sample_count)
                / NULLIF(SUM(CASE WHEN cpu_usage_avg IS NOT NULL THEN sample_count ELSE 0 END), 0)   AS cpu_usage_avg,
              SUM(gpu_util_avg * sample_count)
                / NULLIF(SUM(CASE WHEN gpu_util_avg IS NOT NULL THEN sample_count ELSE 0 END), 0)    AS gpu_util_avg,
              SUM(gpu_power_avg * sample_count)
                / NULLIF(SUM(CASE WHEN gpu_power_avg IS NOT NULL THEN sample_count ELSE 0 END), 0)   AS gpu_power_avg,
              CAST(SUM(vram_used_avg * sample_count)
                / NULLIF(SUM(CASE WHEN vram_used_avg IS NOT NULL THEN sample_count ELSE 0 END), 0) AS BIGINT) AS vram_used_avg,
              SUM(sample_count)                                           AS sample_count
            FROM metrics_1min
            WHERE ts_ms >= {min_lookback} AND ts_ms < {cur_hr_ms}
            GROUP BY 1, 2
            ON CONFLICT (ts_ms, node_id) DO UPDATE SET
              model         = excluded.model,
              tps_avg       = excluded.tps_avg,
              tps_max       = excluded.tps_max,
              tps_p95       = excluded.tps_p95,
              cpu_usage_avg = excluded.cpu_usage_avg,
              gpu_util_avg  = excluded.gpu_util_avg,
              gpu_power_avg = excluded.gpu_power_avg,
              vram_used_avg = excluded.vram_used_avg,
              sample_count  = excluded.sample_count;
        "))?;

        // ── Prune beyond retention windows ────────────────────────────────────
        conn.execute_batch(&format!("
            DELETE FROM metrics_raw  WHERE ts_ms < {raw_cutoff};
            DELETE FROM metrics_1min WHERE ts_ms < {min_cutoff};
            DELETE FROM metrics_1hr  WHERE ts_ms < {hr_cutoff};
            DELETE FROM inference_traces WHERE ts_ms < {raw_cutoff};
            DELETE FROM node_events WHERE ts_ms < {event_cutoff};
            DELETE FROM model_transitions WHERE ts_ms < {transition_cutoff};
            DELETE FROM findings
             WHERE resolved_at_ms IS NOT NULL AND resolved_at_ms < {finding_cutoff};
            DELETE FROM receipts WHERE ts_ms < {receipt_cutoff};
            DELETE FROM verify_runs WHERE ts_ms < {receipt_cutoff};
        "))?;

        // Fold the WAL into the main file after the hourly prune so deleted
        // rows' space is reclaimable and the WAL doesn't grow between DuckDB's
        // size-triggered auto-checkpoints. Best-effort: the aggregation itself
        // already succeeded, so a failed checkpoint is only logged.
        if let Err(e) = conn.execute_batch("CHECKPOINT;") {
            eprintln!("[store] checkpoint after prune failed: {e}");
        }

        Ok(())
    }

    // ── Query ─────────────────────────────────────────────────────────────────

    /// Return historical samples for `node_id` in `[from_ms, to_ms]`.
    /// Caller selects the tier; see `Resolution::auto` for auto-selection.
    pub fn query_history(
        &self,
        node_id: &str,
        from_ms: i64,
        to_ms:   i64,
        res:     Resolution,
    ) -> Result<HistoryResponse, duckdb::Error> {
        let conn = self.0.lock().unwrap();

        let samples: Vec<HistorySample> = match res {
            Resolution::Raw => {
                let mut stmt = conn.prepare(
                    "SELECT ts_ms, model, tps, cpu_usage_pct,
                            gpu_util_pct, gpu_power_w, vram_used_mb, thermal_state,
                            cpu_power_w, mem_pressure_pct,
                            swap_write_mb_s, clock_throttle_pct,
                            ttft_ms, avg_latency_ms, queue_depth
                     FROM metrics_raw
                     WHERE node_id = ? AND ts_ms >= ? AND ts_ms <= ?
                     ORDER BY ts_ms ASC",
                )?;
                stmt.query_map(params![node_id, from_ms, to_ms], |row| {
                    Ok(HistorySample {
                        ts_ms:          row.get(0)?,
                        model:          row.get(1)?,
                        tps:            row.get(2)?,
                        tps_avg:        None,
                        tps_max:        None,
                        tps_p95:        None,
                        cpu_usage_pct:  row.get(3)?,
                        gpu_util_pct:   row.get(4)?,
                        gpu_power_w:    row.get(5)?,
                        vram_used_mb:   row.get(6)?,
                        thermal_state:  row.get(7)?,
                        cpu_power_w:    row.get(8)?,
                        mem_pressure_pct: row.get(9)?,
                        swap_write_mb_s: row.get(10)?,
                        clock_throttle_pct: row.get(11)?,
                        ttft_ms:        row.get(12)?,
                        avg_latency_ms: row.get(13)?,
                        queue_depth:    row.get(14)?,
                    })
                })?.collect::<Result<_, _>>()?
            }

            Resolution::OneMin => {
                let mut stmt = conn.prepare(
                    "SELECT ts_ms, model, tps_avg, tps_max, tps_min,
                            cpu_usage_avg, gpu_util_avg, gpu_power_avg, vram_used_avg
                     FROM metrics_1min
                     WHERE node_id = ? AND ts_ms >= ? AND ts_ms <= ?
                     ORDER BY ts_ms ASC",
                )?;
                stmt.query_map(params![node_id, from_ms, to_ms], |row| {
                    Ok(HistorySample {
                        ts_ms:         row.get(0)?,
                        model:         row.get(1)?,
                        tps:           None,
                        tps_avg:       row.get(2)?,
                        tps_max:       row.get(3)?,
                        tps_p95:        None,
                        cpu_usage_pct:  row.get(5)?,
                        gpu_util_pct:   row.get(6)?,
                        gpu_power_w:    row.get(7)?,
                        vram_used_mb:   row.get(8)?,
                        thermal_state:  None,
                        cpu_power_w:    None,
                        mem_pressure_pct: None,
                        swap_write_mb_s: None,
                        clock_throttle_pct: None,
                        ttft_ms:        None,
                        avg_latency_ms: None,
                        queue_depth:    None,
                    })
                })?.collect::<Result<_, _>>()?
            }

            Resolution::OneHr => {
                let mut stmt = conn.prepare(
                    "SELECT ts_ms, model, tps_avg, tps_max, tps_p95,
                            cpu_usage_avg, gpu_util_avg, gpu_power_avg, vram_used_avg
                     FROM metrics_1hr
                     WHERE node_id = ? AND ts_ms >= ? AND ts_ms <= ?
                     ORDER BY ts_ms ASC",
                )?;
                stmt.query_map(params![node_id, from_ms, to_ms], |row| {
                    Ok(HistorySample {
                        ts_ms:         row.get(0)?,
                        model:         row.get(1)?,
                        tps:           None,
                        tps_avg:       row.get(2)?,
                        tps_max:       row.get(3)?,
                        tps_p95:        row.get(4)?,
                        cpu_usage_pct:  row.get(5)?,
                        gpu_util_pct:   row.get(6)?,
                        gpu_power_w:    row.get(7)?,
                        vram_used_mb:   row.get(8)?,
                        thermal_state:  None,
                        cpu_power_w:    None,
                        mem_pressure_pct: None,
                        swap_write_mb_s: None,
                        clock_throttle_pct: None,
                        ttft_ms:        None,
                        avg_latency_ms: None,
                        queue_depth:    None,
                    })
                })?.collect::<Result<_, _>>()?
            }
        };

        Ok(HistoryResponse {
            node_id:    node_id.to_string(),
            resolution: res.as_str(),
            from_ms,
            to_ms,
            samples,
        })
    }

    // ── Inference Traces ───────────────────────────────────────────────────────

    /// Insert one inference trace.  Conflicts (duplicate id) are silently
    /// discarded — safe if the same done-packet is somehow processed twice.
    pub fn write_trace(&self, t: &TraceRow) {
        let conn = self.0.lock().unwrap();
        let res = conn.prepare_cached(
            "INSERT INTO inference_traces
             (id, ts_ms, node_id, model, latency_ms, ttft_ms, tpot_ms, status,
              eval_count, eval_duration_ns, load_duration_ns,
              prompt_eval_count, prompt_eval_cached_count,
              prompt_eval_duration_ns, total_duration_ns)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO NOTHING",
        ).and_then(|mut stmt| stmt.execute(params![
                t.id.as_str(),
                t.ts_ms,
                t.node_id.as_str(),
                t.model.as_str(),
                t.latency_ms,
                t.ttft_ms,
                t.tpot_ms,
                t.status,
                t.eval_count,
                t.eval_duration_ns,
                t.load_duration_ns,
                t.prompt_eval_count,
                t.prompt_eval_cached_count,
                t.prompt_eval_duration_ns,
                t.total_duration_ns,
            ]));
        if let Err(e) = res {
            eprintln!("[store] trace write error: {e}");
        }
    }

    /// Return recent inference traces, optionally filtered by node_id.
    /// Results ordered newest-first, capped at `limit` (max 500).
    pub fn query_traces(
        &self,
        node_id: Option<&str>,
        limit: i64,
    ) -> Result<Vec<TraceRecord>, duckdb::Error> {
        let conn = self.0.lock().unwrap();
        let limit = limit.min(500);

        let rows: Vec<TraceRecord> = if let Some(nid) = node_id {
            let mut stmt = conn.prepare(
                "SELECT id, ts_ms, node_id, model, latency_ms, ttft_ms, tpot_ms, status
                 FROM inference_traces
                 WHERE node_id = ?
                 ORDER BY ts_ms DESC
                 LIMIT ?",
            )?;
            stmt.query_map(params![nid, limit], |row| {
                let ts_ms: i64 = row.get(1)?;
                Ok(TraceRecord {
                    id:        row.get(0)?,
                    timestamp: millis_to_iso8601(ts_ms),
                    node_id:   row.get(2)?,
                    model:     row.get(3)?,
                    latency:   row.get(4)?,
                    ttft:      row.get(5)?,
                    tpot:      row.get(6)?,
                    status:    row.get(7)?,
                })
            })?.collect::<Result<_, _>>()?
        } else {
            let mut stmt = conn.prepare(
                "SELECT id, ts_ms, node_id, model, latency_ms, ttft_ms, tpot_ms, status
                 FROM inference_traces
                 ORDER BY ts_ms DESC
                 LIMIT ?",
            )?;
            stmt.query_map(params![limit], |row| {
                let ts_ms: i64 = row.get(1)?;
                Ok(TraceRecord {
                    id:        row.get(0)?,
                    timestamp: millis_to_iso8601(ts_ms),
                    node_id:   row.get(2)?,
                    model:     row.get(3)?,
                    latency:   row.get(4)?,
                    ttft:      row.get(5)?,
                    tpot:      row.get(6)?,
                    status:    row.get(7)?,
                })
            })?.collect::<Result<_, _>>()?
        };
        Ok(rows)
    }

    // ── Inference SLA Monitor ───────────────────────────────────────────────

    /// Aggregate SLA percentiles from `inference_traces` over the given window.
    ///
    /// `window_min` is clamped to [1, 1440] minutes (24 h hard ceiling — that's the
    /// retention cap on the table).  `target_ttft_ms` controls compliance + violation
    /// detection.  When `model` is supplied, results scope to that model only.
    ///
    /// Computes p50/p95/p99/max for ttft_ms, latency_ms, tpot_ms via DuckDB's
    /// `quantile_cont()`.  Per-model breakdown via a second GROUP BY query.
    /// Violations are the 20 most-recent rows where `ttft_ms > target_ttft_ms`.
    pub fn query_sla(
        &self,
        node_id: &str,
        window_min: i64,
        model: Option<&str>,
        target_ttft_ms: i64,
    ) -> Result<SlaSummary, duckdb::Error> {
        let conn = self.0.lock().unwrap();
        let window_min = window_min.clamp(1, 1440);
        let window_ms = window_min * 60_000;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let cutoff = now - window_ms;

        // Build base WHERE clause for both queries.
        // We always scope to node_id (the agent only stores its own node anyway,
        // but explicit beats implicit).  Model filter is optional.
        let mut where_clause = "node_id = ? AND ts_ms >= ?".to_string();
        if model.is_some() { where_clause.push_str(" AND model = ?"); }

        // ── Aggregate query: percentiles + counts in a single round-trip. ──
        let agg_sql = format!(
            "SELECT
                COUNT(*) AS n,
                COUNT(*) FILTER (WHERE status >= 400 OR status = 0) AS errs,
                COALESCE(quantile_cont(ttft_ms,    0.5),  0) AS ttft_p50,
                COALESCE(quantile_cont(ttft_ms,    0.95), 0) AS ttft_p95,
                COALESCE(quantile_cont(ttft_ms,    0.99), 0) AS ttft_p99,
                COALESCE(MAX(ttft_ms), 0) AS ttft_max,
                COALESCE(quantile_cont(latency_ms, 0.5),  0) AS e2e_p50,
                COALESCE(quantile_cont(latency_ms, 0.95), 0) AS e2e_p95,
                COALESCE(quantile_cont(latency_ms, 0.99), 0) AS e2e_p99,
                COALESCE(MAX(latency_ms), 0) AS e2e_max,
                COALESCE(quantile_cont(tpot_ms,    0.5),  0) AS tpot_p50,
                COALESCE(quantile_cont(tpot_ms,    0.95), 0) AS tpot_p95,
                COALESCE(quantile_cont(tpot_ms,    0.99), 0) AS tpot_p99,
                COUNT(*) FILTER (WHERE ttft_ms > ?) AS violations,
                COUNT(*) FILTER (WHERE ttft_ms <= ?) AS compliant
             FROM inference_traces
             WHERE {where_clause}"
        );

        let mut stmt = conn.prepare(&agg_sql)?;
        let mut row = if let Some(m) = model {
            stmt.query(params![target_ttft_ms, target_ttft_ms, node_id, cutoff, m])?
        } else {
            stmt.query(params![target_ttft_ms, target_ttft_ms, node_id, cutoff])?
        };
        let r = row.next()?.ok_or_else(|| duckdb::Error::QueryReturnedNoRows)?;

        let n:           i64 = r.get(0)?;
        let errs:        i64 = r.get(1)?;
        let ttft_p50:    f64 = r.get(2)?;
        let ttft_p95:    f64 = r.get(3)?;
        let ttft_p99:    f64 = r.get(4)?;
        let ttft_max:    i64 = r.get(5)?;
        let e2e_p50:     f64 = r.get(6)?;
        let e2e_p95:     f64 = r.get(7)?;
        let e2e_p99:     f64 = r.get(8)?;
        let e2e_max:     i64 = r.get(9)?;
        let tpot_p50:    f64 = r.get(10)?;
        let tpot_p95:    f64 = r.get(11)?;
        let tpot_p99:    f64 = r.get(12)?;
        let violations:  i64 = r.get(13)?;
        let compliant:   i64 = r.get(14)?;
        drop(row); drop(stmt);

        let error_rate_pct = if n > 0 { errs as f64 / n as f64 * 100.0 } else { 0.0 };
        let compliance_pct = if n > 0 { compliant as f64 / n as f64 * 100.0 } else { 100.0 };

        // ── Per-model breakdown. ──
        let by_model_sql = format!(
            "SELECT model, COUNT(*) AS n,
                    COALESCE(quantile_cont(ttft_ms,    0.95), 0) AS ttft_p95,
                    COALESCE(quantile_cont(latency_ms, 0.95), 0) AS e2e_p95
             FROM inference_traces
             WHERE {where_clause}
             GROUP BY model
             ORDER BY n DESC"
        );
        let mut stmt = conn.prepare(&by_model_sql)?;
        let by_model: Vec<SlaModelRow> = if let Some(m) = model {
            stmt.query_map(params![node_id, cutoff, m], |row| Ok(SlaModelRow {
                model:        row.get(0)?,
                count:        row.get(1)?,
                p95_ttft_ms:  row.get(2)?,
                p95_e2e_ms:   row.get(3)?,
            }))?.collect::<Result<_, _>>()?
        } else {
            stmt.query_map(params![node_id, cutoff], |row| Ok(SlaModelRow {
                model:        row.get(0)?,
                count:        row.get(1)?,
                p95_ttft_ms:  row.get(2)?,
                p95_e2e_ms:   row.get(3)?,
            }))?.collect::<Result<_, _>>()?
        };
        drop(stmt);

        // ── Recent violations (last 20 over target). ──
        let viol_sql = format!(
            "SELECT ts_ms, model, ttft_ms, latency_ms
             FROM inference_traces
             WHERE {where_clause} AND ttft_ms > ?
             ORDER BY ts_ms DESC
             LIMIT 20"
        );
        let mut stmt = conn.prepare(&viol_sql)?;
        let recent_violations: Vec<SlaViolation> = if let Some(m) = model {
            stmt.query_map(params![node_id, cutoff, m, target_ttft_ms], |row| Ok(SlaViolation {
                ts_ms:      row.get(0)?,
                model:      row.get(1)?,
                ttft_ms:    row.get(2)?,
                latency_ms: row.get(3)?,
            }))?.collect::<Result<_, _>>()?
        } else {
            stmt.query_map(params![node_id, cutoff, target_ttft_ms], |row| Ok(SlaViolation {
                ts_ms:      row.get(0)?,
                model:      row.get(1)?,
                ttft_ms:    row.get(2)?,
                latency_ms: row.get(3)?,
            }))?.collect::<Result<_, _>>()?
        };

        Ok(SlaSummary {
            window_minutes:  window_min,
            window_start_ms: cutoff,
            request_count:   n,
            error_count:     errs,
            error_rate_pct,
            ttft: SlaPercentiles { p50: ttft_p50, p95: ttft_p95, p99: ttft_p99, max: ttft_max as f64 },
            e2e:  SlaPercentiles { p50: e2e_p50,  p95: e2e_p95,  p99: e2e_p99,  max: e2e_max as f64 },
            tpot: SlaPercentiles { p50: tpot_p50, p95: tpot_p95, p99: tpot_p99, max: 0.0 },
            sla: SlaCompliance {
                target_ttft_ms,
                compliance_pct,
                violations_count: violations,
                violations: recent_violations,
            },
            by_model,
        })
    }

    // ── Node Events ─────────────────────────────────────────────────────────

    /// Insert one Live Activity event.  Conflicts (same ts_ms + node_id +
    /// message) are silently discarded — safe on replay or duplicate push.
    pub fn write_event(
        &self,
        ts_ms:      i64,
        node_id:    &str,
        level:      &str,
        event_type: Option<&str>,
        message:    &str,
    ) {
        let conn = self.0.lock().unwrap();
        let res = conn.prepare_cached(
            "INSERT INTO node_events (ts_ms, node_id, level, event_type, message)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (ts_ms, node_id, message) DO NOTHING",
        ).and_then(|mut stmt| stmt.execute(params![ts_ms, node_id, level, event_type, message]));
        if let Err(e) = res {
            eprintln!("[store] event write error: {e}");
        }
    }

    /// Return persisted events, newest-first, with cursor-based pagination.
    /// `before` is exclusive upper bound on ts_ms; pass `None` for latest.
    /// `event_type` optionally filters to a single type.
    pub fn query_events(
        &self,
        limit:      i64,
        before:     Option<i64>,
        event_type: Option<&str>,
    ) -> Result<Vec<EventRecord>, duckdb::Error> {
        let conn = self.0.lock().unwrap();
        let limit = limit.min(200);
        let before_ms = before.unwrap_or(i64::MAX);

        let rows: Vec<EventRecord> = if let Some(et) = event_type {
            let mut stmt = conn.prepare(
                "SELECT ts_ms, node_id, level, event_type, message
                 FROM node_events
                 WHERE ts_ms < ? AND event_type = ?
                 ORDER BY ts_ms DESC
                 LIMIT ?",
            )?;
            stmt.query_map(params![before_ms, et, limit], |row| {
                let ts_ms: i64 = row.get(0)?;
                Ok(EventRecord {
                    ts_ms,
                    timestamp: millis_to_iso8601(ts_ms),
                    node_id:    row.get(1)?,
                    level:      row.get(2)?,
                    event_type: row.get(3)?,
                    message:    row.get(4)?,
                })
            })?.collect::<Result<_, _>>()?
        } else {
            let mut stmt = conn.prepare(
                "SELECT ts_ms, node_id, level, event_type, message
                 FROM node_events
                 WHERE ts_ms < ?
                 ORDER BY ts_ms DESC
                 LIMIT ?",
            )?;
            stmt.query_map(params![before_ms, limit], |row| {
                let ts_ms: i64 = row.get(0)?;
                Ok(EventRecord {
                    ts_ms,
                    timestamp: millis_to_iso8601(ts_ms),
                    node_id:    row.get(1)?,
                    level:      row.get(2)?,
                    event_type: row.get(3)?,
                    message:    row.get(4)?,
                })
            })?.collect::<Result<_, _>>()?
        };
        Ok(rows)
    }

    // ── Insight dismissals ────────────────────────────────────────────────────

    /// Persist a dismiss decision.  Upserts: re-dismissing the same
    /// (pattern_id, node_id) pair resets the expiry and note.
    ///
    /// `node_id` should be "" for fleet-wide dismissals (not tied to one node).
    pub fn record_dismiss(
        &self,
        pattern_id:      &str,
        node_id:         &str,
        dismissed_at_ms: i64,
        expires_at_ms:   i64,
        note:            Option<&str>,
    ) -> Result<(), duckdb::Error> {
        self.0.lock().unwrap().execute(
            "INSERT INTO accepted_states
             (pattern_id, node_id, dismissed_at_ms, expires_at_ms, note)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (pattern_id, node_id) DO UPDATE SET
               dismissed_at_ms = excluded.dismissed_at_ms,
               expires_at_ms   = excluded.expires_at_ms,
               note            = excluded.note",
            params![pattern_id, node_id, dismissed_at_ms, expires_at_ms, note],
        )?;
        Ok(())
    }

    /// Return all non-expired dismissals (expires_at_ms > now_ms).
    /// Callers can pass `now_ms` explicitly for testability.
    pub fn query_active_dismissals(&self, now_ms: i64) -> Result<Vec<Dismissal>, duckdb::Error> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT pattern_id, node_id, dismissed_at_ms, expires_at_ms, note
             FROM accepted_states
             WHERE expires_at_ms > ?
             ORDER BY dismissed_at_ms DESC",
        )?;
        let rows = stmt.query_map(params![now_ms], |row| {
            Ok(Dismissal {
                pattern_id:      row.get(0)?,
                node_id:         row.get(1)?,
                dismissed_at_ms: row.get(2)?,
                expires_at_ms:   row.get(3)?,
                note:            row.get(4)?,
            })
        })?.collect::<Result<_, _>>()?;
        Ok(rows)
    }

    /// Prune expired dismissal rows older than 7 days beyond their expiry.
    /// Called from the hourly aggregation loop in main.rs.
    pub fn prune_expired_dismissals(&self, now_ms: i64) -> Result<(), duckdb::Error> {
        let cutoff = now_ms - 7 * 24 * 60 * 60 * 1000; // 7 days past expiry
        self.0.lock().unwrap().execute(
            "DELETE FROM accepted_states WHERE expires_at_ms < ?",
            params![cutoff],
        )?;
        Ok(())
    }

    // ── Audit Log Export ──────────────────────────────────────────────────────

    // ── Observation window query ────────────────────────────────────────────

    /// Return the last `window_ms` of raw samples for a given node.
    /// Used by the local observations evaluator (Patterns A/B/J/L).
    /// Ordered oldest-first so pattern windows can be scanned left-to-right.
    pub fn query_observation_window(
        &self,
        node_id:   &str,
        window_ms: i64,
    ) -> Result<Vec<ObsSample>, duckdb::Error> {
        let now   = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let from  = now - window_ms;
        let conn  = self.0.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT ts_ms, model, tps, thermal_state,
                    gpu_power_w, cpu_power_w, mem_pressure_pct,
                    swap_write_mb_s, gpu_util_pct,
                    vram_used_mb, vram_total_mb, clock_throttle_pct,
                    ttft_ms, avg_latency_ms, queue_depth,
                    penalty_avg, nvidia_gpu_temp_c, vllm_cache_usage_perc
             FROM metrics_raw
             WHERE node_id = ? AND ts_ms >= ?
             ORDER BY ts_ms ASC",
        )?;
        let rows = stmt.query_map(params![node_id, from], |row| {
            Ok(ObsSample {
                ts_ms:                 row.get(0)?,
                model:                 row.get(1)?,
                tps:                   row.get(2)?,
                thermal_state:         row.get(3)?,
                gpu_power_w:           row.get(4)?,
                cpu_power_w:           row.get(5)?,
                mem_pressure_pct:      row.get(6)?,
                swap_write_mb_s:       row.get(7)?,
                gpu_util_pct:          row.get(8)?,
                vram_used_mb:          row.get(9)?,
                vram_total_mb:         row.get(10)?,
                clock_throttle_pct:    row.get(11)?,
                ttft_ms:               row.get(12)?,
                avg_latency_ms:        row.get(13)?,
                queue_depth:           row.get(14)?,
                penalty_avg:           row.get(15)?,
                nvidia_gpu_temp_c:     row.get(16)?,
                vllm_cache_usage_perc: row.get(17)?,
            })
        })?.collect::<Result<_, _>>()?;
        Ok(rows)
    }

    /// Query per-model baseline from Normal-thermal samples in the last 7 days.
    /// Returns (median_tps, median_watts, sample_count) or None if < 100 samples.
    pub fn query_model_baseline(
        &self,
        node_id: &str,
        model:   &str,
    ) -> Result<Option<(f64, f64, u32)>, duckdb::Error> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let from = now - 7 * 24 * 3600 * 1000; // 7 days
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT MEDIAN(tps), MEDIAN(gpu_power_w), COUNT(*)
             FROM metrics_raw
             WHERE node_id = ? AND model = ? AND thermal_state = 'Normal'
               AND tps > 0 AND gpu_power_w > 0 AND ts_ms >= ?",
        )?;
        let result = stmt.query_row(params![node_id, model, from], |row| {
            let tps:     Option<f64> = row.get(0)?;
            let watts:   Option<f64> = row.get(1)?;
            let count:   u32         = row.get::<_, i64>(2)? as u32;
            Ok((tps, watts, count))
        });
        match result {
            Ok((Some(tps), Some(watts), count)) if count >= 100 && watts > 0.0 => {
                Ok(Some((tps, watts, count)))
            }
            Ok(_) => Ok(None), // insufficient data
            Err(e) => Err(e),
        }
    }

    // ── Inference Intelligence queries (Pro+) ─────────────────────────────────

    /// Inference Profiler — correlated time-series for a time window.
    /// Buckets auto-scale: ≤10min→1s, ≤1h→10s, ≤6h→30s, ≤24h→60s.
    pub fn query_profile(
        &self,
        node_id: &str,
        minutes: i64,
    ) -> Result<Vec<serde_json::Value>, duckdb::Error> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        let from = now - minutes * 60 * 1000;
        let bucket_ms: i64 = if minutes <= 10 { 1000 }
            else if minutes <= 60 { 10_000 }
            else if minutes <= 360 { 30_000 }
            else { 60_000 };
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT (ts_ms / ? * ?) AS bucket,
                    FIRST(model) AS model,
                    AVG(tps) AS tok_s,
                    AVG(ttft_ms) AS ttft_ms,
                    AVG(avg_latency_ms) AS latency_ms,
                    AVG(queue_depth) AS queue_depth,
                    AVG(vllm_cache_usage_perc) AS kv_cache_pct,
                    AVG(gpu_power_w + COALESCE(cpu_power_w, 0)) AS power_w,
                    FIRST(thermal_state) AS thermal_state,
                    AVG(penalty_avg) AS thermal_penalty,
                    AVG(gpu_util_pct) AS gpu_util_pct,
                    AVG(nvidia_gpu_temp_c) AS gpu_temp_c
             FROM metrics_raw
             WHERE node_id = ? AND ts_ms >= ?
             GROUP BY bucket ORDER BY bucket",
        )?;
        let mut rows = stmt.query(params![bucket_ms, bucket_ms, node_id, from])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            out.push(serde_json::json!({
                "ts_ms":           row.get::<_, Option<i64>>(0)?,
                "model":           row.get::<_, Option<String>>(1)?,
                "tok_s":           row.get::<_, Option<f64>>(2)?,
                "ttft_ms":         row.get::<_, Option<f64>>(3)?,
                "latency_ms":      row.get::<_, Option<f64>>(4)?,
                "queue_depth":     row.get::<_, Option<f64>>(5)?,
                "kv_cache_pct":    row.get::<_, Option<f64>>(6)?,
                "power_w":         row.get::<_, Option<f64>>(7)?,
                "thermal_state":   row.get::<_, Option<String>>(8)?,
                "thermal_penalty": row.get::<_, Option<f64>>(9)?,
                "gpu_util_pct":    row.get::<_, Option<f64>>(10)?,
                "gpu_temp_c":      row.get::<_, Option<f64>>(11)?,
            }));
        }
        Ok(out)
    }

    /// Cost Attribution Per Model — GROUP BY model with power aggregation.
    /// Uses metrics_raw for ≤24h, metrics_1min for >24h.
    pub fn query_cost_by_model(
        &self,
        node_id:  &str,
        hours:    i64,
        kwh_rate: f64,
    ) -> Result<serde_json::Value, duckdb::Error> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        let from = now - hours * 3600 * 1000;
        let conn = self.0.lock().unwrap();

        let (sql, sample_interval_h) = if hours <= 24 {
            // 1Hz raw data — each sample = 1 second = 1/3600 hour
            ("SELECT model, COUNT(*) AS samples,
                     AVG(gpu_power_w + COALESCE(cpu_power_w, 0)) AS avg_watts,
                     AVG(tps) AS avg_tps
              FROM metrics_raw
              WHERE node_id = ? AND ts_ms >= ?
              GROUP BY model ORDER BY avg_watts DESC".to_string(),
             1.0 / 3600.0)
        } else {
            // 1-min aggregated data — `sample_count` carries the number of raw
            // 1 Hz samples folded into each minute, so each counted sample is
            // still 1 second = 1/3600 hour (NOT 1/60: that would treat every
            // raw second as a full minute and inflate cost ~60×).
            ("SELECT model, SUM(sample_count) AS samples,
                     AVG(gpu_power_avg) AS avg_watts,
                     AVG(tps_avg) AS avg_tps
              FROM metrics_1min
              WHERE node_id = ? AND ts_ms >= ?
              GROUP BY model ORDER BY avg_watts DESC".to_string(),
             1.0 / 3600.0)
        };

        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query(params![node_id, from])?;
        let mut models = Vec::new();
        let mut total_cost = 0.0_f64;

        while let Some(row) = rows.next()? {
            let model: Option<String> = row.get(0)?;
            let samples: i64 = row.get(1)?;
            let avg_watts: Option<f64> = row.get(2)?;
            let avg_tps: Option<f64> = row.get(3)?;

            let hours_active = samples as f64 * sample_interval_h;
            let watts = avg_watts.unwrap_or(0.0);
            let total_wh = watts * hours_active;
            let cost = total_wh / 1000.0 * kwh_rate;
            total_cost += cost;

            models.push(serde_json::json!({
                "model":        model,
                "hours_active": (hours_active * 100.0).round() / 100.0,
                "avg_watts":    (watts * 10.0).round() / 10.0,
                "total_wh":     (total_wh * 10.0).round() / 10.0,
                "cost_usd":     (cost * 10000.0).round() / 10000.0,
                "tok_s_avg":    avg_tps.map(|t| (t * 10.0).round() / 10.0),
                "sample_count": samples,
            }));
        }

        Ok(serde_json::json!({
            "node_id":       node_id,
            "range_hours":   hours,
            "kwh_rate":      kwh_rate,
            "models":        models,
            "total_cost_usd": (total_cost * 10000.0).round() / 10000.0,
        }))
    }

    /// "Why Was That Slow?" Explainer — find closest trace, correlate with hardware.
    pub fn query_explain_slowdown(
        &self,
        node_id: &str,
        ts_ms:   i64,
    ) -> Result<serde_json::Value, duckdb::Error> {
        let conn = self.0.lock().unwrap();

        // 1. Find the closest inference trace to the given timestamp (±60s window)
        let mut trace_stmt = conn.prepare(
            "SELECT ts_ms, model, ttft_ms, latency_ms, tpot_ms, eval_count, status
             FROM inference_traces
             WHERE node_id = ? AND ts_ms BETWEEN ? AND ?
             ORDER BY ABS(ts_ms - ?) LIMIT 1",
        )?;
        let trace = trace_stmt.query_row(
            params![node_id, ts_ms - 60_000, ts_ms + 60_000, ts_ms],
            |row| {
                Ok(serde_json::json!({
                    "ts_ms":      row.get::<_, i64>(0)?,
                    "model":      row.get::<_, Option<String>>(1)?,
                    "ttft_ms":    row.get::<_, i64>(2)?,
                    "latency_ms": row.get::<_, i64>(3)?,
                    "tpot_ms":    row.get::<_, Option<f64>>(4)?,
                    "eval_count": row.get::<_, Option<i64>>(5)?,
                    "status":     row.get::<_, i32>(6)?,
                }))
            },
        );

        let trace_val = match trace {
            Ok(t) => t,
            Err(_) => return Ok(serde_json::json!({
                "error": "No inference trace found near the given timestamp",
                "ts_ms": ts_ms,
            })),
        };

        let trace_ts = trace_val["ts_ms"].as_i64().unwrap_or(ts_ms);

        // 2. Read metrics_raw for ±30s around the trace
        let mut hw_stmt = conn.prepare(
            "SELECT AVG(vllm_cache_usage_perc) AS kv_cache,
                    AVG(penalty_avg) AS penalty,
                    FIRST(thermal_state) AS thermal,
                    AVG(queue_depth) AS queue,
                    AVG(gpu_power_w + COALESCE(cpu_power_w, 0)) AS power_w,
                    AVG(gpu_util_pct) AS gpu_pct,
                    AVG(nvidia_gpu_temp_c) AS gpu_temp,
                    AVG(swap_write_mb_s) AS swap,
                    AVG(mem_pressure_pct) AS mem_pct,
                    AVG(clock_throttle_pct) AS clock_throttle
             FROM metrics_raw
             WHERE node_id = ? AND ts_ms BETWEEN ? AND ?",
        )?;
        let hw = hw_stmt.query_row(
            params![node_id, trace_ts - 30_000, trace_ts + 30_000],
            |row| {
                Ok((
                    row.get::<_, Option<f64>>(0)?,  // kv_cache
                    row.get::<_, Option<f64>>(1)?,  // penalty
                    row.get::<_, Option<String>>(2)?, // thermal
                    row.get::<_, Option<f64>>(3)?,  // queue
                    row.get::<_, Option<f64>>(4)?,  // power
                    row.get::<_, Option<f64>>(5)?,  // gpu_pct
                    row.get::<_, Option<f64>>(6)?,  // gpu_temp
                    row.get::<_, Option<f64>>(7)?,  // swap
                    row.get::<_, Option<f64>>(8)?,  // mem_pct
                    row.get::<_, Option<f64>>(9)?,  // clock_throttle
                ))
            },
        ).unwrap_or((None, None, None, None, None, None, None, None, None, None));

        // 3. Evaluate factors
        let mut factors = Vec::new();
        let mut summary_parts = Vec::new();

        if let Some(kv) = hw.0 {
            if kv > 90.0 {
                factors.push(serde_json::json!({ "factor": "kv_cache_pressure", "severity": "high",
                    "detail": format!("KV cache at {kv:.0}% — scheduler may have preempted sequences"), "value": kv, "threshold": 90.0 }));
                summary_parts.push(format!("KV cache at {kv:.0}% (high)"));
            } else if kv > 75.0 {
                factors.push(serde_json::json!({ "factor": "kv_cache_pressure", "severity": "moderate",
                    "detail": format!("KV cache at {kv:.0}% — approaching saturation"), "value": kv, "threshold": 75.0 }));
            }
        }
        if let Some(penalty) = hw.1
            && penalty > 1.2 {
                let sev = if penalty >= 1.75 { "high" } else { "moderate" };
                let thermal = hw.2.as_deref().unwrap_or("unknown");
                factors.push(serde_json::json!({ "factor": "thermal_penalty", "severity": sev,
                    "detail": format!("Thermal state {thermal} ({penalty:.2}x penalty)"), "value": penalty, "threshold": 1.25 }));
                summary_parts.push(format!("thermal penalty {penalty:.2}x ({thermal})"));
            }
        if let Some(queue) = hw.3 {
            if queue >= 3.0 {
                factors.push(serde_json::json!({ "factor": "queue_depth", "severity": if queue >= 5.0 { "high" } else { "moderate" },
                    "detail": format!("{queue:.0} concurrent requests queued"), "value": queue, "threshold": 3.0 }));
                summary_parts.push(format!("queue depth {queue:.0}"));
            } else if queue >= 1.0 {
                factors.push(serde_json::json!({ "factor": "queue_depth", "severity": "low",
                    "detail": format!("{queue:.0} concurrent request(s) in queue"), "value": queue, "threshold": 3.0 }));
            }
        }
        if let Some(swap) = hw.7
            && swap > 2.0 {
                factors.push(serde_json::json!({ "factor": "swap_pressure", "severity": if swap > 10.0 { "high" } else { "moderate" },
                    "detail": format!("Swap write rate {swap:.1} MB/s — model layers spilling to disk"), "value": swap, "threshold": 2.0 }));
                summary_parts.push(format!("swap at {swap:.1} MB/s"));
            }
        if let Some(mem) = hw.8
            && mem > 80.0 {
                factors.push(serde_json::json!({ "factor": "memory_pressure", "severity": if mem > 95.0 { "high" } else { "moderate" },
                    "detail": format!("Memory pressure at {mem:.0}%"), "value": mem, "threshold": 80.0 }));
            }
        if let Some(throttle) = hw.9
            && throttle > 15.0 {
                factors.push(serde_json::json!({ "factor": "clock_throttle", "severity": if throttle > 35.0 { "high" } else { "moderate" },
                    "detail": format!("Clock throttled {throttle:.0}% from maximum"), "value": throttle, "threshold": 15.0 }));
            }

        // Sort factors by severity (high > moderate > low)
        factors.sort_by(|a, b| {
            let sev_rank = |s: &str| match s { "high" => 0, "moderate" => 1, _ => 2 };
            sev_rank(a["severity"].as_str().unwrap_or("low"))
                .cmp(&sev_rank(b["severity"].as_str().unwrap_or("low")))
        });

        let ttft = trace_val["ttft_ms"].as_i64().unwrap_or(0);
        let summary = if summary_parts.is_empty() {
            format!("TTFT was {ttft}ms. No significant hardware factors detected — may be model or prompt complexity.")
        } else {
            format!("TTFT spiked to {ttft}ms primarily due to {}.", summary_parts.join(" and "))
        };

        Ok(serde_json::json!({
            "request": trace_val,
            "hardware_context": {
                "kv_cache_pct":    hw.0,
                "thermal_penalty": hw.1,
                "thermal_state":   hw.2,
                "queue_depth":     hw.3,
                "power_w":         hw.4,
                "gpu_util_pct":    hw.5,
                "gpu_temp_c":      hw.6,
                "swap_write_mb_s": hw.7,
                "mem_pressure_pct": hw.8,
                "clock_throttle_pct": hw.9,
            },
            "factors": factors,
            "summary": summary,
        }))
    }

    /// Model Comparison — side-by-side efficiency data for models that have run on this node.
    /// Queries historical data grouped by model, returns avg tok/s, watts, WES, TTFT, cost.
    pub fn query_model_comparison(
        &self,
        node_id:  &str,
        hours:    i64,
        kwh_rate: f64,
    ) -> Result<Vec<serde_json::Value>, duckdb::Error> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        let from = now - hours * 3600 * 1000;
        let conn = self.0.lock().unwrap();

        let (sql, sample_interval_h) = if hours <= 24 {
            ("SELECT model, COUNT(*) AS samples,
                     AVG(tps) AS avg_tps,
                     AVG(gpu_power_w + COALESCE(cpu_power_w, 0)) AS avg_watts,
                     AVG(ttft_ms) AS avg_ttft,
                     AVG(avg_latency_ms) AS avg_latency,
                     AVG(penalty_avg) AS avg_penalty,
                     MIN(ts_ms) AS first_seen,
                     MAX(ts_ms) AS last_seen
              FROM metrics_raw
              WHERE node_id = ? AND ts_ms >= ? AND model IS NOT NULL AND model != ''
              GROUP BY model ORDER BY AVG(tps) DESC".to_string(),
             1.0 / 3600.0)
        } else {
            ("SELECT model, SUM(sample_count) AS samples,
                     AVG(tps_avg) AS avg_tps,
                     AVG(gpu_power_avg) AS avg_watts,
                     NULL AS avg_ttft,
                     NULL AS avg_latency,
                     NULL AS avg_penalty,
                     MIN(ts_ms) AS first_seen,
                     MAX(ts_ms) AS last_seen
              FROM metrics_1min
              WHERE node_id = ? AND ts_ms >= ? AND model IS NOT NULL AND model != ''
              GROUP BY model ORDER BY AVG(tps_avg) DESC".to_string(),
             1.0 / 60.0)
        };

        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query(params![node_id, from])?;
        let mut out = Vec::new();

        while let Some(row) = rows.next()? {
            let model: Option<String> = row.get(0)?;
            let samples: i64 = row.get(1)?;
            let avg_tps: Option<f64> = row.get(2)?;
            let avg_watts: Option<f64> = row.get(3)?;
            let avg_ttft: Option<f64> = row.get(4)?;
            let avg_latency: Option<f64> = row.get(5)?;
            let avg_penalty: Option<f64> = row.get(6)?;
            let first_seen: Option<i64> = row.get(7)?;
            let last_seen: Option<i64> = row.get(8)?;

            let hours_active = samples as f64 * sample_interval_h;
            let watts = avg_watts.unwrap_or(0.0);
            let tps = avg_tps.unwrap_or(0.0);
            let penalty = avg_penalty.unwrap_or(1.0);
            let wes = if watts > 0.0 && tps > 0.0 { tps / (watts * penalty) } else { 0.0 };
            let cost_per_hour = watts / 1000.0 * kwh_rate;
            let total_cost = cost_per_hour * hours_active;

            out.push(serde_json::json!({
                "model":          model,
                "hours_active":   (hours_active * 100.0).round() / 100.0,
                "avg_tok_s":      avg_tps.map(|t| (t * 10.0).round() / 10.0),
                "avg_watts":      avg_watts.map(|w| (w * 10.0).round() / 10.0),
                "wes":            (wes * 100.0).round() / 100.0,
                "avg_ttft_ms":    avg_ttft.map(|t| (t * 10.0).round() / 10.0),
                "avg_latency_ms": avg_latency.map(|l| (l * 10.0).round() / 10.0),
                "cost_per_hour":  (cost_per_hour * 10000.0).round() / 10000.0,
                "total_cost":     (total_cost * 10000.0).round() / 10000.0,
                "sample_count":   samples,
                "first_seen_ms":  first_seen,
                "last_seen_ms":   last_seen,
            }));
        }
        Ok(out)
    }

    /// Model switching cost — detects model transitions and computes swap overhead.
    /// Returns: each swap event with from_model, to_model, timestamp, and estimated
    /// idle time (gap between last tok/s > 0 on old model and first tok/s > 0 on new model).
    /// Persist a batch of residency transitions.
    ///
    /// One transaction for the batch, for the same reason `write_catalog` uses
    /// one: per-row autocommit made every INSERT its own WAL commit while
    /// holding the store mutex.
    pub fn write_transitions(
        &self,
        node_id: &str,
        transitions: &[crate::residency::Transition],
    ) -> Result<(), duckdb::Error> {
        if transitions.is_empty() {
            return Ok(());
        }
        let mut conn = self.0.lock().unwrap();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO model_transitions
                   (id, ts_ms, node_id, model, kind, cause, co_resident,
                    before_state, after_state)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )?;
            for t in transitions {
                // Model names cannot contain a comma, so joining is lossless
                // and avoids a nested-type dependency in the schema.
                let co_resident = t.co_resident.join(",");
                let before = t
                    .before
                    .as_ref()
                    .and_then(|s| serde_json::to_string(s).ok());
                let after = t
                    .after
                    .as_ref()
                    .and_then(|s| serde_json::to_string(s).ok());
                stmt.execute(params![
                    t.id as i64,
                    t.ts_ms,
                    node_id,
                    t.model.as_str(),
                    t.kind.as_str(),
                    t.cause.as_str(),
                    co_resident.as_str(),
                    before,
                    after,
                ])?;
            }
        }
        tx.commit()
    }

    /// Read back the transition log from `from_ms` onward, oldest first.
    ///
    /// Ascending order is a precondition of
    /// [`derive_switches`](crate::residency::derive_switches), and ties are
    /// broken by `id` so the order within one poll survives the round trip.
    /// A row whose `kind` or `cause` this binary does not recognise is skipped
    /// rather than guessed at — that is what a log written by a newer agent
    /// looks like.
    pub fn query_transitions(
        &self,
        node_id: &str,
        from_ms: i64,
    ) -> Result<Vec<crate::residency::Transition>, duckdb::Error> {
        const MAX_ROWS: i64 = 50_000;
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, ts_ms, model, kind, cause, co_resident, before_state, after_state
             FROM model_transitions
             WHERE node_id = ? AND ts_ms >= ?
             ORDER BY ts_ms ASC, id ASC
             LIMIT ?",
        )?;
        let mut rows = stmt.query(params![node_id, from_ms, MAX_ROWS])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            let id: i64 = row.get(0)?;
            let ts_ms: i64 = row.get(1)?;
            let model: String = row.get(2)?;
            let kind: String = row.get(3)?;
            let cause: String = row.get(4)?;
            let co_resident: String = row.get(5)?;
            let before: Option<String> = row.get(6)?;
            let after: Option<String> = row.get(7)?;
            let (Some(kind), Some(cause)) = (
                crate::residency::TransitionKind::from_name(&kind),
                crate::residency::Cause::from_name(&cause),
            ) else {
                continue;
            };
            out.push(crate::residency::Transition {
                id: id.max(0) as u64,
                ts_ms,
                model,
                kind,
                cause,
                before: before
                    .and_then(|j| serde_json::from_str(&j).ok())
                    .map(Box::new),
                after: after
                    .and_then(|j| serde_json::from_str(&j).ok())
                    .map(Box::new),
                co_resident: if co_resident.is_empty() {
                    Vec::new()
                } else {
                    co_resident.split(',').map(str::to_string).collect()
                },
            });
        }
        Ok(out)
    }

    // ── Model Catalog (HuggingFace GGUF cache) ─────────────────────────────

    /// Write a batch of catalog entries (replaces existing for the same model_id).
    /// Tuple shape: (model_id, filename, quant_level, file_size, downloads, likes, fetched_at).
    ///
    /// One transaction for the whole batch: per-row autocommit made every
    /// INSERT its own WAL commit while holding the store mutex. All-or-nothing
    /// also means a failed refresh never leaves a half-written catalog.
    pub fn write_catalog(&self, entries: &[(String, String, String, u64, u64, u64, i64)]) -> Result<(), duckdb::Error> {
        let mut conn = self.0.lock().unwrap();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO model_catalog (model_id, filename, quant_level, file_size, downloads, likes, fetched_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )?;
            for (model_id, filename, quant_level, file_size, downloads, likes, fetched_at) in entries {
                stmt.execute(duckdb::params![model_id, filename, quant_level, file_size, downloads, likes, fetched_at])?;
            }
        }
        tx.commit()
    }

    /// Check if the catalog is fresh (any entry fetched within TTL).
    pub fn catalog_is_fresh(&self, ttl_hours: i64) -> bool {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        let cutoff = now - ttl_hours * 3600 * 1000;
        let conn = self.0.lock().unwrap();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM model_catalog WHERE fetched_at > ?",
            duckdb::params![cutoff],
            |r| r.get(0),
        ).unwrap_or(0);
        count > 0
    }

    /// Read all catalog entries grouped by model_id.
    /// Tuple shape: (model_id, downloads, likes, variants[]).
    pub fn query_catalog(&self, search: Option<&str>, limit: i64) -> Result<Vec<(String, u64, u64, Vec<(String, String, u64)>)>, duckdb::Error> {
        let conn = self.0.lock().unwrap();
        let sql = if search.is_some() {
            "SELECT model_id, filename, quant_level, file_size, downloads, likes
             FROM model_catalog WHERE LOWER(model_id) LIKE '%' || LOWER(?) || '%'
             ORDER BY downloads DESC"
        } else {
            "SELECT model_id, filename, quant_level, file_size, downloads, likes
             FROM model_catalog ORDER BY downloads DESC"
        };
        let mut stmt = conn.prepare(sql)?;
        let mut rows = if let Some(s) = search {
            stmt.query(duckdb::params![s])?
        } else {
            stmt.query([])?
        };

        let mut models: Vec<(String, u64, u64, Vec<(String, String, u64)>)> = Vec::new();
        let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

        while let Some(row) = rows.next()? {
            let model_id: String = row.get(0)?;
            let filename: String = row.get(1)?;
            let quant: String = row.get(2)?;
            let file_size: u64 = row.get::<_, i64>(3)? as u64;
            let downloads: u64 = row.get::<_, i64>(4)? as u64;
            let likes:     u64 = row.get::<_, i64>(5).unwrap_or(0) as u64;

            if let Some(&idx) = seen.get(&model_id) {
                models[idx].3.push((filename, quant, file_size));
            } else {
                seen.insert(model_id.clone(), models.len());
                models.push((model_id, downloads, likes, vec![(filename, quant, file_size)]));
            }
        }
        models.truncate(limit as usize);
        Ok(models)
    }

    /// Export a unified audit log joining events, traces, and dismissals.
    /// Returns flat records sorted newest-first, capped at `limit`.
    pub fn export_audit_log(
        &self,
        from_ms: i64,
        to_ms:   i64,
        limit:   i64,
    ) -> Result<Vec<AuditRecord>, duckdb::Error> {
        let conn = self.0.lock().unwrap();
        let limit = limit.min(50_000);

        let mut stmt = conn.prepare(
            "SELECT ts_ms, record_type, node_id, level, event_type, message,
                    model, latency_ms, ttft_ms, tpot_ms
             FROM (
                SELECT ts_ms, 'event' AS record_type, node_id, level, event_type, message,
                       NULL AS model, NULL AS latency_ms, NULL AS ttft_ms, NULL AS tpot_ms
                FROM node_events
                WHERE ts_ms >= ? AND ts_ms <= ?

                UNION ALL

                SELECT ts_ms, 'trace' AS record_type, node_id, 'info' AS level,
                       'inference' AS event_type, model AS message,
                       model, latency_ms, ttft_ms, tpot_ms
                FROM inference_traces
                WHERE ts_ms >= ? AND ts_ms <= ?

                UNION ALL

                SELECT dismissed_at_ms AS ts_ms, 'dismissal' AS record_type,
                       node_id, 'info' AS level, 'dismiss' AS event_type,
                       pattern_id || COALESCE(': ' || note, '') AS message,
                       NULL, NULL, NULL, NULL
                FROM accepted_states
             )
             ORDER BY ts_ms DESC
             LIMIT ?",
        )?;

        let rows = stmt.query_map(
            params![from_ms, to_ms, from_ms, to_ms, limit],
            |row| {
                let ts_ms: i64 = row.get(0)?;
                Ok(AuditRecord {
                    ts_ms,
                    timestamp:   millis_to_iso8601(ts_ms),
                    record_type: row.get(1)?,
                    node_id:     row.get(2)?,
                    level:       row.get(3)?,
                    event_type:  row.get(4)?,
                    message:     row.get(5)?,
                    model:       row.get(6)?,
                    latency_ms:  row.get(7)?,
                    ttft_ms:     row.get(8)?,
                    tpot_ms:     row.get(9)?,
                })
            },
        )?.collect::<Result<_, _>>()?;

        Ok(rows)
    }
}

// ── Observation samples ──────────────────────────────────────────────────────

/// Lightweight sample for server-side pattern evaluation.
/// Pulled from `metrics_raw` over a short window (typically 5 min).
#[derive(Debug)]
#[allow(dead_code)] // mem_pressure_pct reserved for Pattern F
pub struct ObsSample {
    pub ts_ms:              i64,
    pub model:              Option<String>,
    pub tps:                Option<f64>,
    pub thermal_state:      Option<String>,
    pub gpu_power_w:        Option<f64>,
    pub cpu_power_w:        Option<f64>,
    pub mem_pressure_pct:   Option<f64>,
    pub swap_write_mb_s:    Option<f64>,
    // Extended fields for backend pattern evaluation (C/D/F/G/H/I/K/O)
    pub gpu_util_pct:          Option<f64>,
    pub vram_used_mb:          Option<i64>,
    pub vram_total_mb:         Option<i64>,
    pub clock_throttle_pct:    Option<f64>,
    // Inference latency fields for patterns P/Q/R
    pub ttft_ms:               Option<f64>,
    pub avg_latency_ms:        Option<f64>,
    pub queue_depth:           Option<i64>,
    // Phase 2 fields (C/I/M/N)
    pub penalty_avg:           Option<f64>,
    pub nvidia_gpu_temp_c:     Option<i32>,
    pub vllm_cache_usage_perc: Option<f64>,
}

/// Flat audit record combining events, traces, and dismissals.
#[derive(serde::Serialize)]
pub struct AuditRecord {
    pub ts_ms:       i64,
    pub timestamp:   String,
    pub record_type: String,
    pub node_id:     String,
    pub level:       String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_type:  Option<String>,
    pub message:     String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model:       Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms:  Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttft_ms:     Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tpot_ms:     Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fresh on-disk store in a unique temp dir (DuckDB CHECKPOINT needs a file).
    fn temp_store(tag: &str) -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "wicklee-store-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join("metrics.db")).unwrap();
        (store, dir)
    }

    #[test]
    fn receipts_survive_a_round_trip_and_a_retry_stores_one_row() {
        use crate::receipts::{Ambient, ReceiptSource, StartState, from_callback};

        let (store, dir) = temp_store("receipts");
        let t0 = 1_700_000_000_000_i64;
        let ambient = Ambient {
            ts_ms: t0,
            digest: Some("sha256:abc".into()),
            size_bytes: Some(5_280_104_447),
            size_vram_bytes: Some(5_280_104_447),
            running_context_length: Some(8192),
            co_resident: vec!["other:7b".into()],
            thermal_state: Some("Normal".into()),
            was_loaded: true,
        };
        let body = serde_json::json!({
            "model": "coder:14b",
            "total_duration": 8_113_331_500_u64,
            "load_duration": 6_396_458_u64,
            "prompt_eval_count": 26,
            "prompt_eval_duration": 130_079_000_u64,
            "eval_count": 298,
            "eval_duration": 4_868_000_000_u64,
            "num_ctx": 32768
        });
        let r = from_callback(&body, &ambient).unwrap();
        store.write_receipt("WK-TEST", &r).unwrap();

        let back = store.query_receipts("WK-TEST", None, 10).unwrap();
        assert_eq!(back.len(), 1);
        // Every field, because the point of the table is that the numbers
        // come back exactly as the runtime reported them.
        assert_eq!(back[0], r);
        assert_eq!(back[0].source, ReceiptSource::Callback);
        assert_eq!(back[0].start_state, StartState::Loaded);
        assert_eq!(back[0].co_resident, vec!["other:7b".to_string()]);
        assert!((back[0].decode_tps().unwrap() - 61.2).abs() < 0.1);

        // The same receipt posted twice is one row, not two: a retried POST
        // must not move a median.
        store.write_receipt("WK-TEST", &r).unwrap();
        assert_eq!(store.query_receipts("WK-TEST", None, 10).unwrap().len(), 1);

        // Newest first, and filterable by model.
        let mut later = ambient.clone();
        later.ts_ms = t0 + 60_000;
        let mut other_body = body.clone();
        other_body.as_object_mut().unwrap().insert("model".into(), serde_json::json!("tiny:1b"));
        let r2 = from_callback(&other_body, &later).unwrap();
        store.write_receipt("WK-TEST", &r2).unwrap();

        let all = store.query_receipts("WK-TEST", None, 10).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].model, "tiny:1b", "newest first");
        assert_eq!(
            store.query_receipts("WK-TEST", Some("coder:14b"), 10).unwrap().len(),
            1,
        );
        // Another node's receipts are its own.
        assert!(store.query_receipts("WK-OTHER", None, 10).unwrap().is_empty());

        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn findings_survive_a_real_round_trip_and_resolve_when_they_stop_firing() {
        use crate::findings::{Finding, Statement};
        use crate::residency::{Cause, ModelState, Residency, Transition, TransitionKind};

        let (store, dir) = temp_store("findings");
        let t0 = 1_700_000_000_000_i64;

        let tr = |model: &str| Transition {
            id: 1,
            ts_ms: t0,
            model: model.to_string(),
            kind: TransitionKind::Unloaded,
            cause: Cause::ExpiryReached,
            before: None,
            after: Some(Box::new(ModelState {
                model: model.to_string(),
                digest: None,
                residency: Residency::NotLoaded,
                size_bytes: None,
                size_vram_bytes: None,
                context_length: None,
                expires_at_ms: None,
                last_activity_ms: None,
                installed_size_bytes: None,
                measured: None,
                observed_at_ms: t0,
            })),
            co_resident: Vec::new(),
        };

        let finding = |rule: &'static str, model: &str| {
            let t = tr(model);
            let obs = Statement::observed(format!("{model} did a thing."), &[&t]).unwrap();
            let inf = Statement::inferred("It may matter.", &[&obs]).unwrap();
            Finding::new(rule, "warning", format!("{model}: {rule}"), vec![obs, inf], t0, t0)
                .unwrap()
        };

        let a = finding("cpu_split", "coder:14b");
        let b = finding("expiry_reload", "classifier:3b");

        // First evaluation: both open, nothing to resolve.
        assert_eq!(store.reconcile_findings("WK-TEST", &[a.clone(), b.clone()], t0).unwrap(), 0);
        let open = store.query_findings("WK-TEST", false).unwrap();
        assert_eq!(open.len(), 2, "both findings stored");
        let stored_a = open.iter().find(|f| f.id == a.id).expect("a is there");
        assert_eq!(stored_a.rule, "cpu_split");
        assert_eq!(stored_a.models, vec!["coder:14b".to_string()]);
        assert!(stored_a.resolved_at_ms.is_none());
        // The statements round-trip as the rule wrote them, labels included.
        assert_eq!(stored_a.statements.as_array().map(Vec::len), Some(2));
        assert_eq!(stored_a.statements[0]["label"], "observed");
        assert_eq!(stored_a.statements[1]["label"], "inferred");

        // Second evaluation, same two: an upsert, not a duplicate.
        let later = t0 + 60_000;
        assert_eq!(store.reconcile_findings("WK-TEST", &[a.clone(), b.clone()], later).unwrap(), 0);
        let open = store.query_findings("WK-TEST", false).unwrap();
        assert_eq!(open.len(), 2, "the content-derived id keyed the update");

        // Third evaluation: only `a` still fires, so `b` resolves.
        let later2 = t0 + 120_000;
        assert_eq!(store.reconcile_findings("WK-TEST", std::slice::from_ref(&a), later2).unwrap(), 1);
        let open = store.query_findings("WK-TEST", false).unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].id, a.id);

        let all = store.query_findings("WK-TEST", true).unwrap();
        assert_eq!(all.len(), 2, "the resolved one is still on record");
        // Open first, as the CLI's two sections expect.
        assert!(all[0].resolved_at_ms.is_none(), "open rows sort first");
        let stored_b = all.iter().find(|f| f.id == b.id).expect("b is there");
        assert_eq!(stored_b.resolved_at_ms, Some(later2));

        // `b` fires again: the row reopens rather than a second one appearing.
        assert_eq!(store.reconcile_findings("WK-TEST", &[a.clone(), b.clone()], t0 + 180_000).unwrap(), 0);
        let all = store.query_findings("WK-TEST", true).unwrap();
        assert_eq!(all.len(), 2, "no duplicate on reopen");
        assert!(
            all.iter().all(|f| f.resolved_at_ms.is_none()),
            "both are open again"
        );

        // Another node's findings are its own.
        assert_eq!(store.reconcile_findings("WK-OTHER", &[], t0 + 240_000).unwrap(), 0);
        assert_eq!(
            store.query_findings("WK-TEST", false).unwrap().len(),
            2,
            "reconciling an empty set for one node must not resolve another's"
        );
        assert!(store.query_findings("WK-OTHER", true).unwrap().is_empty());

        // An empty evaluation resolves everything this node had open.
        assert_eq!(store.reconcile_findings("WK-TEST", &[], t0 + 300_000).unwrap(), 2);
        assert!(store.query_findings("WK-TEST", false).unwrap().is_empty());
        assert_eq!(store.query_findings("WK-TEST", true).unwrap().len(), 2);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn transitions_survive_a_real_round_trip_through_duckdb() {
        use crate::residency::{
            Cause, ModelState, Residency, Transition, TransitionKind, derive_switches,
        };
        let (store, dir) = temp_store("transitions");

        let state = |ctx: Option<u64>| {
            Box::new(ModelState {
                model: "qwen3.5:4b".into(),
                digest: Some("sha256:abc".into()),
                residency: Residency::Loaded,
                size_bytes: Some(3_151_000_000),
                size_vram_bytes: Some(3_151_000_000),
                context_length: ctx,
                expires_at_ms: Some(1_794_580_004_305),
                last_activity_ms: Some(1_700_000_000_000),
                // A real measurement, so the nested struct is covered by the
                // round trip rather than serialising as null.
                measured: Some(crate::residency::MeasuredFootprint {
                    size_bytes: 3_151_000_000,
                    context_length: ctx.unwrap_or(4096),
                    digest: Some("sha256:abc".into()),
                    observed_at_ms: 1_700_000_000_000,
                }),
                installed_size_bytes: Some(3_389_983_735),
                observed_at_ms: 1_700_000_000_000,
            })
        };

        let rows = vec![
            Transition {
                id: 1,
                ts_ms: 1_700_000_000_000,
                model: "llama3.1:8b".into(),
                kind: TransitionKind::Unloaded,
                cause: Cause::ExpiryReached,
                before: Some(state(Some(8192))),
                after: None,
                co_resident: vec![],
            },
            Transition {
                id: 2,
                ts_ms: 1_700_000_000_000,
                model: "qwen3.5:4b".into(),
                kind: TransitionKind::Loaded,
                cause: Cause::User,
                before: None,
                after: Some(state(Some(4096))),
                co_resident: vec!["qwen3.5:9b".into(), "llama3.1:8b".into()],
            },
            Transition {
                id: 3,
                ts_ms: 1_700_000_005_000,
                model: "qwen3.5:4b".into(),
                kind: TransitionKind::ContextChanged,
                cause: Cause::Probe,
                before: Some(state(Some(4096))),
                after: Some(state(Some(2048))),
                co_resident: vec![],
            },
        ];
        store.write_transitions("WK-T", &rows).unwrap();

        // A different node's log is not this node's.
        store
            .write_transitions(
                "WK-OTHER",
                &[Transition { id: 9, model: "elsewhere".into(), ..rows[1].clone() }],
            )
            .unwrap();

        let back = store.query_transitions("WK-T", 0).unwrap();
        assert_eq!(back.len(), 3, "a different node's rows must not come back");
        assert_eq!(back, rows, "every field survives the round trip verbatim");

        // The window is honoured, and ordering is ascending for derive_switches.
        let recent = store.query_transitions("WK-T", 1_700_000_001_000).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].kind, TransitionKind::ContextChanged);
        assert_eq!(recent[0].cause, Cause::Probe);

        // End to end: the stored log derives the swap the endpoint reports.
        let out = derive_switches(&back, 24, false);
        assert_eq!(out["total_swaps"], 1);
        assert_eq!(out["swaps"][0]["from_model"], "llama3.1:8b");
        assert_eq!(out["swaps"][0]["to_model"], "qwen3.5:4b");
        assert_eq!(out["swaps"][0]["cause"], "expiry_reached");
        assert_eq!(out["swaps"][0]["co_resident"][0], "qwen3.5:9b");

        // A kind this binary does not know is skipped, not guessed at.
        {
            let conn = store.0.lock().unwrap();
            conn.execute(
                "INSERT INTO model_transitions
                   (id, ts_ms, node_id, model, kind, cause, co_resident)
                 VALUES (4, 1700000010000, 'WK-T', 'future:1b', 'teleported', 'user', '')",
                [],
            )
            .unwrap();
        }
        assert_eq!(
            store.query_transitions("WK-T", 0).unwrap().len(),
            3,
            "a row from a newer agent is skipped rather than misread"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    fn sample_json(ts_ms: i64) -> String {
        format!(
            r#"{{"node_id":"WK-T","timestamp_ms":{ts_ms},"cpu_usage_percent":10.0,
                "used_memory_mb":1000,"total_memory_mb":8000}}"#
        )
    }

    #[test]
    fn cached_sample_insert_is_reusable_and_dedupes() {
        let (store, dir) = temp_store("sample");
        let base = 1_700_000_000_000_i64;
        for i in 0..3 {
            store.write_sample(Sample::from_broadcast_json(&sample_json(base + i * 1000)).unwrap()).unwrap();
        }
        // Duplicate (ts_ms, node_id) → ON CONFLICT DO NOTHING, not an error.
        store.write_sample(Sample::from_broadcast_json(&sample_json(base)).unwrap()).unwrap();
        let h = store.query_history("WK-T", base, base + 10_000, Resolution::Raw).unwrap();
        assert_eq!(h.samples.len(), 3);
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn aggregation_prunes_and_checkpoints() {
        let (store, dir) = temp_store("agg");
        let now = 1_700_000_000_000_i64;
        let stale = now - 2 * 86_400_000; // older than raw retention
        store.write_sample(Sample::from_broadcast_json(&sample_json(stale)).unwrap()).unwrap();
        store.write_sample(Sample::from_broadcast_json(&sample_json(now - 120_000)).unwrap()).unwrap();
        store.run_aggregation(now).unwrap();
        let h = store.query_history("WK-T", stale - 1, now, Resolution::Raw).unwrap();
        assert_eq!(h.samples.len(), 1, "stale raw row pruned, recent kept");
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn write_catalog_batches_in_one_transaction() {
        let (store, dir) = temp_store("catalog");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        let rows: Vec<_> = (0..5u64)
            .map(|i| (format!("org/m{i}"), format!("m{i}.Q4_K_M.gguf"), "Q4_K_M".to_string(), 1_000 + i, 10 * i, i, now))
            .collect();
        store.write_catalog(&rows).unwrap();
        // Replaying the same batch replaces rather than duplicates.
        store.write_catalog(&rows).unwrap();
        assert!(store.catalog_is_fresh(24));
        assert_eq!(store.query_catalog(None, 100).unwrap().len(), 5);
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// One finding as the store holds it.
///
/// `statements` is passed through as JSON rather than deserialised: `Statement`
/// is Serialize-only by design, and a reader of this row wants exactly what the
/// rule wrote, not a round trip through a second type that could disagree with
/// it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct StoredFinding {
    pub id:             String,
    pub rule:           String,
    pub severity:       String,
    pub title:          String,
    pub models:         Vec<String>,
    pub statements:     serde_json::Value,
    pub first_seen_ms:  i64,
    pub last_seen_ms:   i64,
    /// `None` while the finding is open.
    pub resolved_at_ms: Option<i64>,
}

impl Store {
    /// Record this evaluation's findings and resolve the ones it no longer
    /// produced. Returns how many it resolved.
    ///
    /// Resolution is observed, not scheduled: a finding resolves because an
    /// evaluation ran and did not produce it. So `resolved_at_ms` is when
    /// Wicklee last looked and did not see it, which is all it can honestly
    /// claim — the condition may have stopped at any point since the previous
    /// evaluation.
    pub fn reconcile_findings(
        &self,
        node_id: &str,
        open: &[crate::findings::Finding],
        now_ms: i64,
    ) -> Result<usize, duckdb::Error> {
        let mut conn = self.0.lock().unwrap();
        let tx = conn.transaction()?;

        // UPDATE then INSERT rather than ON CONFLICT: the upsert syntax has
        // moved across DuckDB versions and this runs on a request path, so two
        // portable statements beat one that might not parse.
        {
            let mut upd = tx.prepare(
                "UPDATE findings
                    SET rule = ?, severity = ?, title = ?, models = ?,
                        statements = ?, first_seen_ms = ?, last_seen_ms = ?,
                        resolved_at_ms = NULL
                  WHERE node_id = ? AND id = ?",
            )?;
            let mut ins = tx.prepare(
                "INSERT INTO findings
                   (node_id, id, rule, severity, title, models, statements,
                    first_seen_ms, last_seen_ms, resolved_at_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
            )?;
            for f in open {
                // Model names cannot contain a comma, as write_transitions
                // already relies on for co_resident.
                let models = f.models.join(",");
                let statements = serde_json::to_string(&f.statements).ok();
                // first_seen_ms is the rule's, derived from the log, so a
                // finding that recurs after a quiet spell reports the current
                // occurrence rather than the first one ever recorded.
                let changed = upd.execute(params![
                    f.rule,
                    f.severity,
                    f.title.as_str(),
                    models.as_str(),
                    statements,
                    f.first_seen_ms,
                    f.last_seen_ms,
                    node_id,
                    f.id.as_str(),
                ])?;
                if changed == 0 {
                    ins.execute(params![
                        node_id,
                        f.id.as_str(),
                        f.rule,
                        f.severity,
                        f.title.as_str(),
                        models.as_str(),
                        statements,
                        f.first_seen_ms,
                        f.last_seen_ms,
                    ])?;
                }
            }
        }

        // Which rows are open now that this evaluation's findings are written.
        // Read the ids and update them one at a time rather than building a
        // `NOT IN (...)` list: a handful of findings makes the statement count
        // irrelevant, and nothing is interpolated into SQL.
        let still_open: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT id FROM findings WHERE node_id = ? AND resolved_at_ms IS NULL",
            )?;
            let rows = stmt.query_map(params![node_id], |r| r.get::<_, String>(0))?;
            rows.filter_map(Result::ok).collect()
        };
        let mut resolved = 0usize;
        {
            let mut res = tx.prepare(
                "UPDATE findings SET resolved_at_ms = ? WHERE node_id = ? AND id = ?",
            )?;
            for id in &still_open {
                if !open.iter().any(|f| f.id == *id) {
                    resolved += res.execute(params![now_ms, node_id, id.as_str()])?;
                }
            }
        }

        tx.commit()?;
        Ok(resolved)
    }

    /// Findings for a node: the open ones, and the resolved ones when asked.
    ///
    /// Open first, then most recently seen, so `wicklee findings --all` reads
    /// as "what is wrong now, and what used to be".
    pub fn query_findings(
        &self,
        node_id: &str,
        include_resolved: bool,
    ) -> Result<Vec<StoredFinding>, duckdb::Error> {
        const COLS: &str = "id, rule, severity, title, models, statements,
                            first_seen_ms, last_seen_ms, resolved_at_ms";
        let conn = self.0.lock().unwrap();
        let sql = if include_resolved {
            format!(
                "SELECT {COLS} FROM findings WHERE node_id = ?
                  ORDER BY resolved_at_ms IS NOT NULL, last_seen_ms DESC"
            )
        } else {
            format!(
                "SELECT {COLS} FROM findings
                  WHERE node_id = ? AND resolved_at_ms IS NULL
                  ORDER BY last_seen_ms DESC"
            )
        };
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![node_id], |r| {
            let models: String = r.get(4)?;
            let statements: Option<String> = r.get(5)?;
            Ok(StoredFinding {
                id:       r.get(0)?,
                rule:     r.get(1)?,
                severity: r.get(2)?,
                title:    r.get(3)?,
                models:   models
                    .split(',')
                    .filter(|m| !m.is_empty())
                    .map(str::to_string)
                    .collect(),
                // An unreadable statements column costs the sentences, not the
                // row: the title still says what was found.
                statements: statements
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_else(|| serde_json::json!([])),
                first_seen_ms:  r.get(6)?,
                last_seen_ms:   r.get(7)?,
                resolved_at_ms: r.get(8)?,
            })
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    /// Store one receipt. A receipt already stored under the same id is
    /// replaced rather than duplicated, so a caller that retries a POST does
    /// not pull its own median around.
    pub fn write_receipt(
        &self,
        node_id: &str,
        r: &crate::receipts::Receipt,
    ) -> Result<(), duckdb::Error> {
        // u64 to i64: every column here is a nanosecond duration or a token
        // count, and i64 nanoseconds runs to the year 2262. A value that did
        // not fit would be a runtime reporting nonsense, which is worth
        // storing as NULL rather than as a negative number.
        let n = |v: Option<u64>| v.and_then(|x| i64::try_from(x).ok());
        let conn = self.0.lock().unwrap();
        // DELETE then INSERT for the same reason reconcile_findings does
        // UPDATE then INSERT: the upsert syntax has moved between DuckDB
        // versions and this runs on a request path.
        conn.execute("DELETE FROM receipts WHERE node_id = ? AND id = ?", params![node_id, r.id.as_str()])?;
        conn.execute(
            "INSERT INTO receipts
               (node_id, id, ts_ms, source, model, digest, context_length,
                size_bytes, size_vram_bytes, start_state, load_ns,
                prompt_eval_count, prompt_eval_cached_count, prompt_eval_ns,
                eval_count, eval_ns, total_ns, wall_ms, co_resident,
                thermal_state, test_id, finding_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                node_id,
                r.id.as_str(),
                r.ts_ms,
                r.source.as_str(),
                r.model.as_str(),
                r.digest.as_deref(),
                n(r.context_length),
                n(r.size_bytes),
                n(r.size_vram_bytes),
                r.start_state.as_str(),
                n(r.load_ns),
                n(r.prompt_eval_count),
                n(r.prompt_eval_cached_count),
                n(r.prompt_eval_ns),
                n(r.eval_count),
                n(r.eval_ns),
                n(r.total_ns),
                n(r.wall_ms),
                // Model names cannot contain a comma, as write_transitions
                // already relies on.
                r.co_resident.join(",").as_str(),
                r.thermal_state.as_deref(),
                r.test_id.as_deref(),
                r.finding_id.as_deref(),
            ],
        )?;
        Ok(())
    }

    /// Store one verify run. Replaced rather than duplicated on the same id,
    /// which is derived from the finding and the run's start.
    pub fn write_verify_run(
        &self,
        node_id: &str,
        v: &crate::fingerprint::VerifyRun,
    ) -> Result<(), duckdb::Error> {
        let config = serde_json::to_string(&v.config).ok();
        let conn = self.0.lock().unwrap();
        conn.execute(
            "DELETE FROM verify_runs WHERE node_id = ? AND id = ?",
            params![node_id, v.id.as_str()],
        )?;
        conn.execute(
            "INSERT INTO verify_runs
               (node_id, id, finding_id, ts_ms, config, models, receipts, median, low, high)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                node_id,
                v.id.as_str(),
                v.finding_id.as_str(),
                v.ts_ms,
                config,
                v.models.join(",").as_str(),
                v.receipts.join(",").as_str(),
                v.median,
                v.low,
                v.high,
            ],
        )?;
        Ok(())
    }

    /// Every verify run on this node, oldest first.
    ///
    /// One query for the whole set rather than one per finding: a host has a
    /// handful of findings with a few runs each, and `evaluate` wants them all.
    pub fn query_all_verify_runs(
        &self,
        node_id: &str,
    ) -> Result<Vec<crate::fingerprint::VerifyRun>, duckdb::Error> {
        self.verify_runs_where(node_id, None)
    }

    /// Runs for one finding, oldest first.
    ///
    /// Oldest first, unlike every other read here, because the first run is
    /// the baseline by definition and a caller comparing two wants them in the
    /// order they happened.
    pub fn query_verify_runs(
        &self,
        node_id: &str,
        finding_id: &str,
    ) -> Result<Vec<crate::fingerprint::VerifyRun>, duckdb::Error> {
        self.verify_runs_where(node_id, Some(finding_id))
    }

    /// Both reads above, with the one clause that differs.
    fn verify_runs_where(
        &self,
        node_id: &str,
        finding_id: Option<&str>,
    ) -> Result<Vec<crate::fingerprint::VerifyRun>, duckdb::Error> {
        const COLS: &str = "id, finding_id, ts_ms, config, models, receipts, median, low, high";
        let conn = self.0.lock().unwrap();
        let sql = match finding_id {
            Some(_) => format!(
                "SELECT {COLS} FROM verify_runs WHERE node_id = ? AND finding_id = ?
                  ORDER BY ts_ms ASC"
            ),
            None => format!(
                "SELECT {COLS} FROM verify_runs WHERE node_id = ? ORDER BY ts_ms ASC"
            ),
        };
        let mut stmt = conn.prepare(&sql)?;
        let csv = |s: String| -> Vec<String> {
            s.split(',').filter(|x| !x.is_empty()).map(str::to_string).collect()
        };
        let build = |r: &duckdb::Row| -> Result<crate::fingerprint::VerifyRun, duckdb::Error> {
            let config: Option<String> = r.get(3)?;
            let models: String = r.get(4)?;
            let receipts: String = r.get(5)?;
            Ok(crate::fingerprint::VerifyRun {
                id: r.get(0)?,
                finding_id: r.get(1)?,
                ts_ms: r.get(2)?,
                // An unreadable config costs the diff, not the comparison:
                // the medians and ranges are still the measurement.
                config: config.and_then(|c| serde_json::from_str(&c).ok()).unwrap_or_default(),
                models: csv(models),
                receipts: csv(receipts),
                median: r.get(6)?,
                low: r.get(7)?,
                high: r.get(8)?,
            })
        };
        match finding_id {
            Some(f) => {
                let rows = stmt.query_map(params![node_id, f], build)?;
                Ok(rows.filter_map(Result::ok).collect())
            }
            None => {
                let rows = stmt.query_map(params![node_id], build)?;
                Ok(rows.filter_map(Result::ok).collect())
            }
        }
    }

    /// Receipts for this node, newest first, optionally for one model.
    ///
    /// `limit` is required rather than optional: every caller wants a recent
    /// window, and an unbounded read of thirty days of proxy receipts on a
    /// busy host would hold the store mutex long enough to stall the writer.
    pub fn query_receipts(
        &self,
        node_id: &str,
        model: Option<&str>,
        limit: usize,
    ) -> Result<Vec<crate::receipts::Receipt>, duckdb::Error> {
        use crate::receipts::{Receipt, ReceiptSource, StartState};
        const COLS: &str = "id, ts_ms, source, model, digest, context_length,
                            size_bytes, size_vram_bytes, start_state, load_ns,
                            prompt_eval_count, prompt_eval_cached_count,
                            prompt_eval_ns, eval_count, eval_ns, total_ns,
                            wall_ms, co_resident, thermal_state, test_id,
                            finding_id";
        let limit = limit.min(10_000) as i64;
        let conn = self.0.lock().unwrap();
        let u = |v: Option<i64>| v.and_then(|x| u64::try_from(x).ok());
        let build = |r: &duckdb::Row| -> Result<Receipt, duckdb::Error> {
            let source: String = r.get(2)?;
            let start: String = r.get(8)?;
            let co: String = r.get(17)?;
            Ok(Receipt {
                id: r.get(0)?,
                ts_ms: r.get(1)?,
                // An unreadable name falls back rather than dropping the row:
                // the measurements are still exact, and Callback is the
                // honest guess because it is the only source a stranger can
                // write to.
                source: ReceiptSource::from_name(&source).unwrap_or(ReceiptSource::Callback),
                model: r.get(3)?,
                digest: r.get(4)?,
                context_length: u(r.get(5)?),
                size_bytes: u(r.get(6)?),
                size_vram_bytes: u(r.get(7)?),
                start_state: StartState::from_name(&start).unwrap_or(StartState::ColdUnknown),
                load_ns: u(r.get(9)?),
                prompt_eval_count: u(r.get(10)?),
                prompt_eval_cached_count: u(r.get(11)?),
                prompt_eval_ns: u(r.get(12)?),
                eval_count: u(r.get(13)?),
                eval_ns: u(r.get(14)?),
                total_ns: u(r.get(15)?),
                wall_ms: u(r.get(16)?),
                co_resident: co.split(',').filter(|m| !m.is_empty()).map(str::to_string).collect(),
                thermal_state: r.get(18)?,
                test_id: r.get(19)?,
                finding_id: r.get(20)?,
            })
        };
        match model {
            Some(m) => {
                let mut stmt = conn.prepare(&format!(
                    "SELECT {COLS} FROM receipts WHERE node_id = ? AND model = ?
                      ORDER BY ts_ms DESC LIMIT ?"
                ))?;
                let rows = stmt.query_map(params![node_id, m, limit], build)?;
                Ok(rows.filter_map(Result::ok).collect())
            }
            None => {
                let mut stmt = conn.prepare(&format!(
                    "SELECT {COLS} FROM receipts WHERE node_id = ?
                      ORDER BY ts_ms DESC LIMIT ?"
                ))?;
                let rows = stmt.query_map(params![node_id, limit], build)?;
                Ok(rows.filter_map(Result::ok).collect())
            }
        }
    }
}
