//! Wicklee local metrics store — DuckDB three-tier columnar schema.
//!
//! Tier 0 (metrics_raw):   1 Hz samples,       24-hour retention
//! Tier 1 (metrics_1min):  1-minute aggregates, 30-day  retention
//! Tier 2 (metrics_1hr):   1-hour  aggregates,  90-day  retention
//!
//! All timestamps are stored as INTEGER (Unix milliseconds) so serialisation
//! to JSON never requires format negotiation.
//!
//! The `Store` handle is `Clone`-cheap (Arc inside) and `Send + Sync` — safe to
//! share between the broadcast-writer task and the Axum `/api/history` handler.
//!
//! # Threading model
//! DuckDB's `Connection` is `Send` but not `Sync`; the `Mutex<Connection>`
//! wrapper makes the store `Sync`.  Write calls from the async broadcast
//! subscriber hold the lock for < 1 ms and are fire-and-forget at 1 Hz.
//! The hourly aggregation is dispatched via `tokio::task::spawn_blocking`
//! so it never blocks the async executor even if it takes a few seconds.

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
    let mut days  = total_secs.div_euclid(86400) as i64;
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
                eval_duration_ns  BIGINT
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

            -- Migrations: add columns introduced after the initial schema.
            -- DuckDB supports ADD COLUMN IF NOT EXISTS — safe to run on every startup.
            ALTER TABLE metrics_raw ADD COLUMN IF NOT EXISTS swap_write_mb_s    DOUBLE;
            ALTER TABLE metrics_raw ADD COLUMN IF NOT EXISTS clock_throttle_pct DOUBLE;
        ")
    }

    // ── Write ─────────────────────────────────────────────────────────────────

    /// Insert one raw sample.
    /// Conflicts (same ts_ms + node_id) are silently discarded — safe on restart
    /// within the same wall-clock second or minor clock adjustments.
    pub fn write_sample(&self, s: Sample) -> Result<(), duckdb::Error> {
        self.0.lock().unwrap().execute(
            "INSERT INTO metrics_raw
             (ts_ms, node_id, model, tps,
              cpu_usage_pct, mem_used_mb, mem_total_mb,
              cpu_power_w, gpu_power_w, gpu_util_pct,
              vram_used_mb, vram_total_mb, thermal_state, mem_pressure_pct,
              swap_write_mb_s, clock_throttle_pct)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (ts_ms, node_id) DO NOTHING",
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
              MAX(model)                                        AS model,
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
        // PERCENTILE_CONT is a DuckDB ordered-set aggregate — gives true p95
        // without materialising all raw samples.
        conn.execute_batch(&format!("
            INSERT INTO metrics_1hr
              (ts_ms, node_id, model,
               tps_avg, tps_max, tps_p95,
               cpu_usage_avg, gpu_util_avg, gpu_power_avg,
               vram_used_avg, sample_count)
            SELECT
              (ts_ms / 3600000) * 3600000                                AS ts_ms,
              node_id,
              MAX(model)                                                  AS model,
              AVG(tps_avg)                                                AS tps_avg,
              MAX(tps_max)                                                AS tps_max,
              PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY tps_avg)      AS tps_p95,
              AVG(cpu_usage_avg)                                          AS cpu_usage_avg,
              AVG(gpu_util_avg)                                           AS gpu_util_avg,
              AVG(gpu_power_avg)                                          AS gpu_power_avg,
              CAST(AVG(vram_used_avg) AS BIGINT)                         AS vram_used_avg,
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
        "))?;

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
                            swap_write_mb_s, clock_throttle_pct
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
        let res = self.0.lock().unwrap().execute(
            "INSERT INTO inference_traces
             (id, ts_ms, node_id, model, latency_ms, ttft_ms, tpot_ms, status,
              eval_count, eval_duration_ns)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO NOTHING",
            params![
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
            ],
        );
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
        let res = self.0.lock().unwrap().execute(
            "INSERT INTO node_events (ts_ms, node_id, level, event_type, message)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (ts_ms, node_id, message) DO NOTHING",
            params![ts_ms, node_id, level, event_type, message],
        );
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
    /// Call periodically (e.g., alongside the hourly aggregation).
    #[allow(dead_code)]
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
                    swap_write_mb_s
             FROM metrics_raw
             WHERE node_id = ? AND ts_ms >= ?
             ORDER BY ts_ms ASC",
        )?;
        let rows = stmt.query_map(params![node_id, from], |row| {
            Ok(ObsSample {
                ts_ms:            row.get(0)?,
                model:            row.get(1)?,
                tps:              row.get(2)?,
                thermal_state:    row.get(3)?,
                gpu_power_w:      row.get(4)?,
                cpu_power_w:      row.get(5)?,
                mem_pressure_pct: row.get(6)?,
                swap_write_mb_s:  row.get(7)?,
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
    pub ts_ms:            i64,
    pub model:            Option<String>,
    pub tps:              Option<f64>,
    pub thermal_state:    Option<String>,
    pub gpu_power_w:      Option<f64>,
    pub cpu_power_w:      Option<f64>,
    pub mem_pressure_pct: Option<f64>,
    pub swap_write_mb_s:  Option<f64>,
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
