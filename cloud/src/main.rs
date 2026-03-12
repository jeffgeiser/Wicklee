use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, HeaderMap, Method, Request, StatusCode},
    middleware::{self, Next},
    response::{sse::{Event, KeepAlive, Sse}, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
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

// ── DB type ───────────────────────────────────────────────────────────────────

/// Shared SQLite connection.  rusqlite::Connection is Send but not Sync, so we
/// wrap it in a Mutex to allow sharing across Axum handlers.
type Db = Arc<Mutex<Connection>>;

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

/// In-memory telemetry snapshot (not persisted — DuckDB Phase 4).
#[derive(Clone)]
struct MetricsEntry {
    last_seen_ms: u64,
    metrics:      Option<MetricsPayload>,
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
    db:             Db,
    /// In-memory telemetry cache keyed by node_id.
    metrics:        Arc<RwLock<HashMap<String, MetricsEntry>>>,
    /// Cached Clerk public keys for JWT verification.  Refreshed every 6 h.
    clerk_keys:     Arc<RwLock<Vec<JwkKey>>>,
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
}

// ── Tier constants ────────────────────────────────────────────────────────────

/// Maximum nodes a free-tier account may pair.
const MAX_FREE_NODES: usize = 3;

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

    // Update in-memory snapshot.
    {
        let mut map = state.metrics.write().unwrap();
        if let Some(entry) = map.get_mut(&node_id) {
            entry.last_seen_ms = ts;
            entry.metrics      = Some(payload);
        } else {
            // Accept telemetry even if the node reconnects after a restart.
            map.insert(node_id.clone(), MetricsEntry { last_seen_ms: ts, metrics: Some(payload) });
        }
    }

    // Persist last_seen (and hostname when present) to nodes table.
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        if let Some(ref h) = node_hostname {
            conn.execute(
                "UPDATE nodes SET last_seen = ?1, hostname = ?2 WHERE wk_id = ?3",
                params![ts as i64, h, node_id],
            ).ok();
        } else {
            conn.execute(
                "UPDATE nodes SET last_seen = ?1 WHERE wk_id = ?2",
                params![ts as i64, node_id],
            ).ok();
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
        Some(t) if !t.is_empty() => {
            println!("[fleet-stream] request arrived token={}", &t[..8.min(t.len())]);
            t.clone()
        }
        _ => {
            println!("[fleet-stream] request arrived with NO token param");
            return (StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "Missing stream token" }))).into_response();
        }
    };

    // Validate and consume the single-use token from SQLite.
    // Using spawn_blocking so the SELECT+DELETE are on the same connection/thread.
    let now = now_ms() as i64;
    let db_auth = state.db.clone();
    let st_clone = stream_token.clone();
    let user_id = match tokio::task::spawn_blocking(move || {
        let conn = db_auth.lock().unwrap();

        // Diagnostic: how many tokens exist in the table right now?
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM stream_tokens", [], |r| r.get(0)
        ).unwrap_or(-1);
        println!("[fleet-stream] stream_tokens row count={}", count);

        // Fetch the token row (validates existence and expiry in one shot).
        // Do NOT delete here — EventSource may retry after a proxy 502,
        // and the token is already time-limited to 60 s.  The background
        // cleanup task purges expired tokens every 5 minutes.
        let row = conn.query_row(
            "SELECT user_id FROM stream_tokens WHERE token = ?1 AND expires_ms > ?2",
            params![st_clone, now],
            |r| r.get::<_, String>(0),
        ).ok();
        println!("[fleet-stream] token lookup: {:?} (now_ms={})", &row, now);
        row
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
                (header::ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, OPTIONS"),
                (header::ACCESS_CONTROL_ALLOW_HEADERS, "content-type, authorization"),
            ],
        ).into_response();
    }

    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN,
        header::HeaderValue::from_static("*"));
    res
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

    let state = AppState {
        db:         Arc::new(Mutex::new(conn)),
        metrics:    Arc::new(RwLock::new(seed_metrics)),
        clerk_keys: clerk_keys.clone(),
    };

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
        .route("/health",            get(handle_health))
        .route("/api/auth/signup",       post(handle_signup))
        .route("/api/auth/login",        post(handle_login))
        .route("/api/auth/me",           get(handle_me))
        .route("/api/auth/stream-token", get(handle_stream_token))
        .route("/api/pair/claim",    post(handle_claim))
        .route("/api/pair/activate", post(handle_activate))
        .route("/api/telemetry",    post(handle_telemetry))
        .route("/api/fleet",         get(handle_fleet))
        .route("/api/fleet/stream",  get(handle_fleet_stream))
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
    println!("║  Wicklee Cloud                               ║");
    println!("║  POST /api/auth/signup                       ║");
    println!("║  POST /api/auth/login                        ║");
    println!("║  GET  /api/auth/me                           ║");
    println!("║  GET  /api/auth/stream-token                 ║");
    println!("║  POST /api/pair/claim                        ║");
    println!("║  POST /api/pair/activate                     ║");
    println!("║  POST /api/telemetry                         ║");
    println!("║  GET  /api/fleet                             ║");
    println!("║  GET  /api/fleet/stream                      ║");
    println!("║  Listening on {addr:<30} ║");
    println!("╚══════════════════════════════════════════════╝");

    axum::serve(listener, app).await.expect("Server exited unexpectedly");
}
