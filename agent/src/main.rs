use axum::{
    body::Body,
    http::{header, Response, StatusCode, Uri},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    },
    routing::get,
    Json, Router,
};
use mime_guess::from_path;
use rust_embed::RustEmbed;
use serde::Serialize;
use std::{convert::Infallible, time::Duration};
use sysinfo::System;
use tokio_stream::wrappers::ReceiverStream;
use tower_http::cors::{Any, CorsLayer};

// ── Embedded Frontend ─────────────────────────────────────────────────────────
// At compile time, rust-embed reads every file under agent/frontend/dist/ and
// bakes them into the binary with Brotli compression.  The folder path is
// relative to this crate's Cargo.toml.  Run `npm run build` from the repo root
// first — vite.config.ts is already configured to output there.

#[derive(RustEmbed)]
#[folder = "frontend/dist"]
struct StaticAssets;

// ── Response Types ────────────────────────────────────────────────────────────

/// /api/tags — satisfies SecurityView.tsx "Test Connection" (Ollama wire shape).
#[derive(Serialize)]
struct TagsResponse {
    models: Vec<ModelInfo>,
}

#[derive(Serialize)]
struct ModelInfo {
    name: String,
    size: u64,
}

/// Streamed by /api/metrics at 1 Hz.
#[derive(Serialize)]
struct MetricsPayload {
    node_id: String,
    cpu_usage_percent: f32,
    total_memory_mb: u64,
    used_memory_mb: u64,
    available_memory_mb: u64,
    cpu_core_count: usize,
    timestamp_ms: u64,
}

// ── API Handlers ──────────────────────────────────────────────────────────────

/// GET /api/tags
async fn handle_tags() -> Json<TagsResponse> {
    Json(TagsResponse {
        models: vec![
            ModelInfo { name: "phi3:mini".into(),    size: 2_200_000_000 },
            ModelInfo { name: "mistral".into(),       size: 4_100_000_000 },
            ModelInfo { name: "qwen2.5:1.5b".into(), size: 1_600_000_000 },
        ],
    })
}

/// GET /api/metrics — SSE stream, one telemetry snapshot per second.
///
/// Architecture: a dedicated tokio task owns the `System` handle and refreshes
/// it every second, then sends the payload through an mpsc channel.
/// `ReceiverStream` bridges the channel into the `Stream` that `Sse` requires.
/// When the client disconnects the receiver is dropped, `tx.send()` returns
/// `Err`, and the task exits cleanly — no zombie threads.
async fn handle_metrics() -> Sse<ReceiverStream<Result<Event, Infallible>>> {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, Infallible>>(4);

    tokio::spawn(async move {
        let mut sys = System::new_all();
        let node_id = System::host_name()
            .unwrap_or_else(|| "wicklee-sentinel-01".to_string());

        // Seed the CPU baseline — sysinfo computes usage as a delta between two
        // consecutive reads.  Without this first read the first tick returns 0.
        sys.refresh_all();
        tokio::time::sleep(Duration::from_millis(200)).await;

        let mut interval = tokio::time::interval(Duration::from_secs(1));

        loop {
            interval.tick().await;
            sys.refresh_all();
            sys.refresh_memory();

            let timestamp_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;

            let payload = MetricsPayload {
                node_id: node_id.clone(),
                cpu_usage_percent: sys.global_cpu_info().cpu_usage(),
                total_memory_mb: sys.total_memory() / 1024 / 1024,
                used_memory_mb: sys.used_memory() / 1024 / 1024,
                available_memory_mb: sys.available_memory() / 1024 / 1024,
                cpu_core_count: sys.cpus().len(),
                timestamp_ms,
            };

            let event = match Event::default().json_data(&payload) {
                Ok(e)  => e,
                Err(_) => continue, // serialisation can't fail for this type, but be safe
            };

            if tx.send(Ok(event)).await.is_err() {
                break; // Receiver dropped → client disconnected
            }
        }
    });

    Sse::new(ReceiverStream::new(rx))
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

// ── Static Asset Serving ──────────────────────────────────────────────────────

/// Fallback handler — serves every request that isn't an /api/* route.
///
/// Lookup order:
///   1. Exact asset match in the embed (e.g. `/assets/main-abc123.js`)
///   2. `/` or bare path → serve `index.html`
///   3. Unknown path (e.g. `/nodes`, `/team`) → serve `index.html`
///      so client-side React Router takes over (SPA fallback).
///
/// If the build hasn't been run yet and the embed is empty, a helpful
/// error message is returned instead of a blank 404.
async fn static_handler(uri: Uri) -> impl IntoResponse {
    let raw = uri.path().trim_start_matches('/');
    let path = if raw.is_empty() { "index.html" } else { raw };
    serve_asset(path)
}

fn serve_asset(path: &str) -> Response<Body> {
    // ── 1. Exact match ────────────────────────────────────────────────────────
    if let Some(content) = StaticAssets::get(path) {
        let mime = from_path(path).first_or_octet_stream();
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime.as_ref())
            .body(Body::from(content.data.into_owned()))
            .unwrap();
    }

    // ── 2 & 3. SPA fallback: serve index.html for all unknown paths ───────────
    if let Some(index) = StaticAssets::get("index.html") {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .body(Body::from(index.data.into_owned()))
            .unwrap();
    }

    // ── Frontend not built yet ────────────────────────────────────────────────
    Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header(header::CONTENT_TYPE, "text/plain")
        .body(Body::from(
            "Frontend assets not embedded.\n\
             Run `npm run build` from the repo root, then recompile the agent.",
        ))
        .unwrap()
}

// ── Server Bootstrap ──────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    // Permissive CORS so the Railway-hosted dashboard can reach a locally
    // running Sentinel even when origins differ (e.g. during development).
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/tags",    get(handle_tags))
        .route("/api/metrics", get(handle_metrics))
        // Every other path (including /) goes to the SPA handler.
        .fallback(static_handler)
        .layer(cors);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:7700")
        .await
        .expect("Failed to bind port 7700 — is another process using it?");

    println!("╔══════════════════════════════════════════════╗");
    println!("║                                              ║");
    println!("║   Wicklee Dashboard Active                   ║");
    println!("║   http://localhost:7700                      ║");
    println!("║                                              ║");
    println!("╚══════════════════════════════════════════════╝");

    axum::serve(listener, app)
        .await
        .expect("Server exited unexpectedly");
}
