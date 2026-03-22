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
#[cfg(not(target_env = "musl"))]
mod store;
mod inference;
mod harvester;
mod proxy;
mod cloud_push;
mod service;
mod diagnostics;
#[cfg(any(all(target_os = "linux", not(target_env = "musl")), target_os = "windows"))]
use nvml_wrapper::{bitmasks::device::ThrottleReasons, enum_wrappers::device::{Clock, TemperatureSensor}, Nvml};
// nvml-wrapper 0.10 only wraps nvmlDeviceGetMemoryInfo (v1), which returns
// NVML_ERROR_NOT_SUPPORTED on Grace Blackwell / unified-memory architectures.
// We access nvmlDeviceGetMemoryInfo_v2 directly through the sys crate.
#[cfg(any(all(target_os = "linux", not(target_env = "musl")), target_os = "windows"))]
use nvml_wrapper_sys::bindings::{nvmlMemory_v2_t, nvmlDevice_t};
use tokio_stream::wrappers::ReceiverStream;
use tower_http::cors::{Any, CorsLayer};

use inference::{read_hardware_signals, compute_inference_state};
use proxy::ProxyState;

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
pub(crate) struct OllamaMetrics {
    pub(crate) ollama_running:           bool,
    pub(crate) ollama_active_model:      Option<String>,
    pub(crate) ollama_model_size_gb:     Option<f32>,
    pub(crate) ollama_quantization:      Option<String>,
    /// Sustained tok/s: eval_rate from Ollama /api/generate probe every 30s.
    /// Reflects actual node throughput under current thermal/load conditions.
    pub(crate) ollama_tokens_per_second: Option<f32>,
    /// True when a request completed within the last 35s (one probe interval).
    /// Derived from expires_at resets observed in /api/ps polls.
    /// None = not yet determined (no expires_at change seen since agent start).
    pub(crate) ollama_inference_active: Option<bool>,
    /// True when the transparent proxy is active on :11434.
    /// When true, tok/s comes from done-packet eval_count/eval_duration rather than the 30s probe.
    #[serde(default)]
    pub(crate) ollama_proxy_active: bool,
    /// Set to `Some(Instant::now())` when probe_ollama_tps() begins.
    #[serde(skip)]
    pub(crate) last_probe_start: Option<std::time::Instant>,
    /// Set to `Some(Instant::now())` when probe_ollama_tps() returns.
    #[serde(skip)]
    pub(crate) last_probe_end: Option<std::time::Instant>,
    /// Set when /api/ps expires_at changes while probe_active == false.
    /// Attributed to user inference only — probe-caused resets are excluded via AtomicBool.
    #[serde(skip)]
    pub(crate) last_user_request_ts: Option<std::time::Instant>,
    /// Set to `true` when the probe completes. The /api/ps harvester consumes this
    /// flag on the first `expires_at` change it observes — that change is the probe's
    /// own reset and must not be attributed to the user. Any subsequent expires_at
    /// change is a real user request and is attributed normally.
    /// This replaces the 10s time-based blackout that caused the Dead Zone.
    #[serde(skip)]
    pub(crate) probe_caused_next_reset: bool,
}

impl OllamaMetrics {
    /// True for 30 s after the probe completes — matches the 30s probe interval so
    /// IDLE-SPD displays continuously while Ollama is loaded and probes are running.
    /// Used exclusively for the IDLE-SPD display state; attribution now uses AtomicBool.
    pub(crate) fn recent_probe_baseline(&self) -> bool {
        self.last_probe_end.map_or(false, |t| t.elapsed().as_secs() < 30)
    }

    /// Frontend diagnostic field: true while the probe is actively running,
    /// or within 5 s of finishing (short cool-down). Exported as
    /// `ollama_is_probing` in MetricsPayload so the UI can show "probing" badge.
    pub(crate) fn is_probing_display(&self) -> bool {
        match (self.last_probe_start, self.last_probe_end) {
            (None, _)          => false,                         // never started
            (Some(_), Some(e)) => e.elapsed().as_secs() < 5,    // finished — 5 s cool-down
            (Some(s), None)    => s.elapsed().as_secs() < 60,   // still running (generous timeout)
        }
    }
}

// vLLM runtime metrics — populated when vLLM is detected on localhost:8000.
// All fields are Option/bool-default so the payload serialises cleanly when absent.

#[derive(Serialize, Clone, Default)]
pub(crate) struct VllmMetrics {
    pub(crate) vllm_running:          bool,
    pub(crate) vllm_model_name:       Option<String>,
    pub(crate) vllm_tokens_per_sec:   Option<f32>,
    pub(crate) vllm_cache_usage_perc: Option<f32>,
    pub(crate) vllm_requests_running: Option<u32>,
}

// NVIDIA GPU metrics — populated only on Linux/Windows nodes with NVIDIA drivers.
// All fields are Option so the payload serialises cleanly as null on other platforms.
#[derive(Serialize, Clone, Default)]
pub(crate) struct NvidiaMetrics {
    pub(crate) nvidia_gpu_utilization_percent: Option<f32>,
    pub(crate) nvidia_vram_used_mb:            Option<u64>,
    pub(crate) nvidia_vram_total_mb:           Option<u64>,
    pub(crate) nvidia_gpu_temp_c:              Option<u32>,
    pub(crate) nvidia_power_draw_w:            Option<f32>,
    /// Human-readable GPU model name, e.g. "NVIDIA GeForce RTX 4080"
    nvidia_gpu_name:                Option<String>,
    /// Thermal penalty derived from the NVML throttle-reason bitmask (WES v2).
    /// Always Some(_) when NVML is active — 1.0 = no throttle, >1.0 = throttled.
    /// None on non-NVIDIA platforms. The WES sampler prefers this over string-inferred
    /// thermal_state because it is hardware-authoritative, not temperature-proxied.
    #[serde(skip)]   // internal use only; not forwarded in MetricsPayload
    pub(crate) nvidia_throttle_penalty:        Option<f32>,
    /// GPU clock throttle percentage: 0.0 = running at full rated speed, 100.0 = fully throttled.
    /// Derived from nvmlDeviceGetClockInfo(GRAPHICS) / nvmlDeviceGetMaxClockInfo(GRAPHICS).
    /// Inverse of clock ratio so higher values always mean worse state (consistent with other %).
    /// #[serde(skip)] — forwarded via MetricsPayload.clock_throttle_pct, not directly.
    #[serde(skip)]
    pub(crate) clock_throttle_pct:             Option<f32>,
    /// Current PCIe link width (lanes): 1, 2, 4, 8, or 16.
    /// nvmlDeviceGetCurrPcieLinkWidth. None on virtualised GPUs where PCIe info is unavailable.
    #[serde(skip)]
    pub(crate) pcie_link_width:                Option<u32>,
    /// Maximum PCIe link width the card + slot support.
    /// nvmlDeviceGetMaxPcieLinkWidth. When pcie_link_width < pcie_link_max_width the card is
    /// running in a narrower slot than its design spec (lane-degraded).
    #[serde(skip)]
    pub(crate) pcie_link_max_width:            Option<u32>,
}

#[derive(Serialize, Clone, Default)]
pub(crate) struct AppleSiliconMetrics {
    pub(crate) cpu_power_w:             Option<f32>,
    pub(crate) ecpu_power_w:            Option<f32>,
    pub(crate) pcpu_power_w:            Option<f32>,
    /// GPU power draw reported by powermetrics "GPU Power: NNN mW".
    /// None on Intel Macs and non-macOS platforms.
    pub(crate) gpu_power_w:             Option<f32>,
    /// Apple Neural Engine power from "ANE Power: NNN mW" (some macOS versions).
    pub(crate) ane_power_w:             Option<f32>,
    /// Total SoC power from powermetrics "Combined Power (CPU + GPU + ANE): NNN mW"
    /// (or "Combined Power:" / "Package Power:" on older/newer macOS versions).
    /// This is the authoritative total for Apple Silicon WES calculation.
    /// Synthesized from cpu + gpu + ane if the combined line is absent.
    /// None on Intel Macs and non-macOS platforms.
    pub(crate) soc_power_w:             Option<f32>,
    pub(crate) gpu_utilization_percent: Option<f32>,
    pub(crate) memory_pressure_percent: Option<f32>,
    pub(crate) thermal_state:           Option<String>,
    /// Apple Silicon chip description, e.g. "Apple M3 Max"
    pub(crate) gpu_name:                Option<String>,
    /// GPU wired memory budget (MB) from `sysctl iogpu.wired_limit_mb`.
    /// This is the maximum unified memory macOS will wire for GPU use —
    /// typically ~75% of total RAM. None on Intel Macs and non-macOS.
    pub(crate) gpu_wired_limit_mb:      Option<u64>,
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
    /// GPU power draw from powermetrics "GPU Power:" line.
    /// Use soc_power_w for total WES power calculation (it includes CPU + GPU + ANE).
    #[serde(skip_serializing_if = "Option::is_none")]
    apple_gpu_power_w:       Option<f32>,
    /// Total SoC power from powermetrics "Combined Power (CPU + GPU + ANE):" line.
    /// This is the authoritative total power for Apple Silicon WES calculation.
    /// Prefer this over cpu_power_w + apple_gpu_power_w.
    #[serde(skip_serializing_if = "Option::is_none")]
    apple_soc_power_w:       Option<f32>,
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
    /// True during the agent's 30s background probe AND for 40 s afterward.
    /// Frontend uses this to show IDLE-SPD instead of LIVE during probe activity —
    /// the probe fires a real Ollama request which would otherwise look like a user session.
    #[serde(skip_serializing_if = "Option::is_none")]
    ollama_is_probing: Option<bool>,
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
    /// Swap device write rate in MB/s.
    /// Linux: /proc/vmstat pswpout delta. macOS: vm_stat Swapouts delta.
    /// Absent (None) on Windows and agents that lack the swap harvester.
    #[serde(skip_serializing_if = "Option::is_none")]
    swap_write_mb_s: Option<f32>,
    /// GPU clock throttle percentage: 0 = full speed, 100 = fully throttled.
    /// NVIDIA: derived from nvmlDeviceGetClockInfo(GRAPHICS) / nvmlDeviceGetMaxClockInfo.
    /// AMD/Linux: derived from scaling_cur_freq / cpuinfo_max_freq (clock_ratio path only).
    /// None on macOS, Windows, non-AMD Linux without cpufreq, and musl builds.
    #[serde(skip_serializing_if = "Option::is_none")]
    clock_throttle_pct: Option<f32>,
    /// Current PCIe link width in lanes (1/4/8/16). NVIDIA only; None on non-NVIDIA.
    /// Pattern L fires when pcie_link_width < pcie_link_max_width (lane-degraded slot).
    #[serde(skip_serializing_if = "Option::is_none")]
    pcie_link_width:     Option<u32>,
    /// Maximum PCIe link width the GPU + slot support. Paired with pcie_link_width.
    #[serde(skip_serializing_if = "Option::is_none")]
    pcie_link_max_width: Option<u32>,
    /// Compile-time agent version from Cargo.toml (e.g. "0.4.36").
    /// The frontend compares this against its own build-time UI version to detect
    /// stale cached interfaces and prompt a hard-reload.
    agent_version: String,
    /// Authoritative inference state, computed once by compute_inference_state().
    /// "idle-spd" | "live" | "busy" | "idle"
    /// Sent to both the local WebSocket and the cloud telemetry API so both
    /// surfaces always display the same label — no frontend re-computation needed.
    inference_state: String,
}

// ── Fleet Pairing Types ───────────────────────────────────────────────────────

/// Optional transparent proxy configuration.
/// When enabled, the agent binds :11434 and forwards to Ollama on ollama_port.
/// Provides zero-lag inference detection and exact tok/s from done packets.
/// Requires the user to move Ollama to ollama_port (OLLAMA_HOST=127.0.0.1:11435).
#[derive(Serialize, Deserialize, Default, Clone)]
pub(crate) struct OllamaProxyConfig {
    /// Enable the transparent proxy. Default: false (Phase A /api/ps polling).
    #[serde(default)]
    pub(crate) enabled: bool,
    /// Port where Ollama listens after being moved. Default: 11435.
    #[serde(default = "default_proxy_ollama_port")]
    pub(crate) ollama_port: u16,
    /// Return 503 immediately when backend is unreachable rather than timing out.
    #[serde(default)]
    pub(crate) bypass_if_proxy_down: bool,
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
#[derive(Serialize, Deserialize, Default, Clone)]
pub(crate) struct RuntimePortsConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ollama: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) vllm: Option<u16>,
}

#[derive(Serialize, Deserialize, Default)]
pub(crate) struct WickleeConfig {
    pub(crate) node_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) fleet_url: Option<String>,
    /// Cloud session token — persisted so telemetry push resumes after restart.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) session_token: Option<String>,
    /// Optional transparent Ollama proxy configuration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) ollama_proxy: Option<OllamaProxyConfig>,
    /// Explicit port overrides — bypasses process-based auto-detection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) runtime_ports: Option<RuntimePortsConfig>,
}

#[derive(Clone)]
pub(crate) enum PairingStatus {
    Unpaired,
    Pending { code: String, expires_at: u64 },
    Connected { fleet_url: String },
}

pub(crate) struct PairingState {
    pub(crate) status:               PairingStatus,
    pub(crate) node_id:              String,
    /// Session token returned by the cloud backend after a successful claim.
    /// Present only while paired; used to authenticate telemetry pushes.
    pub(crate) cloud_session_token:  Option<String>,
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
pub(crate) struct LiveActivityEvent {
    pub(crate) message:      String,
    pub(crate) timestamp_ms: u64,
    /// Frontend style hint: "info" | "warn" | "error"
    pub(crate) level:        &'static str,
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

pub(crate) fn parse_pmset_therm(output: &str) -> Option<String> {
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

pub(crate) fn parse_ioreg_gpu(text: &str) -> Option<f32> {
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
pub(crate) const RAPL_PATHS: &[(&str, &str)] = &[
    ("/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj", "intel-rapl"),
    ("/sys/class/powercap/intel-rapl:0/energy_uj",            "intel-rapl:0"),
    ("/sys/class/powercap/amd-core/amd-core:0/energy_uj",     "amd-core"),
];

#[cfg(target_os = "linux")]
pub(crate) fn read_rapl_uj(path: &str) -> Option<u64> {
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

// ── Swap Write Rate Harvester ─────────────────────────────────────────────────
//
// Samples the OS swap-out page counter once every 2 s and converts the delta
// to MB/s.  Zero-privilege — reads kernel counters directly on Linux;
// spawns a single `vm_stat` on macOS.
//
// Platform sources:
//   Linux:   /proc/vmstat → pswpout (cumulative swap-out pages, 4096 bytes each)
//   macOS:   vm_stat      → Swapouts (cumulative, page size from header)
//   Windows: None (WMI-based implementation deferred to Phase 6)
//
// Newtype wrapper prevents Axum extension collision with rapl_metrics which
// is the same inner type (Arc<Mutex<Option<f32>>>).

#[derive(Clone)]
struct SwapMetrics(Arc<Mutex<Option<f32>>>);

impl SwapMetrics {
    fn read(&self) -> Option<f32> {
        self.0.lock().map(|g| *g).unwrap_or(None)
    }
}

fn start_swap_harvester() -> SwapMetrics {
    let inner  = Arc::new(Mutex::new(None::<f32>));
    let shared = SwapMetrics(Arc::clone(&inner));

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        tokio::spawn(async move {
            loop {
                let before = read_swap_pages_out().await;
                tokio::time::sleep(Duration::from_secs(2)).await;
                let after  = read_swap_pages_out().await;

                if let (Some((b_pages, b_ps)), Some((a_pages, a_ps))) = (before, after) {
                    if a_pages >= b_pages {
                        let page_size = ((b_ps + a_ps) / 2) as f64;
                        // (delta_pages × page_size_bytes) / 1_000_000 bytes/MB / 2 seconds
                        let mb_s = ((a_pages - b_pages) as f64 * page_size / 1_000_000.0 / 2.0) as f32;
                        if let Ok(mut guard) = inner.lock() {
                            *guard = Some(mb_s);
                        }
                    }
                }
                // No additional sleep — the 2 s read gap above is the sampling interval.
            }
        });
    }

    shared
}

/// Returns (cumulative_swap_out_pages, page_size_bytes).
/// Returns None when the platform counter is unavailable or the read fails.
#[cfg(target_os = "linux")]
async fn read_swap_pages_out() -> Option<(u64, u64)> {
    // Linux page size is always 4096 on x86_64 and almost always on aarch64.
    // /proc/vmstat pswpout counts pages swapped out since boot.
    let content = std::fs::read_to_string("/proc/vmstat").ok()?;
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("pswpout ") {
            let pages: u64 = rest.trim().parse().ok()?;
            return Some((pages, 4096));
        }
    }
    None
}

#[cfg(target_os = "macos")]
async fn read_swap_pages_out() -> Option<(u64, u64)> {
    let out = tokio::process::Command::new("vm_stat")
        .output()
        .await
        .ok()?;
    if !out.status.success() { return None; }
    parse_vm_stat_swapouts(&String::from_utf8_lossy(&out.stdout))
}

/// Parse vm_stat output for the Swapouts counter and page size.
///
/// Example header: "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
/// Example data line: "Swapouts:                               104."
#[cfg(target_os = "macos")]
fn parse_vm_stat_swapouts(text: &str) -> Option<(u64, u64)> {
    let mut page_size: u64 = 4096;   // default; overridden by header
    let mut swapouts:  Option<u64> = None;

    for line in text.lines() {
        // Parse page size from the header line.
        if line.starts_with("Mach Virtual Memory Statistics:") {
            if let Some(pos) = line.find("page size of ") {
                let rest = &line[pos + "page size of ".len()..];
                let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                if let Ok(v) = num.parse::<u64>() { page_size = v; }
            }
        }
        // Parse the Swapouts counter (trailing period stripped).
        if let Some(rest) = line.strip_prefix("Swapouts:") {
            let s = rest.trim().trim_end_matches('.');
            swapouts = s.parse::<u64>().ok();
        }
    }

    swapouts.map(|s| (s, page_size))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
async fn read_swap_pages_out() -> Option<(u64, u64)> {
    None
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
    /// Raw clock ratio (cur/max) from the AMD path.  None on the generic sysfs path.
    /// Frontend converts to clock_throttle_pct = (1.0 - ratio) * 100.
    clock_ratio:    Option<f64>,
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
        clock_ratio:    Some(ratio),
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
        clock_ratio:    None,
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

// ── Ghost-Killer ─────────────────────────────────────────────────────────────
// If port {port} is held by a previous wicklee process, send SIGTERM then
// SIGKILL and wait for the port to be released before the caller retries bind.
// Returns true when the port has been freed, false when it couldn't be evicted
// (not a wicklee process, permission denied, or OS doesn't have lsof/ps).
#[cfg(not(target_os = "windows"))]
async fn try_evict_port(port: u16) -> bool {
    // Step 1: find the PID holding the port.
    let lsof = tokio::process::Command::new("lsof")
        .args(["-ti", &format!("tcp:{port}")])
        .output().await;
    let Ok(lsof_out) = lsof else { return false };
    let pid_str = String::from_utf8_lossy(&lsof_out.stdout).trim().to_string();
    let Ok(_pid) = pid_str.parse::<u32>() else { return false };

    // Step 2: confirm the process is a wicklee binary (not some other service).
    let ps = tokio::process::Command::new("ps")
        .args(["-p", &pid_str, "-o", "comm="])
        .output().await;
    let Ok(ps_out) = ps else { return false };
    let proc_name = String::from_utf8_lossy(&ps_out.stdout).trim().to_lowercase();
    if !proc_name.contains("wicklee") { return false; }

    println!("  Evicting previous wicklee instance (PID {pid_str})…");

    // Step 3: SIGTERM — allow graceful shutdown.
    let _ = tokio::process::Command::new("kill")
        .args(["-TERM", &pid_str])
        .status().await;

    // Step 4: poll up to 2 s for the port to be free.
    for _ in 0..4 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let check = tokio::process::Command::new("lsof")
            .args(["-ti", &format!("tcp:{port}")])
            .output().await;
        if check.map(|o| o.stdout.trim_ascii().is_empty()).unwrap_or(true) {
            return true;
        }
    }

    // Step 5: SIGKILL if still alive after 2 s.
    let _ = tokio::process::Command::new("kill")
        .args(["-KILL", &pid_str])
        .status().await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    true
}

/// powermetrics — parses CPU/GPU/SoC power and memory pressure.
/// The process may already be root (launchd service) or not; powermetrics
/// requires root for power sampling. When run without root it typically
/// exits non-zero — we surface the stderr so ops can diagnose permissions.
async fn try_powermetrics_nosudo() -> Option<AppleSiliconMetrics> {
    let out = tokio::process::Command::new("powermetrics")
        // 5000 ms window: M2 token-decode is bursty (~28 ms/token at 35 tok/s).
        // A 500 ms window can catch the inter-token idle and report ~1–2 W when the
        // true average is 3–5 W.  5000 ms spans ≥175 decode steps, covering the full
        // chip duty-cycle for an accurate average power reading.
        .args(["--samplers", "cpu_power,gpu_power,thermal", "-n", "1", "-i", "5000"])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        if !stderr.trim().is_empty() {
            eprintln!("[power] powermetrics failed: {}", stderr.trim());
            eprintln!("[power] hint: run as root (sudo wicklee --install-service) for SoC power data");
        }
        return None;
    }
    let result = parse_powermetrics(&String::from_utf8_lossy(&out.stdout));
    // Debug: warn if we got cpu_power but no soc_power — suggests parse miss
    if result.cpu_power_w.is_some() && result.soc_power_w.is_none() {
        eprintln!("[power] parsed cpu_power_w={:.1}W but soc_power_w=None — Combined Power line not found",
            result.cpu_power_w.unwrap_or(0.0));
    }
    Some(result)
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
        } else if let Some(rest) = line.strip_prefix("GPU Power: ") {
            m.gpu_power_w = parse_mw(rest);
        } else if let Some(rest) = line.strip_prefix("ANE Power: ") {
            // Apple Neural Engine power — present on some macOS versions as a separate line
            m.ane_power_w = parse_mw(rest);
        } else if let Some(rest) =
            // macOS 13-14 (Ventura/Sonoma): "Combined Power (CPU + GPU + ANE): XXXX mW"
            line.strip_prefix("Combined Power (CPU + GPU + ANE): ")
            // macOS 15 (Sequoia) variant observed in the wild — parenthetical dropped
            .or_else(|| line.strip_prefix("Combined Power: "))
            // Older Intel-era label still seen on some Mx configurations
            .or_else(|| line.strip_prefix("Package Power: "))
            // Sequoia 15.2+ renames the combined line on Apple Silicon
            .or_else(|| line.strip_prefix("SoC Power: "))
            // Additional observed variant on some M-series configurations
            .or_else(|| line.strip_prefix("System Power: "))
        {
            m.soc_power_w = parse_mw(rest);
        } else if let Some(rest) = line.strip_prefix("GPU Active residency: ")
            // macOS Sequoia (24D+) changed the label to include "HW" — handle both.
            .or_else(|| line.strip_prefix("GPU HW active residency: "))
        {
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

    // Diagnostic: dump every "Power" line from the raw output so operators can
    // see the exact labels powermetrics uses on this macOS version.  This lets
    // us catch label changes (e.g. "Combined Power" → "SoC Power" in Sequoia)
    // without guessing.  Log prefix [pm_raw] — filter with:
    //   sudo tail -f /var/log/wicklee.log | grep '\[pm_raw\]'
    for line in output.lines() {
        let t = line.trim();
        let lower = t.to_ascii_lowercase();
        if lower.contains("power") || lower.contains("residency") {
            eprintln!("[pm_raw] {t}");
        }
    }

    // Synthesize soc_power_w from components if the combined line was absent.
    // This handles macOS versions that omit "Combined Power" but still output
    // individual CPU + GPU + ANE lines.
    if m.soc_power_w.is_none() {
        if m.cpu_power_w.is_some() || m.gpu_power_w.is_some() || m.ane_power_w.is_some() {
            let total = m.cpu_power_w.unwrap_or(0.0)
                + m.gpu_power_w.unwrap_or(0.0)
                + m.ane_power_w.unwrap_or(0.0);
            if total > 0.1 { m.soc_power_w = Some(total); }
        }
    }

    // Diagnostic: log the power component breakdown so operators can verify
    // GPU + ANE rails are being captured during active inference.
    eprintln!("[power] soc={:.2}W  (cpu={:.2} + gpu={:.2} + ane={:.2})",
        m.soc_power_w.unwrap_or(0.0),
        m.cpu_power_w.unwrap_or(0.0),
        m.gpu_power_w.unwrap_or(0.0),
        m.ane_power_w.unwrap_or(0.0));

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

/// System-global config path — identical whether the process runs as root (launchd/systemd)
/// or as a normal user. This prevents the "two config files" problem where upgrading via
/// launchd creates a separate identity from the user's manually-run instance.
///
/// macOS:   /Library/Application Support/Wicklee/config.toml
/// Linux:   /etc/wicklee/config.toml
/// Windows: %APPDATA%\Wicklee\config.toml  (fallback: C:\ProgramData\Wicklee\config.toml)
fn config_path() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        Path::new("/Library/Application Support/Wicklee/config.toml").to_path_buf()
    }
    #[cfg(target_os = "linux")]
    {
        Path::new("/etc/wicklee/config.toml").to_path_buf()
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("APPDATA")
            .or_else(|_| std::env::var("PROGRAMDATA"))
            .unwrap_or_else(|_| r"C:\ProgramData".to_string());
        Path::new(&base).join("Wicklee").join("config.toml")
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        // Fallback for any other platform
        Path::new(".wicklee").join("config.toml")
    }
}

/// Legacy per-user config path (pre-v0.4.37). Used only for one-time migration.
fn legacy_config_path() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        // Try $HOME first; then derive from /etc/passwd for the effective uid.
        let home = std::env::var("HOME").ok().or_else(|| {
            let uid = unsafe { libc::getuid() };
            // Real user's home — look up uid=500+ first; if root (0) skip migration.
            if uid == 0 { return None; }
            let pw = unsafe { libc::getpwuid(uid) };
            if pw.is_null() { return None; }
            let dir = unsafe { std::ffi::CStr::from_ptr((*pw).pw_dir) };
            dir.to_str().ok().map(|s| s.to_string())
        })?;
        let legacy = Path::new(&home).join(".wicklee").join("config.toml");
        if legacy.exists() { Some(legacy) } else { None }
    }
    #[cfg(not(unix))]
    { None }
}

/// Parent directory of config_path() — the Wicklee system config dir.
/// Used for the metrics DB and any future agent-local state files.
fn wicklee_dir() -> PathBuf {
    config_path()
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf()
}


/// Read the platform hardware identity string — stable across reboots and reinstalls.
///
/// Sources by platform:
///   Linux  — `/etc/machine-id` (systemd) or `/var/lib/dbus/machine-id` (DBus fallback)
///   macOS  — `IOPlatformUUID` via `ioreg -rd1 -c IOPlatformExpertDevice`
///   Windows — `MachineGuid` from `HKLM\SOFTWARE\Microsoft\Cryptography`
///
/// Returns `None` when the platform ID is unavailable (some containers, live ISOs, etc.).
fn hardware_machine_id() -> Option<String> {
    // ── Linux ────────────────────────────────────────────────────────────────
    #[cfg(target_os = "linux")]
    {
        for path in &["/etc/machine-id", "/var/lib/dbus/machine-id"] {
            if let Ok(id) = std::fs::read_to_string(path) {
                let id = id.trim().to_string();
                if id.len() >= 8 {
                    return Some(id);
                }
            }
        }
    }

    // ── macOS ────────────────────────────────────────────────────────────────
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
        {
            let s = String::from_utf8_lossy(&out.stdout);
            for line in s.lines() {
                if line.contains("IOPlatformUUID") {
                    // Line: "IOPlatformUUID" = "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
                    if let Some(end) = line.rfind('"') {
                        let before = &line[..end];
                        if let Some(start) = before.rfind('"') {
                            let uuid = before[start + 1..].to_string();
                            if uuid.len() >= 8 {
                                return Some(uuid);
                            }
                        }
                    }
                }
            }
        }
    }

    // ── Windows ──────────────────────────────────────────────────────────────
    #[cfg(target_os = "windows")]
    {
        if let Ok(out) = std::process::Command::new("reg")
            .args(["query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"])
            .output()
        {
            let s = String::from_utf8_lossy(&out.stdout);
            for line in s.lines() {
                if line.contains("MachineGuid") {
                    if let Some(guid) = line.split_whitespace().last() {
                        if guid.len() >= 8 {
                            return Some(guid.to_string());
                        }
                    }
                }
            }
        }
    }

    None
}

/// Fold an arbitrary hardware ID string into a stable 16-bit suffix for WK-XXXX.
///
/// XOR-accumulation over byte pairs — deterministic, no external crates, no random
/// seed (unlike `std::hash::DefaultHasher` which was randomized in Rust 1.x).
/// Same string always produces the same 4-hex-digit output.
fn fold_to_wk_suffix(s: &str) -> u16 {
    let bytes = s.as_bytes();
    let mut acc: u16 = 0x5A5A; // non-zero seed so empty strings don't collide with each other
    for (i, &b) in bytes.iter().enumerate() {
        if i % 2 == 0 {
            acc ^= (b as u16) << 8;
        } else {
            acc ^= b as u16;
        }
    }
    acc
}

/// Generate a WK-XXXX node identity.
///
/// Priority:
///   1. Hardware platform ID (machine-id / IOPlatformUUID / MachineGuid) — deterministic,
///      survives reinstalls, upgrades, and re-pairings.
///   2. Timestamp fallback — used only when the platform ID is unavailable (containers,
///      live ISOs, some CI environments). Matches the original behaviour.
///
/// `load_or_create_config()` only calls this on first run (no existing config.toml),
/// so all currently-paired nodes keep their existing WK-XXXX unchanged.
fn generate_node_id() -> String {
    if let Some(hw_id) = hardware_machine_id() {
        return format!("WK-{:04X}", fold_to_wk_suffix(&hw_id));
    }
    // Fallback: timestamp-based (original behaviour)
    format!("WK-{:04X}", now_ms() & 0xFFFF)
}

fn load_or_create_config() -> WickleeConfig {
    let path = config_path();

    // ── Load from system-global path ─────────────────────────────────────────
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(cfg) = toml::from_str::<WickleeConfig>(&content) {
                return cfg;
            }
        }
    }

    // ── One-time migration from legacy ~/.wicklee/config.toml (pre-v0.4.37) ──
    // If the system-global path doesn't exist yet but the user's home config
    // does, copy it over so the node_id and fleet pairing are preserved.
    if let Some(legacy) = legacy_config_path() {
        if let Ok(content) = std::fs::read_to_string(&legacy) {
            if let Ok(cfg) = toml::from_str::<WickleeConfig>(&content) {
                println!("  Migrating config from {} → {}", legacy.display(), path.display());
                save_config(&cfg);
                return cfg;
            }
        }
    }

    // ── First-run: generate a new identity ───────────────────────────────────
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

fn generate_code() -> String {
    format!("{:06}", now_ms() % 1_000_000)
}

/// POST { code, node_id, fleet_url } to the cloud backend.
/// Returns the session_token to use for subsequent telemetry pushes.
async fn register_pair_code(node_id: &str, code: &str) -> Option<String> {
    let cloud  = std::env::var("WICKLEE_CLOUD_URL").unwrap_or_else(|_| cloud_push::CLOUD_URL.to_string());
    let fleet  = std::env::var("WICKLEE_FLEET_URL").unwrap_or_else(|_| "http://localhost:7700".to_string());
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(3))
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

// Service and diagnostics functions moved to service.rs and diagnostics.rs
// (validate_binary_path, install_service, uninstall_service → service.rs)
// (run_startup_diagnostics → diagnostics.rs)

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

                // ── GPU clock throttle percentage ─────────────────────────────
                // (cur_graphics_mhz / max_graphics_mhz) → inverse is throttle %.
                // Zero-privilege; returns None on virtualised GPUs where clock
                // info is unavailable (safe — patterns gate on Some(_) density).
                if let (Ok(cur_mhz), Ok(max_mhz)) = (
                    device.clock_info(Clock::Graphics),
                    device.max_clock_info(Clock::Graphics),
                ) {
                    if max_mhz > 0 {
                        let ratio = cur_mhz as f32 / max_mhz as f32;
                        m.clock_throttle_pct = Some(((1.0 - ratio) * 100.0).clamp(0.0, 100.0));
                    }
                }

                // ── PCIe link width ───────────────────────────────────────────
                // current_pcie_link_width() returns the negotiated lane count (1/4/8/16).
                // max_pcie_link_width() returns the maximum the card + slot support.
                // When current < max, the GPU is lane-degraded (wrong slot or failed lane).
                // Zero-privilege; returns NotSupported on virtualised guests.
                if let Ok(cur_w) = device.current_pcie_link_width() {
                    m.pcie_link_width = Some(cur_w);
                }
                if let Ok(max_w) = device.max_pcie_link_width() {
                    m.pcie_link_max_width = Some(max_w);
                }

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

            // 4. Power + thermal via powermetrics (no sudo required when running as root)
            //    Copy all power fields: cpu, gpu, ane, and the combined SoC total.
            //    apple_soc_power_w (= soc_power_w) is the true ~13-20 W system draw
            //    during inference; cpu_power_w alone (~1.7-7 W) under-reports by 2-3×.
            if let Some(pm) = try_powermetrics_nosudo().await {
                m.cpu_power_w  = pm.cpu_power_w;
                m.ecpu_power_w = pm.ecpu_power_w;
                m.pcpu_power_w = pm.pcpu_power_w;
                m.gpu_power_w  = pm.gpu_power_w;  // GPU cluster power (W)
                m.ane_power_w  = pm.ane_power_w;  // Apple Neural Engine power (W)
                m.soc_power_w  = pm.soc_power_w;  // Combined SoC total — prefer this for WES
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
    swap_metrics:          SwapMetrics,
    probe_active:          Arc<std::sync::atomic::AtomicBool>,
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
            let swap_mb_s     = swap_metrics.read();

            // Drain any pending live-activity events (normally empty, non-zero during update).
            let pending_events: Vec<LiveActivityEvent> = live_events
                .lock()
                .map(|mut v| std::mem::take(&mut *v))
                .unwrap_or_default();

            // Compute before struct literal so we can borrow `ollama` without
            // conflicting with the field moves (Option<String> fields are not Copy).
            let ollama_is_probing_flag = if ollama.is_probing_display() { Some(true) } else { None };
            let hw = read_hardware_signals(&apple, &nvidia, &ollama, &vllm, &probe_active);
            let inference_state_val = compute_inference_state(&hw).to_string();

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
                apple_gpu_power_w:       apple.gpu_power_w,
                apple_soc_power_w:       apple.soc_power_w,
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
                ollama_inference_active:  ollama.ollama_inference_active,
                ollama_proxy_active:      if ollama.ollama_proxy_active { Some(true) } else { None },
                ollama_is_probing:        ollama_is_probing_flag,
                ollama_quantization:      ollama.ollama_quantization,
                ollama_tokens_per_second: ollama.ollama_tokens_per_second,
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
                swap_write_mb_s: swap_mb_s,
                clock_throttle_pct: nvidia.clock_throttle_pct.or_else(|| {
                    linux_thermal.as_ref()
                        .and_then(|lt| lt.clock_ratio)
                        .map(|r| ((1.0 - r) * 100.0).clamp(0.0, 100.0) as f32)
                }),
                pcie_link_width:     nvidia.pcie_link_width,
                pcie_link_max_width: nvidia.pcie_link_max_width,
                agent_version:       env!("CARGO_PKG_VERSION").to_string(),
                inference_state:     inference_state_val,
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

// ── /api/history ─────────────────────────────────────────────────────────────
// Returns historical metric samples from the local DuckDB store.
//
// Query parameters:
//   node_id    — required; the node to query
//   from       — Unix ms; default = now - 1h
//   to         — Unix ms; default = now
//   resolution — "raw" | "1min" | "1hr" | "auto" (default)
//
// Resolution "auto" picks the best tier for the window width:
//   < 2h  → raw (1-Hz samples)
//   < 7d  → 1-minute aggregates
//   else  → 1-hour aggregates
//
// Not available on musl targets (DuckDB bundled C++ unsupported there).

#[cfg(not(target_env = "musl"))]
#[derive(serde::Deserialize)]
struct HistoryQuery {
    node_id:    Option<String>,
    from:       Option<i64>,
    to:         Option<i64>,
    resolution: Option<String>,
}

#[cfg(not(target_env = "musl"))]
async fn handle_history(
    axum::extract::Query(q): axum::extract::Query<HistoryQuery>,
    axum::extract::Extension(store): axum::extract::Extension<store::Store>,
) -> impl IntoResponse {
    use axum::http::StatusCode;

    let node_id = match q.node_id {
        Some(n) if !n.is_empty() => n,
        _ => return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "node_id query parameter is required" })),
        ).into_response(),
    };

    let now    = now_ms() as i64;
    let from   = q.from.unwrap_or(now - 3_600_000);  // default: last hour
    let to     = q.to.unwrap_or(now);

    // Parse resolution; "auto" and unknown strings both fall back to auto.
    let res = q.resolution
        .as_deref()
        .filter(|s| *s != "auto")
        .and_then(|s| s.parse::<store::Resolution>().ok())
        .unwrap_or_else(|| store::Resolution::auto(from, to));

    match tokio::task::spawn_blocking(move || store.query_history(&node_id, from, to, res)).await {
        Ok(Ok(resp))  => Json(resp).into_response(),
        Ok(Err(e))    => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        ).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        ).into_response(),
    }
}

// ── Insight dismiss endpoints ─────────────────────────────────────────────────
//
// POST /api/insights/dismiss  — persist a dismiss decision for a pattern.
// GET  /api/insights/dismissed — return all active (non-expired) dismissals.
//
// Both are gated on `#[cfg(not(target_env = "musl"))]` because they require
// the DuckDB store.  musl builds (e.g., ARM Linux static) use localStorage-
// only dismissals and never call these endpoints.

#[cfg(not(target_env = "musl"))]
#[derive(serde::Deserialize)]
struct DismissRequest {
    /// Pattern identifier, e.g. "bandwidth_saturation".
    pattern_id:    String,
    /// Node-scoped dismissal. Pass null/omit for fleet-wide suppression.
    node_id:       Option<String>,
    /// Epoch ms at which this dismissal expires.  Default: now + 24 h.
    expires_at_ms: Option<i64>,
    /// Optional operator note ("resolved by restarting ollama", etc.)
    note:          Option<String>,
}

#[cfg(not(target_env = "musl"))]
async fn handle_dismiss(
    axum::extract::Extension(store): axum::extract::Extension<store::Store>,
    axum::extract::Json(body): axum::extract::Json<DismissRequest>,
) -> impl IntoResponse {
    use axum::http::StatusCode;

    if body.pattern_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "pattern_id is required" })),
        ).into_response();
    }

    let now_ms       = now_ms() as i64;
    let expires_at   = body.expires_at_ms.unwrap_or(now_ms + 24 * 60 * 60 * 1_000);
    let node_id      = body.node_id.unwrap_or_default();
    let pattern_id   = body.pattern_id;
    let note         = body.note;

    match tokio::task::spawn_blocking(move || {
        store.record_dismiss(
            &pattern_id,
            &node_id,
            now_ms,
            expires_at,
            note.as_deref(),
        )
    }).await {
        Ok(Ok(())) => (
            StatusCode::ACCEPTED,
            Json(serde_json::json!({ "ok": true, "expires_at_ms": expires_at })),
        ).into_response(),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        ).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        ).into_response(),
    }
}

#[cfg(not(target_env = "musl"))]
async fn handle_dismissed_list(
    axum::extract::Extension(store): axum::extract::Extension<store::Store>,
) -> impl IntoResponse {
    use axum::http::StatusCode;

    let now_ms = now_ms() as i64;

    match tokio::task::spawn_blocking(move || store.query_active_dismissals(now_ms)).await {
        Ok(Ok(dismissals)) => Json(serde_json::json!({ "dismissals": dismissals })).into_response(),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        ).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        ).into_response(),
    }
}

/// Returns the last 20 lifecycle events from the recent_events_log ring buffer,
/// filtered to those within the last 5 minutes. Used by the frontend to seed
/// the Live Activity feed on every fresh WS connect — catches the startup event
/// and any lifecycle activity that fired before the browser was opened.
async fn handle_events_recent(
    axum::extract::Extension(log): axum::extract::Extension<
        Arc<Mutex<std::collections::VecDeque<LiveActivityEvent>>>
    >,
) -> axum::Json<Vec<LiveActivityEvent>> {
    let cutoff = now_ms().saturating_sub(5 * 60 * 1_000); // 5-minute window
    let events: Vec<LiveActivityEvent> = log.lock().unwrap()
        .iter()
        .filter(|e| e.timestamp_ms >= cutoff)
        .cloned()
        .collect();
    axum::Json(events)
}

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
    axum::extract::Extension(swap_metrics):          axum::extract::Extension<SwapMetrics>,
    axum::extract::Extension(probe_active):          axum::extract::Extension<Arc<std::sync::atomic::AtomicBool>>,
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
            let swap_mb_s     = swap_metrics.read();
            let ollama_is_probing_flag = if ollama.is_probing_display() { Some(true) } else { None };
            let hw = read_hardware_signals(&apple, &nvidia, &ollama, &vllm, &probe_active);
            let inference_state_val = compute_inference_state(&hw).to_string();

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
                apple_gpu_power_w:       apple.gpu_power_w,
                apple_soc_power_w:       apple.soc_power_w,
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
                ollama_inference_active:  ollama.ollama_inference_active,
                ollama_proxy_active:      if ollama.ollama_proxy_active { Some(true) } else { None },
                ollama_is_probing:        ollama_is_probing_flag,
                ollama_quantization:      ollama.ollama_quantization,
                ollama_tokens_per_second: ollama.ollama_tokens_per_second,
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
                swap_write_mb_s: swap_mb_s,
                clock_throttle_pct: nvidia.clock_throttle_pct.or_else(|| {
                    linux_thermal.as_ref()
                        .and_then(|lt| lt.clock_ratio)
                        .map(|r| ((1.0 - r) * 100.0).clamp(0.0, 100.0) as f32)
                }),
                pcie_link_width:     nvidia.pcie_link_width,
                pcie_link_max_width: nvidia.pcie_link_max_width,
                agent_version:       env!("CARGO_PKG_VERSION").to_string(),
                inference_state:     inference_state_val,
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
    pairing_state:     Arc<Mutex<PairingState>>,
    live_events:       Arc<Mutex<Vec<LiveActivityEvent>>>,
    recent_events_log: Arc<Mutex<std::collections::VecDeque<LiveActivityEvent>>>,
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
        .connect_timeout(Duration::from_secs(3))
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
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            eprintln!("[update] binary is root-owned — re-run install to fix:");
            eprintln!("[update]   sudo curl -fsSL https://wicklee.dev/install.sh | bash");
        }
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
    // Also push to recent_events_log so late-joining browsers see the update event.
    {
        let event = LiveActivityEvent {
            message:      msg.clone(),
            timestamp_ms: now_ms(),
            level:        "info",
        };
        live_events.lock().unwrap().push(event.clone());
        let mut log = recent_events_log.lock().unwrap();
        log.push_back(event);
        if log.len() > 20 { log.pop_front(); }
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
    // Print version on every invocation — CLI tools, daemon startup, and sudo
    // install/uninstall all benefit from an immediate "which build is this?"
    // confirmation without having to run --version separately.
    println!("wicklee-agent v{}", env!("CARGO_PKG_VERSION"));

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
        return; // version already printed above
    }

    if std::env::args().any(|a| a == "--install-service") {
        service::install_service().await;
        return;
    }

    if std::env::args().any(|a| a == "--uninstall-service") {
        service::uninstall_service().await;
        return;
    }

    // ── --status: query the running agent rather than trying to bind 7700 ──────
    if std::env::args().any(|a| a == "--status") {
        let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(7700);
        let url = format!("http://127.0.0.1:{port}/api/pair/status");
        let sep       = "╠══════════════════════════════════════════════╣";
        let top       = "╔══════════════════════════════════════════════╗";
        let bot       = "╚══════════════════════════════════════════════╝";
        let blank_row = "║                                              ║";
        let row = |key: &str, val: &str| -> String {
            let inner = format!("   {:<7}{}", key, val);
            let capped = if inner.chars().count() <= 46 { format!("{:<46}", inner) }
                         else { inner.chars().take(43).collect::<String>() + "..." };
            format!("║{}║", capped)
        };
        match reqwest::get(&url).await {
            Ok(resp) if resp.status().is_success() => {
                #[derive(serde::Deserialize)]
                struct StatusResp { status: String, node_id: String }
                if let Ok(s) = resp.json::<StatusResp>().await {
                    println!("{top}");
                    println!("{blank_row}");
                    println!("{}", row("", &format!("Wicklee Sentinel  ·  v{}", env!("CARGO_PKG_VERSION"))));
                    println!("{}", row("", &format!("http://localhost:{port}")));
                    println!("{blank_row}");
                    println!("{sep}");
                    println!("{}", row("Node", &s.node_id));
                    println!("{}", row("Pairing", &s.status));
                    println!("{sep}");
                    // Show runtime ports from process discovery + config override
                    let cfg_ref = &config;
                    let discovered = process_discovery::scan_runtimes();
                    let rp = cfg_ref.runtime_ports.as_ref();
                    // Ollama
                    let ollama_cfg = rp.and_then(|r| r.ollama);
                    let ollama_port = ollama_cfg.or_else(|| discovered.get("ollama").copied());
                    if let Some(p) = ollama_port {
                        let tag = if ollama_cfg.is_some() { " (config)" } else { "" };
                        println!("{}", row("Ollama", &format!(":{p}{tag} · detected")));
                    } else {
                        println!("{}", row("Ollama", "not running"));
                    }
                    // vLLM
                    let vllm_cfg = rp.and_then(|r| r.vllm);
                    let vllm_port = vllm_cfg.or_else(|| discovered.get("vllm").copied());
                    if let Some(p) = vllm_port {
                        let tag = if vllm_cfg.is_some() { " (config)" } else { "" };
                        println!("{}", row("vLLM", &format!(":{p}{tag} · detected")));
                    } else {
                        println!("{}", row("vLLM", "not running"));
                    }
                    println!("{bot}");
                }
            }
            _ => {
                eprintln!("wicklee agent is not running on port {port}.");
                eprintln!("Start it with: wicklee  (or: sudo systemctl start wicklee)");
                std::process::exit(1);
            }
        }
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
                    ollama_proxy: config.ollama_proxy.clone(),
                    runtime_ports: config.runtime_ports.clone(),
                });
            }
            None => eprintln!("[warn] Could not register code with cloud backend. Check your internet connection."),
        }
        print_pairing_box(&config.node_id, &code);
    }

    // Run diagnostics first so the output appears before the banner
    diagnostics::run_startup_diagnostics(&config.node_id, if pair_on_start { "pending" } else { initial_status }, port, &config).await;

    // ── Privilege warning (macOS only) ────────────────────────────────────────
    // powermetrics requires root to expose the SoC, GPU, and ANE power rails.
    // Without them the HardwareSignals bundle is blind: soc_power_w and
    // ane_power_w are always None → Tier 3 inference detection never fires.
    // Log this prominently so the issue is immediately diagnosable from
    // /var/log/wicklee.log without needing a full stack trace.
    #[cfg(target_os = "macos")]
    if unsafe { libc::getuid() } != 0 {
        eprintln!("[warn] ╔══════════════════════════════════════════════════════════════╗");
        eprintln!("[warn] ║  RESTRICTED HARDWARE ACCESS — agent is NOT running as root   ║");
        eprintln!("[warn] ╠══════════════════════════════════════════════════════════════╣");
        eprintln!("[warn] ║  macOS restricts powermetrics output for non-root processes. ║");
        eprintln!("[warn] ║  SoC power · GPU power · ANE power  →  all unavailable.     ║");
        eprintln!("[warn] ║  Tier 3 inference detection (physics gate) is DISABLED.     ║");
        eprintln!("[warn] ║                                                              ║");
        eprintln!("[warn] ║  Fix:  sudo wicklee --install-service                       ║");
        eprintln!("[warn] ╚══════════════════════════════════════════════════════════════╝");
    }

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
                    .route("/api/generate", axum::routing::post(proxy::proxy_ollama_streaming))
                    .route("/api/chat",     axum::routing::post(proxy::proxy_ollama_streaming))
                    .fallback(proxy::proxy_passthrough)
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
    let ollama_cfg = rp.and_then(|r| r.ollama);
    let vllm_cfg   = rp.and_then(|r| r.vllm);
    let ollama_port = ollama_cfg.or_else(|| initial.get("ollama").copied());
    let vllm_port   = vllm_cfg  .or_else(|| initial.get("vllm").copied());
    if let Some(p) = ollama_port { let _ = ollama_port_tx.send(Some(p)); }
    if let Some(p) = vllm_port   { let _ = vllm_port_tx.send(Some(p)); }

    // Start the background discovery loop (30 s interval).
    // Runtimes with a TOML config override are excluded from the loop —
    // the override is authoritative and must never be overwritten by
    // auto-discovery (Priority of Truth: TOML > cmdline > socket scan).
    let mut discovery_txs: std::collections::HashMap<&str, _> = Default::default();
    if ollama_cfg.is_none() { discovery_txs.insert("ollama", ollama_port_tx); }
    if vllm_cfg.is_none()   { discovery_txs.insert("vllm",   vllm_port_tx);   }
    process_discovery::start_discovery_loop(discovery_txs, 30);

    let apple_metrics         = start_metrics_harvester();
    let nvidia_metrics        = start_nvidia_harvester();
    let (ollama_metrics, probe_active) = harvester::start_ollama_harvester(
        Arc::clone(&apple_metrics),
        Arc::clone(&nvidia_metrics),
        proxy_arc,
        ollama_port_rx,
    );
    let rapl_metrics          = start_rapl_harvester();
    let linux_thermal_metrics = start_linux_thermal_harvester();
    let vllm_metrics          = harvester::start_vllm_harvester(vllm_port_rx, Arc::clone(&apple_metrics), Arc::clone(&nvidia_metrics));

    // WES v2 — 2 s thermal-penalty sampler (30-sample rolling window).
    // Must start after the platform harvesters above so it has data to read.
    let wes_metrics = start_wes_sampler(
        Arc::clone(&apple_metrics),
        Arc::clone(&nvidia_metrics),
        Arc::clone(&linux_thermal_metrics),
    );

    let swap_metrics = start_swap_harvester();

    // Shared event queue for drain-on-send live activity entries (update notifications etc.).
    let live_events: Arc<Mutex<Vec<LiveActivityEvent>>> = Arc::new(Mutex::new(Vec::new()));

    // Ring buffer of the last 20 lifecycle events for late-joining browsers.
    // Populated alongside live_events but never drained — persists for 5 minutes.
    // Exposed via GET /api/events/recent so browsers that open after agent startup
    // can still see the startup event and any recent lifecycle activity.
    let recent_events_log: Arc<Mutex<std::collections::VecDeque<LiveActivityEvent>>> =
        Arc::new(Mutex::new(std::collections::VecDeque::with_capacity(20)));

    // Emit a startup event so the Live Activity feed is immediately populated.
    {
        let event = LiveActivityEvent {
            message:      format!("Agent started · v{}", env!("CARGO_PKG_VERSION")),
            timestamp_ms: now_ms(),
            level:        "info",
        };
        live_events.lock().unwrap().push(event.clone());
        let mut log = recent_events_log.lock().unwrap();
        log.push_back(event);
        if log.len() > 20 { log.pop_front(); }
    }

    let broadcast_tx          = start_metrics_broadcaster(
        Arc::clone(&apple_metrics),
        Arc::clone(&nvidia_metrics),
        Arc::clone(&ollama_metrics),
        Arc::clone(&rapl_metrics),
        Arc::clone(&linux_thermal_metrics),
        Arc::clone(&vllm_metrics),
        Arc::clone(&live_events),
        Arc::clone(&wes_metrics),
        swap_metrics.clone(),
        Arc::clone(&probe_active),
    );

    // Start cloud telemetry push loop (2 s cadence, gated on session_token).
    cloud_push::start_cloud_push(Arc::clone(&pairing_state), broadcast_tx.clone());

    // ── Local metrics store (DuckDB) ──────────────────────────────────────────
    // Opens ~/.wicklee/metrics.db and subscribes to the broadcast channel.
    // Not available on musl targets — store module and handler compile out.
    #[cfg(not(target_env = "musl"))]
    let metrics_store: Option<store::Store> = {
        let db_path = wicklee_dir().join("metrics.db");
        if let Some(dir) = db_path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        match store::Store::open(&db_path) {
            Ok(s) => {
                println!("[store] metrics db: {}", db_path.display());

                // Writer task — subscribes to broadcast, writes 1 sample/s to metrics_raw.
                // Holding the Mutex < 1 ms per write; lagged frames are silently skipped.
                {
                    let s2  = s.clone();
                    let mut rx = broadcast_tx.subscribe();
                    tokio::spawn(async move {
                        loop {
                            match rx.recv().await {
                                Ok(json) => {
                                    match store::Sample::from_broadcast_json(&json) {
                                        Ok(sample) => {
                                            if let Err(e) = s2.write_sample(sample) {
                                                eprintln!("[store] write error: {e}");
                                            }
                                        }
                                        Err(e) => eprintln!("[store] parse error: {e}"),
                                    }
                                }
                                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                                Err(tokio::sync::broadcast::error::RecvError::Closed)    => break,
                            }
                        }
                    });
                }

                // Aggregation loop — runs at startup (after 10 s) and every hour thereafter.
                // Dispatched via spawn_blocking so a slow aggregation never stalls the executor.
                {
                    let s2 = s.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(10)).await;
                        let sc = s2.clone();
                        let _ = tokio::task::spawn_blocking(move || {
                            if let Err(e) = sc.run_aggregation(now_ms() as i64) {
                                eprintln!("[store] initial aggregation error: {e}");
                            }
                        }).await;

                        let mut tick = tokio::time::interval(Duration::from_secs(3_600));
                        loop {
                            tick.tick().await;
                            let sc = s2.clone();
                            let _ = tokio::task::spawn_blocking(move || {
                                if let Err(e) = sc.run_aggregation(now_ms() as i64) {
                                    eprintln!("[store] aggregation error: {e}");
                                }
                            }).await;
                        }
                    });
                }

                Some(s)
            }
            Err(e) => {
                eprintln!("[store] failed to open metrics db at {}: {e}", db_path.display());
                eprintln!("[store] history API will return 503 until the db is accessible");
                None
            }
        }
    };
    // On musl targets the store is simply absent.
    #[cfg(target_env = "musl")]
    let metrics_store: Option<()> = None;

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Build the router.  The /api/history route and its Extension are only
    // compiled in on non-musl targets where DuckDB is available.
    let app = {
        let r = Router::new()
            .route("/api/tags",           get(handle_tags))
            .route("/api/events/recent",  get(handle_events_recent))
            .route("/api/metrics",        get(handle_metrics))       // SSE fallback (1 Hz)
            .route("/ws",                 get(handle_ws))             // WebSocket primary (10 Hz)
            .route("/api/pair/status",    get(handle_pair_status))
            .route("/api/pair/generate",  post(handle_pair_generate))
            .route("/api/pair/claim",     post(handle_pair_claim))
            .route("/api/pair/disconnect",post(handle_pair_disconnect));

        // Wire store-backed routes only when DuckDB opened successfully.
        // Includes: /api/history, /api/insights/dismiss (POST), /api/insights/dismissed (GET).
        #[cfg(not(target_env = "musl"))]
        let r = if let Some(ref st) = metrics_store {
            r.route("/api/history",             get(handle_history))
             .route("/api/insights/dismiss",    post(handle_dismiss))
             .route("/api/insights/dismissed",  get(handle_dismissed_list))
             .layer(axum::extract::Extension(st.clone()))
        } else {
            r
        };

        r.fallback(static_handler)
         .layer(axum::extract::Extension(Arc::clone(&pairing_state)))
         .layer(axum::extract::Extension(apple_metrics))
         .layer(axum::extract::Extension(nvidia_metrics))
         .layer(axum::extract::Extension(ollama_metrics))
         .layer(axum::extract::Extension(rapl_metrics))
         .layer(axum::extract::Extension(linux_thermal_metrics))
         .layer(axum::extract::Extension(vllm_metrics))
         .layer(axum::extract::Extension(wes_metrics))
         .layer(axum::extract::Extension(swap_metrics))
         .layer(axum::extract::Extension(Arc::clone(&recent_events_log)))
         .layer(axum::extract::Extension(broadcast_tx))
         .layer(axum::extract::Extension(probe_active))
         .layer(cors)
    };
    // Suppress unused-variable warning on musl where metrics_store = None:()
    let _ = &metrics_store;

    // ── Port binding with Ghost-Killer ───────────────────────────────────────
    // On AddrInUse we check whether the incumbent is an old wicklee process.
    // If so, we evict it (SIGTERM → SIGKILL) and retry once. This makes
    // `curl | sh` upgrades seamless — no manual "stop the old agent" step.
    let mut eviction_attempted = false;
    let listener = loop {
        match tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await {
            Ok(l) => break l,
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                #[cfg(not(target_os = "windows"))]
                if !eviction_attempted {
                    eviction_attempted = true;
                    if try_evict_port(port).await {
                        println!("  ✓ Previous instance evicted. Starting on :{port}…");
                        continue; // retry bind
                    }
                }
                // Not a wicklee process, eviction failed, or Windows.
                if pair_on_start {
                    println!();
                    println!("  Agent is running on :{port} — pairing code registered.");
                    println!("  Restart the service to activate:  sudo systemctl restart wicklee");
                } else {
                    eprintln!("Failed to bind port {port}: address already in use.");
                    eprintln!("Run: sudo pkill -x wicklee  then retry.");
                }
                return;
            }
            Err(e) => panic!("Failed to bind port {port}: {e}"),
        }
    };

    // ── Self-update check ─────────────────────────────────────────────────────
    // Runs once after the server is bound. Spawned so axum::serve is not delayed.
    // Sovereign Mode agents (unpaired) skip this entirely inside the function.
    {
        let pairing_state     = Arc::clone(&pairing_state);
        let live_events       = Arc::clone(&live_events);
        let recent_events_log = Arc::clone(&recent_events_log);
        tokio::spawn(async move {
            // Brief startup delay — lets the server stabilise and write its
            // first few metrics frames before we do any network I/O.
            tokio::time::sleep(Duration::from_secs(5)).await;
            check_and_apply_update(pairing_state, live_events, recent_events_log).await;
        });
    }

    // ── Graceful shutdown ──────────────────────────────────────────────────────
    // Catches SIGTERM (launchd/systemd stop) and Ctrl-C (interactive).
    // Allows in-flight HTTP responses and WebSocket frames to flush,
    // and lets DuckDB's Drop impl cleanly close the WAL.
    let shutdown = async {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let mut sigterm = signal(SignalKind::terminate())
                .expect("failed to register SIGTERM handler");
            tokio::select! {
                _ = tokio::signal::ctrl_c() => eprintln!("[agent] received SIGINT — shutting down"),
                _ = sigterm.recv()          => eprintln!("[agent] received SIGTERM — shutting down"),
            }
        }
        #[cfg(not(unix))]
        {
            tokio::signal::ctrl_c().await.ok();
            eprintln!("[agent] received Ctrl-C — shutting down");
        }
    };

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await
        .expect("Server exited unexpectedly");

    eprintln!("[agent] clean shutdown complete");
}

