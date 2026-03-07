use axum::{
    body::Body,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    http::{header, Response, StatusCode, Uri},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    },
    routing::{get, post},
    Json, Router,
};
use mime_guess::from_path;
use rust_embed::RustEmbed;
use serde::{Serialize, Deserialize};
use std::{
    convert::Infallible,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use sysinfo::System;
use tokio::sync::broadcast;
#[cfg(target_os = "linux")]
use nvml_wrapper::{enum_wrappers::device::TemperatureSensor, Nvml};
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

// NVIDIA GPU metrics — populated only on Linux nodes with NVIDIA drivers.
// All fields are Option so the payload serialises cleanly as null on other platforms.
#[derive(Serialize, Clone, Default)]
struct NvidiaMetrics {
    nvidia_gpu_utilization_percent: Option<f32>,
    nvidia_vram_used_mb:            Option<u64>,
    nvidia_vram_total_mb:           Option<u64>,
    nvidia_gpu_temp_c:              Option<u32>,
    nvidia_power_draw_w:            Option<f32>,
}

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
    // Apple Silicon deep-metal
    cpu_power_w:             Option<f32>,
    ecpu_power_w:            Option<f32>,
    pcpu_power_w:            Option<f32>,
    gpu_utilization_percent: Option<f32>,
    memory_pressure_percent: Option<f32>,
    thermal_state:           Option<String>,
    // NVIDIA GPU fields (null on non-NVIDIA platforms)
    nvidia_gpu_utilization_percent: Option<f32>,
    nvidia_vram_used_mb:            Option<u64>,
    nvidia_vram_total_mb:           Option<u64>,
    nvidia_gpu_temp_c:              Option<u32>,
    nvidia_power_draw_w:            Option<f32>,
}

// ── Fleet Pairing Types ───────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Default)]
struct WickleeConfig {
    node_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    fleet_url: Option<String>,
}

#[derive(Clone)]
enum PairingStatus {
    Unpaired,
    Pending { code: String, expires_at: u64 },
    Connected { fleet_url: String },
}

struct PairingState {
    status:               PairingStatus,
    node_id:              String,
    /// Session token returned by the cloud backend after a successful claim.
    /// Present only while paired; used to authenticate telemetry pushes.
    cloud_session_token:  Option<String>,
}

#[derive(Serialize)]
struct PairingStatusResponse {
    status: &'static str,
    node_id: String,
    code: Option<String>,
    expires_at: Option<u64>,
    fleet_url: Option<String>,
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

        // Intel / older macOS: CPU_Speed_Limit or CPU_Scheduler_Limit = N
        let speed_val = if let Some(rest) = line.strip_prefix("CPU_Speed_Limit") {
            Some(rest)
        } else if let Some(rest) = line.strip_prefix("CPU_Scheduler_Limit") {
            Some(rest)
        } else {
            None
        };
        if let Some(rest) = speed_val {
            let val: u32 = rest
                .trim_start_matches(|c: char| c == ' ' || c == '=')
                .trim()
                .parse()
                .ok()?;
            return Some(match val {
                100     => "Normal",
                80..=99 => "Elevated",
                50..=79 => "High",
                _       => "Critical",
            }.to_string());
        }

        // Apple Silicon / macOS Ventura+: "No thermal warning level: N"
        // 0 = not throttling (Normal); any other value means throttled.
        if let Some(rest) = line.strip_prefix("No thermal warning level:") {
            let val: u32 = rest.trim().parse().unwrap_or(0);
            return Some(if val == 0 { "Normal" } else { "Elevated" }.to_string());
        }

        // Apple Silicon macOS Sequoia+: pmset reports notes instead of numeric keys.
        // "Note: No thermal warning level has been recorded" → no throttling = Normal.
        if line.starts_with("Note: No thermal warning level") {
            return Some("Normal".to_string());
        }
        // "Note: No performance warning level has been recorded" → also Normal signal.
        if line.starts_with("Note: No performance warning level") {
            return Some("Normal".to_string());
        }

        // Apple Silicon alternative: "Thermal Warning Level = N"
        if let Some(rest) = line.strip_prefix("Thermal Warning Level") {
            let val: u32 = rest
                .trim_start_matches(|c: char| c == ' ' || c == '=')
                .trim()
                .parse()
                .unwrap_or(0);
            return Some(match val {
                0 => "Normal",
                1 => "Elevated",
                2 => "High",
                _ => "Critical",
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
        // Intel / AMD: "Device Utilization %" = N  (integer percent, e.g. 42)
        if let Some(pos) = line.find("\"Device Utilization %\"") {
            let after = &line[pos + "\"Device Utilization %\"".len()..];
            let after = after.trim_start_matches(|c: char| c == ':' || c == ' ' || c == '=');
            let num: String = after
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            if let Ok(v) = num.parse::<f32>() {
                return Some(v);
            }
        }

        // Apple Silicon AGX (AGXAcceleratorG14G etc.):
        // "GPU Core Utilization" = N  — float 0.0–1.0 in ioreg output.
        if let Some(pos) = line.find("\"GPU Core Utilization\"") {
            let after = &line[pos + "\"GPU Core Utilization\"".len()..];
            // ioreg formats as: "key" = value  (value may be unquoted float)
            let after = after.trim_start_matches(|c: char| c == ':' || c == ' ' || c == '=' || c == '"');
            let num: String = after
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            if let Ok(v) = num.parse::<f32>() {
                // AGX reports 0.0–1.0; multiply by 100 to get percent.
                // Guard against already-percent values (> 1.0) just in case.
                return Some(if v <= 1.0 { v * 100.0 } else { v });
            }
        }
    }
    None
}

/// Memory pressure via `vm_stat` — no sudo required.
///
/// Formula (matches Activity Monitor "Used" definition):
///   in_use = wired + active          ← cannot be reclaimed without eviction
///   total  = free + active + inactive + speculative + wired
///   pressure % = in_use / total × 100
///
/// Inactive and speculative pages are reclaimable cached data — excluding them
/// prevents the metric from reading 99% on a healthy system.
async fn read_memory_pressure_vmstat() -> Option<f32> {
    let out = tokio::process::Command::new("vm_stat")
        .output()
        .await
        .ok()?;
    if !out.status.success() { return None; }
    parse_vmstat_pressure(&String::from_utf8_lossy(&out.stdout))
}

fn parse_vmstat_pressure(text: &str) -> Option<f32> {
    let mut free:        u64 = 0;
    let mut active:      u64 = 0;
    let mut inactive:    u64 = 0;
    let mut speculative: u64 = 0;
    let mut wired:       u64 = 0;
    let mut found_any = false;

    for line in text.lines() {
        let line = line.trim();
        // Each vm_stat line is "Label:    NNN." — strip trailing dot, parse integer.
        let parse_val = |prefix: &str| -> Option<u64> {
            let rest = line.strip_prefix(prefix)?;
            rest.trim().trim_end_matches('.').trim().parse().ok()
        };
        if      let Some(v) = parse_val("Pages free:")        { free = v;        found_any = true; }
        else if let Some(v) = parse_val("Pages active:")      { active = v;      found_any = true; }
        else if let Some(v) = parse_val("Pages inactive:")    { inactive = v;    found_any = true; }
        else if let Some(v) = parse_val("Pages speculative:") { speculative = v; found_any = true; }
        else if let Some(v) = parse_val("Pages wired down:")  { wired = v;       found_any = true; }
    }

    if !found_any { return None; }
    let in_use = wired + active;
    let total  = free + active + inactive + speculative + wired;
    if total == 0 { return None; }
    Some((in_use as f32 / total as f32) * 100.0)
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

// ── Fleet Pairing Helpers ─────────────────────────────────────────────────────

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn config_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    Path::new(&home).join(".wicklee").join("config.toml")
}

fn generate_node_id() -> String {
    format!("WK-{:04X}", now_ms() & 0xFFFF)
}

fn load_or_create_config() -> WickleeConfig {
    let path = config_path();
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(cfg) = toml::from_str::<WickleeConfig>(&content) {
                return cfg;
            }
        }
    }
    let cfg = WickleeConfig { node_id: generate_node_id(), fleet_url: None };
    save_config(&cfg);
    cfg
}

fn save_config(cfg: &WickleeConfig) {
    let path = config_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(content) = toml::to_string(cfg) {
        let _ = std::fs::write(&path, content);
    }
}

const CLOUD_URL: &str = "https://vibrant-fulfillment-production-62c0.up.railway.app";

fn generate_code() -> String {
    format!("{:06}", now_ms() % 1_000_000)
}

/// POST { code, node_id, fleet_url } to the cloud backend.
/// Returns the session_token to use for subsequent telemetry pushes.
async fn register_pair_code(node_id: &str, code: &str) -> Option<String> {
    let cloud  = std::env::var("WICKLEE_CLOUD_URL").unwrap_or_else(|_| CLOUD_URL.to_string());
    let fleet  = std::env::var("WICKLEE_FLEET_URL").unwrap_or_else(|_| "http://localhost:7700".to_string());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .unwrap_or_default();
    let res = client
        .post(format!("{cloud}/api/pair/claim"))
        .json(&serde_json::json!({ "code": code, "node_id": node_id, "fleet_url": fleet }))
        .send()
        .await
        .ok()?;
    if !res.status().is_success() { return None; }
    let body: serde_json::Value = res.json().await.ok()?;
    body["session_token"].as_str().map(|s| s.to_string())
}

/// Spawn a background task that forwards live telemetry to the cloud every 2 s.
/// Subscribes to the existing broadcast channel (already runs at 10 Hz) and
/// throttles pushes to 1 per 2 s so we don't hammer Railway.
/// Stops automatically when the session_token is cleared (on disconnect).
fn start_cloud_push(
    pairing_state: Arc<Mutex<PairingState>>,
    broadcast_tx:  broadcast::Sender<String>,
) {
    use tokio::sync::broadcast::error::RecvError;

    tokio::spawn(async move {
        let cloud  = std::env::var("WICKLEE_CLOUD_URL").unwrap_or_else(|_| CLOUD_URL.to_string());
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_default();

        let mut rx         = broadcast_tx.subscribe();
        let mut last_push  = std::time::Instant::now()
            .checked_sub(std::time::Duration::from_secs(10))  // push immediately on first tick
            .unwrap_or_else(std::time::Instant::now);
        let push_interval  = std::time::Duration::from_secs(2);

        loop {
            let frame = match rx.recv().await {
                Ok(json)                    => json,
                Err(RecvError::Closed)      => break,
                Err(RecvError::Lagged(_))   => continue,
            };

            // Throttle to one push every 2 s.
            if last_push.elapsed() < push_interval { continue; }

            // Only push when paired (session_token present).
            let has_token = pairing_state.lock().unwrap().cloud_session_token.is_some();
            if !has_token { continue; }

            last_push = std::time::Instant::now();
            let _ = client
                .post(format!("{cloud}/api/telemetry"))
                .header("content-type", "application/json")
                .body(frame)
                .send()
                .await;
        }
    });
}

fn print_pairing_box(node_id: &str, code: &str) {
    println!("┌─────────────────────────────────┐");
    println!("│  Wicklee Fleet Pairing          │");
    println!("│  Node Identity: {:<16} │", node_id);
    println!("│  Pairing Code:  {:<16} │", code);
    println!("│  Enter at: wicklee.dev          │");
    println!("│  Expires in: 5:00               │");
    println!("└─────────────────────────────────┘");
}

fn pairing_response(state: &PairingState) -> PairingStatusResponse {
    match &state.status {
        PairingStatus::Unpaired => PairingStatusResponse {
            status: "unpaired",
            node_id: state.node_id.clone(),
            code: None,
            expires_at: None,
            fleet_url: None,
        },
        PairingStatus::Pending { code, expires_at } => PairingStatusResponse {
            status: "pending",
            node_id: state.node_id.clone(),
            code: Some(code.clone()),
            expires_at: Some(*expires_at),
            fleet_url: None,
        },
        PairingStatus::Connected { fleet_url } => PairingStatusResponse {
            status: "connected",
            node_id: state.node_id.clone(),
            code: None,
            expires_at: None,
            fleet_url: Some(fleet_url.clone()),
        },
    }
}

// ── Startup Diagnostics ───────────────────────────────────────────────────────
//
// Runs once at boot and prints to stderr so you can see exactly which source
// is available on this machine.  Safe to leave in production — it's just
// informational stderr and adds < 2 s to startup.

async fn run_startup_diagnostics(node_id: &str, pairing_status: &str) {
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

    // 2. pmset -g therm
    match tokio::process::Command::new("pmset").args(["-g", "therm"]).output().await {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout);
            match parse_pmset_therm(&text) {
                Some(state) => eprintln!("[diag] pmset thermal           OK  → {}", state),
                None        => eprintln!("[diag] pmset thermal           MISS → no known key"),
            }
        }
        Err(e) => eprintln!("[diag] pmset thermal           ERR → {}", e),
    }

    // 3. ioreg IOAccelerator GPU utilization
    match tokio::process::Command::new("ioreg").args(["-r", "-c", "IOAccelerator"]).output().await {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout);
            match parse_ioreg_gpu(&text) {
                Some(v) => eprintln!("[diag] ioreg GPU util          OK  → {}%", v),
                None    => eprintln!("[diag] ioreg GPU util          MISS → no known key in IOAccelerator"),
            }
        }
        Err(e) => eprintln!("[diag] ioreg GPU util          ERR → {}", e),
    }

    // 4. powermetrics without sudo
    match tokio::process::Command::new("powermetrics")
        .args(["-n", "1", "-i", "500", "--samplers", "cpu_power"])
        .output()
        .await
    {
        Ok(out) => {
            if out.status.success() {
                eprintln!("[diag] powermetrics            OK  → available");
            } else {
                eprintln!("[diag] powermetrics            MISS → requires root (cpu_power_w will be null)");
            }
        }
        Err(e) => eprintln!("[diag] powermetrics            ERR → {}", e),
    }

    // 5. NVML / NVIDIA GPU
    #[cfg(target_os = "linux")]
    match Nvml::init() {
        Ok(nvml) => {
            let count = nvml.device_count().unwrap_or(0);
            eprintln!("[diag] NVML                    OK  → {} device{}", count, if count == 1 { "" } else { "s" });
        }
        Err(e) => eprintln!("[diag] NVML                    MISS → {} (nvidia_* fields will be null)", e),
    }
    #[cfg(not(target_os = "linux"))]
    eprintln!("[diag] NVML                    MISS → not Linux (nvidia_* fields will be null)");

    // 6. Node identity + pairing state
    eprintln!("[diag] Node identity           OK  → {}", node_id);
    eprintln!("[diag] Pairing state           OK  → {}", pairing_status);

    eprintln!("──────────────────────────────────────────────");
}

// ── NVIDIA Harvester ──────────────────────────────────────────────────────────
//
// Initialises NVML on the first call; if unavailable (no drivers, macOS, etc.)
// returns immediately with an all-None cache — no crash, no retry spam.
// Polls device 0 every 2 s for: GPU util, VRAM, temperature, board power draw.
// No sudo required on Linux — NVML reads through the kernel driver interface.

fn start_nvidia_harvester() -> Arc<Mutex<NvidiaMetrics>> {
    let shared = Arc::new(Mutex::new(NvidiaMetrics::default()));

    #[cfg(target_os = "linux")]
    {
        let shared_clone = Arc::clone(&shared);
        tokio::spawn(async move {
            let nvml = match Nvml::init() {
                Ok(n) => n,
                Err(_) => return, // diagnostic already logged in run_startup_diagnostics
            };

            let mut interval = tokio::time::interval(Duration::from_secs(2));
            loop {
                interval.tick().await;

                let device = match nvml.device_by_index(0) {
                    Ok(d)  => d,
                    Err(_) => continue,
                };

                let mut m = NvidiaMetrics::default();

                m.nvidia_gpu_utilization_percent =
                    device.utilization_rates().ok().map(|u| u.gpu as f32);

                if let Ok(mem) = device.memory_info() {
                    m.nvidia_vram_used_mb  = Some(mem.used  / 1_048_576);
                    m.nvidia_vram_total_mb = Some(mem.total / 1_048_576);
                }

                m.nvidia_gpu_temp_c =
                    device.temperature(TemperatureSensor::Gpu).ok();

                m.nvidia_power_draw_w =
                    device.power_usage().ok().map(|mw| mw as f32 / 1_000.0);

                if let Ok(mut guard) = shared_clone.lock() {
                    *guard = m;
                }
            }
        });
    }

    shared
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

            // 3. Memory pressure via vm_stat (no sudo required)
            m.memory_pressure_percent = read_memory_pressure_vmstat().await;

            // 4. CPU power via powermetrics (no sudo — overrides mem_pressure if available)
            if let Some(pm) = try_powermetrics_nosudo().await {
                m.cpu_power_w  = pm.cpu_power_w;
                m.ecpu_power_w = pm.ecpu_power_w;
                m.pcpu_power_w = pm.pcpu_power_w;
                if pm.memory_pressure_percent.is_some() {
                    m.memory_pressure_percent = pm.memory_pressure_percent;
                }
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

// ── 10 Hz Metrics Broadcaster (WebSocket feed) ────────────────────────────────

/// Spawns a 100 ms sysinfo loop that serialises MetricsPayload and broadcasts
/// the JSON string to every active WebSocket subscriber.
/// The broadcast channel has capacity 64 — lagged subscribers simply skip frames.
fn start_metrics_broadcaster(
    apple_metrics:  Arc<Mutex<AppleSiliconMetrics>>,
    nvidia_metrics: Arc<Mutex<NvidiaMetrics>>,
) -> broadcast::Sender<String> {
    let (tx, _) = broadcast::channel::<String>(64);
    let tx_clone = tx.clone();

    tokio::spawn(async move {
        let mut sys = System::new_all();
        let node_id = System::host_name()
            .unwrap_or_else(|| "wicklee-sentinel-01".to_string());

        // Warm-up: two reads separated by 200 ms gives sysinfo an accurate CPU delta.
        sys.refresh_all();
        tokio::time::sleep(Duration::from_millis(200)).await;

        let mut interval = tokio::time::interval(Duration::from_millis(100));
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

            let apple  = apple_metrics.lock().map(|g| g.clone()).unwrap_or_default();
            let nvidia = nvidia_metrics.lock().map(|g| g.clone()).unwrap_or_default();

            let payload = MetricsPayload {
                node_id:                 node_id.clone(),
                cpu_usage_percent:       sys.global_cpu_info().cpu_usage(),
                total_memory_mb:         total     / 1024 / 1024,
                used_memory_mb:          used      / 1024 / 1024,
                available_memory_mb:     available / 1024 / 1024,
                cpu_core_count:          sys.cpus().len(),
                timestamp_ms,
                cpu_power_w:             apple.cpu_power_w,
                ecpu_power_w:            apple.ecpu_power_w,
                pcpu_power_w:            apple.pcpu_power_w,
                gpu_utilization_percent: apple.gpu_utilization_percent,
                memory_pressure_percent: apple.memory_pressure_percent,
                thermal_state:           apple.thermal_state,
                nvidia_gpu_utilization_percent: nvidia.nvidia_gpu_utilization_percent,
                nvidia_vram_used_mb:            nvidia.nvidia_vram_used_mb,
                nvidia_vram_total_mb:           nvidia.nvidia_vram_total_mb,
                nvidia_gpu_temp_c:              nvidia.nvidia_gpu_temp_c,
                nvidia_power_draw_w:            nvidia.nvidia_power_draw_w,
            };

            if let Ok(json) = serde_json::to_string(&payload) {
                // send() only errors when there are zero subscribers — that's fine.
                let _ = tx_clone.send(json);
            }
        }
    });

    tx
}

// ── WebSocket Handler ─────────────────────────────────────────────────────────

async fn handle_ws(
    ws: WebSocketUpgrade,
    axum::extract::Extension(tx): axum::extract::Extension<broadcast::Sender<String>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| ws_session(socket, tx))
}

async fn ws_session(mut socket: WebSocket, tx: broadcast::Sender<String>) {
    let mut rx = tx.subscribe();
    loop {
        match rx.recv().await {
            Ok(json) => {
                if socket.send(Message::Text(json.into())).await.is_err() {
                    break; // client disconnected
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => continue, // skip stale frames
            Err(broadcast::error::RecvError::Closed)    => break,
        }
    }
}

// ── Fleet Pairing Handlers ────────────────────────────────────────────────────

async fn handle_pair_status(
    axum::extract::Extension(pairing_state): axum::extract::Extension<Arc<Mutex<PairingState>>>,
) -> Json<PairingStatusResponse> {
    let mut state = pairing_state.lock().unwrap();
    if let PairingStatus::Pending { expires_at, .. } = &state.status {
        if now_ms() > *expires_at {
            state.status = PairingStatus::Unpaired;
        }
    }
    Json(pairing_response(&state))
}

async fn handle_pair_generate(
    axum::extract::Extension(pairing_state): axum::extract::Extension<Arc<Mutex<PairingState>>>,
) -> Json<PairingStatusResponse> {
    let code = generate_code();
    let expires_at = now_ms() + 300_000;
    let (node_id, response) = {
        let mut state = pairing_state.lock().unwrap();
        state.status = PairingStatus::Pending { code: code.clone(), expires_at };
        (state.node_id.clone(), pairing_response(&state))
    };
    // Register with cloud backend and store the returned session_token.
    let ps = Arc::clone(&pairing_state);
    tokio::spawn(async move {
        if let Some(token) = register_pair_code(&node_id, &code).await {
            ps.lock().unwrap().cloud_session_token = Some(token);
        }
    });
    Json(response)
}

#[derive(Deserialize)]
struct ClaimBody { code: String }

async fn handle_pair_claim(
    axum::extract::Extension(pairing_state): axum::extract::Extension<Arc<Mutex<PairingState>>>,
    Json(body): Json<ClaimBody>,
) -> Json<PairingStatusResponse> {
    let mut state = pairing_state.lock().unwrap();
    let valid = match &state.status {
        PairingStatus::Pending { code, expires_at } => {
            body.code == *code && now_ms() <= *expires_at
        }
        _ => false,
    };
    if valid {
        let fleet_url = "https://wicklee.dev/fleet/mock-token".to_string();
        let cfg = WickleeConfig { node_id: state.node_id.clone(), fleet_url: Some(fleet_url.clone()) };
        save_config(&cfg);
        state.status = PairingStatus::Connected { fleet_url };
    }
    Json(pairing_response(&state))
}

async fn handle_pair_disconnect(
    axum::extract::Extension(pairing_state): axum::extract::Extension<Arc<Mutex<PairingState>>>,
) -> Json<PairingStatusResponse> {
    let mut state = pairing_state.lock().unwrap();
    state.status              = PairingStatus::Unpaired;
    state.cloud_session_token = None;
    let cfg = WickleeConfig { node_id: state.node_id.clone(), fleet_url: None };
    save_config(&cfg);
    Json(pairing_response(&state))
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
    axum::extract::Extension(apple_metrics):  axum::extract::Extension<Arc<Mutex<AppleSiliconMetrics>>>,
    axum::extract::Extension(nvidia_metrics): axum::extract::Extension<Arc<Mutex<NvidiaMetrics>>>,
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

            let apple  = apple_metrics.lock().map(|g| g.clone()).unwrap_or_default();
            let nvidia = nvidia_metrics.lock().map(|g| g.clone()).unwrap_or_default();

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
                nvidia_gpu_utilization_percent: nvidia.nvidia_gpu_utilization_percent,
                nvidia_vram_used_mb:            nvidia.nvidia_vram_used_mb,
                nvidia_vram_total_mb:           nvidia.nvidia_vram_total_mb,
                nvidia_gpu_temp_c:              nvidia.nvidia_gpu_temp_c,
                nvidia_power_draw_w:            nvidia.nvidia_power_draw_w,
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
    let config = load_or_create_config();
    let initial_status = if config.fleet_url.is_some() { "connected" } else { "unpaired" };
    let pairing_state = Arc::new(Mutex::new(PairingState {
        node_id:             config.node_id.clone(),
        cloud_session_token: None,
        status: match config.fleet_url.clone() {
            Some(url) => PairingStatus::Connected { fleet_url: url },
            None      => PairingStatus::Unpaired,
        },
    }));

    let pair_on_start = std::env::args().any(|a| a == "--pair");
    if pair_on_start {
        let code = generate_code();
        let expires_at = now_ms() + 300_000;
        pairing_state.lock().unwrap().status = PairingStatus::Pending { code: code.clone(), expires_at };
        match register_pair_code(&config.node_id, &code).await {
            Some(token) => { pairing_state.lock().unwrap().cloud_session_token = Some(token); }
            None        => eprintln!("[warn] Could not register code with cloud backend. Check your internet connection."),
        }
        print_pairing_box(&config.node_id, &code);
    }

    // Run diagnostics first so the output appears before the banner
    run_startup_diagnostics(&config.node_id, if pair_on_start { "pending" } else { initial_status }).await;

    let apple_metrics  = start_metrics_harvester();
    let nvidia_metrics = start_nvidia_harvester();
    let broadcast_tx   = start_metrics_broadcaster(Arc::clone(&apple_metrics), Arc::clone(&nvidia_metrics));

    // Start cloud telemetry push loop (2 s cadence, gated on session_token).
    start_cloud_push(Arc::clone(&pairing_state), broadcast_tx.clone());

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/tags",           get(handle_tags))
        .route("/api/metrics",        get(handle_metrics))       // SSE fallback (1 Hz)
        .route("/ws",                 get(handle_ws))             // WebSocket primary (10 Hz)
        .route("/api/pair/status",    get(handle_pair_status))
        .route("/api/pair/generate",  post(handle_pair_generate))
        .route("/api/pair/claim",     post(handle_pair_claim))
        .route("/api/pair/disconnect",post(handle_pair_disconnect))
        .fallback(static_handler)
        .layer(axum::extract::Extension(pairing_state))
        .layer(axum::extract::Extension(apple_metrics))
        .layer(axum::extract::Extension(nvidia_metrics))
        .layer(axum::extract::Extension(broadcast_tx))
        .layer(cors);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(7700);
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .expect(&format!("Failed to bind port {port}"));

    println!("╔══════════════════════════════════════════════╗");
    println!("║                                              ║");
    println!("║   Wicklee Sentinel Active                    ║");
    println!("║   http://localhost:{port:<26}║");
    println!("║                                              ║");
    println!("╚══════════════════════════════════════════════╝");

    axum::serve(listener, app)
        .await
        .expect("Server exited unexpectedly");
}
