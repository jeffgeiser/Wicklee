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
use tokio::sync::{broadcast, watch};

mod process_discovery;
#[cfg(any(all(target_os = "linux", not(target_env = "musl")), target_os = "windows"))]
use nvml_wrapper::{bitmasks::device::ThrottleReasons, enum_wrappers::device::TemperatureSensor, Nvml};
// nvml-wrapper 0.10 only wraps nvmlDeviceGetMemoryInfo (v1), which returns
// NVML_ERROR_NOT_SUPPORTED on Grace Blackwell / unified-memory architectures.
// We access nvmlDeviceGetMemoryInfo_v2 directly through the sys crate.
#[cfg(any(all(target_os = "linux", not(target_env = "musl")), target_os = "windows"))]
use nvml_wrapper_sys::bindings::{nvmlMemory_v2_t, nvmlDevice_t};
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

// Ollama runtime metrics — populated when Ollama is detected on 127.0.0.1:11434.
// All fields are Option/bool-default so the payload serialises cleanly when absent.
#[derive(Serialize, Clone, Default)]
struct OllamaMetrics {
    ollama_running:           bool,
    ollama_active_model:      Option<String>,
    ollama_model_size_gb:     Option<f32>,
    ollama_quantization:      Option<String>,
    /// Sustained tok/s: eval_rate from Ollama /api/generate probe every 30s.
    /// Reflects actual node throughput under current thermal/load conditions.
    ollama_tokens_per_second: Option<f32>,
    /// True when a request completed within the last 35s (one probe interval).
    /// Derived from expires_at resets observed in /api/ps polls.
    /// None = not yet determined (no expires_at change seen since agent start).
    ollama_inference_active: Option<bool>,
    /// True when the transparent proxy is active on :11434.
    /// When true, tok/s comes from done-packet eval_count/eval_duration rather than the 30s probe.
    #[serde(default)]
    ollama_proxy_active: bool,
}

// vLLM runtime metrics — populated when vLLM is detected on localhost:8000.
// All fields are Option/bool-default so the payload serialises cleanly when absent.
#[derive(Serialize, Clone, Default)]
struct VllmMetrics {
    vllm_running:          bool,
    vllm_model_name:       Option<String>,
    vllm_tokens_per_sec:   Option<f32>,
    vllm_cache_usage_perc: Option<f32>,
    vllm_requests_running: Option<u32>,
}

// NVIDIA GPU metrics — populated only on Linux/Windows nodes with NVIDIA drivers.
// All fields are Option so the payload serialises cleanly as null on other platforms.
#[derive(Serialize, Clone, Default)]
struct NvidiaMetrics {
    nvidia_gpu_utilization_percent: Option<f32>,
    nvidia_vram_used_mb:            Option<u64>,
    nvidia_vram_total_mb:           Option<u64>,
    nvidia_gpu_temp_c:              Option<u32>,
    nvidia_power_draw_w:            Option<f32>,
    /// Human-readable GPU model name, e.g. "NVIDIA GeForce RTX 4080"
    nvidia_gpu_name:                Option<String>,
    /// Thermal penalty derived from the NVML throttle-reason bitmask (WES v2).
    /// Always Some(_) when NVML is active — 1.0 = no throttle, >1.0 = throttled.
    /// None on non-NVIDIA platforms. The WES sampler prefers this over string-inferred
    /// thermal_state because it is hardware-authoritative, not temperature-proxied.
    #[serde(skip)]   // internal use only; not forwarded in MetricsPayload
    nvidia_throttle_penalty:        Option<f32>,
}

#[derive(Serialize, Clone, Default)]
struct AppleSiliconMetrics {
    cpu_power_w:             Option<f32>,
    ecpu_power_w:            Option<f32>,
    pcpu_power_w:            Option<f32>,
    gpu_utilization_percent: Option<f32>,
    memory_pressure_percent: Option<f32>,
    thermal_state:           Option<String>,
    /// Apple Silicon chip description, e.g. "Apple M3 Max"
    gpu_name:                Option<String>,
    /// GPU wired memory budget (MB) from `sysctl iogpu.wired_limit_mb`.
    /// This is the maximum unified memory macOS will wire for GPU use —
    /// typically ~75% of total RAM. None on Intel Macs and non-macOS.
    gpu_wired_limit_mb:      Option<u64>,
}

#[derive(Serialize)]
struct MetricsPayload {
    node_id:                 String,
    /// Human-readable machine hostname (e.g. "DESKTOP-XYZ", "JEFFs-MacBook-Pro.local").
    hostname:                String,
    /// GPU model name — NVIDIA: nvmlDeviceGetName; Apple: system_profiler chip name.
    /// None when neither NVML nor ioreg can provide a name.
    gpu_name:                Option<String>,
    /// CPU/chip model name for non-GPU nodes — Linux: /proc/cpuinfo "model name".
    /// Displayed as the subtitle in the fleet UI when gpu_name is absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    chip_name:               Option<String>,
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
    /// GPU wired memory budget in MB — from `sysctl iogpu.wired_limit_mb`.
    /// Represents the maximum unified memory macOS reserves for GPU access
    /// (typically ~75% of physical RAM). None on non-Apple-Silicon nodes.
    #[serde(skip_serializing_if = "Option::is_none")]
    gpu_wired_limit_mb:      Option<u64>,
    // NVIDIA GPU fields (null on non-NVIDIA platforms)
    nvidia_gpu_utilization_percent: Option<f32>,
    nvidia_vram_used_mb:            Option<u64>,
    nvidia_vram_total_mb:           Option<u64>,
    nvidia_gpu_temp_c:              Option<u32>,
    nvidia_power_draw_w:            Option<f32>,
    // Ollama runtime (null/false when Ollama not running)
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    ollama_running:           bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    ollama_active_model:      Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ollama_model_size_gb:     Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ollama_quantization:      Option<String>,
    /// Sustained tok/s from 30s probe (eval_rate field from Ollama). None until first probe completes.
    #[serde(skip_serializing_if = "Option::is_none")]
    ollama_tokens_per_second: Option<f32>,
    /// True when a request completed within the last 35s. Derived from /api/ps expires_at resets.
    #[serde(skip_serializing_if = "Option::is_none")]
    ollama_inference_active: Option<bool>,
    /// True when the Wicklee transparent proxy is active on :11434.
    /// Frontend uses this to label tok/s as "live" (not "live estimate").
    #[serde(skip_serializing_if = "Option::is_none")]
    ollama_proxy_active: Option<bool>,
    // vLLM runtime (null/false when vLLM not running)
    #[serde(default)]
    vllm_running:          bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    vllm_model_name:       Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vllm_tokens_per_sec:   Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vllm_cache_usage_perc: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vllm_requests_running: Option<u32>,
    /// Compile-time OS — "macOS" | "Linux" | "Windows". Cannot be inferred incorrectly.
    os: String,
    /// Compile-time CPU architecture — "x86_64" | "aarch64". Constant across the process lifetime.
    /// Frontend uses this to label ARM Linux nodes correctly in the identity column.
    arch: String,
    /// Drain-on-send event log. Normally empty; populated when background tasks
    /// (e.g. self-update) emit a notable event. Frontend renders as Live Activity entries.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    live_activities: Vec<LiveActivityEvent>,

    // ── WES v2 thermal-penalty window ─────────────────────────────────────────
    // All optional — None until the first 2 s sampler tick completes (≈2 s after start).
    // The cloud backend stores these in the reserved DuckDB columns (Phase 4B).

    /// Average thermal penalty over the last 30 samples (up to 60 s rolling window).
    /// 1.0 = no penalty (healthy), >1.0 = throttled. Three decimal places.
    #[serde(skip_serializing_if = "Option::is_none")]
    penalty_avg:    Option<f32>,
    /// Worst (highest) penalty seen in the same 60 s window. Alert threshold: >1.75.
    #[serde(skip_serializing_if = "Option::is_none")]
    penalty_peak:   Option<f32>,
    /// Source of the thermal data: "nvml" | "iokit" | "sysfs" | "unavailable".
    /// "nvml" = hardware-authoritative bitmask. Others = state-string inference.
    #[serde(skip_serializing_if = "Option::is_none")]
    thermal_source: Option<String>,
    /// Number of samples in the current window (1–30). Low values mean the agent
    /// just started or restarted — treat avg/peak as provisional.
    #[serde(skip_serializing_if = "Option::is_none")]
    sample_count:   Option<u32>,
    /// WES formula version. 1 = original (Serious=2.0). 2 = refined (Serious=1.75, NVML bitmask).
    /// Increment here when the formula changes; version-stamps all benchmarks in DuckDB.
    wes_version:    u8,
}

// ── Fleet Pairing Types ───────────────────────────────────────────────────────

/// Optional transparent proxy configuration.
/// When enabled, the agent binds :11434 and forwards to Ollama on ollama_port.
/// Provides zero-lag inference detection and exact tok/s from done packets.
/// Requires the user to move Ollama to ollama_port (OLLAMA_HOST=127.0.0.1:11435).
#[derive(Serialize, Deserialize, Default, Clone)]
struct OllamaProxyConfig {
    /// Enable the transparent proxy. Default: false (Phase A /api/ps polling).
    #[serde(default)]
    enabled: bool,
    /// Port where Ollama listens after being moved. Default: 11435.
    #[serde(default = "default_proxy_ollama_port")]
    ollama_port: u16,
    /// Return 503 immediately when backend is unreachable rather than timing out.
    #[serde(default)]
    bypass_if_proxy_down: bool,
}

fn default_proxy_ollama_port() -> u16 { 11435 }

/// Explicit port overrides for inference runtimes.
///
/// When set, these values take precedence over process-based auto-detection.
/// Use when the runtime runs as a different OS user and the agent cannot read
/// its process cmdline (common on shared machines or managed deployments).
///
/// Example in ~/.wicklee/config.toml:
///
/// ```toml
/// [runtime_ports]
/// vllm   = 18010
/// ollama = 11434
/// ```
#[derive(Serialize, Deserialize, Default)]
struct RuntimePortsConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    ollama: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vllm: Option<u16>,
}

#[derive(Serialize, Deserialize, Default)]
struct WickleeConfig {
    node_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    fleet_url: Option<String>,
    /// Cloud session token — persisted so telemetry push resumes after restart.
    #[serde(skip_serializing_if = "Option::is_none")]
    session_token: Option<String>,
    /// Optional transparent Ollama proxy configuration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ollama_proxy: Option<OllamaProxyConfig>,
    /// Explicit port overrides — bypasses process-based auto-detection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    runtime_ports: Option<RuntimePortsConfig>,
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

// ── Live Activity Events ──────────────────────────────────────────────────────

/// A timestamped log entry surfaced in the dashboard Live Activity panel.
/// Written by background tasks (e.g. self-update) and drained into every
/// MetricsPayload broadcast on the next 100 ms tick.
#[derive(Serialize, Clone)]
struct LiveActivityEvent {
    message:      String,
    timestamp_ms: u64,
    /// Frontend style hint: "info" | "warn" | "error"
    level:        &'static str,
}

/// Response shape of GET https://wicklee.dev/api/agent/version
#[derive(Deserialize)]
struct AgentVersionResponse {
    latest:       String,
    download_url: String,
}

// ── Hardware Helpers ──────────────────────────────────────────────────────────

/// Thermal via sysctl — Intel-only key; returns None on Apple Silicon.
#[cfg(not(target_os = "windows"))]
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

/// Windows has no sysctl — thermal state deferred to Phase 3 (WMI).
#[cfg(target_os = "windows")]
fn read_thermal_sysctl() -> Option<String> {
    None
}

/// GPU wired memory limit via `sysctl iogpu.wired_limit_mb` — Apple Silicon only.
///
/// macOS enforces a per-process GPU wired memory budget that is independent of
/// total RAM. On M-series chips this is typically ~75% of physical memory.
/// The sysctl exists only on Apple Silicon; returns None on Intel / non-macOS.
/// No sudo required.
#[cfg(target_os = "macos")]
fn read_iogpu_wired_limit_mb() -> Option<u64> {
    use sysctl::Sysctl;
    let ctl = sysctl::Ctl::new("iogpu.wired_limit_mb").ok()?;
    let s = ctl.value_string().ok()?;
    s.trim().parse::<u64>().ok()
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

/// Apple Silicon chip name via `system_profiler SPHardwareDataType`.
/// Parses the "Chip:" line which reads e.g. "Apple M3 Pro" directly.
/// Falls back to None on non-Apple hardware or if the command is unavailable.
#[cfg(not(target_os = "windows"))]
async fn read_apple_chip_name() -> Option<String> {
    let out = tokio::process::Command::new("system_profiler")
        .arg("SPHardwareDataType")
        .output()
        .await
        .ok()?;
    if !out.status.success() { return None; }
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        // Output contains lines like "      Chip: Apple M3 Pro"
        if let Some(rest) = line.trim().strip_prefix("Chip:") {
            let name = rest.trim().to_string();
            if !name.is_empty() { return Some(name); }
        }
    }
    None
}

#[cfg(target_os = "windows")]
async fn read_apple_chip_name() -> Option<String> { None }

/// CPU model name from `/proc/cpuinfo` on Linux.
/// Reads the "model name" field and strips noisy suffixes so the UI gets a
/// clean string like "AMD EPYC 7302P" or "Intel Xeon Gold 6154".
///
/// ARM processors (e.g. NVIDIA Grace, Ampere Altra) often omit "model name"
/// from /proc/cpuinfo entirely.  When the field is absent we fall back to
/// /sys/firmware/devicetree/base/model which carries the platform board name
/// (e.g. "NVIDIA GH200 480GB" on a Grace Hopper Superchip, or "NVIDIA DGX
/// Spark" on the Grace Blackwell desktop system).  This is readable without
/// elevated privileges on most ARM Linux distributions.
#[cfg(target_os = "linux")]
fn read_linux_chip_name() -> Option<String> {
    // ── Primary: /proc/cpuinfo "model name" (x86, some ARM) ──────────────────
    let from_cpuinfo = (|| -> Option<String> {
        let content = std::fs::read_to_string("/proc/cpuinfo").ok()?;
        let raw = content.lines()
            .find(|l| l.starts_with("model name"))?
            .splitn(2, ':')
            .nth(1)?
            .trim()
            .to_string();

        // Strip " @ X.XXGHz" clock speed annotation
        let raw = if let Some(pos) = raw.find(" @") { raw[..pos].to_string() } else { raw };

        // Drop trailing words that are pure noise: "CPU", "Processor", or "N-Core"
        let words: Vec<&str> = raw.split_whitespace().collect();
        let end = words.iter().position(|w| {
            *w == "CPU" || *w == "Processor" || w.ends_with("-Core")
        }).unwrap_or(words.len());
        let trimmed = words[..end].join(" ");

        // Strip trademark noise: (R) (TM) ® ™
        let clean = trimmed
            .replace("(R)", "").replace("(TM)", "")
            .replace('\u{00ae}', "").replace('\u{2122}', "");

        let result = clean.split_whitespace().collect::<Vec<_>>().join(" ");
        if result.is_empty() { None } else { Some(result) }
    })();

    if from_cpuinfo.is_some() { return from_cpuinfo; }

    // ── Fallback: device-tree model (ARM Linux — NVIDIA Grace, Ampere, etc.) ─
    // The board model string is null-terminated; strip the trailing NUL.
    if let Ok(raw) = std::fs::read_to_string("/sys/firmware/devicetree/base/model") {
        let s = raw.trim_end_matches('\0').trim().to_string();
        if !s.is_empty() { return Some(s); }
    }

    None
}

#[cfg(not(target_os = "linux"))]
fn read_linux_chip_name() -> Option<String> { None }

// ── Linux RAPL CPU Power Harvester ────────────────────────────────────────────
//
// Reads the kernel powercap interface — no sudo, no extra libraries.
// Samples the energy counter twice with a 500 ms gap; power = ΔµJ / Δµs (= Watts).
// Handles three path variants in priority order:
//   1. intel-rapl subdirectory layout  (most Intel, also AMD on modern kernels)
//   2. intel-rapl flat layout          (older kernels)
//   3. amd-core layout                 (fallback for some AMD configs)

#[cfg(target_os = "linux")]
const RAPL_PATHS: &[(&str, &str)] = &[
    ("/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj", "intel-rapl"),
    ("/sys/class/powercap/intel-rapl:0/energy_uj",            "intel-rapl:0"),
    ("/sys/class/powercap/amd-core/amd-core:0/energy_uj",     "amd-core"),
];

#[cfg(target_os = "linux")]
fn read_rapl_uj(path: &str) -> Option<u64> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

/// Returns a shared `Option<f32>` updated every ~500 ms with the package CPU power
/// in Watts (Linux RAPL powercap).  Stays `None` on non-Linux or when no RAPL sysfs
/// node is found (older kernels, certain VMs, or AMD pre-Zen platforms).
fn start_rapl_harvester() -> Arc<Mutex<Option<f32>>> {
    let shared = Arc::new(Mutex::new(None::<f32>));

    #[cfg(target_os = "linux")]
    {
        let shared_clone = Arc::clone(&shared);
        tokio::spawn(async move {
            // Find the first RAPL path that is readable.
            let found = RAPL_PATHS.iter().find(|(path, _)| read_rapl_uj(path).is_some());
            let Some((path, _label)) = found else { return; };
            let path = *path;

            loop {
                let Some(e1) = read_rapl_uj(path) else {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                };
                let t1 = std::time::Instant::now();
                tokio::time::sleep(Duration::from_millis(500)).await;
                let Some(e2) = read_rapl_uj(path) else { continue; };

                let elapsed_us = t1.elapsed().as_micros() as f64;
                // Skip sample on counter rollover — extremely rare but guard it anyway.
                if e2 > e1 && elapsed_us > 0.0 {
                    let power_w = (e2 - e1) as f64 / elapsed_us; // µJ / µs = W
                    if let Ok(mut guard) = shared_clone.lock() {
                        *guard = Some(power_w as f32);
                    }
                }

                // Hold ~500 ms before the next sample so the loop runs at ~1 Hz.
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        });
    }

    shared
}

// ── Linux thermal state ────────────────────────────────────────────────────────
//
// Two paths, tried in priority order:
//
//   1. AMD (k10temp present) — clock ratio + Tdie temperature tie-breaker.
//      Clock ratio = avg(scaling_cur_freq) / cpuinfo_max_freq.
//      Thresholds:  ≥0.95 → Normal (1.00)
//                   ≥0.80 → Fair   (1.25)
//                   ≥0.60 → Serious (1.75)
//                   < 0.60 → Critical (2.50)
//      Tie-breaker: Tdie > 85 °C bumps to at least Serious.
//      Source tag: "clock_ratio"
//
//   2. Generic sysfs — max temp across all /sys/class/thermal/thermal_zone*/temp.
//      < 70 °C → Normal  |  70–79 °C → Fair  |  80–89 °C → Serious  |  ≥90 °C → Critical
//      Source tag: "sysfs"
//
// Returns None when no thermal interface is available on this kernel/container.

/// Shared result from the Linux thermal harvester.  Carried alongside the state
/// string so the WES sampler can use direct_penalty (AMD clock-ratio path) or fall
/// back to thermal_penalty_v2(state) (generic sysfs path).
#[derive(Clone)]
struct LinuxThermalResult {
    state:          String,       // "Normal" | "Fair" | "Serious" | "Critical"
    source:         &'static str, // "clock_ratio" | "sysfs"
    direct_penalty: Option<f32>,  // Some on AMD path (can exceed 2.0); None on sysfs path
}

// Helper functions — Linux only.

#[cfg(target_os = "linux")]
fn find_hwmon(target: &str) -> Option<std::path::PathBuf> {
    let dir = std::path::Path::new("/sys/class/hwmon");
    if !dir.exists() { return None; }
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        if let Ok(name) = std::fs::read_to_string(entry.path().join("name")) {
            if name.trim() == target { return Some(entry.path()); }
        }
    }
    None
}

#[cfg(target_os = "linux")]
/// Read Tdie from k10temp hwmon (millidegrees → °C).
/// Tries temp2_input (Zen2+ Tdie) then temp1_input (older Zen / Tctl).
fn read_k10temp_tdie_c(hwmon: &std::path::Path) -> Option<f64> {
    for name in &["temp2_input", "temp1_input"] {
        if let Ok(raw) = std::fs::read_to_string(hwmon.join(name)) {
            if let Ok(mc) = raw.trim().parse::<i64>() {
                return Some(mc as f64 / 1000.0);
            }
        }
    }
    None
}

#[cfg(target_os = "linux")]
/// Hardware-max CPU frequency (kHz).  Reads cpuinfo_max_freq first (true hardware
/// ceiling), falls back to scaling_max_freq (OS-set limit, usually the same).
fn read_cpu_max_freq_khz() -> Option<u64> {
    let base = std::path::Path::new("/sys/devices/system/cpu/cpu0/cpufreq");
    for file in &["cpuinfo_max_freq", "scaling_max_freq"] {
        if let Ok(raw) = std::fs::read_to_string(base.join(file)) {
            if let Ok(khz) = raw.trim().parse::<u64>() {
                if khz > 0 { return Some(khz); }
            }
        }
    }
    None
}

#[cfg(target_os = "linux")]
/// Average scaling_cur_freq across all logical CPUs (cpu0…cpuN directories).
fn read_avg_cur_freq_khz() -> Option<u64> {
    let cpu_dir = std::path::Path::new("/sys/devices/system/cpu");
    let mut sum: u64 = 0;
    let mut count: u32 = 0;
    for entry in std::fs::read_dir(cpu_dir).ok()?.flatten() {
        let fname = entry.file_name();
        let s = fname.to_string_lossy();
        // Match cpu0, cpu1, … cpuN — skip cpufreq, cpuidle, power, etc.
        if s.starts_with("cpu") && s[3..].parse::<u32>().is_ok() {
            if let Ok(raw) = std::fs::read_to_string(
                entry.path().join("cpufreq/scaling_cur_freq")
            ) {
                if let Ok(khz) = raw.trim().parse::<u64>() {
                    sum += khz;
                    count += 1;
                }
            }
        }
    }
    if count == 0 { return None; }
    Some(sum / count as u64)
}

#[cfg(target_os = "linux")]
/// Convert AMD clock ratio + optional Tdie into a `LinuxThermalResult`.
fn amd_clock_ratio_result(ratio: f64, tdie_c: Option<f64>) -> LinuxThermalResult {
    let (state, penalty): (&str, f32) = if ratio >= 0.95 {
        ("Normal",   1.00)
    } else if ratio >= 0.80 {
        ("Fair",     1.25)
    } else if ratio >= 0.60 {
        ("Serious",  1.75)
    } else {
        ("Critical", 2.50)   // severe throttle — higher than the 4-state cap of 2.0
    };

    // Temperature tie-breaker: Tdie > 85 °C → at least Serious.
    let (state, penalty) = match tdie_c {
        Some(t) if t > 85.0 && penalty < 1.75 => ("Serious", 1.75_f32),
        _ => (state, penalty),
    };

    LinuxThermalResult {
        state:          state.to_string(),
        source:         "clock_ratio",
        direct_penalty: Some(penalty),
    }
}

#[cfg(target_os = "linux")]
fn harvest_linux_thermal(max_freq_khz: Option<u64>) -> Option<LinuxThermalResult> {
    // ── AMD path: k10temp + clock ratio ──────────────────────────────────────
    if let Some(hwmon) = find_hwmon("k10temp") {
        if let (Some(max_khz), Some(cur_khz)) = (max_freq_khz, read_avg_cur_freq_khz()) {
            if max_khz > 0 {
                let ratio  = cur_khz as f64 / max_khz as f64;
                let tdie_c = read_k10temp_tdie_c(&hwmon);
                return Some(amd_clock_ratio_result(ratio, tdie_c));
            }
        }
        // k10temp present but cpufreq unavailable — fall through to generic path.
    }

    // ── Generic path: /sys/class/thermal zone max ─────────────────────────────
    let thermal_dir = std::path::Path::new("/sys/class/thermal");
    if !thermal_dir.exists() { return None; }

    let mut max_temp_c: Option<f64> = None;
    for entry in std::fs::read_dir(thermal_dir).ok()?.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("thermal_zone") { continue; }
        let Ok(raw) = std::fs::read_to_string(entry.path().join("temp")) else { continue; };
        let Ok(mc): Result<i64, _> = raw.trim().parse() else { continue; };
        let temp_c = mc as f64 / 1000.0;
        max_temp_c = Some(max_temp_c.map_or(temp_c, |p: f64| p.max(temp_c)));
    }

    let temp = max_temp_c?;
    let state = match temp {
        t if t < 70.0 => "Normal",
        t if t < 80.0 => "Fair",      // canonical name (was "Elevated" — penalty was wrongly 1.0)
        t if t < 90.0 => "Serious",
        _              => "Critical",
    };
    Some(LinuxThermalResult {
        state:          state.to_string(),
        source:         "sysfs",
        direct_penalty: None,   // derived via thermal_penalty_v2(state)
    })
}

/// Returns a shared `Option<LinuxThermalResult>` updated every 5 s.
/// Stays `None` on non-Linux targets and when no thermal interface is available.
fn start_linux_thermal_harvester() -> Arc<Mutex<Option<LinuxThermalResult>>> {
    let shared = Arc::new(Mutex::new(None::<LinuxThermalResult>));

    #[cfg(target_os = "linux")]
    {
        let shared_clone = Arc::clone(&shared);
        tokio::spawn(async move {
            // Cache hardware-max frequency once — it never changes at runtime.
            // Used by the AMD clock-ratio path; None on non-AMD or no cpufreq.
            let max_freq_khz = read_cpu_max_freq_khz();

            let mut interval = tokio::time::interval(Duration::from_secs(5));
            loop {
                interval.tick().await;
                let result = harvest_linux_thermal(max_freq_khz);
                if let Ok(mut guard) = shared_clone.lock() {
                    *guard = result;
                }
            }
        });
    }

    shared
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
    let cfg = WickleeConfig { node_id: generate_node_id(), fleet_url: None, session_token: None, ollama_proxy: None, runtime_ports: None };
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
            let wk_id = {
                let state = pairing_state.lock().unwrap();
                if state.cloud_session_token.is_none() { continue; }
                state.node_id.clone()
            };

            // Patch the JSON frame: replace node_id with the WK-XXXX identifier
            // so it matches the nodes table key; preserve the machine hostname
            // in a separate `hostname` field for display in the fleet dashboard.
            let patched = if let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&frame) {
                let machine_hostname = val["node_id"].as_str().unwrap_or("").to_string();
                val["node_id"] = serde_json::json!(wk_id);
                val["hostname"] = serde_json::json!(machine_hostname);
                val.to_string()
            } else {
                frame
            };

            last_push = std::time::Instant::now();
            let _ = client
                .post(format!("{cloud}/api/telemetry"))
                .header("content-type", "application/json")
                .body(patched)
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

// ── Service Installation ──────────────────────────────────────────────────────

/// C3 — Validates that a binary path is safe to embed in service descriptors.
///
/// launchd plists, systemd unit files, and Windows sc.exe descriptors are text
/// formats that the respective service managers parse with their own rules.
/// Embedding a path with shell metacharacters, XML-significant characters, or
/// newlines can silently corrupt the descriptor or enable local privilege
/// escalation when the service manager reloads it.
///
/// **Allowed (POSIX):** `[a-zA-Z0-9/_.-]` only.  Covers every normal Unix
/// install path (`/usr/local/bin/wicklee`, `/opt/wicklee/bin/wicklee`, etc.).
///
/// **Allowed (Windows):** drive letter + `:` + `[\\/a-zA-Z0-9_.- ]` only.
/// Spaces are common in Windows paths (`C:\Program Files\…`); they are handled
/// by quoting at the call site rather than here.
///
/// The check rejects `.` components and path traversal (`..`) unconditionally
/// regardless of platform, and enforces a sensible maximum path length.
///
/// If validation fails, `install_service` prints a clear human-readable error
/// and aborts rather than writing a potentially broken service descriptor.
#[cfg(not(target_os = "windows"))]
fn validate_binary_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 4096 {
        return Err(format!(
            "binary path length {} is out of range (1–4096 bytes)", path.len()
        ));
    }
    if !path.starts_with('/') {
        return Err("binary path must be absolute (must start with '/')".to_string());
    }
    // Reject ".." components wherever they appear.
    if path.split('/').any(|component| component == "..") {
        return Err("binary path must not contain path traversal ('..') components".to_string());
    }
    // Byte-level allowlist: [a-zA-Z0-9/_.-]
    // '/' is the POSIX path separator; '_', '.', '-' appear in common binary names.
    // Everything else (spaces, semicolons, shell expansions, XML metacharacters,
    // newlines, null bytes, …) is rejected.
    for (i, b) in path.bytes().enumerate() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9'
            | b'/' | b'_' | b'.' | b'-' => {}
            _ => return Err(format!(
                "binary path contains unsafe byte 0x{b:02X} at index {i} — \
                 only [a-zA-Z0-9/_.-] are permitted in service paths; \
                 move the binary to a simpler path and re-run --install-service"
            )),
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn validate_binary_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 4096 {
        return Err(format!(
            "binary path length {} is out of range (1–4096 bytes)", path.len()
        ));
    }
    let bytes = path.as_bytes();
    // Must start with <DriveLetter>:\ or <DriveLetter>:/
    if bytes.len() < 3
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || (bytes[2] != b'\\' && bytes[2] != b'/')
    {
        return Err(
            "Windows binary path must be absolute — expected format: C:\\...\\wicklee.exe"
                .to_string(),
        );
    }
    // Reject ".." anywhere.
    for component in path.split(['\\', '/']) {
        if component == ".." {
            return Err("binary path must not contain path traversal ('..') components".to_string());
        }
    }
    // Byte-level allowlist for the rest of the path.
    // Spaces allowed (common in "Program Files"); colon only as drive separator (already
    // validated at byte 1).  All shell-significant and XML-significant characters rejected.
    for (i, b) in bytes.iter().enumerate().skip(3) {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9'
            | b'\\' | b'/' | b'_' | b'.' | b'-' | b' ' => {}
            _ => return Err(format!(
                "binary path contains unsafe byte 0x{b:02X} at index {i} — \
                 only [a-zA-Z0-9\\\\/._- ] are permitted in Windows service paths"
            )),
        }
    }
    Ok(())
}

async fn install_service() {
    let exe = match std::env::current_exe() {
        Ok(p)  => p,
        Err(e) => { eprintln!("error: cannot determine executable path: {e}"); return; }
    };
    let exe_str = exe.to_string_lossy().into_owned();

    // C3 — Validate before embedding in any service descriptor.
    // An attacker who installs the binary at a path with shell metacharacters
    // could inject commands executed when the service manager reloads the unit.
    // Abort with a clear error rather than writing a potentially dangerous file.
    if let Err(msg) = validate_binary_path(&exe_str) {
        eprintln!("error: cannot install service — unsafe binary path: {msg}");
        eprintln!("       Move the wicklee binary to a path using only [a-zA-Z0-9/_.-]");
        eprintln!("       (e.g. /usr/local/bin/wicklee) and re-run --install-service.");
        return;
    }

    #[cfg(target_os = "macos")]
    {
        let plist = format!(
"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\"\n\
  \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\">\n\
<dict>\n\
    <key>Label</key>\n\
    <string>dev.wicklee.agent</string>\n\
    <key>ProgramArguments</key>\n\
    <array>\n\
        <string>{exe_str}</string>\n\
    </array>\n\
    <key>RunAtLoad</key>\n\
    <true/>\n\
    <key>KeepAlive</key>\n\
    <true/>\n\
    <key>StandardOutPath</key>\n\
    <string>/var/log/wicklee.log</string>\n\
    <key>StandardErrorPath</key>\n\
    <string>/var/log/wicklee.log</string>\n\
</dict>\n\
</plist>\n"
        );
        let plist_path = "/Library/LaunchDaemons/dev.wicklee.agent.plist";
        if let Err(e) = std::fs::write(plist_path, plist) {
            eprintln!("error: cannot write {plist_path}: {e}");
            eprintln!("       Run with sudo: sudo wicklee --install-service");
            return;
        }
        let status = tokio::process::Command::new("launchctl")
            .args(["load", "-w", plist_path])
            .status().await;
        match status {
            Ok(s) if s.success() => {
                println!("✓ Wicklee Sentinel installed as a launchd service.");
                println!("  Starts automatically on boot (runs as root).");
                println!("  Plist: {plist_path}");
                println!("  Logs:  /var/log/wicklee.log");
                println!("  To remove: sudo wicklee --uninstall-service");
            }
            Ok(s) => eprintln!("error: launchctl load exited with status {s}"),
            Err(e) => eprintln!("error: launchctl: {e}"),
        }
    }

    #[cfg(target_os = "linux")]
    {
        let unit = format!(
"[Unit]\n\
Description=Wicklee Sentinel Agent\n\
After=network.target\n\
\n\
[Service]\n\
Type=simple\n\
ExecStart={exe_str}\n\
Restart=always\n\
RestartSec=5\n\
\n\
[Install]\n\
WantedBy=multi-user.target\n"
        );
        let unit_path = "/etc/systemd/system/wicklee.service";
        if let Err(e) = std::fs::write(unit_path, unit) {
            eprintln!("error: cannot write {unit_path}: {e}");
            eprintln!("       Run with sudo: sudo wicklee --install-service");
            return;
        }
        let _ = tokio::process::Command::new("systemctl")
            .args(["daemon-reload"])
            .status().await;
        // Enable for boot persistence, then restart so a freshly-installed
        // binary is picked up immediately — even if the service was already
        // running with an older version on the same inode.
        let _ = tokio::process::Command::new("systemctl")
            .args(["enable", "wicklee"])
            .status().await;
        let status = tokio::process::Command::new("systemctl")
            .args(["restart", "wicklee"])
            .status().await;
        match status {
            Ok(s) if s.success() => {
                println!("✓ Wicklee Sentinel installed as a systemd service.");
                println!("  Starts now and automatically on every boot.");
                println!("  Unit: {unit_path}");
                println!("  To remove: sudo wicklee --uninstall-service");
            }
            Ok(s) => eprintln!("error: systemctl restart exited with status {s}"),
            Err(e) => eprintln!("error: systemctl: {e}"),
        }
    }

    #[cfg(target_os = "windows")]
    {
        let status = tokio::process::Command::new("sc")
            .args(["create", "WickleeSentinel",
                   "binPath=", &exe_str,
                   "start=", "auto",
                   "DisplayName=", "Wicklee Sentinel"])
            .status().await;
        match status {
            Ok(s) if s.success() => {}
            Ok(s) => {
                eprintln!("error: sc create exited with status {s}");
                eprintln!("       Run from an elevated (Administrator) prompt.");
                return;
            }
            Err(e) => { eprintln!("error: sc: {e}"); return; }
        }
        let _ = tokio::process::Command::new("sc")
            .args(["description", "WickleeSentinel", "Wicklee Sentinel Agent"])
            .status().await;
        let start = tokio::process::Command::new("sc")
            .args(["start", "WickleeSentinel"])
            .status().await;
        match start {
            Ok(s) if s.success() => {
                println!("+ Wicklee Sentinel installed and started as a Windows service.");
                println!("  To remove: wicklee --uninstall-service  (run as Administrator)");
            }
            Ok(s) => eprintln!("warning: sc start exited with status {s} — service registered but not started"),
            Err(e) => eprintln!("error: sc start: {e}"),
        }
    }
}

async fn uninstall_service() {
    #[cfg(target_os = "macos")]
    {
        let plist_path = "/Library/LaunchDaemons/dev.wicklee.agent.plist";
        if !std::path::Path::new(plist_path).exists() {
            eprintln!("Service not installed (plist not found: {plist_path}).");
            return;
        }
        let _ = tokio::process::Command::new("launchctl")
            .args(["unload", "-w", plist_path])
            .status().await;
        if let Err(e) = std::fs::remove_file(plist_path) {
            eprintln!("error: cannot remove {plist_path}: {e}");
            eprintln!("       Run with sudo: sudo wicklee --uninstall-service");
            return;
        }
        println!("✓ Wicklee Sentinel service removed.");
    }

    #[cfg(target_os = "linux")]
    {
        let unit_path = "/etc/systemd/system/wicklee.service";
        if !std::path::Path::new(unit_path).exists() {
            eprintln!("Service not installed (unit not found: {unit_path}).");
            return;
        }
        let _ = tokio::process::Command::new("systemctl")
            .args(["stop", "wicklee"])
            .status().await;
        let _ = tokio::process::Command::new("systemctl")
            .args(["disable", "wicklee"])
            .status().await;
        if let Err(e) = std::fs::remove_file(unit_path) {
            eprintln!("error: cannot remove {unit_path}: {e}");
            eprintln!("       Run with sudo: sudo wicklee --uninstall-service");
            return;
        }
        let _ = tokio::process::Command::new("systemctl")
            .args(["daemon-reload"])
            .status().await;
        println!("✓ Wicklee Sentinel service removed.");
    }

    #[cfg(target_os = "windows")]
    {
        let _ = tokio::process::Command::new("sc")
            .args(["stop", "WickleeSentinel"])
            .status().await;
        let del = tokio::process::Command::new("sc")
            .args(["delete", "WickleeSentinel"])
            .status().await;
        match del {
            Ok(s) if s.success() => println!("+ Wicklee Sentinel service removed."),
            Ok(s) => eprintln!("error: sc delete exited with status {s}\n       Run from an elevated (Administrator) prompt."),
            Err(e) => eprintln!("error: sc: {e}"),
        }
    }
}

// ── Startup Diagnostics ───────────────────────────────────────────────────────
//
// Runs once at boot. Prints a clean bordered summary to stdout showing only
// what is relevant on this platform. Silent absence means N/A — no SKIP lines.

async fn run_startup_diagnostics(node_id: &str, pairing_status: &str, port: u16, cfg_ref: &WickleeConfig) {
    // Format one 48-column box row: ║   KEY     VALUE (padded/truncated to fit)  ║
    let row = |key: &str, val: &str| -> String {
        let inner = format!("   {:<7}{}", key, val);
        let capped = if inner.chars().count() <= 46 {
            format!("{:<46}", inner)
        } else {
            inner.chars().take(43).collect::<String>() + "..."
        };
        format!("║{}║", capped)
    };
    let sep       = "╠══════════════════════════════════════════════╣";
    let top       = "╔══════════════════════════════════════════════╗";
    let bot       = "╚══════════════════════════════════════════════╝";
    let blank_row = "║                                              ║";

    // ── Banner ────────────────────────────────────────────────────────────────
    println!("{top}");
    println!("{blank_row}");
    println!("{}", row("", &format!("Wicklee Sentinel  ·  v{}", env!("CARGO_PKG_VERSION"))));
    println!("{}", row("", &format!("http://localhost:{port}")));
    println!("{blank_row}");
    println!("{sep}");

    // ── Identity ─────────────────────────────────────────────────────────────
    println!("{}", row("Node", node_id));
    println!("{}", row("Pairing", pairing_status));

    // ── Platform rows (only what's relevant on this OS) ───────────────────────
    let mut platform_rows: Vec<String> = Vec::new();

    // macOS: pmset thermal + ioreg GPU util + powermetrics power
    #[cfg(target_os = "macos")]
    {
        // pmset -g therm → CPU thermal throttle state
        if let Ok(out) = tokio::process::Command::new("pmset")
            .args(["-g", "therm"]).output().await
        {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(state) = parse_pmset_therm(&text) {
                platform_rows.push(row("Thermal", &state));
            }
        }

        // ioreg IOAccelerator → GPU utilization
        if let Ok(out) = tokio::process::Command::new("ioreg")
            .args(["-r", "-c", "IOAccelerator"]).output().await
        {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(v) = parse_ioreg_gpu(&text) {
                platform_rows.push(row("GPU", &format!("{v}%  (IOAccelerator)")));
            }
        }

        // powermetrics → CPU power draw (requires root)
        match tokio::process::Command::new("powermetrics")
            .args(["-n", "1", "-i", "500", "--samplers", "cpu_power"])
            .output().await
        {
            Ok(out) if out.status.success() =>
                platform_rows.push(row("Power", "powermetrics  ✓  (root)")),
            _ =>
                platform_rows.push(row("Power", "powermetrics needs root for cpu_power_w")),
        }
    }

    // Linux: NVML (glibc only) + RAPL CPU power
    #[cfg(target_os = "linux")]
    {
        // NVML — not available in musl builds
        #[cfg(not(target_env = "musl"))]
        match Nvml::init() {
            Ok(nvml) => {
                let count = nvml.device_count().unwrap_or(0);
                if count > 0 {
                    if let Ok(dev) = nvml.device_by_index(0) {
                        let name = dev.name().unwrap_or_else(|_| "GPU".to_string());
                        let temp = dev.temperature(TemperatureSensor::Gpu)
                            .map(|t| format!("{t}°C"))
                            .unwrap_or_else(|_| "?°C".to_string());
                        let util = dev.utilization_rates()
                            .map(|u| format!("{}%", u.gpu))
                            .unwrap_or_else(|_| "?%".to_string());
                        platform_rows.push(row("GPU", &format!("{name}  {temp}  {util}")));
                        if let Ok(mem) = dev.memory_info() {
                            let used  = mem.used  as f64 / 1_073_741_824.0;
                            let total = mem.total as f64 / 1_073_741_824.0;
                            platform_rows.push(row("VRAM", &format!("{used:.1} / {total:.1} GB")));
                        }
                        if let Ok(mw) = dev.power_usage() {
                            platform_rows.push(row("GPU Pwr", &format!("{:.0}W", mw as f64 / 1000.0)));
                        }
                    }
                }
            }
            Err(_) => {} // no NVIDIA on this machine — silent
        }

        // RAPL CPU power (powercap, no sudo needed)
        {
            let found = RAPL_PATHS.iter().find(|(path, _)| read_rapl_uj(path).is_some());
            if let Some((path, label)) = found {
                if let Some(e1) = read_rapl_uj(path) {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    if let Some(e2) = read_rapl_uj(path) {
                        let power_w = if e2 > e1 { (e2 - e1) as f64 / 500_000.0 } else { 0.0 };
                        platform_rows.push(row("CPU Pwr", &format!("{power_w:.1}W  (RAPL/{label})")));
                    }
                }
            }
        }
    }

    // Windows: NVML GPU
    #[cfg(target_os = "windows")]
    match Nvml::init() {
        Ok(nvml) => {
            let count = nvml.device_count().unwrap_or(0);
            if count > 0 {
                if let Ok(dev) = nvml.device_by_index(0) {
                    let name = dev.name().unwrap_or_else(|_| "GPU".to_string());
                    let temp = dev.temperature(TemperatureSensor::Gpu)
                        .map(|t| format!("{t}°C"))
                        .unwrap_or_else(|_| "?°C".to_string());
                    let util = dev.utilization_rates()
                        .map(|u| format!("{}%", u.gpu))
                        .unwrap_or_else(|_| "?%".to_string());
                    platform_rows.push(row("GPU", &format!("{name}  {temp}  {util}")));
                    if let Ok(mem) = dev.memory_info() {
                        let used  = mem.used  as f64 / 1_073_741_824.0;
                        let total = mem.total as f64 / 1_073_741_824.0;
                        platform_rows.push(row("VRAM", &format!("{used:.1} / {total:.1} GB")));
                    }
                }
            }
        }
        Err(_) => {}
    }

    if !platform_rows.is_empty() {
        println!("{sep}");
        for r in &platform_rows {
            println!("{r}");
        }
    }

    // ── Runtime (all platforms) ───────────────────────────────────────────────
    println!("{sep}");

    // ── Inference runtime detection (process-first, port-agnostic) ──────────
    {
        let discovered = process_discovery::scan_runtimes();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap_or_default();

        // Ollama
        if let Some(&port) = discovered.get("ollama") {
            let model_hint = async {
                let resp = client
                    .get(format!("http://127.0.0.1:{port}/api/ps"))
                    .send().await.ok()?;
                let json: serde_json::Value = resp.json().await.ok()?;
                let name = json["models"].as_array()?.first()?["name"].as_str()?.to_string();
                Some(format!("{} loaded", name))
            }.await.unwrap_or_else(|| "running (no model loaded)".to_string());
            println!("{}", row("Ollama", &format!(":{port} · {model_hint}")));
        } else {
            println!("{}", row("Ollama", "not running"));
        }

        // vLLM — check config override first, then process scan
        let vllm_cfg_port  = cfg_ref.runtime_ports.as_ref().and_then(|r| r.vllm);
        let vllm_auto_port = discovered.get("vllm").copied();
        let vllm_port      = vllm_cfg_port.or(vllm_auto_port);
        let vllm_source    = if vllm_cfg_port.is_some() { " (config)" } else { "" };
        if let Some(port) = vllm_port {
            let up = client
                .get(format!("http://127.0.0.1:{port}/health"))
                .send().await
                .map(|r| r.status().is_success())
                .unwrap_or(false);
            println!("{}", row("vLLM", &format!(":{port}{vllm_source} · {}", if up { "healthy" } else { "starting up" })));
        } else {
            println!("{}", row("vLLM", "not detected  →  set runtime_ports.vllm in config"));
        }
    }

    println!("{bot}");
}

// ── NVIDIA Harvester ──────────────────────────────────────────────────────────
//
// ── NVML memory info v2 helper ────────────────────────────────────────────────
//
// nvmlDeviceGetMemoryInfo (v1) returns NVML_ERROR_NOT_SUPPORTED on NVIDIA
// Grace Blackwell (GB10/GB200 Superchip) and similar unified-memory SoC
// designs where the GPU does not have a traditional dedicated framebuffer.
// nvmlDeviceGetMemoryInfo_v2 adds a `reserved` field and works correctly on
// these architectures.  nvml-wrapper 0.10 only wraps v1, so we call v2
// directly through the nvml-wrapper-sys bindings.
//
// This function takes an already-loaded NvmlLib (no dlopen inside the poll
// loop) and acquires the device handle internally.  The raw nvmlDevice_t
// pointer is created and consumed within this synchronous fn — it never
// escapes into the async task, keeping the future Send-safe.
//
// Returns (total_mb, used_mb) on success, None if v2 is also unsupported.
#[cfg(any(all(target_os = "linux", not(target_env = "musl")), target_os = "windows"))]
fn nvml_memory_v2(lib: &nvml_wrapper_sys::bindings::NvmlLib, device_index: u32) -> Option<(u64, u64)> {
    use std::mem;
    // NVML_STRUCT_VERSION(Memory, 2) = sizeof(nvmlMemory_v2_t) | (2 << 24)
    let version: u32 = (mem::size_of::<nvmlMemory_v2_t>() as u32) | (2_u32 << 24);

    unsafe {
        let handle_fn = lib.nvmlDeviceGetHandleByIndex_v2.as_ref().ok()?;
        let mem_fn    = lib.nvmlDeviceGetMemoryInfo_v2.as_ref().ok()?;

        let mut dev: nvmlDevice_t = std::ptr::null_mut();
        if handle_fn(device_index, &mut dev) != 0 { return None; }

        let mut info: nvmlMemory_v2_t = mem::zeroed();
        info.version = version;
        if mem_fn(dev, &mut info) != 0 || info.total == 0 { return None; }
        Some((info.total / 1_048_576, info.used / 1_048_576))
    }
}

// Helper: load libnvidia-ml at runtime to access v2 APIs not yet exposed by
// the nvml-wrapper safe layer.  The library is already in-process (loaded by
// Nvml::init()); the OS loader returns the same DSO handle reference-counted,
// so this is cheap and does not cause double-init.
#[cfg(any(all(target_os = "linux", not(target_env = "musl")), target_os = "windows"))]
fn load_nvml_lib() -> Option<nvml_wrapper_sys::bindings::NvmlLib> {
    use nvml_wrapper_sys::bindings::NvmlLib;

    #[cfg(target_os = "linux")]
    let names: &[&str] = &["libnvidia-ml.so.1", "libnvidia-ml.so"];
    #[cfg(target_os = "windows")]
    let names: &[&str] = &["nvml.dll"];

    names.iter().find_map(|n| unsafe { NvmlLib::new(n).ok() })
}

// Initialises NVML on the first call; if unavailable (no drivers, macOS, etc.)
// returns immediately with an all-None cache — no crash, no retry spam.
// Polls device 0 every 2 s for: GPU util, VRAM, temperature, board power draw.
// No sudo required on Linux — NVML reads through the kernel driver interface.
//
// Memory API selection — probed once at startup, held for the session lifetime:
//
//   V1       Standard discrete GPU (GeForce, RTX, A-series, H100, B100, B200…)
//            nvmlDeviceGetMemoryInfo works; reports dedicated GDDR/HBM directly.
//
//   V2(lib)  Hopper/Blackwell HBM systems where v1 returns NOT_SUPPORTED.
//            Uses nvmlDeviceGetMemoryInfo_v2 via the sys crate.
//
//   Unified  GB10 / DGX Spark — LPDDR5x unified memory, no dedicated VRAM
//            budget; nvidia-smi reports [N/A] for memory.total.  We instead:
//              • total  = system RAM (the full unified pool the GPU accesses)
//              • used   = sum of used_gpu_memory across running compute processes
//            This matches exactly what nvidia-smi shows per-process and gives
//            the fleet UI a meaningful VRAM utilisation signal.

fn start_nvidia_harvester() -> Arc<Mutex<NvidiaMetrics>> {
    let shared = Arc::new(Mutex::new(NvidiaMetrics::default()));

    #[cfg(any(all(target_os = "linux", not(target_env = "musl")), target_os = "windows"))]
    {
        let shared_clone = Arc::clone(&shared);
        tokio::spawn(async move {
            let nvml = match Nvml::init() {
                Ok(n) => n,
                Err(_) => return, // diagnostic already logged in run_startup_diagnostics
            };

            // ── One-time setup before the poll loop ───────────────────────────

            enum MemApi {
                V1,
                V2(nvml_wrapper_sys::bindings::NvmlLib),
                /// Unified-memory SoC: no discrete VRAM pool in NVML.
                /// `total_mb` is the system RAM total read once from /proc/meminfo
                /// (Linux) or GlobalMemoryStatusEx (Windows) — the full pool
                /// the GPU can access via NVLink-C2C or similar interconnects.
                Unified { total_mb: u64 },
            }

            let (gpu_name_cached, mem_api): (Option<String>, MemApi) = {
                let probe = nvml.device_by_index(0).ok();
                let name  = probe.as_ref().and_then(|d| d.name().ok());

                // System RAM total — used as the Unified pool denominator on
                // hardware where NVML reports no dedicated VRAM (GB10, etc.).
                // sysinfo is already a direct dependency and handles both Linux
                // (/proc/meminfo) and Windows (GlobalMemoryStatusEx) internally,
                // so no platform-specific code is needed here.
                let sys_total_mb: u64 = {
                    let mut sys = sysinfo::System::new();
                    sys.refresh_memory();
                    sys.total_memory() / 1_048_576
                };

                let api = match probe.as_ref().map(|d| d.memory_info()) {
                    // v1 works and reports a non-zero total → use it directly.
                    Some(Ok(mem)) if mem.total > 0 => MemApi::V1,
                    // v1 returned N/A or zero: try the v2 struct (Hopper / HBM Blackwell).
                    // If v2 also yields no data the device is a unified-memory SoC → Unified.
                    _ => match load_nvml_lib() {
                        Some(lib) if nvml_memory_v2(&lib, 0).is_some() => MemApi::V2(lib),
                        _ => MemApi::Unified { total_mb: sys_total_mb },
                    },
                };
                (name, api)
            };

            let mut interval = tokio::time::interval(Duration::from_secs(2));
            loop {
                interval.tick().await;

                let device = match nvml.device_by_index(0) {
                    Ok(d)  => d,
                    Err(_) => continue,
                };

                let mut m = NvidiaMetrics::default();

                // Static properties — use the cached value, no NVML round-trip.
                m.nvidia_gpu_name = gpu_name_cached.clone();

                m.nvidia_gpu_utilization_percent =
                    device.utilization_rates().ok().map(|u| u.gpu as f32);

                // Memory — use whichever API was confirmed to work at startup.
                match &mem_api {
                    MemApi::V1 => {
                        if let Ok(mem) = device.memory_info() {
                            m.nvidia_vram_total_mb = Some(mem.total / 1_048_576);
                            m.nvidia_vram_used_mb  = Some(mem.used  / 1_048_576);
                        }
                    }
                    MemApi::V2(lib) => {
                        if let Some((total, used)) = nvml_memory_v2(lib, 0) {
                            m.nvidia_vram_total_mb = Some(total);
                            m.nvidia_vram_used_mb  = Some(used);
                        }
                    }
                    MemApi::Unified { total_mb } => {
                        // Sum GPU-resident allocations across all active compute
                        // processes.  This is the same accounting nvidia-smi uses
                        // to surface per-process memory on unified-memory SoCs.
                        use nvml_wrapper::enums::device::UsedGpuMemory;
                        let used_mb: u64 = device
                            .running_compute_processes()
                            .unwrap_or_default()
                            .iter()
                            .filter_map(|p| match p.used_gpu_memory {
                                UsedGpuMemory::Used(bytes) => Some(bytes / 1_048_576),
                                UsedGpuMemory::Unavailable => None,
                            })
                            .sum();
                        m.nvidia_vram_total_mb = Some(*total_mb);
                        m.nvidia_vram_used_mb  = Some(used_mb);
                    }
                }

                m.nvidia_gpu_temp_c =
                    device.temperature(TemperatureSensor::Gpu).ok();

                m.nvidia_power_draw_w =
                    device.power_usage().ok().map(|mw| mw as f32 / 1_000.0);

                // ── WES v2: NVML throttle-reason bitmask ─────────────────
                // Maps hardware clock-throttle reasons to a thermal penalty
                // factor. This is the most authoritative thermal signal on
                // NVIDIA hardware — no temperature inference required.
                //
                // Priority when multiple thermal bits are set: 2.5 (worst-case)
                //   HW_THERMAL_SLOWDOWN alone   → 2.0
                //   SW_THERMAL_SLOWDOWN alone   → 1.25
                //   HW_SLOWDOWN / HW_POWER_BRAKE alone → 1.25
                //   No throttle bits, temp ≥90°C → 1.1 (pre-throttle)
                //   No throttle bits, temp <90°C → 1.0 (healthy)
                if let Ok(reasons) = device.current_throttle_reasons() {
                    let hw_thermal  = reasons.contains(ThrottleReasons::HW_THERMAL_SLOWDOWN);
                    let sw_thermal  = reasons.contains(ThrottleReasons::SW_THERMAL_SLOWDOWN);
                    let hw_slowdown = reasons.contains(ThrottleReasons::HW_SLOWDOWN);
                    let pwr_brake   = reasons.contains(ThrottleReasons::HW_POWER_BRAKE_SLOWDOWN);

                    let thermal_count = [hw_thermal, sw_thermal, hw_slowdown, pwr_brake]
                        .iter()
                        .filter(|&&b| b)
                        .count();

                    let penalty: f32 = if thermal_count > 1 {
                        2.5
                    } else if hw_thermal {
                        2.0
                    } else if sw_thermal || hw_slowdown || pwr_brake {
                        1.25
                    } else {
                        // No throttle bits active — check pre-throttle threshold.
                        m.nvidia_gpu_temp_c
                            .map(|t| if t >= 90 { 1.1 } else { 1.0 })
                            .unwrap_or(1.0)
                    };

                    m.nvidia_throttle_penalty = Some(penalty);
                }

                if let Ok(mut guard) = shared_clone.lock() {
                    *guard = m;
                }
            }
        });
    }

    shared
}

// ── Ollama Transparent Proxy ──────────────────────────────────────────────────
//
// Optional. Binds :11434 and forwards to Ollama on a user-configured backend port
// (default :11435). Provides:
//   - Zero-lag inference detection (inference_active flips true on first byte in)
//   - Exact tok/s from the done packet (eval_count / eval_duration), replacing the probe
//   - The 30s /api/generate probe is disabled when the proxy is active
//
// Falls back gracefully: if :11434 cannot be bound, Phase A /api/ps polling takes over.

/// Shared state between the proxy Axum app and the OllamaMetrics writer task.
struct ProxyState {
    ollama_port:    u16,
    bypass_if_down: bool,
    client:         reqwest::Client,
    /// Set to true the instant a request arrives; cleared via 35s window after last done packet.
    inference_active: std::sync::atomic::AtomicBool,
    /// Timestamp of last completed request (done packet received).
    last_done_ts:   Mutex<Option<std::time::Instant>>,
    /// Exact tok/s from the most recent done packet.
    exact_tps:      Mutex<Option<f32>>,
}

/// Proxy handler for /api/generate and /api/chat — streams request through and
/// inspects the final done packet for exact tok/s.
async fn proxy_ollama_streaming(
    axum::extract::State(state): axum::extract::State<Arc<ProxyState>>,
    req: axum::extract::Request,
) -> impl IntoResponse {
    use tokio_stream::StreamExt;

    let path = req.uri().path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_default();

    let method = req.method().clone();
    let headers = req.headers().clone();

    // Buffer request body (prompt JSON — typically <64 KB)
    let body_bytes = match axum::body::to_bytes(req.into_body(), 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return axum::http::Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .body(Body::from("request body too large"))
            .unwrap(),
    };

    // Extract model name and mark inference as active immediately
    if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&body_bytes) {
        // model field optional — Ollama uses last loaded model if absent
        let _ = v["model"].as_str();
    }
    state.inference_active.store(true, std::sync::atomic::Ordering::Relaxed);

    // Forward to backend Ollama
    let backend_url = format!("http://127.0.0.1:{}{}", state.ollama_port, path);
    let upstream = state.client
        .request(method, &backend_url)
        .headers(headers)
        .body(body_bytes)
        .send()
        .await;

    let upstream_resp = match upstream {
        Ok(r) => r,
        Err(e) => {
            let hint = format!(
                "Wicklee proxy: cannot reach Ollama on :{} — {}\n\
                 Check that Ollama is running with OLLAMA_HOST=127.0.0.1:{}",
                state.ollama_port, e, state.ollama_port
            );
            if state.bypass_if_down {
                return axum::http::Response::builder()
                    .status(StatusCode::SERVICE_UNAVAILABLE)
                    .header("X-Wicklee-Hint", "backend-unreachable")
                    .body(Body::from(hint))
                    .unwrap();
            } else {
                return axum::http::Response::builder()
                    .status(StatusCode::BAD_GATEWAY)
                    .body(Body::from(hint))
                    .unwrap();
            }
        }
    };

    let status  = upstream_resp.status();
    let resp_headers = upstream_resp.headers().clone();

    // Stream response back, inspecting chunks for the done packet
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(64);
    let proxy_state = Arc::clone(&state);

    tokio::spawn(async move {
        let mut byte_stream = upstream_resp.bytes_stream();
        while let Some(chunk) = byte_stream.next().await {
            match chunk {
                Ok(bytes) => {
                    // Scan for done packet — Ollama sends one JSON object per line (NDJSON).
                    // The done packet is the last line; it's small and rarely split across chunks.
                    if let Ok(text) = std::str::from_utf8(&bytes) {
                        for line in text.lines() {
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                                if v["done"].as_bool() == Some(true) {
                                    if let (Some(ec), Some(ed)) = (
                                        v["eval_count"].as_u64(),
                                        v["eval_duration"].as_u64(),
                                    ) {
                                        let tps = ec as f64 / (ed as f64 / 1_000_000_000.0);
                                        *proxy_state.exact_tps.lock().unwrap() = Some(tps as f32);
                                        *proxy_state.last_done_ts.lock().unwrap() =
                                            Some(std::time::Instant::now());
                                    }
                                }
                            }
                        }
                    }
                    if tx.send(Ok(bytes)).await.is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(std::io::Error::new(std::io::ErrorKind::Other, e))).await;
                    break;
                }
            }
        }
    });

    let stream_body = Body::from_stream(ReceiverStream::new(rx));
    let mut builder = axum::http::Response::builder().status(status);
    for (name, value) in &resp_headers {
        builder = builder.header(name, value);
    }
    builder.body(stream_body).unwrap_or_else(|_| {
        axum::http::Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Body::empty())
            .unwrap()
    })
}

/// Proxy passthrough for all other Ollama routes (/api/tags, /api/ps, /api/version, etc.).
/// Pure forwarding — no inspection needed.
async fn proxy_passthrough(
    axum::extract::State(state): axum::extract::State<Arc<ProxyState>>,
    req: axum::extract::Request,
) -> impl IntoResponse {
    use tokio_stream::StreamExt;

    let path = req.uri().path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_default();

    let method  = req.method().clone();
    let headers = req.headers().clone();
    let body_bytes = axum::body::to_bytes(req.into_body(), 64 * 1024 * 1024)
        .await
        .unwrap_or_default();

    let backend_url = format!("http://127.0.0.1:{}{}", state.ollama_port, path);
    let upstream = state.client
        .request(method, &backend_url)
        .headers(headers)
        .body(body_bytes)
        .send()
        .await;

    match upstream {
        Err(e) => axum::http::Response::builder()
            .status(StatusCode::BAD_GATEWAY)
            .body(Body::from(format!("Wicklee proxy: backend unreachable — {e}")))
            .unwrap(),
        Ok(resp) => {
            let status       = resp.status();
            let resp_headers = resp.headers().clone();
            let (tx, rx)     = tokio::sync::mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(64);
            tokio::spawn(async move {
                let mut s = resp.bytes_stream();
                while let Some(c) = s.next().await {
                    match c {
                        Ok(b)  => { if tx.send(Ok(b)).await.is_err() { break; } }
                        Err(e) => { let _ = tx.send(Err(std::io::Error::new(std::io::ErrorKind::Other, e))).await; break; }
                    }
                }
            });
            let mut builder = axum::http::Response::builder().status(status);
            for (name, value) in &resp_headers {
                builder = builder.header(name, value);
            }
            builder.body(Body::from_stream(ReceiverStream::new(rx))).unwrap_or_else(|_| {
                axum::http::Response::builder()
                    .status(StatusCode::INTERNAL_SERVER_ERROR)
                    .body(Body::empty())
                    .unwrap()
            })
        }
    }
}

// ── Ollama Harvester ──────────────────────────────────────────────────────────
//
// Auto-detects Ollama on 127.0.0.1:11434 (explicit IPv4 — avoids Windows resolving
// localhost → ::1 while Ollama is bound to 127.0.0.1). No configuration required.
//
// Two concurrent tasks share the same Arc<Mutex<OllamaMetrics>>:
//
//   Main task (5s):  GET /api/ps — active model name, size, quantization.
//
//   Probe task (30s): POST /api/generate with stream:false, num_predict:20.
//     Non-streaming responses contain eval_count (tokens generated) and
//     eval_duration (nanoseconds) but NOT eval_rate. tok/s is derived as:
//         tps = eval_count / (eval_duration / 1_000_000_000)
//     num_predict:20 ensures the GPU reaches sustained generation speed before
//     the measurement is taken. The 30s probe interval makes the overhead negligible.
//     NOTE: /metrics Prometheus endpoint does not exist in Ollama ≤ v0.17.7.

/// Fires a non-streaming 20-token generate probe and returns tok/s derived from
/// eval_count / eval_duration returned by Ollama. Non-streaming responses do not
/// include eval_rate, so tok/s is calculated from the raw timing fields.
async fn probe_ollama_tps(client: &reqwest::Client, port: u16, model: &str) -> Option<f32> {
    // Explicit 127.0.0.1 (not localhost) to avoid Windows resolving localhost → ::1.
    let url = format!("http://127.0.0.1:{port}/api/generate");
    let resp = match client
        .post(&url)
        .json(&serde_json::json!({
            "model":   model,
            "prompt":  " ",
            "stream":  false,
            "options": { "num_predict": 20 }
        }))
        .send()
        .await
    {
        Ok(r)  => { eprintln!("[ollama] probe {} → HTTP {}", url, r.status()); r }
        Err(e) => { eprintln!("[ollama] probe {} → error: {}", url, e); return None; }
    };

    if !resp.status().is_success() { return None; }

    let text = resp.text().await.ok()?;

    // Non-streaming response is a single JSON object with eval_count (u64, tokens
    // generated) and eval_duration (u64, nanoseconds). Derive tok/s from these.
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
        if let (Some(count), Some(dur_ns)) = (
            json["eval_count"].as_u64(),
            json["eval_duration"].as_u64(),
        ) {
            if count > 0 && dur_ns > 0 {
                let tps = count as f64 / (dur_ns as f64 / 1_000_000_000.0);
                if tps > 0.0 { return Some(tps as f32); }
            }
        }
    }
    None
}

/// GPU utilisation above this threshold (%) causes the probe to be skipped.
/// The dashboard estimation formula (peak × gpu_util%) covers the busy case,
/// so firing tokens into an already-loaded scheduler would only add noise.
const GPU_LOAD_THRESHOLD_PCT: f32 = 40.0;

fn start_ollama_harvester(
    apple:     Arc<Mutex<AppleSiliconMetrics>>,
    nvidia:    Arc<Mutex<NvidiaMetrics>>,
    proxy_arc: Option<Arc<ProxyState>>,
    port_rx: process_discovery::PortRx,
) -> Arc<Mutex<OllamaMetrics>> {
    let shared = Arc::new(Mutex::new(OllamaMetrics::default()));

    // ── Main task: watch for port, poll /api/ps every 5s ────────────────────
    let shared_main = Arc::clone(&shared);
    let proxy_main  = proxy_arc.clone();
    let mut port_rx_main = port_rx.clone();
    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap_or_default();

        loop {
            // ── Wait until the discovery loop reports Ollama is running ──────
            loop {
                if port_rx_main.borrow().is_some() { break; }
                // Park until discovery sends an update (Some or None).
                if port_rx_main.changed().await.is_err() { return; }
            }
            let port = port_rx_main.borrow().unwrap();
            let base = format!("http://127.0.0.1:{port}");
            eprintln!("[ollama] connected on :{port}");

            let mut interval      = tokio::time::interval(Duration::from_secs(5));
            let mut prev_expires:  Option<String>             = None;
            let mut last_infer_ts: Option<std::time::Instant> = None;

            // ── Inner poll loop — runs while Ollama is present ───────────────
            loop {
                interval.tick().await;

                // React to port changes delivered by the discovery loop.
                // None  → runtime stopped: clear metrics and re-enter wait loop.
                // Some(new) → port changed (e.g. restart on different port): update URL.
                if port_rx_main.has_changed().unwrap_or(false) {
                    match *port_rx_main.borrow_and_update() {
                        None => {
                            eprintln!("[ollama] process gone — clearing metrics");
                            if let Ok(mut g) = shared_main.lock() { *g = OllamaMetrics::default(); }
                            break; // back to outer wait loop
                        }
                        Some(new_port) if new_port != port => {
                            // Port changed — restart the inner loop with the new URL.
                            // We break here; the outer loop will re-enter with the new port.
                            break;
                        }
                        _ => {}
                    }
                }

                // Carry forward previous tok/s — the probe task updates it independently.
                let prev_tps = shared_main.lock().ok()
                    .and_then(|g| g.ollama_tokens_per_second);
                let mut m = OllamaMetrics {
                    ollama_running: true,
                    ollama_tokens_per_second: prev_tps,
                    ..Default::default()
                };

                // Poll /api/ps for the loaded model and inference state.
                if let Ok(resp) = client.get(format!("{base}/api/ps")).send().await {
                    if let Ok(json) = resp.json::<serde_json::Value>().await {
                        if let Some(first) = json["models"].as_array().and_then(|a| a.first()) {
                            m.ollama_active_model = first["name"].as_str().map(|s| s.to_string());
                            m.ollama_model_size_gb = first["size"].as_u64()
                                .map(|b| b as f32 / 1_073_741_824.0);
                            m.ollama_quantization = first["details"]["quantization_level"]
                                .as_str().map(|s| s.to_string());
                            // Detect inference activity via expires_at resets.
                            // Ollama resets expires_at = now + keep_alive after each request
                            // completes. When the string changes between polls, a request just
                            // finished — mark inference active for the next 35 s.
                            if let Some(exp_str) = first["expires_at"].as_str() {
                                let exp_owned = exp_str.to_string();
                                if prev_expires.as_deref() != Some(&exp_owned) {
                                    last_infer_ts = Some(std::time::Instant::now());
                                }
                                prev_expires = Some(exp_owned);
                            }
                        }
                    }
                }

                // Inference-active signal: proxy takes priority; fall back to /api/ps timer.
                if let Some(ref ps) = proxy_main {
                    let proxy_active = ps.inference_active.load(std::sync::atomic::Ordering::Relaxed);
                    let since_done   = ps.last_done_ts.lock().unwrap()
                        .map_or(false, |t| t.elapsed().as_secs() < 35);
                    m.ollama_inference_active = Some(proxy_active || since_done);
                    m.ollama_tokens_per_second = *ps.exact_tps.lock().unwrap();
                    m.ollama_proxy_active = true;
                } else {
                    m.ollama_inference_active =
                        Some(last_infer_ts.map_or(false, |t| t.elapsed().as_secs() < 35));
                }

                if let Ok(mut g) = shared_main.lock() { *g = m; }
            }
        }
    });

    // ── Probe task: scheduled 20-token benchmark every 30s ──────────────────
    // Skipped entirely when the proxy is active — the proxy provides exact tok/s
    // from done packets, so synthetic probes are redundant and wasteful.
    // Dynamic scheduling: the probe only fires when the GPU is idle enough to
    // give a clean reading. When GPU util ≥ GPU_LOAD_THRESHOLD_PCT, we skip
    // the probe and write None — the dashboard estimation formula takes over
    // (peak_tps × gpu_util%). Firing tokens into a loaded scheduler would
    // queue behind the active job and produce a noisy / depressed reading.
    if proxy_arc.is_none() {
        let shared_probe = Arc::clone(&shared);
        let apple_probe  = Arc::clone(&apple);
        let nvidia_probe = Arc::clone(&nvidia);
        tokio::spawn(async move {
            // Generous timeout: CPU-only inference of 20 tokens can take several seconds.
            let probe_client = reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .unwrap_or_default();

            let mut interval = tokio::time::interval(Duration::from_secs(30));
            loop {
                interval.tick().await;

                // Read the current port — skip if Ollama isn't running.
                let Some(port) = *port_rx.borrow() else { continue; };

                // Only probe when a model is loaded.
                let model = shared_probe.lock().ok()
                    .and_then(|g| if g.ollama_running { g.ollama_active_model.clone() } else { None });
                let Some(model) = model else { continue; };

                // Read current GPU utilisation — NVIDIA takes priority, fall back to
                // Apple Silicon. None means no GPU sensor available (CPU-only node).
                let gpu_util: Option<f32> = nvidia_probe.lock().ok()
                    .and_then(|g| g.nvidia_gpu_utilization_percent)
                    .or_else(|| apple_probe.lock().ok().and_then(|g| g.gpu_utilization_percent));

                // Skip when GPU is clearly under load — estimation formula covers this.
                if gpu_util.map_or(false, |u| u >= GPU_LOAD_THRESHOLD_PCT) {
                    eprintln!(
                        "[ollama] probe skipped — GPU at {:.0}% (≥{:.0}%), using estimation",
                        gpu_util.unwrap_or(0.0), GPU_LOAD_THRESHOLD_PCT,
                    );
                    if let Ok(mut g) = shared_probe.lock() { g.ollama_tokens_per_second = None; }
                    continue;
                }

                // GPU is idle enough — fire the full 20-token benchmark.
                let new_tps = probe_ollama_tps(&probe_client, port, &model).await;
                if let Ok(mut g) = shared_probe.lock() { g.ollama_tokens_per_second = new_tps; }
            }
        });
    }

    shared
}

// ── vLLM Harvester ──────────────────────────────────────────────────────────────────────────────
//
// Polls the vLLM Prometheus /metrics endpoint on the port discovered by the
// process scanner. Called on a 2 s tick with a 500 ms timeout per call.
// No full Prometheus parser: lines are matched by metric-name prefix.

/// Probe vLLM once on `port`; returns (running, model_name, tok/s, cache_pct, req_count).
/// Never panics on malformed input; returns (false, …) on any connection failure.
async fn harvest_vllm(port: u16) -> (bool, Option<String>, Option<f32>, Option<f32>, Option<u32>) {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
    {
        Ok(c)  => c,
        Err(_) => return (false, None, None, None, None),
    };

    // Explicit 127.0.0.1 (not localhost) to avoid Windows resolving localhost → ::1.
    let resp = match client.get(format!("http://127.0.0.1:{port}/metrics")).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return (false, None, None, None, None),
    };

    let text = match resp.text().await {
        Ok(t)  => t,
        Err(_) => return (true, None, None, None, None),
    };

    let mut model_name:       Option<String> = None;
    let mut tokens_per_sec:   Option<f32>    = None;
    let mut cache_usage_perc: Option<f32>    = None;
    let mut requests_running: Option<u32>    = None;

    for line in text.lines() {
        // Skip Prometheus comment / metadata lines.
        if line.starts_with('#') { continue; }

        // Metric name = everything before the first '{' (labels) or first ' ' (no labels).
        let metric_name = if let Some(brace) = line.find('{') {
            &line[..brace]
        } else if let Some(space) = line.find(' ') {
            &line[..space]
        } else {
            continue;
        };

        // Numeric value = last whitespace-separated token on the line.
        let value: Option<f32> = line.split_whitespace().last()
            .and_then(|s| s.parse().ok());

        // Extract model_name="..." from the label string (first occurrence wins).
        if model_name.is_none() {
            if let Some(start) = line.find("model_name=\"") {
                let rest = &line[start + 12..];
                if let Some(end) = rest.find('"') {
                    model_name = Some(rest[..end].to_string());
                }
            }
        }

        match metric_name.trim() {
            // vllm:avg_generation_throughput_toks_per_s is a direct tok/s gauge emitted
            // by vLLM. Preferred over a latency-inverse formula (1/inter_token_latency)
            // because: (a) vLLM exposes latency only as a histogram (no scalar field),
            // and (b) aggregate generation throughput is the right signal for fleet
            // monitoring — not per-request delivery speed seen by a single consumer.
            // On endpoint failure the caller returns (false, None, …) so tokens_per_sec
            // stays None, clearing any stale value in shared state.
            "vllm:avg_generation_throughput_toks_per_s" => {
                tokens_per_sec = value;
            }
            "vllm:gpu_cache_usage_perc" => {
                // vLLM reports 0.0–1.0; multiply by 100 for percentage.
                cache_usage_perc = value.map(|v| v * 100.0);
            }
            "vllm:num_requests_running" => {
                requests_running = value.and_then(|v| {
                    if v >= 0.0 && v < u32::MAX as f32 { Some(v as u32) } else { None }
                });
            }
            _ => {}
        }
    }

    (true, model_name, tokens_per_sec, cache_usage_perc, requests_running)
}

/// Spawns a 2 s polling loop that watches for vLLM via the discovery channel,
/// then polls the Prometheus /metrics endpoint on the discovered port.
fn start_vllm_harvester(mut port_rx: process_discovery::PortRx) -> Arc<Mutex<VllmMetrics>> {
    let shared       = Arc::new(Mutex::new(VllmMetrics::default()));
    let shared_clone = Arc::clone(&shared);

    tokio::spawn(async move {
        loop {
            // ── Wait until the discovery loop reports vLLM is running ────────
            loop {
                if port_rx.borrow().is_some() { break; }
                if port_rx.changed().await.is_err() { return; }
            }
            let port = port_rx.borrow().unwrap();
            eprintln!("[vllm] connected on :{port}");

            let mut interval = tokio::time::interval(Duration::from_secs(2));

            // ── Inner poll loop — runs while vLLM is present ─────────────────
            loop {
                interval.tick().await;

                // React to port changes from the discovery loop.
                if port_rx.has_changed().unwrap_or(false) {
                    match *port_rx.borrow_and_update() {
                        None => {
                            eprintln!("[vllm] process gone — clearing metrics");
                            if let Ok(mut g) = shared_clone.lock() { *g = VllmMetrics::default(); }
                            break; // back to outer wait loop
                        }
                        Some(new_port) if new_port != port => {
                            break; // port changed — outer loop re-enters with new port
                        }
                        _ => {}
                    }
                }

                let (running, model, tps, cache, reqs) = harvest_vllm(port).await;
                if let Ok(mut g) = shared_clone.lock() {
                    *g = VllmMetrics {
                        vllm_running:          running,
                        vllm_model_name:       model,
                        vllm_tokens_per_sec:   tps,
                        vllm_cache_usage_perc: cache,
                        vllm_requests_running: reqs,
                    };
                }
            }
        }
    });

    shared
}

// ── Background Harvester ──────────────────────────────────────────────────────

fn start_metrics_harvester() -> Arc<Mutex<AppleSiliconMetrics>> {
    let shared = Arc::new(Mutex::new(AppleSiliconMetrics::default()));
    let shared_clone = Arc::clone(&shared);

    tokio::spawn(async move {
        let chip_name = read_apple_chip_name().await;
        // Read once at startup — iogpu.wired_limit_mb reflects the hardware
        // budget, not runtime state. Apple Silicon only; None on Intel Macs.
        #[cfg(target_os = "macos")]
        let wired_limit_mb = read_iogpu_wired_limit_mb();
        #[cfg(not(target_os = "macos"))]
        let wired_limit_mb: Option<u64> = None;

        let mut interval = tokio::time::interval(Duration::from_secs(2));
        loop {
            interval.tick().await;

            let mut m = AppleSiliconMetrics::default();
            m.gpu_name          = chip_name.clone();
            m.gpu_wired_limit_mb = wired_limit_mb;

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

// ── WES v2: Thermal Penalty Sampler ───────────────────────────────────────────
//
// Maps the current thermal_state string (or NVML bitmask result) to a numeric
// penalty factor, then maintains a 30-sample (60 s) rolling window per the WES v2
// spec. The window averages and peak are forwarded in every MetricsPayload.
//
// WES v2 penalty table (refined from v1 — Serious was 2.0, now 1.75):
//   Normal   → 1.00
//   Fair     → 1.25
//   Serious  → 1.75  ← changed from 2.0
//   Critical → 2.00
//
// Source tags:
//   "nvml"         — NVML throttle-reason bitmask (hardware-authoritative; NVIDIA only)
//   "iokit"        — macOS pmset / sysctl thermal level
//   "clock_ratio"  — AMD k10temp + scaling_cur_freq / cpuinfo_max_freq ratio
//   "sysfs"        — Linux /sys/class/thermal zone max (non-AMD fallback)
//   "unavailable"  — no thermal data on this platform

/// Maps a thermal-state string to the WES v2 penalty factor.
fn thermal_penalty_v2(state: &str) -> f32 {
    match state {
        "Critical" => 2.00,
        "Serious"  => 1.75,
        "Fair"     => 1.25,
        _          => 1.00,  // "Normal" and any unknown/empty value
    }
}

/// Snapshot of the WES thermal-penalty rolling window shared between the
/// sampler task and the 1 Hz broadcaster / SSE handler.
#[derive(Clone, Default)]
struct WesMetrics {
    /// Average thermal penalty over the last 30 samples (up to 60 s).
    /// None until the first sampler tick completes.
    penalty_avg:    Option<f32>,
    /// Peak (worst) penalty seen in the same window.
    penalty_peak:   Option<f32>,
    /// Source of the thermal data feeding this window.
    thermal_source: Option<String>,
    /// Number of samples currently in the window (1–30).
    sample_count:   u32,
}

/// Spawns a 2 s thermal-penalty sampling loop.
///
/// Priority (highest first):
///   1. `nvidia_metrics.nvidia_throttle_penalty` — NVML bitmask (authoritative)
///   2. `apple_metrics.thermal_state`            — macOS iokit
///   3. `linux_thermal_metrics`                  — Linux sysfs
///   4. Fallback: 1.0, source = "unavailable"
///
/// Maintains a `VecDeque` of up to 30 samples. Writes avg + peak + source + count
/// into the shared `WesMetrics` on every tick.
fn start_wes_sampler(
    apple_metrics:         Arc<Mutex<AppleSiliconMetrics>>,
    nvidia_metrics:        Arc<Mutex<NvidiaMetrics>>,
    linux_thermal_metrics: Arc<Mutex<Option<LinuxThermalResult>>>,
) -> Arc<Mutex<WesMetrics>> {
    let shared = Arc::new(Mutex::new(WesMetrics::default()));
    let shared_clone = Arc::clone(&shared);

    tokio::spawn(async move {
        let mut window: std::collections::VecDeque<f32> =
            std::collections::VecDeque::with_capacity(30);

        let mut interval = tokio::time::interval(Duration::from_secs(2));
        // Discard the immediate first tick so the first real sample has data.
        interval.tick().await;

        loop {
            interval.tick().await;

            let nvidia = nvidia_metrics.lock().map(|g| g.clone()).unwrap_or_default();
            let apple  = apple_metrics.lock().map(|g| g.clone()).unwrap_or_default();
            let linux  = linux_thermal_metrics.lock().map(|g| g.clone()).unwrap_or(None);

            // Determine penalty + source (highest-quality source wins).
            // AMD clock_ratio path carries a direct_penalty (can exceed 2.0 for
            // severe throttle); sysfs path uses thermal_penalty_v2(state).
            let (penalty, source): (f32, &'static str) =
                if let Some(p) = nvidia.nvidia_throttle_penalty {
                    (p, "nvml")
                } else if let Some(ref state) = apple.thermal_state {
                    (thermal_penalty_v2(state.as_str()), "iokit")
                } else if let Some(ref lt) = linux {
                    let p = lt.direct_penalty
                        .unwrap_or_else(|| thermal_penalty_v2(lt.state.as_str()));
                    (p, lt.source)
                } else {
                    (1.0, "unavailable")
                };

            // Rolling window: evict oldest sample when full.
            if window.len() >= 30 {
                window.pop_front();
            }
            window.push_back(penalty);

            let n   = window.len() as f32;
            let avg = window.iter().copied().sum::<f32>() / n;
            let peak = window.iter().copied().fold(f32::NEG_INFINITY, f32::max);

            // Round to 3 decimal places — avoids floating-point noise in JSON.
            let round3 = |v: f32| (v * 1_000.0).round() / 1_000.0;

            if let Ok(mut guard) = shared_clone.lock() {
                *guard = WesMetrics {
                    penalty_avg:    Some(round3(avg)),
                    penalty_peak:   Some(round3(peak)),
                    thermal_source: Some(source.to_string()),
                    sample_count:   window.len() as u32,
                };
            }
        }
    });

    shared
}

// ── 1 Hz Metrics Broadcaster (WebSocket feed) ─────────────────────────────────

/// Spawns a 1 s broadcast loop that serialises MetricsPayload and broadcasts
/// the JSON string to every active WebSocket subscriber.
/// 1 Hz keeps the display-layer rolling windows (8–12 samples) covering 8–12 s,
/// matching the effective smoothing depth of the cloud fleet dashboard.
/// The broadcast channel has capacity 64 — lagged subscribers simply skip frames.
fn start_metrics_broadcaster(
    apple_metrics:         Arc<Mutex<AppleSiliconMetrics>>,
    nvidia_metrics:        Arc<Mutex<NvidiaMetrics>>,
    ollama_metrics:        Arc<Mutex<OllamaMetrics>>,
    rapl_metrics:          Arc<Mutex<Option<f32>>>,
    linux_thermal_metrics: Arc<Mutex<Option<LinuxThermalResult>>>,
    vllm_metrics:          Arc<Mutex<VllmMetrics>>,
    live_events:           Arc<Mutex<Vec<LiveActivityEvent>>>,
    wes_metrics:           Arc<Mutex<WesMetrics>>,
) -> broadcast::Sender<String> {
    let (tx, _) = broadcast::channel::<String>(64);
    let tx_clone = tx.clone();

    tokio::spawn(async move {
        let mut sys = System::new_all();
        let node_id = System::host_name()
            .unwrap_or_else(|| "wicklee-sentinel-01".to_string());

        // Cache chip_name once — CPU model never changes at runtime.
        let linux_chip_name = read_linux_chip_name();

        // Warm-up: two reads separated by 200 ms gives sysinfo an accurate CPU delta.
        sys.refresh_all();
        tokio::time::sleep(Duration::from_millis(200)).await;

        let mut interval = tokio::time::interval(Duration::from_millis(1_000));
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

            let apple         = apple_metrics.lock().map(|g| g.clone()).unwrap_or_default();
            let nvidia        = nvidia_metrics.lock().map(|g| g.clone()).unwrap_or_default();
            let ollama        = ollama_metrics.lock().map(|g| g.clone()).unwrap_or_default();
            let vllm          = vllm_metrics.lock().map(|g| g.clone()).unwrap_or_default();
            let rapl_power    = rapl_metrics.lock().map(|g| *g).unwrap_or(None);
            let linux_thermal = linux_thermal_metrics.lock().map(|g| g.clone()).unwrap_or(None);
            let wes           = wes_metrics.lock().map(|g| g.clone()).unwrap_or_default();

            // Drain any pending live-activity events (normally empty, non-zero during update).
            let pending_events: Vec<LiveActivityEvent> = live_events
                .lock()
                .map(|mut v| std::mem::take(&mut *v))
                .unwrap_or_default();

            let payload = MetricsPayload {
                node_id:                 node_id.clone(),
                hostname:                node_id.clone(),
                gpu_name:                nvidia.nvidia_gpu_name.clone().or(apple.gpu_name.clone()),
                chip_name:               linux_chip_name.clone(),
                cpu_usage_percent:       sys.global_cpu_info().cpu_usage(),
                total_memory_mb:         total     / 1024 / 1024,
                used_memory_mb:          used      / 1024 / 1024,
                available_memory_mb:     available / 1024 / 1024,
                cpu_core_count:          sys.cpus().len(),
                timestamp_ms,
                // macOS: powermetrics; Linux: RAPL powercap; Windows: null
                cpu_power_w:             apple.cpu_power_w.or(rapl_power),
                ecpu_power_w:            apple.ecpu_power_w,
                pcpu_power_w:            apple.pcpu_power_w,
                gpu_utilization_percent: apple.gpu_utilization_percent,
                memory_pressure_percent: apple.memory_pressure_percent,
                gpu_wired_limit_mb:      apple.gpu_wired_limit_mb,
                // macOS: pmset/sysctl; Linux: /sys/class/thermal (harvest_linux_thermal); Windows: null
                thermal_state:           apple.thermal_state.or_else(|| linux_thermal.as_ref().map(|lt| lt.state.clone())),
                nvidia_gpu_utilization_percent: nvidia.nvidia_gpu_utilization_percent,
                nvidia_vram_used_mb:            nvidia.nvidia_vram_used_mb,
                nvidia_vram_total_mb:           nvidia.nvidia_vram_total_mb,
                nvidia_gpu_temp_c:              nvidia.nvidia_gpu_temp_c,
                nvidia_power_draw_w:            nvidia.nvidia_power_draw_w,
                ollama_running:           ollama.ollama_running,
                ollama_active_model:      ollama.ollama_active_model,
                ollama_model_size_gb:     ollama.ollama_model_size_gb,
                ollama_quantization:      ollama.ollama_quantization,
                ollama_tokens_per_second: ollama.ollama_tokens_per_second,
                ollama_inference_active:  ollama.ollama_inference_active,
                ollama_proxy_active:      if ollama.ollama_proxy_active { Some(true) } else { None },
                vllm_running:          vllm.vllm_running,
                vllm_model_name:       vllm.vllm_model_name,
                vllm_tokens_per_sec:   vllm.vllm_tokens_per_sec,
                vllm_cache_usage_perc: vllm.vllm_cache_usage_perc,
                vllm_requests_running: vllm.vllm_requests_running,
                os: {
                    #[cfg(target_os = "macos")]   { "macOS".to_string() }
                    #[cfg(target_os = "linux")]   { "Linux".to_string() }
                    #[cfg(target_os = "windows")] { "Windows".to_string() }
                    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
                    { "Unknown".to_string() }
                },
                arch: std::env::consts::ARCH.to_string(),
                live_activities: pending_events,
                // WES v2 thermal-penalty window (None until first 2 s sampler tick)
                penalty_avg:    wes.penalty_avg,
                penalty_peak:   wes.penalty_peak,
                thermal_source: wes.thermal_source,
                sample_count:   if wes.sample_count > 0 { Some(wes.sample_count) } else { None },
                wes_version:    2,
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
    // Register with cloud backend. On success: transition to Connected and persist.
    let ps = Arc::clone(&pairing_state);
    tokio::spawn(async move {
        if let Some(token) = register_pair_code(&node_id, &code).await {
            let fleet_url = "https://wicklee.dev".to_string();
            let mut state = ps.lock().unwrap();
            state.cloud_session_token = Some(token.clone());
            state.status = PairingStatus::Connected { fleet_url: fleet_url.clone() };
            save_config(&WickleeConfig {
                node_id: state.node_id.clone(),
                fleet_url: Some(fleet_url),
                session_token: Some(token),
                ollama_proxy: None,
                runtime_ports: None,
            });
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
        let fleet_url = "https://wicklee.dev".to_string();
        save_config(&WickleeConfig {
            node_id: state.node_id.clone(),
            fleet_url: Some(fleet_url.clone()),
            session_token: state.cloud_session_token.clone(),
            ollama_proxy: None,
            runtime_ports: None,
        });
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
    save_config(&WickleeConfig { node_id: state.node_id.clone(), fleet_url: None, session_token: None, ollama_proxy: None, runtime_ports: None });
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
    axum::extract::Extension(apple_metrics):         axum::extract::Extension<Arc<Mutex<AppleSiliconMetrics>>>,
    axum::extract::Extension(nvidia_metrics):        axum::extract::Extension<Arc<Mutex<NvidiaMetrics>>>,
    axum::extract::Extension(ollama_metrics):        axum::extract::Extension<Arc<Mutex<OllamaMetrics>>>,
    axum::extract::Extension(rapl_metrics):          axum::extract::Extension<Arc<Mutex<Option<f32>>>>,
    axum::extract::Extension(linux_thermal_metrics): axum::extract::Extension<Arc<Mutex<Option<LinuxThermalResult>>>>,
    axum::extract::Extension(vllm_metrics):          axum::extract::Extension<Arc<Mutex<VllmMetrics>>>,
    axum::extract::Extension(wes_metrics):           axum::extract::Extension<Arc<Mutex<WesMetrics>>>,
) -> Sse<ReceiverStream<Result<Event, Infallible>>> {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, Infallible>>(4);

    tokio::spawn(async move {
        let mut sys = System::new_all();
        let node_id = System::host_name()
            .unwrap_or_else(|| "wicklee-sentinel-01".to_string());

        let linux_chip_name = read_linux_chip_name();

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

            let apple         = apple_metrics.lock().map(|g| g.clone()).unwrap_or_default();
            let nvidia        = nvidia_metrics.lock().map(|g| g.clone()).unwrap_or_default();
            let ollama        = ollama_metrics.lock().map(|g| g.clone()).unwrap_or_default();
            let vllm          = vllm_metrics.lock().map(|g| g.clone()).unwrap_or_default();
            let rapl_power    = rapl_metrics.lock().map(|g| *g).unwrap_or(None);
            let linux_thermal = linux_thermal_metrics.lock().map(|g| g.clone()).unwrap_or(None);
            let wes           = wes_metrics.lock().map(|g| g.clone()).unwrap_or_default();

            let payload = MetricsPayload {
                node_id:             node_id.clone(),
                hostname:            node_id.clone(),
                gpu_name:            nvidia.nvidia_gpu_name.clone().or(apple.gpu_name.clone()),
                chip_name:           linux_chip_name.clone(),
                cpu_usage_percent:   sys.global_cpu_info().cpu_usage(),
                total_memory_mb:     total     / 1024 / 1024,
                used_memory_mb:      used      / 1024 / 1024,
                available_memory_mb: available / 1024 / 1024,
                cpu_core_count:      sys.cpus().len(),
                timestamp_ms,
                // macOS: powermetrics; Linux: RAPL powercap; Windows: null
                cpu_power_w:             apple.cpu_power_w.or(rapl_power),
                ecpu_power_w:            apple.ecpu_power_w,
                pcpu_power_w:            apple.pcpu_power_w,
                gpu_utilization_percent: apple.gpu_utilization_percent,
                memory_pressure_percent: apple.memory_pressure_percent,
                gpu_wired_limit_mb:      apple.gpu_wired_limit_mb,
                // macOS: pmset/sysctl; Linux: /sys/class/thermal (harvest_linux_thermal); Windows: null
                thermal_state:           apple.thermal_state.or_else(|| linux_thermal.as_ref().map(|lt| lt.state.clone())),
                nvidia_gpu_utilization_percent: nvidia.nvidia_gpu_utilization_percent,
                nvidia_vram_used_mb:            nvidia.nvidia_vram_used_mb,
                nvidia_vram_total_mb:           nvidia.nvidia_vram_total_mb,
                nvidia_gpu_temp_c:              nvidia.nvidia_gpu_temp_c,
                nvidia_power_draw_w:            nvidia.nvidia_power_draw_w,
                ollama_running:           ollama.ollama_running,
                ollama_active_model:      ollama.ollama_active_model,
                ollama_model_size_gb:     ollama.ollama_model_size_gb,
                ollama_quantization:      ollama.ollama_quantization,
                ollama_tokens_per_second: ollama.ollama_tokens_per_second,
                ollama_inference_active:  ollama.ollama_inference_active,
                ollama_proxy_active:      if ollama.ollama_proxy_active { Some(true) } else { None },
                vllm_running:          vllm.vllm_running,
                vllm_model_name:       vllm.vllm_model_name,
                vllm_tokens_per_sec:   vllm.vllm_tokens_per_sec,
                vllm_cache_usage_perc: vllm.vllm_cache_usage_perc,
                vllm_requests_running: vllm.vllm_requests_running,
                os: {
                    #[cfg(target_os = "macos")]   { "macOS".to_string() }
                    #[cfg(target_os = "linux")]   { "Linux".to_string() }
                    #[cfg(target_os = "windows")] { "Windows".to_string() }
                    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
                    { "Unknown".to_string() }
                },
                arch: std::env::consts::ARCH.to_string(),
                // SSE handler never generates live-activity events; broadcaster owns that.
                live_activities: Vec::new(),
                // WES v2 thermal-penalty window
                penalty_avg:    wes.penalty_avg,
                penalty_peak:   wes.penalty_peak,
                thermal_source: wes.thermal_source,
                sample_count:   if wes.sample_count > 0 { Some(wes.sample_count) } else { None },
                wes_version:    2,
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

// ── Self-Update ───────────────────────────────────────────────────────────────

/// Returns a static platform string that matches the GitHub release asset names,
/// e.g. "darwin-aarch64" → "wicklee-agent-darwin-aarch64".
// The fallback "unknown" literal is unreachable on every supported platform —
// suppress the warning rather than clutter with complex cfg(not(any(…))) guards.
#[allow(unreachable_code)]
fn agent_platform() -> &'static str {
    #[cfg(all(target_os = "macos",   target_arch = "aarch64"))]              { return "darwin-aarch64";      }
    // Linux x86_64 has two release binaries: the glibc/NVML build (no `no_nvml`
    // cfg) and the musl/static build (compiled with `RUSTFLAGS='--cfg no_nvml'`).
    // They must pull their own binary on auto-update — swapping them loses GPU metrics.
    #[cfg(all(target_os = "linux",   target_arch = "x86_64", not(no_nvml)))] { return "linux-x86_64-nvidia"; }
    #[cfg(all(target_os = "linux",   target_arch = "x86_64", no_nvml))]      { return "linux-x86_64";        }
    #[cfg(all(target_os = "linux",   target_arch = "aarch64"))]              { return "linux-aarch64";       }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]              { return "windows-x86_64";      }
    "unknown"
}

/// Returns true when `remote` is strictly newer than `current` (simple X.Y.Z
/// comparison — no pre-release handling needed for agent auto-updates).
fn is_newer_version(current: &str, remote: &str) -> bool {
    let parse = |v: &str| -> [u64; 3] {
        let s = v.trim_start_matches('v');
        let mut it = s.split('.').filter_map(|p| p.parse::<u64>().ok());
        [it.next().unwrap_or(0), it.next().unwrap_or(0), it.next().unwrap_or(0)]
    };
    parse(remote) > parse(current)
}

/// Checks https://wicklee.dev/api/agent/version, downloads the new binary when
/// a newer version is available, atomically replaces the current executable via
/// `self_update::self_replace`, emits a Live Activity event, and restarts.
///
/// All error paths log to stderr and return without panicking — startup must
/// never be blocked or aborted due to a failed update check.
///
/// **Sovereign Mode gate**: if the agent is unpaired (no cloud_session_token),
/// the check is skipped entirely to honour the operator's no-outbound-traffic choice.
async fn check_and_apply_update(
    pairing_state: Arc<Mutex<PairingState>>,
    live_events:   Arc<Mutex<Vec<LiveActivityEvent>>>,
) {
    // ── Sovereign Mode gate ────────────────────────────────────────────────────
    {
        let state = pairing_state.lock().unwrap();
        if state.cloud_session_token.is_none() {
            eprintln!("[update] sovereign mode — skipping update check (no fleet pairing)");
            return;
        }
    }

    let platform = agent_platform();
    if platform == "unknown" {
        eprintln!("[update] unrecognised platform — skipping update check");
        return;
    }

    let current = env!("CARGO_PKG_VERSION");
    eprintln!("[update] checking for update  current=v{current}  platform={platform}");

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(format!("wicklee-agent/{current}"))
        .build()
    {
        Ok(c)  => c,
        Err(e) => { eprintln!("[update] client build failed: {e}"); return; }
    };

    // ── Version check ──────────────────────────────────────────────────────────
    let url = format!("https://wicklee.dev/api/agent/version?platform={platform}");
    let resp = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r,
        Ok(r)  => { eprintln!("[update] version endpoint returned {}", r.status()); return; }
        Err(e) => { eprintln!("[update] version check failed: {e}"); return; }
    };

    let info: AgentVersionResponse = match resp.json::<AgentVersionResponse>().await {
        Ok(v)  => v,
        Err(e) => { eprintln!("[update] failed to parse version response: {e}"); return; }
    };

    if !is_newer_version(current, &info.latest) {
        eprintln!("[update] already up to date (v{current})");
        return;
    }

    let new_version = info.latest.trim_start_matches('v').to_string();
    eprintln!("[update] update available: v{current} → v{new_version}  downloading...");

    // ── Download binary ────────────────────────────────────────────────────────
    let download_resp = match client.get(&info.download_url).send().await {
        Ok(r) if r.status().is_success() => r,
        Ok(r)  => { eprintln!("[update] download returned {}", r.status()); return; }
        Err(e) => { eprintln!("[update] download request failed: {e}"); return; }
    };

    let bytes = match download_resp.bytes().await {
        Ok(b) if !b.is_empty() => b,
        Ok(_)  => { eprintln!("[update] download completed with zero bytes — aborting"); return; }
        Err(e) => { eprintln!("[update] failed to read download body: {e}"); return; }
    };

    // Write to a sibling temp file so rename stays on the same filesystem.
    let current_exe = match std::env::current_exe() {
        Ok(p)  => p,
        Err(e) => { eprintln!("[update] could not resolve current exe: {e}"); return; }
    };
    let tmp_path = current_exe.with_extension("update_tmp");

    if let Err(e) = std::fs::write(&tmp_path, &bytes) {
        eprintln!("[update] failed to write temp binary: {e}");
        return;
    }

    // chmod +x on Unix (Windows exe bits are not a thing).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match std::fs::metadata(&tmp_path) {
            Ok(m) => {
                let mut perms = m.permissions();
                perms.set_mode(0o755);
                if let Err(e) = std::fs::set_permissions(&tmp_path, perms) {
                    eprintln!("[update] chmod failed: {e}");
                    let _ = std::fs::remove_file(&tmp_path);
                    return;
                }
            }
            Err(e) => {
                eprintln!("[update] metadata read failed: {e}");
                let _ = std::fs::remove_file(&tmp_path);
                return;
            }
        }
    }

    // ── Atomic binary replacement via self_update ──────────────────────────────
    if let Err(e) = self_update::self_replace::self_replace(&tmp_path) {
        eprintln!("[update] binary replacement failed: {e}");
        let _ = std::fs::remove_file(&tmp_path);
        return;
    }
    // temp file is now the old binary — clean it up on best-effort basis.
    let _ = std::fs::remove_file(&tmp_path);

    let msg = format!("Wicklee agent updated v{current} → v{new_version}");
    eprintln!("[update] {msg}  restarting...");

    // ── Emit Live Activity event ───────────────────────────────────────────────
    // Push before restarting so the broadcaster picks it up in the next tick.
    {
        let mut evts = live_events.lock().unwrap();
        evts.push(LiveActivityEvent {
            message:      msg,
            timestamp_ms: now_ms(),
            level:        "info",
        });
    }

    // Give the broadcaster one full tick to drain the event to all WebSocket clients.
    tokio::time::sleep(Duration::from_millis(200)).await;

    // ── Restart ────────────────────────────────────────────────────────────────
    let args: Vec<String> = std::env::args().skip(1).collect();
    match std::process::Command::new(&current_exe).args(&args).spawn() {
        Ok(_)  => std::process::exit(0),
        Err(e) => eprintln!("[update] restart failed — continuing on new binary: {e}"),
    }
}

// ── Server Bootstrap ──────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    let config = load_or_create_config();
    let initial_status = if config.fleet_url.is_some() { "connected" } else { "unpaired" };
    let pairing_state = Arc::new(Mutex::new(PairingState {
        node_id:             config.node_id.clone(),
        // Restore session_token so telemetry push resumes immediately after a restart.
        cloud_session_token: config.session_token.clone(),
        status: match config.fleet_url.clone() {
            Some(url) => PairingStatus::Connected { fleet_url: url },
            None      => PairingStatus::Unpaired,
        },
    }));

    if std::env::args().any(|a| a == "--version" || a == "-V") {
        println!("wicklee-agent {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    if std::env::args().any(|a| a == "--install-service") {
        install_service().await;
        return;
    }

    if std::env::args().any(|a| a == "--uninstall-service") {
        uninstall_service().await;
        return;
    }

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(7700);

    let pair_on_start = std::env::args().any(|a| a == "--pair");
    if pair_on_start {
        let code = generate_code();
        let expires_at = now_ms() + 300_000;
        pairing_state.lock().unwrap().status = PairingStatus::Pending { code: code.clone(), expires_at };
        match register_pair_code(&config.node_id, &code).await {
            Some(token) => {
                let fleet_url = "https://wicklee.dev".to_string();
                let mut state = pairing_state.lock().unwrap();
                state.cloud_session_token = Some(token.clone());
                state.status = PairingStatus::Connected { fleet_url: fleet_url.clone() };
                save_config(&WickleeConfig {
                    node_id: state.node_id.clone(),
                    fleet_url: Some(fleet_url),
                    session_token: Some(token),
                    ollama_proxy: None,
                    runtime_ports: None,
                });
            }
            None => eprintln!("[warn] Could not register code with cloud backend. Check your internet connection."),
        }
        print_pairing_box(&config.node_id, &code);
    }

    // Run diagnostics first so the output appears before the banner
    run_startup_diagnostics(&config.node_id, if pair_on_start { "pending" } else { initial_status }, port, &config).await;

    // ── Optional Ollama transparent proxy ─────────────────────────────────────
    // When enabled in config, try to bind :11434 and forward to Ollama on
    // ollama_port (default 11435). If :11434 is unavailable (Ollama still there),
    // fall back to Phase A /api/ps polling with a clear log message.
    let proxy_cfg = config.ollama_proxy.clone().unwrap_or_default();
    let proxy_arc: Option<Arc<ProxyState>> = if proxy_cfg.enabled {
        match tokio::net::TcpListener::bind("127.0.0.1:11434").await {
            Ok(proxy_listener) => {
                let ps = Arc::new(ProxyState {
                    ollama_port:      proxy_cfg.ollama_port,
                    bypass_if_down:   proxy_cfg.bypass_if_proxy_down,
                    client:           reqwest::Client::builder()
                                        .timeout(Duration::from_secs(300))
                                        .build()
                                        .unwrap_or_default(),
                    inference_active: std::sync::atomic::AtomicBool::new(false),
                    last_done_ts:     Mutex::new(None),
                    exact_tps:        Mutex::new(None),
                });
                let ps_clone = Arc::clone(&ps);
                let proxy_app = axum::Router::new()
                    .route("/api/generate", axum::routing::post(proxy_ollama_streaming))
                    .route("/api/chat",     axum::routing::post(proxy_ollama_streaming))
                    .fallback(proxy_passthrough)
                    .with_state(ps_clone)
                    .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any));
                tokio::spawn(async move {
                    if let Err(e) = axum::serve(proxy_listener, proxy_app).await {
                        eprintln!("[proxy] Server exited: {e}");
                    }
                });
                eprintln!("[proxy] Listening on 127.0.0.1:11434 → Ollama :{}", proxy_cfg.ollama_port);
                Some(ps)
            }
            Err(e) => {
                eprintln!(
                    "[proxy] Cannot bind 127.0.0.1:11434 ({e})\n\
                     Falling back to /api/ps polling (Phase A). Is Ollama still on :11434?\n\
                     To enable proxy: set OLLAMA_HOST=127.0.0.1:{} and restart Ollama, then restart the agent.",
                    proxy_cfg.ollama_port
                );
                None
            }
        }
    } else {
        None
    };

    // ── Runtime discovery — process-first, port-agnostic ─────────────────────
    // Create one watch channel per known runtime. The discovery loop scans
    // processes every 30 s and sends Some(port) / None into each channel.
    // Harvesters receive their channel and react to changes automatically —
    // no hardcoded ports, no restart required when a runtime changes port.
    let (ollama_port_tx, ollama_port_rx) = watch::channel(None::<u16>);
    let (vllm_port_tx,   vllm_port_rx)   = watch::channel(None::<u16>);

    // Seed channels: config overrides take precedence over process auto-detection.
    // Config overrides are used when the runtime runs as a different OS user and
    // the agent cannot read its process cmdline (cross-user /proc restriction).
    let initial = process_discovery::scan_runtimes();
    let rp = config.runtime_ports.as_ref();
    let ollama_port = rp.and_then(|r| r.ollama).or_else(|| initial.get("ollama").copied());
    let vllm_port   = rp.and_then(|r| r.vllm  ).or_else(|| initial.get("vllm").copied());
    if let Some(p) = ollama_port { let _ = ollama_port_tx.send(Some(p)); }
    if let Some(p) = vllm_port   { let _ = vllm_port_tx.send(Some(p)); }

    // Start the background discovery loop (30 s interval).
    process_discovery::start_discovery_loop(
        [
            ("ollama", ollama_port_tx),
            ("vllm",   vllm_port_tx),
        ].into_iter().collect(),
        30,
    );

    let apple_metrics         = start_metrics_harvester();
    let nvidia_metrics        = start_nvidia_harvester();
    let ollama_metrics        = start_ollama_harvester(
        Arc::clone(&apple_metrics),
        Arc::clone(&nvidia_metrics),
        proxy_arc,
        ollama_port_rx,
    );
    let rapl_metrics          = start_rapl_harvester();
    let linux_thermal_metrics = start_linux_thermal_harvester();
    let vllm_metrics          = start_vllm_harvester(vllm_port_rx);

    // WES v2 — 2 s thermal-penalty sampler (30-sample rolling window).
    // Must start after the platform harvesters above so it has data to read.
    let wes_metrics = start_wes_sampler(
        Arc::clone(&apple_metrics),
        Arc::clone(&nvidia_metrics),
        Arc::clone(&linux_thermal_metrics),
    );

    // Shared event queue for drain-on-send live activity entries (update notifications etc.).
    let live_events: Arc<Mutex<Vec<LiveActivityEvent>>> = Arc::new(Mutex::new(Vec::new()));

    let broadcast_tx          = start_metrics_broadcaster(
        Arc::clone(&apple_metrics),
        Arc::clone(&nvidia_metrics),
        Arc::clone(&ollama_metrics),
        Arc::clone(&rapl_metrics),
        Arc::clone(&linux_thermal_metrics),
        Arc::clone(&vllm_metrics),
        Arc::clone(&live_events),
        Arc::clone(&wes_metrics),
    );

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
        .layer(axum::extract::Extension(Arc::clone(&pairing_state)))
        .layer(axum::extract::Extension(apple_metrics))
        .layer(axum::extract::Extension(nvidia_metrics))
        .layer(axum::extract::Extension(ollama_metrics))
        .layer(axum::extract::Extension(rapl_metrics))
        .layer(axum::extract::Extension(linux_thermal_metrics))
        .layer(axum::extract::Extension(vllm_metrics))
        .layer(axum::extract::Extension(wes_metrics))
        .layer(axum::extract::Extension(broadcast_tx))
        .layer(cors);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .expect(&format!("Failed to bind port {port}"));

    // ── Self-update check ─────────────────────────────────────────────────────
    // Runs once after the server is bound. Spawned so axum::serve is not delayed.
    // Sovereign Mode agents (unpaired) skip this entirely inside the function.
    {
        let pairing_state = Arc::clone(&pairing_state);
        let live_events   = Arc::clone(&live_events);
        tokio::spawn(async move {
            // Brief startup delay — lets the server stabilise and write its
            // first few metrics frames before we do any network I/O.
            tokio::time::sleep(Duration::from_secs(5)).await;
            check_and_apply_update(pairing_state, live_events).await;
        });
    }

    axum::serve(listener, app)
        .await
        .expect("Server exited unexpectedly");
}
