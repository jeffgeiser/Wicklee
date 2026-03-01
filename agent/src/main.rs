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

/// Apple Silicon / macOS deep-metal metrics.
/// All fields are `Option` — serialize as JSON `null` when unavailable.
#[derive(Serialize, Clone, Default)]
struct AppleSiliconMetrics {
    cpu_power_w:             Option<f32>,
    ecpu_power_w:            Option<f32>,
    pcpu_power_w:            Option<f32>,
    gpu_utilization_percent: Option<f32>,
    memory_pressure_percent: Option<f32>,
    thermal_state:           Option<String>,
}

/// Streamed by /api/metrics at 1 Hz.
#[derive(Serialize)]
struct MetricsPayload {
    node_id:                 String,
    cpu_usage_percent:       f32,
    total_memory_mb:         u64,
    used_memory_mb:          u64,
    available_memory_mb:     u64,   // Bug 1 fix: computed as total - used
    cpu_core_count:          usize,
    timestamp_ms:            u64,
    // Deep-metal (null when unavailable)
    cpu_power_w:             Option<f32>,
    ecpu_power_w:            Option<f32>,
    pcpu_power_w:            Option<f32>,
    gpu_utilization_percent: Option<f32>,
    memory_pressure_percent: Option<f32>,
    thermal_state:           Option<String>,
}

// ── Hardware Helpers ──────────────────────────────────────────────────────────

/// Read CPU thermal pressure level via `sysctl` — no subprocess, no sudo.
///
/// Key `machdep.xcpm.cpu_thermal_level` is Intel-specific; returns `None`
/// on Apple Silicon (key absent) — the caller falls back to other sources.
/// Values: 0 = Normal, 1 = Elevated, 2 = High, 3+ = Critical.
fn read_thermal_sysctl() -> Option<String> {
    use sysctl::Sysctl;
    let ctl = sysctl::Ctl::new("machdep.xcpm.cpu_thermal_level").ok()?;
    let val: i32 = ctl.value_string().ok()?.trim().parse().ok()?;
    Some(match val {
        0 => "Normal",
        1 => "Elevated",
        2 => "High",
        _ => "Critical",
    }.to_string())
}

/// Read GPU utilization % via `ioreg -r -c IOAccelerator` — no sudo required.
///
/// Parses `"Device Utilization %":N` out of the PerformanceStatistics
/// dictionary that every Metal-capable GPU publishes.
async fn read_gpu_ioreg() -> Option<f32> {
    let out = tokio::process::Command::new("ioreg")
        .args(["-r", "-c", "IOAccelerator"])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_ioreg_gpu(&String::from_utf8_lossy(&out.stdout))
}

fn parse_ioreg_gpu(text: &str) -> Option<f32> {
    for line in text.lines() {
        if let Some(pos) = line.find("\"Device Utilization %\"") {
            let after = &line[pos + "\"Device Utilization %\"".len()..];
            let after = after.trim_start_matches(|c: char| c == ':' || c == ' ');
            let num: String = after
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            if let Ok(v) = num.parse::<f32>() {
                return Some(v);
            }
        }
    }
    None
}

/// Attempt `powermetrics` without sudo — works on some macOS configs where
/// the binary has been granted the `com.apple.private.iokit.powerlogging`
/// entitlement or the user has a NOPASSWD sudoers entry.
/// Gracefully returns `None` if it exits non-zero.
async fn try_powermetrics_nosudo() -> Option<AppleSiliconMetrics> {
    let out = tokio::process::Command::new("powermetrics")
        .args(["--samplers", "cpu_power,gpu_power,thermal", "-n", "1", "-i", "1000"])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(parse_powermetrics(&String::from_utf8_lossy(&out.stdout)))
}

/// Parse plain-text `powermetrics` output.
///
/// Relevant lines:
///   "CPU Power: 3210 mW"
///   "E-Cluster Power: 812 mW"
///   "P-Cluster Power: 2398 mW"
///   "GPU Active residency: 12.45%"
///   "System Memory Pressure: 23%"
///   "Thermal level: Normal"
fn parse_powermetrics(output: &str) -> AppleSiliconMetrics {
    let mut m = AppleSiliconMetrics::default();
    for line in output.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("CPU Power: ") {
            m.cpu_power_w = parse_mw(rest);
        } else if let Some(rest) = line.strip_prefix("E-Cluster Power: ")
            .or_else(|| line.strip_prefix("E-core Power: "))
        {
            m.ecpu_power_w = parse_mw(rest);
        } else if let Some(rest) = line.strip_prefix("P-Cluster Power: ")
            .or_else(|| line.strip_prefix("P-core Power: "))
        {
            m.pcpu_power_w = parse_mw(rest);
        } else if let Some(rest) = line.strip_prefix("GPU Active residency: ") {
            m.gpu_utilization_percent = parse_percent(rest);
        } else if let Some(rest) = line.strip_prefix("System Memory Pressure: ")
            .or_else(|| line.strip_prefix("Memory Pressure: "))
        {
            m.memory_pressure_percent = parse_percent(rest);
        } else if let Some(rest) = line.strip_prefix("Thermal level: ")
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

fn parse_mw(s: &str) -> Option<f32> {
    let num: f32 = s.split_whitespace().next()?.parse().ok()?;
    Some(num / 1000.0)
}

fn parse_percent(s: &str) -> Option<f32> {
    s.trim_end_matches('%').split_whitespace().next()?.parse().ok()
}

// ── Background Harvester ──────────────────────────────────────────────────────
//
// Runs every 2 s (offset from the 1 Hz SSE loop to avoid lock contention).
// Priority order per the spec:
//   1. Thermal  → sysctl (sync, zero cost, no subprocess)
//   2. GPU      → ioreg  (async subprocess, no sudo)
//   3. CPU power / mem pressure → powermetrics without sudo (may fail)
//
// All sources degrade gracefully to null — the loop never panics.

fn start_metrics_harvester() -> Arc<Mutex<AppleSiliconMetrics>> {
    let shared = Arc::new(Mutex::new(AppleSiliconMetrics::default()));
    let shared_clone = Arc::clone(&shared);

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(2));
        loop {
            interval.tick().await;

            let mut m = AppleSiliconMetrics::default();

            // 1. Thermal via sysctl — fast, synchronous, no subprocess
            m.thermal_state = read_thermal_sysctl();

            // 2. GPU utilization via ioreg — no sudo
            m.gpu_utilization_percent = read_gpu_ioreg().await;

            // 3. CPU power + memory pressure via powermetrics (no sudo)
            if let Some(pm) = try_powermetrics_nosudo().await {
                m.cpu_power_w             = pm.cpu_power_w;
                m.ecpu_power_w            = pm.ecpu_power_w;
                m.pcpu_power_w            = pm.pcpu_power_w;
                m.memory_pressure_percent = pm.memory_pressure_percent;
                // powermetrics thermal overrides sysctl if present
                if pm.thermal_state.is_some() {
                    m.thermal_state = pm.thermal_state;
                }
                // powermetrics may also give GPU — prefer ioreg if we already have it
                if m.gpu_utilization_percent.is_none() {
                    m.gpu_utilization_percent = pm.gpu_utilization_percent;
                }
            }

            if let Ok(mut guard) = shared_clone.lock() {
                *guard = m;
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
async fn handle_metrics(
    axum::extract::Extension(apple_metrics): axum::extract::Extension<Arc<Mutex<AppleSiliconMetrics>>>,
) -> Sse<ReceiverStream<Result<Event, Infallible>>> {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, Infallible>>(4);

    tokio::spawn(async move {
        let mut sys = System::new_all();
        let node_id = System::host_name()
            .unwrap_or_else(|| "wicklee-sentinel-01".to_string());

        // Seed CPU baseline — sysinfo needs two reads separated by ~200ms
        // for an accurate delta; without this the first tick returns 0%.
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

            let total    = sys.total_memory();
            let used     = sys.used_memory();
            // Bug 1 fix: sysinfo's available_memory() returns 0 on some macOS
            // versions; derive it reliably from total - used instead.
            let available = total.saturating_sub(used);

            let apple = apple_metrics
                .lock()
                .map(|g| g.clone())
                .unwrap_or_default();

            let payload = MetricsPayload {
                node_id:             node_id.clone(),
                cpu_usage_percent:   sys.global_cpu_info().cpu_usage(),
                total_memory_mb:     total     / 1024 / 1024,
                used_memory_mb:      used      / 1024 / 1024,
                available_memory_mb: available / 1024 / 1024,
                cpu_core_count:      sys.cpus().len(),
                timestamp_ms,
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

async fn static_handler(uri: Uri) -> impl IntoResponse {
    let raw = uri.path().trim_start_matches('/');
    let path = if raw.is_empty() { "index.html" } else { raw };
    serve_asset(path)
}

fn serve_asset(path: &str) -> Response<Body> {
    if let Some(content) = StaticAssets::get(path) {
        let mime = from_path(path).first_or_octet_stream();
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime.as_ref())
            .body(Body::from(content.data.into_owned()))
            .unwrap();
    }
    if let Some(index) = StaticAssets::get("index.html") {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .body(Body::from(index.data.into_owned()))
            .unwrap();
    }
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
    let apple_metrics = start_metrics_harvester();

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/tags",    get(handle_tags))
        .route("/api/metrics", get(handle_metrics))
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
