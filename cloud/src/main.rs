use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, Method, Request, StatusCode},
    middleware::{self, Next},
    response::{sse::{Event, KeepAlive, Sse}, IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use sha2::{Sha256, Digest};
use std::convert::Infallible;
use std::time::Duration;
use tokio_stream::StreamExt as _;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use duckdb::Connection as DuckConn;
use tokio::sync::mpsc;

// ── DB types ──────────────────────────────────────────────────────────────────

/// Shared SQLite connection.  rusqlite::Connection is Send but not Sync, so we
/// wrap it in a Mutex to allow sharing across Axum handlers.
type Db = Arc<Mutex<Connection>>;

/// Shared DuckDB connection for analytics.  All writes are serialised through
/// the metrics_writer_task channel — direct handler access is not needed.
type DuckDb = Arc<Mutex<DuckConn>>;

/// Lock the DuckDB mutex, recovering from a poisoned state.
/// If a prior holder panicked (poisoning the mutex), we still acquire the
/// inner connection — DuckDB is process-safe and the connection remains valid.
/// This prevents a single task panic from cascading to every DuckDB consumer.
fn duck_lock(duck: &DuckDb) -> std::sync::MutexGuard<'_, DuckConn> {
    duck.lock().unwrap_or_else(|poisoned| {
        eprintln!("[duck] WARNING: mutex was poisoned by a prior panic — recovering");
        poisoned.into_inner()
    })
}

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
    /// True when a user request completed within the last 35s (Tier 2 attribution).
    #[serde(default)]
    ollama_inference_active: Option<bool>,
    /// True when the Wicklee transparent proxy is active on :11434.
    #[serde(default)]
    ollama_proxy_active: Option<bool>,
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
    /// Persisted to cloud DuckDB `node_events` for fleet event history.
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

/// In-memory telemetry snapshot (not persisted to DuckDB directly — goes
/// through the metrics_writer_task channel).
#[derive(Clone)]
struct MetricsEntry {
    last_seen_ms: u64,
    metrics:      Option<MetricsPayload>,
}

/// One row of derived telemetry ready for DuckDB ingest.
/// Built from MetricsPayload on every incoming frame; flushed in 30-second batches.
#[derive(Clone)]
struct MetricsRow {
    node_id:          String,
    ts_ms:            i64,
    tenant_id:        String,           // SQLite user_id; set after node lookup
    tok_s:            Option<f32>,
    watts:            Option<f32>,
    wes_raw:          Option<f32>,      // tok_s / watts × 10, no penalty
    wes_penalized:    Option<f32>,      // tok_s / (watts × penalty) × 10
    thermal_cost_pct: Option<f32>,      // Phase 4B — from agent WES v2
    thermal_penalty:  Option<f32>,      // 1.0 / 1.25 / 1.75 / 2.0
    thermal_state:    Option<String>,
    vram_used_mb:     Option<i32>,
    vram_total_mb:    Option<i32>,
    mem_pressure_pct: Option<f32>,
    gpu_pct:          Option<f32>,
    cpu_pct:          Option<f32>,
    inference_state:  Option<String>,    // "live" | "idle-spd" | "busy" | "idle"
    wes_version:      u8,               // incremented when WES formula changes
}

/// A Live Activity event destined for the cloud DuckDB `node_events` table.
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
    /// Persistent store for users, sessions, and node pairing records.
    db:               Db,
    /// In-memory telemetry cache keyed by node_id.
    metrics:          Arc<RwLock<HashMap<String, MetricsEntry>>>,
    /// Cached Clerk public keys for JWT verification.  Refreshed every 6 h.
    clerk_keys:       Arc<RwLock<Vec<JwkKey>>>,
    /// Sliding-window rate-limit timestamps keyed by api_key key_id.
    api_rate_limits:  Arc<Mutex<HashMap<String, Vec<u64>>>>,
    /// Channel to the DuckDB writer task.  try_send drops rows if the writer
    /// falls behind; that's acceptable for telemetry.
    metrics_tx:       mpsc::Sender<MetricsRow>,
    /// Channel to the DuckDB event writer task.  Persists Live Activity events
    /// for the fleet event history endpoint.
    events_tx:        mpsc::Sender<EventRow>,
    /// Shared DuckDB connection for history read queries (wes-history endpoint).
    duck_db:          DuckDb,
}

// ── DB bootstrap ──────────────────────────────────────────────────────────────

fn db_path() -> std::path::PathBuf {
    // Railway: set DB_PATH=/data/wicklee.db via the volume mount env var.
    if let Ok(p) = std::env::var("DB_PATH") {
        return std::path::PathBuf::from(p);
    }
    // Local fallback: ~/.wicklee/cloud.db
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    std::path::PathBuf::from(home).join(".wicklee").join("cloud.db")
}

fn open_db() -> Connection {
    let path = db_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("Cannot create DB directory");
    }
    let conn = Connection::open(&path)
        .unwrap_or_else(|e| panic!("Cannot open SQLite at {}: {e}", path.display()));

    // WAL mode — better concurrent read/write performance.
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .expect("PRAGMA failed");

    run_migrations(&conn);
    println!("  DB  → {}", path.display());
    conn
}

fn run_migrations(conn: &Connection) {
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS users (
            id            TEXT PRIMARY KEY,
            email         TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            full_name     TEXT NOT NULL,
            role          TEXT NOT NULL DEFAULT 'Owner',
            is_pro        INTEGER NOT NULL DEFAULT 0,
            created_at    INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token      TEXT PRIMARY KEY,
            user_id    TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS nodes (
            wk_id         TEXT PRIMARY KEY,
            fleet_url     TEXT NOT NULL,
            session_token TEXT NOT NULL,
            code          TEXT,
            paired_at     INTEGER NOT NULL,
            last_seen     INTEGER NOT NULL
        );

    ").expect("Migration failed");
    // Add code column if upgrading from an older schema — ignored on fresh DBs.
    let _ = conn.execute_batch("ALTER TABLE nodes ADD COLUMN code TEXT;");
    // Add hostname column — stores the machine hostname from telemetry so it
    // survives Railway redeploys even when metrics_map is empty.
    let _ = conn.execute_batch("ALTER TABLE nodes ADD COLUMN hostname TEXT;");
    // Add user_id column — links each node to the account that activated it.
    // Needed for per-user node counting to enforce the free-tier limit correctly.
    let _ = conn.execute_batch("ALTER TABLE nodes ADD COLUMN user_id TEXT;");

    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS stream_tokens (
            token      TEXT PRIMARY KEY,
            user_id    TEXT NOT NULL,
            expires_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_stream_tokens_expires
            ON stream_tokens(expires_ms);
    ").expect("stream_tokens migration failed");

    // Add clerk_id column — links a Clerk identity (sub claim) to an internal user.
    let _ = conn.execute_batch("ALTER TABLE users ADD COLUMN clerk_id TEXT;");
    let _ = conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_users_clerk_id ON users(clerk_id);"
    );

    // Backfill: if only one user exists, assign all orphaned nodes to them.
    // Safe to run on every startup — no-ops when there are zero or multiple users.
    let _ = conn.execute_batch("
        UPDATE nodes
        SET user_id = (SELECT id FROM users LIMIT 1)
        WHERE user_id IS NULL
          AND (SELECT COUNT(*) FROM users) = 1;
    ");

    // Index for per-user node queries.
    let _ = conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_nodes_user_id ON nodes(user_id);"
    );

    // API keys for Agent API v1 (Phase 3B).
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS api_keys (
            key_id       TEXT PRIMARY KEY,
            key_hash     TEXT UNIQUE NOT NULL,
            user_id      TEXT NOT NULL,
            name         TEXT NOT NULL,
            created_at   INTEGER NOT NULL,
            last_used_ms INTEGER,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
    ").expect("api_keys migration failed");

    // ── Phase 4A: Billing tier columns on users ────────────────────────────────
    // subscription_tier: 'community' | 'team' | 'enterprise'
    // Ignored on re-run (ALTER TABLE ADD COLUMN is idempotent via let _ =).
    let _ = conn.execute_batch(
        "ALTER TABLE users ADD COLUMN subscription_tier TEXT NOT NULL DEFAULT 'community';"
    );
    let _ = conn.execute_batch("ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;");
    let _ = conn.execute_batch("ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT;");

    // ── Phase 4A: Alerting tables ──────────────────────────────────────────────

    // notification_channels — where to deliver alerts (Slack webhook URL or email).
    // config_json holds channel-type-specific fields:
    //   slack: { "webhook_url": "https://hooks.slack.com/..." }
    //   email: { "address": "ops@example.com" }
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS notification_channels (
            id           TEXT PRIMARY KEY,
            user_id      TEXT NOT NULL,
            channel_type TEXT NOT NULL CHECK (channel_type IN ('slack', 'email')),
            name         TEXT NOT NULL,
            config_json  TEXT NOT NULL,
            verified     INTEGER NOT NULL DEFAULT 0,
            created_at   INTEGER NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_notif_channels_user
            ON notification_channels(user_id);
    ").expect("notification_channels migration failed");

    // alert_rules — one row per configured alert trigger.
    // node_id NULL means fleet-wide (any node for this user).
    // event_type values: 'thermal_serious' | 'thermal_critical' | 'node_offline' |
    //   'memory_pressure_high' | 'wes_drop' | 'idle_digest' |
    //   'thermal_drain' | 'phantom_load' | 'wes_velocity_drop' | 'memory_trajectory'
    // urgency values: 'immediate' | 'debounce_5m' | 'debounce_15m' | 'digest_daily'
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS alert_rules (
            id              TEXT PRIMARY KEY,
            user_id         TEXT NOT NULL,
            node_id         TEXT,
            event_type      TEXT NOT NULL,
            threshold_value REAL,
            urgency         TEXT NOT NULL DEFAULT 'immediate',
            channel_id      TEXT NOT NULL,
            enabled         INTEGER NOT NULL DEFAULT 1,
            created_at      INTEGER NOT NULL,
            FOREIGN KEY (user_id)    REFERENCES users(id)                 ON DELETE CASCADE,
            FOREIGN KEY (channel_id) REFERENCES notification_channels(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_alert_rules_user    ON alert_rules(user_id);
        CREATE INDEX IF NOT EXISTS idx_alert_rules_channel ON alert_rules(channel_id);
    ").expect("alert_rules migration failed");

    // alert_events — firing history; drives debounce, resolution, and audit trail.
    //
    // State machine per (rule_id, node_id):
    //   resolved_at IS NULL  → alert is currently open (firing)
    //   resolved_at NOT NULL → alert resolved; quiet_until_ms enforces flap suppression
    //
    // quiet_until_ms: set to resolved_at + 300_000 (5 min) on resolution.
    //   The evaluation loop skips re-firing while now_ms < quiet_until_ms.
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS alert_events (
            id                   TEXT PRIMARY KEY,
            rule_id              TEXT NOT NULL,
            node_id              TEXT NOT NULL,
            triggered_at         INTEGER NOT NULL,
            resolved_at          INTEGER,
            quiet_until_ms       INTEGER,
            metrics_snapshot_json TEXT,
            FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_alert_events_rule_node
            ON alert_events(rule_id, node_id);
        CREATE INDEX IF NOT EXISTS idx_alert_events_open
            ON alert_events(resolved_at)
            WHERE resolved_at IS NULL;
    ").expect("alert_events migration failed");
}

// ── Tier constants ────────────────────────────────────────────────────────────

/// Maximum nodes a free-tier account may pair.
const MAX_FREE_NODES: usize = 3;

/// Agent API v1 rate limits (requests per 60-second sliding window).
const API_RATE_COMMUNITY: usize = 60;
const API_RATE_TEAM:      usize = 600;

/// Flap-suppression quiet period after an alert resolves (milliseconds).
/// Prevents a node hovering on a threshold boundary from firing repeatedly.
const ALERT_QUIET_PERIOD_MS: u64 = 300_000; // 5 minutes

/// Returns true if the account has Team or Enterprise tier (alerting unlocked).
fn is_team_or_above(tier: &str) -> bool {
    matches!(tier, "team" | "enterprise")
}

/// Number of nodes available for free on the Community tier.
const FREE_NODE_LIMIT: usize = 3;

/// Returns the set of node_ids that are restricted for this user.
/// For community tier: all nodes beyond the first FREE_NODE_LIMIT (by paired_at ASC).
/// For team/enterprise: empty set (all nodes unrestricted).
#[allow(dead_code)]
fn restricted_node_set(user_id: &str, tier: &str, conn: &rusqlite::Connection) -> std::collections::HashSet<String> {
    if is_team_or_above(tier) {
        return std::collections::HashSet::new();
    }
    let mut stmt = match conn.prepare(
        "SELECT wk_id FROM nodes WHERE user_id = ?1 ORDER BY paired_at ASC"
    ) {
        Ok(s) => s,
        Err(_) => return std::collections::HashSet::new(),
    };
    let all_nodes: Vec<String> = stmt.query_map(params![user_id], |r| r.get(0))
        .ok()
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default();
    all_nodes.into_iter().skip(FREE_NODE_LIMIT).collect()
}

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

    // kid is optional — if absent, try every key in the JWKS.
    let candidates: Vec<&JwkKey> = match &header.kid {
        Some(kid) => {
            let m: Vec<&JwkKey> = keys.iter().filter(|k| &k.kid == kid).collect();
            if m.is_empty() {
                eprintln!("[auth] JWT kid={kid} not found in JWKS ({} keys cached)", keys.len());
                keys.iter().collect() // fall back to all keys
            } else { m }
        }
        None => {
            eprintln!("[auth] JWT has no kid — trying all {} cached keys", keys.len());
            keys.iter().collect()
        }
    };

    let mut val = Validation::new(Algorithm::RS256);
    val.validate_aud = false; // Clerk uses azp, not aud
    val.leeway = 60;          // 60s leeway for clock skew

    for jwk in &candidates {
        match DecodingKey::from_rsa_components(&jwk.n, &jwk.e) {
            Err(e) => { eprintln!("[auth] DecodingKey build failed for kid={}: {e}", jwk.kid); }
            Ok(key) => match decode::<ClerkClaims>(token, &key, &val) {
                Ok(data) => {
                    eprintln!("[auth] JWT valid — sub={}", data.claims.sub);
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
/// - If a user with this clerk_id exists → return their id.
/// - If exactly one user has no clerk_id → link them (solo-dev migration path).
/// - Otherwise → create a new minimal user record.
fn resolve_clerk_user(clerk_sub: &str, conn: &Connection) -> Option<String> {
    // Already linked?
    if let Ok(id) = conn.query_row(
        "SELECT id FROM users WHERE clerk_id = ?1",
        params![clerk_sub],
        |r| r.get::<_, String>(0),
    ) {
        return Some(id);
    }

    // Exactly one unmapped user — link them (handles DIY→Clerk migration).
    let unmapped: i64 = conn.query_row(
        "SELECT COUNT(*) FROM users WHERE clerk_id IS NULL",
        [],
        |r| r.get(0),
    ).unwrap_or(0);

    if unmapped == 1 {
        if let Ok(id) = conn.query_row(
            "SELECT id FROM users WHERE clerk_id IS NULL LIMIT 1",
            [],
            |r| r.get::<_, String>(0),
        ) {
            let _ = conn.execute(
                "UPDATE users SET clerk_id = ?1 WHERE id = ?2",
                params![clerk_sub, id],
            );
            return Some(id);
        }
    }

    // New Clerk user — create a minimal record (Clerk owns the identity data).
    let new_id = Uuid::new_v4().to_string();
    let ts     = now_ms() as i64;
    // Use clerk_sub as email placeholder (unique); password_hash empty (Clerk authenticates).
    conn.execute(
        "INSERT INTO users (id, email, password_hash, full_name, role, is_pro, created_at, clerk_id)
         VALUES (?1, ?2, '', 'Clerk User', 'Owner', 0, ?3, ?2)",
        params![new_id, clerk_sub, ts],
    ).ok()?;
    Some(new_id)
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

/// Validate a Bearer token and return the internal user_id.
/// Tries the legacy sessions table first, then Clerk JWT.
/// Synchronous — call inside spawn_blocking or block_in_place.
fn require_user(token: &str, conn: &Connection, clerk_keys: &[JwkKey]) -> Option<String> {
    // Legacy DIY sessions (backward compat with old tokens).
    if let Ok(id) = conn.query_row(
        "SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?1",
        params![token],
        |r| r.get::<_, String>(0),
    ) {
        return Some(id);
    }

    // Clerk JWT.
    validate_clerk_jwt(token, clerk_keys)
        .and_then(|sub| resolve_clerk_user(&sub, conn))
}

/// Like require_user but also returns email and is_pro for tier checks.
fn require_user_info(
    token: &str,
    conn: &Connection,
    clerk_keys: &[JwkKey],
) -> Option<(String, String, i32)> {
    let user_id = require_user(token, conn, clerk_keys)?;
    conn.query_row(
        "SELECT email, is_pro FROM users WHERE id = ?1",
        params![user_id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i32>(1)?)),
    ).ok().map(|(email, is_pro)| (user_id, email, is_pro))
}

/// Load the set of node IDs belonging to a user.
/// Synchronous — call inside spawn_blocking or block_in_place.
fn user_node_set(user_id: &str, conn: &Connection) -> HashSet<String> {
    conn.prepare("SELECT wk_id FROM nodes WHERE user_id = ?1")
        .ok()
        .map(|mut stmt| {
            stmt.query_map(params![user_id], |r| r.get::<_, String>(0))
                .ok()
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
                .unwrap_or_default()
        })
        .unwrap_or_default()
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
    Some(((tok_s / (watts * penalty)) * 10.0).round() / 10.0)
}

/// Validate a raw API key, enforce rate limits, return (key_id, user_id, is_pro).
/// Call inside spawn_blocking.
fn validate_api_key_sync(
    raw_key: &str,
    conn: &Connection,
    rate_limits: &Arc<Mutex<HashMap<String, Vec<u64>>>>,
) -> Option<(String, String, bool)> {
    let hash = sha256_hex(raw_key);
    let (key_id, user_id, is_pro_int): (String, String, i32) = conn.query_row(
        "SELECT k.key_id, k.user_id, u.is_pro
         FROM api_keys k
         JOIN users u ON u.id = k.user_id
         WHERE k.key_hash = ?1",
        params![hash],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).ok()?;

    let limit = if is_pro_int != 0 { API_RATE_TEAM } else { API_RATE_COMMUNITY };
    let now = now_ms();
    let window_start = now.saturating_sub(60_000);
    {
        let mut rl = rate_limits.lock().unwrap();
        let calls = rl.entry(key_id.clone()).or_default();
        calls.retain(|&t| t >= window_start);
        if calls.len() >= limit {
            return None; // rate limit exceeded
        }
        calls.push(now);
    }

    let _ = conn.execute(
        "UPDATE api_keys SET last_used_ms = ?1 WHERE key_id = ?2",
        params![now as i64, key_id],
    );

    Some((key_id, user_id, is_pro_int != 0))
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
    key:        String,  // raw key — returned once, not stored
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
    let db   = state.db.clone();
    let name = body.name.trim().to_owned();

    let result = tokio::task::spawn_blocking(move || {
        let conn    = db.lock().unwrap();
        let user_id = require_user(&token, &conn, &clerk_keys)?;
        let raw_key = format!("wk_live_{}", Uuid::new_v4().to_string().replace('-', ""));
        let key_hash = sha256_hex(&raw_key);
        let key_id   = Uuid::new_v4().to_string();
        let ts       = now_ms() as i64;

        conn.execute(
            "INSERT INTO api_keys (key_id, key_hash, user_id, name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![key_id, key_hash, user_id, name, ts],
        ).ok()?;

        Some(V1CreateKeyResponse { key_id, key: raw_key, name, created_at: ts })
    }).await.unwrap();

    match result {
        None    => (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
        Some(r) => (StatusCode::CREATED, Json(r)).into_response(),
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
    let db = state.db.clone();

    let result: Option<Vec<V1KeyInfo>> = tokio::task::spawn_blocking(move || {
        let conn    = db.lock().unwrap();
        let user_id = require_user(&token, &conn, &clerk_keys)?;
        let mut stmt = conn.prepare(
            "SELECT key_id, name, created_at, last_used_ms
             FROM api_keys WHERE user_id = ?1 ORDER BY created_at DESC"
        ).ok()?;
        Some(stmt.query_map(params![user_id], |r| Ok(V1KeyInfo {
            key_id:       r.get(0)?,
            name:         r.get(1)?,
            created_at:   r.get(2)?,
            last_used_ms: r.get(3)?,
        })).ok()?.filter_map(|r| r.ok()).collect())
    }).await.unwrap();

    match result {
        None    => (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
        Some(k) => Json(serde_json::json!({ "keys": k })).into_response(),
    }
}

/// DELETE /api/nodes/:node_id
/// Removes a node from the authenticated user's fleet and erases its stored
/// metrics. The node slot is freed immediately — the user can pair a new node
/// without hitting the Community tier limit.
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
    let db = state.db.clone();
    // Keep a copy of node_id for the in-memory eviction step below.
    let node_id_evict = node_id.clone();

    let result: Option<usize> = tokio::task::spawn_blocking(move || {
        let conn    = db.lock().unwrap();
        let user_id = require_user(&token, &conn, &clerk_keys)?;
        // Delete from nodes table — scoped to user so users can only remove their own.
        let n = conn.execute(
            "DELETE FROM nodes WHERE wk_id = ?1 AND user_id = ?2",
            params![node_id, user_id],
        ).unwrap_or(0);
        if n == 0 { return Some(0); }
        // Purge stored metrics so the slot is truly clean.
        let _ = conn.execute(
            "DELETE FROM metrics_raw WHERE node_id = ?1 AND tenant_id = ?2",
            params![node_id, user_id],
        );
        let _ = conn.execute(
            "DELETE FROM metrics_5min WHERE node_id = ?1 AND tenant_id = ?2",
            params![node_id, user_id],
        );
        Some(n)
    }).await.unwrap();

    match result {
        None    => (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
        Some(0) => (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Node not found" }))).into_response(),
        Some(_) => {
            // Evict the node from the in-memory telemetry cache immediately.
            // The SSE fleet stream builds its payload by iterating metrics_map,
            // so without this the deleted node reappears in SSE snapshots for
            // up to ~60 s (the stream's node-set refresh interval).
            state.metrics.write().unwrap().remove(&node_id_evict);
            StatusCode::NO_CONTENT.into_response()
        }
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
    let db = state.db.clone();

    let result: Option<usize> = tokio::task::spawn_blocking(move || {
        let conn    = db.lock().unwrap();
        let user_id = require_user(&token, &conn, &clerk_keys)?;
        let n = conn.execute(
            "DELETE FROM api_keys WHERE key_id = ?1 AND user_id = ?2",
            params![key_id, user_id],
        ).unwrap_or(0);
        Some(n)
    }).await.unwrap();

    match result {
        None    => (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
        Some(0) => (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Key not found" }))).into_response(),
        Some(_) => StatusCode::NO_CONTENT.into_response(),
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

    let db = state.db.clone();
    let rl = state.api_rate_limits.clone();

    let result: Option<Vec<(String, i64)>> = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        let (_key_id, user_id, _is_pro) = validate_api_key_sync(&raw_key, &conn, &rl)?;
        let mut stmt = conn.prepare(
            "SELECT wk_id, last_seen FROM nodes WHERE user_id = ?1 ORDER BY last_seen DESC"
        ).ok()?;
        Some(stmt.query_map(params![user_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .ok()?.filter_map(|r| r.ok()).collect())
    }).await.unwrap();

    let persisted = match result {
        None    => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid API key or rate limit exceeded" }))).into_response(),
        Some(r) => r,
    };

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

    let db = state.db.clone();
    let rl = state.api_rate_limits.clone();

    let result: Option<Vec<String>> = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        let (_key_id, user_id, _is_pro) = validate_api_key_sync(&raw_key, &conn, &rl)?;
        let mut stmt = conn.prepare("SELECT wk_id FROM nodes WHERE user_id = ?1").ok()?;
        Some(stmt.query_map(params![user_id], |r| r.get(0))
            .ok()?.filter_map(|r| r.ok()).collect())
    }).await.unwrap();

    let node_ids = match result {
        None  => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid API key or rate limit exceeded" }))).into_response(),
        Some(ids) => ids,
    };

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

    let db       = state.db.clone();
    let rl       = state.api_rate_limits.clone();
    let nid      = node_id.clone();

    let result: Option<bool> = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        let (_key_id, user_id, _is_pro) = validate_api_key_sync(&raw_key, &conn, &rl)?;
        let owned: bool = conn.query_row(
            "SELECT 1 FROM nodes WHERE wk_id = ?1 AND user_id = ?2",
            params![nid, user_id],
            |_| Ok(true),
        ).unwrap_or(false);
        Some(owned)
    }).await.unwrap();

    match result {
        None        => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid API key or rate limit exceeded" }))).into_response(),
        Some(false) => return (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Node not found" }))).into_response(),
        Some(true)  => {}
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

    let db = state.db.clone();
    let rl = state.api_rate_limits.clone();

    let result: Option<Vec<String>> = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        let (_key_id, user_id, _is_pro) = validate_api_key_sync(&raw_key, &conn, &rl)?;
        let mut stmt = conn.prepare("SELECT wk_id FROM nodes WHERE user_id = ?1").ok()?;
        Some(stmt.query_map(params![user_id], |r| r.get(0))
            .ok()?.filter_map(|r| r.ok()).collect())
    }).await.unwrap();

    let node_ids = match result {
        None      => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid API key or rate limit exceeded" }))).into_response(),
        Some(ids) => ids,
    };

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
//
// Deterministic fleet pattern analysis — no LLM, no randomness.
// Intended for external consumers: automation scripts, MCP servers, CI/CD
// pipelines.  The Wicklee dashboard computes findings client-side via
// patternEngine.ts and does NOT call this endpoint.
//
// Auth: X-API-Key (same as all v1 endpoints).
// Response: InsightsResponse (see types below).

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
    severity: &'static str,   // "high" | "moderate" | "low"
    pattern:  &'static str,   // machine-readable pattern key
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

    let db = state.db.clone();
    let rl = state.api_rate_limits.clone();

    let node_ids: Option<Vec<String>> = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        let (_key_id, user_id, _is_pro) = validate_api_key_sync(&raw_key, &conn, &rl)?;
        let mut stmt = conn.prepare("SELECT wk_id FROM nodes WHERE user_id = ?1").ok()?;
        Some(stmt.query_map(params![user_id], |r| r.get(0))
            .ok()?.filter_map(|r| r.ok()).collect())
    }).await.unwrap();

    let node_ids = match node_ids {
        None      => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid API key or rate limit exceeded" }))).into_response(),
        Some(ids) => ids,
    };

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

    // ── Pattern evaluation ────────────────────────────────────────────────────

    let mut findings: Vec<V1InsightFinding> = Vec::new();

    // Fleet offline — every node unreachable
    if total_count > 0 && online_count == 0 {
        findings.push(V1InsightFinding {
            node_id:  "fleet".into(),
            hostname: None,
            severity: "high",
            pattern:  "fleet_offline",
            title:    "Fleet offline".into(),
            detail:   format!("All {total_count} registered nodes are unreachable (last telemetry > 30s ago)."),
            value:    None,
            unit:     None,
        });
    }

    for snap in &snaps {
        // Node offline (partial outage)
        if !snap.online && total_count > 1 {
            findings.push(V1InsightFinding {
                node_id:  snap.node_id.clone(),
                hostname: snap.hostname.clone(),
                severity: "moderate",
                pattern:  "node_offline",
                title:    format!("{} offline", snap.hostname.as_deref().unwrap_or(&snap.node_id)),
                detail:   "Node has not reported telemetry in the last 30 seconds.".into(),
                value:    None,
                unit:     None,
            });
            continue; // no metric-level findings for offline nodes
        }

        let Some(ref m) = snap.metrics else { continue };

        // Thermal stress
        match m.thermal_state.as_deref() {
            Some("Critical") => findings.push(V1InsightFinding {
                node_id:  snap.node_id.clone(),
                hostname: snap.hostname.clone(),
                severity: "high",
                pattern:  "thermal_stress",
                title:    format!("Critical thermal state on {}", snap.hostname.as_deref().unwrap_or(&snap.node_id)),
                detail:   "Thermal state: Critical — WES penalised 2×. Throughput may be severely throttled.".into(),
                value:    snap.wes,
                unit:     Some("WES"),
            }),
            Some("Serious") => findings.push(V1InsightFinding {
                node_id:  snap.node_id.clone(),
                hostname: snap.hostname.clone(),
                severity: "moderate",
                pattern:  "thermal_stress",
                title:    format!("Thermal stress on {}", snap.hostname.as_deref().unwrap_or(&snap.node_id)),
                detail:   "Thermal state: Serious — WES penalised 1.75×. Consider redistributing load.".into(),
                value:    snap.wes,
                unit:     Some("WES"),
            }),
            _ => {}
        }

        // Memory pressure (Apple Silicon only)
        if let Some(mem_pct) = m.memory_pressure_percent {
            if mem_pct >= 90.0 {
                findings.push(V1InsightFinding {
                    node_id:  snap.node_id.clone(),
                    hostname: snap.hostname.clone(),
                    severity: "high",
                    pattern:  "memory_pressure",
                    title:    format!("High memory pressure on {}", snap.hostname.as_deref().unwrap_or(&snap.node_id)),
                    detail:   format!("Memory pressure: {mem_pct:.0}% — swap thrashing likely. Throughput may degrade."),
                    value:    Some(mem_pct),
                    unit:     Some("%"),
                });
            } else if mem_pct >= 75.0 {
                findings.push(V1InsightFinding {
                    node_id:  snap.node_id.clone(),
                    hostname: snap.hostname.clone(),
                    severity: "moderate",
                    pattern:  "memory_pressure",
                    title:    format!("Elevated memory pressure on {}", snap.hostname.as_deref().unwrap_or(&snap.node_id)),
                    detail:   format!("Memory pressure: {mem_pct:.0}% — monitor for swap activity."),
                    value:    Some(mem_pct),
                    unit:     Some("%"),
                });
            }
        }

        // Low throughput relative to fleet average (only meaningful with ≥2 online nodes)
        if online_count >= 2 {
            if let (Some(node_tok), Some(fleet_avg)) = (snap.tok_s, fleet_tok_s.map(|t| t / online_count as f32)) {
                if fleet_avg > 5.0 && node_tok < fleet_avg * 0.40 {
                    findings.push(V1InsightFinding {
                        node_id:  snap.node_id.clone(),
                        hostname: snap.hostname.clone(),
                        severity: "low",
                        pattern:  "low_throughput",
                        title:    format!("Low throughput on {}", snap.hostname.as_deref().unwrap_or(&snap.node_id)),
                        detail:   format!(
                            "{:.1} tok/s vs fleet average {:.1} tok/s — node is underperforming.",
                            node_tok, fleet_avg
                        ),
                        value:    Some(node_tok),
                        unit:     Some("tok/s"),
                    });
                }
            }
        }

        // WES well below fleet average (only when we have a fleet average to compare)
        if online_count >= 2 {
            if let (Some(node_wes), Some(fleet_avg_wes)) = (snap.wes, avg_wes) {
                if fleet_avg_wes > 1.0 && node_wes < fleet_avg_wes * 0.40 {
                    findings.push(V1InsightFinding {
                        node_id:  snap.node_id.clone(),
                        hostname: snap.hostname.clone(),
                        severity: "low",
                        pattern:  "wes_below_baseline",
                        title:    format!("WES below fleet average on {}", snap.hostname.as_deref().unwrap_or(&snap.node_id)),
                        detail:   format!(
                            "WES {:.1} vs fleet average {:.1} — check thermal state and power headroom.",
                            node_wes, fleet_avg_wes
                        ),
                        value:    Some(node_wes),
                        unit:     Some("WES"),
                    });
                }
            }
        }
    }

    // Sort: high → moderate → low, then alphabetically within severity
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
/// Issues a single-use 60-second token for EventSource connections.
/// EventSource cannot send Authorization headers, so the client fetches this
/// token via a normal authenticated request, then passes it as ?token=<uuid>.
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
    let db = state.db.clone();
    let user_id = match tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        require_user(&token, &conn, &clerk_keys)
    }).await.unwrap() {
        Some(uid) => uid,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let stream_token = Uuid::new_v4().to_string();
    let expires_ms = (now_ms() + 60_000) as i64;
    let db2 = state.db.clone();
    let st2 = stream_token.clone();
    tokio::task::spawn_blocking(move || {
        let conn = db2.lock().unwrap();
        conn.execute(
            "INSERT INTO stream_tokens (token, user_id, expires_ms) VALUES (?1, ?2, ?3)",
            params![st2, user_id, expires_ms],
        ).ok();
    }).await.unwrap();

    (StatusCode::OK, Json(serde_json::json!({ "stream_token": stream_token }))).into_response()
}

/// POST /api/auth/signup
async fn handle_signup(
    State(state): State<AppState>,
    Json(body): Json<SignupRequest>,
) -> impl IntoResponse {
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

    // Hash password off the async executor.
    let password = body.password.clone();
    let password_hash = match tokio::task::spawn_blocking(move || bcrypt::hash(password, 12))
        .await.unwrap()
    {
        Ok(h) => h,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal error" }))).into_response(),
    };

    let id         = Uuid::new_v4().to_string();
    let token      = Uuid::new_v4().to_string();
    let full_name  = body.full_name.trim().to_owned();
    let ts         = now_ms() as i64;
    let db         = state.db.clone();
    let id2        = id.clone();
    let email2     = email.clone();
    let full_name2 = full_name.clone();
    let token2     = token.clone();

    let result = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        // Check for duplicate email.
        let exists: bool = conn.query_row(
            "SELECT 1 FROM users WHERE email = ?1",
            params![email2],
            |_| Ok(true),
        ).unwrap_or(false);
        if exists { return Err("exists"); }

        conn.execute(
            "INSERT INTO users (id, email, password_hash, full_name, role, is_pro, created_at)
             VALUES (?1, ?2, ?3, ?4, 'Owner', 0, ?5)",
            params![id2, email2, password_hash, full_name2, ts],
        ).map_err(|_| "insert_user")?;

        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at) VALUES (?1, ?2, ?3)",
            params![token2, id2, ts],
        ).map_err(|_| "insert_session")?;

        Ok(())
    }).await.unwrap();

    match result {
        Err("exists") => (StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "An account with this email already exists" }))).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal error" }))).into_response(),
        Ok(()) => {
            let is_pro = is_dev_account(&email);
            (StatusCode::CREATED, Json(AuthResponse {
                token,
                user: UserResponse { id, email, full_name, role: "Owner".into(), is_pro },
            })).into_response()
        }
    }
}

/// POST /api/auth/login
async fn handle_login(
    State(state): State<AppState>,
    Json(body): Json<LoginRequest>,
) -> impl IntoResponse {
    let email = body.email.trim().to_lowercase();
    let db    = state.db.clone();
    let email2 = email.clone();

    // Fetch user record from DB.
    let row = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        conn.query_row(
            "SELECT id, email, password_hash, full_name, role, is_pro FROM users WHERE email = ?1",
            params![email2],
            |r| Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i32>(5)?,
            )),
        ).ok()
    }).await.unwrap();

    let (id, stored_email, hash, full_name, role, is_pro_int) = match row {
        Some(r) => r,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid email or password" }))).into_response(),
    };

    // Verify password off-thread.
    let password = body.password.clone();
    let valid = tokio::task::spawn_blocking(move || bcrypt::verify(password, &hash))
        .await.unwrap().unwrap_or(false);

    if !valid {
        return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid email or password" }))).into_response();
    }

    let token = Uuid::new_v4().to_string();
    let ts    = now_ms() as i64;
    let db    = state.db.clone();
    let token2 = token.clone();
    let id2    = id.clone();

    tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at) VALUES (?1, ?2, ?3)",
            params![token2, id2, ts],
        ).ok();
    }).await.unwrap();

    let is_pro = is_pro_int != 0 || is_dev_account(&stored_email);
    (StatusCode::OK, Json(AuthResponse {
        token,
        user: UserResponse { id, email: stored_email, full_name, role, is_pro },
    })).into_response()
}

/// GET /api/auth/me — validates session token from Authorization: Bearer header
async fn handle_me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let db = state.db.clone();
    let row = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        conn.query_row(
            "SELECT u.id, u.email, u.full_name, u.role, u.is_pro
             FROM sessions s
             JOIN users u ON u.id = s.user_id
             WHERE s.token = ?1",
            params![token],
            |r| Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i32>(4)?,
            )),
        ).ok()
    }).await.unwrap();

    match row {
        None => (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
        Some((id, email, full_name, role, is_pro_int)) => {
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

    let token    = mint_node_token(&body.node_id);
    let ts       = now_ms() as i64;
    let db       = state.db.clone();
    let node_id  = body.node_id.clone();
    let fleet_url = body.fleet_url.clone();
    let code     = body.code.clone();
    let token2   = token.clone();
    let node_id2 = node_id.clone();

    tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        conn.execute(
            "INSERT INTO nodes (wk_id, fleet_url, session_token, code, paired_at, last_seen)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(wk_id) DO UPDATE SET
               fleet_url     = excluded.fleet_url,
               session_token = excluded.session_token,
               code          = excluded.code,
               last_seen     = excluded.last_seen",
            params![node_id2, fleet_url, token2, code, ts],
        ).ok();
    }).await.unwrap();

    // Seed the in-memory metrics entry so telemetry can flow immediately.
    state.metrics.write().unwrap()
        .entry(node_id.clone())
        .or_insert(MetricsEntry { last_seen_ms: now_ms(), metrics: None });

    (StatusCode::OK, Json(ClaimResponse { session_token: token, node_id })).into_response()
}

/// POST /api/telemetry
async fn handle_telemetry(
    State(state): State<AppState>,
    Json(payload): Json<MetricsPayload>,
) -> StatusCode {
    let node_id       = payload.node_id.clone();
    let node_hostname = payload.hostname.clone();
    let ts            = now_ms();

    // Derive the DuckDB row BEFORE moving payload into the in-memory map.
    let duck_row = metrics_row_from_payload(&payload, ts);

    // Extract Live Activity events before payload is moved into the map.
    let live_activities = payload.live_activities.clone();

    // Clone for alert evaluation (payload is moved into the map below).
    let metrics_snap: Option<MetricsPayload> = Some(payload.clone());

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

    // Persist last_seen (and hostname when present) to nodes table,
    // then look up tenant_id and enqueue the DuckDB row.
    let db         = state.db.clone();
    let metrics_tx = state.metrics_tx.clone();
    let events_tx  = state.events_tx.clone();
    let nid        = node_id.clone();
    tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        if let Some(ref h) = node_hostname {
            conn.execute(
                "UPDATE nodes SET last_seen = ?1, hostname = ?2 WHERE wk_id = ?3",
                params![ts as i64, h, nid],
            ).ok();
        } else {
            conn.execute(
                "UPDATE nodes SET last_seen = ?1 WHERE wk_id = ?2",
                params![ts as i64, nid],
            ).ok();
        }

        // Resolve tenant_id (= user_id) and enqueue for DuckDB ingest.
        // Nodes that haven't been activated yet have NULL user_id — skip those.
        if let Ok(tenant_id) = conn.query_row(
            "SELECT user_id FROM nodes WHERE wk_id = ?1 AND user_id IS NOT NULL",
            params![nid],
            |r| r.get::<_, String>(0),
        ) {
            let row = MetricsRow { tenant_id: tenant_id.clone(), ..duck_row };
            if let Err(e) = metrics_tx.try_send(row) {
                eprintln!("[telemetry] metrics_tx send failed for {nid}: {e} — DuckDB pipeline may be broken");
            }

            // Persist any Live Activity events to DuckDB.
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
            let tier: String = conn.query_row(
                "SELECT subscription_tier FROM users WHERE id = ?1",
                params![tenant_id],
                |r| r.get(0),
            ).unwrap_or_else(|_| "community".to_string());
            if is_team_or_above(&tier) {
                // Borrow the payload from the in-memory map for rule evaluation.
                // We already moved `payload` into the map above, so re-fetch it.
                if let Some(ref metrics_snapshot) = metrics_snap {
                    evaluate_alerts(&tenant_id, &nid, metrics_snapshot, &conn);
                }
            }
        }
    }).await.ok();

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
    let db = state.db.clone();
    let result: Option<(String, Vec<(String, String, i64)>)> = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        let user_id = require_user(&token, &conn, &clerk_keys)?;
        let tier: String = conn.query_row(
            "SELECT subscription_tier FROM users WHERE id = ?1",
            params![user_id],
            |r| r.get(0),
        ).unwrap_or_else(|_| "community".to_string());
        let mut stmt = conn.prepare(
            "SELECT wk_id, fleet_url, paired_at FROM nodes WHERE user_id = ?1 ORDER BY paired_at ASC"
        ).ok()?;
        let rows = stmt.query_map(params![user_id], |r| Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
        )))
        .ok()?
        .filter_map(|r| r.ok())
        .collect();
        Some((tier, rows))
    }).await.unwrap();

    let (tier, persisted) = match result {
        Some(r) => r,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let restricted: std::collections::HashSet<String> = persisted.iter()
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

/// GET /api/fleet/events/history?limit=50&before=<ts_ms>&node_id=<optional>&event_type=<optional>
///
/// Returns persisted Live Activity events for the authenticated user's fleet.
/// Paginated via `before` (exclusive upper bound on ts_ms).  Max 200 per page.
async fn handle_fleet_events_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    // Authenticate via Clerk JWT → user_id (same pattern as handle_wes_history).
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let db = state.db.clone();
    let user_id: Option<String> = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        require_user(&token, &conn, &clerk_keys)
    }).await.unwrap();

    let user_id = match user_id {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let limit: i64 = params.get("limit")
        .and_then(|v| v.parse().ok())
        .unwrap_or(50)
        .min(200);
    let before: i64 = params.get("before")
        .and_then(|v| v.parse().ok())
        .unwrap_or(i64::MAX);
    let node_id_filter = params.get("node_id").cloned();
    let event_type_filter = params.get("event_type").cloned();

    let duck = state.duck_db.clone();
    match tokio::task::spawn_blocking(move || {
        let conn = duck_lock(&duck);

        // Row mapper closure reused across all query branches.
        let map_row = |r: &duckdb::Row| Ok(serde_json::json!({
            "ts_ms":      r.get::<_, i64>(0)?,
            "node_id":    r.get::<_, String>(1)?,
            "level":      r.get::<_, String>(2)?,
            "event_type": r.get::<_, Option<String>>(3)?,
            "message":    r.get::<_, String>(4)?,
        }));

        // Use fixed SQL per filter combination to avoid raw_bind_parameter issues.
        let base = "SELECT ts_ms, node_id, level, event_type, message FROM node_events WHERE tenant_id = ?1 AND ts_ms < ?2";
        let rows = match (&node_id_filter, &event_type_filter) {
            (Some(nid), Some(et)) => {
                let sql = format!("{base} AND node_id = ?3 AND event_type = ?4 ORDER BY ts_ms DESC LIMIT ?5");
                conn.prepare(&sql)?.query_map(duckdb::params![user_id, before, nid, et, limit], map_row)?
                    .collect::<Result<Vec<_>, _>>()?
            }
            (Some(nid), None) => {
                let sql = format!("{base} AND node_id = ?3 ORDER BY ts_ms DESC LIMIT ?4");
                conn.prepare(&sql)?.query_map(duckdb::params![user_id, before, nid, limit], map_row)?
                    .collect::<Result<Vec<_>, _>>()?
            }
            (None, Some(et)) => {
                let sql = format!("{base} AND event_type = ?3 ORDER BY ts_ms DESC LIMIT ?4");
                conn.prepare(&sql)?.query_map(duckdb::params![user_id, before, et, limit], map_row)?
                    .collect::<Result<Vec<_>, _>>()?
            }
            (None, None) => {
                let sql = format!("{base} ORDER BY ts_ms DESC LIMIT ?3");
                conn.prepare(&sql)?.query_map(duckdb::params![user_id, before, limit], map_row)?
                    .collect::<Result<Vec<_>, _>>()?
            }
        };
        Ok::<_, duckdb::Error>(rows)
    }).await {
        Ok(Ok(events)) => Json(serde_json::json!({ "events": events })).into_response(),
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("query failed: {e}") }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("task join failed: {e}") }))).into_response(),
    }
}

/// GET /api/fleet/observations?state=open|resolved|acknowledged|all&node_id=<optional>&limit=50
///
/// Returns fleet observations from DuckDB. JWT-authenticated, tenant-isolated.
/// Observations are stateful alert records with severity and lifecycle state.
async fn handle_fleet_observations(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let db = state.db.clone();
    let user_id: Option<String> = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        require_user(&token, &conn, &clerk_keys)
    }).await.unwrap();

    let user_id = match user_id {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let limit: i64 = params.get("limit")
        .and_then(|v| v.parse().ok())
        .unwrap_or(50)
        .min(200);
    let state_filter = params.get("state").cloned().unwrap_or_else(|| "open".into());
    let node_id_filter = params.get("node_id").cloned();

    let duck = state.duck_db.clone();
    match tokio::task::spawn_blocking(move || {
        let conn = duck_lock(&duck);

        let map_row = |r: &duckdb::Row| Ok(serde_json::json!({
            "id":             r.get::<_, String>(0)?,
            "node_id":        r.get::<_, String>(1)?,
            "alert_type":     r.get::<_, String>(2)?,
            "severity":       r.get::<_, String>(3)?,
            "state":          r.get::<_, String>(4)?,
            "title":          r.get::<_, String>(5)?,
            "detail":         r.get::<_, String>(6)?,
            "context_json":   r.get::<_, Option<String>>(7)?,
            "fired_at_ms":    r.get::<_, i64>(8)?,
            "resolved_at_ms": r.get::<_, Option<i64>>(9)?,
            "ack_at_ms":      r.get::<_, Option<i64>>(10)?,
        }));

        let base = "SELECT id, node_id, alert_type, severity, state, title, detail, context_json, fired_at_ms, resolved_at_ms, ack_at_ms FROM fleet_observations WHERE tenant_id = ?1";

        let rows = match (state_filter.as_str(), &node_id_filter) {
            ("all", Some(nid)) => {
                let sql = format!("{base} AND node_id = ?2 ORDER BY fired_at_ms DESC LIMIT ?3");
                conn.prepare(&sql)?.query_map(duckdb::params![user_id, nid, limit], map_row)?
                    .collect::<Result<Vec<_>, _>>()?
            }
            ("all", None) => {
                let sql = format!("{base} ORDER BY fired_at_ms DESC LIMIT ?2");
                conn.prepare(&sql)?.query_map(duckdb::params![user_id, limit], map_row)?
                    .collect::<Result<Vec<_>, _>>()?
            }
            (st, Some(nid)) => {
                let sql = format!("{base} AND state = ?2 AND node_id = ?3 ORDER BY fired_at_ms DESC LIMIT ?4");
                conn.prepare(&sql)?.query_map(duckdb::params![user_id, st, nid, limit], map_row)?
                    .collect::<Result<Vec<_>, _>>()?
            }
            (st, None) => {
                let sql = format!("{base} AND state = ?2 ORDER BY fired_at_ms DESC LIMIT ?3");
                conn.prepare(&sql)?.query_map(duckdb::params![user_id, st, limit], map_row)?
                    .collect::<Result<Vec<_>, _>>()?
            }
        };
        Ok::<_, duckdb::Error>(rows)
    }).await {
        Ok(Ok(obs)) => Json(serde_json::json!({ "observations": obs })).into_response(),
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("query failed: {e}") }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("task join failed: {e}") }))).into_response(),
    }
}

/// POST /api/fleet/observations/:id/acknowledge
///
/// Manually acknowledge an open observation (sets state='acknowledged', ack_at_ms=now).
/// JWT-authenticated, tenant-isolated.
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
    let db = state.db.clone();
    let user_id: Option<String> = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        require_user(&token, &conn, &clerk_keys)
    }).await.unwrap();

    let user_id = match user_id {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let duck = state.duck_db.clone();
    let now = now_ms() as i64;
    match tokio::task::spawn_blocking(move || {
        let conn = duck_lock(&duck);
        let updated = conn.execute(
            "UPDATE fleet_observations SET state = 'acknowledged', ack_at_ms = ?1
             WHERE id = ?2 AND tenant_id = ?3 AND state = 'open'",
            duckdb::params![now, obs_id, user_id],
        )?;
        Ok::<_, duckdb::Error>(updated)
    }).await {
        Ok(Ok(n)) if n > 0 => Json(serde_json::json!({ "ok": true })).into_response(),
        Ok(Ok(_)) => (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Observation not found or already resolved" }))).into_response(),
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("update failed: {e}") }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("task join failed: {e}") }))).into_response(),
    }
}

/// GET /api/fleet/export?format=csv|json&from=<ts_ms>&to=<ts_ms>&limit=10000&node_id=<optional>
///
/// Export fleet node events as CSV or JSON. JWT-authenticated, tenant-isolated.
async fn handle_fleet_export(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let db = state.db.clone();
    let user_id: Option<String> = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        require_user(&token, &conn, &clerk_keys)
    }).await.unwrap();

    let user_id = match user_id {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
    let from_ms: i64 = params.get("from").and_then(|v| v.parse().ok()).unwrap_or(now_ms - 24 * 60 * 60 * 1000);
    let to_ms: i64   = params.get("to").and_then(|v| v.parse().ok()).unwrap_or(now_ms);
    let limit: i64   = params.get("limit").and_then(|v| v.parse().ok()).unwrap_or(10_000).min(50_000);
    let format        = params.get("format").map(|s| s.as_str()).unwrap_or("csv").to_string();
    let node_filter   = params.get("node_id").cloned();

    let duck = state.duck_db.clone();
    let events = match tokio::task::spawn_blocking(move || {
        let conn = duck_lock(&duck);
        let base = "SELECT ts_ms, node_id, level, event_type, message FROM node_events
                    WHERE tenant_id = ?1 AND ts_ms >= ?2 AND ts_ms <= ?3";
        let map_row = |r: &duckdb::Row| {
            let ts_ms: i64 = r.get(0)?;
            let ts_str = format!("{}.{:03}", ts_ms / 1000, ts_ms % 1000);
            Ok(serde_json::json!({
                "ts_ms": ts_ms,
                "timestamp": ts_str,
                "record_type": "event",
                "node_id": r.get::<_, String>(1)?,
                "level": r.get::<_, String>(2)?,
                "event_type": r.get::<_, Option<String>>(3)?,
                "message": r.get::<_, String>(4)?,
            }))
        };
        let rows = match &node_filter {
            Some(nid) => {
                let sql = format!("{base} AND node_id = ?4 ORDER BY ts_ms DESC LIMIT ?5");
                conn.prepare(&sql)?.query_map(duckdb::params![user_id, from_ms, to_ms, nid, limit], map_row)?
                    .collect::<Result<Vec<_>, _>>()?
            }
            None => {
                let sql = format!("{base} ORDER BY ts_ms DESC LIMIT ?4");
                conn.prepare(&sql)?.query_map(duckdb::params![user_id, from_ms, to_ms, limit], map_row)?
                    .collect::<Result<Vec<_>, _>>()?
            }
        };
        Ok::<_, duckdb::Error>(rows)
    }).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => return (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("Export failed: {e}") }))).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("Task join failed: {e}") }))).into_response(),
    };

    if format == "json" {
        let body = serde_json::to_string_pretty(&events).unwrap_or_default();
        (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "application/json"),
             (axum::http::header::CONTENT_DISPOSITION, "attachment; filename=\"wicklee-fleet-export.json\"")],
            body,
        ).into_response()
    } else {
        let mut csv = String::from("timestamp,record_type,node_id,level,event_type,message\n");
        for e in &events {
            csv.push_str(&format!("{},{},{},{},{},{}\n",
                e["timestamp"].as_str().unwrap_or(""),
                "event",
                e["node_id"].as_str().unwrap_or(""),
                e["level"].as_str().unwrap_or(""),
                e["event_type"].as_str().unwrap_or(""),
                e["message"].as_str().unwrap_or("").replace(',', ";"),
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

/// GET /api/fleet/wes-history?node_id=<optional>&range=1h|24h|7d|30d|90d
///
/// Returns WES time-series data for the authenticated user's fleet (or a single node).
/// Short ranges (1h) pull from metrics_raw; longer ranges use metrics_5min aggregates.
///
/// Response: { "range": "24h", "nodes": [{ "node_id", "hostname", "points": [{ ts_ms, raw_wes, penalized_wes, thermal_state }] }] }
async fn handle_wes_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let range = params.get("range").map(|s| s.as_str()).unwrap_or("24h").to_string();
    let node_id_filter = params.get("node_id").cloned();

    // (lookback_ms, bucket_ms, use_raw_table)
    // 1h + 24h use metrics_raw (2-day retention) to ensure data is always
    // visible even before the hourly rollup populates metrics_5min.
    // 7d+ use metrics_5min for efficiency (rollup aggregates older data).
    let (lookback_ms, bucket_ms, use_raw): (i64, i64, bool) = match range.as_str() {
        "1h"  => (3_600_000,      60_000,    true),
        "24h" => (86_400_000,     300_000,   true),
        "7d"  => (604_800_000,    1_800_000, false),
        "30d" => (2_592_000_000,  7_200_000, false),
        "90d" => (7_776_000_000,  21_600_000, false),
        _     => (86_400_000,     300_000,   true),
    };

    // 1. Authenticate
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let db = state.db.clone();
    let user_id: Option<String> = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        require_user(&token, &conn, &clerk_keys)
    }).await.unwrap();

    let user_id = match user_id {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    // Tier enforcement — server-side guard on history ranges.
    // community: 1h, 24h  |  pro: +7d  |  team/enterprise: +30d, 90d
    {
        let db2 = state.db.clone();
        let uid2 = user_id.clone();
        let tier: String = tokio::task::spawn_blocking(move || {
            let conn = db2.lock().unwrap();
            conn.query_row("SELECT subscription_tier FROM users WHERE id = ?1", params![uid2], |r| r.get(0))
                .unwrap_or_else(|_| "community".to_string())
        }).await.unwrap_or_else(|_| "community".to_string());

        let allowed = match tier.as_str() {
            "team" | "enterprise" => true,
            "pro" => !matches!(range.as_str(), "30d" | "90d"),
            _ => matches!(range.as_str(), "1h" | "24h"),
        };
        if !allowed {
            return (StatusCode::FORBIDDEN,
                Json(serde_json::json!({ "error": format!("Range '{}' requires a higher subscription tier", range) }))).into_response();
        }
    }

    // 2. Enumerate user's nodes from SQLite (wk_id + persisted hostname)
    let db2 = state.db.clone();
    let uid = user_id.clone();
    let node_rows: Vec<(String, Option<String>)> = tokio::task::spawn_blocking(move || {
        let conn = db2.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT wk_id, hostname FROM nodes WHERE user_id = ?1 ORDER BY last_seen DESC"
        ).ok()?;
        Some(stmt.query_map(params![uid], |r| Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1).ok().flatten(),
        ))).ok()?.filter_map(|r| r.ok()).collect())
    }).await.unwrap().unwrap_or_default();

    if node_rows.is_empty() {
        return Json(serde_json::json!({ "range": range, "nodes": [] })).into_response();
    }

    // Enrich hostnames from live metrics cache (takes precedence over persisted hostname)
    let node_rows: Vec<(String, Option<String>)> = {
        let metrics_map = state.metrics.read().unwrap();
        node_rows.into_iter().map(|(nid, stored_hostname)| {
            let live_hostname = metrics_map.get(&nid)
                .and_then(|e| e.metrics.as_ref())
                .and_then(|m| m.hostname.clone());
            (nid, live_hostname.or(stored_hostname))
        }).collect()
    };

    // 3. Filter to requested node (or all nodes)
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

    // 4. Query DuckDB for WES points
    let duck = state.duck_db.clone();
    let now  = now_ms() as i64;
    let since_ms = now - lookback_ms;

    let nodes_data: Vec<serde_json::Value> = tokio::task::spawn_blocking(move || {
        let conn = duck_lock(&duck);
        let mut out = Vec::new();

        for (node_id, hostname) in &target_nodes {
            let points: Vec<serde_json::Value> = if use_raw {
                let sql = format!(
                    "SELECT (ts_ms / {bkt}) * {bkt} AS bucket,
                            AVG(wes_raw)       AS raw_wes,
                            AVG(wes_penalized) AS penalized_wes,
                            MAX(CASE thermal_state
                                WHEN 'Critical' THEN 3
                                WHEN 'Serious'  THEN 2
                                WHEN 'Fair'     THEN 1
                                ELSE 0 END)     AS thermal_rank
                     FROM metrics_raw
                     WHERE tenant_id = '{uid}' AND node_id = '{nid}' AND ts_ms >= {since}
                     GROUP BY bucket ORDER BY bucket",
                    bkt = bucket_ms, uid = user_id, nid = node_id, since = since_ms
                );
                match conn.prepare(&sql).ok().and_then(|mut s| {
                    s.query_map([], |r| Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, Option<f64>>(1)?,
                        r.get::<_, Option<f64>>(2)?,
                        r.get::<_, Option<i64>>(3)?,
                    ))).ok().map(|it| it.filter_map(|r| r.ok()).collect::<Vec<_>>())
                }) {
                    Some(rows) => rows.into_iter().map(|(ts, rw, pw, tr)| {
                        let thermal = match tr { Some(3) => "Critical", Some(2) => "Serious", Some(1) => "Fair", _ => "Normal" };
                        serde_json::json!({ "ts_ms": ts, "raw_wes": rw, "penalized_wes": pw, "thermal_state": thermal })
                    }).collect(),
                    None => vec![],
                }
            } else {
                let sql = format!(
                    "SELECT (ts_ms / {bkt}) * {bkt} AS bucket,
                            AVG(wes_raw_avg)       AS raw_wes,
                            AVG(wes_penalized_avg) AS penalized_wes,
                            MAX(CASE thermal_state_worst
                                WHEN 'Critical' THEN 3
                                WHEN 'Serious'  THEN 2
                                WHEN 'Fair'     THEN 1
                                ELSE 0 END)         AS thermal_rank
                     FROM metrics_5min
                     WHERE tenant_id = '{uid}' AND node_id = '{nid}' AND ts_ms >= {since}
                     GROUP BY bucket ORDER BY bucket",
                    bkt = bucket_ms, uid = user_id, nid = node_id, since = since_ms
                );
                match conn.prepare(&sql).ok().and_then(|mut s| {
                    s.query_map([], |r| Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, Option<f64>>(1)?,
                        r.get::<_, Option<f64>>(2)?,
                        r.get::<_, Option<i64>>(3)?,
                    ))).ok().map(|it| it.filter_map(|r| r.ok()).collect::<Vec<_>>())
                }) {
                    Some(rows) => rows.into_iter().map(|(ts, rw, pw, tr)| {
                        let thermal = match tr { Some(3) => "Critical", Some(2) => "Serious", Some(1) => "Fair", _ => "Normal" };
                        serde_json::json!({ "ts_ms": ts, "raw_wes": rw, "penalized_wes": pw, "thermal_state": thermal })
                    }).collect(),
                    None => vec![],
                }
            };

            // Resolve hostname from the live metrics cache (most current)
            let display_hostname = hostname.clone().unwrap_or_else(|| node_id.clone());

            out.push(serde_json::json!({
                "node_id":  node_id,
                "hostname": display_hostname,
                "points":   points,
            }));
        }
        out
    }).await.unwrap_or_default();

    Json(serde_json::json!({ "range": range, "nodes": nodes_data })).into_response()
}

/// GET /api/fleet/metrics-history?node_id=<optional>&range=1h|24h|7d|30d|90d
///
/// Returns time-series data for Tok/s, Power (W), GPU%, and Memory Pressure %
/// for the authenticated user's fleet (or a single node).
/// Short ranges (1h) pull from metrics_raw; longer ranges use metrics_5min aggregates.
/// The tok_s_p95 field is only populated for 24h+ ranges (metrics_5min source).
///
/// Response: { "range": "24h", "nodes": [{ "node_id", "hostname", "points": [
///   { ts_ms, tok_s, tok_s_p95, watts, gpu_pct, mem_pct }
/// ] }] }
async fn handle_metrics_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let range          = params.get("range").map(|s| s.as_str()).unwrap_or("24h").to_string();
    let node_id_filter = params.get("node_id").cloned();

    // 1h + 24h query metrics_raw directly (2-day retention) so data is
    // visible immediately. 7d+ use metrics_5min rollup aggregates.
    let (lookback_ms, bucket_ms, use_raw): (i64, i64, bool) = match range.as_str() {
        "1h"  => (3_600_000,      60_000,    true),
        "24h" => (86_400_000,     300_000,   true),
        "7d"  => (604_800_000,    1_800_000, false),
        "30d" => (2_592_000_000,  7_200_000, false),
        "90d" => (7_776_000_000,  21_600_000, false),
        _     => (86_400_000,     300_000,   true),
    };

    // Authenticate
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let db         = state.db.clone();
    let user_id: Option<String> = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        require_user(&token, &conn, &clerk_keys)
    }).await.unwrap();

    let user_id = match user_id {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    // Tier enforcement — server-side guard on history ranges.
    {
        let db2 = state.db.clone();
        let uid2 = user_id.clone();
        let tier: String = tokio::task::spawn_blocking(move || {
            let conn = db2.lock().unwrap();
            conn.query_row("SELECT subscription_tier FROM users WHERE id = ?1", params![uid2], |r| r.get(0))
                .unwrap_or_else(|_| "community".to_string())
        }).await.unwrap_or_else(|_| "community".to_string());

        let allowed = match tier.as_str() {
            "team" | "enterprise" => true,
            "pro" => !matches!(range.as_str(), "30d" | "90d"),
            _ => matches!(range.as_str(), "1h" | "24h"),
        };
        if !allowed {
            return (StatusCode::FORBIDDEN,
                Json(serde_json::json!({ "error": format!("Range '{}' requires a higher subscription tier", range) }))).into_response();
        }
    }

    // Enumerate user's nodes from SQLite
    let db2 = state.db.clone();
    let uid  = user_id.clone();
    let node_rows: Vec<(String, Option<String>)> = tokio::task::spawn_blocking(move || {
        let conn = db2.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT wk_id, hostname FROM nodes WHERE user_id = ?1 ORDER BY last_seen DESC"
        ).ok()?;
        Some(stmt.query_map(params![uid], |r| Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1).ok().flatten(),
        ))).ok()?.filter_map(|r| r.ok()).collect())
    }).await.unwrap().unwrap_or_default();

    if node_rows.is_empty() {
        return Json(serde_json::json!({ "range": range, "nodes": [] })).into_response();
    }

    // Enrich hostnames from live metrics cache
    let node_rows: Vec<(String, Option<String>)> = {
        let metrics_map = state.metrics.read().unwrap();
        node_rows.into_iter().map(|(nid, stored_hostname)| {
            let live_hostname = metrics_map.get(&nid)
                .and_then(|e| e.metrics.as_ref())
                .and_then(|m| m.hostname.clone());
            (nid, live_hostname.or(stored_hostname))
        }).collect()
    };

    // Filter to requested node (or all nodes)
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

    // Query DuckDB
    let duck     = state.duck_db.clone();
    let now      = now_ms() as i64;
    let since_ms = now - lookback_ms;

    let nodes_data: Vec<serde_json::Value> = tokio::task::spawn_blocking(move || {
        let conn = duck_lock(&duck);
        let mut out = Vec::new();

        for (node_id, hostname) in &target_nodes {
            let points: Vec<serde_json::Value> = if use_raw {
                // 1h range — query metrics_raw, 60-second buckets
                let sql = format!(
                    "SELECT (ts_ms / {bkt}) * {bkt} AS bucket,
                            AVG(tok_s)            AS tok_s,
                            NULL::DOUBLE           AS tok_s_p95,
                            AVG(watts)            AS watts,
                            AVG(gpu_pct)          AS gpu_pct,
                            AVG(mem_pressure_pct) AS mem_pct,
                            (SUM(CASE WHEN inference_state = 'live' THEN 1 ELSE 0 END)::DOUBLE / COUNT(*)::DOUBLE * 100.0) AS duty_pct
                     FROM metrics_raw
                     WHERE tenant_id = '{uid}' AND node_id = '{nid}' AND ts_ms >= {since}
                     GROUP BY bucket ORDER BY bucket",
                    bkt = bucket_ms, uid = user_id, nid = node_id, since = since_ms
                );
                match conn.prepare(&sql).ok().and_then(|mut s| {
                    s.query_map([], |r| Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, Option<f64>>(1)?,
                        r.get::<_, Option<f64>>(2)?,
                        r.get::<_, Option<f64>>(3)?,
                        r.get::<_, Option<f64>>(4)?,
                        r.get::<_, Option<f64>>(5)?,
                        r.get::<_, Option<f64>>(6)?,
                    ))).ok().map(|it| it.filter_map(|r| r.ok()).collect::<Vec<_>>())
                }) {
                    Some(rows) => rows.into_iter().map(|(ts, toks, toksp95, w, gpu, mem, duty)| {
                        serde_json::json!({
                            "ts_ms":      ts,
                            "tok_s":      toks,
                            "tok_s_p95":  toksp95,
                            "watts":      w,
                            "gpu_pct":    gpu,
                            "mem_pct":    mem,
                            "duty_pct":   duty,
                        })
                    }).collect(),
                    None => vec![],
                }
            } else {
                // 24h–90d — query metrics_5min aggregates
                let sql = format!(
                    "SELECT (ts_ms / {bkt}) * {bkt} AS bucket,
                            AVG(tok_s_avg)            AS tok_s,
                            AVG(tok_s_p95)            AS tok_s_p95,
                            AVG(watts_avg)            AS watts,
                            AVG(gpu_pct_avg)          AS gpu_pct,
                            AVG(mem_pressure_pct_avg) AS mem_pct,
                            AVG(inference_duty_pct)   AS duty_pct
                     FROM metrics_5min
                     WHERE tenant_id = '{uid}' AND node_id = '{nid}' AND ts_ms >= {since}
                     GROUP BY bucket ORDER BY bucket",
                    bkt = bucket_ms, uid = user_id, nid = node_id, since = since_ms
                );
                match conn.prepare(&sql).ok().and_then(|mut s| {
                    s.query_map([], |r| Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, Option<f64>>(1)?,
                        r.get::<_, Option<f64>>(2)?,
                        r.get::<_, Option<f64>>(3)?,
                        r.get::<_, Option<f64>>(4)?,
                        r.get::<_, Option<f64>>(5)?,
                        r.get::<_, Option<f64>>(6)?,
                    ))).ok().map(|it| it.filter_map(|r| r.ok()).collect::<Vec<_>>())
                }) {
                    Some(rows) => rows.into_iter().map(|(ts, toks, toksp95, w, gpu, mem, duty)| {
                        serde_json::json!({
                            "ts_ms":      ts,
                            "tok_s":      toks,
                            "tok_s_p95":  toksp95,
                            "watts":      w,
                            "gpu_pct":    gpu,
                            "mem_pct":    mem,
                            "duty_pct":   duty,
                        })
                    }).collect(),
                    None => vec![],
                }
            };

            let display_hostname = hostname.clone().unwrap_or_else(|| node_id.clone());
            out.push(serde_json::json!({
                "node_id":  node_id,
                "hostname": display_hostname,
                "points":   points,
            }));
        }
        out
    }).await.unwrap_or_default();

    Json(serde_json::json!({ "range": range, "nodes": nodes_data })).into_response()
}

/// GET /api/fleet/duty?range=1h|24h|7d|30d
///
/// Returns the fleet-wide inference duty cycle — the percentage of time at least
/// one node was actively generating tokens ("live" state).
///
/// Response: { "range": "24h", "duty_pct": 42.5, "total_samples": 1234, "live_samples": 525,
///             "nodes": [{ "node_id", "hostname", "duty_pct" }] }
async fn handle_fleet_duty(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let range = params.get("range").map(|s| s.as_str()).unwrap_or("24h").to_string();

    let (lookback_ms, use_raw): (i64, bool) = match range.as_str() {
        "1h"  => (3_600_000,     true),
        "24h" => (86_400_000,    false),
        "7d"  => (604_800_000,   false),
        "30d" => (2_592_000_000, false),
        _     => (86_400_000,    false),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let db         = state.db.clone();
    let user_id: Option<String> = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        require_user(&token, &conn, &clerk_keys)
    }).await.unwrap();

    let user_id = match user_id {
        Some(uid) => uid,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid token" }))).into_response(),
    };

    let duck   = state.duck_db.clone();
    let db2    = state.db.clone();
    let since_ms = now_ms() as i64 - lookback_ms;

    let result = tokio::task::spawn_blocking(move || {
        let conn = duck_lock(&duck);
        let sql_conn = db2.lock().unwrap();

        // Get target nodes
        let mut node_stmt = sql_conn.prepare("SELECT id, hostname FROM nodes WHERE user_id = ?1").ok()?;
        let target_nodes: Vec<(String, Option<String>)> = node_stmt.query_map(
            params![user_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        ).ok()?.filter_map(|r| r.ok()).collect();

        if target_nodes.is_empty() { return Some(serde_json::json!({ "range": range, "duty_pct": null, "total_samples": 0, "live_samples": 0, "nodes": [] })); }

        let mut per_node = Vec::new();
        let mut total_all: i64 = 0;
        let mut live_all: i64 = 0;

        for (nid, hostname) in &target_nodes {
            let (total, live) = if use_raw {
                let sql = format!(
                    "SELECT COUNT(*) AS total,
                            SUM(CASE WHEN inference_state = 'live' THEN 1 ELSE 0 END) AS live_count
                     FROM metrics_raw
                     WHERE tenant_id = '{}' AND node_id = '{}' AND ts_ms >= {}",
                    user_id, nid, since_ms
                );
                conn.prepare(&sql).ok().and_then(|mut s| {
                    s.query_row([], |r| Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                    ))).ok()
                }).unwrap_or((0, 0))
            } else {
                // For longer ranges, use metrics_5min: weighted average of duty_pct × sample_count
                let sql = format!(
                    "SELECT COALESCE(SUM(sample_count), 0) AS total,
                            COALESCE(SUM(inference_duty_pct * sample_count / 100.0), 0)::BIGINT AS live_count
                     FROM metrics_5min
                     WHERE tenant_id = '{}' AND node_id = '{}' AND ts_ms >= {}",
                    user_id, nid, since_ms
                );
                conn.prepare(&sql).ok().and_then(|mut s| {
                    s.query_row([], |r| Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                    ))).ok()
                }).unwrap_or((0, 0))
            };

            let duty_pct = if total > 0 { Some((live as f64 / total as f64) * 100.0) } else { None };
            let display_hostname = hostname.clone().unwrap_or_else(|| nid.clone());
            per_node.push(serde_json::json!({
                "node_id":  nid,
                "hostname": display_hostname,
                "duty_pct": duty_pct.map(|d| (d * 10.0).round() / 10.0),
            }));
            total_all += total;
            live_all  += live;
        }

        let fleet_duty = if total_all > 0 {
            Some(((live_all as f64 / total_all as f64) * 1000.0).round() / 10.0)
        } else {
            None
        };

        Some(serde_json::json!({
            "range":         range,
            "duty_pct":      fleet_duty,
            "total_samples": total_all,
            "live_samples":  live_all,
            "nodes":         per_node,
        }))
    }).await.unwrap_or(None);

    match result {
        Some(data) => Json(data).into_response(),
        None => (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Query failed" }))).into_response(),
    }
}

/// POST /api/pair/activate — user enters 6-digit code from their terminal to link the node.
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

    // Auth is required — a node must always be owned by an account.
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let db = state.db.clone();
    // Returns (user_id, email, is_pro)
    let user_info: Option<(String, String, i32)> = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        require_user_info(&token, &conn, &clerk_keys)
    }).await.unwrap();

    let (user_id, email, is_pro_db) = match user_info {
        Some(info) => info,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    // Enforce free-tier node limit per user (skip for dev account or pro users).
    let is_pro = is_pro_db != 0 || is_dev_account(&email);
    if !is_pro {
        let db2 = state.db.clone();
        let uid = user_id.clone();
        let count: usize = tokio::task::spawn_blocking(move || {
            let conn = db2.lock().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM nodes WHERE user_id = ?1",
                params![uid],
                |r| r.get::<_, i64>(0),
            ).unwrap_or(0) as usize
        }).await.unwrap();
        if count >= MAX_FREE_NODES {
            return (StatusCode::PAYMENT_REQUIRED,
                Json(serde_json::json!({
                    "error": format!("Free tier limit reached ({MAX_FREE_NODES} nodes). Upgrade to Wicklee Pro to add more.")
                }))).into_response();
        }
    }

    let db   = state.db.clone();
    let code = body.code.clone();
    let uid  = user_id.clone();

    let row: Option<(String, String)> = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        let row = conn.query_row(
            "SELECT wk_id, fleet_url FROM nodes WHERE code = ?1",
            params![code],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        ).ok()?;
        // Stamp user_id immediately — always set, never NULL.
        let _ = conn.execute(
            "UPDATE nodes SET user_id = ?1 WHERE wk_id = ?2",
            params![uid, row.0],
        );
        Some(row)
    }).await.unwrap();

    match row {
        None => (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Code not found or already used. Make sure the agent is running and try again." }))).into_response(),
        Some((node_id, fleet_url)) =>
            (StatusCode::OK, Json(serde_json::json!({ "node_id": node_id, "fleet_url": fleet_url }))).into_response(),
    }
}

/// GET /api/fleet/stream — SSE stream pushing fleet snapshots every 2 s.
/// Auth: single-use stream token via ?token=<uuid> (issued by /api/auth/stream-token).
/// EventSource cannot send Authorization headers, so we use a short-lived UUID token.
async fn handle_fleet_stream(
    State(state): State<AppState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let stream_token = match params.get("token") {
        Some(t) if !t.is_empty() => t.clone(),
        _ => {
            return (StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "Missing stream token" }))).into_response();
        }
    };

    // Validate the token from SQLite.
    // Using spawn_blocking so the SELECT runs on the same connection/thread.
    let now = now_ms() as i64;
    let db_auth = state.db.clone();
    let st_clone = stream_token.clone();
    let user_id = match tokio::task::spawn_blocking(move || {
        let conn = db_auth.lock().unwrap();
        // Fetch the token row (validates existence and expiry in one shot).
        // Do NOT delete here — EventSource may retry after a proxy 502,
        // and the token is already time-limited to 60 s.  The background
        // cleanup task purges expired tokens every 5 minutes.
        conn.query_row(
            "SELECT user_id FROM stream_tokens WHERE token = ?1 AND expires_ms > ?2",
            params![st_clone, now],
            |r| r.get::<_, String>(0),
        ).ok()
    }).await.unwrap() {
        Some(uid) => uid,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired stream token" }))).into_response(),
    };

    // Load initial node set and tier for this user.
    let db = state.db.clone();
    let uid2 = user_id.clone();
    let initial: (HashSet<String>, Vec<String>, String) = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        let node_set = user_node_set(&uid2, &conn);
        // Ordered list (by paired_at ASC) for restricted-set computation.
        let ordered: Vec<String> = conn.prepare(
            "SELECT wk_id FROM nodes WHERE user_id = ?1 ORDER BY paired_at ASC"
        ).ok()
        .map(|mut stmt| stmt.query_map(params![uid2], |r| r.get::<_, String>(0))
            .ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
            .unwrap_or_default())
        .unwrap_or_default();
        let tier: String = conn.query_row(
            "SELECT subscription_tier FROM users WHERE id = ?1",
            params![uid2],
            |r| r.get(0),
        ).unwrap_or_else(|_| "community".to_string());
        (node_set, ordered, tier)
    }).await.unwrap();

    let interval_stream = tokio_stream::wrappers::IntervalStream::new(
        tokio::time::interval(Duration::from_secs(2)),
    );

    let db_stream  = state.db.clone();
    let uid_stream = user_id.clone();
    let (initial_nodes, initial_ordered, initial_tier) = initial;
    let mut nodes          = initial_nodes;
    let mut ordered_nodes  = initial_ordered;
    let mut tier           = initial_tier;
    let mut tick: u32 = 0;

    let stream = interval_stream.map(move |_| {
        tick += 1;
        // Refresh the user's node list every 30 ticks (~60 s) to pick up
        // newly paired nodes without restarting the stream.
        if tick % 30 == 0 {
            let uid_ref = uid_stream.clone();
            let (new_nodes, new_ordered, new_tier) = tokio::task::block_in_place(|| {
                let conn = db_stream.lock().unwrap();
                let node_set = user_node_set(&uid_ref, &conn);
                let ordered: Vec<String> = conn.prepare(
                    "SELECT wk_id FROM nodes WHERE user_id = ?1 ORDER BY paired_at ASC"
                ).ok()
                .map(|mut stmt| stmt.query_map(params![uid_ref], |r| r.get::<_, String>(0))
                    .ok()
                    .map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
                    .unwrap_or_default())
                .unwrap_or_default();
                let t: String = conn.query_row(
                    "SELECT subscription_tier FROM users WHERE id = ?1",
                    params![uid_ref],
                    |r| r.get(0),
                ).unwrap_or_else(|_| "community".to_string());
                (node_set, ordered, t)
            });
            nodes         = new_nodes;
            ordered_nodes = new_ordered;
            tier          = new_tier;
        }

        // Compute restricted set from the ordered node list.
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
                serde_json::json!({
                    "node_id":      node_id,
                    "last_seen_ms": entry.last_seen_ms,
                    "metrics":      entry.metrics,
                    "restricted":   restricted_ids.contains(node_id.as_str()),
                })
            })
            .collect();

        let data = serde_json::to_string(&serde_json::json!({ "nodes": node_list }))
            .unwrap_or_else(|_| r#"{"nodes":[]}"#.to_string());
        Ok::<_, Infallible>(Event::default().data(data))
    });

    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

/// GET /health — trivial liveness probe, no DB dependency.
async fn handle_health(State(state): State<AppState>) -> impl IntoResponse {
    // Diagnostic: check DuckDB metrics_raw freshness
    let duck = state.duck_db.clone();
    let diag = tokio::task::spawn_blocking(move || {
        let conn = duck_lock(&duck);
        let latest_ts: Option<i64> = conn.query_row(
            "SELECT MAX(ts_ms) FROM metrics_raw", [], |r| r.get(0),
        ).ok();
        let count_1h: Option<i64> = {
            let cutoff = (now_ms() as i64) - 3_600_000;
            conn.query_row(
                "SELECT COUNT(*) FROM metrics_raw WHERE ts_ms >= ?", duckdb::params![cutoff], |r| r.get(0),
            ).ok()
        };
        let count_24h: Option<i64> = {
            let cutoff = (now_ms() as i64) - 86_400_000;
            conn.query_row(
                "SELECT COUNT(*) FROM metrics_raw WHERE ts_ms >= ?", duckdb::params![cutoff], |r| r.get(0),
            ).ok()
        };
        let obs_open: Option<i64> = conn.query_row(
            "SELECT COUNT(*) FROM fleet_observations WHERE state = 'open'", [], |r| r.get(0),
        ).ok();
        (latest_ts, count_1h, count_24h, obs_open)
    }).await.unwrap_or((None, None, None, None));

    let now = now_ms() as i64;
    let age_s = diag.0.map(|ts| (now - ts) / 1000);

    Json(serde_json::json!({
        "status": "ok",
        "now_ms": now,
        "metrics_raw": {
            "latest_ts_ms": diag.0,
            "latest_age_s": age_s,
            "rows_1h": diag.1,
            "rows_24h": diag.2,
        },
        "fleet_observations_open": diag.3,
    })).into_response()
}

/// GET /api/agent/version?platform=<platform>
///
/// Queries the GitHub releases API for the latest wicklee-agent release and
/// returns the version tag + platform-specific download URL. Called by the
/// agent's auto-updater on startup. No auth required — public endpoint.
///
/// Response: { "latest": "v0.4.9", "download_url": "https://..." }
///
/// Platform → asset mapping:
///   darwin-aarch64        → wicklee-agent-darwin-aarch64
///   linux-x86_64          → wicklee-agent-linux-x86_64
///   linux-aarch64         → wicklee-agent-linux-aarch64
///   linux-x86_64-nvidia   → wicklee-agent-linux-x86_64-nvidia
///   windows-x86_64        → wicklee-agent-windows-x86_64.exe
async fn handle_agent_version(
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let platform = params.get("platform").cloned().unwrap_or_default();

    let asset_name = match platform.as_str() {
        "darwin-aarch64"      => "wicklee-agent-darwin-aarch64",
        "linux-x86_64"        => "wicklee-agent-linux-x86_64",
        "linux-aarch64"       => "wicklee-agent-linux-aarch64",
        "linux-x86_64-nvidia" => "wicklee-agent-linux-x86_64-nvidia",
        "windows-x86_64"      => "wicklee-agent-windows-x86_64.exe",
        _ => {
            return (StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "unrecognised platform" }))).into_response();
        }
    };

    // Query GitHub releases API in a blocking task (ureq is synchronous).
    let result = tokio::task::spawn_blocking(move || -> Result<(String, String), String> {
        let resp = ureq::get("https://api.github.com/repos/jeffgeiser/Wicklee/releases/latest")
            .set("User-Agent", "wicklee-cloud/1.0")
            .set("Accept", "application/vnd.github+json")
            .call()
            .map_err(|e| format!("github api request failed: {e}"))?;

        let body: serde_json::Value = resp.into_json()
            .map_err(|e| format!("github api json parse failed: {e}"))?;

        let tag = body["tag_name"]
            .as_str()
            .ok_or_else(|| "missing tag_name in github response".to_string())?
            .to_string();

        // Build direct download URL from the release tag + known asset name.
        let download_url = format!(
            "https://github.com/jeffgeiser/Wicklee/releases/download/{tag}/{asset_name}"
        );

        Ok((tag, download_url))
    }).await;

    match result {
        Ok(Ok((latest, download_url))) => (
            StatusCode::OK,
            Json(serde_json::json!({ "latest": latest, "download_url": download_url })),
        ).into_response(),
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
//
// Injected directly into the response so Railway's proxy cannot strip the
// headers. OPTIONS preflights are short-circuited with 200 OK before they
// reach any route handler.

async fn cors(req: Request<Body>, next: Next) -> Response {
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
    let h = res.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN,
        header::HeaderValue::from_static("*"));
    res
}

// ── DuckDB — path & connection ────────────────────────────────────────────────

fn duck_db_path() -> std::path::PathBuf {
    // Railway: set DUCK_DB_PATH=/data/analytics.duckdb via the volume mount.
    if let Ok(p) = std::env::var("DUCK_DB_PATH") {
        return std::path::PathBuf::from(p);
    }
    // Local fallback: ~/.wicklee/analytics.duckdb
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    std::path::PathBuf::from(home).join(".wicklee").join("analytics.duckdb")
}

fn open_duck_db() -> DuckConn {
    // DUCKDB_MODE=memory forces in-memory mode (no file I/O, no corruption risk).
    // Data is lost on restart but the process never crashes from file corruption.
    let use_memory = std::env::var("DUCKDB_MODE").unwrap_or_default() == "memory";

    if use_memory {
        let conn = DuckConn::open_in_memory()
            .expect("Cannot open in-memory DuckDB");
        run_duck_migrations(&conn);
        println!("  DUCK → :memory: (DUCKDB_MODE=memory)");
        return conn;
    }

    let path = duck_db_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("Cannot create DuckDB directory");
    }

    // Try to open.  If the file is corrupted (heap corruption, WAL damage),
    // rename the broken file and start fresh.  Metrics history is expendable;
    // a corrupted file that crashes the process is not.
    let conn = match DuckConn::open(&path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[duck] CRITICAL: cannot open {}: {e}", path.display());
            eprintln!("[duck] Renaming corrupted file and starting fresh");
            let backup = path.with_extension("duckdb.corrupt");
            if let Err(re) = std::fs::rename(&path, &backup) {
                eprintln!("[duck] WARNING: rename failed: {re} — deleting instead");
                let _ = std::fs::remove_file(&path);
                // Also remove WAL file if present.
                let wal = path.with_extension("duckdb.wal");
                let _ = std::fs::remove_file(&wal);
            }
            DuckConn::open(&path)
                .unwrap_or_else(|e2| panic!("Cannot create fresh DuckDB at {}: {e2}", path.display()))
        }
    };

    // Request ZSTD for all future checkpoints.  Only meaningful for file-backed mode.
    let _ = conn.execute_batch("SET force_compression='zstd';");

    run_duck_migrations(&conn);
    println!("  DUCK → {}", path.display());
    conn
}

// ── DuckDB — schema migrations ────────────────────────────────────────────────

fn run_duck_migrations(conn: &DuckConn) {
    conn.execute_batch("
        -- ── Raw telemetry (24-hour rolling window at native 1 Hz) ──────────
        CREATE TABLE IF NOT EXISTS metrics_raw (
            node_id          VARCHAR   NOT NULL,
            ts_ms            BIGINT    NOT NULL,
            tenant_id        VARCHAR   NOT NULL,
            tok_s            FLOAT,
            watts            FLOAT,
            wes_raw          FLOAT,
            wes_penalized    FLOAT,
            thermal_cost_pct FLOAT,
            thermal_penalty  FLOAT,
            thermal_state    VARCHAR,
            vram_used_mb     INTEGER,
            vram_total_mb    INTEGER,
            mem_pressure_pct FLOAT,
            gpu_pct          FLOAT,
            cpu_pct          FLOAT,
            inference_state  VARCHAR,
            wes_version      UTINYINT  NOT NULL DEFAULT 1,
            agent_version    VARCHAR,
            PRIMARY KEY (tenant_id, node_id, ts_ms)
        );

        -- ── 5-minute aggregates (90-day retention) ───────────────────────
        CREATE TABLE IF NOT EXISTS metrics_5min (
            node_id              VARCHAR   NOT NULL,
            ts_ms                BIGINT    NOT NULL,
            tenant_id            VARCHAR   NOT NULL,
            tok_s_avg            FLOAT,
            tok_s_p50            FLOAT,
            tok_s_p95            FLOAT,
            watts_avg            FLOAT,
            wes_raw_avg          FLOAT,
            wes_penalized_avg    FLOAT,
            wes_penalized_min    FLOAT,
            thermal_cost_pct_avg FLOAT,
            thermal_cost_pct_max FLOAT,
            thermal_state_worst  VARCHAR,
            mem_pressure_pct_avg FLOAT,
            mem_pressure_pct_max FLOAT,
            gpu_pct_avg          FLOAT,
            inference_duty_pct   FLOAT,
            sample_count         USMALLINT NOT NULL DEFAULT 0,
            wes_version          UTINYINT  NOT NULL DEFAULT 1,
            wes_version_count    UTINYINT  NOT NULL DEFAULT 1,
            agent_version        VARCHAR,
            PRIMARY KEY (tenant_id, node_id, ts_ms)
        );

        -- ── WES formula version boundaries ───────────────────────────────
        CREATE TABLE IF NOT EXISTS schema_breakpoints (
            node_id         VARCHAR NOT NULL,
            ts_ms           BIGINT  NOT NULL,
            tenant_id       VARCHAR NOT NULL,
            breakpoint_type VARCHAR NOT NULL,
            detail          VARCHAR
        );

        -- ── Node events (30-day retention) ──────────────────────────────
        CREATE TABLE IF NOT EXISTS node_events (
            ts_ms       BIGINT  NOT NULL,
            node_id     VARCHAR NOT NULL,
            tenant_id   VARCHAR NOT NULL,
            level       VARCHAR NOT NULL DEFAULT 'info',
            event_type  VARCHAR,
            message     VARCHAR NOT NULL,
            PRIMARY KEY (tenant_id, node_id, ts_ms, message)
        );

        CREATE INDEX IF NOT EXISTS idx_raw_node_ts
            ON metrics_raw  (tenant_id, node_id, ts_ms);
        CREATE INDEX IF NOT EXISTS idx_5min_node_ts
            ON metrics_5min (tenant_id, node_id, ts_ms);
        CREATE INDEX IF NOT EXISTS idx_node_events_tenant_ts
            ON node_events  (tenant_id, ts_ms);
    ").expect("DuckDB migrations failed");

    // ── Fleet observations (Phase 4B — stateful alert triage) ──────────
    //
    // Separate from node_events (flat log): observations are stateful records
    // with severity, open/resolved/acknowledged lifecycle, and structured
    // context JSON for the Triage tab.
    //
    // State machine:
    //   state = 'open'         → condition is actively firing
    //   state = 'resolved'     → condition cleared (auto-resolved by evaluator)
    //   state = 'acknowledged' → operator dismissed via UI (manual)
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS fleet_observations (
            id              VARCHAR   NOT NULL,
            tenant_id       VARCHAR   NOT NULL,
            node_id         VARCHAR   NOT NULL,
            alert_type      VARCHAR   NOT NULL,
            severity        VARCHAR   NOT NULL DEFAULT 'warning',
            state           VARCHAR   NOT NULL DEFAULT 'open',
            title           VARCHAR   NOT NULL,
            detail          VARCHAR   NOT NULL,
            context_json    VARCHAR,
            fired_at_ms     BIGINT    NOT NULL,
            resolved_at_ms  BIGINT,
            ack_at_ms       BIGINT,
            PRIMARY KEY (tenant_id, node_id, alert_type, fired_at_ms)
        );
        CREATE INDEX IF NOT EXISTS idx_observations_tenant_state
            ON fleet_observations (tenant_id, state, fired_at_ms);
        CREATE INDEX IF NOT EXISTS idx_observations_node
            ON fleet_observations (tenant_id, node_id, fired_at_ms);
    ").unwrap_or_else(|e| eprintln!("[duck] fleet_observations migration failed (non-fatal): {e}"));

    // ── Additive column migrations (idempotent — silently ignored if column exists) ──
    let _ = conn.execute_batch("ALTER TABLE metrics_raw  ADD COLUMN inference_state VARCHAR;");
    let _ = conn.execute_batch("ALTER TABLE metrics_raw  ADD COLUMN wes_version UTINYINT NOT NULL DEFAULT 1;");
    let _ = conn.execute_batch("ALTER TABLE metrics_raw  ADD COLUMN agent_version VARCHAR;");
    let _ = conn.execute_batch("ALTER TABLE metrics_5min ADD COLUMN inference_duty_pct FLOAT;");
    let _ = conn.execute_batch("ALTER TABLE metrics_5min ADD COLUMN wes_version UTINYINT NOT NULL DEFAULT 1;");
    let _ = conn.execute_batch("ALTER TABLE metrics_5min ADD COLUMN wes_version_count UTINYINT NOT NULL DEFAULT 1;");
    let _ = conn.execute_batch("ALTER TABLE metrics_5min ADD COLUMN agent_version VARCHAR;");

    // ── Diagnostic: log actual column count so schema drift is visible ──
    if let Ok(mut stmt) = conn.prepare("SELECT column_name FROM information_schema.columns WHERE table_name = 'metrics_raw' ORDER BY ordinal_position") {
        if let Ok(cols) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            let names: Vec<String> = cols.filter_map(|r| r.ok()).collect();
            eprintln!("[duck] metrics_raw schema: {} columns — {:?}", names.len(), names);
        }
    }
}

// ── DuckDB — derive MetricsRow from inbound telemetry ────────────────────────

fn metrics_row_from_payload(m: &MetricsPayload, ts_ms: u64) -> MetricsRow {
    let tok_s   = if m.vllm_running { m.vllm_tokens_per_sec } else { m.ollama_tokens_per_second };
    // Power priority: NVIDIA board power → Apple SoC (Combined CPU+GPU+ANE) → cpu_power_w fallback.
    // apple_soc_power_w is the correct total power for Apple Silicon WES calculation.
    // cpu_power_w alone is just the CPU cluster (~0.1W at idle) and produces inflated WES.
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
        tenant_id:        String::new(), // filled in by handle_telemetry after node lookup
        tok_s,
        watts,
        wes_raw,
        wes_penalized,
        // Use agent's penalty_avg for thermal cost if available (WES v2).
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
    }
}

// ── DuckDB — batch writer ─────────────────────────────────────────────────────

/// Flush a batch of MetricsRow into metrics_raw using explicit INSERT statements.
/// Slower than the DuckDB Appender but immune to schema drift from ALTER TABLE
/// migrations that change the column order or count on an existing database file.
/// Call only from spawn_blocking — DuckDB Connection is !Sync.
fn flush_batch(conn: &DuckConn, batch: &[MetricsRow]) {
    if batch.is_empty() { return; }

    let mut stmt = match conn.prepare(
        "INSERT INTO metrics_raw (
            node_id, ts_ms, tenant_id, tok_s, watts, wes_raw, wes_penalized,
            thermal_cost_pct, thermal_penalty, thermal_state,
            vram_used_mb, vram_total_mb, mem_pressure_pct, gpu_pct, cpu_pct,
            inference_state, wes_version, agent_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ) {
        Ok(s) => s,
        Err(e) => { eprintln!("[duck] INSERT prepare failed: {e}"); return; }
    };

    let mut ok = 0usize;
    let mut fail = 0usize;
    for row in batch {
        match stmt.execute(duckdb::params![
            row.node_id.as_str(),
            row.ts_ms,
            row.tenant_id.as_str(),
            row.tok_s,
            row.watts,
            row.wes_raw,
            row.wes_penalized,
            row.thermal_cost_pct,
            row.thermal_penalty,
            row.thermal_state.as_deref(),
            row.vram_used_mb,
            row.vram_total_mb,
            row.mem_pressure_pct,
            row.gpu_pct,
            row.cpu_pct,
            row.inference_state.as_deref(),
            row.wes_version,
            Option::<&str>::None, // agent_version — Phase 4B
        ]) {
            Ok(_)  => ok += 1,
            Err(_) => fail += 1,
        }
    }
    if fail > 0 {
        eprintln!("[duck] INSERT batch: {ok} ok, {fail} failed (of {} total)", batch.len());
    }
}

/// Background task: drain the metrics channel and flush to DuckDB every 30 s
/// or when the buffer hits 512 rows (safety valve).
async fn metrics_writer_task(mut rx: mpsc::Receiver<MetricsRow>, duck: DuckDb) {
    let mut buffer: Vec<MetricsRow> = Vec::with_capacity(256);
    let mut flush_interval = tokio::time::interval(Duration::from_secs(30));
    flush_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    flush_interval.tick().await; // discard the immediate first tick

    loop {
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    None => break, // sender dropped; flush remaining and exit
                    Some(row) => {
                        buffer.push(row);
                        if buffer.len() >= 512 {
                            let batch = std::mem::take(&mut buffer);
                            let d = duck.clone();
                            tokio::task::spawn_blocking(move || {
                                flush_batch(&duck_lock(&d), &batch);
                            }).await.ok();
                        }
                    }
                }
            }
            _ = flush_interval.tick() => {
                if !buffer.is_empty() {
                    let batch = std::mem::take(&mut buffer);
                    let d = duck.clone();
                    tokio::task::spawn_blocking(move || {
                        flush_batch(&duck_lock(&d), &batch);
                    }).await.ok();
                }
            }
        }
    }

    // Final flush on shutdown
    if !buffer.is_empty() {
        let d = duck.clone();
        tokio::task::spawn_blocking(move || {
            flush_batch(&duck_lock(&d), &buffer);
        }).await.ok();
    }
}

/// Background task: drain the events channel and write to DuckDB immediately.
/// Events are rare (a few per day per node), so no batching — direct INSERT.
async fn events_writer_task(mut rx: mpsc::Receiver<EventRow>, duck: DuckDb) {
    while let Some(ev) = rx.recv().await {
        let d = duck.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let conn = duck_lock(&d);
            if let Err(e) = conn.execute(
                "INSERT INTO node_events (ts_ms, node_id, tenant_id, level, event_type, message)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT DO NOTHING",
                duckdb::params![ev.ts_ms, ev.node_id, ev.tenant_id, ev.level, ev.event_type, ev.message],
            ) {
                eprintln!("[duck] event write error: {e}");
            }
        }).await;
    }
}

// ── DuckDB — rollup & maintenance ────────────────────────────────────────────

/// Hourly: aggregate metrics_raw rows older than 24 h into 5-minute buckets,
/// then delete the raw rows that were successfully rolled up.
/// EXISTS guard on DELETE ensures we never lose data if the INSERT fails.
fn run_rollup(conn: &DuckConn) {
    let cutoff_ms: i64 = (now_ms() as i64) - 86_400_000; // 24 h ago

    // thermal_state_worst uses numeric encoding so ordering is correct:
    // Critical(3) > Serious(2) > Fair(1) > Normal(0).
    let sql = format!(r#"
        BEGIN TRANSACTION;

        INSERT INTO metrics_5min (
            node_id, ts_ms, tenant_id,
            tok_s_avg, tok_s_p50, tok_s_p95,
            watts_avg, wes_raw_avg, wes_penalized_avg, wes_penalized_min,
            thermal_cost_pct_avg, thermal_cost_pct_max, thermal_state_worst,
            mem_pressure_pct_avg, mem_pressure_pct_max, gpu_pct_avg,
            inference_duty_pct,
            sample_count, wes_version, wes_version_count, agent_version
        )
        SELECT
            node_id,
            (ts_ms / 300000) * 300000          AS ts_ms,
            tenant_id,
            AVG(tok_s)                         AS tok_s_avg,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY tok_s) AS tok_s_p50,
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY tok_s) AS tok_s_p95,
            AVG(watts)                         AS watts_avg,
            AVG(wes_raw)                       AS wes_raw_avg,
            AVG(wes_penalized)                 AS wes_penalized_avg,
            MIN(wes_penalized)                 AS wes_penalized_min,
            AVG(thermal_cost_pct)              AS thermal_cost_pct_avg,
            MAX(thermal_cost_pct)              AS thermal_cost_pct_max,
            CASE MAX(CASE thermal_state
                     WHEN 'Critical' THEN 3
                     WHEN 'Serious'  THEN 2
                     WHEN 'Fair'     THEN 1
                     ELSE 0 END)
                WHEN 3 THEN 'Critical'
                WHEN 2 THEN 'Serious'
                WHEN 1 THEN 'Fair'
                ELSE 'Normal' END              AS thermal_state_worst,
            AVG(mem_pressure_pct)              AS mem_pressure_pct_avg,
            MAX(mem_pressure_pct)              AS mem_pressure_pct_max,
            AVG(gpu_pct)                       AS gpu_pct_avg,
            -- Inference duty: % of samples in this 5-min bucket where the node was "live"
            (SUM(CASE WHEN inference_state = 'live' THEN 1 ELSE 0 END)::FLOAT / COUNT(*)::FLOAT * 100.0) AS inference_duty_pct,
            COUNT(*)::USMALLINT                AS sample_count,
            MAX(wes_version)                   AS wes_version,
            COUNT(DISTINCT wes_version)::UTINYINT AS wes_version_count,
            ANY_VALUE(agent_version)           AS agent_version
        FROM metrics_raw
        WHERE ts_ms < {cutoff_ms}
        GROUP BY node_id, tenant_id, (ts_ms / 300000) * 300000
        ON CONFLICT DO NOTHING;

        -- Only delete raw rows that were successfully rolled up (EXISTS guard).
        DELETE FROM metrics_raw
        WHERE ts_ms < {cutoff_ms}
          AND EXISTS (
              SELECT 1 FROM metrics_5min m
              WHERE m.tenant_id = metrics_raw.tenant_id
                AND m.node_id   = metrics_raw.node_id
                AND m.ts_ms     = (metrics_raw.ts_ms / 300000) * 300000
          );

        -- Prune 5-min rows older than 90 days.
        DELETE FROM metrics_5min
        WHERE ts_ms < ({cutoff_ms} - 7776000000);

        COMMIT;
    "#);

    conn.execute_batch(&sql)
        .unwrap_or_else(|e| eprintln!("[rollup] failed: {e}"));
    println!("[rollup] complete (cutoff_ms={cutoff_ms})");
}

/// Nightly (3 AM UTC): CHECKPOINT + ANALYZE to compact WAL and update stats.
/// Separated from the hourly rollup to avoid blocking the Appender writer.
fn run_nightly_maintenance(conn: &DuckConn) {
    // Prune node_events older than 30 days.
    let event_cutoff_ms = (now_ms() as i64) - 30 * 86_400_000;
    let _ = conn.execute(
        "DELETE FROM node_events WHERE ts_ms < ?",
        duckdb::params![event_cutoff_ms],
    );

    // Prune resolved/acknowledged observations older than 30 days.
    let _ = conn.execute(
        "DELETE FROM fleet_observations WHERE state != 'open' AND fired_at_ms < ?",
        duckdb::params![event_cutoff_ms],
    );

    conn.execute_batch("
        CHECKPOINT;
        ANALYZE metrics_raw;
        ANALYZE metrics_5min;
        ANALYZE node_events;
        ANALYZE fleet_observations;
    ").unwrap_or_else(|e| eprintln!("[nightly] maintenance failed: {e}"));
    println!("[nightly] CHECKPOINT + ANALYZE complete");
}

/// Hourly rollup background task.  Runs once on startup (after 60s warm-up
/// to let the first telemetry frames land), then every hour.
async fn rollup_task(duck: DuckDb) {
    // Wait 60s for initial telemetry to arrive, then run first rollup.
    tokio::time::sleep(Duration::from_secs(60)).await;
    {
        let d = duck.clone();
        tokio::task::spawn_blocking(move || run_rollup(&duck_lock(&d))).await.ok();
    }

    let mut interval = tokio::time::interval(Duration::from_secs(3600));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    interval.tick().await; // consume the immediate first tick
    loop {
        interval.tick().await;
        let d = duck.clone();
        tokio::task::spawn_blocking(move || {
            run_rollup(&duck_lock(&d));
        }).await.ok();
    }
}

/// Nightly maintenance task — fires at 3 AM UTC.
async fn nightly_task(duck: DuckDb) {
    loop {
        // Calculate seconds until next 3 AM UTC.
        let now_s = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let secs_in_day      = now_s % 86400;
        let target_in_day    = 3 * 3600_u64; // 03:00 UTC
        let sleep_secs = if secs_in_day < target_in_day {
            target_in_day - secs_in_day
        } else {
            86400 - secs_in_day + target_in_day
        };
        tokio::time::sleep(Duration::from_secs(sleep_secs)).await;
        let d = duck.clone();
        tokio::task::spawn_blocking(move || {
            run_nightly_maintenance(&duck_lock(&d));
        }).await.ok();
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
    channel_type: String,  // "slack" | "email"
    name:         String,
    config_json:  String,  // { "webhook_url": "..." } or { "address": "..." }
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

/// Post a message to a Slack incoming webhook URL.
/// Returns true on success.
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

/// Send a transactional email via Resend.
/// RESEND_API_KEY env var must be set.  FROM_EMAIL defaults to alerts@wicklee.dev.
fn send_email(to: &str, subject: &str, text: &str, html: &str) -> bool {
    let api_key = match std::env::var("RESEND_API_KEY") {
        Ok(k) => k,
        Err(_) => {
            eprintln!("[email] RESEND_API_KEY not set — skipping delivery");
            return false;
        }
    };
    let from = std::env::var("FROM_EMAIL")
        .unwrap_or_else(|_| "Wicklee Alerts <alerts@wicklee.dev>".to_string());

    let payload = serde_json::json!({
        "from":    from,
        "to":      [to],
        "subject": subject,
        "text":    text,
        "html":    html,
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

// ── Alerting — payload builders ───────────────────────────────────────────────

/// Build a Slack Block Kit payload for a firing alert.
fn slack_alert_blocks(
    node_id:    &str,
    event_type: &str,
    detail:     &str,
    resolved:   bool,
) -> String {
    let (icon, color_word) = if resolved {
        ("✅", "Recovered")
    } else {
        match event_type {
            "thermal_critical"      => ("🔥", "Critical"),
            "thermal_serious"       => ("⚠️",  "Warning"),
            "thermal_drain"         => ("🌡️",  "Thermal Drain"),
            "memory_pressure_high"  => ("💾", "Warning"),
            "memory_trajectory"     => ("📈", "Memory Trajectory"),
            "wes_drop"              => ("📉", "Warning"),
            "wes_velocity_drop"     => ("📉", "WES Declining"),
            "phantom_load"          => ("⚡", "Phantom Load"),
            "node_offline"          => ("🔴", "Offline"),
            _                       => ("⚡", "Alert"),
        }
    };
    let title = if resolved {
        format!("{icon} {node_id} — Recovered ({event_type})")
    } else {
        format!("{icon} {node_id} — {color_word}")
    };
    serde_json::json!([
        {
            "type": "header",
            "text": { "type": "plain_text", "text": title }
        },
        {
            "type": "section",
            "text": { "type": "mrkdwn", "text": detail }
        },
        {
            "type": "context",
            "elements": [{
                "type": "mrkdwn",
                "text": format!("Wicklee · <https://wicklee.dev|View Dashboard>")
            }]
        }
    ]).to_string()
}

/// Build plain-text + HTML email body for an alert.
fn email_alert_body(
    node_id:    &str,
    event_type: &str,
    detail:     &str,
    resolved:   bool,
) -> (String, String) {
    let state_word = if resolved { "RECOVERED" } else { "FIRING" };
    let subject_prefix = if resolved { "✅ Recovered" } else { "⚠️ Alert" };
    let text = format!(
        "{subject_prefix}: {node_id} — {event_type}\n\n{detail}\n\nView dashboard: https://wicklee.dev",
    );
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

// ── Alerting — core evaluation ────────────────────────────────────────────────

/// Evaluate active alert rules for a single telemetry frame.
/// Called synchronously inside `handle_telemetry`'s spawn_blocking block.
fn evaluate_alerts(
    user_id:  &str,
    node_id:  &str,
    metrics:  &MetricsPayload,
    conn:     &Connection,
) {
    // Load enabled rules for this user that apply to this node (or fleet-wide).
    let mut stmt = match conn.prepare(
        "SELECT ar.id, ar.event_type, ar.threshold_value, ar.urgency,
                nc.channel_type, nc.config_json
         FROM   alert_rules ar
         JOIN   notification_channels nc ON nc.id = ar.channel_id
         WHERE  ar.user_id  = ?1
           AND  ar.enabled  = 1
           AND  (ar.node_id IS NULL OR ar.node_id = ?2)",
    ) {
        Ok(s)  => s,
        Err(e) => { eprintln!("[alerts] prepare failed: {e}"); return; }
    };

    struct RuleRow {
        id:              String,
        event_type:      String,
        threshold_value: f64,
        urgency:         String,
        channel_type:    String,
        config_json:     String,
    }

    let rules: Vec<RuleRow> = match stmt.query_map(params![user_id, node_id], |r| {
        Ok(RuleRow {
            id:              r.get(0)?,
            event_type:      r.get(1)?,
            threshold_value: r.get::<_, Option<f64>>(2)?.unwrap_or(0.0),
            urgency:         r.get(3)?,
            channel_type:    r.get(4)?,
            config_json:     r.get(5)?,
        })
    }) {
        Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
        Err(e)   => { eprintln!("[alerts] query failed: {e}"); return; }
    };

    let now = now_ms();

    for rule in &rules {
        // ── Evaluate condition ──────────────────────────────────────────────
        let firing = match rule.event_type.as_str() {
            "thermal_serious"  => matches!(
                metrics.thermal_state.as_deref(),
                Some("Serious") | Some("Critical")
            ),
            "thermal_critical" => matches!(
                metrics.thermal_state.as_deref(),
                Some("Critical")
            ),
            "memory_pressure_high" => {
                let threshold = if rule.threshold_value > 0.0 { rule.threshold_value as f32 } else { 85.0 };
                metrics.memory_pressure_percent
                    .map(|p| p > threshold)
                    .unwrap_or(false)
            }
            "wes_drop" => {
                let threshold = if rule.threshold_value > 0.0 { rule.threshold_value as f32 } else { 5.0 };
                wes_for_payload(metrics)
                    .map(|w| w < threshold)
                    .unwrap_or(false)
            }
            // ── Pattern Engine alert types ──────────────────────────────────────
            //
            // These are server-side proxy conditions that approximate the client-side
            // pattern engine's time-windowed detections. They fire on a single telemetry
            // frame; the frontend pattern engine provides richer trend-based analysis.
            //
            // thermal_drain: non-Normal thermal state with a measurable efficiency
            //   penalty (penalized WES below threshold). Fires before thermal_critical
            //   but after the node has crossed into Fair/Serious thermal territory.
            //   Default threshold: WES < 6.0 (penalized).
            "thermal_drain" => {
                let threshold = if rule.threshold_value > 0.0 { rule.threshold_value as f32 } else { 6.0 };
                let is_throttled = matches!(
                    metrics.thermal_state.as_deref(),
                    Some("Fair") | Some("Serious") | Some("Critical")
                );
                if !is_throttled { false } else {
                    wes_for_payload(metrics).map(|w| w < threshold).unwrap_or(false)
                }
            }
            // phantom_load: a model is loaded and drawing power but no inference
            //   activity is happening. Proxy: watts > threshold AND vram > 1 GB (or
            //   an Ollama model is active) AND tok/s is effectively zero.
            //   Default threshold: watts > 15W.
            "phantom_load" => {
                let watts_threshold = if rule.threshold_value > 0.0 { rule.threshold_value as f32 } else { 15.0 };
                let watts = metrics.nvidia_power_draw_w.or(metrics.cpu_power_w).unwrap_or(0.0);
                let tok_s  = if metrics.vllm_running {
                    metrics.vllm_tokens_per_sec
                } else {
                    metrics.ollama_tokens_per_second
                };
                let model_loaded = metrics.nvidia_vram_used_mb.map(|v| v >= 1024).unwrap_or(false)
                    || metrics.ollama_active_model.is_some();
                watts > watts_threshold
                    && model_loaded
                    && tok_s.map(|t| t < 0.5).unwrap_or(true)
            }
            // wes_velocity_drop: WES is in a "warning zone" — below the velocity-drop
            //   threshold but NOT yet at the critical wes_drop level, AND thermal state
            //   is not already Serious/Critical (avoids duplicate with thermal_serious).
            //   Acts as an early-warning complement to wes_drop.
            //   Default threshold: WES < 7.0 (penalized).
            "wes_velocity_drop" => {
                let threshold = if rule.threshold_value > 0.0 { rule.threshold_value as f32 } else { 7.0 };
                let not_thermal = !matches!(
                    metrics.thermal_state.as_deref(),
                    Some("Serious") | Some("Critical")
                );
                not_thermal && wes_for_payload(metrics).map(|w| w < threshold).unwrap_or(false)
            }
            // memory_trajectory: memory pressure is in the early-warning zone before
            //   the memory_pressure_high threshold — fires between 65% and 80%.
            //   Default threshold: 65% (pattern engine suppresses at ≥ 80%).
            "memory_trajectory" => {
                let lo_threshold = if rule.threshold_value > 0.0 { rule.threshold_value as f32 } else { 65.0 };
                metrics.memory_pressure_percent
                    .map(|p| p >= lo_threshold && p < 80.0)
                    .unwrap_or(false)
            }
            _ => continue, // node_offline is handled by the interval task
        };

        // ── Check existing open alert for this rule + node ──────────────────
        let open_event: Option<(String, Option<i64>)> = conn.query_row(
            "SELECT id, quiet_until_ms FROM alert_events
             WHERE rule_id = ?1 AND node_id = ?2 AND resolved_at IS NULL
             ORDER BY triggered_at DESC LIMIT 1",
            params![rule.id, node_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?)),
        ).ok();

        // ── Debounce / urgency window check ────────────────────────────────
        let debounce_ms: u64 = match rule.urgency.as_str() {
            "immediate"      => 0,
            "debounce_5m"    => 5 * 60_000,
            "debounce_15m"   => 15 * 60_000,
            _                => 0,
        };

        if firing {
            // Skip if in flap-suppression quiet period
            if let Some((_, Some(quiet_until))) = &open_event {
                if now < *quiet_until as u64 { continue; }
            }
            // Skip if already open (don't re-fire same alert)
            if open_event.is_some() { continue; }

            // Check last resolved event for debounce window
            if debounce_ms > 0 {
                let last_resolved_at: Option<i64> = conn.query_row(
                    "SELECT MAX(resolved_at) FROM alert_events
                     WHERE rule_id = ?1 AND node_id = ?2 AND resolved_at IS NOT NULL",
                    params![rule.id, node_id],
                    |r| r.get(0),
                ).ok().flatten();
                if let Some(last_res) = last_resolved_at {
                    if now < (last_res as u64).saturating_add(debounce_ms) { continue; }
                }
            }

            // ── Build detail string ─────────────────────────────────────────
            let detail = match rule.event_type.as_str() {
                "thermal_serious" | "thermal_critical" => format!(
                    "Thermal state: *{}*\nWES: {:.1} · Watts: {:.1}W",
                    metrics.thermal_state.as_deref().unwrap_or("—"),
                    wes_for_payload(metrics).unwrap_or(0.0),
                    metrics.nvidia_power_draw_w.or(metrics.cpu_power_w).unwrap_or(0.0),
                ),
                "memory_pressure_high" => format!(
                    "Memory pressure: *{:.0}%*  (threshold: {:.0}%)\n{:.1} GB used / {:.1} GB total",
                    metrics.memory_pressure_percent.unwrap_or(0.0),
                    if rule.threshold_value > 0.0 { rule.threshold_value } else { 85.0 },
                    metrics.used_memory_mb as f64 / 1024.0,
                    metrics.total_memory_mb as f64 / 1024.0,
                ),
                "wes_drop" => format!(
                    "WES: *{:.1}*  (threshold: {:.1})\nTok/s: {:.1}  Watts: {:.1}W  Thermal: {}",
                    wes_for_payload(metrics).unwrap_or(0.0),
                    if rule.threshold_value > 0.0 { rule.threshold_value } else { 5.0 },
                    metrics.ollama_tokens_per_second.or(metrics.vllm_tokens_per_sec).unwrap_or(0.0),
                    metrics.nvidia_power_draw_w.or(metrics.cpu_power_w).unwrap_or(0.0),
                    metrics.thermal_state.as_deref().unwrap_or("—"),
                ),
                "thermal_drain" => {
                    let penalty = thermal_penalty_for(metrics.thermal_state.as_deref());
                    format!(
                        "Thermal: *{}*  (penalty ×{:.2})\nWES: {:.1}  Tok/s: {:.1}  Watts: {:.1}W\n\
                         Route requests away to preserve throughput.",
                        metrics.thermal_state.as_deref().unwrap_or("—"),
                        penalty,
                        wes_for_payload(metrics).unwrap_or(0.0),
                        metrics.ollama_tokens_per_second.or(metrics.vllm_tokens_per_sec).unwrap_or(0.0),
                        metrics.nvidia_power_draw_w.or(metrics.cpu_power_w).unwrap_or(0.0),
                    )
                }
                "phantom_load" => {
                    let watts  = metrics.nvidia_power_draw_w.or(metrics.cpu_power_w).unwrap_or(0.0);
                    let vram   = metrics.nvidia_vram_used_mb.unwrap_or(0);
                    let model  = metrics.ollama_active_model.as_deref().unwrap_or("unknown");
                    format!(
                        "Drawing *{:.0}W* with {:.1} GB VRAM allocated — no inference activity.\n\
                         Model: {}  |  Tok/s: 0\n\
                         Unload the idle model to reclaim VRAM and reduce power draw.",
                        watts,
                        vram as f64 / 1024.0,
                        model,
                    )
                }
                "wes_velocity_drop" => format!(
                    "WES: *{:.1}*  (early-warning threshold: {:.1})\n\
                     Tok/s: {:.1}  Watts: {:.1}W  Thermal: {}\n\
                     Efficiency is declining — check for thermal buildup or competing processes.",
                    wes_for_payload(metrics).unwrap_or(0.0),
                    if rule.threshold_value > 0.0 { rule.threshold_value } else { 7.0 },
                    metrics.ollama_tokens_per_second.or(metrics.vllm_tokens_per_sec).unwrap_or(0.0),
                    metrics.nvidia_power_draw_w.or(metrics.cpu_power_w).unwrap_or(0.0),
                    metrics.thermal_state.as_deref().unwrap_or("Normal"),
                ),
                "memory_trajectory" => format!(
                    "Memory pressure: *{:.0}%*  (warning threshold: {:.0}%  |  critical: 85%)\n\
                     {:.1} GB used / {:.1} GB total\n\
                     Pressure is rising — unload models or stop background processes now.",
                    metrics.memory_pressure_percent.unwrap_or(0.0),
                    if rule.threshold_value > 0.0 { rule.threshold_value } else { 65.0 },
                    metrics.used_memory_mb as f64 / 1024.0,
                    metrics.total_memory_mb as f64 / 1024.0,
                ),
                _ => String::new(),
            };

            // ── Fire notification ───────────────────────────────────────────
            let fired = deliver_alert(
                &rule.channel_type,
                &rule.config_json,
                node_id,
                &rule.event_type,
                &detail,
                false,
            );
            if fired {
                let event_id = Uuid::new_v4().to_string();
                let _ = conn.execute(
                    "INSERT INTO alert_events (id, rule_id, node_id, triggered_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![event_id, rule.id, node_id, now as i64],
                );
                println!("[alerts] fired {}/{node_id} → {}", rule.event_type, rule.channel_type);
            }

        } else {
            // Condition cleared — resolve any open alert and send recovery notification.
            if let Some((event_id, _)) = open_event {
                let quiet_until = (now + ALERT_QUIET_PERIOD_MS) as i64;
                let _ = conn.execute(
                    "UPDATE alert_events SET resolved_at = ?1, quiet_until_ms = ?2
                     WHERE id = ?3",
                    params![now as i64, quiet_until, event_id],
                );
                // Only send recovery message for immediate urgency (not digests)
                if rule.urgency == "immediate" || rule.urgency == "debounce_5m" {
                    deliver_alert(
                        &rule.channel_type,
                        &rule.config_json,
                        node_id,
                        &rule.event_type,
                        "Condition has cleared.",
                        true,
                    );
                }
                println!("[alerts] resolved {}/{node_id}", rule.event_type);
            }
        }
    }
}

/// Dispatch a notification to the configured channel.
/// Returns true if delivery succeeded.
fn deliver_alert(
    channel_type: &str,
    config_json:  &str,
    node_id:      &str,
    event_type:   &str,
    detail:       &str,
    resolved:     bool,
) -> bool {
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
            let subject_prefix = if resolved { "✅ Recovered" } else { "⚠️ Alert" };
            let subject = format!("{subject_prefix}: {node_id} — {event_type}");
            let (text, html) = email_alert_body(node_id, event_type, detail, resolved);
            send_email(&addr, &subject, &text, &html)
        }
        _ => { eprintln!("[alerts] unknown channel_type: {channel_type}"); false }
    }
}

// ── Alerting — node offline interval task ────────────────────────────────────

/// Runs every 60 seconds.  Detects node offline/online transitions and writes
/// events to the DuckDB `node_events` table (visible in Fleet Event Timeline).
/// Also fires `node_offline` alerts for Team+ users with configured rules.
async fn node_offline_alert_task(state: AppState) {
    // In-memory set of nodes we've already marked offline this process lifetime.
    // Prevents duplicate "offline" events on every 60-second tick.
    let mut known_offline: std::collections::HashSet<String> = std::collections::HashSet::new();

    let mut interval = tokio::time::interval(Duration::from_secs(60));
    interval.tick().await; // skip immediate first tick
    loop {
        interval.tick().await;
        let state2 = state.clone();
        let mut offline_snapshot = known_offline.clone();
        let (new_offline, new_online) = tokio::task::spawn_blocking(move || {
            let conn = state2.db.lock().unwrap();
            let now  = now_ms();
            let offline_threshold_ms = 5 * 60_000_u64; // 5 minutes
            let mut went_offline: Vec<(String, String, String, u64)> = Vec::new(); // (user_id, node_id, tenant_id, elapsed)
            let mut came_online:  Vec<(String, String, String)> = Vec::new();      // (user_id, node_id, tenant_id)

            // Load all user_id → node_id pairs with their last_seen timestamps.
            let nodes: Vec<(String, String, u64, String)> = {
                let mut stmt = match conn.prepare(
                    "SELECT n.user_id, n.wk_id, n.last_seen
                     FROM nodes n WHERE n.user_id IS NOT NULL"
                ) { Ok(s) => s, Err(_) => return (vec![], vec![]) };
                match stmt.query_map([], |r| Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2).map(|v| v as u64)?,
                    r.get::<_, String>(0)?, // tenant_id = user_id
                ))) {
                    Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
                    Err(_)   => return (vec![], vec![]),
                }
            };

            for (user_id, node_id, last_seen, tenant_id) in &nodes {
                let elapsed = now.saturating_sub(*last_seen);

                if elapsed >= offline_threshold_ms {
                    // Node is offline
                    if !offline_snapshot.contains(node_id) {
                        went_offline.push((user_id.clone(), node_id.clone(), tenant_id.clone(), elapsed));
                        offline_snapshot.insert(node_id.clone());
                    }
                } else {
                    // Node is online — check if it was previously offline (recovery)
                    if offline_snapshot.remove(node_id) {
                        came_online.push((user_id.clone(), node_id.clone(), tenant_id.clone()));
                    }
                }
            }

            // ── Fire alerts for nodes that just went offline ──────────────
            for (user_id, node_id, _tenant_id, elapsed) in &went_offline {
                // Check subscription tier — alerting delivery is Team+.
                let tier: Option<String> = conn.query_row(
                    "SELECT subscription_tier FROM users WHERE id = ?1",
                    params![user_id],
                    |r| r.get(0),
                ).ok();
                if !is_team_or_above(tier.as_deref().unwrap_or("community")) { continue; }

                let rules: Vec<(String, String, String)> = {
                    let mut stmt = match conn.prepare(
                        "SELECT ar.id, nc.channel_type, nc.config_json
                         FROM   alert_rules ar
                         JOIN   notification_channels nc ON nc.id = ar.channel_id
                         WHERE  ar.user_id = ?1
                           AND  ar.event_type = 'node_offline'
                           AND  ar.enabled = 1
                           AND  (ar.node_id IS NULL OR ar.node_id = ?2)",
                    ) { Ok(s) => s, Err(_) => continue };
                    match stmt.query_map(params![user_id, node_id], |r| Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))) {
                        Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
                        Err(_)   => continue,
                    }
                };

                for (rule_id, channel_type, config_json) in rules {
                    let open: Option<String> = conn.query_row(
                        "SELECT id FROM alert_events
                         WHERE rule_id = ?1 AND node_id = ?2 AND resolved_at IS NULL
                         LIMIT 1",
                        params![rule_id, node_id],
                        |r| r.get(0),
                    ).ok();
                    if open.is_some() { continue; }

                    let minutes = elapsed / 60_000;
                    let detail  = format!("Node has not reported telemetry in *{minutes} minutes*.");
                    let fired   = deliver_alert(&channel_type, &config_json, node_id, "node_offline", &detail, false);
                    if fired {
                        let event_id = Uuid::new_v4().to_string();
                        let _ = conn.execute(
                            "INSERT INTO alert_events (id, rule_id, node_id, triggered_at)
                             VALUES (?1, ?2, ?3, ?4)",
                            params![event_id, rule_id, node_id, now as i64],
                        );
                        println!("[alerts] node_offline fired for {node_id}");
                    }
                }
            }

            // ── Resolve open alerts for nodes that came back online ───────
            for (user_id, node_id, _tenant_id) in &came_online {
                let tier: Option<String> = conn.query_row(
                    "SELECT subscription_tier FROM users WHERE id = ?1",
                    params![user_id],
                    |r| r.get(0),
                ).ok();
                if !is_team_or_above(tier.as_deref().unwrap_or("community")) { continue; }

                // Resolve all open node_offline alert events for this node.
                let _ = conn.execute(
                    "UPDATE alert_events SET resolved_at = ?1
                     WHERE node_id = ?2 AND resolved_at IS NULL",
                    params![now as i64, node_id],
                );
                println!("[alerts] node_online — resolved alerts for {node_id}");
            }

            (went_offline, came_online)
        }).await.unwrap_or_default();

        // ── Persist offline/online events to DuckDB (visible in Fleet Event Timeline) ──
        // Dedup: skip if a node_offline event was already written for this node
        // within the last hour (guards against process restarts on Railway).
        for (_user_id, node_id, tenant_id, elapsed) in &new_offline {
            let duck = state.duck_db.clone();
            let nid = node_id.clone();
            let tid = tenant_id.clone();
            let cutoff = (now_ms() as i64) - 3_600_000; // 1 hour ago
            let already_exists = tokio::task::spawn_blocking(move || {
                let conn = duck_lock(&duck);
                conn.query_row(
                    "SELECT 1 FROM node_events WHERE tenant_id = ? AND node_id = ? AND event_type = 'node_offline' AND ts_ms > ? LIMIT 1",
                    duckdb::params![tid, nid, cutoff],
                    |_| Ok(true),
                ).unwrap_or(false)
            }).await.unwrap_or(false);

            if !already_exists {
                let minutes = elapsed / 60_000;
                let _ = state.events_tx.try_send(EventRow {
                    ts_ms:      now_ms() as i64,
                    node_id:    node_id.clone(),
                    tenant_id:  tenant_id.clone(),
                    level:      "error".into(),
                    event_type: Some("node_offline".into()),
                    message:    format!("Node offline — no telemetry received for {minutes}m"),
                });

                // Also write a fleet_observation for the Triage tab.
                let duck2 = state.duck_db.clone();
                let obs_id = Uuid::new_v4().to_string();
                let nid2 = node_id.clone();
                let tid2 = tenant_id.clone();
                let minutes = elapsed / 60_000;
                let now_i64 = now_ms() as i64;
                let _ = tokio::task::spawn_blocking(move || {
                    let conn = duck_lock(&duck2);
                    conn.execute(
                        "INSERT INTO fleet_observations
                         (id, tenant_id, node_id, alert_type, severity, state, title, detail, context_json, fired_at_ms)
                         VALUES (?, ?, ?, 'node_offline', 'critical', 'open', ?, ?, ?, ?)
                         ON CONFLICT DO NOTHING",
                        duckdb::params![
                            obs_id, tid2, nid2,
                            "Node Offline",
                            format!("Node has not reported telemetry in {minutes} minutes."),
                            format!(r#"{{"elapsed_minutes":{minutes}}}"#),
                            now_i64,
                        ],
                    )
                }).await;
            }
            known_offline.insert(node_id.clone());
        }

        for (_user_id, node_id, tenant_id) in &new_online {
            let _ = state.events_tx.try_send(EventRow {
                ts_ms:      now_ms() as i64,
                node_id:    node_id.clone(),
                tenant_id:  tenant_id.clone(),
                level:      "info".into(),
                event_type: Some("node_online".into()),
                message:    "Node back online — telemetry resumed".into(),
            });
            // Auto-resolve any open node_offline observation for this node.
            let duck = state.duck_db.clone();
            let nid = node_id.clone();
            let tid = tenant_id.clone();
            let now_i64 = now_ms() as i64;
            let _ = tokio::task::spawn_blocking(move || {
                let conn = duck_lock(&duck);
                conn.execute(
                    "UPDATE fleet_observations SET state = 'resolved', resolved_at_ms = ?
                     WHERE tenant_id = ? AND node_id = ? AND alert_type = 'node_offline' AND state = 'open'",
                    duckdb::params![now_i64, tid, nid],
                )
            }).await;
            known_offline.remove(node_id);
        }
    }
}

// ── Phase 4B — Fleet Alert Evaluator (Essential Four) ─────────────────────────

/// Per-node ring buffer for sustained-threshold checks.
/// Stores the last N evaluation ticks (60s each) worth of metric snapshots.
struct NodeRingBuffer {
    /// Circular buffer of (timestamp_ms, inference_state, thermal_state, mem_pressure_pct, wes_penalized).
    entries: Vec<(u64, Option<String>, Option<String>, Option<f32>, Option<f32>)>,
    head: usize,
    len: usize,
}

impl NodeRingBuffer {
    fn new(capacity: usize) -> Self {
        Self {
            entries: vec![(0, None, None, None, None); capacity],
            head: 0,
            len: 0,
        }
    }

    fn push(&mut self, ts_ms: u64, inf_state: Option<String>, thermal: Option<String>, mem_pct: Option<f32>, wes: Option<f32>) {
        self.entries[self.head] = (ts_ms, inf_state, thermal, mem_pct, wes);
        self.head = (self.head + 1) % self.entries.len();
        if self.len < self.entries.len() {
            self.len += 1;
        }
    }

    /// Returns the number of consecutive recent ticks (from newest backward) where the predicate holds.
    fn consecutive_ticks<F: Fn(&(u64, Option<String>, Option<String>, Option<f32>, Option<f32>)) -> bool>(&self, pred: F) -> usize {
        let mut count = 0;
        for i in 0..self.len {
            let idx = (self.head + self.entries.len() - 1 - i) % self.entries.len();
            if pred(&self.entries[idx]) {
                count += 1;
            } else {
                break;
            }
        }
        count
    }
}

/// Observation severity — maps to card color in the Triage tab.
#[allow(dead_code)]
enum ObsSeverity {
    Warning,
    Critical,
}

impl ObsSeverity {
    fn as_str(&self) -> &'static str {
        match self { Self::Warning => "warning", Self::Critical => "critical" }
    }
}

/// Runs every 60 seconds.  Evaluates the Essential Four alert conditions against
/// the live in-memory metrics cache.  Uses per-node ring buffers for "sustained"
/// threshold checks.  Writes to both `node_events` (flat log for timeline) and
/// `fleet_observations` (stateful for triage).
///
/// Essential Four:
///   1. Zombied Engine — inference_state == "busy" sustained >10min → critical
///   2. Thermal Redline — thermal_state == "Critical" sustained >2min → critical
///   3. OOM Warning — memory_pressure_percent > 95% sustained >1min → warning
///   4. WES Cliff — current WES < 50% of 24h baseline → warning
async fn fleet_alert_evaluator_task(state: AppState) {
    // Per-node ring buffers — 15 ticks × 60s = 15 minutes of history.
    let mut ring_buffers: HashMap<String, NodeRingBuffer> = HashMap::new();

    // Track which observations are currently open per (node_id, alert_type).
    // Value = observation ID.  Prevents duplicate fires on every tick.
    let mut open_observations: HashMap<(String, String), String> = HashMap::new();

    // Cache 24h WES baselines per node (refreshed every 10 ticks = 10 min).
    let mut wes_baselines: HashMap<String, f32> = HashMap::new();
    let mut baseline_refresh_counter: u32 = 0;

    let mut interval = tokio::time::interval(Duration::from_secs(60));
    interval.tick().await; // skip immediate first tick
    // Wait 120s on startup for telemetry + ring buffers to fill.
    tokio::time::sleep(Duration::from_secs(120)).await;

    loop {
        interval.tick().await;
        let now = now_ms();

        // ── Refresh 24h WES baselines every 10 min ───────────────────────────
        baseline_refresh_counter += 1;
        if baseline_refresh_counter >= 10 || wes_baselines.is_empty() {
            baseline_refresh_counter = 0;
            let duck = state.duck_db.clone();
            if let Ok(baselines) = tokio::task::spawn_blocking(move || {
                let conn = duck_lock(&duck);
                let cutoff = (now as i64) - 86_400_000; // 24h ago
                let mut stmt = conn.prepare(
                    "SELECT node_id, AVG(wes_penalized) FROM metrics_raw
                     WHERE ts_ms > ? AND wes_penalized IS NOT NULL
                     GROUP BY node_id"
                )?;
                let rows: Vec<(String, f32)> = stmt.query_map(duckdb::params![cutoff], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)? as f32))
                })?.filter_map(|r| r.ok()).collect();
                Ok::<_, duckdb::Error>(rows)
            }).await.unwrap_or(Err(duckdb::Error::InvalidQuery)) {
                wes_baselines.clear();
                for (nid, avg) in baselines {
                    wes_baselines.insert(nid, avg);
                }
            }
        }

        // ── Snapshot current metrics from live cache ─────────────────────────
        let snapshot: Vec<(String, MetricsPayload)> = {
            let cache = state.metrics.read().unwrap();
            cache.iter()
                .filter_map(|(nid, entry)| {
                    // Only consider nodes with recent telemetry (< 5 min).
                    if now.saturating_sub(entry.last_seen_ms) > 300_000 { return None; }
                    entry.metrics.as_ref().map(|m| (nid.clone(), m.clone()))
                })
                .collect()
        };

        // ── Evaluate each node ───────────────────────────────────────────────
        struct PendingObs {
            node_id:    String,
            alert_type: String,
            severity:   ObsSeverity,
            title:      String,
            detail:     String,
            context:    serde_json::Value,
        }
        let mut to_fire: Vec<PendingObs> = Vec::new();
        let mut to_resolve: Vec<(String, String)> = Vec::new(); // (node_id, alert_type)

        for (node_id, m) in &snapshot {
            // Update ring buffer for this node.
            let ring = ring_buffers
                .entry(node_id.clone())
                .or_insert_with(|| NodeRingBuffer::new(15));

            let mem_pct = m.memory_pressure_percent;
            let wes = {
                let watts = m.nvidia_power_draw_w.or(m.apple_soc_power_w).or(m.cpu_power_w);
                let tok_s = if m.vllm_running { m.vllm_tokens_per_sec } else { m.ollama_tokens_per_second };
                match (tok_s, watts) {
                    (Some(t), Some(w)) if w > 0.0 => {
                        let penalty = thermal_penalty_for(m.thermal_state.as_deref());
                        Some(t / (w * penalty) * 10.0)
                    }
                    _ => None,
                }
            };
            ring.push(now, m.inference_state.clone(), m.thermal_state.clone(), mem_pct, wes);

            // ── 1. Zombied Engine: busy >10min (10 consecutive ticks) → critical ──
            {
                let alert_type = "zombied_engine";
                let busy_ticks = ring.consecutive_ticks(|e| e.1.as_deref() == Some("busy"));
                let threshold = 10; // 10 × 60s = 10 min
                let is_firing = busy_ticks >= threshold;
                let is_open = open_observations.contains_key(&(node_id.clone(), alert_type.into()));

                if is_firing && !is_open {
                    to_fire.push(PendingObs {
                        node_id: node_id.clone(),
                        alert_type: alert_type.into(),
                        severity: ObsSeverity::Critical,
                        title: "Zombied Engine Detected".into(),
                        detail: format!("Inference state has been 'busy' for >{} minutes without completing. The engine may be deadlocked.", busy_ticks),
                        context: serde_json::json!({
                            "inference_state": "busy",
                            "sustained_minutes": busy_ticks,
                            "active_model": m.ollama_active_model.as_deref().or(m.vllm_model_name.as_deref()),
                        }),
                    });
                } else if !is_firing && is_open {
                    to_resolve.push((node_id.clone(), alert_type.into()));
                }
            }

            // ── 2. Thermal Redline: thermal_state == "Critical" >2min (2 ticks) → critical ──
            {
                let alert_type = "thermal_redline";
                let critical_ticks = ring.consecutive_ticks(|e| e.2.as_deref() == Some("Critical"));
                let threshold = 2; // 2 × 60s = 2 min
                let is_firing = critical_ticks >= threshold;
                let is_open = open_observations.contains_key(&(node_id.clone(), alert_type.into()));

                if is_firing && !is_open {
                    to_fire.push(PendingObs {
                        node_id: node_id.clone(),
                        alert_type: alert_type.into(),
                        severity: ObsSeverity::Critical,
                        title: "Thermal Redline — Critical Temperature".into(),
                        detail: format!("Thermal state has been Critical for >{} minutes. Hardware throttling is active.", critical_ticks),
                        context: serde_json::json!({
                            "thermal_state": "Critical",
                            "sustained_minutes": critical_ticks,
                            "gpu_temp_c": m.nvidia_gpu_temp_c,
                        }),
                    });
                } else if !is_firing && is_open {
                    to_resolve.push((node_id.clone(), alert_type.into()));
                }
            }

            // ── 3. OOM Warning: memory_pressure > 95% >1min (1 tick) → warning ──
            {
                let alert_type = "oom_warning";
                let oom_ticks = ring.consecutive_ticks(|e| e.3.map_or(false, |p| p > 95.0));
                let threshold = 1;
                let is_firing = oom_ticks >= threshold;
                let is_open = open_observations.contains_key(&(node_id.clone(), alert_type.into()));

                if is_firing && !is_open {
                    let pct = mem_pct.unwrap_or(0.0);
                    to_fire.push(PendingObs {
                        node_id: node_id.clone(),
                        alert_type: alert_type.into(),
                        severity: ObsSeverity::Warning,
                        title: "Memory Pressure Critical — OOM Risk".into(),
                        detail: format!("Memory pressure at {:.1}% — system is at risk of OOM. Consider evicting idle models.", pct),
                        context: serde_json::json!({
                            "memory_pressure_pct": pct,
                            "used_memory_mb": m.used_memory_mb,
                            "total_memory_mb": m.total_memory_mb,
                            "active_model": m.ollama_active_model.as_deref().or(m.vllm_model_name.as_deref()),
                        }),
                    });
                } else if !is_firing && is_open {
                    to_resolve.push((node_id.clone(), alert_type.into()));
                }
            }

            // ── 4. WES Cliff: current WES < 50% of 24h baseline → warning ──
            {
                let alert_type = "wes_cliff";
                if let (Some(current_wes), Some(&baseline)) = (wes, wes_baselines.get(node_id)) {
                    let is_firing = baseline > 0.0 && current_wes < baseline * 0.5;
                    let is_open = open_observations.contains_key(&(node_id.clone(), alert_type.into()));

                    if is_firing && !is_open {
                        to_fire.push(PendingObs {
                            node_id: node_id.clone(),
                            alert_type: alert_type.into(),
                            severity: ObsSeverity::Warning,
                            title: "WES Cliff — Efficiency Collapse".into(),
                            detail: format!("WES dropped to {:.1} (24h baseline: {:.1}). Efficiency has fallen below 50% of normal.", current_wes, baseline),
                            context: serde_json::json!({
                                "current_wes": current_wes,
                                "baseline_wes_24h": baseline,
                                "drop_pct": ((baseline - current_wes) / baseline * 100.0) as i32,
                                "thermal_state": m.thermal_state,
                            }),
                        });
                    } else if !is_firing && is_open {
                        to_resolve.push((node_id.clone(), alert_type.into()));
                    }
                }
            }
        }

        // ── 5. Agent Version Mismatch: node version differs from fleet majority → warning ──
        {
            // Compute fleet majority version (mode).
            let mut version_counts: HashMap<String, u32> = HashMap::new();
            for (_, m) in &snapshot {
                if let Some(ref v) = m.agent_version {
                    *version_counts.entry(v.clone()).or_insert(0) += 1;
                }
            }
            let majority_version = version_counts.iter()
                .max_by_key(|(_, count)| *count)
                .map(|(v, _)| v.clone());

            if let Some(ref majority) = majority_version {
                // Only alert if fleet has > 1 node reporting versions.
                let total_versioned = version_counts.values().sum::<u32>();
                if total_versioned > 1 {
                    for (node_id, m) in &snapshot {
                        let alert_type = "agent_version_mismatch";
                        if let Some(ref node_ver) = m.agent_version {
                            let is_firing = node_ver != majority;
                            let is_open = open_observations.contains_key(&(node_id.clone(), alert_type.into()));

                            if is_firing && !is_open {
                                to_fire.push(PendingObs {
                                    node_id: node_id.clone(),
                                    alert_type: alert_type.into(),
                                    severity: ObsSeverity::Warning,
                                    title: "Agent Version Mismatch".into(),
                                    detail: format!(
                                        "Running v{} while the fleet majority is v{}. Update with: curl -fsSL https://wicklee.dev/install.sh | bash",
                                        node_ver, majority
                                    ),
                                    context: serde_json::json!({
                                        "node_version": node_ver,
                                        "fleet_majority": majority,
                                        "fleet_node_count": total_versioned,
                                    }),
                                });
                            } else if !is_firing && is_open {
                                to_resolve.push((node_id.clone(), alert_type.into()));
                            }
                        }
                    }
                }
            }
        }

        // ── Also auto-resolve observations for nodes that are no longer online ──
        let online_nodes: HashSet<String> = snapshot.iter().map(|(nid, _)| nid.clone()).collect();
        let stale_keys: Vec<(String, String)> = open_observations.keys()
            .filter(|(nid, _)| !online_nodes.contains(nid))
            .cloned()
            .collect();
        for _key in stale_keys {
            // Don't auto-resolve for offline nodes — they'll get a node_offline observation instead.
            // Just clean up the in-memory tracking; the DuckDB row stays open.
        }

        // ── Write observations to DuckDB ─────────────────────────────────────
        if !to_fire.is_empty() || !to_resolve.is_empty() {
            // Resolve tenant_ids for affected nodes.
            let affected_nodes: HashSet<String> = to_fire.iter().map(|o| o.node_id.clone())
                .chain(to_resolve.iter().map(|(nid, _)| nid.clone()))
                .collect();

            let db = state.db.clone();
            let tenant_map: HashMap<String, String> = tokio::task::spawn_blocking(move || {
                let conn = db.lock().unwrap();
                let mut map = HashMap::new();
                for nid in &affected_nodes {
                    if let Ok(uid) = conn.query_row(
                        "SELECT user_id FROM nodes WHERE wk_id = ?1 AND user_id IS NOT NULL",
                        params![nid],
                        |r| r.get::<_, String>(0),
                    ) {
                        map.insert(nid.clone(), uid);
                    }
                }
                map
            }).await.unwrap_or_default();

            // Fire new observations.
            for obs in &to_fire {
                let tenant_id = match tenant_map.get(&obs.node_id) {
                    Some(t) => t.clone(),
                    None => continue,
                };

                let obs_id = Uuid::new_v4().to_string();
                let duck = state.duck_db.clone();
                let obs_id2 = obs_id.clone();
                let node_id = obs.node_id.clone();
                let alert_type = obs.alert_type.clone();
                let severity = obs.severity.as_str().to_owned();
                let title = obs.title.clone();
                let detail = obs.detail.clone();
                let context_str = serde_json::to_string(&obs.context).unwrap_or_default();
                let tenant_id2 = tenant_id.clone();
                let now_i64 = now as i64;

                let _ = tokio::task::spawn_blocking(move || {
                    let conn = duck_lock(&duck);
                    conn.execute(
                        "INSERT INTO fleet_observations
                         (id, tenant_id, node_id, alert_type, severity, state, title, detail, context_json, fired_at_ms)
                         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
                         ON CONFLICT DO NOTHING",
                        duckdb::params![obs_id2, tenant_id2, node_id, alert_type, severity, title, detail, context_str, now_i64],
                    )
                }).await;

                // Also write to node_events for the Fleet Event Timeline.
                let _ = state.events_tx.try_send(EventRow {
                    ts_ms:      now as i64,
                    node_id:    obs.node_id.clone(),
                    tenant_id:  tenant_id.clone(),
                    level:      if matches!(obs.severity, ObsSeverity::Critical) { "error" } else { "warning" }.into(),
                    event_type: Some(obs.alert_type.clone()),
                    message:    obs.title.clone(),
                });

                // Deliver to notification channels (Team+ only).
                let db2 = state.db.clone();
                let node_id3 = obs.node_id.clone();
                let alert_type3 = obs.alert_type.clone();
                let detail3 = obs.detail.clone();
                tokio::task::spawn_blocking(move || {
                    let conn = db2.lock().unwrap();
                    let tier: Option<String> = conn.query_row(
                        "SELECT subscription_tier FROM users WHERE id = ?1",
                        params![tenant_id],
                        |r| r.get(0),
                    ).ok();
                    if !is_team_or_above(tier.as_deref().unwrap_or("community")) { return; }

                    // Find matching alert rules for this event type.
                    let rules: Vec<(String, String)> = {
                        let mut stmt = match conn.prepare(
                            "SELECT nc.channel_type, nc.config_json
                             FROM alert_rules ar
                             JOIN notification_channels nc ON nc.id = ar.channel_id
                             WHERE ar.user_id = ?1
                               AND ar.event_type = ?2
                               AND ar.enabled = 1
                               AND (ar.node_id IS NULL OR ar.node_id = ?3)"
                        ) { Ok(s) => s, Err(_) => return };
                        match stmt.query_map(params![tenant_id, alert_type3, node_id3], |r| {
                            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                        }) {
                            Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
                            Err(_) => return,
                        }
                    };
                    for (ch_type, config_json) in rules {
                        deliver_alert(&ch_type, &config_json, &node_id3, &alert_type3, &detail3, false);
                    }
                });

                open_observations.insert((obs.node_id.clone(), obs.alert_type.clone()), obs_id);
                println!("[evaluator] 🔴 {} fired for {}", obs.alert_type, obs.node_id);
            }

            // Resolve cleared observations.
            for (node_id, alert_type) in &to_resolve {
                if let Some(obs_id) = open_observations.remove(&(node_id.clone(), alert_type.clone())) {
                    let duck = state.duck_db.clone();
                    let now_i64 = now as i64;
                    let obs_id2 = obs_id.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        let conn = duck_lock(&duck);
                        conn.execute(
                            "UPDATE fleet_observations SET state = 'resolved', resolved_at_ms = ?1
                             WHERE id = ?2 AND state = 'open'",
                            duckdb::params![now_i64, obs_id2],
                        )
                    }).await;

                    // Write resolution event to timeline.
                    if let Some(tenant_id) = tenant_map.get(node_id) {
                        let _ = state.events_tx.try_send(EventRow {
                            ts_ms:      now as i64,
                            node_id:    node_id.clone(),
                            tenant_id:  tenant_id.clone(),
                            level:      "info".into(),
                            event_type: Some(format!("{alert_type}_resolved")),
                            message:    format!("{} condition cleared", alert_type.replace('_', " ")),
                        });
                    }

                    println!("[evaluator] ✅ {} resolved for {}", alert_type, node_id);
                }
            }
        }
    }
}

// ── Alerting — CRUD handlers ──────────────────────────────────────────────────

/// POST /api/alerts/channels — create a notification channel (Slack or email).
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
    let db   = state.db.clone();
    let body = body;

    let result = tokio::task::spawn_blocking(move || {
        let conn    = db.lock().unwrap();
        let user_id = require_user(&token, &conn, &clerk_keys)?;

        // Tier gate — alerting is Team+.
        let tier: String = conn.query_row(
            "SELECT subscription_tier FROM users WHERE id = ?1",
            params![user_id],
            |r| r.get(0),
        ).unwrap_or_else(|_| "community".to_string());
        if !is_team_or_above(&tier) {
            return None; // caller maps None → 402 Upgrade Required
        }

        let id = Uuid::new_v4().to_string();
        let ts = now_ms() as i64;
        conn.execute(
            "INSERT INTO notification_channels (id, user_id, channel_type, name, config_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, user_id, body.channel_type, body.name, body.config_json, ts],
        ).ok()?;
        Some(AlertChannel {
            id,
            channel_type: body.channel_type,
            name: body.name,
            config_json: body.config_json,
            verified: false,
            created_at: ts,
        })
    }).await.unwrap();

    match result {
        None    => (StatusCode::PAYMENT_REQUIRED,
            Json(serde_json::json!({ "error": "Alerting requires Team tier" }))).into_response(),
        Some(c) => (StatusCode::CREATED, Json(c)).into_response(),
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
    let db = state.db.clone();

    let result: Option<Vec<AlertChannel>> = tokio::task::spawn_blocking(move || {
        let conn    = db.lock().unwrap();
        let user_id = require_user(&token, &conn, &clerk_keys)?;
        let mut stmt = conn.prepare(
            "SELECT id, channel_type, name, config_json, verified, created_at
             FROM notification_channels WHERE user_id = ?1 ORDER BY created_at DESC"
        ).ok()?;
        Some(stmt.query_map(params![user_id], |r| Ok(AlertChannel {
            id:           r.get(0)?,
            channel_type: r.get(1)?,
            name:         r.get(2)?,
            config_json:  r.get(3)?,
            verified:     r.get::<_, i32>(4)? != 0,
            created_at:   r.get(5)?,
        })).ok()?.filter_map(|r| r.ok()).collect())
    }).await.unwrap();

    match result {
        None    => (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
        Some(c) => Json(serde_json::json!({ "channels": c })).into_response(),
    }
}

/// DELETE /api/alerts/channels/:id
async fn handle_delete_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(channel_id): axum::extract::Path<String>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let db = state.db.clone();

    let result: Option<bool> = tokio::task::spawn_blocking(move || {
        let conn    = db.lock().unwrap();
        let user_id = require_user(&token, &conn, &clerk_keys)?;
        let rows = conn.execute(
            "DELETE FROM notification_channels WHERE id = ?1 AND user_id = ?2",
            params![channel_id, user_id],
        ).unwrap_or(0);
        Some(rows > 0)
    }).await.unwrap();

    match result {
        None         => (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
        Some(false)  => (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Channel not found" }))).into_response(),
        Some(true)   => Json(serde_json::json!({ "ok": true })).into_response(),
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
    let db   = state.db.clone();
    let body = body;

    let result = tokio::task::spawn_blocking(move || {
        let conn    = db.lock().unwrap();
        let user_id = require_user(&token, &conn, &clerk_keys)?;

        let tier: String = conn.query_row(
            "SELECT subscription_tier FROM users WHERE id = ?1",
            params![user_id],
            |r| r.get(0),
        ).unwrap_or_else(|_| "community".to_string());
        if !is_team_or_above(&tier) { return None; }

        // Verify the channel belongs to this user.
        let channel_owner: Option<String> = conn.query_row(
            "SELECT user_id FROM notification_channels WHERE id = ?1",
            params![body.channel_id],
            |r| r.get(0),
        ).ok();
        if channel_owner.as_deref() != Some(&user_id) { return None; }

        let id      = Uuid::new_v4().to_string();
        let urgency = body.urgency.as_deref().unwrap_or("immediate").to_string();
        let ts      = now_ms() as i64;
        conn.execute(
            "INSERT INTO alert_rules
             (id, user_id, node_id, event_type, threshold_value, urgency, channel_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id, user_id, body.node_id, body.event_type,
                body.threshold_value, urgency, body.channel_id, ts
            ],
        ).ok()?;
        Some(AlertRule {
            id,
            node_id:         body.node_id,
            event_type:      body.event_type,
            threshold_value: body.threshold_value,
            urgency,
            channel_id:      body.channel_id,
            enabled:         true,
            created_at:      ts,
        })
    }).await.unwrap();

    match result {
        None    => (StatusCode::PAYMENT_REQUIRED,
            Json(serde_json::json!({ "error": "Alerting requires Team tier or channel not found" }))).into_response(),
        Some(r) => (StatusCode::CREATED, Json(r)).into_response(),
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
    let db = state.db.clone();

    let result: Option<Vec<AlertRule>> = tokio::task::spawn_blocking(move || {
        let conn    = db.lock().unwrap();
        let user_id = require_user(&token, &conn, &clerk_keys)?;
        let mut stmt = conn.prepare(
            "SELECT id, node_id, event_type, threshold_value, urgency, channel_id, enabled, created_at
             FROM alert_rules WHERE user_id = ?1 ORDER BY created_at DESC"
        ).ok()?;
        Some(stmt.query_map(params![user_id], |r| Ok(AlertRule {
            id:              r.get(0)?,
            node_id:         r.get(1)?,
            event_type:      r.get(2)?,
            threshold_value: r.get(3)?,
            urgency:         r.get(4)?,
            channel_id:      r.get(5)?,
            enabled:         r.get::<_, i32>(6)? != 0,
            created_at:      r.get(7)?,
        })).ok()?.filter_map(|r| r.ok()).collect())
    }).await.unwrap();

    match result {
        None    => (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
        Some(r) => Json(serde_json::json!({ "rules": r })).into_response(),
    }
}

/// DELETE /api/alerts/rules/:id
async fn handle_delete_rule(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(rule_id): axum::extract::Path<String>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let db = state.db.clone();

    let result: Option<bool> = tokio::task::spawn_blocking(move || {
        let conn    = db.lock().unwrap();
        let user_id = require_user(&token, &conn, &clerk_keys)?;
        let rows = conn.execute(
            "DELETE FROM alert_rules WHERE id = ?1 AND user_id = ?2",
            params![rule_id, user_id],
        ).unwrap_or(0);
        Some(rows > 0)
    }).await.unwrap();

    match result {
        None        => (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
        Some(false) => (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Rule not found" }))).into_response(),
        Some(true)  => Json(serde_json::json!({ "ok": true })).into_response(),
    }
}

/// POST /api/alerts/channels/:id/test — fire a test notification immediately.
async fn handle_test_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(channel_id): axum::extract::Path<String>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let db = state.db.clone();

    let result = tokio::task::spawn_blocking(move || {
        let conn    = db.lock().unwrap();
        let user_id = require_user(&token, &conn, &clerk_keys)?;
        let row: Option<(String, String)> = conn.query_row(
            "SELECT channel_type, config_json FROM notification_channels
             WHERE id = ?1 AND user_id = ?2",
            params![channel_id, user_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).ok();
        row.map(|(ct, cfg)| {
            deliver_alert(
                &ct, &cfg, "WK-TEST", "test",
                "This is a test notification from Wicklee. Your alert channel is working correctly.",
                false,
            )
        })
    }).await.unwrap();

    match result {
        None        => (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session or channel not found" }))).into_response(),
        Some(false) => (StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "error": "Delivery failed — check webhook URL or email address" }))).into_response(),
        Some(true)  => Json(serde_json::json!({ "ok": true, "message": "Test notification sent" })).into_response(),
    }
}

// ── Billing handlers ──────────────────────────────────────────────────────────

/// POST /api/billing/checkout
/// Creates a Stripe Checkout session (subscription mode) for the authenticated user.
/// Reads STRIPE_SECRET_KEY and STRIPE_PRICE_ID env vars.
/// Returns: { "url": "https://checkout.stripe.com/..." }
async fn handle_billing_checkout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let secret_key = match std::env::var("STRIPE_SECRET_KEY") {
        Ok(k) if !k.is_empty() => k,
        _ => return (StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "Billing not configured" }))).into_response(),
    };
    let price_id = std::env::var("STRIPE_PRICE_ID")
        .unwrap_or_else(|_| "price_placeholder".to_string());
    let base_url = std::env::var("APP_URL")
        .unwrap_or_else(|_| "https://wicklee.dev".to_string());

    let db = state.db.clone();
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let email: Option<String> = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        let user_id = require_user(&token, &conn, &clerk_keys)?;
        conn.query_row(
            "SELECT email FROM users WHERE id = ?1",
            params![user_id],
            |r| r.get(0),
        ).ok()
    }).await.unwrap();

    let email = match email {
        Some(e) => e,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid session" }))).into_response(),
    };

    let result = tokio::task::spawn_blocking(move || {
        let body = format!(
            "mode=subscription\
             &line_items[0][price]={price_id}\
             &line_items[0][quantity]=1\
             &customer_email={email}\
             &success_url={base_url}/dashboard?upgraded=1\
             &cancel_url={base_url}/dashboard"
        );
        match ureq::post("https://api.stripe.com/v1/checkout/sessions")
            .set("Authorization", &format!("Bearer {secret_key}"))
            .set("Content-Type", "application/x-www-form-urlencoded")
            .send_string(&body)
        {
            Ok(r) => r.into_json::<serde_json::Value>().ok(),
            Err(e) => { eprintln!("[billing] checkout failed: {e}"); None }
        }
    }).await.unwrap();

    match result.and_then(|v| v["url"].as_str().map(|s| s.to_string())) {
        Some(url) => Json(serde_json::json!({ "url": url })).into_response(),
        None => (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to create checkout session" }))).into_response(),
    }
}

/// POST /api/webhooks/stripe
/// Handles Stripe webhook events. Verifies HMAC-SHA256 signature if
/// STRIPE_WEBHOOK_SECRET is set. Processes checkout.session.completed
/// (upgrades user to 'team') and customer.subscription.deleted (downgrades to 'community').
async fn handle_stripe_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    // Verify Stripe-Signature header if STRIPE_WEBHOOK_SECRET is set
    if let Ok(secret) = std::env::var("STRIPE_WEBHOOK_SECRET") {
        let sig_header = headers.get("stripe-signature")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let ts = sig_header.split(',')
            .find(|p| p.starts_with("t="))
            .and_then(|p| p.strip_prefix("t="))
            .unwrap_or("");
        let expected = sig_header.split(',')
            .find(|p| p.starts_with("v1="))
            .and_then(|p| p.strip_prefix("v1="))
            .unwrap_or("");
        let payload = format!("{}.{}", ts, String::from_utf8_lossy(&body));
        use hmac::{Hmac, Mac};
        type HmacSha256 = Hmac<sha2::Sha256>;
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
            .expect("HMAC can take any key length");
        mac.update(payload.as_bytes());
        let computed = hex::encode(mac.finalize().into_bytes());
        let sig_ok: bool = subtle::ConstantTimeEq::ct_eq(computed.as_bytes(), expected.as_bytes()).into();
        if !sig_ok {
            return (StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "Invalid signature" }))).into_response();
        }
    } else {
        eprintln!("[billing] STRIPE_WEBHOOK_SECRET not set — skipping signature verification");
    }

    let event: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": format!("Invalid JSON: {e}") }))).into_response(),
    };

    let event_type = event["type"].as_str().unwrap_or("");
    match event_type {
        "checkout.session.completed" => {
            let customer_id     = event["data"]["object"]["customer"].as_str().unwrap_or("").to_string();
            let subscription_id = event["data"]["object"]["subscription"].as_str().unwrap_or("").to_string();
            let customer_email  = event["data"]["object"]["customer_email"].as_str().unwrap_or("").to_string();
            let db = state.db.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let conn = db.lock().unwrap();
                let _ = conn.execute(
                    "UPDATE users SET subscription_tier = 'team',
                         stripe_customer_id = ?1, stripe_subscription_id = ?2
                     WHERE email = ?3",
                    params![customer_id, subscription_id, customer_email],
                );
                println!("[billing] upgraded {customer_email} → team (customer={customer_id})");
            }).await;
        }
        "customer.subscription.deleted" => {
            let customer_id = event["data"]["object"]["customer"].as_str().unwrap_or("").to_string();
            let db = state.db.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let conn = db.lock().unwrap();
                let _ = conn.execute(
                    "UPDATE users SET subscription_tier = 'community',
                         stripe_subscription_id = NULL
                     WHERE stripe_customer_id = ?1",
                    params![customer_id],
                );
                println!("[billing] downgraded customer={customer_id} → community");
            }).await;
        }
        _ => {} // Ignore other event types
    }

    StatusCode::OK.into_response()
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    let conn = open_db();

    // One-shot node purge — set RESET_NODES=1 in Railway env, redeploy once,
    // then remove the var.  Clears the nodes table and the in-memory cache so
    // all nodes can be re-paired from scratch.
    if std::env::var("RESET_NODES").as_deref() == Ok("1") {
        conn.execute_batch("DELETE FROM nodes;").expect("RESET_NODES purge failed");
        println!("  ⚠  RESET_NODES=1 — all nodes purged.  Remove this env var now.");
    }

    // Pre-load known nodes from the DB so they survive Railway redeploys.
    // metrics is always None here — the frontend shows "last seen X ago" until
    // the agent re-pushes real telemetry (within its 2s push cadence).
    let seed_metrics: HashMap<String, MetricsEntry> = {
        let rows: Vec<(String, i64)> = conn
            .prepare("SELECT wk_id, last_seen FROM nodes")
            .unwrap()
            .query_map([], |r| Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
            )))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        rows.into_iter()
            .map(|(node_id, last_seen)| {
                (node_id, MetricsEntry { last_seen_ms: last_seen as u64, metrics: None })
            })
            .collect()
    };

    // Fetch Clerk JWKS on startup so JWT validation works immediately.
    // Set CLERK_JWKS_URL in Railway env, e.g.:
    //   https://<your-clerk-domain>/.well-known/jwks.json
    let jwks_url = std::env::var("CLERK_JWKS_URL").ok();
    let initial_keys = if let Some(ref url) = jwks_url {
        let url2 = url.clone();
        tokio::task::spawn_blocking(move || fetch_jwks(&url2))
            .await
            .unwrap_or_default()
    } else {
        eprintln!("[jwks] CLERK_JWKS_URL not set — Clerk JWT auth disabled");
        vec![]
    };
    if !initial_keys.is_empty() {
        println!("  JWKS → {} key(s) loaded", initial_keys.len());
    }
    let clerk_keys = Arc::new(RwLock::new(initial_keys));

    // Open DuckDB and create the analytics write channel.
    let duck_conn = open_duck_db();
    let duck      = Arc::new(Mutex::new(duck_conn)) as DuckDb;
    let (metrics_tx, metrics_rx) = mpsc::channel::<MetricsRow>(8_192);
    let (events_tx,  events_rx)  = mpsc::channel::<EventRow>(1_024);

    let state = AppState {
        db:              Arc::new(Mutex::new(conn)),
        metrics:         Arc::new(RwLock::new(seed_metrics)),
        clerk_keys:      clerk_keys.clone(),
        api_rate_limits: Arc::new(Mutex::new(HashMap::new())),
        metrics_tx,
        events_tx,
        duck_db:         duck.clone(),
    };

    // Spawn DuckDB analytics writer (drains channel, batches, flushes every 30 s).
    tokio::spawn(metrics_writer_task(metrics_rx, duck.clone()));

    // Spawn DuckDB event writer (Live Activity events — rare, no batching needed).
    tokio::spawn(events_writer_task(events_rx, duck.clone()));

    // Spawn hourly rollup (raw → 5-min aggregates, prune old raw rows).
    tokio::spawn(rollup_task(duck.clone()));

    // Spawn nightly maintenance (CHECKPOINT + ANALYZE at 3 AM UTC).
    tokio::spawn(nightly_task(duck.clone()));

    // Spawn node-offline alert task (checks every 60 s; fires once per outage).
    tokio::spawn(node_offline_alert_task(state.clone()));

    // Spawn fleet alert evaluator (Essential Four: Zombied Engine, Thermal
    // Redline, OOM Warning, WES Cliff — 60 s cadence with ring-buffer history).
    tokio::spawn(fleet_alert_evaluator_task(state.clone()));

    // Refresh JWKS every 6 hours to pick up Clerk key rotations.
    if let Some(url) = jwks_url {
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
                let url2 = url.clone();
                let new_keys = tokio::task::spawn_blocking(move || fetch_jwks(&url2))
                    .await
                    .unwrap_or_default();
                if !new_keys.is_empty() {
                    *clerk_keys.write().unwrap() = new_keys;
                    println!("[jwks] refreshed");
                }
            }
        });
    }

    // Purge expired stream tokens every 5 minutes.
    let db_cleanup = state.db.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(300)).await;
            let db2 = db_cleanup.clone();
            let now = now_ms() as i64;
            tokio::task::spawn_blocking(move || {
                let conn = db2.lock().unwrap();
                conn.execute("DELETE FROM stream_tokens WHERE expires_ms < ?1", params![now]).ok();
            }).await.ok();
        }
    });

    let app = Router::new()
        .route("/health",                  get(handle_health))
        .route("/api/agent/version",       get(handle_agent_version))
        .route("/api/auth/signup",       post(handle_signup))
        .route("/api/auth/login",        post(handle_login))
        .route("/api/auth/me",           get(handle_me))
        .route("/api/auth/stream-token", get(handle_stream_token))
        .route("/api/pair/claim",    post(handle_claim))
        .route("/api/pair/activate", post(handle_activate))
        .route("/api/nodes/:node_id",     delete(handle_delete_node))
        .route("/api/telemetry",    post(handle_telemetry))
        .route("/api/fleet",              get(handle_fleet))
        .route("/api/fleet/stream",       get(handle_fleet_stream))
        .route("/api/fleet/wes-history",          get(handle_wes_history))
        .route("/api/fleet/metrics-history",      get(handle_metrics_history))
        .route("/api/fleet/duty",                 get(handle_fleet_duty))
        .route("/api/fleet/events/history",       get(handle_fleet_events_history))
        .route("/api/fleet/export",               get(handle_fleet_export))
        // ── Fleet Observations (Phase 4B — stateful alert triage) ────────────
        .route("/api/fleet/observations",            get(handle_fleet_observations))
        .route("/api/fleet/observations/:id/acknowledge", post(handle_acknowledge_observation))
        // ── Agent API v1 ──────────────────────────────────────────────────────
        .route("/api/v1/keys",           post(handle_v1_create_key))
        .route("/api/v1/keys",           get(handle_v1_list_keys))
        .route("/api/v1/keys/:key_id",   delete(handle_v1_delete_key))
        .route("/api/v1/fleet",          get(handle_v1_fleet))
        .route("/api/v1/fleet/wes",      get(handle_v1_fleet_wes))
        .route("/api/v1/nodes/:id",      get(handle_v1_node))
        .route("/api/v1/route/best",     get(handle_v1_route_best))
        .route("/api/v1/insights/latest", get(handle_v1_insights_latest))
        // ── Alerting (Phase 4A) ───────────────────────────────────────────────
        .route("/api/alerts/channels",          post(handle_create_channel))
        .route("/api/alerts/channels",          get(handle_list_channels))
        .route("/api/alerts/channels/:id",      delete(handle_delete_channel))
        .route("/api/alerts/channels/:id/test", post(handle_test_channel))
        .route("/api/alerts/rules",             post(handle_create_rule))
        .route("/api/alerts/rules",             get(handle_list_rules))
        .route("/api/alerts/rules/:id",         delete(handle_delete_rule))
        // ── Billing (Stripe) ──────────────────────────────────────────────────
        .route("/api/billing/checkout",  post(handle_billing_checkout))
        .route("/api/webhooks/stripe",   post(handle_stripe_webhook))
        .with_state(state)
        .layer(middleware::from_fn(cors)); // cors() short-circuits OPTIONS before router

    // Railway injects PORT at runtime; fall back to 8080 for local dev.
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let addr = format!("0.0.0.0:{port}");

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Failed to bind");

    println!("╔══════════════════════════════════════════════╗");
    println!("║  Wicklee Cloud  (Phase 4A — Alerts active)   ║");
    println!("║  POST /api/auth/signup                       ║");
    println!("║  POST /api/auth/login                        ║");
    println!("║  GET  /api/auth/me                           ║");
    println!("║  GET  /api/auth/stream-token                 ║");
    println!("║  POST /api/pair/claim                        ║");
    println!("║  POST /api/pair/activate                     ║");
    println!("║  POST /api/telemetry  → DuckDB + alerts      ║");
    println!("║  GET  /api/fleet                             ║");
    println!("║  GET  /api/fleet/stream                      ║");
    println!("║  GET  /api/fleet/wes-history                 ║");
    println!("║  GET  /api/fleet/metrics-history             ║");
    println!("║  ── Alerting (Team+) ─────────────────────  ║");
    println!("║  POST   /api/alerts/channels                 ║");
    println!("║  GET    /api/alerts/channels                 ║");
    println!("║  DELETE /api/alerts/channels/:id             ║");
    println!("║  POST   /api/alerts/channels/:id/test        ║");
    println!("║  POST   /api/alerts/rules                    ║");
    println!("║  GET    /api/alerts/rules                    ║");
    println!("║  DELETE /api/alerts/rules/:id                ║");
    println!("║  ── Agent API v1 ─────────────────────────  ║");
    println!("║  POST   /api/v1/keys                         ║");
    println!("║  GET    /api/v1/keys                         ║");
    println!("║  DELETE /api/v1/keys/:key_id                 ║");
    println!("║  GET    /api/v1/fleet                        ║");
    println!("║  GET    /api/v1/fleet/wes                    ║");
    println!("║  GET    /api/v1/nodes/:id                    ║");
    println!("║  GET    /api/v1/route/best                   ║");
    println!("║  GET    /api/v1/insights/latest              ║");
    println!("║  Listening on {addr:<30} ║");
    println!("╚══════════════════════════════════════════════╝");

    axum::serve(listener, app).await.expect("Server exited unexpectedly");
}
