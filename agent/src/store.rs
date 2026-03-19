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
    #[serde(default)] nvidia_power_draw_w:             Option<f32>,
    #[serde(default)] nvidia_gpu_utilization_percent:  Option<f32>,
    #[serde(default)] gpu_utilization_percent:         Option<f32>,
    #[serde(default)] nvidia_vram_used_mb:             Option<u64>,
    #[serde(default)] nvidia_vram_total_mb:            Option<u64>,
    #[serde(default)] thermal_state:                   Option<String>,
    #[serde(default)] memory_pressure_percent:         Option<f32>,
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
            // NVIDIA: nvidia_power_draw_w. Apple: gpu_utilization × budget (power not directly exposed).
            // For now store only direct measurements; Apple GPU power estimation is Phase 2.2.
            gpu_power_w:      self.nvidia_power_draw_w.map(|v| v as f64),
            // NVIDIA preferred; fall back to Apple Silicon iogpu utilization.
            gpu_util_pct:     self.nvidia_gpu_utilization_percent
                                  .or(self.gpu_utilization_percent)
                                  .map(|v| v as f64),
            vram_used_mb:     self.nvidia_vram_used_mb.map(|v| v as i64),
            vram_total_mb:    self.nvidia_vram_total_mb.map(|v| v as i64),
            thermal_state:    self.thermal_state,
            mem_pressure_pct: self.memory_pressure_percent.map(|v| v as f64),
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
}

#[derive(Debug, Serialize)]
pub struct HistoryResponse {
    pub node_id:    String,
    pub resolution: &'static str,
    pub from_ms:    i64,
    pub to_ms:      i64,
    pub samples:    Vec<HistorySample>,
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
              vram_used_mb, vram_total_mb, thermal_state, mem_pressure_pct)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        let raw_cutoff = now_ms - 86_400_000_i64;           // 24 h
        let min_cutoff = now_ms - 30_i64 * 86_400_000_i64;  // 30 d
        let hr_cutoff  = now_ms - 90_i64 * 86_400_000_i64;  // 90 d

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
                            gpu_util_pct, gpu_power_w, vram_used_mb, thermal_state
                     FROM metrics_raw
                     WHERE node_id = ? AND ts_ms >= ? AND ts_ms <= ?
                     ORDER BY ts_ms ASC",
                )?;
                stmt.query_map(params![node_id, from_ms, to_ms], |row| {
                    Ok(HistorySample {
                        ts_ms:         row.get(0)?,
                        model:         row.get(1)?,
                        tps:           row.get(2)?,
                        tps_avg:       None,
                        tps_max:       None,
                        tps_p95:       None,
                        cpu_usage_pct: row.get(3)?,
                        gpu_util_pct:  row.get(4)?,
                        gpu_power_w:   row.get(5)?,
                        vram_used_mb:  row.get(6)?,
                        thermal_state: row.get(7)?,
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
                        tps_p95:       None,
                        cpu_usage_pct: row.get(5)?,
                        gpu_util_pct:  row.get(6)?,
                        gpu_power_w:   row.get(7)?,
                        vram_used_mb:  row.get(8)?,
                        thermal_state: None,
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
                        tps_p95:       row.get(4)?,
                        cpu_usage_pct: row.get(5)?,
                        gpu_util_pct:  row.get(6)?,
                        gpu_power_w:   row.get(7)?,
                        vram_used_mb:  row.get(8)?,
                        thermal_state: None,
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
}
