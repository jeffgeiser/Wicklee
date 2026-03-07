use axum::{
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tower_http::cors::CorsLayer;
use uuid::Uuid;

// ── Shared payload shape — must stay in sync with the agent ──────────────────

#[derive(Deserialize, Serialize, Clone)]
struct MetricsPayload {
    node_id:                        String,
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
}

// ── Auth types ────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct UserRecord {
    id:            String,
    email:         String,
    full_name:     String,
    password_hash: String,
    role:          String,
    is_pro:        bool,
}

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
    id:       String,
    email:    String,
    #[serde(rename = "fullName")]
    full_name: String,
    role:     String,
    #[serde(rename = "isPro")]
    is_pro:   bool,
}

#[derive(Serialize)]
struct AuthResponse {
    token: String,
    user:  UserResponse,
}

impl From<&UserRecord> for UserResponse {
    fn from(u: &UserRecord) -> Self {
        UserResponse {
            id:        u.id.clone(),
            email:     u.email.clone(),
            full_name: u.full_name.clone(),
            role:      u.role.clone(),
            is_pro:    u.is_pro,
        }
    }
}

// ── Fleet types ───────────────────────────────────────────────────────────────

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

#[derive(Clone)]
struct NodeEntry {
    node_id:       String,
    fleet_url:     String,
    session_token: String,
    last_seen_ms:  u64,
    metrics:       Option<MetricsPayload>,
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

// ── App state ─────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct AppState {
    fleet:    Arc<RwLock<HashMap<String, NodeEntry>>>,   // node_id  → entry
    users:    Arc<RwLock<HashMap<String, UserRecord>>>,  // email    → record
    sessions: Arc<RwLock<HashMap<String, String>>>,      // token    → email
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

// ── Auth handlers ─────────────────────────────────────────────────────────────

/// POST /api/auth/signup
async fn handle_signup(
    State(state): State<AppState>,
    Json(body): Json<SignupRequest>,
) -> impl IntoResponse {
    let email = body.email.trim().to_lowercase();

    if email.is_empty() || !email.contains('@') {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Valid email required" })),
        )
        .into_response();
    }
    if body.password.len() < 8 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Password must be at least 8 characters" })),
        )
        .into_response();
    }
    if body.full_name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Full name required" })),
        )
        .into_response();
    }

    {
        let users = state.users.read().unwrap();
        if users.contains_key(&email) {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({ "error": "An account with this email already exists" })),
            )
            .into_response();
        }
    }

    let password = body.password.clone();
    let hash_result = tokio::task::spawn_blocking(move || bcrypt::hash(password, 12))
        .await
        .unwrap();
    let password_hash = match hash_result {
        Ok(h) => h,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Internal error" })),
            )
            .into_response();
        }
    };

    let record = UserRecord {
        id:            Uuid::new_v4().to_string(),
        email:         email.clone(),
        full_name:     body.full_name.trim().to_owned(),
        password_hash,
        role:          "Owner".to_owned(),
        is_pro:        false,
    };

    let token = Uuid::new_v4().to_string();
    let user_response = UserResponse::from(&record);

    state.users.write().unwrap().insert(email.clone(), record);
    state.sessions.write().unwrap().insert(token.clone(), email);

    (StatusCode::CREATED, Json(AuthResponse { token, user: user_response })).into_response()
}

/// POST /api/auth/login
async fn handle_login(
    State(state): State<AppState>,
    Json(body): Json<LoginRequest>,
) -> impl IntoResponse {
    let email = body.email.trim().to_lowercase();

    let record = state.users.read().unwrap().get(&email).cloned();
    let record = match record {
        Some(r) => r,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "Invalid email or password" })),
            )
            .into_response();
        }
    };

    let hash = record.password_hash.clone();
    let password = body.password.clone();
    let valid = tokio::task::spawn_blocking(move || bcrypt::verify(password, &hash))
        .await
        .unwrap()
        .unwrap_or(false);

    if !valid {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid email or password" })),
        )
        .into_response();
    }

    let token = Uuid::new_v4().to_string();
    let user_response = UserResponse::from(&record);
    state.sessions.write().unwrap().insert(token.clone(), email);

    (StatusCode::OK, Json(AuthResponse { token, user: user_response })).into_response()
}

/// GET /api/auth/me — validates session token from Authorization: Bearer header
async fn handle_me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "Missing auth token" })),
            )
            .into_response();
        }
    };

    let email = state.sessions.read().unwrap().get(&token).cloned();
    let email = match email {
        Some(e) => e,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "Invalid or expired session" })),
            )
            .into_response();
        }
    };

    let record = state.users.read().unwrap().get(&email).cloned();
    match record {
        Some(r) => (StatusCode::OK, Json(UserResponse::from(&r))).into_response(),
        None => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "User not found" })),
        )
        .into_response(),
    }
}

// ── Fleet handlers ────────────────────────────────────────────────────────────

/// POST /api/pair/claim
async fn handle_claim(
    State(state): State<AppState>,
    Json(body): Json<ClaimRequest>,
) -> impl IntoResponse {
    if body.code.len() != 6 || !body.code.chars().all(|c| c.is_ascii_digit()) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "code must be exactly 6 ASCII digits" })),
        )
        .into_response();
    }
    if body.node_id.is_empty() || body.fleet_url.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "node_id and fleet_url are required" })),
        )
        .into_response();
    }

    let token = mint_node_token(&body.node_id);
    state.fleet.write().unwrap().insert(
        body.node_id.clone(),
        NodeEntry {
            node_id:       body.node_id.clone(),
            fleet_url:     body.fleet_url.clone(),
            session_token: token.clone(),
            last_seen_ms:  now_ms(),
            metrics:       None,
        },
    );

    (
        StatusCode::OK,
        Json(ClaimResponse { session_token: token, node_id: body.node_id }),
    )
    .into_response()
}

/// POST /api/telemetry
async fn handle_telemetry(
    State(state): State<AppState>,
    Json(payload): Json<MetricsPayload>,
) -> StatusCode {
    let node_id = payload.node_id.clone();
    let mut map = state.fleet.write().unwrap();
    if let Some(entry) = map.get_mut(&node_id) {
        entry.last_seen_ms = now_ms();
        entry.metrics = Some(payload);
    }
    StatusCode::NO_CONTENT
}

/// GET /api/fleet
async fn handle_fleet(State(state): State<AppState>) -> impl IntoResponse {
    let map = state.fleet.read().unwrap();
    let nodes: Vec<NodeSummary> = map
        .values()
        .map(|e| NodeSummary {
            node_id:      e.node_id.clone(),
            fleet_url:    e.fleet_url.clone(),
            last_seen_ms: e.last_seen_ms,
            metrics:      e.metrics.clone(),
        })
        .collect();
    Json(FleetResponse { nodes })
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    let state = AppState {
        fleet:    Arc::new(RwLock::new(HashMap::new())),
        users:    Arc::new(RwLock::new(HashMap::new())),
        sessions: Arc::new(RwLock::new(HashMap::new())),
    };

    // Allow requests from the hosted dashboard and local dev origins.
    let origins: [HeaderValue; 4] = [
        "https://wicklee.com".parse().unwrap(),
        "https://wicklee.dev".parse().unwrap(),
        "http://localhost:7700".parse().unwrap(),
        "http://localhost:5173".parse().unwrap(),
    ];
    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any);

    let app = Router::new()
        .route("/api/auth/signup",  post(handle_signup))
        .route("/api/auth/login",   post(handle_login))
        .route("/api/auth/me",      get(handle_me))
        .route("/api/pair/claim",   post(handle_claim))
        .route("/api/telemetry",    post(handle_telemetry))
        .route("/api/fleet",        get(handle_fleet))
        .with_state(state)
        .layer(cors);

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
    println!("║  POST /api/pair/claim                        ║");
    println!("║  POST /api/telemetry                         ║");
    println!("║  GET  /api/fleet                             ║");
    println!("║  Listening on {addr:<30} ║");
    println!("╚══════════════════════════════════════════════╝");

    axum::serve(listener, app).await.expect("Server exited unexpectedly");
}
