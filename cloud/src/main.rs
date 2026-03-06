use axum::{
    extract::State,
    http::{HeaderValue, StatusCode},
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

// ── Shared payload shape — must stay in sync with the agent ──────────────────
//
// All Option fields carry null on platforms that don't expose the metric;
// the cloud stores whatever the agent sends without interpreting it.

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

// ── Request / Response types ──────────────────────────────────────────────────

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

// ── In-memory node registry ───────────────────────────────────────────────────

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

type Fleet = Arc<RwLock<HashMap<String, NodeEntry>>>;

// ── Helpers ───────────────────────────────────────────────────────────────────

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Simple session token — not a security primitive yet; the claim code +
/// WK identity is the only gate at this stage.
fn mint_token(node_id: &str) -> String {
    format!("wk_{:x}_{node_id}", now_ms())
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/// POST /api/pair/claim
///
/// Called by the agent after the user triggers --pair. Registers the node
/// in the in-memory fleet and returns a session token the agent can store.
async fn handle_claim(
    State(fleet): State<Fleet>,
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

    let token = mint_token(&body.node_id);
    fleet.write().unwrap().insert(
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
///
/// Agents POST their MetricsPayload here after pairing. The node_id field
/// inside the payload is the lookup key — telemetry from unregistered nodes
/// is silently dropped (no auth, no info leak).
async fn handle_telemetry(
    State(fleet): State<Fleet>,
    Json(payload): Json<MetricsPayload>,
) -> StatusCode {
    let node_id = payload.node_id.clone();
    let mut map = fleet.write().unwrap();
    if let Some(entry) = map.get_mut(&node_id) {
        entry.last_seen_ms = now_ms();
        entry.metrics = Some(payload);
    }
    StatusCode::NO_CONTENT
}

/// GET /api/fleet
///
/// Returns every registered node with its latest metrics snapshot.
/// Suitable for the Fleet Overview dashboard page.
async fn handle_fleet(State(fleet): State<Fleet>) -> impl IntoResponse {
    let map = fleet.read().unwrap();
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
    let fleet: Fleet = Arc::new(RwLock::new(HashMap::new()));

    // Allow requests from the hosted dashboard origins only.
    let origins: [HeaderValue; 2] = [
        "https://wicklee.com".parse().unwrap(),
        "https://wicklee.dev".parse().unwrap(),
    ];
    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any);

    let app = Router::new()
        .route("/api/pair/claim", post(handle_claim))
        .route("/api/telemetry",  post(handle_telemetry))
        .route("/api/fleet",      get(handle_fleet))
        .with_state(fleet)
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
    println!("║  POST /api/pair/claim                        ║");
    println!("║  POST /api/telemetry                         ║");
    println!("║  GET  /api/fleet                             ║");
    println!("║  Listening on {addr:<30} ║");
    println!("╚══════════════════════════════════════════════╝");

    axum::serve(listener, app).await.expect("Server exited unexpectedly");
}
