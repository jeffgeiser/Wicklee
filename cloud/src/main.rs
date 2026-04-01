use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, Method, Request, StatusCode},
    middleware::{self, Next},
    response::{sse::{Event, KeepAlive, Sse}, IntoResponse, Response},
    routing::{delete, get, patch, post},
    Json, Router,
};
use sha2::{Sha256, Digest};
use std::convert::Infallible;
use std::time::Duration;
use tokio_stream::StreamExt as _;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use tokio::sync::mpsc;

// ── Shared payload shape — must stay in sync with the agent ──────────────────
//
// IMPORTANT: Every field the agent's MetricsPayload serializes must appear here.
// Serde silently drops unknown fields during deserialization — any field missing
// from this struct is lost before it reaches the in-memory cache and SSE stream.
// The SSE stream serves `entry.metrics` verbatim; the fleet frontend depends on
// receiving every field the agent sends.

#[derive(Deserialize, Serialize, Clone)]
struct MetricsPayload {
    node_id:                        String,
    #[serde(default)]
    hostname:                       Option<String>,
    #[serde(default)]
    gpu_name:                       Option<String>,
    #[serde(default)]
    chip_name:                      Option<String>,
    cpu_usage_percent:              f32,
    total_memory_mb:                u64,
    used_memory_mb:                 u64,
    available_memory_mb:            u64,
    cpu_core_count:                 usize,
    timestamp_ms:                   u64,
    // Apple Silicon deep-metal
    #[serde(default)]
    gpu_wired_limit_mb:             Option<u64>,
    cpu_power_w:                    Option<f32>,
    ecpu_power_w:                   Option<f32>,
    pcpu_power_w:                   Option<f32>,
    /// GPU-only power from powermetrics "GPU Power:" line.
    #[serde(default)]
    apple_gpu_power_w:              Option<f32>,
    /// Total SoC power: Combined Power (CPU + GPU + ANE). Authoritative for WES.
    #[serde(default)]
    apple_soc_power_w:              Option<f32>,
    gpu_utilization_percent:        Option<f32>,
    memory_pressure_percent:        Option<f32>,
    thermal_state:                  Option<String>,
    // NVIDIA
    nvidia_gpu_utilization_percent: Option<f32>,
    nvidia_vram_used_mb:            Option<u64>,
    nvidia_vram_total_mb:           Option<u64>,
    nvidia_gpu_temp_c:              Option<u32>,
    nvidia_power_draw_w:            Option<f32>,
    // Ollama runtime
    #[serde(default)]
    ollama_running:       bool,
    #[serde(default)]
    ollama_active_model:  Option<String>,
    #[serde(default)]
    ollama_model_size_gb: Option<f32>,
    #[serde(default)]
    ollama_quantization:  Option<String>,
    #[serde(default)]
    ollama_tokens_per_second: Option<f32>,
    #[serde(default)]
    ollama_prompt_eval_tps: Option<f32>,
    #[serde(default)]
    ollama_ttft_ms: Option<f32>,
    #[serde(default)]
    ollama_load_duration_ms: Option<f32>,
    /// True when a user request completed within the last 35s (Tier 2 attribution).
    #[serde(default)]
    ollama_inference_active: Option<bool>,
    /// True when the Wicklee transparent proxy is active on :11434.
    #[serde(default)]
    ollama_proxy_active: Option<bool>,
    #[serde(default)]
    ollama_proxy_avg_ttft_ms: Option<f32>,
    #[serde(default)]
    ollama_proxy_avg_latency_ms: Option<f32>,
    #[serde(default)]
    ollama_proxy_request_count: Option<u64>,
    #[serde(default)]
    proxy_listen_port: Option<u16>,
    #[serde(default)]
    proxy_target_port: Option<u16>,
    #[serde(default)]
    runtime_port_overrides: Option<String>,
    /// True during probe and 40s afterward — frontend uses for IDLE-SPD display.
    #[serde(default)]
    ollama_is_probing: Option<bool>,
    #[serde(default)]
    os: Option<String>,
    /// CPU architecture: "x86_64" | "aarch64".
    #[serde(default)]
    arch: Option<String>,
    // vLLM runtime
    #[serde(default)]
    vllm_running:          bool,
    #[serde(default)]
    vllm_model_name:       Option<String>,
    #[serde(default)]
    vllm_tokens_per_sec:   Option<f32>,
    #[serde(default)]
    vllm_cache_usage_perc: Option<f32>,
    #[serde(default)]
    vllm_requests_running: Option<u32>,
    #[serde(default)]
    vllm_requests_waiting: Option<u32>,
    #[serde(default)]
    vllm_requests_swapped: Option<u32>,
    #[serde(default)]
    vllm_avg_ttft_ms: Option<f32>,
    #[serde(default)]
    vllm_avg_e2e_latency_ms: Option<f32>,
    #[serde(default)]
    vllm_avg_queue_time_ms: Option<f32>,
    #[serde(default)]
    vllm_prompt_tokens_total: Option<u64>,
    #[serde(default)]
    vllm_generation_tokens_total: Option<u64>,
    // llama.cpp / llama-box runtime
    #[serde(default)]
    llamacpp_running:          bool,
    #[serde(default)]
    llamacpp_model_name:       Option<String>,
    #[serde(default)]
    llamacpp_tokens_per_sec:   Option<f32>,
    #[serde(default)]
    llamacpp_slots_processing: Option<u32>,
    // ── WES v2 thermal-penalty window ─────────────────────────────────────────
    #[serde(default)]
    penalty_avg:    Option<f32>,
    #[serde(default)]
    penalty_peak:   Option<f32>,
    #[serde(default)]
    thermal_source: Option<String>,
    #[serde(default)]
    sample_count:   Option<u32>,
    #[serde(default)]
    wes_version:    Option<u8>,
    // ── Deep Metal expansion (v0.4.30+) ───────────────────────────────────────
    #[serde(default)]
    swap_write_mb_s:     Option<f32>,
    #[serde(default)]
    clock_throttle_pct:  Option<f32>,
    #[serde(default)]
    pcie_link_width:     Option<u32>,
    #[serde(default)]
    pcie_link_max_width: Option<u32>,
    // ── Per-model WES baseline (v0.7.8+) ───────────────────────────────────────
    #[serde(default)]
    model_baseline_tps:     Option<f32>,
    #[serde(default)]
    model_baseline_wes:     Option<f32>,
    #[serde(default)]
    model_baseline_samples: Option<u32>,
    // ── Agent identity + state (v0.5.10+) ─────────────────────────────────────
    /// Compile-time agent version from Cargo.toml.
    #[serde(default)]
    agent_version:   Option<String>,
    /// Authoritative inference state: "live" | "idle-spd" | "busy" | "idle".
    /// SSOT — fleet frontend must display this directly, never re-derive.
    #[serde(default)]
    inference_state: Option<String>,
    // ── Live Activity events (v0.5.16+) ──────────────────────────────────────
    /// Ephemeral lifecycle events drained from the agent on each broadcast tick.
    /// Persisted to cloud `node_events` for fleet event history.
    #[serde(default)]
    live_activities: Vec<LiveActivityEventPayload>,
}

/// A single Live Activity event as received from the agent's telemetry push.
#[derive(Deserialize, Serialize, Clone)]
struct LiveActivityEventPayload {
    message:      String,
    timestamp_ms: u64,
    #[serde(default)]
    level:        String,
    #[serde(default)]
    event_type:   Option<String>,
}

// ── Auth request / response types ────────────────────────────────────────────

#[derive(Deserialize)]
struct SignupRequest {
    email:     String,
    password:  String,
    full_name: String,
}

#[derive(Deserialize)]
struct LoginRequest {
    email:    String,
    password: String,
}

/// Shape that matches the frontend User interface in types.ts.
#[derive(Serialize, Clone)]
struct UserResponse {
    id:        String,
    email:     String,
    #[serde(rename = "fullName")]
    full_name: String,
    role:      String,
    #[serde(rename = "isPro")]
    is_pro:    bool,
}

#[derive(Serialize)]
struct AuthResponse {
    token: String,
    user:  UserResponse,
}

// ── Fleet request / response types ───────────────────────────────────────────

#[derive(Deserialize)]
struct ClaimRequest {
    /// 6-digit code displayed by the agent's --pair flow.
    code:      String,
    /// The agent's reachable local URL, e.g. "http://192.168.1.5:7700".
    fleet_url: String,
    /// WK-XXXX identity assigned by the agent at first run.
    node_id:   String,
}

#[derive(Serialize)]
struct ClaimResponse {
    session_token: String,
    node_id:       String,
}

/// In-memory telemetry snapshot.
#[derive(Clone)]
struct MetricsEntry {
    last_seen_ms: u64,
    metrics:      Option<MetricsPayload>,
}

/// One row of derived telemetry ready for Postgres ingest.
/// Built from MetricsPayload on every incoming frame; flushed in 30-second batches.
#[derive(Clone)]
struct MetricsRow {
    node_id:          String,
    ts_ms:            i64,
    tenant_id:        String,           // user_id; set after node lookup
    tok_s:            Option<f32>,
    watts:            Option<f32>,
    wes_raw:          Option<f32>,      // tok_s / watts, no penalty
    wes_penalized:    Option<f32>,      // tok_s / (watts × penalty)
    thermal_cost_pct: Option<f32>,
    thermal_penalty:  Option<f32>,      // 1.0 / 1.25 / 1.75 / 2.0
    thermal_state:    Option<String>,
    vram_used_mb:     Option<i32>,
    vram_total_mb:    Option<i32>,
    mem_pressure_pct: Option<f32>,
    gpu_pct:          Option<f32>,
    cpu_pct:          Option<f32>,
    inference_state:  Option<String>,    // "live" | "idle-spd" | "busy" | "idle"
    wes_version:      u8,               // incremented when WES formula changes
    swap_write:       Option<f32>,      // swap write MB/s — SSD degradation indicator
    ttft_ms:          Option<f32>,      // best-available TTFT (vLLM > proxy > Ollama probe)
    avg_latency_ms:   Option<f32>,      // best-available E2E latency (vLLM > proxy)
    queue_depth:      Option<i32>,      // vLLM requests_waiting
}

/// A Live Activity event destined for the `node_events` table.
#[derive(Clone)]
struct EventRow {
    ts_ms:      i64,
    node_id:    String,
    tenant_id:  String,
    level:      String,
    event_type: Option<String>,
    message:    String,
}

#[derive(Serialize)]
struct NodeSummary {
    node_id:      String,
    fleet_url:    String,
    last_seen_ms: u64,
    metrics:      Option<MetricsPayload>,
    restricted:   bool,
}

#[derive(Serialize)]
struct FleetResponse {
    nodes: Vec<NodeSummary>,
}

// ── Clerk JWKS types ──────────────────────────────────────────────────────────

/// A single RSA public key from the Clerk JWKS endpoint.
#[derive(Deserialize, Clone)]
struct JwkKey {
    kid: String,
    n:   String,   // base64url modulus
    e:   String,   // base64url exponent
}

#[derive(Deserialize)]
struct JwksResponse {
    keys: Vec<JwkKey>,
}

// ── App state ─────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct AppState {
    /// Postgres connection pool (replaces both SQLite and DuckDB).
    pool:             sqlx::PgPool,
    /// In-memory telemetry cache keyed by node_id.
    metrics:          Arc<RwLock<HashMap<String, MetricsEntry>>>,
    /// Cached Clerk public keys for JWT verification.  Refreshed every 6 h.
    clerk_keys:       Arc<RwLock<Vec<JwkKey>>>,
    /// Sliding-window rate-limit timestamps keyed by api_key key_id.
    api_rate_limits:  Arc<Mutex<HashMap<String, Vec<u64>>>>,
    /// IP-based rate-limit for auth endpoints (login/signup). 10 requests per 60s.
    auth_rate_limits: Arc<Mutex<HashMap<String, Vec<u64>>>>,
    /// Channel to the metrics writer task.  try_send drops rows if the writer
    /// falls behind; that's acceptable for telemetry.
    metrics_tx:       mpsc::Sender<MetricsRow>,
    /// Channel to the event writer task.  Persists Live Activity events
    /// for the fleet event history endpoint.
    events_tx:        mpsc::Sender<EventRow>,
}

// ── PG bootstrap ──────────────────────────────────────────────────────────────

async fn run_pg_migrations(pool: &sqlx::PgPool) {
    // ── Extensions ──────────────────────────────────────────────────────────
    sqlx::query("CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE")
        .execute(pool).await
        .unwrap_or_else(|e| { eprintln!("[pg] timescaledb extension: {e}"); Default::default() });

    // ── Transactional tables ────────────────────────────────────────────────

    sqlx::query("
        CREATE TABLE IF NOT EXISTS users (
            id                     TEXT PRIMARY KEY,
            email                  TEXT UNIQUE NOT NULL,
            password_hash          TEXT NOT NULL,
            full_name              TEXT NOT NULL,
            role                   TEXT NOT NULL DEFAULT 'Owner',
            is_pro                 INTEGER NOT NULL DEFAULT 0,
            created_at             BIGINT NOT NULL,
            clerk_id               TEXT,
            subscription_tier      TEXT NOT NULL DEFAULT 'community',
            stripe_customer_id     TEXT,
            stripe_subscription_id TEXT,
            paddle_customer_id     TEXT,
            paddle_subscription_id TEXT
        )
    ").execute(pool).await.expect("users migration failed");

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_users_clerk_id ON users(clerk_id)")
        .execute(pool).await.ok();

    // Paddle columns migration (for existing databases that only have stripe columns)
    sqlx::query("ALTER TABLE users ADD COLUMN IF NOT EXISTS paddle_customer_id TEXT")
        .execute(pool).await.ok();
    sqlx::query("ALTER TABLE users ADD COLUMN IF NOT EXISTS paddle_subscription_id TEXT")
        .execute(pool).await.ok();

    sqlx::query("
        CREATE TABLE IF NOT EXISTS sessions (
            token      TEXT PRIMARY KEY,
            user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at BIGINT NOT NULL
        )
    ").execute(pool).await.expect("sessions migration failed");

    sqlx::query("
        CREATE TABLE IF NOT EXISTS nodes (
            wk_id               TEXT PRIMARY KEY,
            fleet_url            TEXT NOT NULL,
            session_token        TEXT NOT NULL,
            code                 TEXT,
            paired_at            BIGINT NOT NULL,
            last_seen            BIGINT NOT NULL,
            hostname             TEXT,
            user_id              TEXT,
            last_telemetry_json  JSONB,
            display_name         TEXT,
            tags                 TEXT
        )
    ").execute(pool).await.expect("nodes migration failed");

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_nodes_user_id ON nodes(user_id)")
        .execute(pool).await.ok();
    // Migration for existing databases
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS display_name TEXT")
        .execute(pool).await.ok();
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS tags TEXT")
        .execute(pool).await.ok();

    sqlx::query("
        CREATE TABLE IF NOT EXISTS stream_tokens (
            token      TEXT PRIMARY KEY,
            user_id    TEXT NOT NULL,
            expires_ms BIGINT NOT NULL
        )
    ").execute(pool).await.expect("stream_tokens migration failed");

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_stream_tokens_expires ON stream_tokens(expires_ms)")
        .execute(pool).await.ok();

    sqlx::query("
        CREATE TABLE IF NOT EXISTS api_keys (
            key_id       TEXT PRIMARY KEY,
            key_hash     TEXT UNIQUE NOT NULL,
            user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            created_at   BIGINT NOT NULL,
            last_used_ms BIGINT
        )
    ").execute(pool).await.expect("api_keys migration failed");

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id)")
        .execute(pool).await.ok();

    sqlx::query("
        CREATE TABLE IF NOT EXISTS notification_channels (
            id           TEXT PRIMARY KEY,
            user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            channel_type TEXT NOT NULL CHECK (channel_type IN ('slack', 'email')),
            name         TEXT NOT NULL,
            config_json  JSONB NOT NULL,
            verified     INTEGER NOT NULL DEFAULT 0,
            created_at   BIGINT NOT NULL
        )
    ").execute(pool).await.expect("notification_channels migration failed");

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_notif_channels_user ON notification_channels(user_id)")
        .execute(pool).await.ok();

    sqlx::query("
        CREATE TABLE IF NOT EXISTS alert_rules (
            id              TEXT PRIMARY KEY,
            user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            node_id         TEXT,
            event_type      TEXT NOT NULL,
            threshold_value REAL,
            urgency         TEXT NOT NULL DEFAULT 'immediate',
            channel_id      TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
            enabled         INTEGER NOT NULL DEFAULT 1,
            created_at      BIGINT NOT NULL
        )
    ").execute(pool).await.expect("alert_rules migration failed");

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_alert_rules_user ON alert_rules(user_id)")
        .execute(pool).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_alert_rules_channel ON alert_rules(channel_id)")
        .execute(pool).await.ok();

    sqlx::query("
        CREATE TABLE IF NOT EXISTS alert_events (
            id                   TEXT PRIMARY KEY,
            rule_id              TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
            node_id              TEXT NOT NULL,
            triggered_at         BIGINT NOT NULL,
            resolved_at          BIGINT,
            quiet_until_ms       BIGINT,
            metrics_snapshot_json TEXT
        )
    ").execute(pool).await.expect("alert_events migration failed");

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_alert_events_rule_node ON alert_events(rule_id, node_id)")
        .execute(pool).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_alert_events_open ON alert_events(resolved_at) WHERE resolved_at IS NULL")
        .execute(pool).await.ok();

    // ── Time-series tables ──────────────────────────────────────────────────

    sqlx::query("
        CREATE TABLE IF NOT EXISTS metrics_raw (
            ts               TIMESTAMPTZ NOT NULL,
            node_id          TEXT        NOT NULL,
            tenant_id        TEXT        NOT NULL,
            tok_s            REAL,
            watts            REAL,
            wes_raw          REAL,
            wes_penalized    REAL,
            thermal_cost_pct REAL,
            thermal_penalty  REAL,
            thermal_state    TEXT,
            vram_used_mb     INTEGER,
            vram_total_mb    INTEGER,
            mem_pressure_pct REAL,
            gpu_pct          REAL,
            cpu_pct          REAL,
            inference_state  TEXT,
            wes_version      SMALLINT    NOT NULL DEFAULT 1,
            agent_version    TEXT,
            swap_write       REAL,
            UNIQUE (tenant_id, node_id, ts)
        )
    ").execute(pool).await.expect("metrics_raw migration failed");

    // Additive column migration (idempotent — silently ignored if column exists)
    sqlx::query("ALTER TABLE metrics_raw ADD COLUMN IF NOT EXISTS swap_write REAL")
        .execute(pool).await.ok();
    sqlx::query("ALTER TABLE metrics_raw ADD COLUMN IF NOT EXISTS ttft_ms REAL")
        .execute(pool).await.ok();
    sqlx::query("ALTER TABLE metrics_raw ADD COLUMN IF NOT EXISTS avg_latency_ms REAL")
        .execute(pool).await.ok();
    sqlx::query("ALTER TABLE metrics_raw ADD COLUMN IF NOT EXISTS queue_depth INTEGER")
        .execute(pool).await.ok();

    // Convert to hypertable (idempotent check via exception handling)
    sqlx::query(
        "SELECT create_hypertable('metrics_raw', 'ts', if_not_exists => true)"
    ).execute(pool).await.ok();

    sqlx::query("
        CREATE TABLE IF NOT EXISTS metrics_5min (
            ts                   TIMESTAMPTZ NOT NULL,
            node_id              TEXT        NOT NULL,
            tenant_id            TEXT        NOT NULL,
            tok_s_avg            REAL,
            tok_s_p50            REAL,
            tok_s_p95            REAL,
            watts_avg            REAL,
            wes_raw_avg          REAL,
            wes_penalized_avg    REAL,
            wes_penalized_min    REAL,
            thermal_cost_pct_avg REAL,
            thermal_cost_pct_max REAL,
            thermal_state_worst  TEXT,
            mem_pressure_pct_avg REAL,
            mem_pressure_pct_max REAL,
            gpu_pct_avg          REAL,
            inference_duty_pct   REAL,
            swap_write_avg       REAL,
            sample_count         SMALLINT    NOT NULL DEFAULT 0,
            wes_version          SMALLINT    NOT NULL DEFAULT 1,
            wes_version_count    SMALLINT    NOT NULL DEFAULT 1,
            agent_version        TEXT,
            UNIQUE (tenant_id, node_id, ts)
        )
    ").execute(pool).await.expect("metrics_5min migration failed");

    sqlx::query("ALTER TABLE metrics_5min ADD COLUMN IF NOT EXISTS swap_write_avg REAL")
        .execute(pool).await.ok();

    sqlx::query(
        "SELECT create_hypertable('metrics_5min', 'ts', if_not_exists => true)"
    ).execute(pool).await.ok();

    sqlx::query("
        CREATE TABLE IF NOT EXISTS node_events (
            ts          TIMESTAMPTZ NOT NULL,
            node_id     TEXT        NOT NULL,
            tenant_id   TEXT        NOT NULL,
            level       TEXT        NOT NULL DEFAULT 'info',
            event_type  TEXT,
            message     TEXT        NOT NULL,
            UNIQUE (tenant_id, node_id, ts, message)
        )
    ").execute(pool).await.expect("node_events migration failed");

    sqlx::query(
        "SELECT create_hypertable('node_events', 'ts', if_not_exists => true)"
    ).execute(pool).await.ok();

    sqlx::query("
        CREATE TABLE IF NOT EXISTS fleet_observations (
            id              TEXT        NOT NULL,
            tenant_id       TEXT        NOT NULL,
            node_id         TEXT        NOT NULL,
            alert_type      TEXT        NOT NULL,
            severity        TEXT        NOT NULL DEFAULT 'warning',
            state           TEXT        NOT NULL DEFAULT 'open',
            title           TEXT        NOT NULL,
            detail          TEXT        NOT NULL,
            context_json    JSONB,
            fired_at_ms     BIGINT      NOT NULL,
            resolved_at_ms  BIGINT,
            ack_at_ms       BIGINT,
            PRIMARY KEY (id)
        )
    ").execute(pool).await.expect("fleet_observations migration failed");

    // Additive column migration — acknowledged_by tracks who acknowledged (Clerk user_id).
    sqlx::query("ALTER TABLE fleet_observations ADD COLUMN IF NOT EXISTS acknowledged_by TEXT")
        .execute(pool).await.ok();

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_observations_tenant_state ON fleet_observations(tenant_id, state, fired_at_ms)")
        .execute(pool).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_observations_node ON fleet_observations(tenant_id, node_id, fired_at_ms)")
        .execute(pool).await.ok();

    sqlx::query("
        CREATE TABLE IF NOT EXISTS schema_breakpoints (
            node_id         TEXT NOT NULL,
            ts_ms           BIGINT NOT NULL,
            tenant_id       TEXT NOT NULL,
            breakpoint_type TEXT NOT NULL,
            detail          TEXT
        )
    ").execute(pool).await.expect("schema_breakpoints migration failed");

    // ── TimescaleDB policies ────────────────────────────────────────────────
    // Retention: metrics_raw 2 days, node_events 30 days
    // These are idempotent — TimescaleDB ignores if already set.
    sqlx::query("SELECT add_retention_policy('metrics_raw', INTERVAL '2 days', if_not_exists => true)")
        .execute(pool).await.ok();
    sqlx::query("SELECT add_retention_policy('node_events', INTERVAL '30 days', if_not_exists => true)")
        .execute(pool).await.ok();
    sqlx::query("SELECT add_retention_policy('metrics_5min', INTERVAL '90 days', if_not_exists => true)")
        .execute(pool).await.ok();

    // Compression policies
    sqlx::query("ALTER TABLE metrics_raw SET (timescaledb.compress, timescaledb.compress_segmentby = 'node_id,tenant_id')")
        .execute(pool).await.ok();
    sqlx::query("SELECT add_compression_policy('metrics_raw', INTERVAL '1 day', if_not_exists => true)")
        .execute(pool).await.ok();
    sqlx::query("ALTER TABLE metrics_5min SET (timescaledb.compress, timescaledb.compress_segmentby = 'node_id,tenant_id')")
        .execute(pool).await.ok();
    sqlx::query("SELECT add_compression_policy('metrics_5min', INTERVAL '7 days', if_not_exists => true)")
        .execute(pool).await.ok();

    // ── Backfill: if only one user exists, assign all orphaned nodes to them. ──
    sqlx::query("
        UPDATE nodes
        SET user_id = (SELECT id FROM users LIMIT 1)
        WHERE user_id IS NULL
          AND (SELECT COUNT(*) FROM users) = 1
    ").execute(pool).await.ok();

    println!("  PG migrations complete");
}

// ── Tier constants ────────────────────────────────────────────────────────────

/// Maximum nodes a free-tier account may pair.
const MAX_FREE_NODES: usize = 3;

/// Agent API v1 rate limits (requests per 60-second sliding window).
const API_RATE_COMMUNITY: usize = 60;
const API_RATE_TEAM:      usize = 600;

/// Flap-suppression quiet period after an alert resolves (milliseconds).
const ALERT_QUIET_PERIOD_MS: u64 = 300_000; // 5 minutes

/// Returns true if the account has Team or Enterprise tier (alerting unlocked).
fn is_team_or_above(tier: &str) -> bool {
    matches!(tier, "team" | "enterprise")
}

fn is_pro_or_above(tier: &str) -> bool {
    matches!(tier, "pro" | "team" | "enterprise")
}

/// Pattern-to-tier allowlist. Community users see 7 patterns; Pro+ see all 18.
fn allowed_patterns_for_tier(tier: &str) -> Vec<String> {
    let community: Vec<&str> = vec!["A", "B", "D", "H", "J", "K", "L"];
    if is_pro_or_above(tier) {
        // All 18 patterns A–R
        (b'A'..=b'R').map(|c| String::from(c as char)).collect()
    } else {
        community.into_iter().map(String::from).collect()
    }
}

/// Number of nodes available for free on the Community tier.
const FREE_NODE_LIMIT: usize = 3;

/// Nodes not seen within this window are considered offline.
const ONLINE_THRESHOLD_MS: u64 = 30_000;

/// If DEV_ACCOUNT_EMAIL env var is set, that account gets isPro=true and no
/// node limit — useful for internal testing without hitting the free wall.
fn is_dev_account(email: &str) -> bool {
    std::env::var("DEV_ACCOUNT_EMAIL")
        .map(|e| e.trim().to_lowercase() == email.trim().to_lowercase())
        .unwrap_or(false)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn mint_node_token(node_id: &str) -> String {
    format!("wk_{:x}_{node_id}", now_ms())
}

fn extract_bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_owned())
}

// ── Clerk JWT helpers ─────────────────────────────────────────────────────────

/// Fetch JWKS from Clerk. Synchronous — call from spawn_blocking.
fn fetch_jwks(url: &str) -> Vec<JwkKey> {
    match ureq::get(url).call() {
        Ok(resp) => resp.into_json::<JwksResponse>()
            .map(|j| j.keys)
            .unwrap_or_default(),
        Err(e) => {
            eprintln!("[jwks] fetch failed: {e}");
            vec![]
        }
    }
}

/// Verify a Clerk JWT and return the `sub` claim (Clerk user ID).
fn validate_clerk_jwt(token: &str, keys: &[JwkKey]) -> Option<String> {
    #[derive(Deserialize)]
    struct ClerkClaims { sub: String }

    if keys.is_empty() {
        eprintln!("[auth] clerk_keys is empty — CLERK_JWKS_URL not set or fetch failed");
        return None;
    }

    let header = match jsonwebtoken::decode_header(token) {
        Ok(h) => h,
        Err(e) => { eprintln!("[auth] JWT decode_header failed: {e}"); return None; }
    };

    let candidates: Vec<&JwkKey> = match &header.kid {
        Some(kid) => {
            let m: Vec<&JwkKey> = keys.iter().filter(|k| &k.kid == kid).collect();
            if m.is_empty() {
                eprintln!("[auth] JWT kid={kid} not found in JWKS ({} keys cached)", keys.len());
                keys.iter().collect()
            } else { m }
        }
        None => {
            eprintln!("[auth] JWT has no kid — trying all {} cached keys", keys.len());
            keys.iter().collect()
        }
    };

    let mut val = Validation::new(Algorithm::RS256);
    val.validate_aud = false;
    val.leeway = 60;

    for jwk in &candidates {
        match DecodingKey::from_rsa_components(&jwk.n, &jwk.e) {
            Err(e) => { eprintln!("[auth] DecodingKey build failed for kid={}: {e}", jwk.kid); }
            Ok(key) => match decode::<ClerkClaims>(token, &key, &val) {
                Ok(data) => {
                    eprintln!("[auth] JWT valid");
                    return Some(data.claims.sub);
                }
                Err(e) => { eprintln!("[auth] JWT decode failed for kid={}: {e}", jwk.kid); }
            }
        }
    }
    eprintln!("[auth] JWT validation exhausted all candidates");
    None
}

/// Map a Clerk `sub` to an internal user ID, creating or linking the record as needed.
async fn resolve_clerk_user(clerk_sub: &str, pool: &sqlx::PgPool) -> Option<String> {
    // Already linked?
    if let Ok(row) = sqlx::query_scalar::<_, String>(
        "SELECT id FROM users WHERE clerk_id = $1"
    ).bind(clerk_sub).fetch_one(pool).await {
        return Some(row);
    }

    // Exactly one unmapped user — link them (handles DIY→Clerk migration).
    let unmapped: i64 = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM users WHERE clerk_id IS NULL"
    ).fetch_one(pool).await.unwrap_or(0);

    if unmapped == 1 {
        if let Ok(id) = sqlx::query_scalar::<_, String>(
            "SELECT id FROM users WHERE clerk_id IS NULL LIMIT 1"
        ).fetch_one(pool).await {
            let _ = sqlx::query("UPDATE users SET clerk_id = $1 WHERE id = $2")
                .bind(clerk_sub).bind(&id)
                .execute(pool).await;
            return Some(id);
        }
    }

    // New Clerk user — create a minimal record.
    let new_id = Uuid::new_v4().to_string();
    let ts     = now_ms() as i64;
    let r = sqlx::query(
        "INSERT INTO users (id, email, password_hash, full_name, role, is_pro, created_at, clerk_id)
         VALUES ($1, $2, '', 'Clerk User', 'Owner', 0, $3, $2)"
    ).bind(&new_id).bind(clerk_sub).bind(ts)
    .execute(pool).await;
    if r.is_ok() { Some(new_id) } else { None }
}

// ── Auth helpers (async) ──────────────────────────────────────────────────────

/// Validate a Bearer token and return the internal user_id.
/// Tries the legacy sessions table first, then Clerk JWT.
async fn require_user(token: &str, pool: &sqlx::PgPool, clerk_keys: &[JwkKey]) -> Option<String> {
    // Legacy DIY sessions.
    if let Ok(id) = sqlx::query_scalar::<_, String>(
        "SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1"
    ).bind(token).fetch_one(pool).await {
        return Some(id);
    }

    // Clerk JWT.
    let sub = validate_clerk_jwt(token, clerk_keys)?;
    resolve_clerk_user(&sub, pool).await
}

/// Like require_user but also returns email and is_pro for tier checks.
async fn require_user_info(
    token: &str,
    pool: &sqlx::PgPool,
    clerk_keys: &[JwkKey],
) -> Option<(String, String, i32)> {
    let user_id = require_user(token, pool, clerk_keys).await?;
    let row = sqlx::query_as::<_, (String, i32)>(
        "SELECT email, is_pro FROM users WHERE id = $1"
    ).bind(&user_id).fetch_one(pool).await.ok()?;
    Some((user_id, row.0, row.1))
}

/// Load the set of node IDs belonging to a user.
async fn user_node_set(user_id: &str, pool: &sqlx::PgPool) -> HashSet<String> {
    sqlx::query_scalar::<_, String>("SELECT wk_id FROM nodes WHERE user_id = $1")
        .bind(user_id)
        .fetch_all(pool).await
        .unwrap_or_default()
        .into_iter()
        .collect()
}

/// Blocking version for use inside SSE stream map closure (block_in_place).
fn user_node_set_blocking(user_id: &str, pool: &sqlx::PgPool) -> HashSet<String> {
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(user_node_set(user_id, pool))
    })
}

// ── Agent API v1 helpers ──────────────────────────────────────────────────────

fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    format!("{:x}", h.finalize())
}

fn thermal_penalty_for(state: Option<&str>) -> f32 {
    match state.unwrap_or("Normal") {
        "Fair"     => 1.25,
        "Serious"  => 1.75,
        "Critical" => 2.0,
        _          => 1.0,
    }
}

fn wes_for_payload(m: &MetricsPayload) -> Option<f32> {
    let tok_s = if m.vllm_running {
        m.vllm_tokens_per_sec?
    } else {
        m.ollama_tokens_per_second?
    };
    if tok_s <= 0.0 { return None; }
    let watts = m.nvidia_power_draw_w.or(m.cpu_power_w)?;
    if watts <= 0.0 { return None; }
    let penalty = thermal_penalty_for(m.thermal_state.as_deref());
    let raw = tok_s / (watts * penalty);
    Some((raw * 10.0).round() / 10.0)  // round to 1 decimal place
}

/// Validate a raw API key, enforce rate limits, return (key_id, user_id, is_pro).
async fn validate_api_key(
    raw_key: &str,
    pool: &sqlx::PgPool,
    rate_limits: &Arc<Mutex<HashMap<String, Vec<u64>>>>,
) -> Option<(String, String, bool)> {
    let hash = sha256_hex(raw_key);
    let row = sqlx::query_as::<_, (String, String, i32)>(
        "SELECT k.key_id, k.user_id, u.is_pro
         FROM api_keys k
         JOIN users u ON u.id = k.user_id
         WHERE k.key_hash = $1"
    ).bind(&hash).fetch_one(pool).await.ok()?;

    let (key_id, user_id, is_pro_int) = row;
    let limit = if is_pro_int != 0 { API_RATE_TEAM } else { API_RATE_COMMUNITY };
    let now = now_ms();
    let window_start = now.saturating_sub(60_000);
    {
        let mut rl = rate_limits.lock().unwrap();
        let calls = rl.entry(key_id.clone()).or_default();
        calls.retain(|&t| t >= window_start);
        if calls.len() >= limit {
            return None;
        }
        calls.push(now);
    }

    let _ = sqlx::query("UPDATE api_keys SET last_used_ms = $1 WHERE key_id = $2")
        .bind(now as i64).bind(&key_id)
        .execute(pool).await;

    Some((key_id, user_id, is_pro_int != 0))
}

const AUTH_RATE_LIMIT: usize = 10; // max attempts per 60s per IP

/// IP-based sliding-window rate limiter for auth endpoints.
/// Returns true if the request is allowed, false if rate-limited.
fn check_auth_rate_limit(
    ip: &str,
    rate_limits: &Arc<Mutex<HashMap<String, Vec<u64>>>>,
) -> bool {
    let now = now_ms();
    let window_start = now.saturating_sub(60_000);
    let mut rl = rate_limits.lock().unwrap();
    let calls = rl.entry(ip.to_string()).or_default();
    calls.retain(|&t| t >= window_start);
    if calls.len() >= AUTH_RATE_LIMIT {
        return false;
    }
    calls.push(now);
    true
}

/// Extract client IP from X-Forwarded-For (Railway/nginx) or fall back to peer addr.
fn client_ip(headers: &HeaderMap) -> String {
    headers.get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn extract_api_key(headers: &HeaderMap) -> Option<String> {
    headers.get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_owned())
        .or_else(|| extract_bearer(headers))
}

// ── Agent API v1 types ────────────────────────────────────────────────────────

#[derive(Serialize)]
struct V1NodeInfo {
    node_id:      String,
    hostname:     Option<String>,
    online:       bool,
    last_seen_ms: u64,
    metrics:      Option<MetricsPayload>,
    wes:          Option<f32>,
}

#[derive(Serialize)]
struct V1FleetResponse {
    nodes: Vec<V1NodeInfo>,
}

#[derive(Serialize)]
struct V1WesNode {
    node_id: String,
    wes:     Option<f32>,
    online:  bool,
}

#[derive(Serialize)]
struct V1RouteCandidate {
    node:   String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tok_s:  Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wes:    Option<f32>,
    reason: String,
}

#[derive(Serialize)]
struct V1RouteResponse {
    latency:    Option<V1RouteCandidate>,
    efficiency: Option<V1RouteCandidate>,
    default:    &'static str,
}

#[derive(Serialize)]
struct V1KeyInfo {
    key_id:       String,
    name:         String,
    created_at:   i64,
    last_used_ms: Option<i64>,
}

#[derive(Deserialize)]
struct V1CreateKeyRequest {
    name: String,
}

#[derive(Serialize)]
struct V1CreateKeyResponse {
    key_id:     String,
    key:        String,
    name:       String,
    created_at: i64,
}

// ── Agent API v1 handlers — key management ────────────────────────────────────

/// POST /api/v1/keys
async fn handle_v1_create_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<V1CreateKeyRequest>,
) -> impl IntoResponse {
    if body.name.trim().is_empty() {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "name is required" }))).into_response();
    }
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let name     = body.name.trim().to_owned();
    let raw_key  = format!("wk_live_{}", Uuid::new_v4().to_string().replace('-', ""));
    let key_hash = sha256_hex(&raw_key);
    let key_id   = Uuid::new_v4().to_string();
    let ts       = now_ms() as i64;

    let result = sqlx::query(
        "INSERT INTO api_keys (key_id, key_hash, user_id, name, created_at)
         VALUES ($1, $2, $3, $4, $5)"
    ).bind(&key_id).bind(&key_hash).bind(&user_id).bind(&name).bind(ts)
    .execute(&state.pool).await;

    match result {
        Ok(_) => (StatusCode::CREATED, Json(V1CreateKeyResponse {
            key_id, key: raw_key, name, created_at: ts,
        })).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal error" }))).into_response(),
    }
}

/// GET /api/v1/keys
async fn handle_v1_list_keys(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let keys: Vec<(String, String, i64, Option<i64>)> = sqlx::query_as(
        "SELECT key_id, name, created_at, last_used_ms
         FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC"
    ).bind(&user_id).fetch_all(&state.pool).await.unwrap_or_default();

    let key_list: Vec<V1KeyInfo> = keys.into_iter().map(|(key_id, name, created_at, last_used_ms)| {
        V1KeyInfo { key_id, name, created_at, last_used_ms }
    }).collect();

    Json(serde_json::json!({ "keys": key_list })).into_response()
}

/// DELETE /api/nodes/:node_id
async fn handle_delete_node(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(node_id): Path<String>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let result = sqlx::query(
        "DELETE FROM nodes WHERE wk_id = $1 AND user_id = $2"
    ).bind(&node_id).bind(&user_id).execute(&state.pool).await;

    match result {
        Ok(r) if r.rows_affected() == 0 => {
            return (StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "Node not found" }))).into_response();
        }
        Ok(_) => {
            // Purge stored metrics.
            let _ = sqlx::query("DELETE FROM metrics_raw WHERE node_id = $1 AND tenant_id = $2")
                .bind(&node_id).bind(&user_id).execute(&state.pool).await;
            let _ = sqlx::query("DELETE FROM metrics_5min WHERE node_id = $1 AND tenant_id = $2")
                .bind(&node_id).bind(&user_id).execute(&state.pool).await;

            // Evict from in-memory cache.
            state.metrics.write().unwrap().remove(&node_id);
            StatusCode::NO_CONTENT.into_response()
        }
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal error" }))).into_response(),
    }
}

/// DELETE /api/v1/keys/:key_id
async fn handle_v1_delete_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(key_id): Path<String>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let result = sqlx::query(
        "DELETE FROM api_keys WHERE key_id = $1 AND user_id = $2"
    ).bind(&key_id).bind(&user_id).execute(&state.pool).await;

    match result {
        Ok(r) if r.rows_affected() == 0 => (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Key not found" }))).into_response(),
        Ok(_)  => StatusCode::NO_CONTENT.into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal error" }))).into_response(),
    }
}

// ── Agent API v1 handlers — fleet data ────────────────────────────────────────

/// GET /api/v1/fleet
async fn handle_v1_fleet(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let raw_key = match extract_api_key(&headers) {
        Some(k) => k,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing API key" }))).into_response(),
    };

    let (_key_id, user_id, _is_pro) = match validate_api_key(&raw_key, &state.pool, &state.api_rate_limits).await {
        Some(r) => r,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid API key or rate limit exceeded" }))).into_response(),
    };

    let persisted: Vec<(String, i64)> = sqlx::query_as(
        "SELECT wk_id, last_seen FROM nodes WHERE user_id = $1 ORDER BY last_seen DESC"
    ).bind(&user_id).fetch_all(&state.pool).await.unwrap_or_default();

    let metrics_map = state.metrics.read().unwrap();
    let now = now_ms();
    let nodes: Vec<V1NodeInfo> = persisted.into_iter().map(|(node_id, last_seen_db)| {
        let (last_seen_ms, metrics) = metrics_map.get(&node_id)
            .map(|e| (e.last_seen_ms, e.metrics.clone()))
            .unwrap_or((last_seen_db as u64, None));
        let online   = now.saturating_sub(last_seen_ms) < ONLINE_THRESHOLD_MS;
        let wes      = metrics.as_ref().and_then(wes_for_payload);
        let hostname = metrics.as_ref().and_then(|m| m.hostname.clone());
        V1NodeInfo { node_id, hostname, online, last_seen_ms, metrics, wes }
    }).collect();

    Json(V1FleetResponse { nodes }).into_response()
}

/// GET /api/v1/fleet/wes
async fn handle_v1_fleet_wes(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let raw_key = match extract_api_key(&headers) {
        Some(k) => k,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing API key" }))).into_response(),
    };

    let (_key_id, user_id, _is_pro) = match validate_api_key(&raw_key, &state.pool, &state.api_rate_limits).await {
        Some(r) => r,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid API key or rate limit exceeded" }))).into_response(),
    };

    let node_ids: Vec<String> = sqlx::query_scalar(
        "SELECT wk_id FROM nodes WHERE user_id = $1"
    ).bind(&user_id).fetch_all(&state.pool).await.unwrap_or_default();

    let metrics_map = state.metrics.read().unwrap();
    let now = now_ms();
    let nodes: Vec<V1WesNode> = node_ids.into_iter().map(|node_id| {
        let entry        = metrics_map.get(&node_id);
        let last_seen_ms = entry.map(|e| e.last_seen_ms).unwrap_or(0);
        let online       = now.saturating_sub(last_seen_ms) < ONLINE_THRESHOLD_MS;
        let wes          = entry.and_then(|e| e.metrics.as_ref()).and_then(wes_for_payload);
        V1WesNode { node_id, wes, online }
    }).collect();

    Json(serde_json::json!({ "nodes": nodes })).into_response()
}

/// GET /api/v1/nodes/:id
async fn handle_v1_node(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(node_id): Path<String>,
) -> impl IntoResponse {
    let raw_key = match extract_api_key(&headers) {
        Some(k) => k,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing API key" }))).into_response(),
    };

    let (_key_id, user_id, _is_pro) = match validate_api_key(&raw_key, &state.pool, &state.api_rate_limits).await {
        Some(r) => r,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid API key or rate limit exceeded" }))).into_response(),
    };

    let owned: bool = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM nodes WHERE wk_id = $1 AND user_id = $2)"
    ).bind(&node_id).bind(&user_id).fetch_one(&state.pool).await.unwrap_or(false);

    if !owned {
        return (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Node not found" }))).into_response();
    }

    let metrics_map = state.metrics.read().unwrap();
    let now = now_ms();

    match metrics_map.get(&node_id) {
        None => (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Node not found" }))).into_response(),
        Some(entry) => {
            let last_seen_ms = entry.last_seen_ms;
            let online   = now.saturating_sub(last_seen_ms) < ONLINE_THRESHOLD_MS;
            let wes      = entry.metrics.as_ref().and_then(wes_for_payload);
            let hostname = entry.metrics.as_ref().and_then(|m| m.hostname.clone());
            Json(V1NodeInfo {
                node_id, hostname, online, last_seen_ms,
                metrics: entry.metrics.clone(), wes,
            }).into_response()
        }
    }
}

/// GET /api/v1/route/best
async fn handle_v1_route_best(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let raw_key = match extract_api_key(&headers) {
        Some(k) => k,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing API key" }))).into_response(),
    };

    let (_key_id, user_id, _is_pro) = match validate_api_key(&raw_key, &state.pool, &state.api_rate_limits).await {
        Some(r) => r,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid API key or rate limit exceeded" }))).into_response(),
    };

    let node_ids: Vec<String> = sqlx::query_scalar(
        "SELECT wk_id FROM nodes WHERE user_id = $1"
    ).bind(&user_id).fetch_all(&state.pool).await.unwrap_or_default();

    let metrics_map = state.metrics.read().unwrap();
    let now = now_ms();

    struct NodeScore {
        node_id: String,
        tok_s:   Option<f32>,
        wes:     Option<f32>,
    }

    let candidates: Vec<NodeScore> = node_ids.into_iter().filter_map(|node_id| {
        let entry = metrics_map.get(&node_id)?;
        if now.saturating_sub(entry.last_seen_ms) >= ONLINE_THRESHOLD_MS { return None; }
        let m     = entry.metrics.as_ref()?;
        let tok_s = if m.vllm_running { m.vllm_tokens_per_sec } else { m.ollama_tokens_per_second };
        let wes   = wes_for_payload(m);
        Some(NodeScore { node_id, tok_s, wes })
    }).collect();

    let best_latency = candidates.iter()
        .filter_map(|c| c.tok_s.map(|t| (c, t)))
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(c, t)| V1RouteCandidate {
            node: c.node_id.clone(), tok_s: Some(t), wes: c.wes,
            reason: "Highest throughput".into(),
        });

    let best_efficiency = candidates.iter()
        .filter_map(|c| c.wes.map(|w| (c, w)))
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(c, w)| V1RouteCandidate {
            node: c.node_id.clone(), tok_s: c.tok_s, wes: Some(w),
            reason: "Highest WES".into(),
        });

    Json(V1RouteResponse {
        latency: best_latency, efficiency: best_efficiency, default: "efficiency",
    }).into_response()
}

// ── GET /api/v1/insights/latest ───────────────────────────────────────────────

#[derive(Serialize)]
struct V1InsightsFleet {
    online_count: usize,
    total_count:  usize,
    avg_wes:      Option<f32>,
    fleet_tok_s:  Option<f32>,
}

#[derive(Serialize)]
struct V1InsightFinding {
    node_id:  String,
    hostname: Option<String>,
    severity: &'static str,
    pattern:  &'static str,
    title:    String,
    detail:   String,
    value:    Option<f32>,
    unit:     Option<&'static str>,
}

#[derive(Serialize)]
struct V1InsightsResponse {
    generated_at_ms: u64,
    fleet:           V1InsightsFleet,
    findings:        Vec<V1InsightFinding>,
}

/// GET /api/v1/insights/latest
async fn handle_v1_insights_latest(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let raw_key = match extract_api_key(&headers) {
        Some(k) => k,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing API key" }))).into_response(),
    };

    let (_key_id, user_id, _is_pro) = match validate_api_key(&raw_key, &state.pool, &state.api_rate_limits).await {
        Some(r) => r,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid API key or rate limit exceeded" }))).into_response(),
    };

    // Insights API is Team+ only
    let tier: String = sqlx::query_scalar::<_, String>(
        "SELECT subscription_tier FROM users WHERE id = $1"
    ).bind(&user_id).fetch_one(&state.pool).await.unwrap_or_else(|_| "community".to_string());
    if !is_team_or_above(&tier) {
        return (StatusCode::PAYMENT_REQUIRED,
            Json(serde_json::json!({ "error": "Insights API requires Team tier or above", "upgrade": true }))).into_response();
    }

    let node_ids: Vec<String> = sqlx::query_scalar(
        "SELECT wk_id FROM nodes WHERE user_id = $1"
    ).bind(&user_id).fetch_all(&state.pool).await.unwrap_or_default();

    let metrics_map = state.metrics.read().unwrap();
    let now = now_ms();
    let total_count = node_ids.len();

    struct NodeSnap {
        node_id:  String,
        hostname: Option<String>,
        online:   bool,
        metrics:  Option<MetricsPayload>,
        wes:      Option<f32>,
        tok_s:    Option<f32>,
    }

    let snaps: Vec<NodeSnap> = node_ids.into_iter().map(|node_id| {
        let entry    = metrics_map.get(&node_id);
        let online   = entry.map(|e| now.saturating_sub(e.last_seen_ms) < ONLINE_THRESHOLD_MS).unwrap_or(false);
        let metrics  = entry.and_then(|e| e.metrics.clone());
        let wes      = metrics.as_ref().and_then(wes_for_payload);
        let tok_s    = metrics.as_ref().and_then(|m| {
            if m.vllm_running { m.vllm_tokens_per_sec } else { m.ollama_tokens_per_second }
        });
        let hostname = metrics.as_ref().and_then(|m| m.hostname.clone());
        NodeSnap { node_id, hostname, online, metrics, wes, tok_s }
    }).collect();

    let online_count = snaps.iter().filter(|s| s.online).count();
    let wes_vals: Vec<f32> = snaps.iter().filter_map(|s| if s.online { s.wes } else { None }).collect();
    let avg_wes = if wes_vals.is_empty() { None } else {
        Some((wes_vals.iter().sum::<f32>() / wes_vals.len() as f32 * 10.0).round() / 10.0)
    };
    let tok_vals: Vec<f32> = snaps.iter().filter_map(|s| if s.online { s.tok_s } else { None }).collect();
    let fleet_tok_s = if tok_vals.is_empty() { None } else {
        Some((tok_vals.iter().sum::<f32>() * 10.0).round() / 10.0)
    };

    let mut findings: Vec<V1InsightFinding> = Vec::new();

    if total_count > 0 && online_count == 0 {
        findings.push(V1InsightFinding {
            node_id: "fleet".into(), hostname: None, severity: "high",
            pattern: "fleet_offline",
            title: "Fleet offline".into(),
            detail: format!("All {total_count} registered nodes are unreachable (last telemetry > 30s ago)."),
            value: None, unit: None,
        });
    }

    for snap in &snaps {
        if !snap.online && total_count > 1 {
            findings.push(V1InsightFinding {
                node_id: snap.node_id.clone(), hostname: snap.hostname.clone(),
                severity: "moderate", pattern: "node_offline",
                title: format!("{} offline", snap.hostname.as_deref().unwrap_or(&snap.node_id)),
                detail: "Node has not reported telemetry in the last 30 seconds.".into(),
                value: None, unit: None,
            });
            continue;
        }

        let Some(ref m) = snap.metrics else { continue };

        match m.thermal_state.as_deref() {
            Some("Critical") => findings.push(V1InsightFinding {
                node_id: snap.node_id.clone(), hostname: snap.hostname.clone(),
                severity: "high", pattern: "thermal_stress",
                title: format!("Critical thermal state on {}", snap.hostname.as_deref().unwrap_or(&snap.node_id)),
                detail: "Thermal state: Critical — WES penalised 2×. Throughput may be severely throttled.".into(),
                value: snap.wes, unit: Some("WES"),
            }),
            Some("Serious") => findings.push(V1InsightFinding {
                node_id: snap.node_id.clone(), hostname: snap.hostname.clone(),
                severity: "moderate", pattern: "thermal_stress",
                title: format!("Thermal stress on {}", snap.hostname.as_deref().unwrap_or(&snap.node_id)),
                detail: "Thermal state: Serious — WES penalised 1.75×. Consider redistributing load.".into(),
                value: snap.wes, unit: Some("WES"),
            }),
            _ => {}
        }

        if let Some(mem_pct) = m.memory_pressure_percent {
            if mem_pct >= 90.0 {
                findings.push(V1InsightFinding {
                    node_id: snap.node_id.clone(), hostname: snap.hostname.clone(),
                    severity: "high", pattern: "memory_pressure",
                    title: format!("High memory pressure on {}", snap.hostname.as_deref().unwrap_or(&snap.node_id)),
                    detail: format!("Memory pressure: {mem_pct:.0}% — swap thrashing likely. Throughput may degrade."),
                    value: Some(mem_pct), unit: Some("%"),
                });
            } else if mem_pct >= 75.0 {
                findings.push(V1InsightFinding {
                    node_id: snap.node_id.clone(), hostname: snap.hostname.clone(),
                    severity: "moderate", pattern: "memory_pressure",
                    title: format!("Elevated memory pressure on {}", snap.hostname.as_deref().unwrap_or(&snap.node_id)),
                    detail: format!("Memory pressure: {mem_pct:.0}% — monitor for swap activity."),
                    value: Some(mem_pct), unit: Some("%"),
                });
            }
        }

        if online_count >= 2 {
            if let (Some(node_tok), Some(fleet_avg)) = (snap.tok_s, fleet_tok_s.map(|t| t / online_count as f32)) {
                if fleet_avg > 5.0 && node_tok < fleet_avg * 0.40 {
                    findings.push(V1InsightFinding {
                        node_id: snap.node_id.clone(), hostname: snap.hostname.clone(),
                        severity: "low", pattern: "low_throughput",
                        title: format!("Low throughput on {}", snap.hostname.as_deref().unwrap_or(&snap.node_id)),
                        detail: format!("{:.1} tok/s vs fleet average {:.1} tok/s — node is underperforming.", node_tok, fleet_avg),
                        value: Some(node_tok), unit: Some("tok/s"),
                    });
                }
            }
        }

        if online_count >= 2 {
            if let (Some(node_wes), Some(fleet_avg_wes)) = (snap.wes, avg_wes) {
                if fleet_avg_wes > 1.0 && node_wes < fleet_avg_wes * 0.40 {
                    findings.push(V1InsightFinding {
                        node_id: snap.node_id.clone(), hostname: snap.hostname.clone(),
                        severity: "low", pattern: "wes_below_baseline",
                        title: format!("WES below fleet average on {}", snap.hostname.as_deref().unwrap_or(&snap.node_id)),
                        detail: format!("WES {:.1} vs fleet average {:.1} — check thermal state and power headroom.", node_wes, fleet_avg_wes),
                        value: Some(node_wes), unit: Some("WES"),
                    });
                }
            }
        }
    }

    let sev_ord = |s: &str| match s { "high" => 0u8, "moderate" => 1, _ => 2 };
    findings.sort_by(|a, b| {
        sev_ord(a.severity).cmp(&sev_ord(b.severity))
            .then_with(|| a.node_id.cmp(&b.node_id))
    });

    Json(V1InsightsResponse {
        generated_at_ms: now,
        fleet: V1InsightsFleet { online_count, total_count, avg_wes, fleet_tok_s },
        findings,
    }).into_response()
}

// ── Auth handlers ─────────────────────────────────────────────────────────────

/// GET /api/auth/stream-token
async fn handle_stream_token(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(uid) => uid,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let stream_token = Uuid::new_v4().to_string();
    let expires_ms = (now_ms() + 60_000) as i64;

    let _ = sqlx::query(
        "INSERT INTO stream_tokens (token, user_id, expires_ms) VALUES ($1, $2, $3)"
    ).bind(&stream_token).bind(&user_id).bind(expires_ms)
    .execute(&state.pool).await;

    (StatusCode::OK, Json(serde_json::json!({ "stream_token": stream_token }))).into_response()
}

/// DELETE /api/auth/stream-token — revoke all stream tokens for the current user (called on logout).
async fn handle_revoke_stream_tokens(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return StatusCode::UNAUTHORIZED,
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(uid) => uid,
        None => return StatusCode::UNAUTHORIZED,
    };

    let _ = sqlx::query("DELETE FROM stream_tokens WHERE user_id = $1")
        .bind(&user_id).execute(&state.pool).await;

    StatusCode::NO_CONTENT
}

/// POST /api/auth/signup
async fn handle_signup(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SignupRequest>,
) -> impl IntoResponse {
    let ip = client_ip(&headers);
    if !check_auth_rate_limit(&ip, &state.auth_rate_limits) {
        return (StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({ "error": "Too many requests. Try again in a minute." }))).into_response();
    }
    let email = body.email.trim().to_lowercase();

    if email.is_empty() || !email.contains('@') {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Valid email required" }))).into_response();
    }
    if body.password.len() < 8 {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Password must be at least 8 characters" }))).into_response();
    }
    if body.full_name.trim().is_empty() {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Full name required" }))).into_response();
    }

    let password = body.password.clone();
    let password_hash = match tokio::task::spawn_blocking(move || bcrypt::hash(password, 12))
        .await.unwrap()
    {
        Ok(h) => h,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal error" }))).into_response(),
    };

    // Check for duplicate email.
    let exists: bool = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM users WHERE email = $1)"
    ).bind(&email).fetch_one(&state.pool).await.unwrap_or(false);
    if exists {
        return (StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "An account with this email already exists" }))).into_response();
    }

    let id        = Uuid::new_v4().to_string();
    let token     = Uuid::new_v4().to_string();
    let full_name = body.full_name.trim().to_owned();
    let ts        = now_ms() as i64;

    let r = sqlx::query(
        "INSERT INTO users (id, email, password_hash, full_name, role, is_pro, created_at)
         VALUES ($1, $2, $3, $4, 'Owner', 0, $5)"
    ).bind(&id).bind(&email).bind(&password_hash).bind(&full_name).bind(ts)
    .execute(&state.pool).await;

    if r.is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal error" }))).into_response();
    }

    let _ = sqlx::query(
        "INSERT INTO sessions (token, user_id, created_at) VALUES ($1, $2, $3)"
    ).bind(&token).bind(&id).bind(ts)
    .execute(&state.pool).await;

    let is_pro = is_dev_account(&email);
    (StatusCode::CREATED, Json(AuthResponse {
        token,
        user: UserResponse { id, email, full_name, role: "Owner".into(), is_pro },
    })).into_response()
}

/// POST /api/auth/login
async fn handle_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<LoginRequest>,
) -> impl IntoResponse {
    let ip = client_ip(&headers);
    if !check_auth_rate_limit(&ip, &state.auth_rate_limits) {
        return (StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({ "error": "Too many requests. Try again in a minute." }))).into_response();
    }
    let email = body.email.trim().to_lowercase();

    let row = sqlx::query_as::<_, (String, String, String, String, String, i32)>(
        "SELECT id, email, password_hash, full_name, role, is_pro FROM users WHERE email = $1"
    ).bind(&email).fetch_one(&state.pool).await;

    let (id, stored_email, hash, full_name, role, is_pro_int) = match row {
        Ok(r) => r,
        Err(_) => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid email or password" }))).into_response(),
    };

    let password = body.password.clone();
    let valid = tokio::task::spawn_blocking(move || bcrypt::verify(password, &hash))
        .await.unwrap().unwrap_or(false);

    if !valid {
        return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid email or password" }))).into_response();
    }

    let token = Uuid::new_v4().to_string();
    let ts    = now_ms() as i64;

    let _ = sqlx::query(
        "INSERT INTO sessions (token, user_id, created_at) VALUES ($1, $2, $3)"
    ).bind(&token).bind(&id).bind(ts)
    .execute(&state.pool).await;

    let is_pro = is_pro_int != 0 || is_dev_account(&stored_email);
    (StatusCode::OK, Json(AuthResponse {
        token,
        user: UserResponse { id, email: stored_email, full_name, role, is_pro },
    })).into_response()
}

/// GET /api/auth/me
async fn handle_me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let row = sqlx::query_as::<_, (String, String, String, String, i32)>(
        "SELECT u.id, u.email, u.full_name, u.role, u.is_pro
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = $1"
    ).bind(&token).fetch_one(&state.pool).await;

    match row {
        Err(_) => (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
        Ok((id, email, full_name, role, is_pro_int)) => {
            let is_pro = is_pro_int != 0 || is_dev_account(&email);
            (StatusCode::OK, Json(UserResponse {
                id, email, full_name, role, is_pro,
            })).into_response()
        }
    }
}

// ── Fleet handlers ────────────────────────────────────────────────────────────

/// POST /api/pair/claim
async fn handle_claim(
    State(state): State<AppState>,
    Json(body): Json<ClaimRequest>,
) -> impl IntoResponse {
    if body.code.len() != 6 || !body.code.chars().all(|c| c.is_ascii_digit()) {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "code must be exactly 6 ASCII digits" }))).into_response();
    }
    if body.node_id.is_empty() || body.fleet_url.is_empty() {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "node_id and fleet_url are required" }))).into_response();
    }

    let token   = mint_node_token(&body.node_id);
    let ts      = now_ms() as i64;
    let node_id = body.node_id.clone();

    let _ = sqlx::query(
        "INSERT INTO nodes (wk_id, fleet_url, session_token, code, paired_at, last_seen)
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT(wk_id) DO UPDATE SET
           fleet_url     = EXCLUDED.fleet_url,
           session_token = EXCLUDED.session_token,
           code          = EXCLUDED.code,
           last_seen     = EXCLUDED.last_seen"
    ).bind(&node_id).bind(&body.fleet_url).bind(&token).bind(&body.code).bind(ts)
    .execute(&state.pool).await;

    state.metrics.write().unwrap()
        .entry(node_id.clone())
        .or_insert(MetricsEntry { last_seen_ms: now_ms(), metrics: None });

    (StatusCode::OK, Json(ClaimResponse { session_token: token, node_id })).into_response()
}

/// POST /api/telemetry
async fn handle_telemetry(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<MetricsPayload>,
) -> StatusCode {
    let node_id       = payload.node_id.clone();
    let node_hostname = payload.hostname.clone();
    let ts            = now_ms();

    // Authenticate: require session_token issued during pairing.
    let bearer = headers.get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "));
    let bearer = match bearer {
        Some(t) => t.to_string(),
        None => return StatusCode::UNAUTHORIZED,
    };

    // Combined existence + auth check (single indexed query).
    let stored_token: Option<String> = sqlx::query_scalar::<_, String>(
        "SELECT session_token FROM nodes WHERE wk_id = $1"
    ).bind(&node_id).fetch_optional(&state.pool).await.unwrap_or(None);

    match stored_token {
        None => return StatusCode::GONE, // 410 — node deleted from fleet
        Some(ref t) if t != &bearer => return StatusCode::UNAUTHORIZED,
        _ => {} // token matches — proceed
    }

    let duck_row = metrics_row_from_payload(&payload, ts);
    let live_activities = payload.live_activities.clone();
    let metrics_snap: Option<MetricsPayload> = Some(payload.clone());

    // Serialize payload as JSON for last_telemetry_json column.
    let payload_json = serde_json::to_value(&payload).ok();

    // Update in-memory snapshot.
    {
        let mut map = state.metrics.write().unwrap();
        if let Some(entry) = map.get_mut(&node_id) {
            entry.last_seen_ms = ts;
            entry.metrics      = Some(payload);
        } else {
            map.insert(node_id.clone(), MetricsEntry { last_seen_ms: ts, metrics: Some(payload) });
        }
    }

    // Persist last_seen, hostname, last_telemetry_json to nodes table,
    // then look up tenant_id and enqueue the metrics row.
    let pool       = state.pool.clone();
    let metrics_tx = state.metrics_tx.clone();
    let events_tx  = state.events_tx.clone();
    let nid        = node_id.clone();

    tokio::spawn(async move {
        // Update nodes table.
        if let Some(ref h) = node_hostname {
            let _ = sqlx::query(
                "UPDATE nodes SET last_seen = $1, hostname = $2, last_telemetry_json = $3 WHERE wk_id = $4"
            ).bind(ts as i64).bind(h).bind(&payload_json).bind(&nid)
            .execute(&pool).await;
        } else {
            let _ = sqlx::query(
                "UPDATE nodes SET last_seen = $1, last_telemetry_json = $2 WHERE wk_id = $3"
            ).bind(ts as i64).bind(&payload_json).bind(&nid)
            .execute(&pool).await;
        }

        // Resolve tenant_id and enqueue for ingest.
        if let Ok(tenant_id) = sqlx::query_scalar::<_, String>(
            "SELECT user_id FROM nodes WHERE wk_id = $1 AND user_id IS NOT NULL"
        ).bind(&nid).fetch_one(&pool).await {
            let row = MetricsRow { tenant_id: tenant_id.clone(), ..duck_row };
            if let Err(e) = metrics_tx.try_send(row) {
                eprintln!("[telemetry] metrics_tx send failed for {nid}: {e}");
            }

            for ev in &live_activities {
                let _ = events_tx.try_send(EventRow {
                    ts_ms:      ev.timestamp_ms as i64,
                    node_id:    nid.clone(),
                    tenant_id:  tenant_id.clone(),
                    level:      if ev.level.is_empty() { "info".to_string() } else { ev.level.clone() },
                    event_type: ev.event_type.clone(),
                    message:    ev.message.clone(),
                });
            }

            // Evaluate alert rules if user is Team+ tier.
            let tier: String = sqlx::query_scalar::<_, String>(
                "SELECT subscription_tier FROM users WHERE id = $1"
            ).bind(&tenant_id).fetch_one(&pool).await
            .unwrap_or_else(|_| "community".to_string());

            if is_team_or_above(&tier) {
                if let Some(ref metrics_snapshot) = metrics_snap {
                    evaluate_alerts(&tenant_id, &nid, metrics_snapshot, &pool).await;
                }
            }
        }
    });

    StatusCode::NO_CONTENT
}

/// GET /api/fleet
async fn handle_fleet(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let tier: String = sqlx::query_scalar::<_, String>(
        "SELECT subscription_tier FROM users WHERE id = $1"
    ).bind(&user_id).fetch_one(&state.pool).await
    .unwrap_or_else(|_| "community".to_string());

    let persisted: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT wk_id, fleet_url, paired_at FROM nodes WHERE user_id = $1 ORDER BY paired_at ASC"
    ).bind(&user_id).fetch_all(&state.pool).await.unwrap_or_default();

    let restricted: HashSet<String> = persisted.iter()
        .skip(if is_team_or_above(&tier) { usize::MAX } else { FREE_NODE_LIMIT })
        .map(|(id, _, _)| id.clone())
        .collect();

    let metrics_map = state.metrics.read().unwrap();
    let nodes: Vec<NodeSummary> = persisted.into_iter().map(|(node_id, fleet_url, last_seen_db)| {
        let (last_seen_ms, metrics) = metrics_map.get(&node_id)
            .map(|e| (e.last_seen_ms, e.metrics.clone()))
            .unwrap_or((last_seen_db as u64, None));
        let is_restricted = restricted.contains(&node_id);
        NodeSummary { node_id, fleet_url, last_seen_ms, metrics, restricted: is_restricted }
    }).collect();

    Json(FleetResponse { nodes }).into_response()
}

/// GET /api/fleet/events/history
async fn handle_fleet_events_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let limit: i64 = params.get("limit")
        .and_then(|v| v.parse().ok())
        .unwrap_or(50)
        .min(200);
    // Default to "now + 1 day" (in epoch ms) instead of i64::MAX.
    // i64::MAX overflows Postgres to_timestamp(), producing a 500/502.
    let default_before = (now_ms() + 86_400_000) as i64;
    let before: i64 = params.get("before")
        .and_then(|v| v.parse().ok())
        .unwrap_or(default_before);
    let node_id_filter = params.get("node_id").cloned();
    let event_type_filter = params.get("event_type").cloned();

    let base = "SELECT (EXTRACT(EPOCH FROM ts) * 1000)::bigint AS ts_ms, node_id, level, event_type, message FROM node_events WHERE tenant_id = $1 AND ts < to_timestamp($2::float8 / 1000.0)";

    let events: Vec<serde_json::Value> = match (&node_id_filter, &event_type_filter) {
        (Some(nid), Some(et)) => {
            let sql = format!("{base} AND node_id = $3 AND event_type = $4 ORDER BY ts DESC LIMIT $5");
            sqlx::query_as::<_, (i64, String, String, Option<String>, String)>(&sql)
                .bind(&user_id).bind(before).bind(nid).bind(et).bind(limit)
                .fetch_all(&state.pool).await.unwrap_or_default()
                .into_iter().map(|(ts_ms, node_id, level, event_type, message)| {
                    serde_json::json!({ "ts_ms": ts_ms, "node_id": node_id, "level": level, "event_type": event_type, "message": message })
                }).collect()
        }
        (Some(nid), None) => {
            let sql = format!("{base} AND node_id = $3 ORDER BY ts DESC LIMIT $4");
            sqlx::query_as::<_, (i64, String, String, Option<String>, String)>(&sql)
                .bind(&user_id).bind(before).bind(nid).bind(limit)
                .fetch_all(&state.pool).await.unwrap_or_default()
                .into_iter().map(|(ts_ms, node_id, level, event_type, message)| {
                    serde_json::json!({ "ts_ms": ts_ms, "node_id": node_id, "level": level, "event_type": event_type, "message": message })
                }).collect()
        }
        (None, Some(et)) => {
            let sql = format!("{base} AND event_type = $3 ORDER BY ts DESC LIMIT $4");
            sqlx::query_as::<_, (i64, String, String, Option<String>, String)>(&sql)
                .bind(&user_id).bind(before).bind(et).bind(limit)
                .fetch_all(&state.pool).await.unwrap_or_default()
                .into_iter().map(|(ts_ms, node_id, level, event_type, message)| {
                    serde_json::json!({ "ts_ms": ts_ms, "node_id": node_id, "level": level, "event_type": event_type, "message": message })
                }).collect()
        }
        (None, None) => {
            let sql = format!("{base} ORDER BY ts DESC LIMIT $3");
            sqlx::query_as::<_, (i64, String, String, Option<String>, String)>(&sql)
                .bind(&user_id).bind(before).bind(limit)
                .fetch_all(&state.pool).await.unwrap_or_default()
                .into_iter().map(|(ts_ms, node_id, level, event_type, message)| {
                    serde_json::json!({ "ts_ms": ts_ms, "node_id": node_id, "level": level, "event_type": event_type, "message": message })
                }).collect()
        }
    };

    Json(serde_json::json!({ "events": events })).into_response()
}

/// GET /api/fleet/observations
async fn handle_fleet_observations(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    // Tier-based pattern filtering: community users only see community-tier observations.
    let tier: String = sqlx::query_scalar::<_, String>(
        "SELECT subscription_tier FROM users WHERE id = $1"
    ).bind(&user_id).fetch_one(&state.pool).await.unwrap_or_else(|_| "community".to_string());
    let allowed = allowed_patterns_for_tier(&tier);

    let limit: i64 = params.get("limit").and_then(|v| v.parse().ok()).unwrap_or(50).min(200);
    let state_filter = params.get("state").cloned().unwrap_or_else(|| "open".into());
    let node_id_filter = params.get("node_id").cloned();

    let base = "SELECT id, node_id, alert_type, severity, state, title, detail, context_json::text, fired_at_ms, resolved_at_ms, ack_at_ms, acknowledged_by FROM fleet_observations WHERE tenant_id = $1 AND alert_type = ANY($2)";

    let rows: Vec<(String, String, String, String, String, String, String, Option<String>, i64, Option<i64>, Option<i64>, Option<String>)> = match (state_filter.as_str(), &node_id_filter) {
        ("all", Some(nid)) => {
            let sql = format!("{base} AND node_id = $3 ORDER BY fired_at_ms DESC LIMIT $4");
            sqlx::query_as(&sql).bind(&user_id).bind(&allowed).bind(nid).bind(limit)
                .fetch_all(&state.pool).await.unwrap_or_default()
        }
        ("all", None) => {
            let sql = format!("{base} ORDER BY fired_at_ms DESC LIMIT $3");
            sqlx::query_as(&sql).bind(&user_id).bind(&allowed).bind(limit)
                .fetch_all(&state.pool).await.unwrap_or_default()
        }
        (st, Some(nid)) => {
            let sql = format!("{base} AND state = $3 AND node_id = $4 ORDER BY fired_at_ms DESC LIMIT $5");
            sqlx::query_as(&sql).bind(&user_id).bind(&allowed).bind(st).bind(nid).bind(limit)
                .fetch_all(&state.pool).await.unwrap_or_default()
        }
        (st, None) => {
            let sql = format!("{base} AND state = $3 ORDER BY fired_at_ms DESC LIMIT $4");
            sqlx::query_as(&sql).bind(&user_id).bind(&allowed).bind(st).bind(limit)
                .fetch_all(&state.pool).await.unwrap_or_default()
        }
    };

    let observations: Vec<serde_json::Value> = rows.into_iter().map(|r| {
        serde_json::json!({
            "id": r.0, "node_id": r.1, "alert_type": r.2, "severity": r.3,
            "state": r.4, "title": r.5, "detail": r.6, "context_json": r.7,
            "fired_at_ms": r.8, "resolved_at_ms": r.9, "ack_at_ms": r.10,
            "acknowledged_by": r.11,
        })
    }).collect();

    Json(serde_json::json!({ "observations": observations })).into_response()
}

/// POST /api/fleet/observations/:id/acknowledge
async fn handle_acknowledge_observation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(obs_id): Path<String>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let now = now_ms() as i64;
    let result = sqlx::query(
        "UPDATE fleet_observations SET state = 'acknowledged', ack_at_ms = $1, acknowledged_by = $4
         WHERE id = $2 AND tenant_id = $3 AND state = 'open'"
    ).bind(now).bind(&obs_id).bind(&user_id).bind(&user_id)
    .execute(&state.pool).await;

    match result {
        Ok(r) if r.rows_affected() > 0 => Json(serde_json::json!({ "ok": true })).into_response(),
        Ok(_) => (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Observation not found or already resolved" }))).into_response(),
        Err(e) => { eprintln!("[observations] update failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" }))).into_response() },
    }
}

/// POST /api/fleet/observations — submit client-side pattern detections (Pro+)
async fn handle_submit_observation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    // Pro+ only — persistent insight cards
    let tier: String = sqlx::query_scalar::<_, String>(
        "SELECT subscription_tier FROM users WHERE id = $1"
    ).bind(&user_id).fetch_one(&state.pool).await.unwrap_or_else(|_| "community".to_string());
    if tier == "community" {
        return (StatusCode::PAYMENT_REQUIRED,
            Json(serde_json::json!({ "error": "Persistent insights require Pro tier or above", "upgrade": true }))).into_response();
    }

    let node_id    = body["node_id"].as_str().unwrap_or_default().to_string();
    let alert_type = body["alert_type"].as_str().unwrap_or_default().to_string();
    let severity   = body["severity"].as_str().unwrap_or("warning").to_string();
    let title      = body["title"].as_str().unwrap_or_default().to_string();
    let detail     = body["detail"].as_str().unwrap_or_default().to_string();
    let context    = body.get("context").cloned().unwrap_or(serde_json::json!({}));

    if node_id.is_empty() || alert_type.is_empty() || title.is_empty() {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "node_id, alert_type, and title are required" }))).into_response();
    }

    // Verify node belongs to user
    let owns: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM nodes WHERE wk_id = $1 AND user_id = $2"
    ).bind(&node_id).bind(&user_id).fetch_one(&state.pool).await.unwrap_or(0) > 0;
    if !owns {
        return (StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Node not found or not owned by you" }))).into_response();
    }

    // Dedup: skip if same (node, alert_type) already open
    let already_open: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM fleet_observations WHERE tenant_id = $1 AND node_id = $2 AND alert_type = $3 AND state = 'open'"
    ).bind(&user_id).bind(&node_id).bind(&alert_type).fetch_one(&state.pool).await.unwrap_or(0) > 0;
    if already_open {
        return Json(serde_json::json!({ "ok": true, "dedup": true, "message": "Already open" })).into_response();
    }

    let now = now_ms() as i64;
    let obs_id = Uuid::new_v4().to_string();
    let context_str = serde_json::to_string(&context).unwrap_or_default();

    let _ = sqlx::query(
        "INSERT INTO fleet_observations (id, tenant_id, node_id, alert_type, severity, state, title, detail, context_json, fired_at_ms)
         VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8::jsonb, $9)
         ON CONFLICT DO NOTHING"
    ).bind(&obs_id).bind(&user_id).bind(&node_id).bind(&alert_type)
    .bind(&severity).bind(&title).bind(&detail)
    .bind(&context_str).bind(now)
    .execute(&state.pool).await;

    // Also write to node_events for timeline visibility
    let _ = state.events_tx.try_send(EventRow {
        ts_ms: now, node_id: node_id.clone(), tenant_id: user_id.clone(),
        level: if severity == "critical" { "error" } else { "warning" }.into(),
        event_type: Some(alert_type.clone()), message: title.clone(),
    });

    Json(serde_json::json!({ "ok": true, "id": obs_id })).into_response()
}

/// POST /api/fleet/observations/:id/resolve — mark an observation as resolved from frontend
async fn handle_resolve_observation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(obs_id): Path<String>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let now = now_ms() as i64;
    let result = sqlx::query(
        "UPDATE fleet_observations SET state = 'resolved', resolved_at_ms = $1
         WHERE id = $2 AND tenant_id = $3 AND state = 'open'"
    ).bind(now).bind(&obs_id).bind(&user_id)
    .execute(&state.pool).await;

    match result {
        Ok(r) if r.rows_affected() > 0 => Json(serde_json::json!({ "ok": true })).into_response(),
        Ok(_) => (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Observation not found or already resolved" }))).into_response(),
        Err(e) => { eprintln!("[observations] resolve failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" }))).into_response() },
    }
}

/// GET /api/fleet/export
async fn handle_fleet_export(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    // Export is Team+ only
    let tier: String = sqlx::query_scalar::<_, String>(
        "SELECT subscription_tier FROM users WHERE id = $1"
    ).bind(&user_id).fetch_one(&state.pool).await.unwrap_or_else(|_| "community".to_string());
    if !is_team_or_above(&tier) {
        return (StatusCode::PAYMENT_REQUIRED,
            Json(serde_json::json!({ "error": "CSV/JSON export requires Team tier or above", "upgrade": true }))).into_response();
    }

    let now_ms_val = now_ms() as i64;
    let from_ms: i64 = params.get("from").and_then(|v| v.parse().ok()).unwrap_or(now_ms_val - 24 * 60 * 60 * 1000);
    let to_ms: i64   = params.get("to").and_then(|v| v.parse().ok()).unwrap_or(now_ms_val);
    let limit: i64   = params.get("limit").and_then(|v| v.parse().ok()).unwrap_or(10_000).min(50_000);
    let format        = params.get("format").map(|s| s.as_str()).unwrap_or("csv").to_string();
    let node_filter   = params.get("node_id").cloned();

    let base = "SELECT (EXTRACT(EPOCH FROM ts) * 1000)::bigint AS ts_ms, node_id, level, event_type, message
                FROM node_events WHERE tenant_id = $1 AND ts >= to_timestamp($2::float8 / 1000.0) AND ts <= to_timestamp($3::float8 / 1000.0)";

    let events: Vec<(i64, String, String, Option<String>, String)> = match &node_filter {
        Some(nid) => {
            let sql = format!("{base} AND node_id = $4 ORDER BY ts DESC LIMIT $5");
            sqlx::query_as(&sql).bind(&user_id).bind(from_ms).bind(to_ms).bind(nid).bind(limit)
                .fetch_all(&state.pool).await.unwrap_or_default()
        }
        None => {
            let sql = format!("{base} ORDER BY ts DESC LIMIT $4");
            sqlx::query_as(&sql).bind(&user_id).bind(from_ms).bind(to_ms).bind(limit)
                .fetch_all(&state.pool).await.unwrap_or_default()
        }
    };

    if format == "json" {
        let json_events: Vec<serde_json::Value> = events.iter().map(|(ts_ms, node_id, level, event_type, message)| {
            let ts_str = format!("{}.{:03}", ts_ms / 1000, ts_ms % 1000);
            serde_json::json!({
                "ts_ms": ts_ms, "timestamp": ts_str, "record_type": "event",
                "node_id": node_id, "level": level, "event_type": event_type, "message": message,
            })
        }).collect();
        let body = serde_json::to_string_pretty(&json_events).unwrap_or_default();
        (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "application/json"),
             (axum::http::header::CONTENT_DISPOSITION, "attachment; filename=\"wicklee-fleet-export.json\"")],
            body,
        ).into_response()
    } else {
        let mut csv = String::from("timestamp,record_type,node_id,level,event_type,message\n");
        for (ts_ms, node_id, level, event_type, message) in &events {
            let ts_str = format!("{}.{:03}", ts_ms / 1000, ts_ms % 1000);
            csv.push_str(&format!("{},{},{},{},{},{}\n",
                ts_str, "event", node_id, level,
                event_type.as_deref().unwrap_or(""),
                message.replace(',', ";"),
            ));
        }
        (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "text/csv; charset=utf-8"),
             (axum::http::header::CONTENT_DISPOSITION, "attachment; filename=\"wicklee-fleet-export.csv\"")],
            csv,
        ).into_response()
    }
}

/// Helper for converting range to epoch-based bucket seconds (stock Postgres compatible).
fn time_bucket_for_range(range: &str) -> (i64, &str, bool) {
    // Returns (bucket_seconds, lookback_interval, use_raw)
    // Using epoch-based bucketing instead of TimescaleDB time_bucket()
    // so it works on stock Postgres without TimescaleDB extension.
    match range {
        "1h"  => (60,     "1 hour",   true),
        "24h" => (300,    "24 hours",  true),
        "7d"  => (1800,   "7 days",   false),
        "30d" => (7200,   "30 days",  false),
        "90d" => (21600,  "90 days",  false),
        _     => (300,    "24 hours",  true),
    }
}

/// GET /api/fleet/wes-history
async fn handle_wes_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let range = params.get("range").map(|s| s.as_str()).unwrap_or("24h").to_string();
    let node_id_filter = params.get("node_id").cloned();
    let (bucket_secs, lookback_interval, use_raw) = time_bucket_for_range(&range);

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    // Tier enforcement
    let tier: String = sqlx::query_scalar::<_, String>(
        "SELECT subscription_tier FROM users WHERE id = $1"
    ).bind(&user_id).fetch_one(&state.pool).await.unwrap_or_else(|_| "community".to_string());

    let allowed = match tier.as_str() {
        "team" | "enterprise" => true,
        "pro" => !matches!(range.as_str(), "30d" | "90d"),
        _ => matches!(range.as_str(), "1h" | "24h"),
    };
    if !allowed {
        return (StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": format!("Range '{}' requires a higher subscription tier", range) }))).into_response();
    }

    // Enumerate user's nodes
    let node_rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT wk_id, hostname FROM nodes WHERE user_id = $1 ORDER BY last_seen DESC"
    ).bind(&user_id).fetch_all(&state.pool).await.unwrap_or_default();

    if node_rows.is_empty() {
        return Json(serde_json::json!({ "range": range, "nodes": [] })).into_response();
    }

    // Enrich hostnames from live cache
    let node_rows: Vec<(String, Option<String>)> = {
        let metrics_map = state.metrics.read().unwrap();
        node_rows.into_iter().map(|(nid, stored_hostname)| {
            let live_hostname = metrics_map.get(&nid)
                .and_then(|e| e.metrics.as_ref())
                .and_then(|m| m.hostname.clone());
            (nid, live_hostname.or(stored_hostname))
        }).collect()
    };

    let target_nodes: Vec<(String, Option<String>)> = match node_id_filter {
        Some(ref id) => {
            let found: Vec<_> = node_rows.into_iter().filter(|(nid, _)| nid == id).collect();
            if found.is_empty() {
                return (StatusCode::NOT_FOUND,
                    Json(serde_json::json!({ "error": "Node not found" }))).into_response();
            }
            found
        }
        None => node_rows,
    };

    let mut nodes_data: Vec<serde_json::Value> = Vec::new();

    for (node_id, hostname) in &target_nodes {
        let points: Vec<serde_json::Value> = if use_raw {
            let sql = format!(
                "SELECT (floor(EXTRACT(EPOCH FROM ts) / {bucket_secs}) * {bucket_secs} * 1000)::bigint AS bucket_ms,
                        AVG(wes_raw)       AS raw_wes,
                        AVG(wes_penalized) AS penalized_wes,
                        MAX(CASE thermal_state
                            WHEN 'Critical' THEN 3
                            WHEN 'Serious'  THEN 2
                            WHEN 'Fair'     THEN 1
                            ELSE 0 END)     AS thermal_rank
                 FROM metrics_raw
                 WHERE tenant_id = $1 AND node_id = $2 AND ts >= NOW() - INTERVAL '{lookback}'
                 GROUP BY bucket_ms ORDER BY bucket_ms",
                bucket_secs = bucket_secs, lookback = lookback_interval
            );
            sqlx::query_as::<_, (i64, Option<f64>, Option<f64>, Option<i32>)>(&sql)
                .bind(&user_id).bind(node_id)
                .fetch_all(&state.pool).await.unwrap_or_default()
                .into_iter().map(|(ts, rw, pw, tr)| {
                    let thermal = match tr { Some(3) => "Critical", Some(2) => "Serious", Some(1) => "Fair", _ => "Normal" };
                    serde_json::json!({ "ts_ms": ts, "raw_wes": rw, "penalized_wes": pw, "thermal_state": thermal })
                }).collect()
        } else {
            let sql = format!(
                "SELECT (floor(EXTRACT(EPOCH FROM ts) / {bucket_secs}) * {bucket_secs} * 1000)::bigint AS bucket_ms,
                        AVG(wes_raw_avg)       AS raw_wes,
                        AVG(wes_penalized_avg) AS penalized_wes,
                        MAX(CASE thermal_state_worst
                            WHEN 'Critical' THEN 3
                            WHEN 'Serious'  THEN 2
                            WHEN 'Fair'     THEN 1
                            ELSE 0 END)         AS thermal_rank
                 FROM metrics_5min
                 WHERE tenant_id = $1 AND node_id = $2 AND ts >= NOW() - INTERVAL '{lookback}'
                 GROUP BY bucket_ms ORDER BY bucket_ms",
                bucket_secs = bucket_secs, lookback = lookback_interval
            );
            sqlx::query_as::<_, (i64, Option<f64>, Option<f64>, Option<i32>)>(&sql)
                .bind(&user_id).bind(node_id)
                .fetch_all(&state.pool).await.unwrap_or_default()
                .into_iter().map(|(ts, rw, pw, tr)| {
                    let thermal = match tr { Some(3) => "Critical", Some(2) => "Serious", Some(1) => "Fair", _ => "Normal" };
                    serde_json::json!({ "ts_ms": ts, "raw_wes": rw, "penalized_wes": pw, "thermal_state": thermal })
                }).collect()
        };

        let display_hostname = hostname.clone().unwrap_or_else(|| node_id.clone());
        nodes_data.push(serde_json::json!({ "node_id": node_id, "hostname": display_hostname, "points": points }));
    }

    Json(serde_json::json!({ "range": range, "nodes": nodes_data })).into_response()
}

/// GET /api/fleet/metrics-history
async fn handle_metrics_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let range          = params.get("range").map(|s| s.as_str()).unwrap_or("24h").to_string();
    let node_id_filter = params.get("node_id").cloned();
    let (bucket_secs, lookback_interval, use_raw) = time_bucket_for_range(&range);

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    // Tier enforcement
    let tier: String = sqlx::query_scalar::<_, String>(
        "SELECT subscription_tier FROM users WHERE id = $1"
    ).bind(&user_id).fetch_one(&state.pool).await.unwrap_or_else(|_| "community".to_string());

    let allowed = match tier.as_str() {
        "team" | "enterprise" => true,
        "pro" => !matches!(range.as_str(), "30d" | "90d"),
        _ => matches!(range.as_str(), "1h" | "24h"),
    };
    if !allowed {
        return (StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": format!("Range '{}' requires a higher subscription tier", range) }))).into_response();
    }

    let node_rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT wk_id, hostname FROM nodes WHERE user_id = $1 ORDER BY last_seen DESC"
    ).bind(&user_id).fetch_all(&state.pool).await.unwrap_or_default();

    if node_rows.is_empty() {
        return Json(serde_json::json!({ "range": range, "nodes": [] })).into_response();
    }

    let node_rows: Vec<(String, Option<String>)> = {
        let metrics_map = state.metrics.read().unwrap();
        node_rows.into_iter().map(|(nid, stored_hostname)| {
            let live_hostname = metrics_map.get(&nid)
                .and_then(|e| e.metrics.as_ref())
                .and_then(|m| m.hostname.clone());
            (nid, live_hostname.or(stored_hostname))
        }).collect()
    };

    let target_nodes: Vec<(String, Option<String>)> = match node_id_filter {
        Some(ref id) => {
            let found: Vec<_> = node_rows.into_iter().filter(|(nid, _)| nid == id).collect();
            if found.is_empty() {
                return (StatusCode::NOT_FOUND,
                    Json(serde_json::json!({ "error": "Node not found" }))).into_response();
            }
            found
        }
        None => node_rows,
    };

    let mut nodes_data: Vec<serde_json::Value> = Vec::new();

    for (node_id, hostname) in &target_nodes {
        let points: Vec<serde_json::Value> = if use_raw {
            let sql = format!(
                "SELECT (floor(EXTRACT(EPOCH FROM ts) / {bucket_secs}) * {bucket_secs} * 1000)::bigint AS bucket_ms,
                        AVG(tok_s)            AS tok_s,
                        NULL::float8           AS tok_s_p95,
                        AVG(watts)            AS watts,
                        AVG(gpu_pct)          AS gpu_pct,
                        AVG(mem_pressure_pct) AS mem_pct,
                        (SUM(CASE WHEN inference_state = 'live' THEN 1 ELSE 0 END)::float8 / NULLIF(COUNT(*), 0)::float8 * 100.0) AS duty_pct,
                        AVG(cpu_pct)          AS cpu_pct,
                        AVG(swap_write)       AS swap_write,
                        AVG(ttft_ms)          AS ttft_ms,
                        AVG(avg_latency_ms)   AS e2e_latency_ms
                 FROM metrics_raw
                 WHERE tenant_id = $1 AND node_id = $2 AND ts >= NOW() - INTERVAL '{lookback}'
                 GROUP BY bucket_ms ORDER BY bucket_ms",
                bucket_secs = bucket_secs, lookback = lookback_interval
            );
            sqlx::query_as::<_, (i64, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>)>(&sql)
                .bind(&user_id).bind(node_id)
                .fetch_all(&state.pool).await.unwrap_or_default()
                .into_iter().map(|(ts, toks, toksp95, w, gpu, mem, duty, cpu, swap, ttft, e2e)| {
                    serde_json::json!({ "ts_ms": ts, "tok_s": toks, "tok_s_p95": toksp95, "watts": w, "gpu_pct": gpu, "mem_pct": mem, "duty_pct": duty, "cpu_pct": cpu, "swap_write": swap, "ttft_ms": ttft, "e2e_latency_ms": e2e })
                }).collect()
        } else {
            let sql = format!(
                "SELECT (floor(EXTRACT(EPOCH FROM ts) / {bucket_secs}) * {bucket_secs} * 1000)::bigint AS bucket_ms,
                        AVG(tok_s_avg)            AS tok_s,
                        AVG(tok_s_p95)            AS tok_s_p95,
                        AVG(watts_avg)            AS watts,
                        AVG(gpu_pct_avg)          AS gpu_pct,
                        AVG(mem_pressure_pct_avg) AS mem_pct,
                        AVG(inference_duty_pct)   AS duty_pct,
                        NULL::float8              AS cpu_pct,
                        AVG(swap_write_avg)       AS swap_write,
                        NULL::float8              AS ttft_ms,
                        NULL::float8              AS e2e_latency_ms
                 FROM metrics_5min
                 WHERE tenant_id = $1 AND node_id = $2 AND ts >= NOW() - INTERVAL '{lookback}'
                 GROUP BY bucket_ms ORDER BY bucket_ms",
                bucket_secs = bucket_secs, lookback = lookback_interval
            );
            sqlx::query_as::<_, (i64, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>)>(&sql)
                .bind(&user_id).bind(node_id)
                .fetch_all(&state.pool).await.unwrap_or_default()
                .into_iter().map(|(ts, toks, toksp95, w, gpu, mem, duty, cpu, swap, ttft, e2e)| {
                    serde_json::json!({ "ts_ms": ts, "tok_s": toks, "tok_s_p95": toksp95, "watts": w, "gpu_pct": gpu, "mem_pct": mem, "duty_pct": duty, "cpu_pct": cpu, "swap_write": swap, "ttft_ms": ttft, "e2e_latency_ms": e2e })
                }).collect()
        };

        let display_hostname = hostname.clone().unwrap_or_else(|| node_id.clone());
        nodes_data.push(serde_json::json!({ "node_id": node_id, "hostname": display_hostname, "points": points }));
    }

    Json(serde_json::json!({ "range": range, "nodes": nodes_data })).into_response()
}

/// GET /api/fleet/duty
async fn handle_fleet_duty(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let range = params.get("range").map(|s| s.as_str()).unwrap_or("24h").to_string();
    let (_bucket, lookback_interval, use_raw) = time_bucket_for_range(&range);

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(uid) => uid,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid token" }))).into_response(),
    };

    let target_nodes: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT wk_id, hostname FROM nodes WHERE user_id = $1"
    ).bind(&user_id).fetch_all(&state.pool).await.unwrap_or_default();

    if target_nodes.is_empty() {
        return Json(serde_json::json!({ "range": range, "duty_pct": null, "total_samples": 0, "live_samples": 0, "nodes": [] })).into_response();
    }

    let mut per_node = Vec::new();
    let mut total_all: i64 = 0;
    let mut live_all: i64 = 0;

    for (nid, hostname) in &target_nodes {
        let (total, live): (i64, i64) = if use_raw {
            let sql = format!(
                "SELECT COUNT(*) AS total,
                        SUM(CASE WHEN inference_state = 'live' THEN 1 ELSE 0 END) AS live_count
                 FROM metrics_raw
                 WHERE tenant_id = $1 AND node_id = $2 AND ts >= NOW() - INTERVAL '{lookback}'",
                lookback = lookback_interval
            );
            sqlx::query_as::<_, (i64, i64)>(&sql)
                .bind(&user_id).bind(nid)
                .fetch_one(&state.pool).await.unwrap_or((0, 0))
        } else {
            let sql = format!(
                "SELECT COALESCE(SUM(sample_count), 0) AS total,
                        COALESCE(SUM((inference_duty_pct * sample_count / 100.0)::bigint), 0) AS live_count
                 FROM metrics_5min
                 WHERE tenant_id = $1 AND node_id = $2 AND ts >= NOW() - INTERVAL '{lookback}'",
                lookback = lookback_interval
            );
            sqlx::query_as::<_, (i64, i64)>(&sql)
                .bind(&user_id).bind(nid)
                .fetch_one(&state.pool).await.unwrap_or((0, 0))
        };

        let duty_pct = if total > 0 { Some((live as f64 / total as f64) * 100.0) } else { None };
        let display_hostname = hostname.clone().unwrap_or_else(|| nid.clone());
        per_node.push(serde_json::json!({
            "node_id": nid, "hostname": display_hostname,
            "duty_pct": duty_pct.map(|d| (d * 10.0).round() / 10.0),
        }));
        total_all += total;
        live_all  += live;
    }

    let fleet_duty = if total_all > 0 {
        Some(((live_all as f64 / total_all as f64) * 1000.0).round() / 10.0)
    } else { None };

    Json(serde_json::json!({
        "range": range, "duty_pct": fleet_duty,
        "total_samples": total_all, "live_samples": live_all, "nodes": per_node,
    })).into_response()
}

/// POST /api/pair/activate
#[derive(Deserialize)]
struct ActivateRequest {
    code: String,
}

async fn handle_activate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ActivateRequest>,
) -> impl IntoResponse {
    if body.code.len() != 6 || !body.code.chars().all(|c| c.is_ascii_digit()) {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "code must be exactly 6 ASCII digits" }))).into_response();
    }

    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_info = require_user_info(&token, &state.pool, &clerk_keys).await;

    let (user_id, email, is_pro_db) = match user_info {
        Some(info) => info,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let is_pro = is_pro_db != 0 || is_dev_account(&email);
    if !is_pro {
        let count: i64 = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM nodes WHERE user_id = $1"
        ).bind(&user_id).fetch_one(&state.pool).await.unwrap_or(0);
        if count as usize >= MAX_FREE_NODES {
            return (StatusCode::PAYMENT_REQUIRED,
                Json(serde_json::json!({
                    "error": format!("Free tier limit reached ({MAX_FREE_NODES} nodes). Upgrade to Wicklee Pro to add more.")
                }))).into_response();
        }
    }

    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT wk_id, fleet_url FROM nodes WHERE code = $1"
    ).bind(&body.code).fetch_one(&state.pool).await;

    match row {
        Err(_) => (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Code not found or already used. Make sure the agent is running and try again." }))).into_response(),
        Ok((node_id, fleet_url)) => {
            let _ = sqlx::query("UPDATE nodes SET user_id = $1 WHERE wk_id = $2")
                .bind(&user_id).bind(&node_id)
                .execute(&state.pool).await;
            (StatusCode::OK, Json(serde_json::json!({ "node_id": node_id, "fleet_url": fleet_url }))).into_response()
        }
    }
}

/// GET /api/fleet/stream — SSE stream pushing fleet snapshots every 2 s.
async fn handle_fleet_stream(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let stream_token = match params.get("token") {
        Some(t) if !t.is_empty() => t.clone(),
        _ => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing stream token" }))).into_response(),
    };

    let now = now_ms() as i64;
    let user_id = match sqlx::query_scalar::<_, String>(
        "SELECT user_id FROM stream_tokens WHERE token = $1 AND expires_ms > $2"
    ).bind(&stream_token).bind(now).fetch_one(&state.pool).await {
        Ok(uid) => uid,
        Err(_) => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired stream token" }))).into_response(),
    };

    // Load initial node set and tier.
    let pool = state.pool.clone();
    let uid2 = user_id.clone();
    let initial_nodes = user_node_set_blocking(&uid2, &pool);
    let initial_ordered: Vec<String> = tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(async {
            sqlx::query_scalar::<_, String>(
                "SELECT wk_id FROM nodes WHERE user_id = $1 ORDER BY paired_at ASC"
            ).bind(&uid2).fetch_all(&pool).await.unwrap_or_default()
        })
    });
    let initial_tier: String = tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(async {
            sqlx::query_scalar::<_, String>(
                "SELECT subscription_tier FROM users WHERE id = $1"
            ).bind(&uid2).fetch_one(&pool).await.unwrap_or_else(|_| "community".to_string())
        })
    });

    let interval_stream = tokio_stream::wrappers::IntervalStream::new(
        tokio::time::interval(Duration::from_secs(2)),
    );

    let uid_stream = user_id.clone();
    let mut nodes          = initial_nodes;
    let mut ordered_nodes  = initial_ordered;
    let mut tier           = initial_tier;
    // display_name cache: node_id → custom name (Pro+ feature)
    let mut display_names: HashMap<String, String> = tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(async {
            sqlx::query_as::<_, (String, String)>(
                "SELECT wk_id, display_name FROM nodes WHERE user_id = $1 AND display_name IS NOT NULL"
            ).bind(&uid2).fetch_all(&pool).await.unwrap_or_default()
                .into_iter().collect()
        })
    });
    let mut tick: u32 = 0;

    let stream = interval_stream.map(move |_| {
        tick += 1;
        if tick % 30 == 0 {
            let uid_ref = uid_stream.clone();
            nodes = user_node_set_blocking(&uid_ref, &pool);
            ordered_nodes = tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current().block_on(async {
                    sqlx::query_scalar::<_, String>(
                        "SELECT wk_id FROM nodes WHERE user_id = $1 ORDER BY paired_at ASC"
                    ).bind(&uid_ref).fetch_all(&pool).await.unwrap_or_default()
                })
            });
            tier = tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current().block_on(async {
                    sqlx::query_scalar::<_, String>(
                        "SELECT subscription_tier FROM users WHERE id = $1"
                    ).bind(&uid_ref).fetch_one(&pool).await.unwrap_or_else(|_| "community".to_string())
                })
            });
            display_names = tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current().block_on(async {
                    sqlx::query_as::<_, (String, String)>(
                        "SELECT wk_id, display_name FROM nodes WHERE user_id = $1 AND display_name IS NOT NULL"
                    ).bind(&uid_ref).fetch_all(&pool).await.unwrap_or_default()
                        .into_iter().collect()
                })
            });
        }

        let restricted_ids: HashSet<&str> = if is_team_or_above(&tier) {
            HashSet::new()
        } else {
            ordered_nodes.iter().skip(FREE_NODE_LIMIT).map(|s| s.as_str()).collect()
        };

        let metrics_map = state.metrics.read().unwrap();
        let node_list: Vec<serde_json::Value> = metrics_map
            .iter()
            .filter(|(node_id, _)| nodes.contains(node_id.as_str()))
            .map(|(node_id, entry)| {
                let mut obj = serde_json::json!({
                    "node_id":      node_id,
                    "last_seen_ms": entry.last_seen_ms,
                    "metrics":      entry.metrics,
                    "restricted":   restricted_ids.contains(node_id.as_str()),
                });
                if let Some(name) = display_names.get(node_id.as_str()) {
                    obj["display_name"] = serde_json::Value::String(name.clone());
                }
                obj
            })
            .collect();

        let data = serde_json::to_string(&serde_json::json!({ "nodes": node_list }))
            .unwrap_or_else(|_| r#"{"nodes":[]}"#.to_string());
        Ok::<_, Infallible>(Event::default().data(data))
    });

    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

/// GET /health
async fn handle_health(State(state): State<AppState>) -> impl IntoResponse {
    let now = now_ms() as i64;
    let raw_stats = sqlx::query_as::<_, (Option<i64>, i64, i64)>(
        "SELECT
            (EXTRACT(EPOCH FROM MAX(ts)) * 1000)::bigint,
            COUNT(*) FILTER (WHERE ts > NOW() - INTERVAL '1 hour'),
            COUNT(*) FILTER (WHERE ts > NOW() - INTERVAL '24 hours')
         FROM metrics_raw"
    ).fetch_one(&state.pool).await.unwrap_or((None, 0, 0));

    let obs_open: i64 = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM fleet_observations WHERE state = 'open'"
    ).fetch_one(&state.pool).await.unwrap_or(0);

    let age_s = raw_stats.0.map(|ts| (now - ts) / 1000);

    Json(serde_json::json!({
        "status": "ok",
        "now_ms": now,
        "metrics_raw": {
            "latest_ts_ms": raw_stats.0,
            "latest_age_s": age_s,
            "rows_1h": raw_stats.1,
            "rows_24h": raw_stats.2,
        },
        "fleet_observations_open": obs_open,
    })).into_response()
}

/// GET /api/agent/version
async fn handle_agent_version(
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let platform = params.get("platform").cloned().unwrap_or_default();

    let asset_name = match platform.as_str() {
        "darwin-aarch64"      => "wicklee-agent-darwin-aarch64",
        "linux-x86_64"        => "wicklee-agent-linux-x86_64",
        "linux-aarch64"       => "wicklee-agent-linux-aarch64",
        "linux-x86_64-nvidia" => "wicklee-agent-linux-x86_64-nvidia",
        "windows-x86_64"      => "wicklee-agent-windows-x86_64.exe",
        _ => return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "unrecognised platform" }))).into_response(),
    };

    let result = tokio::task::spawn_blocking(move || -> Result<(String, String), String> {
        let resp = ureq::get("https://api.github.com/repos/jeffgeiser/Wicklee/releases/latest")
            .set("User-Agent", "wicklee-cloud/1.0")
            .set("Accept", "application/vnd.github+json")
            .call()
            .map_err(|e| format!("github api request failed: {e}"))?;
        let body: serde_json::Value = resp.into_json()
            .map_err(|e| format!("github api json parse failed: {e}"))?;
        let tag = body["tag_name"].as_str()
            .ok_or_else(|| "missing tag_name".to_string())?.to_string();
        let download_url = format!("https://github.com/jeffgeiser/Wicklee/releases/download/{tag}/{asset_name}");
        Ok((tag, download_url))
    }).await;

    match result {
        Ok(Ok((latest, download_url))) => (StatusCode::OK,
            Json(serde_json::json!({ "latest": latest, "download_url": download_url }))).into_response(),
        Ok(Err(e)) => {
            eprintln!("[agent-version] upstream error: {e}");
            (StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "error": "could not fetch latest release" }))).into_response()
        }
        Err(e) => {
            eprintln!("[agent-version] task error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "internal error" }))).into_response()
        }
    }
}

// ── CORS middleware ───────────────────────────────────────────────────────────

/// Restrictive CORS for dashboard routes — only wicklee.dev and localhost dev server.
async fn cors_dashboard(req: Request<Body>, next: Next) -> Response {
    let origin = req.headers().get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let allowed = matches!(origin.as_str(),
        "https://wicklee.dev" | "http://localhost:3000" | "http://localhost:5173"
    );
    let allow_origin = if allowed { origin.as_str() } else { "https://wicklee.dev" };
    let origin_owned = allow_origin.to_string();

    if req.method() == Method::OPTIONS {
        return (
            StatusCode::OK,
            [
                (header::ACCESS_CONTROL_ALLOW_ORIGIN,  origin_owned.as_str()),
                (header::ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, PATCH, DELETE, OPTIONS"),
                (header::ACCESS_CONTROL_ALLOW_HEADERS, "content-type, authorization"),
            ],
        ).into_response();
    }

    let mut res = next.run(req).await;
    if let Ok(v) = header::HeaderValue::from_str(&origin_owned) {
        res.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
    }
    res
}

/// Permissive CORS for v1 API routes (external consumers) and agent endpoints.
async fn cors_open(req: Request<Body>, next: Next) -> Response {
    if req.method() == Method::OPTIONS {
        return (
            StatusCode::OK,
            [
                (header::ACCESS_CONTROL_ALLOW_ORIGIN,  "*"),
                (header::ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, DELETE, OPTIONS"),
                (header::ACCESS_CONTROL_ALLOW_HEADERS, "content-type, authorization, x-api-key"),
            ],
        ).into_response();
    }

    let mut res = next.run(req).await;
    res.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN,
        header::HeaderValue::from_static("*"));
    res
}

// ── Derive MetricsRow from inbound telemetry ────────────────────────────────

fn metrics_row_from_payload(m: &MetricsPayload, ts_ms: u64) -> MetricsRow {
    let tok_s   = if m.vllm_running { m.vllm_tokens_per_sec } else { m.ollama_tokens_per_second };
    let watts   = m.nvidia_power_draw_w.or(m.apple_soc_power_w).or(m.cpu_power_w);
    let penalty = thermal_penalty_for(m.thermal_state.as_deref());

    let wes_raw = match (tok_s, watts) {
        (Some(t), Some(w)) if t > 0.0 && w > 0.0 =>
            Some(((t / w) * 10.0).round() / 10.0),
        _ => None,
    };
    let wes_penalized = match (tok_s, watts) {
        (Some(t), Some(w)) if t > 0.0 && w > 0.0 =>
            Some(((t / (w * penalty)) * 10.0).round() / 10.0),
        _ => None,
    };
    let gpu_pct = m.gpu_utilization_percent.or(m.nvidia_gpu_utilization_percent);

    MetricsRow {
        node_id:          m.node_id.clone(),
        ts_ms:            ts_ms as i64,
        tenant_id:        String::new(),
        tok_s,
        watts,
        wes_raw,
        wes_penalized,
        thermal_cost_pct: m.penalty_avg.and_then(|p| if p > 1.0 { Some(((p - 1.0) / p) * 100.0) } else { None }),
        thermal_penalty:  Some(penalty),
        thermal_state:    m.thermal_state.clone(),
        vram_used_mb:     m.nvidia_vram_used_mb.map(|v| v as i32),
        vram_total_mb:    m.nvidia_vram_total_mb.map(|v| v as i32),
        mem_pressure_pct: m.memory_pressure_percent,
        gpu_pct,
        cpu_pct:          Some(m.cpu_usage_percent),
        inference_state:  m.inference_state.clone(),
        wes_version:      m.wes_version.unwrap_or(1),
        swap_write:       m.swap_write_mb_s,
        // Best-available TTFT: vLLM > proxy > Ollama probe
        ttft_ms:          m.vllm_avg_ttft_ms.or(m.ollama_proxy_avg_ttft_ms).or(m.ollama_ttft_ms),
        // Best-available latency: vLLM > proxy
        avg_latency_ms:   m.vllm_avg_e2e_latency_ms.or(m.ollama_proxy_avg_latency_ms),
        queue_depth:      m.vllm_requests_waiting.map(|v| v as i32),
    }
}

// ── Batch writer (Postgres UNNEST) ──────────────────────────────────────────

async fn flush_batch(pool: &sqlx::PgPool, batch: &[MetricsRow]) {
    if batch.is_empty() { return; }

    for chunk in batch.chunks(1000) {
        let ts_values:   Vec<f64>            = chunk.iter().map(|r| r.ts_ms as f64).collect();
        let node_ids:    Vec<&str>           = chunk.iter().map(|r| r.node_id.as_str()).collect();
        let tenant_ids:  Vec<&str>           = chunk.iter().map(|r| r.tenant_id.as_str()).collect();
        let tok_s:       Vec<Option<f32>>    = chunk.iter().map(|r| r.tok_s).collect();
        let watts:       Vec<Option<f32>>    = chunk.iter().map(|r| r.watts).collect();
        let wes_raw:     Vec<Option<f32>>    = chunk.iter().map(|r| r.wes_raw).collect();
        let wes_pen:     Vec<Option<f32>>    = chunk.iter().map(|r| r.wes_penalized).collect();
        let therm_cost:  Vec<Option<f32>>    = chunk.iter().map(|r| r.thermal_cost_pct).collect();
        let therm_pen:   Vec<Option<f32>>    = chunk.iter().map(|r| r.thermal_penalty).collect();
        let therm_state: Vec<Option<&str>>   = chunk.iter().map(|r| r.thermal_state.as_deref()).collect();
        let vram_used:   Vec<Option<i32>>    = chunk.iter().map(|r| r.vram_used_mb).collect();
        let vram_total:  Vec<Option<i32>>    = chunk.iter().map(|r| r.vram_total_mb).collect();
        let mem_pct:     Vec<Option<f32>>    = chunk.iter().map(|r| r.mem_pressure_pct).collect();
        let gpu_pct:     Vec<Option<f32>>    = chunk.iter().map(|r| r.gpu_pct).collect();
        let cpu_pct:     Vec<Option<f32>>    = chunk.iter().map(|r| r.cpu_pct).collect();
        let inf_state:   Vec<Option<&str>>   = chunk.iter().map(|r| r.inference_state.as_deref()).collect();
        let wes_ver:     Vec<i16>            = chunk.iter().map(|r| r.wes_version as i16).collect();
        let swap_write:  Vec<Option<f32>>    = chunk.iter().map(|r| r.swap_write).collect();
        let ttft:        Vec<Option<f32>>    = chunk.iter().map(|r| r.ttft_ms).collect();
        let avg_lat:     Vec<Option<f32>>    = chunk.iter().map(|r| r.avg_latency_ms).collect();
        let q_depth:     Vec<Option<i32>>    = chunk.iter().map(|r| r.queue_depth).collect();

        let _ = sqlx::query(
            "INSERT INTO metrics_raw (ts, node_id, tenant_id, tok_s, watts, wes_raw, wes_penalized,
                thermal_cost_pct, thermal_penalty, thermal_state, vram_used_mb, vram_total_mb,
                mem_pressure_pct, gpu_pct, cpu_pct, inference_state, wes_version, swap_write,
                ttft_ms, avg_latency_ms, queue_depth)
             SELECT to_timestamp(unnest($1::float8[]) / 1000.0),
                    unnest($2::text[]), unnest($3::text[]),
                    unnest($4::real[]), unnest($5::real[]), unnest($6::real[]), unnest($7::real[]),
                    unnest($8::real[]), unnest($9::real[]), unnest($10::text[]),
                    unnest($11::int[]), unnest($12::int[]),
                    unnest($13::real[]), unnest($14::real[]), unnest($15::real[]),
                    unnest($16::text[]), unnest($17::smallint[]), unnest($18::real[]),
                    unnest($19::real[]), unnest($20::real[]), unnest($21::int[])
             ON CONFLICT DO NOTHING"
        )
        .bind(&ts_values).bind(&node_ids).bind(&tenant_ids)
        .bind(&tok_s).bind(&watts).bind(&wes_raw).bind(&wes_pen)
        .bind(&therm_cost).bind(&therm_pen).bind(&therm_state)
        .bind(&vram_used).bind(&vram_total)
        .bind(&mem_pct).bind(&gpu_pct).bind(&cpu_pct)
        .bind(&inf_state).bind(&wes_ver).bind(&swap_write)
        .bind(&ttft).bind(&avg_lat).bind(&q_depth)
        .execute(pool).await;
    }
}

/// Background task: drain the metrics channel and flush every 30 s.
async fn metrics_writer_task(mut rx: mpsc::Receiver<MetricsRow>, pool: sqlx::PgPool) {
    let mut buffer: Vec<MetricsRow> = Vec::with_capacity(256);
    let mut flush_interval = tokio::time::interval(Duration::from_secs(30));
    flush_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    flush_interval.tick().await;

    loop {
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    None => break,
                    Some(row) => {
                        buffer.push(row);
                        if buffer.len() >= 512 {
                            let batch = std::mem::take(&mut buffer);
                            flush_batch(&pool, &batch).await;
                        }
                    }
                }
            }
            _ = flush_interval.tick() => {
                if !buffer.is_empty() {
                    let batch = std::mem::take(&mut buffer);
                    flush_batch(&pool, &batch).await;
                }
            }
        }
    }

    if !buffer.is_empty() {
        flush_batch(&pool, &buffer).await;
    }
}

/// Background task: drain the events channel and write immediately.
async fn events_writer_task(mut rx: mpsc::Receiver<EventRow>, pool: sqlx::PgPool) {
    while let Some(ev) = rx.recv().await {
        let _ = sqlx::query(
            "INSERT INTO node_events (ts, node_id, tenant_id, level, event_type, message)
             VALUES (to_timestamp($1::float8 / 1000.0), $2, $3, $4, $5, $6)
             ON CONFLICT DO NOTHING"
        ).bind(ev.ts_ms as f64).bind(&ev.node_id).bind(&ev.tenant_id)
        .bind(&ev.level).bind(&ev.event_type).bind(&ev.message)
        .execute(&pool).await;
    }
}

// ── Rollup & maintenance ─────────────────────────────────────────────────────

async fn run_rollup(pool: &sqlx::PgPool) {
    // Aggregate metrics_raw rows older than 24h into 5-minute buckets.
    let result = sqlx::query(
        "INSERT INTO metrics_5min (ts, node_id, tenant_id,
            tok_s_avg, tok_s_p50, tok_s_p95,
            watts_avg, wes_raw_avg, wes_penalized_avg, wes_penalized_min,
            thermal_cost_pct_avg, thermal_cost_pct_max, thermal_state_worst,
            mem_pressure_pct_avg, mem_pressure_pct_max, gpu_pct_avg,
            inference_duty_pct, swap_write_avg,
            sample_count, wes_version, wes_version_count, agent_version)
        SELECT
            to_timestamp(floor(EXTRACT(EPOCH FROM ts) / 300) * 300) AS bucket,
            node_id, tenant_id,
            AVG(tok_s),
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY tok_s),
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY tok_s),
            AVG(watts), AVG(wes_raw), AVG(wes_penalized), MIN(wes_penalized),
            AVG(thermal_cost_pct), MAX(thermal_cost_pct),
            CASE MAX(CASE thermal_state
                     WHEN 'Critical' THEN 3
                     WHEN 'Serious'  THEN 2
                     WHEN 'Fair'     THEN 1
                     ELSE 0 END)
                WHEN 3 THEN 'Critical'
                WHEN 2 THEN 'Serious'
                WHEN 1 THEN 'Fair'
                ELSE 'Normal' END,
            AVG(mem_pressure_pct), MAX(mem_pressure_pct), AVG(gpu_pct),
            (SUM(CASE WHEN inference_state = 'live' THEN 1 ELSE 0 END)::real / NULLIF(COUNT(*), 0)::real * 100.0),
            AVG(swap_write),
            COUNT(*)::smallint,
            MIN(wes_version)::smallint,
            COUNT(DISTINCT wes_version)::smallint,
            MIN(agent_version)
        FROM metrics_raw
        WHERE ts < NOW() - INTERVAL '24 hours'
        GROUP BY bucket, node_id, tenant_id
        ON CONFLICT DO NOTHING"
    ).execute(pool).await;

    match result {
        Ok(r) => println!("[rollup] inserted {} 5-min aggregates", r.rows_affected()),
        Err(e) => eprintln!("[rollup] insert failed: {e}"),
    }

    // Delete rolled-up raw rows. TimescaleDB retention policy also handles this,
    // but explicit deletion ensures data is rolled up first.
    let _ = sqlx::query(
        "DELETE FROM metrics_raw
         WHERE ts < NOW() - INTERVAL '24 hours'
           AND EXISTS (
               SELECT 1 FROM metrics_5min m
               WHERE m.tenant_id = metrics_raw.tenant_id
                 AND m.node_id   = metrics_raw.node_id
                 AND m.ts        = to_timestamp(floor(EXTRACT(EPOCH FROM metrics_raw.ts) / 300) * 300)
           )"
    ).execute(pool).await;

    println!("[rollup] complete");
}

/// Nightly maintenance: prune old data, VACUUM ANALYZE.
/// On TimescaleDB, retention policies handle metrics_raw/node_events/metrics_5min
/// automatically. These DELETEs are a fallback for stock Postgres without TimescaleDB.
async fn run_nightly_maintenance(pool: &sqlx::PgPool) {
    let now = now_ms() as i64;

    // Prune metrics_raw older than 2 days (fallback — TimescaleDB retention handles this if active).
    let _ = sqlx::query("DELETE FROM metrics_raw WHERE ts < to_timestamp($1::float8 / 1000.0)")
        .bind(now - 2 * 86_400_000).execute(pool).await;

    // Prune node_events older than 30 days.
    let _ = sqlx::query("DELETE FROM node_events WHERE ts < to_timestamp($1::float8 / 1000.0)")
        .bind(now - 30 * 86_400_000).execute(pool).await;

    // Prune metrics_5min older than 90 days.
    let _ = sqlx::query("DELETE FROM metrics_5min WHERE ts < to_timestamp($1::float8 / 1000.0)")
        .bind(now - 90 * 86_400_000).execute(pool).await;

    // Prune resolved/acknowledged observations older than 30 days.
    let _ = sqlx::query(
        "DELETE FROM fleet_observations WHERE state != 'open' AND fired_at_ms < $1"
    ).bind(now - 30 * 86_400_000).execute(pool).await;

    // ANALYZE key tables for query planner.
    let _ = sqlx::query("ANALYZE metrics_raw").execute(pool).await;
    let _ = sqlx::query("ANALYZE metrics_5min").execute(pool).await;
    let _ = sqlx::query("ANALYZE node_events").execute(pool).await;
    let _ = sqlx::query("ANALYZE fleet_observations").execute(pool).await;

    println!("[nightly] maintenance complete — pruned + ANALYZE");
}

async fn rollup_task(pool: sqlx::PgPool) {
    tokio::time::sleep(Duration::from_secs(60)).await;
    run_rollup(&pool).await;

    let mut interval = tokio::time::interval(Duration::from_secs(3600));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    interval.tick().await;
    loop {
        interval.tick().await;
        run_rollup(&pool).await;
    }
}

async fn nightly_task(pool: sqlx::PgPool) {
    loop {
        let now_s = SystemTime::now()
            .duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        let secs_in_day   = now_s % 86400;
        let target_in_day = 3 * 3600_u64;
        let sleep_secs = if secs_in_day < target_in_day {
            target_in_day - secs_in_day
        } else {
            86400 - secs_in_day + target_in_day
        };
        tokio::time::sleep(Duration::from_secs(sleep_secs)).await;
        run_nightly_maintenance(&pool).await;
    }
}

// ── Alerting — structs ────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct AlertChannel {
    id:           String,
    channel_type: String,
    name:         String,
    config_json:  String,
    verified:     bool,
    created_at:   i64,
}

#[derive(Serialize, Clone)]
struct AlertRule {
    id:              String,
    node_id:         Option<String>,
    event_type:      String,
    threshold_value: Option<f64>,
    urgency:         String,
    channel_id:      String,
    enabled:         bool,
    created_at:      i64,
}

#[derive(Deserialize)]
struct CreateChannelRequest {
    channel_type: String,
    name:         String,
    config_json:  String,
}

#[derive(Deserialize)]
struct CreateRuleRequest {
    node_id:         Option<String>,
    event_type:      String,
    threshold_value: Option<f64>,
    urgency:         Option<String>,
    channel_id:      String,
}

// ── Alerting — notification delivery ─────────────────────────────────────────

fn send_slack(webhook_url: &str, blocks_json: &str) -> bool {
    let body = format!(r#"{{"blocks":{blocks_json}}}"#);
    match ureq::post(webhook_url)
        .set("Content-Type", "application/json")
        .send_string(&body)
    {
        Ok(_)  => true,
        Err(e) => { eprintln!("[slack] delivery failed: {e}"); false }
    }
}

fn send_email(to: &str, subject: &str, text: &str, html: &str) -> bool {
    let api_key = match std::env::var("RESEND_API_KEY") {
        Ok(k) => k,
        Err(_) => { eprintln!("[email] RESEND_API_KEY not set"); return false; }
    };
    let from = std::env::var("FROM_EMAIL")
        .unwrap_or_else(|_| "Wicklee Alerts <alerts@wicklee.dev>".to_string());
    let payload = serde_json::json!({
        "from": from, "to": [to], "subject": subject, "text": text, "html": html,
    });
    match ureq::post("https://api.resend.com/emails")
        .set("Authorization", &format!("Bearer {api_key}"))
        .set("Content-Type", "application/json")
        .send_string(&payload.to_string())
    {
        Ok(_)  => true,
        Err(e) => { eprintln!("[email] Resend delivery failed: {e}"); false }
    }
}

fn slack_alert_blocks(node_id: &str, event_type: &str, detail: &str, resolved: bool) -> String {
    let (icon, color_word) = if resolved {
        ("\u{2705}", "Recovered")
    } else {
        match event_type {
            "thermal_critical"      => ("\u{1F525}", "Critical"),
            "thermal_serious"       => ("\u{26A0}\u{FE0F}",  "Warning"),
            "thermal_drain"         => ("\u{1F321}\u{FE0F}",  "Thermal Drain"),
            "memory_pressure_high"  => ("\u{1F4BE}", "Warning"),
            "memory_trajectory"     => ("\u{1F4C8}", "Memory Trajectory"),
            "wes_drop"              => ("\u{1F4C9}", "Warning"),
            "wes_velocity_drop"     => ("\u{1F4C9}", "WES Declining"),
            "phantom_load"          => ("\u{26A1}", "Phantom Load"),
            "node_offline"          => ("\u{1F534}", "Offline"),
            _                       => ("\u{26A1}", "Alert"),
        }
    };
    let title = if resolved {
        format!("{icon} {node_id} \u{2014} Recovered ({event_type})")
    } else {
        format!("{icon} {node_id} \u{2014} {color_word}")
    };
    serde_json::json!([
        { "type": "header", "text": { "type": "plain_text", "text": title } },
        { "type": "section", "text": { "type": "mrkdwn", "text": detail } },
        { "type": "context", "elements": [{ "type": "mrkdwn", "text": "Wicklee \u{00B7} <https://wicklee.dev|View Dashboard>" }] }
    ]).to_string()
}

fn email_alert_body(node_id: &str, event_type: &str, detail: &str, resolved: bool) -> (String, String) {
    let state_word = if resolved { "RECOVERED" } else { "FIRING" };
    let subject_prefix = if resolved { "\u{2705} Recovered" } else { "\u{26A0}\u{FE0F} Alert" };
    let text = format!("{subject_prefix}: {node_id} \u{2014} {event_type}\n\n{detail}\n\nView dashboard: https://wicklee.dev");
    let html = format!(
        r#"<html><body style="font-family:monospace;background:#030712;color:#e5e7eb;padding:24px">
<h2 style="color:{color}">{state_word}: {node_id}</h2>
<p style="color:#9ca3af;font-size:12px;text-transform:uppercase">{event_type}</p>
<pre style="background:#111827;padding:16px;border-radius:8px;color:#d1d5db">{detail}</pre>
<p><a href="https://wicklee.dev" style="color:#6366f1">View Dashboard →</a></p>
</body></html>"#,
        color = if resolved { "#4ade80" } else { "#fb923c" },
    );
    (text, html)
}

// ── Alerting — core evaluation (async) ──────────────────────────────────────

async fn evaluate_alerts(
    user_id:  &str,
    node_id:  &str,
    metrics:  &MetricsPayload,
    pool:     &sqlx::PgPool,
) {
    // Load enabled rules for this user + node.
    let rules: Vec<(String, String, Option<f64>, String, String, String)> = sqlx::query_as(
        "SELECT ar.id, ar.event_type, ar.threshold_value, ar.urgency,
                nc.channel_type, nc.config_json::text
         FROM   alert_rules ar
         JOIN   notification_channels nc ON nc.id = ar.channel_id
         WHERE  ar.user_id  = $1
           AND  ar.enabled  = 1
           AND  (ar.node_id IS NULL OR ar.node_id = $2)"
    ).bind(user_id).bind(node_id)
    .fetch_all(pool).await.unwrap_or_default();

    let now = now_ms();

    for (rule_id, event_type, threshold_value_opt, urgency, channel_type, config_json) in &rules {
        let threshold_value = threshold_value_opt.unwrap_or(0.0);

        let firing = match event_type.as_str() {
            "thermal_serious"  => matches!(metrics.thermal_state.as_deref(), Some("Serious") | Some("Critical")),
            "thermal_critical" => matches!(metrics.thermal_state.as_deref(), Some("Critical")),
            "memory_pressure_high" => {
                let threshold = if threshold_value > 0.0 { threshold_value as f32 } else { 85.0 };
                metrics.memory_pressure_percent.map(|p| p > threshold).unwrap_or(false)
            }
            "wes_drop" => {
                let threshold = if threshold_value > 0.0 { threshold_value as f32 } else { 5.0 };
                wes_for_payload(metrics).map(|w| w < threshold).unwrap_or(false)
            }
            "thermal_drain" => {
                let threshold = if threshold_value > 0.0 { threshold_value as f32 } else { 6.0 };
                let is_throttled = matches!(metrics.thermal_state.as_deref(), Some("Fair") | Some("Serious") | Some("Critical"));
                is_throttled && wes_for_payload(metrics).map(|w| w < threshold).unwrap_or(false)
            }
            "phantom_load" => {
                let watts_threshold = if threshold_value > 0.0 { threshold_value as f32 } else { 15.0 };
                let watts = metrics.nvidia_power_draw_w.or(metrics.cpu_power_w).unwrap_or(0.0);
                let tok_s = if metrics.vllm_running { metrics.vllm_tokens_per_sec } else { metrics.ollama_tokens_per_second };
                let model_loaded = metrics.nvidia_vram_used_mb.map(|v| v >= 1024).unwrap_or(false) || metrics.ollama_active_model.is_some();
                watts > watts_threshold && model_loaded && tok_s.map(|t| t < 0.5).unwrap_or(true)
            }
            "wes_velocity_drop" => {
                let threshold = if threshold_value > 0.0 { threshold_value as f32 } else { 7.0 };
                let not_thermal = !matches!(metrics.thermal_state.as_deref(), Some("Serious") | Some("Critical"));
                not_thermal && wes_for_payload(metrics).map(|w| w < threshold).unwrap_or(false)
            }
            "memory_trajectory" => {
                let lo_threshold = if threshold_value > 0.0 { threshold_value as f32 } else { 65.0 };
                metrics.memory_pressure_percent.map(|p| p >= lo_threshold && p < 80.0).unwrap_or(false)
            }
            "ttft_regression" => {
                let threshold = if threshold_value > 0.0 { threshold_value as f32 } else { 500.0 };
                let ttft = metrics.vllm_avg_ttft_ms.or(metrics.ollama_proxy_avg_ttft_ms).or(metrics.ollama_ttft_ms);
                let is_active = matches!(metrics.inference_state.as_deref(), Some("live") | Some("idle-spd"));
                is_active && ttft.map(|t| t > threshold).unwrap_or(false)
            }
            "throughput_low" => {
                let threshold = if threshold_value > 0.0 { threshold_value as f32 } else { 5.0 };
                let tok_s = if metrics.vllm_running { metrics.vllm_tokens_per_sec } else { metrics.ollama_tokens_per_second };
                let is_live = matches!(metrics.inference_state.as_deref(), Some("live"));
                is_live && tok_s.map(|t| t < threshold).unwrap_or(false)
            }
            _ => continue,
        };

        let open_event: Option<(String, Option<i64>)> = sqlx::query_as(
            "SELECT id, quiet_until_ms FROM alert_events
             WHERE rule_id = $1 AND node_id = $2 AND resolved_at IS NULL
             ORDER BY triggered_at DESC LIMIT 1"
        ).bind(rule_id).bind(node_id).fetch_optional(pool).await.ok().flatten();

        let debounce_ms: u64 = match urgency.as_str() {
            "debounce_5m"  => 5 * 60_000,
            "debounce_15m" => 15 * 60_000,
            _              => 0,
        };

        if firing {
            if let Some((_, Some(quiet_until))) = &open_event {
                if now < *quiet_until as u64 { continue; }
            }
            if open_event.is_some() { continue; }

            if debounce_ms > 0 {
                let last_resolved_at: Option<i64> = sqlx::query_scalar(
                    "SELECT MAX(resolved_at) FROM alert_events
                     WHERE rule_id = $1 AND node_id = $2 AND resolved_at IS NOT NULL"
                ).bind(rule_id).bind(node_id).fetch_one(pool).await.ok().flatten();
                if let Some(last_res) = last_resolved_at {
                    if now < (last_res as u64).saturating_add(debounce_ms) { continue; }
                }
            }

            let detail = match event_type.as_str() {
                "thermal_serious" | "thermal_critical" => format!(
                    "Thermal state: *{}*\nWES: {:.1} \u{00B7} Watts: {:.1}W",
                    metrics.thermal_state.as_deref().unwrap_or("\u{2014}"),
                    wes_for_payload(metrics).unwrap_or(0.0),
                    metrics.nvidia_power_draw_w.or(metrics.cpu_power_w).unwrap_or(0.0),
                ),
                "memory_pressure_high" => format!(
                    "Memory pressure: *{:.0}%*  (threshold: {:.0}%)\n{:.1} GB used / {:.1} GB total",
                    metrics.memory_pressure_percent.unwrap_or(0.0),
                    if threshold_value > 0.0 { threshold_value } else { 85.0 },
                    metrics.used_memory_mb as f64 / 1024.0,
                    metrics.total_memory_mb as f64 / 1024.0,
                ),
                "wes_drop" => format!(
                    "WES: *{:.1}*  (threshold: {:.1})\nTok/s: {:.1}  Watts: {:.1}W  Thermal: {}",
                    wes_for_payload(metrics).unwrap_or(0.0),
                    if threshold_value > 0.0 { threshold_value } else { 5.0 },
                    metrics.ollama_tokens_per_second.or(metrics.vllm_tokens_per_sec).unwrap_or(0.0),
                    metrics.nvidia_power_draw_w.or(metrics.cpu_power_w).unwrap_or(0.0),
                    metrics.thermal_state.as_deref().unwrap_or("\u{2014}"),
                ),
                "thermal_drain" => {
                    let penalty = thermal_penalty_for(metrics.thermal_state.as_deref());
                    format!(
                        "Thermal: *{}*  (penalty \u{00D7}{:.2})\nWES: {:.1}  Tok/s: {:.1}  Watts: {:.1}W\nRoute requests away to preserve throughput.",
                        metrics.thermal_state.as_deref().unwrap_or("\u{2014}"), penalty,
                        wes_for_payload(metrics).unwrap_or(0.0),
                        metrics.ollama_tokens_per_second.or(metrics.vllm_tokens_per_sec).unwrap_or(0.0),
                        metrics.nvidia_power_draw_w.or(metrics.cpu_power_w).unwrap_or(0.0),
                    )
                }
                "phantom_load" => {
                    let watts = metrics.nvidia_power_draw_w.or(metrics.cpu_power_w).unwrap_or(0.0);
                    let vram  = metrics.nvidia_vram_used_mb.unwrap_or(0);
                    let model = metrics.ollama_active_model.as_deref().unwrap_or("unknown");
                    format!("Drawing *{:.0}W* with {:.1} GB VRAM allocated \u{2014} no inference activity.\nModel: {}  |  Tok/s: 0\nUnload the idle model to reclaim VRAM and reduce power draw.",
                        watts, vram as f64 / 1024.0, model)
                }
                "wes_velocity_drop" => format!(
                    "WES: *{:.1}*  (early-warning threshold: {:.1})\nTok/s: {:.1}  Watts: {:.1}W  Thermal: {}\nEfficiency is declining \u{2014} check for thermal buildup or competing processes.",
                    wes_for_payload(metrics).unwrap_or(0.0),
                    if threshold_value > 0.0 { threshold_value } else { 7.0 },
                    metrics.ollama_tokens_per_second.or(metrics.vllm_tokens_per_sec).unwrap_or(0.0),
                    metrics.nvidia_power_draw_w.or(metrics.cpu_power_w).unwrap_or(0.0),
                    metrics.thermal_state.as_deref().unwrap_or("Normal"),
                ),
                "memory_trajectory" => format!(
                    "Memory pressure: *{:.0}%*  (warning threshold: {:.0}%  |  critical: 85%)\n{:.1} GB used / {:.1} GB total\nPressure is rising \u{2014} unload models or stop background processes now.",
                    metrics.memory_pressure_percent.unwrap_or(0.0),
                    if threshold_value > 0.0 { threshold_value } else { 65.0 },
                    metrics.used_memory_mb as f64 / 1024.0,
                    metrics.total_memory_mb as f64 / 1024.0,
                ),
                _ => String::new(),
            };

            let fired = tokio::task::spawn_blocking({
                let ct = channel_type.clone();
                let cj = config_json.clone();
                let ni = node_id.to_owned();
                let et = event_type.clone();
                let dt = detail.clone();
                move || deliver_alert(&ct, &cj, &ni, &et, &dt, false)
            }).await.unwrap_or(false);

            if fired {
                let event_id = Uuid::new_v4().to_string();
                let _ = sqlx::query(
                    "INSERT INTO alert_events (id, rule_id, node_id, triggered_at)
                     VALUES ($1, $2, $3, $4)"
                ).bind(&event_id).bind(rule_id).bind(node_id).bind(now as i64)
                .execute(pool).await;
                println!("[alerts] fired {}/{node_id} \u{2192} {}", event_type, channel_type);
            }
        } else {
            if let Some((event_id, _)) = open_event {
                let quiet_until = (now + ALERT_QUIET_PERIOD_MS) as i64;
                let _ = sqlx::query(
                    "UPDATE alert_events SET resolved_at = $1, quiet_until_ms = $2 WHERE id = $3"
                ).bind(now as i64).bind(quiet_until).bind(&event_id)
                .execute(pool).await;

                if urgency == "immediate" || urgency == "debounce_5m" {
                    let ct = channel_type.clone();
                    let cj = config_json.clone();
                    let ni = node_id.to_owned();
                    let et = event_type.clone();
                    tokio::task::spawn_blocking(move || {
                        deliver_alert(&ct, &cj, &ni, &et, "Condition has cleared.", true);
                    });
                }
                println!("[alerts] resolved {}/{node_id}", event_type);
            }
        }
    }
}

fn deliver_alert(channel_type: &str, config_json: &str, node_id: &str, event_type: &str, detail: &str, resolved: bool) -> bool {
    let cfg: serde_json::Value = serde_json::from_str(config_json).unwrap_or_default();
    match channel_type {
        "slack" => {
            let url = match cfg.get("webhook_url").and_then(|v| v.as_str()) {
                Some(u) => u.to_owned(),
                None => { eprintln!("[alerts] slack channel missing webhook_url"); return false; }
            };
            let blocks = slack_alert_blocks(node_id, event_type, detail, resolved);
            send_slack(&url, &blocks)
        }
        "email" => {
            let addr = match cfg.get("address").and_then(|v| v.as_str()) {
                Some(a) => a.to_owned(),
                None => { eprintln!("[alerts] email channel missing address"); return false; }
            };
            let subject_prefix = if resolved { "\u{2705} Recovered" } else { "\u{26A0}\u{FE0F} Alert" };
            let subject = format!("{subject_prefix}: {node_id} \u{2014} {event_type}");
            let (text, html) = email_alert_body(node_id, event_type, detail, resolved);
            send_email(&addr, &subject, &text, &html)
        }
        _ => { eprintln!("[alerts] unknown channel_type: {channel_type}"); false }
    }
}

// ── Node offline alert task ──────────────────────────────────────────────────

async fn node_offline_alert_task(state: AppState) {
    let mut known_offline: HashSet<String> = HashSet::new();

    // Pre-populate known_offline from Postgres so a redeploy doesn't fire
    // "came online" for every node. Any node whose last_seen is already stale
    // at startup is assumed to be offline — matching the steady-state that
    // existed before the restart.
    let offline_threshold_ms = 5 * 60_000_u64;
    {
        let boot_now = now_ms();
        let seed_nodes: Vec<(String, i64)> = sqlx::query_as(
            "SELECT wk_id, last_seen FROM nodes WHERE user_id IS NOT NULL"
        ).fetch_all(&state.pool).await.unwrap_or_default();
        for (nid, last_seen) in seed_nodes {
            if boot_now.saturating_sub(last_seen as u64) >= offline_threshold_ms {
                known_offline.insert(nid);
            }
        }
        if !known_offline.is_empty() {
            println!("[alerts] seeded {} node(s) as offline from DB on startup", known_offline.len());
        }
    }

    let mut interval = tokio::time::interval(Duration::from_secs(60));
    interval.tick().await;
    loop {
        interval.tick().await;
        let now = now_ms();

        let nodes: Vec<(String, String, i64)> = sqlx::query_as(
            "SELECT user_id, wk_id, last_seen FROM nodes WHERE user_id IS NOT NULL"
        ).fetch_all(&state.pool).await.unwrap_or_default();

        let mut went_offline: Vec<(String, String, u64)> = Vec::new();
        let mut came_online:  Vec<(String, String)> = Vec::new();

        for (user_id, node_id, last_seen) in &nodes {
            let elapsed = now.saturating_sub(*last_seen as u64);
            if elapsed >= offline_threshold_ms {
                if !known_offline.contains(node_id) {
                    went_offline.push((user_id.clone(), node_id.clone(), elapsed));
                    known_offline.insert(node_id.clone());
                }
            } else if known_offline.remove(node_id) {
                came_online.push((user_id.clone(), node_id.clone()));
            }
        }

        // Fire alerts for nodes that just went offline.
        for (user_id, node_id, elapsed) in &went_offline {
            let tier: String = sqlx::query_scalar::<_, String>(
                "SELECT subscription_tier FROM users WHERE id = $1"
            ).bind(user_id).fetch_one(&state.pool).await.unwrap_or_else(|_| "community".to_string());
            if !is_team_or_above(&tier) { continue; }

            let rules: Vec<(String, String, String)> = sqlx::query_as(
                "SELECT ar.id, nc.channel_type, nc.config_json::text
                 FROM alert_rules ar
                 JOIN notification_channels nc ON nc.id = ar.channel_id
                 WHERE ar.user_id = $1 AND ar.event_type = 'node_offline' AND ar.enabled = 1
                   AND (ar.node_id IS NULL OR ar.node_id = $2)"
            ).bind(user_id).bind(node_id).fetch_all(&state.pool).await.unwrap_or_default();

            for (rule_id, channel_type, config_json) in rules {
                let open: Option<String> = sqlx::query_scalar(
                    "SELECT id FROM alert_events WHERE rule_id = $1 AND node_id = $2 AND resolved_at IS NULL LIMIT 1"
                ).bind(&rule_id).bind(node_id).fetch_optional(&state.pool).await.ok().flatten();
                if open.is_some() { continue; }

                let minutes = elapsed / 60_000;
                let detail  = format!("Node has not reported telemetry in *{minutes} minutes*.");
                let ct = channel_type.clone();
                let cj = config_json.clone();
                let ni = node_id.clone();
                let fired = tokio::task::spawn_blocking(move || deliver_alert(&ct, &cj, &ni, "node_offline", &detail, false))
                    .await.unwrap_or(false);
                if fired {
                    let event_id = Uuid::new_v4().to_string();
                    let _ = sqlx::query("INSERT INTO alert_events (id, rule_id, node_id, triggered_at) VALUES ($1, $2, $3, $4)")
                        .bind(&event_id).bind(&rule_id).bind(node_id).bind(now as i64)
                        .execute(&state.pool).await;
                    println!("[alerts] node_offline fired for {node_id}");
                }
            }

            // Dedup check before writing event.
            let cutoff = (now as i64) - 3_600_000;
            let already_exists: bool = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM node_events WHERE tenant_id = $1 AND node_id = $2 AND event_type = 'node_offline' AND ts > to_timestamp($3::float8 / 1000.0))"
            ).bind(user_id).bind(node_id).bind(cutoff as f64).fetch_one(&state.pool).await.unwrap_or(false);

            if !already_exists {
                let minutes = elapsed / 60_000;
                let _ = state.events_tx.try_send(EventRow {
                    ts_ms: now as i64, node_id: node_id.clone(), tenant_id: user_id.clone(),
                    level: "error".into(), event_type: Some("node_offline".into()),
                    message: format!("Node offline \u{2014} no telemetry received for {minutes}m"),
                });

                // Write fleet observation.
                let obs_id = Uuid::new_v4().to_string();
                let minutes = elapsed / 60_000;
                let _ = sqlx::query(
                    "INSERT INTO fleet_observations (id, tenant_id, node_id, alert_type, severity, state, title, detail, context_json, fired_at_ms)
                     VALUES ($1, $2, $3, 'node_offline', 'critical', 'open', 'Node Offline', $4, $5, $6)
                     ON CONFLICT DO NOTHING"
                ).bind(&obs_id).bind(user_id).bind(node_id)
                .bind(format!("Node has not reported telemetry in {minutes} minutes."))
                .bind(serde_json::json!({"elapsed_minutes": minutes}))
                .bind(now as i64)
                .execute(&state.pool).await;
            }
        }

        // Resolve alerts for nodes that came back online.
        for (user_id, node_id) in &came_online {
            let tier: String = sqlx::query_scalar::<_, String>(
                "SELECT subscription_tier FROM users WHERE id = $1"
            ).bind(user_id).fetch_one(&state.pool).await.unwrap_or_else(|_| "community".to_string());
            if !is_team_or_above(&tier) { continue; }

            let _ = sqlx::query("UPDATE alert_events SET resolved_at = $1 WHERE node_id = $2 AND resolved_at IS NULL")
                .bind(now as i64).bind(node_id).execute(&state.pool).await;

            let _ = state.events_tx.try_send(EventRow {
                ts_ms: now as i64, node_id: node_id.clone(), tenant_id: user_id.clone(),
                level: "info".into(), event_type: Some("node_online".into()),
                message: "Node back online \u{2014} telemetry resumed".into(),
            });

            let _ = sqlx::query(
                "UPDATE fleet_observations SET state = 'resolved', resolved_at_ms = $1
                 WHERE tenant_id = $2 AND node_id = $3 AND alert_type = 'node_offline' AND state = 'open'"
            ).bind(now as i64).bind(user_id).bind(node_id).execute(&state.pool).await;

            println!("[alerts] node_online \u{2014} resolved alerts for {node_id}");
        }
    }
}

// ── Fleet Alert Evaluator (Essential Four + Agent Version Mismatch) ───────────

struct NodeRingBuffer {
    entries: Vec<(u64, Option<String>, Option<String>, Option<f32>, Option<f32>)>,
    head: usize,
    len: usize,
}

impl NodeRingBuffer {
    fn new(capacity: usize) -> Self {
        Self { entries: vec![(0, None, None, None, None); capacity], head: 0, len: 0 }
    }

    fn push(&mut self, ts_ms: u64, inf_state: Option<String>, thermal: Option<String>, mem_pct: Option<f32>, wes: Option<f32>) {
        self.entries[self.head] = (ts_ms, inf_state, thermal, mem_pct, wes);
        self.head = (self.head + 1) % self.entries.len();
        if self.len < self.entries.len() { self.len += 1; }
    }

    fn consecutive_ticks<F: Fn(&(u64, Option<String>, Option<String>, Option<f32>, Option<f32>)) -> bool>(&self, pred: F) -> usize {
        let mut count = 0;
        for i in 0..self.len {
            let idx = (self.head + self.entries.len() - 1 - i) % self.entries.len();
            if pred(&self.entries[idx]) { count += 1; } else { break; }
        }
        count
    }
}

#[allow(dead_code)]
enum ObsSeverity { Warning, Critical }
impl ObsSeverity {
    fn as_str(&self) -> &'static str {
        match self { Self::Warning => "warning", Self::Critical => "critical" }
    }
}

async fn fleet_alert_evaluator_task(state: AppState) {
    let mut ring_buffers: HashMap<String, NodeRingBuffer> = HashMap::new();
    let mut open_observations: HashMap<(String, String), String> = HashMap::new();
    let mut wes_baselines: HashMap<String, f32> = HashMap::new();
    let mut baseline_refresh_counter: u32 = 0;

    let mut interval = tokio::time::interval(Duration::from_secs(60));
    interval.tick().await;
    tokio::time::sleep(Duration::from_secs(120)).await;

    loop {
        interval.tick().await;
        let now = now_ms();

        // Refresh 24h WES baselines every 10 min.
        baseline_refresh_counter += 1;
        if baseline_refresh_counter >= 10 || wes_baselines.is_empty() {
            baseline_refresh_counter = 0;
            let baselines: Vec<(String, f64)> = sqlx::query_as(
                "SELECT node_id, AVG(wes_penalized)::float8 FROM metrics_raw
                 WHERE ts > NOW() - INTERVAL '24 hours' AND wes_penalized IS NOT NULL
                 GROUP BY node_id"
            ).fetch_all(&state.pool).await.unwrap_or_default();
            wes_baselines.clear();
            for (nid, avg) in baselines {
                wes_baselines.insert(nid, avg as f32);
            }
        }

        // Snapshot current metrics.
        let snapshot: Vec<(String, MetricsPayload)> = {
            let cache = state.metrics.read().unwrap();
            cache.iter()
                .filter_map(|(nid, entry)| {
                    if now.saturating_sub(entry.last_seen_ms) > 300_000 { return None; }
                    entry.metrics.as_ref().map(|m| (nid.clone(), m.clone()))
                })
                .collect()
        };

        struct PendingObs {
            node_id: String, alert_type: String, severity: ObsSeverity,
            title: String, detail: String, context: serde_json::Value,
        }
        let mut to_fire: Vec<PendingObs> = Vec::new();
        let mut to_resolve: Vec<(String, String)> = Vec::new();

        for (node_id, m) in &snapshot {
            let ring = ring_buffers.entry(node_id.clone()).or_insert_with(|| NodeRingBuffer::new(15));
            let mem_pct = m.memory_pressure_percent;
            let wes = {
                let watts = m.nvidia_power_draw_w.or(m.apple_soc_power_w).or(m.cpu_power_w);
                let tok_s = if m.vllm_running { m.vllm_tokens_per_sec } else { m.ollama_tokens_per_second };
                match (tok_s, watts) {
                    (Some(t), Some(w)) if w > 0.0 => Some(t / (w * thermal_penalty_for(m.thermal_state.as_deref()))),
                    _ => None,
                }
            };
            ring.push(now, m.inference_state.clone(), m.thermal_state.clone(), mem_pct, wes);

            // 1. Zombied Engine
            {
                let alert_type = "zombied_engine";
                let busy_ticks = ring.consecutive_ticks(|e| e.1.as_deref() == Some("busy"));
                let is_firing = busy_ticks >= 10;
                let is_open = open_observations.contains_key(&(node_id.clone(), alert_type.into()));
                if is_firing && !is_open {
                    to_fire.push(PendingObs { node_id: node_id.clone(), alert_type: alert_type.into(),
                        severity: ObsSeverity::Critical, title: "Zombied Engine Detected".into(),
                        detail: format!("Inference state has been 'busy' for >{} minutes without completing.", busy_ticks),
                        context: serde_json::json!({"inference_state": "busy", "sustained_minutes": busy_ticks, "active_model": m.ollama_active_model.as_deref().or(m.vllm_model_name.as_deref())}),
                    });
                } else if !is_firing && is_open { to_resolve.push((node_id.clone(), alert_type.into())); }
            }
            // 2. Thermal Redline
            {
                let alert_type = "thermal_redline";
                let critical_ticks = ring.consecutive_ticks(|e| e.2.as_deref() == Some("Critical"));
                let is_firing = critical_ticks >= 2;
                let is_open = open_observations.contains_key(&(node_id.clone(), alert_type.into()));
                if is_firing && !is_open {
                    to_fire.push(PendingObs { node_id: node_id.clone(), alert_type: alert_type.into(),
                        severity: ObsSeverity::Critical, title: "Thermal Redline \u{2014} Critical Temperature".into(),
                        detail: format!("Thermal state has been Critical for >{} minutes.", critical_ticks),
                        context: serde_json::json!({"thermal_state": "Critical", "sustained_minutes": critical_ticks, "gpu_temp_c": m.nvidia_gpu_temp_c}),
                    });
                } else if !is_firing && is_open { to_resolve.push((node_id.clone(), alert_type.into())); }
            }
            // 3. OOM Warning
            {
                let alert_type = "oom_warning";
                let oom_ticks = ring.consecutive_ticks(|e| e.3.map_or(false, |p| p > 95.0));
                let is_firing = oom_ticks >= 1;
                let is_open = open_observations.contains_key(&(node_id.clone(), alert_type.into()));
                if is_firing && !is_open {
                    let pct = mem_pct.unwrap_or(0.0);
                    to_fire.push(PendingObs { node_id: node_id.clone(), alert_type: alert_type.into(),
                        severity: ObsSeverity::Warning, title: "Memory Pressure Critical \u{2014} OOM Risk".into(),
                        detail: format!("Memory pressure at {:.1}%.", pct),
                        context: serde_json::json!({"memory_pressure_pct": pct, "used_memory_mb": m.used_memory_mb, "total_memory_mb": m.total_memory_mb}),
                    });
                } else if !is_firing && is_open { to_resolve.push((node_id.clone(), alert_type.into())); }
            }
            // 4. WES Cliff — only fires during active inference, with a minimum floor
            // to avoid noise from idle-state WES fluctuations.
            {
                let alert_type = "wes_cliff";
                if let (Some(current_wes), Some(&baseline)) = (wes, wes_baselines.get(node_id)) {
                    let is_active = matches!(m.inference_state.as_deref(), Some("live") | Some("idle-spd"));
                    let wes_floor = 3.0_f32; // Don't fire if WES is still in "Good" range
                    let is_firing = is_active && baseline > 0.0 && current_wes < baseline * 0.35 && current_wes < wes_floor;
                    let is_open = open_observations.contains_key(&(node_id.clone(), alert_type.into()));
                    if is_firing && !is_open {
                        to_fire.push(PendingObs { node_id: node_id.clone(), alert_type: alert_type.into(),
                            severity: ObsSeverity::Warning, title: "WES Cliff \u{2014} Efficiency Collapse".into(),
                            detail: format!("WES dropped to {:.1} (24h baseline: {:.1}). Active inference detected — this is not an idle fluctuation.", current_wes, baseline),
                            context: serde_json::json!({"current_wes": current_wes, "baseline_wes_24h": baseline, "thermal_state": m.thermal_state, "inference_state": m.inference_state}),
                        });
                    } else if !is_firing && is_open { to_resolve.push((node_id.clone(), alert_type.into())); }
                }
            }
        }

        // 5. Agent Version Mismatch
        {
            let mut version_counts: HashMap<String, u32> = HashMap::new();
            for (_, m) in &snapshot {
                if let Some(ref v) = m.agent_version { *version_counts.entry(v.clone()).or_insert(0) += 1; }
            }
            let majority_version = version_counts.iter().max_by_key(|(_, c)| *c).map(|(v, _)| v.clone());
            if let Some(ref majority) = majority_version {
                let total_versioned = version_counts.values().sum::<u32>();
                if total_versioned > 1 {
                    for (node_id, m) in &snapshot {
                        let alert_type = "agent_version_mismatch";
                        if let Some(ref node_ver) = m.agent_version {
                            let is_firing = node_ver != majority;
                            let is_open = open_observations.contains_key(&(node_id.clone(), alert_type.into()));
                            if is_firing && !is_open {
                                to_fire.push(PendingObs { node_id: node_id.clone(), alert_type: alert_type.into(),
                                    severity: ObsSeverity::Warning, title: "Agent Version Mismatch".into(),
                                    detail: format!("Running v{} while fleet majority is v{}.", node_ver, majority),
                                    context: serde_json::json!({"node_version": node_ver, "fleet_majority": majority}),
                                });
                            } else if !is_firing && is_open { to_resolve.push((node_id.clone(), alert_type.into())); }
                        }
                    }
                }
            }
        }

        // Write observations.
        if !to_fire.is_empty() || !to_resolve.is_empty() {
            let affected_nodes: HashSet<String> = to_fire.iter().map(|o| o.node_id.clone())
                .chain(to_resolve.iter().map(|(nid, _)| nid.clone())).collect();

            let mut tenant_map: HashMap<String, String> = HashMap::new();
            for nid in &affected_nodes {
                if let Ok(uid) = sqlx::query_scalar::<_, String>(
                    "SELECT user_id FROM nodes WHERE wk_id = $1 AND user_id IS NOT NULL"
                ).bind(nid).fetch_one(&state.pool).await {
                    tenant_map.insert(nid.clone(), uid);
                }
            }

            // Cooldown: skip firing if the same (node, alert_type) was recently
            // resolved or acknowledged. WES cliff gets a longer cooldown (4h) to
            // prevent hourly fire/resolve churn from natural WES fluctuations.
            let default_cooldown_ms: i64 = 3_600_000; // 1 hour
            let wes_cliff_cooldown_ms: i64 = 14_400_000; // 4 hours

            for obs in &to_fire {
                let tenant_id = match tenant_map.get(&obs.node_id) { Some(t) => t.clone(), None => continue };

                // Check cooldown: was this (node, alert_type) recently resolved/acknowledged?
                let cooldown = if obs.alert_type == "wes_cliff" { wes_cliff_cooldown_ms } else { default_cooldown_ms };
                let cooldown_cutoff = (now as i64) - cooldown;
                let recently_settled: bool = sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM fleet_observations
                     WHERE tenant_id = $1 AND node_id = $2 AND alert_type = $3
                       AND state IN ('resolved', 'acknowledged')
                       AND COALESCE(resolved_at_ms, ack_at_ms) > $4"
                ).bind(&tenant_id).bind(&obs.node_id).bind(&obs.alert_type).bind(cooldown_cutoff)
                .fetch_one(&state.pool).await.unwrap_or(0) > 0;

                if recently_settled {
                    let hours = cooldown / 3_600_000;
                    eprintln!("[evaluator] cooldown: skipping {} for {} (settled <{}h ago)", obs.alert_type, obs.node_id, hours);
                    continue;
                }

                let obs_id = Uuid::new_v4().to_string();
                let context_str = serde_json::to_string(&obs.context).unwrap_or_default();

                let _ = sqlx::query(
                    "INSERT INTO fleet_observations (id, tenant_id, node_id, alert_type, severity, state, title, detail, context_json, fired_at_ms)
                     VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8::jsonb, $9)
                     ON CONFLICT DO NOTHING"
                ).bind(&obs_id).bind(&tenant_id).bind(&obs.node_id).bind(&obs.alert_type)
                .bind(obs.severity.as_str()).bind(&obs.title).bind(&obs.detail)
                .bind(&context_str).bind(now as i64)
                .execute(&state.pool).await;

                let _ = state.events_tx.try_send(EventRow {
                    ts_ms: now as i64, node_id: obs.node_id.clone(), tenant_id: tenant_id.clone(),
                    level: if matches!(obs.severity, ObsSeverity::Critical) { "error" } else { "warning" }.into(),
                    event_type: Some(obs.alert_type.clone()), message: obs.title.clone(),
                });

                // Deliver to notification channels.
                let pool2 = state.pool.clone();
                let node_id3 = obs.node_id.clone();
                let alert_type3 = obs.alert_type.clone();
                let detail3 = obs.detail.clone();
                let tenant_id2 = tenant_id.clone();
                tokio::spawn(async move {
                    let tier: String = sqlx::query_scalar::<_, String>(
                        "SELECT subscription_tier FROM users WHERE id = $1"
                    ).bind(&tenant_id2).fetch_one(&pool2).await.unwrap_or_else(|_| "community".to_string());
                    if !is_team_or_above(&tier) { return; }

                    let rules: Vec<(String, String)> = sqlx::query_as(
                        "SELECT nc.channel_type, nc.config_json::text
                         FROM alert_rules ar JOIN notification_channels nc ON nc.id = ar.channel_id
                         WHERE ar.user_id = $1 AND ar.event_type = $2 AND ar.enabled = 1
                           AND (ar.node_id IS NULL OR ar.node_id = $3)"
                    ).bind(&tenant_id2).bind(&alert_type3).bind(&node_id3)
                    .fetch_all(&pool2).await.unwrap_or_default();

                    for (ch_type, config_json) in rules {
                        let ni = node_id3.clone();
                        let at = alert_type3.clone();
                        let dt = detail3.clone();
                        tokio::task::spawn_blocking(move || { deliver_alert(&ch_type, &config_json, &ni, &at, &dt, false); });
                    }
                });

                open_observations.insert((obs.node_id.clone(), obs.alert_type.clone()), obs_id);
                println!("[evaluator] fired {} for {}", obs.alert_type, obs.node_id);
            }

            for (node_id, alert_type) in &to_resolve {
                if let Some(obs_id) = open_observations.remove(&(node_id.clone(), alert_type.clone())) {
                    let _ = sqlx::query(
                        "UPDATE fleet_observations SET state = 'resolved', resolved_at_ms = $1 WHERE id = $2 AND state = 'open'"
                    ).bind(now as i64).bind(&obs_id).execute(&state.pool).await;

                    if let Some(tenant_id) = tenant_map.get(node_id) {
                        let _ = state.events_tx.try_send(EventRow {
                            ts_ms: now as i64, node_id: node_id.clone(), tenant_id: tenant_id.clone(),
                            level: "info".into(), event_type: Some(format!("{alert_type}_resolved")),
                            message: format!("{} condition cleared", alert_type.replace('_', " ")),
                        });
                    }
                    println!("[evaluator] resolved {} for {}", alert_type, node_id);
                }
            }
        }
    }
}

// ── Node naming (Pro+) ───────────────────────────────────────────────────────

#[derive(Deserialize)]
struct UpdateNodeRequest {
    display_name: Option<String>,
    tags: Option<String>,
}

/// PATCH /api/nodes/:node_id — update display name and/or tags (Pro+ only)
async fn handle_update_node(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(node_id): axum::extract::Path<String>,
    Json(body): Json<UpdateNodeRequest>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let tier: String = sqlx::query_scalar::<_, String>(
        "SELECT subscription_tier FROM users WHERE id = $1"
    ).bind(&user_id).fetch_one(&state.pool).await.unwrap_or_else(|_| "community".to_string());
    if !is_pro_or_above(&tier) {
        return (StatusCode::PAYMENT_REQUIRED,
            Json(serde_json::json!({ "error": "Node naming requires Pro tier or above" }))).into_response();
    }

    // Verify the node belongs to this user
    let owns: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM nodes WHERE wk_id = $1 AND user_id = $2"
    ).bind(&node_id).bind(&user_id).fetch_one(&state.pool).await.unwrap_or(0);
    if owns == 0 {
        return (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Node not found" }))).into_response();
    }

    if let Some(ref name) = body.display_name {
        let trimmed = name.trim();
        if trimmed.len() > 64 {
            return (StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "Display name must be 64 characters or fewer" }))).into_response();
        }
        let val = if trimmed.is_empty() { None } else { Some(trimmed.to_string()) };
        let _ = sqlx::query("UPDATE nodes SET display_name = $1 WHERE wk_id = $2")
            .bind(&val).bind(&node_id).execute(&state.pool).await;
    }
    if let Some(ref tags) = body.tags {
        let trimmed = tags.trim();
        let val = if trimmed.is_empty() { None } else { Some(trimmed.to_string()) };
        let _ = sqlx::query("UPDATE nodes SET tags = $1 WHERE wk_id = $2")
            .bind(&val).bind(&node_id).execute(&state.pool).await;
    }

    // Return updated node info
    let row: Option<(String, Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT wk_id, hostname, display_name, tags FROM nodes WHERE wk_id = $1"
    ).bind(&node_id).fetch_optional(&state.pool).await.ok().flatten();

    match row {
        Some((wk_id, hostname, display_name, tags)) => {
            Json(serde_json::json!({
                "node_id": wk_id,
                "hostname": hostname,
                "display_name": display_name,
                "tags": tags,
            })).into_response()
        }
        None => (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Node not found" }))).into_response(),
    }
}

// ── Alerting — CRUD handlers ──────────────────────────────────────────────────

/// POST /api/alerts/channels
async fn handle_create_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateChannelRequest>,
) -> impl IntoResponse {
    if !matches!(body.channel_type.as_str(), "slack" | "email") {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "channel_type must be 'slack' or 'email'" }))).into_response();
    }
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let tier: String = sqlx::query_scalar::<_, String>(
        "SELECT subscription_tier FROM users WHERE id = $1"
    ).bind(&user_id).fetch_one(&state.pool).await.unwrap_or_else(|_| "community".to_string());
    if !is_pro_or_above(&tier) {
        return (StatusCode::PAYMENT_REQUIRED,
            Json(serde_json::json!({ "error": "Alerting requires Pro tier or above" }))).into_response();
    }

    let id = Uuid::new_v4().to_string();
    let ts = now_ms() as i64;
    let result = sqlx::query(
        "INSERT INTO notification_channels (id, user_id, channel_type, name, config_json, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)"
    ).bind(&id).bind(&user_id).bind(&body.channel_type).bind(&body.name).bind(&body.config_json).bind(ts)
    .execute(&state.pool).await;

    match result {
        Ok(_) => (StatusCode::CREATED, Json(AlertChannel {
            id, channel_type: body.channel_type, name: body.name,
            config_json: body.config_json, verified: false, created_at: ts,
        })).into_response(),
        Err(e) => { eprintln!("[alerts] channel insert failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" }))).into_response() },
    }
}

/// GET /api/alerts/channels
async fn handle_list_channels(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let rows: Vec<(String, String, String, String, i32, i64)> = sqlx::query_as(
        "SELECT id, channel_type, name, config_json::text, verified, created_at
         FROM notification_channels WHERE user_id = $1 ORDER BY created_at DESC"
    ).bind(&user_id).fetch_all(&state.pool).await.unwrap_or_default();

    let channels: Vec<AlertChannel> = rows.into_iter().map(|(id, ct, name, cj, v, ca)| {
        AlertChannel { id, channel_type: ct, name, config_json: cj, verified: v != 0, created_at: ca }
    }).collect();

    Json(serde_json::json!({ "channels": channels })).into_response()
}

/// DELETE /api/alerts/channels/:id
async fn handle_delete_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(channel_id): Path<String>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let result = sqlx::query("DELETE FROM notification_channels WHERE id = $1 AND user_id = $2")
        .bind(&channel_id).bind(&user_id).execute(&state.pool).await;

    match result {
        Ok(r) if r.rows_affected() > 0 => Json(serde_json::json!({ "ok": true })).into_response(),
        Ok(_) => (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "Channel not found" }))).into_response(),
        Err(e) => { eprintln!("[alerts] channel delete failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Internal server error" }))).into_response() },
    }
}

/// POST /api/alerts/rules
async fn handle_create_rule(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateRuleRequest>,
) -> impl IntoResponse {
    const VALID_TYPES: &[&str] = &[
        "thermal_serious", "thermal_critical", "memory_pressure_high", "wes_drop", "node_offline",
        "ttft_regression", "throughput_low",
    ];
    if !VALID_TYPES.contains(&body.event_type.as_str()) {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "invalid event_type" }))).into_response();
    }
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let tier: String = sqlx::query_scalar::<_, String>(
        "SELECT subscription_tier FROM users WHERE id = $1"
    ).bind(&user_id).fetch_one(&state.pool).await.unwrap_or_else(|_| "community".to_string());
    if !is_pro_or_above(&tier) {
        return (StatusCode::PAYMENT_REQUIRED,
            Json(serde_json::json!({ "error": "Alerting requires Pro tier or above" }))).into_response();
    }

    // Verify channel belongs to user.
    let channel_owner: Option<String> = sqlx::query_scalar(
        "SELECT user_id FROM notification_channels WHERE id = $1"
    ).bind(&body.channel_id).fetch_optional(&state.pool).await.ok().flatten();
    if channel_owner.as_deref() != Some(&user_id) {
        return (StatusCode::PAYMENT_REQUIRED,
            Json(serde_json::json!({ "error": "Alerting requires Team tier or channel not found" }))).into_response();
    }

    let id      = Uuid::new_v4().to_string();
    let urgency = body.urgency.as_deref().unwrap_or("immediate").to_string();
    let ts      = now_ms() as i64;

    let result = sqlx::query(
        "INSERT INTO alert_rules (id, user_id, node_id, event_type, threshold_value, urgency, channel_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)"
    ).bind(&id).bind(&user_id).bind(&body.node_id).bind(&body.event_type)
    .bind(body.threshold_value).bind(&urgency).bind(&body.channel_id).bind(ts)
    .execute(&state.pool).await;

    match result {
        Ok(_) => (StatusCode::CREATED, Json(AlertRule {
            id, node_id: body.node_id, event_type: body.event_type,
            threshold_value: body.threshold_value, urgency, channel_id: body.channel_id,
            enabled: true, created_at: ts,
        })).into_response(),
        Err(e) => { eprintln!("[alerts] rule insert failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" }))).into_response() },
    }
}

/// GET /api/alerts/rules
async fn handle_list_rules(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let rows: Vec<(String, Option<String>, String, Option<f64>, String, String, i32, i64)> = sqlx::query_as(
        "SELECT id, node_id, event_type, threshold_value, urgency, channel_id, enabled, created_at
         FROM alert_rules WHERE user_id = $1 ORDER BY created_at DESC"
    ).bind(&user_id).fetch_all(&state.pool).await.unwrap_or_default();

    let rules: Vec<AlertRule> = rows.into_iter().map(|(id, nid, et, tv, u, cid, en, ca)| {
        AlertRule { id, node_id: nid, event_type: et, threshold_value: tv, urgency: u,
            channel_id: cid, enabled: en != 0, created_at: ca }
    }).collect();

    Json(serde_json::json!({ "rules": rules })).into_response()
}

/// DELETE /api/alerts/rules/:id
async fn handle_delete_rule(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(rule_id): Path<String>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let result = sqlx::query("DELETE FROM alert_rules WHERE id = $1 AND user_id = $2")
        .bind(&rule_id).bind(&user_id).execute(&state.pool).await;

    match result {
        Ok(r) if r.rows_affected() > 0 => Json(serde_json::json!({ "ok": true })).into_response(),
        Ok(_) => (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "Rule not found" }))).into_response(),
        Err(e) => { eprintln!("[alerts] rule delete failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Internal server error" }))).into_response() },
    }
}

/// POST /api/alerts/channels/:id/test
async fn handle_test_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(channel_id): Path<String>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session or channel not found" }))).into_response(),
    };

    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT channel_type, config_json::text FROM notification_channels WHERE id = $1 AND user_id = $2"
    ).bind(&channel_id).bind(&user_id).fetch_optional(&state.pool).await.ok().flatten();

    match row {
        None => (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session or channel not found" }))).into_response(),
        Some((ct, cfg)) => {
            let ok = tokio::task::spawn_blocking(move || {
                deliver_alert(&ct, &cfg, "WK-TEST", "test",
                    "This is a test notification from Wicklee. Your alert channel is working correctly.", false)
            }).await.unwrap_or(false);
            if ok {
                Json(serde_json::json!({ "ok": true, "message": "Test notification sent" })).into_response()
            } else {
                (StatusCode::BAD_GATEWAY,
                    Json(serde_json::json!({ "error": "Delivery failed \u{2014} check webhook URL or email address" }))).into_response()
            }
        }
    }
}

// ── Billing handlers ──────────────────────────────────────────────────────────

/// GET /api/billing/config — returns Paddle client-side config for Paddle.js overlay
async fn handle_billing_config(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid session" }))).into_response(),
    };

    let email: Option<String> = sqlx::query_scalar(
        "SELECT email FROM users WHERE id = $1"
    ).bind(&user_id).fetch_optional(&state.pool).await.ok().flatten();

    let paddle_env = std::env::var("PADDLE_ENV").unwrap_or_else(|_| "sandbox".to_string());
    let pro_price_id = std::env::var("PADDLE_PRO_PRICE_ID").unwrap_or_else(|_| "pri_placeholder_pro".to_string());
    let team_price_id = std::env::var("PADDLE_TEAM_PRICE_ID").unwrap_or_else(|_| "pri_placeholder_team".to_string());

    Json(serde_json::json!({
        "environment": paddle_env,
        "prices": { "pro": pro_price_id, "team": team_price_id },
        "custom_data": { "user_id": user_id },
        "customer_email": email,
    })).into_response()
}

/// POST /api/webhooks/paddle — handles Paddle subscription lifecycle events.
/// Signature verification uses HMAC-SHA256 with PADDLE_WEBHOOK_SECRET.
async fn handle_paddle_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    if let Ok(secret) = std::env::var("PADDLE_WEBHOOK_SECRET") {
        let sig_header = headers.get("paddle-signature")
            .and_then(|v| v.to_str().ok()).unwrap_or("");
        let ts = sig_header.split(';').find(|p| p.starts_with("ts="))
            .and_then(|p| p.strip_prefix("ts=")).unwrap_or("");
        let expected = sig_header.split(';').find(|p| p.starts_with("h1="))
            .and_then(|p| p.strip_prefix("h1=")).unwrap_or("");
        let payload = format!("{}:{}", ts, String::from_utf8_lossy(&body));
        use hmac::{Hmac, Mac};
        type HmacSha256 = Hmac<sha2::Sha256>;
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC key");
        mac.update(payload.as_bytes());
        let computed = hex::encode(mac.finalize().into_bytes());
        let sig_ok: bool = subtle::ConstantTimeEq::ct_eq(computed.as_bytes(), expected.as_bytes()).into();
        if !sig_ok {
            return (StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "Invalid signature" }))).into_response();
        }
    } else {
        eprintln!("[billing] PADDLE_WEBHOOK_SECRET not set \u{2014} rejecting webhook");
        return (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Webhook verification not configured" }))).into_response();
    }

    let event: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => { eprintln!("[billing] webhook JSON parse failed: {e}");
            return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Invalid request body" }))).into_response() },
    };

    let event_type = event["event_type"].as_str().unwrap_or("");
    let data = &event["data"];
    match event_type {
        "subscription.activated" | "subscription.updated" => {
            let customer_id     = data["customer_id"].as_str().unwrap_or("").to_string();
            let subscription_id = data["id"].as_str().unwrap_or("").to_string();
            let user_id = data["custom_data"]["user_id"].as_str().unwrap_or("").to_string();

            // Determine tier from price — check items[0].price.id
            let price_id = data["items"].as_array()
                .and_then(|items| items.first())
                .and_then(|item| item["price"]["id"].as_str())
                .unwrap_or("");
            let pro_price = std::env::var("PADDLE_PRO_PRICE_ID").unwrap_or_default();
            let team_price = std::env::var("PADDLE_TEAM_PRICE_ID").unwrap_or_default();
            let tier = if price_id == team_price { "team" }
                       else if price_id == pro_price { "pro" }
                       else { "pro" };

            let status = data["status"].as_str().unwrap_or("active");
            if status == "active" || status == "trialing" {
                let _ = sqlx::query(
                    "UPDATE users SET subscription_tier = $1, paddle_customer_id = $2, paddle_subscription_id = $3 WHERE id = $4"
                ).bind(tier).bind(&customer_id).bind(&subscription_id).bind(&user_id)
                .execute(&state.pool).await;
                println!("[billing] paddle: {user_id} \u{2192} {tier} (sub={subscription_id})");
            }
        }
        "subscription.canceled" | "subscription.past_due" => {
            let customer_id = data["customer_id"].as_str().unwrap_or("").to_string();
            let _ = sqlx::query(
                "UPDATE users SET subscription_tier = 'community', paddle_subscription_id = NULL WHERE paddle_customer_id = $1"
            ).bind(&customer_id).execute(&state.pool).await;
            println!("[billing] paddle: downgraded customer={customer_id} \u{2192} community");
        }
        _ => {
            println!("[billing] paddle: unhandled event_type={event_type}");
        }
    }

    StatusCode::OK.into_response()
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    // Connect to Postgres. DATABASE_URL must be set.
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL env var must be set (e.g. postgres://user:pass@host/db)");

    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(20)
        .connect(&database_url)
        .await
        .expect("Cannot connect to Postgres");

    println!("  PG  \u{2192} connected");

    run_pg_migrations(&pool).await;

    // One-shot node purge.
    if std::env::var("RESET_NODES").as_deref() == Ok("1") {
        sqlx::query("DELETE FROM nodes").execute(&pool).await.expect("RESET_NODES purge failed");
        println!("  RESET_NODES=1 \u{2014} all nodes purged.");
    }

    // Pre-load known nodes. If last_telemetry_json is available, seed the in-memory cache.
    let seed_metrics: HashMap<String, MetricsEntry> = {
        let rows: Vec<(String, i64, Option<serde_json::Value>)> = sqlx::query_as(
            "SELECT wk_id, last_seen, last_telemetry_json FROM nodes"
        ).fetch_all(&pool).await.unwrap_or_default();
        rows.into_iter()
            .map(|(node_id, last_seen, json_opt)| {
                let metrics = json_opt.and_then(|j| serde_json::from_value::<MetricsPayload>(j).ok());
                (node_id, MetricsEntry { last_seen_ms: last_seen as u64, metrics })
            })
            .collect()
    };

    // Fetch Clerk JWKS on startup.
    let jwks_url = std::env::var("CLERK_JWKS_URL").ok();
    let initial_keys = if let Some(ref url) = jwks_url {
        let url2 = url.clone();
        tokio::task::spawn_blocking(move || fetch_jwks(&url2)).await.unwrap_or_default()
    } else {
        eprintln!("[jwks] CLERK_JWKS_URL not set \u{2014} Clerk JWT auth disabled");
        vec![]
    };
    if !initial_keys.is_empty() {
        println!("  JWKS \u{2192} {} key(s) loaded", initial_keys.len());
    }
    let clerk_keys = Arc::new(RwLock::new(initial_keys));

    let (metrics_tx, metrics_rx) = mpsc::channel::<MetricsRow>(8_192);
    let (events_tx,  events_rx)  = mpsc::channel::<EventRow>(1_024);

    let state = AppState {
        pool:            pool.clone(),
        metrics:         Arc::new(RwLock::new(seed_metrics)),
        clerk_keys:      clerk_keys.clone(),
        api_rate_limits:  Arc::new(Mutex::new(HashMap::new())),
        auth_rate_limits: Arc::new(Mutex::new(HashMap::new())),
        metrics_tx,
        events_tx,
    };

    // Spawn background tasks.
    tokio::spawn(metrics_writer_task(metrics_rx, pool.clone()));
    tokio::spawn(events_writer_task(events_rx, pool.clone()));
    tokio::spawn(rollup_task(pool.clone()));
    tokio::spawn(nightly_task(pool.clone()));
    tokio::spawn(node_offline_alert_task(state.clone()));
    tokio::spawn(fleet_alert_evaluator_task(state.clone()));

    // Refresh JWKS every 6 hours.
    if let Some(url) = jwks_url {
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
                let url2 = url.clone();
                let new_keys = tokio::task::spawn_blocking(move || fetch_jwks(&url2))
                    .await.unwrap_or_default();
                if !new_keys.is_empty() {
                    *clerk_keys.write().unwrap() = new_keys;
                    println!("[jwks] refreshed");
                }
            }
        });
    }

    // Purge expired stream tokens every 5 minutes.
    let pool_cleanup = pool.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(300)).await;
            let now = now_ms() as i64;
            let _ = sqlx::query("DELETE FROM stream_tokens WHERE expires_ms < $1")
                .bind(now).execute(&pool_cleanup).await;
        }
    });

    // Dashboard routes — restrictive CORS (wicklee.dev + localhost dev only).
    let dashboard_routes = Router::new()
        .route("/api/auth/signup",       post(handle_signup))
        .route("/api/auth/login",        post(handle_login))
        .route("/api/auth/me",           get(handle_me))
        .route("/api/auth/stream-token", get(handle_stream_token).delete(handle_revoke_stream_tokens))
        .route("/api/pair/claim",    post(handle_claim))
        .route("/api/pair/activate", post(handle_activate))
        .route("/api/nodes/:node_id",     delete(handle_delete_node))
        .route("/api/fleet",              get(handle_fleet))
        .route("/api/fleet/stream",       get(handle_fleet_stream))
        .route("/api/fleet/wes-history",          get(handle_wes_history))
        .route("/api/fleet/metrics-history",      get(handle_metrics_history))
        .route("/api/fleet/duty",                 get(handle_fleet_duty))
        .route("/api/fleet/events/history",       get(handle_fleet_events_history))
        .route("/api/fleet/export",               get(handle_fleet_export))
        .route("/api/fleet/observations",            get(handle_fleet_observations).post(handle_submit_observation))
        .route("/api/fleet/observations/:id/acknowledge", post(handle_acknowledge_observation))
        .route("/api/fleet/observations/:id/resolve",     post(handle_resolve_observation))
        .route("/api/alerts/channels",          post(handle_create_channel))
        .route("/api/alerts/channels",          get(handle_list_channels))
        .route("/api/alerts/channels/:id",      delete(handle_delete_channel))
        .route("/api/alerts/channels/:id/test", post(handle_test_channel))
        .route("/api/alerts/rules",             post(handle_create_rule))
        .route("/api/alerts/rules",             get(handle_list_rules))
        .route("/api/alerts/rules/:id",         delete(handle_delete_rule))
        .route("/api/nodes/:node_id",    patch(handle_update_node))
        .route("/api/billing/config",    get(handle_billing_config))
        .route("/api/webhooks/paddle",   post(handle_paddle_webhook))
        .with_state(state.clone())
        .layer(middleware::from_fn(cors_dashboard));

    // Open routes — permissive CORS. V1 API (external consumers), agent telemetry, health.
    let open_routes = Router::new()
        .route("/health",                  get(handle_health))
        .route("/api/agent/version",       get(handle_agent_version))
        .route("/api/telemetry",    post(handle_telemetry))
        .route("/api/v1/keys",           post(handle_v1_create_key))
        .route("/api/v1/keys",           get(handle_v1_list_keys))
        .route("/api/v1/keys/:key_id",   delete(handle_v1_delete_key))
        .route("/api/v1/fleet",          get(handle_v1_fleet))
        .route("/api/v1/fleet/wes",      get(handle_v1_fleet_wes))
        .route("/api/v1/nodes/:id",      get(handle_v1_node))
        .route("/api/v1/route/best",     get(handle_v1_route_best))
        .route("/api/v1/insights/latest", get(handle_v1_insights_latest))
        .with_state(state)
        .layer(middleware::from_fn(cors_open));

    let app = dashboard_routes.merge(open_routes)
        .layer(axum::extract::DefaultBodyLimit::max(2 * 1024 * 1024)); // 2 MB global limit

    let port: u16 = std::env::var("PORT")
        .ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    let addr = format!("0.0.0.0:{port}");

    let listener = tokio::net::TcpListener::bind(&addr).await.expect("Failed to bind");

    println!("  Wicklee Cloud — Phase 5 — Postgres + TimescaleDB listening on {addr}");

    axum::serve(listener, app).await.expect("Server exited unexpectedly");
}
