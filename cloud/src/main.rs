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

// ── Shared payload shape — must stay in sync with the agent ──────────────────

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
    cpu_power_w:                    Option<f32>,
    ecpu_power_w:                   Option<f32>,
    pcpu_power_w:                   Option<f32>,
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
    os: Option<String>,
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
    wes_version:      u8,               // incremented when WES formula changes
}

#[derive(Serialize)]
struct NodeSummary {
    node_id:      String,
    fleet_url:    String,
    last_seen_ms: u64,
    metrics:      Option<MetricsPayload>,
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
    //   'memory_pressure_high' | 'wes_drop' | 'idle_digest'
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
            let _ = metrics_tx.try_send(row);

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
    let result: Option<Vec<(String, String, i64)>> = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        let user_id = require_user(&token, &conn, &clerk_keys)?;
        let mut stmt = conn.prepare(
            "SELECT wk_id, fleet_url, last_seen FROM nodes WHERE user_id = ?1 ORDER BY last_seen DESC"
        ).ok()?;
        Some(stmt.query_map(params![user_id], |r| Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
        )))
        .ok()?
        .filter_map(|r| r.ok())
        .collect())
    }).await.unwrap();

    let persisted = match result {
        Some(rows) => rows,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let metrics_map = state.metrics.read().unwrap();
    let nodes: Vec<NodeSummary> = persisted.into_iter().map(|(node_id, fleet_url, last_seen_db)| {
        let (last_seen_ms, metrics) = metrics_map.get(&node_id)
            .map(|e| (e.last_seen_ms, e.metrics.clone()))
            .unwrap_or((last_seen_db as u64, None));
        NodeSummary { node_id, fleet_url, last_seen_ms, metrics }
    }).collect();

    Json(FleetResponse { nodes }).into_response()
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
    let (lookback_ms, bucket_ms, use_raw): (i64, i64, bool) = match range.as_str() {
        "1h"  => (3_600_000,      60_000,    true),
        "24h" => (86_400_000,     300_000,   false),
        "7d"  => (604_800_000,    1_800_000, false),
        "30d" => (2_592_000_000,  7_200_000, false),
        "90d" => (7_776_000_000,  21_600_000, false),
        _     => (86_400_000,     300_000,   false),
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
        let conn = duck.lock().unwrap();
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

    let (lookback_ms, bucket_ms, use_raw): (i64, i64, bool) = match range.as_str() {
        "1h"  => (3_600_000,      60_000,    true),
        "24h" => (86_400_000,     300_000,   false),
        "7d"  => (604_800_000,    1_800_000, false),
        "30d" => (2_592_000_000,  7_200_000, false),
        "90d" => (7_776_000_000,  21_600_000, false),
        _     => (86_400_000,     300_000,   false),
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
        let conn = duck.lock().unwrap();
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
                            AVG(mem_pressure_pct) AS mem_pct
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
                    ))).ok().map(|it| it.filter_map(|r| r.ok()).collect::<Vec<_>>())
                }) {
                    Some(rows) => rows.into_iter().map(|(ts, toks, toksp95, w, gpu, mem)| {
                        serde_json::json!({
                            "ts_ms":      ts,
                            "tok_s":      toks,
                            "tok_s_p95":  toksp95,
                            "watts":      w,
                            "gpu_pct":    gpu,
                            "mem_pct":    mem,
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
                            AVG(mem_pressure_pct_avg) AS mem_pct
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
                    ))).ok().map(|it| it.filter_map(|r| r.ok()).collect::<Vec<_>>())
                }) {
                    Some(rows) => rows.into_iter().map(|(ts, toks, toksp95, w, gpu, mem)| {
                        serde_json::json!({
                            "ts_ms":      ts,
                            "tok_s":      toks,
                            "tok_s_p95":  toksp95,
                            "watts":      w,
                            "gpu_pct":    gpu,
                            "mem_pct":    mem,
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
                    "error": format!("Free tier limit reached ({MAX_FREE_NODES} nodes). Upgrade to add more.")
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

    // Load initial node set for this user.
    let db = state.db.clone();
    let uid2 = user_id.clone();
    let initial_nodes: HashSet<String> = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        user_node_set(&uid2, &conn)
    }).await.unwrap();

    let interval_stream = tokio_stream::wrappers::IntervalStream::new(
        tokio::time::interval(Duration::from_secs(2)),
    );

    let db_stream  = state.db.clone();
    let uid_stream = user_id.clone();
    let mut nodes  = initial_nodes;
    let mut tick: u32 = 0;

    let stream = interval_stream.map(move |_| {
        tick += 1;
        // Refresh the user's node list every 30 ticks (~60 s) to pick up
        // newly paired nodes without restarting the stream.
        if tick % 30 == 0 {
            nodes = tokio::task::block_in_place(|| {
                let conn = db_stream.lock().unwrap();
                user_node_set(&uid_stream, &conn)
            });
        }

        let metrics_map = state.metrics.read().unwrap();
        let node_list: Vec<serde_json::Value> = metrics_map
            .iter()
            .filter(|(node_id, _)| nodes.contains(node_id.as_str()))
            .map(|(node_id, entry)| {
                serde_json::json!({
                    "node_id":      node_id,
                    "last_seen_ms": entry.last_seen_ms,
                    "metrics":      entry.metrics,
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
async fn handle_health() -> StatusCode {
    StatusCode::OK
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
    let path = duck_db_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("Cannot create DuckDB directory");
    }
    let conn = DuckConn::open(&path)
        .unwrap_or_else(|e| panic!("Cannot open DuckDB at {}: {e}", path.display()));

    // Request ZSTD for all future checkpoints. DuckDB picks the level internally;
    // zstd_compression_level is not an exposed setting in v1.
    conn.execute_batch("SET force_compression='zstd';")
        .expect("DuckDB compression settings failed");

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

        CREATE INDEX IF NOT EXISTS idx_raw_node_ts
            ON metrics_raw  (tenant_id, node_id, ts_ms);
        CREATE INDEX IF NOT EXISTS idx_5min_node_ts
            ON metrics_5min (tenant_id, node_id, ts_ms);
    ").expect("DuckDB migrations failed");
}

// ── DuckDB — derive MetricsRow from inbound telemetry ────────────────────────

fn metrics_row_from_payload(m: &MetricsPayload, ts_ms: u64) -> MetricsRow {
    let tok_s   = if m.vllm_running { m.vllm_tokens_per_sec } else { m.ollama_tokens_per_second };
    let watts   = m.nvidia_power_draw_w.or(m.cpu_power_w);
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
        thermal_cost_pct: None,          // Phase 4B — requires agent WES v2
        thermal_penalty:  Some(penalty),
        thermal_state:    m.thermal_state.clone(),
        vram_used_mb:     m.nvidia_vram_used_mb.map(|v| v as i32),
        vram_total_mb:    m.nvidia_vram_total_mb.map(|v| v as i32),
        mem_pressure_pct: m.memory_pressure_percent,
        gpu_pct,
        cpu_pct:          Some(m.cpu_usage_percent),
        wes_version:      1,
    }
}

// ── DuckDB — batch writer ─────────────────────────────────────────────────────

/// Flush a batch of MetricsRow into metrics_raw using the DuckDB Appender
/// (10-20× faster than prepared statements for bulk inserts).
/// Call only from spawn_blocking — DuckDB Connection is !Sync.
fn flush_batch(conn: &DuckConn, batch: &[MetricsRow]) {
    if batch.is_empty() { return; }

    let mut app = match conn.appender("metrics_raw") {
        Ok(a)  => a,
        Err(e) => { eprintln!("[duck] appender open failed: {e}"); return; }
    };

    for row in batch {
        let _ = app.append_row(duckdb::params![
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
            row.wes_version,
            Option::<&str>::None, // agent_version — Phase 4B
        ]);
    }

    if let Err(e) = app.flush() {
        eprintln!("[duck] appender flush failed ({} rows dropped): {e}", batch.len());
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
                                flush_batch(&d.lock().unwrap(), &batch);
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
                        flush_batch(&d.lock().unwrap(), &batch);
                    }).await.ok();
                }
            }
        }
    }

    // Final flush on shutdown
    if !buffer.is_empty() {
        let d = duck.clone();
        tokio::task::spawn_blocking(move || {
            flush_batch(&d.lock().unwrap(), &buffer);
        }).await.ok();
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
    conn.execute_batch("
        CHECKPOINT;
        ANALYZE metrics_raw;
        ANALYZE metrics_5min;
    ").unwrap_or_else(|e| eprintln!("[nightly] maintenance failed: {e}"));
    println!("[nightly] CHECKPOINT + ANALYZE complete");
}

/// Hourly rollup background task.
async fn rollup_task(duck: DuckDb) {
    let mut interval = tokio::time::interval(Duration::from_secs(3600));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    interval.tick().await; // skip immediate first tick — wait a full hour
    loop {
        interval.tick().await;
        let d = duck.clone();
        tokio::task::spawn_blocking(move || {
            run_rollup(&d.lock().unwrap());
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
            run_nightly_maintenance(&d.lock().unwrap());
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
            "memory_pressure_high"  => ("💾", "Warning"),
            "wes_drop"              => ("📉", "Warning"),
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

/// Runs every 60 seconds. Fires `node_offline` alerts for nodes not seen in
/// the last 5 minutes, but only once per outage (stateful via alert_events).
async fn node_offline_alert_task(state: AppState) {
    let mut interval = tokio::time::interval(Duration::from_secs(60));
    interval.tick().await; // skip immediate first tick
    loop {
        interval.tick().await;
        let state2 = state.clone();
        tokio::task::spawn_blocking(move || {
            let conn = state2.db.lock().unwrap();
            let now  = now_ms();
            let offline_threshold_ms = 5 * 60_000_u64; // 5 minutes

            // Load all user_id → node_id pairs with their last_seen timestamps.
            let nodes: Vec<(String, String, u64)> = {
                let mut stmt = match conn.prepare(
                    "SELECT user_id, wk_id, last_seen FROM nodes WHERE user_id IS NOT NULL"
                ) { Ok(s) => s, Err(_) => return };
                match stmt.query_map([], |r| Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2).map(|v| v as u64)?,
                ))) {
                    Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
                    Err(_)   => return,
                }
            };

            for (user_id, node_id, last_seen) in nodes {
                let elapsed = now.saturating_sub(last_seen);
                if elapsed < offline_threshold_ms { continue; }

                // Check subscription tier — alerting is Team+.
                let tier: Option<String> = conn.query_row(
                    "SELECT subscription_tier FROM users WHERE id = ?1",
                    params![user_id],
                    |r| r.get(0),
                ).ok();
                if !is_team_or_above(tier.as_deref().unwrap_or("community")) { continue; }

                // Load node_offline rules for this user.
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
                    // Only fire once per outage — skip if open alert already exists.
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
                    let fired   = deliver_alert(&channel_type, &config_json, &node_id, "node_offline", &detail, false);
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
        }).await.ok();
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

    let state = AppState {
        db:              Arc::new(Mutex::new(conn)),
        metrics:         Arc::new(RwLock::new(seed_metrics)),
        clerk_keys:      clerk_keys.clone(),
        api_rate_limits: Arc::new(Mutex::new(HashMap::new())),
        metrics_tx,
        duck_db:         duck.clone(),
    };

    // Spawn DuckDB analytics writer (drains channel, batches, flushes every 30 s).
    tokio::spawn(metrics_writer_task(metrics_rx, duck.clone()));

    // Spawn hourly rollup (raw → 5-min aggregates, prune old raw rows).
    tokio::spawn(rollup_task(duck.clone()));

    // Spawn nightly maintenance (CHECKPOINT + ANALYZE at 3 AM UTC).
    tokio::spawn(nightly_task(duck.clone()));

    // Spawn node-offline alert task (checks every 60 s; fires once per outage).
    tokio::spawn(node_offline_alert_task(state.clone()));

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
        .route("/api/telemetry",    post(handle_telemetry))
        .route("/api/fleet",              get(handle_fleet))
        .route("/api/fleet/stream",       get(handle_fleet_stream))
        .route("/api/fleet/wes-history",      get(handle_wes_history))
        .route("/api/fleet/metrics-history",  get(handle_metrics_history))
        // ── Agent API v1 ──────────────────────────────────────────────────────
        .route("/api/v1/keys",           post(handle_v1_create_key))
        .route("/api/v1/keys",           get(handle_v1_list_keys))
        .route("/api/v1/keys/:key_id",   delete(handle_v1_delete_key))
        .route("/api/v1/fleet",          get(handle_v1_fleet))
        .route("/api/v1/fleet/wes",      get(handle_v1_fleet_wes))
        .route("/api/v1/nodes/:id",      get(handle_v1_node))
        .route("/api/v1/route/best",     get(handle_v1_route_best))
        // ── Alerting (Phase 4A) ───────────────────────────────────────────────
        .route("/api/alerts/channels",          post(handle_create_channel))
        .route("/api/alerts/channels",          get(handle_list_channels))
        .route("/api/alerts/channels/:id",      delete(handle_delete_channel))
        .route("/api/alerts/channels/:id/test", post(handle_test_channel))
        .route("/api/alerts/rules",             post(handle_create_rule))
        .route("/api/alerts/rules",             get(handle_list_rules))
        .route("/api/alerts/rules/:id",         delete(handle_delete_rule))
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
    println!("║  Listening on {addr:<30} ║");
    println!("╚══════════════════════════════════════════════╝");

    axum::serve(listener, app).await.expect("Server exited unexpectedly");
}
