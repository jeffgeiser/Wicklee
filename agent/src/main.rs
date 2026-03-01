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
use std::{
    convert::Infallible,
    sync::{Arc, Mutex},
    time::Duration,
};
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

/// Apple Silicon deep-metal metrics harvested from powermetrics.
/// All fields are `Option<f32>` so they serialize as JSON `null` when
/// powermetrics is unavailable (no sudo, non-Apple hardware, etc.).
#[derive(Serialize, Clone, Default)]
struct AppleSiliconMetrics {
    cpu_power_w:            Option<f32>,
    ecpu_power_w:           Option<f32>,
    pcpu_power_w:           Option<f32>,
    gpu_utilization_percent: Option<f32>,
    memory_pressure_percent: Option<f32>,
    /// "Normal" | "Elevated" | "High" | "Critical" — or null if unavailable.
    thermal_state:          Option<String>,
}

/// Streamed by /api/metrics at 1 Hz.
#[derive(Serialize)]
struct MetricsPayload {
    node_id:                 String,
    cpu_usage_percent:       f32,
    total_memory_mb:         u64,
    used_memory_mb:          u64,
    available_memory_mb:     u64,
    cpu_core_count:          usize,
    timestamp_ms:            u64,
    // ── Apple Silicon deep metal (null on non-Apple / no-sudo) ──────────────
    cpu_power_w:             Option<f32>,
    ecpu_power_w:            Option<f32>,
    pcpu_power_w:            Option<f32>,
    gpu_utilization_percent: Option<f32>,
    memory_pressure_percent: Option<f32>,
    thermal_state:           Option<String>,
}

// ── powermetrics harvester ────────────────────────────────────────────────────
//
// Spawned once as a background tokio task.  Runs `powermetrics` every ~2 s
// (slightly offset from the 1 Hz SSE loop to avoid lock contention), parses
// the plain-text output, and stores the result in a shared `Arc<Mutex<…>>`.
//
// The SSE loop reads the latest snapshot on each tick — no blocking, no sudo
// escalation inside the hot path.

/// Parse the plain-text `powermetrics` output for the fields we care about.
///
/// Relevant lines look like:
///   "CPU Power: 3210 mW"
///   "E-Cluster Power: 812 mW"
///   "P-Cluster Power: 2398 mW"
///   "GPU Power: 450 mW"         (sometimes absent on low-power samples)
///   "GPU Active residency: 12.45%"
///   "System Memory Pressure: 23%"   (or "Memory Pressure: 23%")
///   "Thermal level: Normal"
fn parse_powermetrics(output: &str) -> AppleSiliconMetrics {
    let mut m = AppleSiliconMetrics::default();

    for line in output.lines() {
        let line = line.trim();

        // CPU total power
        if let Some(rest) = line.strip_prefix("CPU Power: ") {
            m.cpu_power_w = parse_mw(rest);
        }
        // Efficiency cluster
        else if let Some(rest) = line.strip_prefix("E-Cluster Power: ")
            .or_else(|| line.strip_prefix("E-core Power: "))
        {
            m.ecpu_power_w = parse_mw(rest);
        }
        // Performance cluster
        else if let Some(rest) = line.strip_prefix("P-Cluster Power: ")
            .or_else(|| line.strip_prefix("P-core Power: "))
        {
            m.pcpu_power_w = parse_mw(rest);
        }
        // GPU active residency (utilisation %)
        else if let Some(rest) = line.strip_prefix("GPU Active residency: ") {
            m.gpu_utilization_percent = parse_percent(rest);
        }
        // Memory pressure
        else if let Some(rest) = line.strip_prefix("System Memory Pressure: ")
            .or_else(|| line.strip_prefix("Memory Pressure: "))
        {
            m.memory_pressure_percent = parse_percent(rest);
        }
        // Thermal state
        else if let Some(rest) = line.strip_prefix("Thermal level: ")
            .or_else(|| line.strip_prefix("Thermal pressure: "))
        {
            let state = rest.split_whitespace().next().unwrap_or("").to_string();
            if !state.is_empty() {
                m.thermal_state = Some(state);
            }
        }
    }

    m
}

/// Parse "3210 mW" → Some(3.21)  (convert mW → W)
fn parse_mw(s: &str) -> Option<f32> {
    let num: f32 = s.split_whitespace().next()?.parse().ok()?;
    Some(num / 1000.0)
}

/// Parse "12.45%" → Some(12.45)
fn parse_percent(s: &str) -> Option<f32> {
    let clean = s.trim_end_matches('%').split_whitespace().next()?;
    clean.parse().ok()
}

/// Spawn the background harvester task.
///
/// Returns an `Arc<Mutex<AppleSiliconMetrics>>` that the SSE loop can clone
/// and read on every tick.  If powermetrics is unavailable the mutex always
/// contains the `Default` (all-null) value.
fn start_powermetrics_harvester() -> Arc<Mutex<AppleSiliconMetrics>> {
    let shared = Arc::new(Mutex::new(AppleSiliconMetrics::default()));
    let shared_clone = Arc::clone(&shared);

    tokio::spawn(async move {
        // Check once whether powermetrics is even on this system.
        // On non-macOS builds, or without sudo, we log and exit the task
        // immediately — the SSE stream will emit null fields gracefully.
        let probe = tokio::process::Command::new("sudo")
            .args(["-n", "powermetrics", "--samplers", "cpu_power,gpu_power,thermal",
                   "-n", "1", "-i", "500"])
            .output()
            .await;

        match probe {
            Err(e) => {
                eprintln!("[powermetrics] spawn error — deep metal disabled: {e}");
                return;
            }
            Ok(out) if !out.status.success() => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                eprintln!("[powermetrics] not available (non-zero exit) — deep metal disabled.\n  → {stderr}");
                return;
            }
            Ok(out) => {
                // First sample succeeded — parse and store immediately.
                let text = String::from_utf8_lossy(&out.stdout);
                let parsed = parse_powermetrics(&text);
                if let Ok(mut guard) = shared_clone.lock() {
                    *guard = parsed;
                }
            }
        }

        // Steady-state: refresh every 2 s (interleaved with 1 Hz SSE ticks).
        let mut interval = tokio::time::interval(Duration::from_secs(2));
        loop {
            interval.tick().await;

            let result = tokio::process::Command::new("sudo")
                .args(["-n", "powermetrics", "--samplers", "cpu_power,gpu_power,thermal",
                       "-n", "1", "-i", "500"])
                .output()
                .await;

            match result {
                Ok(out) if out.status.success() => {
                    let text = String::from_utf8_lossy(&out.stdout);
                    let parsed = parse_powermetrics(&text);
                    if let Ok(mut guard) = shared_clone.lock() {
                        *guard = parsed;
                    }
                }
                Ok(out) => {
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    eprintln!("[powermetrics] sample failed: {stderr}");
                    // Keep the last good values in the mutex — don't zero them out.
                }
                Err(e) => {
                    eprintln!("[powermetrics] spawn error: {e}");
                }
            }
        }
    });

    shared
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
async fn handle_metrics(
    axum::extract::Extension(apple_metrics): axum::extract::Extension<Arc<Mutex<AppleSiliconMetrics>>>,
) -> Sse<ReceiverStream<Result<Event, Infallible>>> {
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

            // Snapshot the latest Apple Silicon metrics (non-blocking mutex read).
            let apple = apple_metrics
                .lock()
                .map(|g| g.clone())
                .unwrap_or_default();

            let payload = MetricsPayload {
                node_id: node_id.clone(),
                cpu_usage_percent: sys.global_cpu_info().cpu_usage(),
                total_memory_mb:   sys.total_memory()     / 1024 / 1024,
                used_memory_mb:    sys.used_memory()      / 1024 / 1024,
                available_memory_mb: sys.available_memory() / 1024 / 1024,
                cpu_core_count:    sys.cpus().len(),
                timestamp_ms,
                // Apple Silicon deep metal (null on non-Apple / no-sudo)
                cpu_power_w:             apple.cpu_power_w,
                ecpu_power_w:            apple.ecpu_power_w,
                pcpu_power_w:            apple.pcpu_power_w,
                gpu_utilization_percent: apple.gpu_utilization_percent,
                memory_pressure_percent: apple.memory_pressure_percent,
                thermal_state:           apple.thermal_state,
            };

            let event = match Event::default().json_data(&payload) {
                Ok(e)  => e,
                Err(_) => continue,
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
    // Start the Apple Silicon powermetrics harvester in the background.
    // Returns immediately with a shared handle; the harvester probes
    // `sudo -n powermetrics` and self-disables gracefully if unavailable.
    let apple_metrics = start_powermetrics_harvester();

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
        .layer(axum::extract::Extension(apple_metrics))
        .layer(cors);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:7700")
        .await
        .expect("Failed to bind port 7700 — is another process using it?");

    println!("╔══════════════════════════════════════════════╗");
    println!("║                                              ║");
    println!("║   Wicklee Sentinel Active                    ║");
    println!("║   http://localhost:7700                      ║");
    println!("║                                              ║");
    println!("╚══════════════════════════════════════════════╝");

    axum::serve(listener, app)
        .await
        .expect("Server exited unexpectedly");
}
