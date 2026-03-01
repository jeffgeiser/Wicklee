use axum::{routing::get, Json, Router};
use serde::Serialize;
use sysinfo::System;
use tower_http::cors::{Any, CorsLayer};

// ── Response Types ────────────────────────────────────────────────────────────

/// Mirrors the shape SecurityView.tsx expects from /api/tags
#[derive(Serialize)]
struct TagsResponse {
    models: Vec<ModelInfo>,
}

#[derive(Serialize)]
struct ModelInfo {
    name: String,
    size: u64,
}

/// Hardware telemetry snapshot returned by /api/telemetry
#[derive(Serialize)]
struct TelemetryResponse {
    node_id: String,
    cpu_usage_percent: f32,
    total_memory_mb: u64,
    used_memory_mb: u64,
    available_memory_mb: u64,
    cpu_core_count: usize,
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/// GET /api/tags
/// Returns a hardcoded list of locally available models — satisfies the
/// SecurityView.tsx "Test Connection" check which calls this endpoint.
async fn handle_tags() -> Json<TagsResponse> {
    Json(TagsResponse {
        models: vec![
            ModelInfo {
                name: "phi3:mini".to_string(),
                size: 2_200_000_000,
            },
            ModelInfo {
                name: "mistral".to_string(),
                size: 4_100_000_000,
            },
            ModelInfo {
                name: "qwen2.5:1.5b".to_string(),
                size: 1_600_000_000,
            },
        ],
    })
}

/// GET /api/telemetry
/// Uses sysinfo to sample real CPU + RAM from the host machine.
async fn handle_telemetry() -> Json<TelemetryResponse> {
    let mut sys = System::new_all();
    sys.refresh_all();

    let total_memory_mb = sys.total_memory() / 1024 / 1024;
    let used_memory_mb = sys.used_memory() / 1024 / 1024;
    let available_memory_mb = total_memory_mb.saturating_sub(used_memory_mb);

    // Global CPU usage — average across all logical cores
    let cpu_usage_percent = sys.global_cpu_info().cpu_usage();
    let cpu_core_count = sys.cpus().len();

    // Node ID derived from hostname; fall back to a static sentinel name
    let node_id = System::host_name().unwrap_or_else(|| "wicklee-sentinel-01".to_string());

    Json(TelemetryResponse {
        node_id,
        cpu_usage_percent,
        total_memory_mb,
        used_memory_mb,
        available_memory_mb,
        cpu_core_count,
    })
}

// ── Server Bootstrap ──────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    // Permissive CORS — allows the Railway-hosted dashboard (any origin)
    // to call this local agent during development and after deployment.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/tags", get(handle_tags))
        .route("/api/telemetry", get(handle_telemetry))
        .layer(cors);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000")
        .await
        .expect("Failed to bind port 3000 — is another process already listening?");

    println!("╔══════════════════════════════════════════════╗");
    println!("║  Sentinel Active: Listening for Sovereign    ║");
    println!("║  Dashboard on http://0.0.0.0:3000            ║");
    println!("╚══════════════════════════════════════════════╝");

    axum::serve(listener, app)
        .await
        .expect("Server exited unexpectedly");
}
