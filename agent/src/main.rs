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

#[derive(Serialize)]
struct TagsResponse { models: Vec<ModelInfo> }

#[derive(Serialize)]
struct ModelInfo { name: String, size: u64 }

#[derive(Serialize, Clone, Default)]
struct AppleSiliconMetrics {
    cpu_power_w:             Option<f32>,
    ecpu_power_w:            Option<f32>,
    pcpu_power_w:            Option<f32>,
    gpu_utilization_percent: Option<f32>,
    memory_pressure_percent: Option<f32>,
    thermal_state:           Option<String>,
}

#[derive(Serialize)]
struct MetricsPayload {
    node_id:                 String,
    cpu_usage_percent:       f32,
    total_memory_mb:         u64,
    used_memory_mb:          u64,
    available_memory_mb:     u64,
    cpu_core_count:          usize,
    timestamp_ms:            u64,
    cpu_power_w:             Option<f32>,
    ecpu_power_w:            Option<f32>,
    pcpu_power_w:            Option<f32>,
    gpu_utilization_percent: Option<f32>,
    memory_pressure_percent: Option<f32>,
    thermal_state:           Option<String>,
}

// ── Hardware Helpers ──────────────────────────────────────────────────────────

/// Thermal via sysctl — Intel-only key; returns None on Apple Silicon.
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

/// Thermal via `pmset -g therm` — works on Apple Silicon, no sudo.
///
/// Parses `CPU_Speed_Limit` (or `CPU_Scheduler_Limit` as fallback):
///   100    → Normal
///   80-99  → Elevated
///   50-79  → High
///   < 50   → Critical
async fn read_thermal_pmset() -> Option<String> {
    let out = tokio::process::Command::new("pmset")
        .args(["-g", "therm"])
        .output()
        .await
        .ok()?;
    if !out.status.success() { return None; }
    parse_pmset_therm(&String::from_utf8_lossy(&out.stdout))
}

fn parse_pmset_therm(output: &str) -> Option<String> {
    for line in output.lines() {
        let line = line.trim();
        // Try CPU_Speed_Limit first, then CPU_Scheduler_Limit
        let val_str = if let Some(rest) = line.strip_prefix("CPU_Speed_Limit") {
            Some(rest)
        } else if let Some(rest) = line.strip_prefix("CPU_Scheduler_Limit") {
            Some(rest)
        } else {
            None
        };
        if let Some(rest) = val_str {
            let val: u32 = rest
                .trim_start_matches(|c: char| c == ' ' || c == '=')
                .trim()
                .parse()
                .ok()?;
            return Some(match val {
                100       => "Normal",
                80..=99   => "Elevated",
                50..=79   => "High",
                _         => "Critical",
            }.to_string());
        }
    }
    None
}

/// GPU utilization via ioreg — no sudo.
/// Tries `IOAccelerator` first (Intel/AMD), then `IOGPUDevice` (Apple Silicon AGX).
async fn read_gpu_ioreg() -> Option<f32> {
    for class in &["IOAccelerator", "IOGPUDevice"] {
        if let Some(v) = try_ioreg_class(class).await {
            return Some(v);
        }
    }
    None
}

async fn try_ioreg_class(class: &str) -> Option<f32> {
    let out = tokio::process::Command::new("ioreg")
        .args(["-r", "-c", class])
        .output()
        .await
        .ok()?;
    if !out.status.success() { return None; }
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

/// powermetrics without sudo — parses CPU power + memory pressure.
async fn try_powermetrics_nosudo() -> Option<AppleSiliconMetrics> {
    let out = tokio::process::Command::new("powermetrics")
        .args(["--samplers", "cpu_power,gpu_power,thermal", "-n", "1", "-i", "1000"])
        .output()
        .await
        .ok()?;
    if !out.status.success() { return None; }
    Some(parse_powermetrics(&String::from_utf8_lossy(&out.stdout)))
}

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
            if !state.is_empty() { m.thermal_state = Some(state); }
        }
    }
    m
}

fn parse_mw(s: &str) -> Option<f32> {
    let n: f32 = s.split_whitespace().next()?.parse().ok()?;
    Some(n / 1000.0)
}
fn parse_percent(s: &str) -> Option<f32> {
    s.trim_end_matches('%').split_whitespace().next()?.parse().ok()
}

// ── Startup Diagnostics ───────────────────────────────────────────────────────
//
// Runs once at boot and prints to stderr so you can see exactly which source
// is available on this machine.  Safe to leave in production — it's just
// informational stderr and adds < 2 s to startup.

async fn run_startup_diagnostics() {
    eprintln!("──────────────────────────────────────────────");
    eprintln!("[diag] Wicklee Sentinel — hardware source probe");
    eprintln!("──────────────────────────────────────────────");

    // 1. sysctl thermal (Intel key)
    {
        use sysctl::Sysctl;
        match sysctl::Ctl::new("machdep.xcpm.cpu_thermal_level") {
            Ok(ctl) => match ctl.value_string() {
                Ok(v)  => eprintln!("[diag] sysctl thermal          OK  → level={}", v.trim()),
                Err(e) => eprintln!("[diag] sysctl thermal          ERR → {}", e),
            },
            Err(e) => eprintln!("[diag] sysctl thermal          MISS → {} (expected on Apple Silicon)", e),
        }
    }

    // 2. pmset -g therm (M-series thermal)
    match tokio::process::Command::new("pmset").args(["-g", "therm"]).output().await {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout);
            eprintln!("[diag] pmset -g therm          exit={}", out.status);
            // Print relevant lines only
            for line in text.lines() {
                let l = line.trim();
                if l.starts_with("CPU_Speed_Limit") || l.starts_with("CPU_Scheduler_Limit")
                    || l.starts_with("GPU_Available") || l.starts_with("System-wide") {
                    eprintln!("[diag]   {}", l);
                }
            }
            match parse_pmset_therm(&text) {
                Some(state) => eprintln!("[diag] pmset thermal parsed    OK  → {}", state),
                None        => eprintln!("[diag] pmset thermal parsed    MISS → no CPU_Speed_Limit or CPU_Scheduler_Limit found"),
            }
        }
        Err(e) => eprintln!("[diag] pmset -g therm          ERR → {}", e),
    }

    // 3. ioreg IOAccelerator (Intel/AMD GPU)
    match tokio::process::Command::new("ioreg").args(["-r", "-c", "IOAccelerator"]).output().await {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout);
            eprintln!("[diag] ioreg IOAccelerator      exit={} size={}B", out.status, text.len());
            let preview: String = text.chars().take(300).collect();
            eprintln!("[diag]   preview: {}", preview.replace('\n', "↵"));
            match parse_ioreg_gpu(&text) {
                Some(v) => eprintln!("[diag] IOAccelerator GPU util   OK  → {}%", v),
                None    => eprintln!("[diag] IOAccelerator GPU util   MISS → 'Device Utilization %' not found"),
            }
        }
        Err(e) => eprintln!("[diag] ioreg IOAccelerator      ERR → {}", e),
    }

    // 4. ioreg IOGPUDevice (Apple Silicon AGX)
    match tokio::process::Command::new("ioreg").args(["-r", "-c", "IOGPUDevice"]).output().await {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout);
            eprintln!("[diag] ioreg IOGPUDevice        exit={} size={}B", out.status, text.len());
            let preview: String = text.chars().take(300).collect();
            eprintln!("[diag]   preview: {}", preview.replace('\n', "↵"));
            match parse_ioreg_gpu(&text) {
                Some(v) => eprintln!("[diag] IOGPUDevice GPU util     OK  → {}%", v),
                None    => eprintln!("[diag] IOGPUDevice GPU util     MISS → 'Device Utilization %' not found"),
            }
        }
        Err(e) => eprintln!("[diag] ioreg IOGPUDevice        ERR → {}", e),
    }

    // 5. powermetrics without sudo
    match tokio::process::Command::new("powermetrics")
        .args(["-n", "1", "-i", "500", "--samplers", "cpu_power"])
        .output()
        .await
    {
        Ok(out) => {
            eprintln!("[diag] powermetrics (no sudo)   exit={}", out.status);
            let stdout_p: String = String::from_utf8_lossy(&out.stdout).chars().take(200).collect();
            let stderr_p: String = String::from_utf8_lossy(&out.stderr).chars().take(200).collect();
            eprintln!("[diag]   stdout[0..200]: {}", stdout_p.replace('\n', "↵"));
            eprintln!("[diag]   stderr[0..200]: {}", stderr_p.replace('\n', "↵"));
        }
        Err(e) => eprintln!("[diag] powermetrics (no sudo)   ERR → {}", e),
    }

    eprintln!("──────────────────────────────────────────────");
}

// ── Background Harvester ──────────────────────────────────────────────────────

fn start_metrics_harvester() -> Arc<Mutex<AppleSiliconMetrics>> {
    let shared = Arc::new(Mutex::new(AppleSiliconMetrics::default()));
    let shared_clone = Arc::clone(&shared);

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(2));
        loop {
            interval.tick().await;

            let mut m = AppleSiliconMetrics::default();

            // 1. Thermal: sysctl (Intel) → pmset (M-series)
            m.thermal_state = read_thermal_sysctl();
            if m.thermal_state.is_none() {
                m.thermal_state = read_thermal_pmset().await;
            }

            // 2. GPU: IOAccelerator → IOGPUDevice (Apple Silicon AGX)
            m.gpu_utilization_percent = read_gpu_ioreg().await;

            // 3. CPU power / memory pressure via powermetrics (no sudo)
            if let Some(pm) = try_powermetrics_nosudo().await {
                m.cpu_power_w             = pm.cpu_power_w;
                m.ecpu_power_w            = pm.ecpu_power_w;
                m.pcpu_power_w            = pm.pcpu_power_w;
                m.memory_pressure_percent = pm.memory_pressure_percent;
                if pm.thermal_state.is_some() { m.thermal_state = pm.thermal_state; }
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

async fn handle_tags() -> Json<TagsResponse> {
    Json(TagsResponse {
        models: vec![
            ModelInfo { name: "phi3:mini".into(),    size: 2_200_000_000 },
            ModelInfo { name: "mistral".into(),       size: 4_100_000_000 },
            ModelInfo { name: "qwen2.5:1.5b".into(), size: 1_600_000_000 },
        ],
    })
}

async fn handle_metrics(
    axum::extract::Extension(apple_metrics): axum::extract::Extension<Arc<Mutex<AppleSiliconMetrics>>>,
) -> Sse<ReceiverStream<Result<Event, Infallible>>> {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, Infallible>>(4);

    tokio::spawn(async move {
        let mut sys = System::new_all();
        let node_id = System::host_name()
            .unwrap_or_else(|| "wicklee-sentinel-01".to_string());

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

            let total     = sys.total_memory();
            let used      = sys.used_memory();
            let available = total.saturating_sub(used);

            let apple = apple_metrics.lock().map(|g| g.clone()).unwrap_or_default();

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

            if tx.send(Ok(event)).await.is_err() { break; }
        }
    });

    Sse::new(ReceiverStream::new(rx))
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

// ── Static Asset Serving ──────────────────────────────────────────────────────

async fn static_handler(uri: Uri) -> impl IntoResponse {
    let raw = uri.path().trim_start_matches('/');
    serve_asset(if raw.is_empty() { "index.html" } else { raw })
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
    // Run diagnostics first so the output appears before the banner
    run_startup_diagnostics().await;

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
