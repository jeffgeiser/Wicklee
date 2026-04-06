#![recursion_limit = "256"]

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

// ── MCP (Model Context Protocol) JSON-RPC 2.0 Types ─────────────────────────
// Lightweight MCP server — wraps existing agent endpoints for AI agent consumption.
// No additional crate dependencies; just serde_json over Axum.

#[derive(Deserialize)]
struct JsonRpcRequest {
    #[allow(dead_code)]
    jsonrpc: String,
    method: String,
    params: Option<serde_json::Value>,
    /// JSON-RPC notifications omit `id`. Default to Null so they deserialize.
    #[serde(default)]
    id: serde_json::Value,
}

#[derive(Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
    id: serde_json::Value,
}

#[derive(Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

impl JsonRpcResponse {
    fn success(id: serde_json::Value, result: serde_json::Value) -> Self {
        Self { jsonrpc: "2.0", result: Some(result), error: None, id }
    }
    fn error(id: serde_json::Value, code: i32, message: String) -> Self {
        Self { jsonrpc: "2.0", result: None, error: Some(JsonRpcError { code, message }), id }
    }
}

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
    /// Prefill speed from probe: prompt_eval_count / prompt_eval_duration (tok/s).
    pub(crate) ollama_prompt_eval_tps: Option<f32>,
    /// Cold TTFT from probe: prompt_eval_duration in milliseconds.
    pub(crate) ollama_ttft_ms: Option<f32>,
    /// Model load duration from probe (ms). 0 = warm, >0 = cold start.
    pub(crate) ollama_load_duration_ms: Option<f32>,
    /// True when a request completed within the last 35s (one probe interval).
    /// Derived from expires_at resets observed in /api/ps polls.
    /// None = not yet determined (no expires_at change seen since agent start).
    pub(crate) ollama_inference_active: Option<bool>,
    /// True when the transparent proxy is active on :11434.
    /// When true, tok/s comes from done-packet eval_count/eval_duration rather than the 30s probe.
    #[serde(default)]
    pub(crate) ollama_proxy_active: bool,
    /// Live TTFT from proxy done packets (rolling average, ms). Null when proxy inactive.
    pub(crate) ollama_proxy_avg_ttft_ms: Option<f32>,
    /// Live E2E latency from proxy done packets (rolling average, ms). Null when proxy inactive.
    pub(crate) ollama_proxy_avg_latency_ms: Option<f32>,
    /// Total requests proxied since agent start.
    pub(crate) ollama_proxy_request_count: Option<u64>,
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
    /// API-validated port set by the main harvester after health-checking.
    /// The probe task reads this instead of port_rx to avoid hitting worker sockets
    /// that don't serve the Ollama HTTP API (e.g. ollama_llama_server on :34111).
    #[serde(skip)]
    pub(crate) validated_port: Option<u16>,
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
    // Phase 1: queue/saturation gauges
    pub(crate) vllm_requests_waiting:     Option<u32>,
    pub(crate) vllm_requests_swapped:     Option<u32>,
    // Phase 3: windowed histogram averages (computed from _sum/_count deltas)
    pub(crate) vllm_avg_ttft_ms:              Option<f32>,
    pub(crate) vllm_avg_e2e_latency_ms:       Option<f32>,
    pub(crate) vllm_avg_queue_time_ms:        Option<f32>,
    pub(crate) vllm_prompt_tokens_total:      Option<u64>,
    pub(crate) vllm_generation_tokens_total:  Option<u64>,
    /// Set when the 30s idle probe completes. Used for IDLE-SPD display state.
    #[serde(skip)]
    pub(crate) last_probe_end: Option<std::time::Instant>,
    // Histogram delta tracking (not serialized — internal state for windowed averages)
    #[serde(skip)]
    pub(crate) prev_ttft_sum:        Option<f64>,
    #[serde(skip)]
    pub(crate) prev_ttft_count:      Option<u64>,
    #[serde(skip)]
    pub(crate) prev_e2e_sum:         Option<f64>,
    #[serde(skip)]
    pub(crate) prev_e2e_count:       Option<u64>,
    #[serde(skip)]
    pub(crate) prev_queue_time_sum:  Option<f64>,
    #[serde(skip)]
    pub(crate) prev_queue_time_count: Option<u64>,
}

impl VllmMetrics {
    /// True for 30 s after the probe completes — mirrors OllamaMetrics::recent_probe_baseline().
    pub(crate) fn recent_probe_baseline(&self) -> bool {
        self.last_probe_end.map_or(false, |t| t.elapsed().as_secs() < 30)
    }
}

// llama.cpp / llama-box runtime metrics — populated when llama-server is detected.
// All fields are Option/bool-default so the payload serialises cleanly when absent.
#[derive(Serialize, Clone, Default)]
pub(crate) struct LlamacppMetrics {
    pub(crate) llamacpp_running:          bool,
    pub(crate) llamacpp_model_name:       Option<String>,
    pub(crate) llamacpp_tokens_per_sec:   Option<f32>,
    pub(crate) llamacpp_slots_processing: Option<u32>,
    /// Set when the 30s idle probe completes. Used for IDLE-SPD display state.
    #[serde(skip)]
    pub(crate) last_probe_end: Option<std::time::Instant>,
}

impl LlamacppMetrics {
    /// True for 30 s after the probe completes — mirrors OllamaMetrics::recent_probe_baseline().
    pub(crate) fn recent_probe_baseline(&self) -> bool {
        self.last_probe_end.map_or(false, |t| t.elapsed().as_secs() < 30)
    }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    ollama_prompt_eval_tps: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ollama_ttft_ms: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ollama_load_duration_ms: Option<f32>,
    /// True when a request completed within the last 35s. Derived from /api/ps expires_at resets.
    #[serde(skip_serializing_if = "Option::is_none")]
    ollama_inference_active: Option<bool>,
    /// True when the Wicklee transparent proxy is active on :11434.
    /// Frontend uses this to label tok/s as "live" (not "live estimate").
    #[serde(skip_serializing_if = "Option::is_none")]
    ollama_proxy_active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ollama_proxy_avg_ttft_ms: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ollama_proxy_avg_latency_ms: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ollama_proxy_request_count: Option<u64>,
    /// Port the proxy listens on (e.g. 11434). None when proxy is disabled.
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy_listen_port: Option<u16>,
    /// Port the proxy forwards to (the real Ollama port, e.g. 11435). None when proxy is disabled.
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy_target_port: Option<u16>,
    /// Comma-separated runtime names with [runtime_ports] config overrides (e.g. "vllm" or "ollama,vllm").
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_port_overrides: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    vllm_requests_waiting: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vllm_requests_swapped: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vllm_avg_ttft_ms: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vllm_avg_e2e_latency_ms: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vllm_avg_queue_time_ms: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vllm_prompt_tokens_total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vllm_generation_tokens_total: Option<u64>,
    // llama.cpp / llama-box runtime (null/false when not running)
    #[serde(default)]
    llamacpp_running:          bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    llamacpp_model_name:       Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    llamacpp_tokens_per_sec:   Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    llamacpp_slots_processing: Option<u32>,
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
    /// Per-model baseline tok/s from 7-day DuckDB history at Normal thermal state.
    /// Populated on model change, cached until model changes again. None when
    /// insufficient history (< 100 Normal-thermal samples) or musl builds.
    #[serde(skip_serializing_if = "Option::is_none")]
    model_baseline_tps: Option<f32>,
    /// Per-model baseline WES computed from historical median tok/s and watts.
    #[serde(skip_serializing_if = "Option::is_none")]
    model_baseline_wes: Option<f32>,
    /// Number of Normal-thermal samples used to compute the baseline.
    #[serde(skip_serializing_if = "Option::is_none")]
    model_baseline_samples: Option<u32>,
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
    /// Network bind address. Default "127.0.0.1" (localhost only).
    /// Set to "0.0.0.0" to accept LAN connections (proxy mode, remote dashboard).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) bind_address: Option<String>,
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
#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct LiveActivityEvent {
    pub(crate) message:      String,
    pub(crate) timestamp_ms: u64,
    /// Frontend style hint: "info" | "warn" | "error"
    pub(crate) level:        &'static str,
    /// Structured event category for filtering/querying in DuckDB.
    /// Values: "startup", "update", "model_swap", "thermal_change", "error"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) event_type:   Option<&'static str>,
}

/// Centralised event emitter: pushes to both in-memory queues (for live WS
/// broadcast and late-joining browsers) AND persists to DuckDB when available.
/// Every call site that creates a `LiveActivityEvent` should use this function
/// instead of manually pushing to `live_events` + `recent_events_log`.
#[allow(unused_variables)]              // `store` + `node_id` unused on musl
fn push_event(
    live_events:       &Mutex<Vec<LiveActivityEvent>>,
    recent_events_log: &Mutex<std::collections::VecDeque<LiveActivityEvent>>,
    #[cfg(not(target_env = "musl"))]
    store:             &Option<store::Store>,
    node_id:           &str,
    event:             LiveActivityEvent,
) {
    live_events.lock().unwrap().push(event.clone());
    {
        let mut log = recent_events_log.lock().unwrap();
        log.push_back(event.clone());
        if log.len() > 20 { log.pop_front(); }
    }
    #[cfg(not(target_env = "musl"))]
    if let Some(s) = store {
        s.write_event(
            event.timestamp_ms as i64,
            node_id,
            event.level,
            event.event_type,
            &event.message,
        );
    }
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

/// Windows thermal via WMI — queries MSAcpi_ThermalZoneTemperature.
/// Temperature is in tenths of Kelvin; convert to Celsius for state mapping.
/// Annotated as "estimated" in UI (thermal_source: "wmi").
#[cfg(target_os = "windows")]
fn read_thermal_sysctl() -> Option<String> {
    // Use wmic to query thermal zone temperature.
    let output = std::process::Command::new("wmic")
        .args([
            "/namespace:\\\\root\\wmi",
            "path", "MSAcpi_ThermalZoneTemperature",
            "get", "CurrentTemperature",
            "/format:value",
        ])
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Parse "CurrentTemperature=NNNNN" — value is tenths of Kelvin.
    let temp_dk: f64 = stdout.lines()
        .filter_map(|line| {
            let line = line.trim();
            line.strip_prefix("CurrentTemperature=")
                .and_then(|v| v.trim().parse::<f64>().ok())
        })
        .max_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))?;

    let temp_c = (temp_dk / 10.0) - 273.15;
    let state = match temp_c {
        t if t < 70.0 => "Normal",
        t if t < 80.0 => "Fair",
        t if t < 90.0 => "Serious",
        _              => "Critical",
    };
    Some(state.to_string())
}

/// GPU wired memory limit via `sysctl iogpu.wired_limit_mb` — Apple Silicon only.
///
/// macOS enforces a per-process GPU wired memory budget that is independent of
/// total RAM. On M-series chips this is typically ~75% of physical memory.
/// The sysctl exists only on Apple Silicon; returns None on Intel / non-macOS.
/// No sudo required.
///
/// M4 chips use dynamic wired memory management (`iogpu.dynamic_lwm: 1`) and
/// report `wired_limit_mb: 0`. When this happens, fall back to 75% of total
/// physical RAM as the estimated GPU budget — matching Apple's documented
/// unified memory allocation ratio.
#[cfg(target_os = "macos")]
fn read_iogpu_wired_limit_mb() -> Option<u64> {
    use sysctl::Sysctl;
    let ctl = sysctl::Ctl::new("iogpu.wired_limit_mb").ok()?;
    let s = ctl.value_string().ok()?;
    let val = s.trim().parse::<u64>().ok()?;
    if val > 0 {
        return Some(val);
    }
    // M4 dynamic wired memory: wired_limit_mb == 0 means no static cap.
    // Estimate 75% of physical RAM as the effective GPU budget.
    let memsize_ctl = sysctl::Ctl::new("hw.memsize").ok()?;
    let memsize_str = memsize_ctl.value_string().ok()?;
    let total_bytes = memsize_str.trim().parse::<u64>().ok()?;
    Some(total_bytes * 3 / 4 / 1024 / 1024) // 75% of total, in MB
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
        // No temperature sensor: low clock ratio is likely demand-based frequency
        // scaling (idle CPU), not thermal throttling. Cap at "Fair" since we can't
        // confirm actual thermal stress without a temp reading.
        None if penalty > 1.25 => ("Fair", 1.25_f32),
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
/// Read Intel coretemp max temperature (millidegrees → °C).
/// Scans all temp*_input entries and returns the highest.
fn read_coretemp_max_c(hwmon: &std::path::Path) -> Option<f64> {
    let mut max_c: Option<f64> = None;
    for entry in std::fs::read_dir(hwmon).ok()?.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with("temp") && name_str.ends_with("_input") {
            if let Ok(raw) = std::fs::read_to_string(entry.path()) {
                if let Ok(mc) = raw.trim().parse::<i64>() {
                    let c = mc as f64 / 1000.0;
                    max_c = Some(max_c.map_or(c, |p: f64| p.max(c)));
                }
            }
        }
    }
    max_c
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

    // ── Intel path: coretemp hwmon + clock ratio ─────────────────────────────
    // coretemp provides direct per-core temperature readings on Intel CPUs.
    // Combined with clock ratio for thermal state determination.
    if let Some(hwmon) = find_hwmon("coretemp") {
        let temp_c = read_coretemp_max_c(&hwmon);
        // Try clock ratio first (same approach as AMD)
        if let (Some(max_khz), Some(cur_khz)) = (max_freq_khz, read_avg_cur_freq_khz()) {
            if max_khz > 0 {
                let ratio = cur_khz as f64 / max_khz as f64;
                // Use same clock ratio mapping as AMD, with coretemp as tie-breaker
                let mut result = amd_clock_ratio_result(ratio, temp_c);
                result.source = "coretemp";
                return Some(result);
            }
        }
        // coretemp present but cpufreq unavailable — use temperature directly
        if let Some(tc) = temp_c {
            let state = match tc {
                t if t < 70.0 => "Normal",
                t if t < 80.0 => "Fair",
                t if t < 90.0 => "Serious",
                _              => "Critical",
            };
            return Some(LinuxThermalResult {
                state:          state.to_string(),
                source:         "coretemp",
                direct_penalty: None,
                clock_ratio:    None,
            });
        }
    }

    // ── Generic Intel/other: clock ratio without dedicated hwmon ─────────────
    // If no k10temp or coretemp hwmon, but cpufreq is available, use clock ratio.
    if find_hwmon("k10temp").is_none() && find_hwmon("coretemp").is_none() {
        if let (Some(max_khz), Some(cur_khz)) = (max_freq_khz, read_avg_cur_freq_khz()) {
            if max_khz > 0 {
                let ratio = cur_khz as f64 / max_khz as f64;
                let mut result = amd_clock_ratio_result(ratio, None);
                result.source = "clock_ratio";
                return Some(result);
            }
        }
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

    eprintln!("  Replacing previous wicklee instance (PID {pid_str})…");

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
    let cfg = WickleeConfig { node_id: generate_node_id(), fleet_url: None, session_token: None, ollama_proxy: None, runtime_ports: None, bind_address: None };
    save_config(&cfg);
    cfg
}

fn save_config(cfg: &WickleeConfig) {
    let path = config_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(content) = toml::to_string(cfg) {
        let _ = std::fs::write(&path, &content);
        // Restrict config file to owner-only (0600) — it contains session_token.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
    }
}

fn generate_code() -> String {
    use rand::Rng;
    let n: u32 = rand::thread_rng().gen_range(0..1_000_000);
    format!("{:06}", n)
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

/// Resolve thermal state for the MetricsPayload, with idle CPU override.
///
/// When `thermal_source` is `clock_ratio` (Linux without hardware temp sensor),
/// low clock frequencies at idle are normal power-saving — NOT thermal throttling.
/// Force `Normal` when CPU usage is below 15% to avoid false thermal penalties.
#[cfg(target_os = "linux")]
fn resolve_thermal_state(
    apple_state: &Option<String>,
    linux_thermal: &Option<LinuxThermalResult>,
    cpu_usage_pct: f32,
) -> Option<String> {
    let raw = apple_state.clone()
        .or_else(|| linux_thermal.as_ref().map(|lt| lt.state.clone()));
    let is_clock_ratio = linux_thermal.as_ref()
        .map_or(false, |lt| lt.source == "clock_ratio");
    if is_clock_ratio && cpu_usage_pct < 15.0 && raw.as_deref() != Some("Normal") {
        Some("Normal".to_string())
    } else {
        raw
    }
}

#[cfg(not(target_os = "linux"))]
fn resolve_thermal_state(
    apple_state: &Option<String>,
    linux_thermal: &Option<LinuxThermalResult>,
    cpu_usage_pct: f32,
) -> Option<String> {
    apple_state.clone()
        .or_else(|| linux_thermal.as_ref().map(|lt| {
            // Idle CPU override: clock_ratio at low CPU is frequency scaling, not throttle.
            // Must match the same logic in start_wes_sampler() so thermal_state and
            // penalty_avg stay consistent in the payload.
            if lt.source == "clock_ratio" && cpu_usage_pct < 15.0 {
                "Normal".to_string()
            } else {
                lt.state.clone()
            }
        }))
}

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
    cpu_usage_pct:         Arc<std::sync::atomic::AtomicU32>,  // IEEE f32 bits
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
                    let cpu_pct = f32::from_bits(cpu_usage_pct.load(std::sync::atomic::Ordering::Relaxed));
                    // Idle CPU override: clock_ratio at low CPU is frequency scaling, not throttle.
                    let p = if lt.source == "clock_ratio" && cpu_pct < 15.0 {
                        1.0
                    } else {
                        lt.direct_penalty.unwrap_or_else(|| thermal_penalty_v2(lt.state.as_str()))
                    };
                    (p, lt.source)
                } else if let Some(ref state) = read_thermal_sysctl() {
                    // Windows WMI path — read_thermal_sysctl() returns thermal state
                    // string on Windows via WMI MSAcpi_ThermalZoneTemperature.
                    (thermal_penalty_v2(state.as_str()), "wmi")
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
/// Shared per-model baseline cache. Updated by the broadcast loop when model changes.
/// Tuple: (baseline_tps, baseline_wes, sample_count).
type ModelBaselineCache = Arc<Mutex<Option<(f32, f32, u32)>>>;

fn start_metrics_broadcaster(
    apple_metrics:         Arc<Mutex<AppleSiliconMetrics>>,
    nvidia_metrics:        Arc<Mutex<NvidiaMetrics>>,
    ollama_metrics:        Arc<Mutex<OllamaMetrics>>,
    rapl_metrics:          Arc<Mutex<Option<f32>>>,
    linux_thermal_metrics: Arc<Mutex<Option<LinuxThermalResult>>>,
    vllm_metrics:          Arc<Mutex<VllmMetrics>>,
    llamacpp_metrics:      Arc<Mutex<LlamacppMetrics>>,
    live_events:           Arc<Mutex<Vec<LiveActivityEvent>>>,
    wes_metrics:           Arc<Mutex<WesMetrics>>,
    swap_metrics:          SwapMetrics,
    probe_active:          Arc<std::sync::atomic::AtomicBool>,
    proxy_listen_port:     Option<u16>,
    proxy_target_port:     Option<u16>,
    runtime_port_overrides: Option<String>,
    config_node_id:        String,
    model_baseline:        ModelBaselineCache,
    cpu_usage_atomic:      Arc<std::sync::atomic::AtomicU32>,
) -> broadcast::Sender<String> {
    let (tx, _) = broadcast::channel::<String>(64);
    let tx_clone = tx.clone();

    tokio::spawn(async move {
        let mut sys = System::new_all();
        let node_id = config_node_id;
        let hostname = System::host_name()
            .unwrap_or_else(|| node_id.clone());

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
            // Update shared CPU usage for WES sampler idle-thermal override.
            cpu_usage_atomic.store(
                sys.global_cpu_info().cpu_usage().to_bits(),
                std::sync::atomic::Ordering::Relaxed,
            );

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
            let llamacpp      = llamacpp_metrics.lock().map(|g| g.clone()).unwrap_or_default();
            let rapl_power    = rapl_metrics.lock().map(|g| *g).unwrap_or(None);
            let linux_thermal = linux_thermal_metrics.lock().map(|g| g.clone()).unwrap_or(None);
            let wes           = wes_metrics.lock().map(|g| g.clone()).unwrap_or_default();
            let swap_mb_s     = swap_metrics.read();

            // Read per-model baseline from shared cache (updated by store task on model change).
            let model_baseline_cache = model_baseline.lock().map(|g| *g).unwrap_or(None);

            // Drain any pending live-activity events (normally empty, non-zero during update).
            let pending_events: Vec<LiveActivityEvent> = live_events
                .lock()
                .map(|mut v| std::mem::take(&mut *v))
                .unwrap_or_default();

            // Compute before struct literal so we can borrow `ollama` without
            // conflicting with the field moves (Option<String> fields are not Copy).
            let ollama_is_probing_flag = if ollama.is_probing_display() { Some(true) } else { None };
            let hw = read_hardware_signals(&apple, &nvidia, &ollama, &vllm, &llamacpp, &probe_active);
            let inference_state_val = compute_inference_state(&hw).to_string();

            let payload = MetricsPayload {
                node_id:                 node_id.clone(),
                hostname:                hostname.clone(),
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
                // macOS: pmset/sysctl; Linux: clock_ratio/coretemp/sysfs; Windows: WMI
                // Idle CPU override applied for clock_ratio source (see resolve_thermal_state).
                thermal_state:           resolve_thermal_state(&apple.thermal_state, &linux_thermal, sys.global_cpu_info().cpu_usage()),
                nvidia_gpu_utilization_percent: nvidia.nvidia_gpu_utilization_percent,
                nvidia_vram_used_mb:            nvidia.nvidia_vram_used_mb,
                nvidia_vram_total_mb:           nvidia.nvidia_vram_total_mb,
                nvidia_gpu_temp_c:              nvidia.nvidia_gpu_temp_c,
                nvidia_power_draw_w:            nvidia.nvidia_power_draw_w,
                ollama_running:           ollama.ollama_running,
                ollama_active_model:      ollama.ollama_active_model,
                ollama_model_size_gb:     ollama.ollama_model_size_gb,
                ollama_inference_active:  ollama.ollama_inference_active,
                ollama_proxy_active:         if ollama.ollama_proxy_active { Some(true) } else { None },
                ollama_proxy_avg_ttft_ms:    ollama.ollama_proxy_avg_ttft_ms,
                ollama_proxy_avg_latency_ms: ollama.ollama_proxy_avg_latency_ms,
                ollama_proxy_request_count:  ollama.ollama_proxy_request_count,
                proxy_listen_port,
                proxy_target_port,
                runtime_port_overrides: runtime_port_overrides.clone(),
                ollama_is_probing:        ollama_is_probing_flag,
                ollama_quantization:      ollama.ollama_quantization,
                ollama_tokens_per_second:  ollama.ollama_tokens_per_second,
                ollama_prompt_eval_tps:    ollama.ollama_prompt_eval_tps,
                ollama_ttft_ms:            ollama.ollama_ttft_ms,
                ollama_load_duration_ms:   ollama.ollama_load_duration_ms,
                vllm_running:          vllm.vllm_running,
                vllm_model_name:       vllm.vllm_model_name,
                vllm_tokens_per_sec:   vllm.vllm_tokens_per_sec,
                vllm_cache_usage_perc: vllm.vllm_cache_usage_perc,
                vllm_requests_running: vllm.vllm_requests_running,
                vllm_requests_waiting:        vllm.vllm_requests_waiting,
                vllm_requests_swapped:        vllm.vllm_requests_swapped,
                vllm_avg_ttft_ms:             vllm.vllm_avg_ttft_ms,
                vllm_avg_e2e_latency_ms:      vllm.vllm_avg_e2e_latency_ms,
                vllm_avg_queue_time_ms:       vllm.vllm_avg_queue_time_ms,
                vllm_prompt_tokens_total:     vllm.vllm_prompt_tokens_total,
                vllm_generation_tokens_total: vllm.vllm_generation_tokens_total,
                llamacpp_running:          llamacpp.llamacpp_running,
                llamacpp_model_name:       llamacpp.llamacpp_model_name,
                llamacpp_tokens_per_sec:   llamacpp.llamacpp_tokens_per_sec,
                llamacpp_slots_processing: llamacpp.llamacpp_slots_processing,
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
                model_baseline_tps:     model_baseline_cache.as_ref().map(|b| b.0),
                model_baseline_wes:     model_baseline_cache.as_ref().map(|b| b.1),
                model_baseline_samples: model_baseline_cache.as_ref().map(|b| b.2),
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
                bind_address: None,
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
            bind_address: None,
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
    save_config(&WickleeConfig { node_id: state.node_id.clone(), fleet_url: None, session_token: None, ollama_proxy: None, runtime_ports: None, bind_address: None });
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

// ── /api/traces ──────────────────────────────────────────────────────────────
// Returns recent inference traces from the local DuckDB store.
// Query parameters: node_id (optional), limit (optional, default 100, max 500).

#[cfg(not(target_env = "musl"))]
#[derive(serde::Deserialize)]
struct TracesQuery {
    node_id: Option<String>,
    limit: Option<i64>,
}

#[cfg(not(target_env = "musl"))]
async fn handle_traces(
    axum::extract::Query(q): axum::extract::Query<TracesQuery>,
    axum::extract::Extension(store): axum::extract::Extension<store::Store>,
) -> impl IntoResponse {
    use axum::http::StatusCode;

    let limit = q.limit.unwrap_or(100).min(500);
    let node_id_owned = q.node_id;
    match tokio::task::spawn_blocking(move || store.query_traces(node_id_owned.as_deref(), limit)).await {
        Ok(Ok(traces)) => Json(traces).into_response(),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("trace query failed: {e}"),
        ).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("task join failed: {e}"),
        ).into_response(),
    }
}

// ── Event history endpoint ────────────────────────────────────────────────────
//
// GET /api/events/history — paginated, persisted Live Activity events from DuckDB.

#[cfg(not(target_env = "musl"))]
#[derive(Deserialize)]
struct EventHistoryQuery {
    limit:      Option<i64>,
    before:     Option<i64>,
    event_type: Option<String>,
}

#[cfg(not(target_env = "musl"))]
async fn handle_events_history(
    axum::extract::Query(q): axum::extract::Query<EventHistoryQuery>,
    axum::extract::Extension(store): axum::extract::Extension<store::Store>,
) -> impl IntoResponse {
    use axum::http::StatusCode;

    let limit = q.limit.unwrap_or(50).min(200);
    let before = q.before;
    let event_type = q.event_type;
    match tokio::task::spawn_blocking(move || {
        store.query_events(limit, before, event_type.as_deref())
    }).await {
        Ok(Ok(events)) => Json(serde_json::json!({ "events": events })).into_response(),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("event query failed: {e}"),
        ).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("task join failed: {e}"),
        ).into_response(),
    }
}

// ── Audit Log Export ─────────────────────────────────────────────────────────
//
// GET /api/export — download a unified audit log (events + traces + dismissals)
// as CSV or JSON. Joins all three DuckDB audit tables into flat records.

#[cfg(not(target_env = "musl"))]
#[derive(Deserialize)]
struct ExportQuery {
    format: Option<String>,   // "csv" (default) or "json"
    from:   Option<i64>,      // start ts_ms (default: 24h ago)
    to:     Option<i64>,      // end ts_ms (default: now)
    limit:  Option<i64>,      // max records (default: 10000, max: 50000)
}

#[cfg(not(target_env = "musl"))]
async fn handle_export(
    axum::extract::Query(q): axum::extract::Query<ExportQuery>,
    axum::extract::Extension(store): axum::extract::Extension<store::Store>,
) -> impl IntoResponse {
    use axum::http::{StatusCode, header};

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let from_ms = q.from.unwrap_or(now_ms - 24 * 60 * 60 * 1000);
    let to_ms   = q.to.unwrap_or(now_ms);
    let limit   = q.limit.unwrap_or(10_000).min(50_000);
    let format  = q.format.as_deref().unwrap_or("csv");

    let records = match tokio::task::spawn_blocking(move || {
        store.export_audit_log(from_ms, to_ms, limit)
    }).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            let msg = format!("{e}");
            if msg.contains("Permission denied") {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({
                        "error": "Database access denied. Run: sudo chown -R $USER /etc/wicklee/"
                    })),
                ).into_response();
            }
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("Export failed: {msg}") })),
            ).into_response();
        }
        Err(e) => return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("Task join failed: {e}") })),
        ).into_response(),
    };

    let node_id = System::host_name().unwrap_or_else(|| "node".to_string());
    // Simple date string from system time — no chrono needed.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = secs / 86400;
    // Rough year/month/day — good enough for filenames.
    let y = 1970 + days / 365;
    let d = days % 365;
    let m = d / 30 + 1;
    let day = d % 30 + 1;
    let date = format!("{y}-{m:02}-{day:02}");
    let filename = format!("wicklee-audit-{node_id}-{date}");

    if format == "json" {
        let body = serde_json::to_string_pretty(&records).unwrap_or_default();
        (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "application/json"),
                (header::CONTENT_DISPOSITION, &format!("attachment; filename=\"{filename}.json\"")),
            ],
            body,
        ).into_response()
    } else {
        // CSV
        let mut csv = String::from("timestamp,record_type,node_id,level,event_type,message,model,latency_ms,ttft_ms,tpot_ms\n");
        for r in &records {
            csv.push_str(&format!(
                "{},{},{},{},{},{},{},{},{},{}\n",
                r.timestamp,
                r.record_type,
                csv_escape(&r.node_id),
                r.level,
                r.event_type.as_deref().unwrap_or(""),
                csv_escape(&r.message),
                r.model.as_deref().unwrap_or(""),
                r.latency_ms.map(|v| format!("{v:.1}")).unwrap_or_default(),
                r.ttft_ms.map(|v| format!("{v:.1}")).unwrap_or_default(),
                r.tpot_ms.map(|v| format!("{v:.1}")).unwrap_or_default(),
            ));
        }
        (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "text/csv; charset=utf-8"),
                (header::CONTENT_DISPOSITION, &format!("attachment; filename=\"{filename}.csv\"")),
            ],
            csv,
        ).into_response()
    }
}

/// Escape a string for CSV: wrap in double quotes if it contains commas,
/// quotes, or newlines. Double any existing double quotes.
#[cfg(not(target_env = "musl"))]
fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
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

// ── Local Observations (Patterns A, B, J, L) ─────────────────────────────────
//
// Server-side evaluation of 16 hardware-focused patterns against the 10-min
// DuckDB buffer. Returned by GET /api/observations for the localhost frontend
// and pushed to the cloud for fleet views via the observation cache.

/// Shared cache of the latest evaluated observations.  Written by the 10 s
/// observation evaluator task; read by cloud_push (embed in telemetry) and
/// handle_observations (GET /api/observations).
#[cfg(not(target_env = "musl"))]
pub(crate) type ObservationCache = Arc<Mutex<Vec<LocalObservation>>>;

#[cfg(not(target_env = "musl"))]
#[derive(Serialize, Clone)]
struct LocalObservation {
    pattern_id:       &'static str,
    severity:         &'static str,
    title:            String,
    hook:             String,
    body:             String,
    recommendation:   String,
    resolution_steps: Vec<String>,
    action_id:        &'static str,
    confidence:       &'static str,
    confidence_ratio: f64,
    first_fired_ms:   i64,
    node_id:          String,
    hostname:         String,
}

/// PCIe state snapshot from live NvidiaMetrics (not stored in DuckDB).
#[cfg(not(target_env = "musl"))]
struct PcieSnapshot {
    link_width:     Option<u32>,
    link_max_width: Option<u32>,
}

// ── Pattern-engine math helpers ──────────────────────────────────────────────

fn obs_mean(values: &[f64]) -> f64 {
    if values.is_empty() { return 0.0; }
    values.iter().sum::<f64>() / values.len() as f64
}

fn obs_stddev(values: &[f64]) -> f64 {
    if values.len() < 2 { return 0.0; }
    let m = obs_mean(values);
    let var = values.iter().map(|&v| (v - m).powi(2)).sum::<f64>() / (values.len() - 1) as f64;
    var.sqrt()
}

/// Ordinary least-squares slope over an ordered series (index = x, value = y).
/// Returns units-per-sample; caller multiplies by samples/min to get per-minute slope.
fn obs_linear_slope(values: &[f64]) -> f64 {
    let n = values.len() as f64;
    if n < 2.0 { return 0.0; }
    let sum_x:  f64 = (0..values.len()).map(|i| i as f64).sum();
    let sum_y:  f64 = values.iter().sum();
    let sum_xy: f64 = values.iter().enumerate().map(|(i, &y)| i as f64 * y).sum();
    let sum_x2: f64 = (0..values.len()).map(|i| (i as f64).powi(2)).sum();
    let denom = n * sum_x2 - sum_x * sum_x;
    if denom.abs() < f64::EPSILON { 0.0 } else { (n * sum_xy - sum_x * sum_y) / denom }
}

fn obs_confidence(ratio: f64) -> &'static str {
    if ratio >= 0.9 { "high" } else if ratio >= 0.5 { "moderate" } else { "building" }
}

#[cfg(not(target_env = "musl"))]
/// Pure evaluation function — no side effects, no stored state.
/// Takes a 10-minute window of DuckDB samples + live PCIe state and returns
/// any observations that meet their gating criteria.
fn evaluate_local_observations(
    samples:  &[store::ObsSample],
    pcie:     &PcieSnapshot,
    node_id:  &str,
    hostname: &str,
) -> Vec<LocalObservation> {
    let mut obs = Vec::new();
    let now_ms = now_ms() as i64;

    // 5-minute window — used by patterns A/B/H/J/K
    let min_density_5m = 210_usize;   // 70% of 300s at 1 Hz
    let cutoff_5m = now_ms - 300_000_i64;
    let window: Vec<&store::ObsSample> = samples.iter()
        .filter(|s| s.ts_ms >= cutoff_5m)
        .collect();

    // 10-minute window — used by patterns C/F
    let min_density_10m = 420_usize;  // 70% of 600s at 1 Hz
    let cutoff_10m = now_ms - 600_000_i64;
    let long_window: Vec<&store::ObsSample> = samples.iter()
        .filter(|s| s.ts_ms >= cutoff_10m)
        .collect();

    // ── Pattern A: Thermal Performance Drain ─────────────────────────────
    // thermal_state != "Normal" sustained 5 min + tok/s visible during window.
    // Hook: tok/s delta vs Normal-thermal baseline.
    if window.len() >= min_density_5m {
        let thermal_samples: Vec<&store::ObsSample> = window.iter()
            .filter(|s| s.thermal_state.as_deref().is_some_and(|t| t != "Normal"))
            .copied()
            .collect();
        let normal_samples: Vec<&store::ObsSample> = window.iter()
            .filter(|s| s.thermal_state.as_deref() == Some("Normal"))
            .copied()
            .collect();

        let thermal_ratio = thermal_samples.len() as f64 / window.len() as f64;

        if thermal_ratio >= 0.70 {
            // Compute tok/s means for throttled vs Normal baselines
            let throttled_tps: Vec<f64> = thermal_samples.iter()
                .filter_map(|s| s.tps)
                .filter(|t| *t > 0.0)
                .collect();
            let normal_tps: Vec<f64> = normal_samples.iter()
                .filter_map(|s| s.tps)
                .filter(|t| *t > 0.0)
                .collect();

            if !throttled_tps.is_empty() {
                let throttled_avg = throttled_tps.iter().sum::<f64>() / throttled_tps.len() as f64;
                let (hook, body, degradation_pct) = if !normal_tps.is_empty() {
                    let normal_avg = normal_tps.iter().sum::<f64>() / normal_tps.len() as f64;
                    let delta = normal_avg - throttled_avg;
                    let pct = if normal_avg > 0.0 { (delta / normal_avg) * 100.0 } else { 0.0 };
                    (
                        format!("-{:.1} tok/s ({:.0}% below Normal baseline)", delta.max(0.0), pct.max(0.0)),
                        format!(
                            "Thermal state has been elevated for {:.0}% of the last 5 minutes. \
                             Throughput averages {:.1} tok/s under thermal pressure vs {:.1} tok/s \
                             at Normal — a {:.0}% performance drain.",
                            thermal_ratio * 100.0, throttled_avg, normal_avg, pct.max(0.0),
                        ),
                        pct,
                    )
                } else {
                    // No Normal baseline — still report the throttle
                    (
                        format!("{:.1} tok/s under thermal pressure", throttled_avg),
                        format!(
                            "Thermal state has been elevated for {:.0}% of the last 5 minutes \
                             with no Normal-thermal baseline available for comparison. \
                             Current throughput: {:.1} tok/s.",
                            thermal_ratio * 100.0, throttled_avg,
                        ),
                        0.0,
                    )
                };

                // Only fire if degradation > 8% (spec threshold)
                if degradation_pct > 8.0 || normal_tps.is_empty() {
                    let confidence_ratio = (thermal_ratio).min(1.0);
                    obs.push(LocalObservation {
                        pattern_id:       "thermal_drain",
                        severity:         if degradation_pct > 20.0 { "critical" } else { "warning" },
                        title:            "Thermal Performance Drain".into(),
                        hook,
                        body,
                        recommendation:   "Reduce ambient temperature or improve airflow around the node. \
                                           If persistent, consider offloading inference to a cooler node."
                                           .into(),
                        resolution_steps: vec![
                            "Check ambient temperature and airflow around the machine".into(),
                            "Run: pmset -g therm (macOS) or check /sys/class/thermal (Linux)".into(),
                            "If model is large, consider a smaller quantization to reduce heat output".into(),
                        ],
                        action_id:        "check_thermal_zone",
                        confidence:       if confidence_ratio >= 0.9 { "high" } else if confidence_ratio >= 0.5 { "moderate" } else { "building" },
                        confidence_ratio,
                        first_fired_ms:   now_ms,
                        node_id:          node_id.into(),
                        hostname:         hostname.into(),
                    });
                }
            }
        }
    }

    // ── Pattern B: Phantom Load ──────────────────────────────────────────
    // Model loaded + power > 5W + tok/s < 0.5 for 5 min at 70% density.
    if window.len() >= min_density_5m {
        let phantom_samples: Vec<&store::ObsSample> = window.iter()
            .filter(|s| {
                let model_loaded = s.model.is_some();
                let power = s.gpu_power_w.or(s.cpu_power_w).unwrap_or(0.0);
                let tps = s.tps.unwrap_or(0.0);
                model_loaded && power > 5.0 && tps < 0.5
            })
            .copied()
            .collect();

        let phantom_ratio = phantom_samples.len() as f64 / window.len() as f64;

        if phantom_ratio >= 0.70 {
            let avg_watts: f64 = phantom_samples.iter()
                .filter_map(|s| s.gpu_power_w.or(s.cpu_power_w))
                .sum::<f64>() / phantom_samples.len().max(1) as f64;
            // Cost estimate: $/day at $0.12/kWh default
            let kwh_rate = 0.12;
            let cost_per_day = (avg_watts / 1000.0) * 24.0 * kwh_rate;
            let model_name = phantom_samples.last()
                .and_then(|s| s.model.as_deref())
                .unwrap_or("unknown");

            let confidence_ratio = phantom_ratio.min(1.0);
            obs.push(LocalObservation {
                pattern_id:       "phantom_load",
                severity:         "warning",
                title:            "Phantom Load Detected".into(),
                hook:             format!("-${:.2}/day · {:.0}W idle", cost_per_day, avg_watts),
                body:             format!(
                    "Model \"{}\" is loaded in VRAM and drawing {:.0}W with zero inference activity \
                     for the last 5 minutes. This is pure idle cost — {:.0}% of samples show \
                     no useful work being done.",
                    model_name, avg_watts, phantom_ratio * 100.0,
                ),
                recommendation:   "Unload the idle model to reclaim VRAM and reduce power draw. \
                                   If the model is needed soon, set a keep-alive timer instead."
                                   .into(),
                resolution_steps: vec![
                    format!("Run: ollama stop {}", model_name),
                    "Or: ollama ps  (verify model is still loaded)".into(),
                    "Consider: OLLAMA_KEEP_ALIVE=5m to auto-unload after inactivity".into(),
                ],
                action_id:        "investigate_phantom",
                confidence:       if confidence_ratio >= 0.9 { "high" } else if confidence_ratio >= 0.5 { "moderate" } else { "building" },
                confidence_ratio,
                first_fired_ms:   now_ms,
                node_id:          node_id.into(),
                hostname:         hostname.into(),
            });
        }
    }

    // ── Pattern J: Swap I/O Pressure ─────────────────────────────────────
    // swap_write_mb_s > 2.0 sustained 5 min.
    if window.len() >= min_density_5m {
        let swap_samples: Vec<&store::ObsSample> = window.iter()
            .filter(|s| s.swap_write_mb_s.unwrap_or(0.0) > 2.0)
            .copied()
            .collect();

        let swap_ratio = swap_samples.len() as f64 / window.len() as f64;

        if swap_ratio >= 0.70 {
            let avg_swap: f64 = swap_samples.iter()
                .filter_map(|s| s.swap_write_mb_s)
                .sum::<f64>() / swap_samples.len().max(1) as f64;
            let is_storm = avg_swap > 10.0;
            let avg_tps: Option<f64> = {
                let tps_vals: Vec<f64> = window.iter()
                    .filter_map(|s| s.tps)
                    .filter(|t| *t > 0.0)
                    .collect();
                if tps_vals.is_empty() { None } else { Some(tps_vals.iter().sum::<f64>() / tps_vals.len() as f64) }
            };

            let confidence_ratio = swap_ratio.min(1.0);
            obs.push(LocalObservation {
                pattern_id:       "swap_io_pressure",
                severity:         if is_storm { "critical" } else { "warning" },
                title:            if is_storm { "Swap Storm".into() } else { "Swap I/O Pressure".into() },
                hook:             format!(
                    "{:.1} MB/s swap{}",
                    avg_swap,
                    avg_tps.map(|t| format!(" · {:.1} tok/s", t)).unwrap_or_default(),
                ),
                body:             format!(
                    "Sustained swap write rate of {:.1} MB/s over {:.0}% of the last 5 minutes{}. \
                     Swap pressure forces the OS to page model weights to disk, dramatically \
                     increasing inference latency.",
                    avg_swap, swap_ratio * 100.0,
                    if is_storm { " — this is a swap storm (>10 MB/s)" } else { "" },
                ),
                recommendation:   "Reduce memory pressure by unloading idle models or switching to \
                                   a smaller quantization. If possible, add physical RAM."
                                   .into(),
                resolution_steps: vec![
                    "Run: ollama ps  (check loaded model count and VRAM usage)".into(),
                    "Evict idle models: ollama stop <model>".into(),
                    "Consider a smaller quantization (e.g., Q4_K_M → Q4_0)".into(),
                    "Monitor: vm_stat 1 (macOS) or vmstat 1 (Linux)".into(),
                ],
                action_id:        "evict_idle_models",
                confidence:       if confidence_ratio >= 0.9 { "high" } else if confidence_ratio >= 0.5 { "moderate" } else { "building" },
                confidence_ratio,
                first_fired_ms:   now_ms,
                node_id:          node_id.into(),
                hostname:         hostname.into(),
            });
        }
    }

    // ── Pattern L: PCIe Lane Degradation ─────────────────────────────────
    // Point-in-time: pcie_link_width < pcie_link_max_width (NVIDIA only).
    if let (Some(cur), Some(max)) = (pcie.link_width, pcie.link_max_width) {
        if cur < max {
            obs.push(LocalObservation {
                pattern_id:       "pcie_lane_degradation",
                severity:         if cur <= max / 2 { "critical" } else { "warning" },
                title:            "PCIe Lane Degradation".into(),
                hook:             format!("x{} in x{} slot", cur, max),
                body:             format!(
                    "GPU is negotiating {} PCIe lanes but the slot supports {}. \
                     This reduces GPU↔CPU bandwidth by {:.0}%, which can bottleneck \
                     large model weight transfers and KV cache synchronisation.",
                    cur, max, (1.0 - cur as f64 / max as f64) * 100.0,
                ),
                recommendation:   "Reseat the GPU in its PCIe slot. Check for dust, bent pins, \
                                   or a loose riser cable. Verify BIOS PCIe settings."
                                   .into(),
                resolution_steps: vec![
                    "Power off and reseat the GPU in the PCIe slot".into(),
                    "Inspect the slot and card edge connector for debris or damage".into(),
                    "Check BIOS: ensure PCIe link speed is set to Auto or Gen4/Gen5".into(),
                    "Run: nvidia-smi -q -d PCIE  (confirm current negotiated width)".into(),
                ],
                action_id:        "check_power_limits",
                confidence:       "high",
                confidence_ratio: 1.0,
                first_fired_ms:   now_ms,
                node_id:          node_id.into(),
                hostname:         hostname.into(),
            });
        }
    }

    // ── Pattern C: WES Velocity Drop ─────────────────────────────────────
    // Efficiency score declining before thermal state changes — early warning.
    // Window: 10 min; fires if WES slope < -0.5/min AND total drop > 10%.
    // Suppressed when thermal is already Serious/Critical (Pattern A covers it).
    if long_window.len() >= min_density_10m {
        // Compute WES per sample: tps / (power × penalty).  penalty defaults to 1.0.
        let wes_vals: Vec<f64> = long_window.iter()
            .filter_map(|s| {
                let tps   = s.tps?;
                let power = s.gpu_power_w.or(s.cpu_power_w)?;
                if power <= 0.0 { return None; }
                let penalty = s.penalty_avg.unwrap_or(1.0).max(1.0);
                Some(tps / (power * penalty))
            })
            .collect();

        let dense_enough = wes_vals.len() >= (min_density_10m as f64 * 0.7) as usize;
        let latest_thermal = long_window.last()
            .and_then(|s| s.thermal_state.as_deref());
        let is_already_hot = matches!(latest_thermal, Some("Serious") | Some("Critical"));

        if dense_enough && !is_already_hot {
            // At 1 Hz, 60 samples = 1 minute
            let slope_per_sample = obs_linear_slope(&wes_vals);
            let slope_per_min    = slope_per_sample * 60.0;

            if slope_per_min < -0.5 {
                let first_wes = wes_vals[0];
                let last_wes  = wes_vals[wes_vals.len() - 1];
                let drop_pct  = if first_wes > 0.0 { ((first_wes - last_wes) / first_wes) * 100.0 } else { 0.0 };

                if drop_pct >= 10.0 {
                    let minutes_to_half = if last_wes > 0.0 && slope_per_min < 0.0 {
                        Some((last_wes / 2.0) / slope_per_min.abs())
                    } else { None };
                    let observed_min = (wes_vals.len() as f64 / 60.0).round() as u64;
                    let ratio = ((wes_vals.len() as f64 / 60.0) / 10.0_f64).min(1.0);

                    let eta_note = match minutes_to_half {
                        Some(m) if m < 30.0 => format!(" WES may halve in ~{} min at this rate.", m.round() as u64),
                        _ => String::new(),
                    };

                    obs.push(LocalObservation {
                        pattern_id:       "wes_velocity_drop",
                        severity:         "warning",
                        title:            "WES Velocity Drop".into(),
                        hook:             format!("{:.1} WES/min · {:.0}% drop", slope_per_min, drop_pct),
                        body:             format!(
                            "{hostname}'s efficiency score has been declining at {:.1} WES/min for the \
                             last {observed_min} min ({:.0} → {:.0} WES). Thermal state has not yet \
                             changed — this is an early warning.{eta_note}",
                            slope_per_min.abs(), first_wes, last_wes,
                        ),
                        recommendation:   format!(
                            "Reduce workload on {hostname} now — check ambient temperature, competing \
                             background processes, and VRAM allocation.{eta_note}",
                        ),
                        resolution_steps: vec![
                            format!("Monitor WES: watch -n 30 \"curl -s http://localhost:7700/api/health | jq .wes_score\""),
                            "Reduce OLLAMA_NUM_PARALLEL to 1 to slow the WES decline".into(),
                            "Check if background processes (backups, builds) started recently".into(),
                            "If WES drops below 5 within 5 min, treat as Pattern A — enact physical cooling".into(),
                        ],
                        action_id:        "check_thermal_zone",
                        confidence:       obs_confidence(ratio),
                        confidence_ratio: ratio,
                        first_fired_ms:   now_ms,
                        node_id:          node_id.into(),
                        hostname:         hostname.into(),
                    });
                }
            }
        }
    }

    // ── Pattern F: Memory Pressure Trajectory ────────────────────────────
    // Memory pressure climbing — projected to hit critical threshold.
    // Window: 10 min; fires if rising trend will hit 85% within 30 min.
    // Apple Silicon only (mem_pressure_pct not available on NVIDIA nodes).
    if long_window.len() >= min_density_10m {
        let mem_vals: Vec<f64> = long_window.iter()
            .filter_map(|s| s.mem_pressure_pct)
            .collect();

        let dense_enough = mem_vals.len() >= (min_density_10m as f64 * 0.7) as usize;

        if dense_enough {
            let current_mem = *mem_vals.last().unwrap();

            // Suppress if already critical — a separate MemoryExhaustionCard handles that
            if current_mem < 80.0 {
                let slope_per_sample = obs_linear_slope(&mem_vals);

                if slope_per_sample > 0.0 {
                    let slope_per_min = slope_per_sample * 60.0;
                    let headroom  = 85.0 - current_mem;
                    let eta_min   = headroom / slope_per_min;

                    if eta_min > 0.0 && eta_min <= 30.0 {
                        let eta_rounded = eta_min.round() as u64;
                        let ratio = ((mem_vals.len() as f64 / 60.0) / 10.0_f64).min(1.0);

                        obs.push(LocalObservation {
                            pattern_id:       "memory_trajectory",
                            severity:         "warning",
                            title:            "Memory Pressure Trajectory".into(),
                            hook:             format!("Critical in ~{eta_rounded}m"),
                            body:             format!(
                                "{hostname}'s memory pressure is rising at {slope_per_min:.1}%/min \
                                 (currently {current_mem:.0}%). At this rate it will hit the critical \
                                 threshold (85%) in ~{eta_rounded} min. Swap activity and inference \
                                 stalls follow immediately after.",
                            ),
                            recommendation:   "Unload the largest loaded model now to arrest the \
                                               pressure rise before swap activity begins. Run `ollama ps` \
                                               to identify the largest resident model and `ollama stop \
                                               <model>` to release it.".into(),
                            resolution_steps: vec![
                                "Check loaded models: `ollama ps` — note memory footprint of each".into(),
                                "Unload the largest model: `ollama stop <model-name>`".into(),
                                "Close memory-heavy background processes: browsers, IDEs, Docker".into(),
                                "Verify pressure decreasing: `curl http://localhost:7700/api/health | jq .memory_pressure_percent`".into(),
                                "Prevent recurrence: set OLLAMA_MAX_LOADED_MODELS=1".into(),
                            ],
                            action_id:        "evict_idle_models",
                            confidence:       obs_confidence(ratio),
                            confidence_ratio: ratio,
                            first_fired_ms:   now_ms,
                            node_id:          node_id.into(),
                            hostname:         hostname.into(),
                        });
                    }
                }
            }
        }
    }

    // ── Pattern H: Power Jitter ───────────────────────────────────────────
    // Power draw CoV > 20% during active inference — PSU/VRM stress or thundering herd.
    // Window: 5 min; requires mean watts > 30 and mean tok/s > 0.5.
    if window.len() >= min_density_5m {
        let watts_vals: Vec<f64> = window.iter()
            .filter_map(|s| s.gpu_power_w.or(s.cpu_power_w))
            .collect();

        let dense_enough = watts_vals.len() >= (min_density_5m as f64 * 0.7) as usize;

        if dense_enough {
            let avg_watts = obs_mean(&watts_vals);

            if avg_watts >= 30.0 {
                let tps_vals: Vec<f64> = window.iter()
                    .filter_map(|s| s.tps)
                    .filter(|&t| t > 0.0)
                    .collect();
                let avg_tps = if tps_vals.is_empty() { 0.0 } else { obs_mean(&tps_vals) };

                if avg_tps >= 0.5 {
                    let sd  = obs_stddev(&watts_vals);
                    let cov = sd / avg_watts;

                    if cov >= 0.20 {
                        let tps_cov = if tps_vals.len() >= 3 {
                            obs_stddev(&tps_vals) / obs_mean(&tps_vals).max(f64::EPSILON)
                        } else { 0.0 };
                        let is_thundering_herd = tps_cov > 0.25;
                        let observed_min = 5_u64;
                        let ratio = (watts_vals.len() as f64 / (min_density_5m as f64 / 0.7)).min(1.0);

                        let recommendation = if is_thundering_herd {
                            format!(
                                "Power variance ({:.0}% CoV) coupled with throughput variance — consistent \
                                 with thundering herd load. Reduce OLLAMA_NUM_PARALLEL and introduce a \
                                 request queue to smooth bursty traffic.",
                                cov * 100.0,
                            )
                        } else {
                            format!(
                                "Power draw variance ({:.0}% CoV at {avg_watts:.0}W average) indicates \
                                 the GPU is cycling between saturation and near-idle. Check load balancer \
                                 dispatch for bursty traffic. Sustained dynamic load accelerates PSU/VRM wear.",
                                cov * 100.0,
                            )
                        };

                        obs.push(LocalObservation {
                            pattern_id:       "power_jitter",
                            severity:         "warning",
                            title:            "Power Jitter".into(),
                            hook:             format!(
                                "±{sd:.0}W · {:.0}% CoV{}",
                                cov * 100.0,
                                if is_thundering_herd { " · thundering herd" } else { "" },
                            ),
                            body:             format!(
                                "{hostname}'s power draw has a {:.0}% coefficient of variation \
                                 (±{sd:.0}W around {avg_watts:.0}W average) over the last \
                                 {observed_min} min.{} Stable inference has predictable power draw. \
                                 High variance is a leading indicator of PSU/VRM stress.",
                                cov * 100.0,
                                if is_thundering_herd {
                                    " Throughput variance is also elevated — the GPU is cycling \
                                     between full saturation and near-idle in sync with bursty batches."
                                } else { "" },
                            ),
                            recommendation,
                            resolution_steps: if is_thundering_herd { vec![
                                "Check load balancer — are requests arriving in synchronized waves?".into(),
                                "Add a request queue (FIFO dispatch) to smooth bursty traffic".into(),
                                "Reduce OLLAMA_NUM_PARALLEL to 1–2 to prevent excessive context switching".into(),
                                "Target < 15% CoV to confirm the fix worked".into(),
                            ]} else { vec![
                                "Verify PSU headroom: rated wattage should be ≥ 20% above peak draw".into(),
                                "Check VRM temperatures if sensors available — target < 85°C under load".into(),
                                "Reduce inference concurrency: set OLLAMA_NUM_PARALLEL=1".into(),
                                "Check for bursty workload patterns — add client-side request smoothing".into(),
                            ]},
                            action_id:        "reduce_batch_size",
                            confidence:       obs_confidence(ratio),
                            confidence_ratio: ratio,
                            first_fired_ms:   now_ms,
                            node_id:          node_id.into(),
                            hostname:         hostname.into(),
                        });
                    }
                }
            }
        }
    }

    // ── Pattern K: Clock Drift ────────────────────────────────────────────
    // GPU clocks throttled during inference despite Normal thermals — power cap or driver limit.
    // Window: 5 min; fires if avg throttle > 15% with tps > 0.5 and Normal thermals.
    if window.len() >= min_density_5m {
        let clock_vals: Vec<f64> = window.iter()
            .filter_map(|s| s.clock_throttle_pct)
            .collect();

        let dense_enough = clock_vals.len() >= (min_density_5m as f64 * 0.7) as usize;

        if dense_enough {
            let avg_throttle = obs_mean(&clock_vals);

            if avg_throttle >= 15.0 {
                let tps_vals: Vec<f64> = window.iter()
                    .filter_map(|s| s.tps)
                    .filter(|&t| t > 0.0)
                    .collect();
                let avg_tps = if tps_vals.is_empty() { 0.0 } else { obs_mean(&tps_vals) };

                if avg_tps >= 0.5 {
                    // Only fire when thermals are Normal — Pattern A covers hot+throttled
                    let hot_count = window.iter()
                        .filter(|s| s.thermal_state.as_deref().is_some_and(|t| t != "Normal"))
                        .count();
                    let hot_ratio = hot_count as f64 / window.len() as f64;

                    if hot_ratio <= 0.30 {
                        let is_severe   = avg_throttle >= 35.0;
                        let speed_pct   = 100.0 - avg_throttle;
                        let implied_tps = if avg_throttle > 0.0 {
                            Some(avg_tps / (speed_pct / 100.0))
                        } else { None };
                        let ratio = (clock_vals.len() as f64 / (min_density_5m as f64 / 0.7)).min(1.0);

                        obs.push(LocalObservation {
                            pattern_id:       "clock_drift",
                            severity:         if is_severe { "critical" } else { "warning" },
                            title:            if is_severe {
                                "Severe Clock Throttle During Inference".into()
                            } else {
                                "Clock Drift During Inference".into()
                            },
                            hook:             format!(
                                "{avg_throttle:.0}% throttled · running at {speed_pct:.0}% of rated clock · {avg_tps:.1} tok/s",
                            ),
                            body:             format!(
                                "{hostname} is sustaining {avg_throttle:.0}% clock throttling while \
                                 inference is active, despite Normal thermal state. Running at {speed_pct:.0}% \
                                 of rated frequency — due to a power limit, BIOS cap, or OS power governor.{}\
                                 {}",
                                implied_tps.map(|t| format!(" At full clock speed, throughput would be ~{t:.1} tok/s (current: {avg_tps:.1}).")).unwrap_or_default(),
                                if is_severe { " At this throttle level, hardware is significantly underperforming spec." } else { "" },
                            ),
                            recommendation:   "Check and lift the power limit or clock cap constraining \
                                               this node. On Linux, set the CPU governor to `performance`. \
                                               On Apple Silicon, ensure AC power with Performance mode enabled.".into(),
                            resolution_steps: vec![
                                format!("Verify throttle: `curl http://localhost:7700/api/health | jq .clock_throttle_pct`"),
                                "Linux CPU governor: `sudo cpupower frequency-set -g performance`".into(),
                                "NVIDIA: `nvidia-smi -q -d CLOCK | grep -A4 'Clocks Throttle'`".into(),
                                "Apple Silicon: System Settings → Battery → Options → disable 'Limit CPU speed'".into(),
                            ],
                            action_id:        "check_power_limits",
                            confidence:       obs_confidence(ratio),
                            confidence_ratio: ratio,
                            first_fired_ms:   now_ms,
                            node_id:          node_id.into(),
                            hostname:         hostname.into(),
                        });
                    }
                }
            }
        }
    }

    // ── Pattern N: NVIDIA Thermal Redline ────────────────────────────────
    // NVIDIA GPU temperature above safe operating range.
    // Dual-path: sustained >85°C for 2 min (warning) OR instantaneous >90°C (critical).
    {
        // Instantaneous path: latest sample > 90°C
        let instant_temp: Option<i32> = window.last()
            .and_then(|s| s.nvidia_gpu_temp_c)
            .filter(|&t| t > 90);

        // Sustained path: >85°C for 2 min (120 samples), 70% density
        let sustained_result: Option<(f64, f64)> = {
            let temp_samples: Vec<i32> = window.iter()
                .filter_map(|s| s.nvidia_gpu_temp_c)
                .collect();
            if temp_samples.len() >= 84 {  // 70% of 120
                let hot_samples: Vec<f64> = temp_samples.iter()
                    .filter(|&&t| t > 85)
                    .map(|&t| t as f64)
                    .collect();
                if hot_samples.len() >= (temp_samples.len() as f64 * 0.70) as usize {
                    let avg = obs_mean(&hot_samples);
                    let ratio = (temp_samples.len() as f64 / 120.0).min(1.0);
                    Some((avg, ratio))
                } else { None }
            } else { None }
        };

        if instant_temp.is_some() || sustained_result.is_some() {
            let (temp, is_critical, confidence_ratio) = if let Some(t) = instant_temp {
                (t as f64, true, 1.0_f64)
            } else {
                let (avg, ratio) = sustained_result.unwrap();
                (avg, avg > 90.0, ratio)
            };

            obs.push(LocalObservation {
                pattern_id:       "nvidia_thermal_redline",
                severity:         if is_critical { "critical" } else { "warning" },
                title:            if is_critical {
                    "NVIDIA GPU Critical Temperature".into()
                } else {
                    "NVIDIA GPU Thermal Redline".into()
                },
                hook:             format!("{temp:.0}°C GPU temperature"),
                body:             if is_critical {
                    format!(
                        "{hostname}'s NVIDIA GPU is at {temp:.0}°C — exceeding the 90°C critical \
                         threshold. The driver will aggressively throttle clocks and may shut down \
                         the GPU to prevent damage.",
                    )
                } else {
                    format!(
                        "{hostname}'s NVIDIA GPU is sustained above 85°C. Thermal throttling \
                         reduces clock frequency and inference throughput progressively.",
                    )
                },
                recommendation:   if is_critical {
                    "Immediately reduce GPU load: stop inference, check fan operation, and verify \
                     airflow. If temperature doesn't drop within 60 seconds, power off to prevent \
                     hardware damage.".into()
                } else {
                    "Check case airflow and fan curves. Consider lowering the power limit with \
                     `nvidia-smi -pl` to reduce thermal output.".into()
                },
                resolution_steps: vec![
                    "Check temperature and throttle: `nvidia-smi --query-gpu=temperature.gpu,clocks_throttle_reasons.active --format=csv,noheader`".into(),
                    "Verify fan: `nvidia-smi --query-gpu=fan.speed --format=csv,noheader` — 0% may indicate failed fan".into(),
                    "Lower power limit: `sudo nvidia-smi -pl <watts>` (try 80% of TDP)".into(),
                    "Check ambient temperature and dust buildup on heatsink".into(),
                ],
                action_id:        "check_thermal_zone",
                confidence:       obs_confidence(confidence_ratio),
                confidence_ratio,
                first_fired_ms:   now_ms,
                node_id:          node_id.into(),
                hostname:         hostname.into(),
            });
        }
    }

    // ── Pattern D: Power-GPU Decoupling ──────────────────────────────────
    // High watts + active inference + low GPU utilization.
    // Inference is CPU-bound or memory-bound, not GPU-bound.
    // Uses 5-min window; requires gpu_util_pct data.
    {
        let min_gpu_density = (min_density_5m as f64 * 0.7) as usize;
        let gpu_count = window.iter().filter(|s| s.gpu_util_pct.is_some()).count();

        if gpu_count >= min_gpu_density {
            // Qualifying samples: high watts + inference active + low GPU util
            let decoupled: Vec<&&store::ObsSample> = window.iter()
                .filter(|s| {
                    let watts = s.gpu_power_w.unwrap_or(0.0) + s.cpu_power_w.unwrap_or(0.0);
                    watts > 50.0
                        && s.tps.unwrap_or(0.0) > 0.0
                        && s.gpu_util_pct.unwrap_or(100.0) < 20.0
                })
                .collect();

            let min_decoupled = (min_density_5m as f64 * 0.6) as usize;
            if decoupled.len() >= min_decoupled {
                let watts_vals: Vec<f64> = decoupled.iter()
                    .map(|s| s.gpu_power_w.unwrap_or(0.0) + s.cpu_power_w.unwrap_or(0.0))
                    .collect();
                let gpu_util_vals: Vec<f64> = decoupled.iter()
                    .filter_map(|s| s.gpu_util_pct)
                    .collect();
                let tps_vals: Vec<f64> = decoupled.iter()
                    .filter_map(|s| s.tps)
                    .collect();

                let avg_watts    = obs_mean(&watts_vals);
                let avg_gpu_util = if gpu_util_vals.is_empty() { 0.0 } else { obs_mean(&gpu_util_vals) };
                let avg_tps      = if tps_vals.is_empty() { 0.0 } else { obs_mean(&tps_vals) };
                let ratio        = (decoupled.len() as f64 / min_density_5m as f64).min(1.0);

                obs.push(LocalObservation {
                    pattern_id:       "power_gpu_decoupling",
                    severity:         "warning",
                    title:            "Power-GPU Decoupling".into(),
                    hook:             format!("{avg_gpu_util:.0}% GPU · {avg_watts:.0}W"),
                    body:             format!(
                        "{hostname} is drawing {avg_watts:.0}W and generating {avg_tps:.1} tok/s, \
                         but GPU utilization is only {avg_gpu_util:.0}% — significantly below what \
                         the power draw suggests. Inference appears CPU-bound or memory-bound. \
                         Common causes: large context window filling KV cache, CPU-offloaded layers \
                         in a mixed quantization, or a batch size too small to saturate GPU SIMD lanes.",
                    ),
                    recommendation:   "Try reducing concurrent context length or switching to a \
                                       quantization with fewer CPU-offloaded layers (e.g. Q4_K_M over \
                                       Q2_K). If using vLLM, tune --max-num-batched-tokens to the \
                                       GPU-saturating sweet spot.".into(),
                    resolution_steps: vec![
                        format!("Check GPU util: `curl http://localhost:7700/api/health | jq '{{gpu_util:.nvidia_gpu_utilization_percent,cpu_w:.cpu_power_w,tok_s:.ollama_tokens_per_second}}'`"),
                        "Set all layers to GPU: OLLAMA_NUM_GPU=99 ollama serve".into(),
                        "Switch to Q4_K_M: `ollama pull <model>:q4_K_M` — fully GPU-offloads vs Q2_K".into(),
                        "For vLLM: raise --max-num-seqs to create batches that saturate GPU SIMD lanes".into(),
                        "Trim max_tokens in your app — KV cache fills CPU memory when context > VRAM".into(),
                    ],
                    action_id:        "reduce_batch_size",
                    confidence:       obs_confidence(ratio),
                    confidence_ratio: ratio,
                    first_fired_ms:   now_ms,
                    node_id:          node_id.into(),
                    hostname:         hostname.into(),
                });
            }
        }
    }

    // ── Pattern G: Bandwidth Saturation ──────────────────────────────────
    // GPU compute utilization is low despite active inference and high memory
    // pressure — the GPU cores are stalled waiting for weights from VRAM/memory bus.
    // Uses 5-min window for recent state; 10-min window for WES session peak.
    {
        let min_gpu_density = (min_density_5m as f64 * 0.7) as usize;
        let gpu_samples: Vec<&&store::ObsSample> = window.iter()
            .filter(|s| s.gpu_util_pct.is_some())
            .collect();

        if gpu_samples.len() >= min_gpu_density {
            let avg_gpu_util: f64 = {
                let v: Vec<f64> = gpu_samples.iter().filter_map(|s| s.gpu_util_pct).collect();
                if v.is_empty() { 100.0 } else { obs_mean(&v) }
            };
            let tps_vals: Vec<f64> = window.iter().filter_map(|s| s.tps).collect();
            let avg_tps = if tps_vals.is_empty() { 0.0 } else { obs_mean(&tps_vals) };

            // GPU compute must be low AND inference active
            if avg_gpu_util < 45.0 && avg_tps >= 0.5 {
                // Thermals must be Normal — not a thermal issue
                let hot_count = window.iter()
                    .filter(|s| s.thermal_state.as_deref().map(|t| t != "Normal").unwrap_or(false))
                    .count();
                let hot_limit = (min_density_5m as f64 * 0.3) as usize;

                if hot_count <= hot_limit {
                    // Memory pressure: VRAM path (NVIDIA) or unified memory (Apple Silicon)
                    let vram_samples: Vec<&&store::ObsSample> = window.iter()
                        .filter(|s| s.vram_used_mb.is_some() && s.vram_total_mb.map(|v| v > 0).unwrap_or(false))
                        .collect();
                    let vram_density = (min_density_5m as f64 * 0.5) as usize;

                    let (mem_pressure_ok, vram_pct_display, mem_label) =
                        if vram_samples.len() >= vram_density {
                            let avg_vram_pct: f64 = {
                                let v: Vec<f64> = vram_samples.iter()
                                    .map(|s| s.vram_used_mb.unwrap() as f64 / s.vram_total_mb.unwrap() as f64 * 100.0)
                                    .collect();
                                obs_mean(&v)
                            };
                            (avg_vram_pct >= 80.0, avg_vram_pct, "VRAM")
                        } else {
                            let mem_vals: Vec<f64> = window.iter()
                                .filter_map(|s| s.mem_pressure_pct)
                                .collect();
                            if mem_vals.len() >= vram_density {
                                let avg_mem = obs_mean(&mem_vals);
                                (avg_mem >= 70.0, avg_mem, "memory")
                            } else {
                                (false, 0.0, "memory")
                            }
                        };

                    if mem_pressure_ok {
                        // WES drop: compare 10-min session peak vs 5-min recent
                        let compute_wes = |s: &&store::ObsSample| -> Option<f64> {
                            let tps = s.tps.filter(|&t| t > 0.0)?;
                            let watts = s.gpu_power_w.unwrap_or(0.0) + s.cpu_power_w.unwrap_or(0.0);
                            if watts <= 0.0 { return None; }
                            let penalty = s.penalty_avg.unwrap_or(1.0);
                            Some(tps / (watts * penalty))
                        };

                        let session_wes: Vec<f64> = long_window.iter().filter_map(compute_wes).collect();
                        let recent_wes:  Vec<f64> = window.iter().filter_map(compute_wes).collect();

                        if session_wes.len() >= 5 && recent_wes.len() >= (min_density_5m as f64 * 0.5) as usize {
                            let peak_wes   = session_wes.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                            let recent_avg = obs_mean(&recent_wes);
                            let wes_drop   = if peak_wes > 0.0 { (peak_wes - recent_avg) / peak_wes * 100.0 } else { 0.0 };

                            if wes_drop >= 35.0 {
                                let ratio = (gpu_samples.len() as f64 / min_density_5m as f64).min(1.0);
                                obs.push(LocalObservation {
                                    pattern_id:       "bandwidth_saturation",
                                    severity:         "warning",
                                    title:            "Bandwidth Saturation".into(),
                                    hook:             format!("{avg_gpu_util:.0}% GPU · {vram_pct_display:.0}% {mem_label} · −{wes_drop:.0}% WES"),
                                    body:             format!(
                                        "{hostname} is generating {avg_tps:.1} tok/s at only \
                                         {avg_gpu_util:.0}% GPU utilization with {vram_pct_display:.0}% \
                                         {mem_label} occupied. Thermals are Normal — the GPU cores are \
                                         idle waiting for model weight data from {mem_label}, not blocked \
                                         by compute or temperature. WES has dropped {wes_drop:.0}% from \
                                         its session peak. This is the {mem_label} bandwidth ceiling: \
                                         model weights saturate the bus faster than the GPU can consume them.",
                                    ),
                                    recommendation:   format!(
                                        "Reduce quantization (e.g. Q8 → Q4) to cut {mem_label} bandwidth \
                                         demand by ~50%, or switch to a lower parameter count model to \
                                         recover throughput.",
                                    ),
                                    resolution_steps: vec![
                                        format!("Confirm bottleneck: `curl http://localhost:7700/api/health | jq '{{gpu_util:.nvidia_gpu_utilization_percent,vram_used:.nvidia_vram_used_mb,vram_total:.nvidia_vram_total_mb}}'`"),
                                        "Switch to lower quantization to halve bandwidth demand: `ollama pull <model>:q4_K_M`".into(),
                                        "If already on Q4, try Q3_K_M or Q2_K — quality trade-off worth the bandwidth recovery".into(),
                                        "Reduce context window size — longer contexts increase KV cache weight streaming".into(),
                                        "Consider a hardware upgrade to a node with higher memory bandwidth for sustained relief".into(),
                                    ],
                                    action_id:        "switch_quantization",
                                    confidence:       obs_confidence(ratio),
                                    confidence_ratio: ratio,
                                    first_fired_ms:   now_ms,
                                    node_id:          node_id.into(),
                                    hostname:         hostname.into(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // ── Pattern I: Efficiency Penalty Drag ───────────────────────────────
    // WES penalty_avg is persistently elevated despite Normal thermals and active
    // GPU — indicates workload configuration overhead (context length, batch
    // fragmentation, KV cache pressure, MoE routing overhead).
    // Requires penalty_avg data (written by agent since Phase 2 migration).
    {
        let penalty_vals: Vec<f64> = window.iter().filter_map(|s| s.penalty_avg).collect();
        let min_pen_density = (min_density_5m as f64 * 0.7) as usize;

        if penalty_vals.len() >= min_pen_density {
            let avg_multiplier = obs_mean(&penalty_vals);
            // multiplier 1.0 = no penalty; skip early if no real overhead
            if avg_multiplier > 1.0 {
                // Efficiency loss fraction: 1 - (1/multiplier)
                // e.g. multiplier 1.75 → 43% loss
                let avg_penalty = 1.0 - (1.0 / avg_multiplier);

                if avg_penalty >= 0.30 {
                    let tps_vals: Vec<f64> = window.iter().filter_map(|s| s.tps).collect();
                    let avg_tps = if tps_vals.is_empty() { 0.0 } else { obs_mean(&tps_vals) };

                    if avg_tps >= 0.5 {
                        // Thermals must be Normal
                        let hot_count = window.iter()
                            .filter(|s| s.thermal_state.as_deref().map(|t| t != "Normal").unwrap_or(false))
                            .count();
                        let hot_limit = (min_density_5m as f64 * 0.3) as usize;

                        // GPU must be working (not decoupled — Pattern D territory)
                        let gpu_vals: Vec<f64> = window.iter().filter_map(|s| s.gpu_util_pct).collect();
                        let avg_gpu = if gpu_vals.len() >= (min_density_5m as f64 * 0.5) as usize {
                            obs_mean(&gpu_vals)
                        } else { 50.0 }; // assume ok if no GPU data

                        // Not memory-bound (not Pattern F or G territory)
                        let mem_vals: Vec<f64> = window.iter().filter_map(|s| s.mem_pressure_pct).collect();
                        let avg_mem = if mem_vals.is_empty() { 0.0 } else { obs_mean(&mem_vals) };

                        let vram_samples: Vec<&&store::ObsSample> = window.iter()
                            .filter(|s| s.vram_used_mb.is_some() && s.vram_total_mb.map(|v| v > 0).unwrap_or(false))
                            .collect();
                        let avg_vram_pct = if vram_samples.len() >= (min_density_5m as f64 * 0.5) as usize {
                            let v: Vec<f64> = vram_samples.iter()
                                .map(|s| s.vram_used_mb.unwrap() as f64 / s.vram_total_mb.unwrap() as f64 * 100.0)
                                .collect();
                            obs_mean(&v)
                        } else { 0.0 };

                        if hot_count <= hot_limit && avg_gpu >= 30.0 && avg_mem < 75.0 && avg_vram_pct < 80.0 {
                            let penalty_pct = (avg_penalty * 100.0) as u32;
                            let lost_tok_s  = avg_tps * (avg_multiplier - 1.0);

                            // Implied max WES without penalty
                            let wes_vals: Vec<f64> = window.iter()
                                .filter_map(|s| {
                                    let tps = s.tps.filter(|&t| t > 0.0)?;
                                    let watts = s.gpu_power_w.unwrap_or(0.0) + s.cpu_power_w.unwrap_or(0.0);
                                    if watts <= 0.0 { return None; }
                                    Some(tps / (watts * s.penalty_avg.unwrap_or(1.0)))
                                })
                                .collect();
                            let avg_wes     = if wes_vals.is_empty() { None } else { Some(obs_mean(&wes_vals)) };
                            let implied_max = avg_wes.map(|w| w * avg_multiplier);

                            let ratio = (penalty_vals.len() as f64 / min_density_5m as f64).min(1.0);
                            obs.push(LocalObservation {
                                pattern_id:       "efficiency_drag",
                                severity:         "warning",
                                title:            "Efficiency Penalty Drag".into(),
                                hook:             format!("{penalty_pct}% WES penalty · {lost_tok_s:.1} tok/s headroom being lost"),
                                body:             format!(
                                    "{hostname} is sustaining a {penalty_pct}% WES efficiency penalty \
                                     despite Normal thermals, active GPU utilization, and no memory \
                                     saturation. The penalty_avg field captures overhead not caused by \
                                     heat or bandwidth — context window size, batch fragmentation, \
                                     KV cache pressure, or expert routing overhead in MoE models.{}",
                                    match implied_max.zip(avg_wes) {
                                        Some((imp, cur)) => format!(" Without this penalty, WES would be ~{imp:.0} (current: {cur:.0})."),
                                        None => String::new(),
                                    }
                                ),
                                recommendation:   "This penalty is recoverable through workload \
                                                   configuration. Reduce maximum context window to the \
                                                   shortest that meets quality needs, and increase batch \
                                                   concurrency slightly to better saturate the GPU pipeline. \
                                                   If using a MoE model (e.g. Mixtral), ensure all experts \
                                                   are VRAM-resident.".into(),
                                resolution_steps: vec![
                                    "Check penalty: `curl http://localhost:7700/api/health | jq .penalty_avg` — confirm consistently > 1.30".into(),
                                    "Reduce context window: lower max_tokens or num_ctx to 2048–4096 in your application".into(),
                                    "Increase batch slightly: OLLAMA_NUM_PARALLEL=2 (more concurrent reqs fill GPU pipeline bubbles)".into(),
                                    "MoE models (Mixtral, Qwen-MoE): verify all expert weights are VRAM-resident with `ollama ps`".into(),
                                    "vLLM: enable --enable-chunked-prefill to reduce KV cache fragmentation from variable-length requests".into(),
                                ],
                                action_id:        "reduce_batch_size",
                                confidence:       obs_confidence(ratio),
                                confidence_ratio: ratio,
                                first_fired_ms:   now_ms,
                                node_id:          node_id.into(),
                                hostname:         hostname.into(),
                            });
                        }
                    }
                }
            }
        }
    }

    // ── Pattern M: vLLM KV Cache Saturation ──────────────────────────────
    // vLLM's KV cache is persistently full — the scheduler cannot admit new
    // sequences; requests queue, get preempted, or return 503.
    // Uses 5-min window; only fires on nodes running vLLM (field is None elsewhere).
    {
        let cache_vals: Vec<f64> = window.iter()
            .filter_map(|s| s.vllm_cache_usage_perc)
            .collect();
        let min_cache_density = (min_density_5m as f64 * 0.7) as usize;

        if cache_vals.len() >= min_cache_density {
            let saturated_count = cache_vals.iter().filter(|&&v| v > 90.0).count();
            let min_saturated   = (cache_vals.len() as f64 * 0.7) as usize;

            if saturated_count >= min_saturated {
                let avg_cache: f64 = cache_vals.iter()
                    .filter(|&&v| v > 90.0)
                    .sum::<f64>() / saturated_count as f64;

                // Check for back-pressure from queue_depth
                let queue_vals: Vec<f64> = window.iter()
                    .filter_map(|s| s.queue_depth.filter(|&q| q > 0).map(|q| q as f64))
                    .collect();
                let avg_queue = if queue_vals.is_empty() { 0.0 } else { obs_mean(&queue_vals) };

                let ratio = (cache_vals.len() as f64 / min_density_5m as f64).min(1.0);
                obs.push(LocalObservation {
                    pattern_id:       "vllm_kv_cache_saturation",
                    severity:         "warning",
                    title:            "vLLM KV Cache Saturation".into(),
                    hook:             format!("{avg_cache:.0}% KV cache full"),
                    body:             format!(
                        "{hostname}'s vLLM KV cache has been above 90% for the last 5 min \
                         (avg {avg_cache:.1}%). When the cache fills, the scheduler cannot \
                         admit new sequences — incoming requests queue, get preempted, or \
                         return 503.{}",
                        if avg_queue > 0.0 {
                            format!(" Currently {avg_queue:.0} requests queued on average — confirming back-pressure.")
                        } else { String::new() }
                    ),
                    recommendation:   "Reduce concurrent load: lower --max-num-seqs or \
                                       --max-num-batched-tokens to free KV cache headroom. \
                                       If demand is sustained, scale horizontally or switch \
                                       to a smaller model/quantization.".into(),
                    resolution_steps: vec![
                        "Check KV cache: `curl http://localhost:7700/api/health | jq .vllm_cache_usage_perc`".into(),
                        "Reduce concurrent sequences: restart vLLM with --max-num-seqs 4 (default is often 256)".into(),
                        "Lower batched tokens: --max-num-batched-tokens 2048 reduces per-batch KV footprint".into(),
                        "Long contexts: --max-model-len to cap per-sequence KV allocation".into(),
                        "Monitor: `watch -n 5 \"curl -s http://localhost:7700/api/health | jq .vllm_cache_usage_perc\"`".into(),
                    ],
                    action_id:        "reduce_batch_size",
                    confidence:       obs_confidence(ratio),
                    confidence_ratio: ratio,
                    first_fired_ms:   now_ms,
                    node_id:          node_id.into(),
                    hostname:         hostname.into(),
                });
            }
        }
    }

    // ── Pattern P: TTFT Regression ───────────────────────────────────────
    // Time-to-first-token is trending upward, indicating growing inference
    // latency for users — KV cache thrash, memory pressure, or queue build-up.
    // Uses 10-min window; requires ≥ 10 samples with valid ttft_ms.
    {
        let ttft_vals: Vec<(usize, f64)> = long_window.iter()
            .enumerate()
            .filter_map(|(i, s)| s.ttft_ms.map(|v| (i, v)))
            .collect();

        if ttft_vals.len() >= 10 {
            // Rebuild as sequential values for OLS (use position-in-window, not ts)
            let ttft_seq: Vec<f64> = ttft_vals.iter().map(|(_, v)| *v).collect();
            let mean_ttft = obs_mean(&ttft_seq);

            // OLS slope using sample index as X-axis; convert to ms/min
            // Each sample ~ 1s, so slope_per_sample * 60 = slope_per_min
            let n = ttft_seq.len() as f64;
            let x_mean = (n - 1.0) / 2.0;
            let slope_raw: f64 = {
                let num: f64 = ttft_seq.iter().enumerate()
                    .map(|(i, &y)| (i as f64 - x_mean) * (y - mean_ttft))
                    .sum();
                let den: f64 = ttft_seq.iter().enumerate()
                    .map(|(i, _)| (i as f64 - x_mean).powi(2))
                    .sum();
                if den.abs() < 1e-9 { 0.0 } else { num / den }
            };
            // Samples are sparse (only on inference), estimate spacing at ~10s avg
            let slope_per_min = slope_raw * 6.0;

            // Recent tail: last 30% of ttft samples vs full mean
            let tail_start = (ttft_seq.len() as f64 * 0.70) as usize;
            let tail_vals: Vec<f64> = ttft_seq[tail_start..].to_vec();
            let tail_mean = if tail_vals.is_empty() { mean_ttft } else { obs_mean(&tail_vals) };

            let is_critical = slope_per_min > 25.0 || tail_mean > 2000.0;
            let fire = (slope_per_min > 5.0 && mean_ttft > 100.0) || tail_mean > 2000.0;

            if fire {
                let ratio = ((ttft_vals.len() as f64 - 10.0) / 50.0).min(1.0).max(0.3);
                obs.push(LocalObservation {
                    pattern_id:       "ttft_regression",
                    severity:         if is_critical { "critical" } else { "warning" },
                    title:            "TTFT Regression".into(),
                    hook:             format!("TTFT +{slope_per_min:.0} ms/min, avg {mean_ttft:.0} ms"),
                    body:             format!(
                        "{hostname}'s time-to-first-token is trending upward (+{slope_per_min:.0} ms/min). \
                         Current mean TTFT is {mean_ttft:.0} ms{}. \
                         Likely causes: KV cache eviction under memory pressure, growing request queue, \
                         or context window expansion.",
                        if tail_mean > mean_ttft * 1.3 {
                            format!(" with recent tail at {tail_mean:.0} ms")
                        } else { String::new() },
                    ),
                    recommendation:   if is_critical {
                        "TTFT is critically high or accelerating fast. Reduce concurrent requests, \
                         check vLLM queue depth, and consider a shorter context window or smaller batch size.".into()
                    } else {
                        "Monitor for continued TTFT growth. Check KV cache hit rate and memory pressure. \
                         Reducing max_model_len or increasing GPU VRAM allocation can stabilize TTFT.".into()
                    },
                    resolution_steps: vec![
                        "vLLM queue: `curl http://localhost:18010/metrics | grep vllm:num_requests_waiting`".into(),
                        "vLLM KV cache: `curl http://localhost:18010/metrics | grep vllm:gpu_cache_usage_perc`".into(),
                        "Reduce concurrent load: lower `--max-num-seqs` in vLLM launch args".into(),
                        "Check memory pressure: `curl http://localhost:7700/api/health | jq .mem_pressure_pct`".into(),
                    ],
                    action_id:        "check_inference_latency",
                    confidence:       obs_confidence(ratio),
                    confidence_ratio: ratio,
                    first_fired_ms:   now_ms,
                    node_id:          node_id.into(),
                    hostname:         hostname.into(),
                });
            }
        }
    }

    // ── Pattern Q: Latency Spike ─────────────────────────────────────────
    // E2E inference latency has spiked significantly compared to the window
    // baseline — indicates sudden degradation (thermal event, preemption, swap).
    // Uses 10-min window; requires ≥ 10 samples with valid avg_latency_ms.
    {
        let lat_vals: Vec<f64> = long_window.iter()
            .filter_map(|s| s.avg_latency_ms)
            .collect();

        if lat_vals.len() >= 10 {
            let baseline_end = (lat_vals.len() as f64 * 0.60) as usize;
            let baseline: Vec<f64> = lat_vals[..baseline_end].to_vec();
            let recent:   Vec<f64> = lat_vals[baseline_end..].to_vec();

            let baseline_mean = obs_mean(&baseline);
            let recent_mean   = obs_mean(&recent);

            // Spike ratio: how much worse is the recent window vs baseline?
            let spike_ratio = if baseline_mean > 1.0 {
                recent_mean / baseline_mean
            } else { 1.0 };

            let is_critical = spike_ratio > 3.0 || recent_mean > 10_000.0;
            // Fire if recent is 1.5× baseline AND recent is meaningfully slow
            let fire = spike_ratio >= 1.5 && recent_mean > 500.0;

            if fire {
                let ratio = ((spike_ratio - 1.5) / 1.5).min(1.0).max(0.3);
                obs.push(LocalObservation {
                    pattern_id:       "latency_spike",
                    severity:         if is_critical { "critical" } else { "warning" },
                    title:            "Inference Latency Spike".into(),
                    hook:             format!("Latency {spike_ratio:.1}× baseline ({recent_mean:.0} ms)"),
                    body:             format!(
                        "{hostname} is experiencing a {spike_ratio:.1}× spike in E2E inference latency \
                         (recent: {recent_mean:.0} ms vs baseline: {baseline_mean:.0} ms). \
                         Common causes: thermal throttling, swap I/O, model preemption, or sudden increase \
                         in concurrent requests.",
                    ),
                    recommendation:   if is_critical {
                        "Latency has degraded critically. Investigate thermal state, memory pressure, \
                         and swap usage. Consider restarting the inference server if it does not recover.".into()
                    } else {
                        "Check for correlated thermal events or memory pressure spikes that may have \
                         caused this latency increase. Monitor over the next few minutes for recovery.".into()
                    },
                    resolution_steps: vec![
                        "Check thermal state: `curl http://localhost:7700/api/health | jq .thermal_state`".into(),
                        "Check swap: `curl http://localhost:7700/api/health | jq .swap_write_mb_s`".into(),
                        "vLLM preemption metric: `curl http://localhost:18010/metrics | grep vllm:num_preemptions`".into(),
                        "Ollama running requests: `curl http://localhost:11434/api/ps`".into(),
                    ],
                    action_id:        "check_inference_latency",
                    confidence:       obs_confidence(ratio),
                    confidence_ratio: ratio,
                    first_fired_ms:   now_ms,
                    node_id:          node_id.into(),
                    hostname:         hostname.into(),
                });
            }
        }
    }

    // ── Pattern R: vLLM Queue Saturation ────────────────────────────────
    // vLLM's waiting request queue is persistently backlogged, meaning the
    // GPU cannot drain requests as fast as they arrive.
    // Uses 5-min window; requires ≥ 10 samples with valid queue_depth.
    // Only fires on nodes running vLLM (queue_depth is None for Ollama/llama.cpp).
    {
        let queue_vals: Vec<f64> = window.iter()
            .filter_map(|s| s.queue_depth.map(|q| q as f64))
            .collect();

        if queue_vals.len() >= 10 {
            let avg_queue = obs_mean(&queue_vals);
            let max_queue = queue_vals.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

            // OLS slope to detect queue growth vs steady state
            let slope = obs_linear_slope(&queue_vals); // requests/sample (~1s), so /min = *60
            let slope_per_min = slope * 60.0;

            let is_critical = max_queue >= 10.0 || (avg_queue >= 5.0 && slope_per_min > 0.5);
            let fire = avg_queue >= 3.0 || max_queue >= 8.0;

            if fire {
                let ratio = ((avg_queue - 3.0) / 7.0).min(1.0).max(0.3);
                obs.push(LocalObservation {
                    pattern_id:       "vllm_queue_saturation",
                    severity:         if is_critical { "critical" } else { "warning" },
                    title:            "vLLM Queue Saturation".into(),
                    hook:             format!("avg {avg_queue:.1} waiting requests (max {max_queue:.0})"),
                    body:             format!(
                        "{hostname}'s vLLM request queue is backed up with an average of {avg_queue:.1} \
                         waiting requests (max: {max_queue:.0}){}. \
                         The GPU cannot service requests as fast as they arrive — throughput is \
                         degraded and latency will increase.",
                        if slope_per_min > 0.1 {
                            format!(" and growing at +{slope_per_min:.1} req/min")
                        } else { String::new() },
                    ),
                    recommendation:   if is_critical {
                        "Queue is critically saturated. Increase `--max-num-seqs`, reduce max context \
                         length, or scale out to additional nodes. Consider enabling chunked prefill to \
                         improve scheduling fairness.".into()
                    } else {
                        "Queue is accumulating faster than it drains. Review request arrival rate and \
                         consider tuning `--max-num-seqs` or `--max-num-batched-tokens` for this workload.".into()
                    },
                    resolution_steps: vec![
                        "vLLM queue metrics: `curl http://localhost:18010/metrics | grep -E 'num_requests_(running|waiting|swapped)'`".into(),
                        "Increase throughput: raise `--max-num-seqs` in vLLM launch args (watch VRAM)".into(),
                        "Enable chunked prefill: add `--enable-chunked-prefill` to vLLM args".into(),
                        "Scale out: register additional vLLM nodes in Wicklee fleet".into(),
                    ],
                    action_id:        "check_vllm_queue",
                    confidence:       obs_confidence(ratio),
                    confidence_ratio: ratio,
                    first_fired_ms:   now_ms,
                    node_id:          node_id.into(),
                    hostname:         hostname.into(),
                });
            }
        }
    }

    obs
}

/// Pattern O — VRAM Overcommit.  Point-in-time check: fires when the loaded
/// model consumes >90% of available GPU memory (NVIDIA VRAM or Apple unified).
/// Community tier, action_id = switch_quantization.
#[cfg(not(target_env = "musl"))]
fn evaluate_vram_overcommit(
    ollama: &OllamaMetrics,
    nvidia: &NvidiaMetrics,
    apple:  &AppleSiliconMetrics,
    node_id:  &str,
    hostname: &str,
) -> Option<LocalObservation> {
    let model_gb = ollama.ollama_model_size_gb?;
    if model_gb <= 0.0 { return None; }

    // Resolve VRAM capacity: NVIDIA total → Apple unified memory budget
    let vram_gb = nvidia.nvidia_vram_total_mb
        .filter(|&v| v >= 1024) // ≥1 GB = real GPU
        .map(|v| v as f64 / 1024.0)
        .or_else(|| apple.gpu_wired_limit_mb
            .filter(|&v| v > 0)
            .map(|v| v as f64 / 1024.0))?;

    let usage_pct = (model_gb as f64 / vram_gb) * 100.0;
    if usage_pct < 90.0 { return None; }

    let headroom_gb = vram_gb - model_gb as f64;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let is_critical = usage_pct >= 98.0;
    let os_name = {
        #[cfg(target_os = "macos")]   { "macOS" }
        #[cfg(target_os = "linux")]   { "Linux" }
        #[cfg(target_os = "windows")] { "Windows" }
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        { "Unknown" }
    };

    let resolution_steps = if nvidia.nvidia_vram_total_mb.filter(|&v| v >= 1024).is_some() {
        vec![
            "Check VRAM: `nvidia-smi --query-gpu=memory.total,memory.used,memory.free --format=csv,noheader`".into(),
            "List loaded models: `ollama ps`".into(),
            "Pull smaller quantization: `ollama pull <model>:q4_K_M`".into(),
            "Unload competing models: `ollama stop <model_name>`".into(),
        ]
    } else {
        vec![
            format!("Check GPU memory budget: `sysctl iogpu.wired_limit_mb` (current: {:.1} GB)", vram_gb),
            "List loaded models: `ollama ps`".into(),
            "Pull smaller quantization: `ollama pull <model>:q4_K_M`".into(),
            "Unload competing models: `ollama stop <model_name>`".into(),
        ]
    };

    Some(LocalObservation {
        pattern_id:       "vram_overcommit",
        severity:         if is_critical { "critical" } else { "warning" },
        title:            "VRAM Overcommit".into(),
        hook:             format!("{usage_pct:.0}% VRAM used ({headroom_gb:.1} GB free)"),
        body:             format!(
            "{hostname}'s loaded model ({model_gb:.1} GB) consumes {usage_pct:.0}% of the \
             {vram_gb:.1} GB {os_name} GPU memory budget, leaving only {headroom_gb:.1} GB headroom. \
             Inference will spill to system RAM, causing severe throughput degradation and swap pressure.",
        ),
        recommendation:   if is_critical {
            "GPU memory is near-exhausted. Immediately switch to a smaller quantization variant \
             (e.g. q4_K_M) or unload competing models to restore headroom.".into()
        } else {
            "Model is close to the VRAM ceiling. Consider pulling a smaller quantization variant \
             to leave headroom for KV cache and batch processing.".into()
        },
        resolution_steps,
        action_id:        "switch_quantization",
        confidence:       "high",
        confidence_ratio: 1.0,
        first_fired_ms:   now_ms,
        node_id:          node_id.into(),
        hostname:         hostname.into(),
    })
}

/// Newtype wrapper for the node_id Extension so it doesn't collide with other Arc<String>.
#[derive(Clone)]
struct NodeId(Arc<String>);

#[cfg(not(target_env = "musl"))]
async fn handle_observations(
    axum::extract::Extension(obs_cache): axum::extract::Extension<ObservationCache>,
) -> impl IntoResponse {
    // Return the latest cached observations from the 10 s evaluator task.
    let observations = obs_cache.lock().map(|c| c.clone()).unwrap_or_default();
    Json(serde_json::json!({ "observations": observations })).into_response()
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

// ── MCP Server ───────────────────────────────────────────────────────────────
// JSON-RPC 2.0 endpoint for AI agent consumption (Cursor, Claude Desktop, etc.).
// Wraps existing sensor data — no new shared state, no new dependencies.

async fn handle_mcp_manifest() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "schema_version": "2024-11-05",
        "name": "wicklee-agent",
        "version": env!("CARGO_PKG_VERSION"),
        "description": "Sovereign GPU fleet monitor — hardware telemetry, inference state, WES efficiency scores, and observation patterns for local AI inference nodes.",
        "transport": { "type": "http", "url": "/mcp" },
        "capabilities": {
            "tools": true,
            "resources": true,
        }
    }))
}

fn mcp_tools_list() -> serde_json::Value {
    serde_json::json!([
        {
            "name": "get_node_status",
            "description": "Returns a full snapshot of the node's current hardware and inference metrics — CPU, GPU, memory, power, thermal state, inference state, active model, WES penalty, tok/s, and more.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "get_inference_state",
            "description": "Returns the node's current inference state (live, idle-spd, busy, or idle) with context about which detection tier matched and the relevant sensor values.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "get_active_models",
            "description": "Returns a list of currently loaded AI models across all detected runtimes (Ollama, vLLM, llama.cpp) with model names, sizes, and inference activity.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "get_observations",
            "description": "Evaluates local hardware observation patterns (Thermal Drain, Phantom Load, Swap Pressure, PCIe Degradation) against the 1-hour DuckDB buffer. Returns any active observations with severity, evidence, and recommended actions.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "get_metrics_history",
            "description": "Returns the 1-hour rolling metrics history from the local DuckDB store. Includes tok/s, GPU%, power, memory pressure, and swap over time.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "minutes": {
                        "type": "integer",
                        "description": "How many minutes of history to return (1-60, default 60)"
                    }
                }
            }
        }
    ])
}

fn mcp_resources_list() -> serde_json::Value {
    serde_json::json!([
        {
            "uri": "wicklee://node/metrics",
            "name": "Live Metrics Snapshot",
            "description": "Current MetricsPayload — full hardware + inference telemetry for this node.",
            "mimeType": "application/json"
        },
        {
            "uri": "wicklee://node/thermal",
            "name": "Thermal State",
            "description": "Current thermal state, WES penalty values, thermal source, and sample count.",
            "mimeType": "application/json"
        }
    ])
}

/// Build a MetricsPayload snapshot from shared sensor state.
/// Used by both the 1 Hz broadcaster and the MCP handler.
fn build_mcp_node_snapshot(
    apple: &AppleSiliconMetrics,
    nvidia: &NvidiaMetrics,
    ollama: &OllamaMetrics,
    vllm: &VllmMetrics,
    llamacpp: &LlamacppMetrics,
    wes: &WesMetrics,
    rapl_power: Option<f32>,
    linux_thermal: &Option<LinuxThermalResult>,
    swap_mb_s: Option<f32>,
    probe_active: &std::sync::atomic::AtomicBool,
    cpu_usage: f32,
    total_mb: u64,
    used_mb: u64,
    available_mb: u64,
    core_count: usize,
    node_id: &str,
    hostname: &str,
    proxy_listen: Option<u16>,
    proxy_target: Option<u16>,
    _runtime_overrides: Option<String>,
    model_baseline: Option<(f32, f32, u32)>,
) -> serde_json::Value {
    let hw = read_hardware_signals(apple, nvidia, ollama, vllm, llamacpp,
        &Arc::new(std::sync::atomic::AtomicBool::new(
            probe_active.load(std::sync::atomic::Ordering::Relaxed)
        )));
    let inference_state_val = compute_inference_state(&hw).to_string();
    let thermal = resolve_thermal_state(&apple.thermal_state, linux_thermal, cpu_usage);

    serde_json::json!({
        "node_id": node_id,
        "hostname": hostname,
        "gpu_name": nvidia.nvidia_gpu_name.as_deref().or(apple.gpu_name.as_deref()),
        "cpu_usage_percent": cpu_usage,
        "total_memory_mb": total_mb,
        "used_memory_mb": used_mb,
        "available_memory_mb": available_mb,
        "cpu_core_count": core_count,
        "timestamp_ms": now_ms(),
        "cpu_power_w": apple.cpu_power_w.or(rapl_power),
        "apple_soc_power_w": apple.soc_power_w,
        "apple_gpu_power_w": apple.gpu_power_w,
        "gpu_utilization_percent": apple.gpu_utilization_percent,
        "memory_pressure_percent": apple.memory_pressure_percent,
        "thermal_state": thermal,
        "nvidia_gpu_utilization_percent": nvidia.nvidia_gpu_utilization_percent,
        "nvidia_vram_used_mb": nvidia.nvidia_vram_used_mb,
        "nvidia_vram_total_mb": nvidia.nvidia_vram_total_mb,
        "nvidia_gpu_temp_c": nvidia.nvidia_gpu_temp_c,
        "nvidia_power_draw_w": nvidia.nvidia_power_draw_w,
        "ollama_running": ollama.ollama_running,
        "ollama_active_model": ollama.ollama_active_model,
        "ollama_tokens_per_second": ollama.ollama_tokens_per_second,
        "ollama_inference_active": ollama.ollama_inference_active,
        "ollama_prompt_eval_tps": ollama.ollama_prompt_eval_tps,
        "ollama_ttft_ms": ollama.ollama_ttft_ms,
        "vllm_running": vllm.vllm_running,
        "vllm_model_name": vllm.vllm_model_name,
        "vllm_tokens_per_sec": vllm.vllm_tokens_per_sec,
        "vllm_cache_usage_perc": vllm.vllm_cache_usage_perc,
        "vllm_requests_waiting": vllm.vllm_requests_waiting,
        "vllm_avg_ttft_ms": vllm.vllm_avg_ttft_ms,
        "vllm_avg_e2e_latency_ms": vllm.vllm_avg_e2e_latency_ms,
        "llamacpp_running": llamacpp.llamacpp_running,
        "llamacpp_model_name": llamacpp.llamacpp_model_name,
        "llamacpp_tokens_per_sec": llamacpp.llamacpp_tokens_per_sec,
        "inference_state": inference_state_val,
        "penalty_avg": wes.penalty_avg,
        "penalty_peak": wes.penalty_peak,
        "thermal_source": wes.thermal_source,
        "swap_write_mb_s": swap_mb_s,
        "proxy_listen_port": proxy_listen,
        "proxy_target_port": proxy_target,
        "model_baseline_tps": model_baseline.map(|b| b.0),
        "model_baseline_wes": model_baseline.map(|b| b.1),
        "agent_version": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}

async fn handle_mcp(
    axum::extract::Extension(apple_metrics):         axum::extract::Extension<Arc<Mutex<AppleSiliconMetrics>>>,
    axum::extract::Extension(nvidia_metrics):        axum::extract::Extension<Arc<Mutex<NvidiaMetrics>>>,
    axum::extract::Extension(ollama_metrics):        axum::extract::Extension<Arc<Mutex<OllamaMetrics>>>,
    axum::extract::Extension(rapl_metrics):          axum::extract::Extension<Arc<Mutex<Option<f32>>>>,
    axum::extract::Extension(linux_thermal_metrics): axum::extract::Extension<Arc<Mutex<Option<LinuxThermalResult>>>>,
    axum::extract::Extension(vllm_metrics):          axum::extract::Extension<Arc<Mutex<VllmMetrics>>>,
    axum::extract::Extension(llamacpp_metrics):      axum::extract::Extension<Arc<Mutex<LlamacppMetrics>>>,
    axum::extract::Extension(wes_metrics):           axum::extract::Extension<Arc<Mutex<WesMetrics>>>,
    axum::extract::Extension(swap_metrics):          axum::extract::Extension<SwapMetrics>,
    axum::extract::Extension(probe_active):          axum::extract::Extension<Arc<std::sync::atomic::AtomicBool>>,
    axum::extract::Extension(proxy_ports):           axum::extract::Extension<ProxyPorts>,
    axum::extract::Extension(node_id):               axum::extract::Extension<NodeId>,
    Json(req): Json<JsonRpcRequest>,
) -> Json<JsonRpcResponse> {
    let id = req.id.clone();

    // Helper: read all shared state into local snapshots.
    let read_snapshot = || -> serde_json::Value {
        let apple    = apple_metrics.lock().map(|g| g.clone()).unwrap_or_default();
        let nvidia   = nvidia_metrics.lock().map(|g| g.clone()).unwrap_or_default();
        let ollama   = ollama_metrics.lock().map(|g| g.clone()).unwrap_or_default();
        let vllm     = vllm_metrics.lock().map(|g| g.clone()).unwrap_or_default();
        let llamacpp = llamacpp_metrics.lock().map(|g| g.clone()).unwrap_or_default();
        let wes      = wes_metrics.lock().map(|g| g.clone()).unwrap_or_default();
        let rapl     = rapl_metrics.lock().map(|g| *g).unwrap_or(None);
        let lt       = linux_thermal_metrics.lock().map(|g| g.clone()).unwrap_or(None);
        let swap     = swap_metrics.read();
        let hostname = sysinfo::System::host_name().unwrap_or_else(|| node_id.0.to_string());

        // Get basic system info
        let mut sys = sysinfo::System::new_all();
        sys.refresh_memory();
        let total = sys.total_memory() / 1024 / 1024;
        let used  = sys.used_memory()  / 1024 / 1024;

        build_mcp_node_snapshot(
            &apple, &nvidia, &ollama, &vllm, &llamacpp, &wes,
            rapl, &lt, swap, &probe_active, sys.global_cpu_info().cpu_usage(),
            total, used, total.saturating_sub(used), sys.cpus().len(),
            &node_id.0, &hostname,
            proxy_ports.listen, proxy_ports.target, proxy_ports.runtime_overrides.clone(),
            None, // model_baseline — not wired through Extension, acceptable for MCP
        )
    };

    match req.method.as_str() {
        // ── Protocol lifecycle ───────────────────────────────────────────────
        "initialize" => Json(JsonRpcResponse::success(id, serde_json::json!({
            "protocolVersion": "2024-11-05",
            "serverInfo": {
                "name": "wicklee-agent",
                "version": env!("CARGO_PKG_VERSION"),
            },
            "capabilities": {
                "tools": { "listChanged": false },
                "resources": { "listChanged": false },
            }
        }))),

        "notifications/initialized" => Json(JsonRpcResponse::success(id, serde_json::json!({}))),

        // ── Tools ────────────────────────────────────────────────────────────
        "tools/list" => Json(JsonRpcResponse::success(id, serde_json::json!({
            "tools": mcp_tools_list()
        }))),

        "tools/call" => {
            let tool_name = req.params.as_ref()
                .and_then(|p| p.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("");

            match tool_name {
                "get_node_status" => {
                    let snapshot = read_snapshot();
                    Json(JsonRpcResponse::success(id, serde_json::json!({
                        "content": [{ "type": "text", "text": serde_json::to_string_pretty(&snapshot).unwrap_or_default() }]
                    })))
                }

                "get_inference_state" => {
                    let apple    = apple_metrics.lock().map(|g| g.clone()).unwrap_or_default();
                    let nvidia   = nvidia_metrics.lock().map(|g| g.clone()).unwrap_or_default();
                    let ollama   = ollama_metrics.lock().map(|g| g.clone()).unwrap_or_default();
                    let vllm     = vllm_metrics.lock().map(|g| g.clone()).unwrap_or_default();
                    let llamacpp = llamacpp_metrics.lock().map(|g| g.clone()).unwrap_or_default();
                    let wes      = wes_metrics.lock().map(|g| g.clone()).unwrap_or_default();

                    let hw = read_hardware_signals(&apple, &nvidia, &ollama, &vllm, &llamacpp, &probe_active);
                    let state = compute_inference_state(&hw);

                    let result = serde_json::json!({
                        "inference_state": state.to_string(),
                        "signals": {
                            "vllm_requests": hw.vllm_requests,
                            "apple_gpu_pct": hw.apple_gpu_pct,
                            "nvidia_gpu_pct": hw.nvidia_gpu_pct,
                            "soc_power_w": hw.soc_power_w,
                            "nvidia_power_w": hw.nvidia_power_w,
                            "ai_runtime_loaded": hw.ai_runtime_loaded,
                        },
                        "active_model": ollama.ollama_active_model.as_deref()
                            .or(vllm.vllm_model_name.as_deref())
                            .or(llamacpp.llamacpp_model_name.as_deref()),
                        "tokens_per_second": ollama.ollama_tokens_per_second
                            .or(vllm.vllm_tokens_per_sec)
                            .or(llamacpp.llamacpp_tokens_per_sec),
                        "wes_penalty": wes.penalty_avg,
                        "thermal_source": wes.thermal_source,
                    });
                    Json(JsonRpcResponse::success(id, serde_json::json!({
                        "content": [{ "type": "text", "text": serde_json::to_string_pretty(&result).unwrap_or_default() }]
                    })))
                }

                "get_active_models" => {
                    let ollama   = ollama_metrics.lock().map(|g| g.clone()).unwrap_or_default();
                    let vllm     = vllm_metrics.lock().map(|g| g.clone()).unwrap_or_default();
                    let llamacpp = llamacpp_metrics.lock().map(|g| g.clone()).unwrap_or_default();

                    let mut models = Vec::new();
                    if ollama.ollama_running {
                        models.push(serde_json::json!({
                            "runtime": "ollama",
                            "model": ollama.ollama_active_model,
                            "size_gb": ollama.ollama_model_size_gb,
                            "inference_active": ollama.ollama_inference_active,
                            "tokens_per_second": ollama.ollama_tokens_per_second,
                            "quantization": ollama.ollama_quantization,
                        }));
                    }
                    if vllm.vllm_running {
                        models.push(serde_json::json!({
                            "runtime": "vllm",
                            "model": vllm.vllm_model_name,
                            "tokens_per_second": vllm.vllm_tokens_per_sec,
                            "requests_running": vllm.vllm_requests_running,
                            "requests_waiting": vllm.vllm_requests_waiting,
                            "cache_usage_pct": vllm.vllm_cache_usage_perc,
                        }));
                    }
                    if llamacpp.llamacpp_running {
                        models.push(serde_json::json!({
                            "runtime": "llamacpp",
                            "model": llamacpp.llamacpp_model_name,
                            "tokens_per_second": llamacpp.llamacpp_tokens_per_sec,
                            "slots_processing": llamacpp.llamacpp_slots_processing,
                        }));
                    }

                    Json(JsonRpcResponse::success(id, serde_json::json!({
                        "content": [{ "type": "text", "text": serde_json::to_string_pretty(&models).unwrap_or_default() }]
                    })))
                }

                "get_observations" | "get_metrics_history" => {
                    // These require DuckDB — return a helpful message on musl/no-store builds.
                    #[cfg(not(target_env = "musl"))]
                    {
                        // Note: DuckDB store is wired as an Extension only on store-backed routes.
                        // For MCP, we return a message directing users to the REST endpoint.
                        let msg = if tool_name == "get_observations" {
                            "Local observations are available via GET /api/observations. The MCP handler does not have direct DuckDB access — use the REST endpoint or the wicklee://node/metrics resource for current state."
                        } else {
                            "Metrics history is available via GET /api/history?node_id=<id>&minutes=60. The MCP handler proxies to the live snapshot — use the REST endpoint for historical data."
                        };
                        Json(JsonRpcResponse::success(id, serde_json::json!({
                            "content": [{ "type": "text", "text": msg }]
                        })))
                    }
                    #[cfg(target_env = "musl")]
                    {
                        Json(JsonRpcResponse::success(id, serde_json::json!({
                            "content": [{ "type": "text", "text": "DuckDB is not available on this build (musl). Historical data and observations require the standard build." }]
                        })))
                    }
                }

                _ => Json(JsonRpcResponse::error(id, -32601, format!("Unknown tool: {tool_name}"))),
            }
        }

        // ── Resources ────────────────────────────────────────────────────────
        "resources/list" => Json(JsonRpcResponse::success(id, serde_json::json!({
            "resources": mcp_resources_list()
        }))),

        "resources/read" => {
            let uri = req.params.as_ref()
                .and_then(|p| p.get("uri"))
                .and_then(|u| u.as_str())
                .unwrap_or("");

            match uri {
                "wicklee://node/metrics" => {
                    let snapshot = read_snapshot();
                    Json(JsonRpcResponse::success(id, serde_json::json!({
                        "contents": [{
                            "uri": "wicklee://node/metrics",
                            "mimeType": "application/json",
                            "text": serde_json::to_string_pretty(&snapshot).unwrap_or_default()
                        }]
                    })))
                }

                "wicklee://node/thermal" => {
                    let apple = apple_metrics.lock().map(|g| g.clone()).unwrap_or_default();
                    let wes   = wes_metrics.lock().map(|g| g.clone()).unwrap_or_default();
                    let lt    = linux_thermal_metrics.lock().map(|g| g.clone()).unwrap_or(None);

                    let thermal = serde_json::json!({
                        "thermal_state": resolve_thermal_state(&apple.thermal_state, &lt, 0.0),
                        "penalty_avg": wes.penalty_avg,
                        "penalty_peak": wes.penalty_peak,
                        "thermal_source": wes.thermal_source,
                        "sample_count": wes.sample_count,
                    });
                    Json(JsonRpcResponse::success(id, serde_json::json!({
                        "contents": [{
                            "uri": "wicklee://node/thermal",
                            "mimeType": "application/json",
                            "text": serde_json::to_string_pretty(&thermal).unwrap_or_default()
                        }]
                    })))
                }

                _ => Json(JsonRpcResponse::error(id, -32602, format!("Unknown resource: {uri}"))),
            }
        }

        // ── Unknown method ───────────────────────────────────────────────────
        _ => Json(JsonRpcResponse::error(id, -32601, format!("Method not found: {}", req.method))),
    }
}

// ── MCP stdio transport ──────────────────────────────────────────────────────
// Thin proxy: reads JSON-RPC lines from stdin, POSTs to the running agent's
// HTTP MCP endpoint, writes JSON-RPC responses to stdout.  This lets Claude
// Desktop, Claude Code, and other MCP clients use the native stdio transport
// without requiring HTTPS.  The agent must already be running (service or
// foreground).
async fn run_mcp_stdio() {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let port: u16 = std::env::var("WICKLEE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(7700);
    let url = format!("http://127.0.0.1:{port}/mcp");
    let client = reqwest::Client::new();

    // Verify agent is reachable before entering the read loop.
    match client.get(format!("http://127.0.0.1:{port}/api/pair/status")).send().await {
        Ok(r) if r.status().is_success() => {}
        _ => {
            let err = serde_json::json!({
                "jsonrpc": "2.0",
                "error": { "code": -32000, "message": format!("Wicklee agent not reachable on port {port}. Is the service running?") },
                "id": null
            });
            println!("{}", err);
            return;
        }
    }

    let stdin = tokio::io::stdin();
    let reader = BufReader::new(stdin);
    let mut lines = reader.lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() { continue; }

        // Forward to agent HTTP MCP endpoint.
        let resp = match client
            .post(&url)
            .header("Content-Type", "application/json")
            .body(line.clone())
            .send()
            .await
        {
            Ok(r) => {
                match r.text().await {
                    Ok(body) => body,
                    Err(e) => {
                        // Extract id from request for error response.
                        let id = serde_json::from_str::<serde_json::Value>(&line)
                            .ok()
                            .and_then(|v| v.get("id").cloned())
                            .unwrap_or(serde_json::Value::Null);
                        serde_json::json!({
                            "jsonrpc": "2.0",
                            "error": { "code": -32000, "message": format!("Failed to read response: {e}") },
                            "id": id
                        }).to_string()
                    }
                }
            }
            Err(e) => {
                let id = serde_json::from_str::<serde_json::Value>(&line)
                    .ok()
                    .and_then(|v| v.get("id").cloned())
                    .unwrap_or(serde_json::Value::Null);
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "error": { "code": -32000, "message": format!("Agent unreachable: {e}") },
                    "id": id
                }).to_string()
            }
        };

        // Write response to stdout (one JSON object per line).
        println!("{resp}");
    }
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

/// Immutable proxy + runtime port config, set once at startup.
#[derive(Clone)]
struct ProxyPorts {
    listen: Option<u16>,
    target: Option<u16>,
    runtime_overrides: Option<String>,
}

async fn handle_metrics(
    axum::extract::Extension(apple_metrics):         axum::extract::Extension<Arc<Mutex<AppleSiliconMetrics>>>,
    axum::extract::Extension(nvidia_metrics):        axum::extract::Extension<Arc<Mutex<NvidiaMetrics>>>,
    axum::extract::Extension(ollama_metrics):        axum::extract::Extension<Arc<Mutex<OllamaMetrics>>>,
    axum::extract::Extension(rapl_metrics):          axum::extract::Extension<Arc<Mutex<Option<f32>>>>,
    axum::extract::Extension(linux_thermal_metrics): axum::extract::Extension<Arc<Mutex<Option<LinuxThermalResult>>>>,
    axum::extract::Extension(vllm_metrics):          axum::extract::Extension<Arc<Mutex<VllmMetrics>>>,
    axum::extract::Extension(llamacpp_metrics):      axum::extract::Extension<Arc<Mutex<LlamacppMetrics>>>,
    axum::extract::Extension(wes_metrics):           axum::extract::Extension<Arc<Mutex<WesMetrics>>>,
    axum::extract::Extension(swap_metrics):          axum::extract::Extension<SwapMetrics>,
    axum::extract::Extension(probe_active):          axum::extract::Extension<Arc<std::sync::atomic::AtomicBool>>,
    axum::extract::Extension(proxy_ports):           axum::extract::Extension<ProxyPorts>,
) -> Sse<ReceiverStream<Result<Event, Infallible>>> {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, Infallible>>(4);

    tokio::spawn(async move {
        let proxy_listen_port = proxy_ports.listen;
        let proxy_target_port = proxy_ports.target;
        let runtime_port_overrides = proxy_ports.runtime_overrides;

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
            let llamacpp      = llamacpp_metrics.lock().map(|g| g.clone()).unwrap_or_default();
            let rapl_power    = rapl_metrics.lock().map(|g| *g).unwrap_or(None);
            let linux_thermal = linux_thermal_metrics.lock().map(|g| g.clone()).unwrap_or(None);
            let wes           = wes_metrics.lock().map(|g| g.clone()).unwrap_or_default();
            let swap_mb_s     = swap_metrics.read();
            let ollama_is_probing_flag = if ollama.is_probing_display() { Some(true) } else { None };
            let hw = read_hardware_signals(&apple, &nvidia, &ollama, &vllm, &llamacpp, &probe_active);
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
                // macOS: pmset/sysctl; Linux: clock_ratio/coretemp/sysfs; Windows: WMI
                // Idle CPU override applied for clock_ratio source (see resolve_thermal_state).
                thermal_state:           resolve_thermal_state(&apple.thermal_state, &linux_thermal, sys.global_cpu_info().cpu_usage()),
                nvidia_gpu_utilization_percent: nvidia.nvidia_gpu_utilization_percent,
                nvidia_vram_used_mb:            nvidia.nvidia_vram_used_mb,
                nvidia_vram_total_mb:           nvidia.nvidia_vram_total_mb,
                nvidia_gpu_temp_c:              nvidia.nvidia_gpu_temp_c,
                nvidia_power_draw_w:            nvidia.nvidia_power_draw_w,
                ollama_running:           ollama.ollama_running,
                ollama_active_model:      ollama.ollama_active_model,
                ollama_model_size_gb:     ollama.ollama_model_size_gb,
                ollama_inference_active:  ollama.ollama_inference_active,
                ollama_proxy_active:         if ollama.ollama_proxy_active { Some(true) } else { None },
                ollama_proxy_avg_ttft_ms:    ollama.ollama_proxy_avg_ttft_ms,
                ollama_proxy_avg_latency_ms: ollama.ollama_proxy_avg_latency_ms,
                ollama_proxy_request_count:  ollama.ollama_proxy_request_count,
                proxy_listen_port,
                proxy_target_port,
                runtime_port_overrides: runtime_port_overrides.clone(),
                ollama_is_probing:        ollama_is_probing_flag,
                ollama_quantization:      ollama.ollama_quantization,
                ollama_tokens_per_second:  ollama.ollama_tokens_per_second,
                ollama_prompt_eval_tps:    ollama.ollama_prompt_eval_tps,
                ollama_ttft_ms:            ollama.ollama_ttft_ms,
                ollama_load_duration_ms:   ollama.ollama_load_duration_ms,
                vllm_running:          vllm.vllm_running,
                vllm_model_name:       vllm.vllm_model_name,
                vllm_tokens_per_sec:   vllm.vllm_tokens_per_sec,
                vllm_cache_usage_perc: vllm.vllm_cache_usage_perc,
                vllm_requests_running: vllm.vllm_requests_running,
                vllm_requests_waiting:        vllm.vllm_requests_waiting,
                vllm_requests_swapped:        vllm.vllm_requests_swapped,
                vllm_avg_ttft_ms:             vllm.vllm_avg_ttft_ms,
                vllm_avg_e2e_latency_ms:      vllm.vllm_avg_e2e_latency_ms,
                vllm_avg_queue_time_ms:       vllm.vllm_avg_queue_time_ms,
                vllm_prompt_tokens_total:     vllm.vllm_prompt_tokens_total,
                vllm_generation_tokens_total: vllm.vllm_generation_tokens_total,
                llamacpp_running:          llamacpp.llamacpp_running,
                llamacpp_model_name:       llamacpp.llamacpp_model_name,
                llamacpp_tokens_per_sec:   llamacpp.llamacpp_tokens_per_sec,
                llamacpp_slots_processing: llamacpp.llamacpp_slots_processing,
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
                model_baseline_tps:     None,
                model_baseline_wes:     None,
                model_baseline_samples: None,
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
            event_type:   Some("update"),
        };
        // Manual push here (not push_event) — the process restarts immediately
        // after, so there is no store handle to persist to.  The event reaches
        // connected browsers via the next broadcast tick before exit.
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

    // ── --mcp-stdio: stdio transport for Claude Desktop / Claude Code ──────────
    // Reads JSON-RPC from stdin, forwards to the running agent's HTTP MCP endpoint,
    // writes responses to stdout. The agent must already be running as a service.
    if std::env::args().any(|a| a == "--mcp-stdio") {
        run_mcp_stdio().await;
        return;
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
            let inner = if key.is_empty() { format!("   {val}") } else { format!("   {:<8} {}", key, val) };
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
                #[cfg(target_os = "macos")]
                eprintln!("Start it with: sudo wicklee --install-service");
                #[cfg(target_os = "linux")]
                eprintln!("Start it with: sudo wicklee --install-service  (or: sudo systemctl start wicklee)");
                #[cfg(target_os = "windows")]
                eprintln!("Start it with: wicklee --install-service");
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
                    bind_address: config.bind_address.clone(),
                });
            }
            None => eprintln!("[warn] Could not register code with cloud backend. Check your internet connection."),
        }
        print_pairing_box(&config.node_id, &code);

        // Pairing is done — config is saved. The running service (systemd/launchd)
        // will pick up the new fleet_url + session_token on its next telemetry push.
        // Don't fall through to the server startup path, which would evict the
        // running service and confuse users with SIGTERM/shutdown messages.
        println!("\n  ✓ Pairing complete. The background service will connect to the fleet automatically.");
        println!("  Run `wicklee --status` to verify.\n");
        return;
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

    // Channel for proxy → store inference trace writes.
    #[cfg(not(target_env = "musl"))]
    let (trace_tx, trace_rx) = tokio::sync::mpsc::unbounded_channel::<store::TraceRow>();

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
                    node_id:          config.node_id.clone(),
                    #[cfg(not(target_env = "musl"))]
                    trace_tx:         Some(trace_tx.clone()),
                    ttft_sum_ns:      std::sync::atomic::AtomicU64::new(0),
                    latency_sum_ns:   std::sync::atomic::AtomicU64::new(0),
                    request_count:    std::sync::atomic::AtomicU64::new(0),
                });
                let ps_clone = Arc::clone(&ps);
                let proxy_app = axum::Router::new()
                    .route("/api/generate", axum::routing::post(proxy::proxy_ollama_streaming))
                    .route("/api/chat",     axum::routing::post(proxy::proxy_ollama_streaming))
                    .fallback(proxy::proxy_passthrough)
                    .with_state(ps_clone)
                    .layer(CorsLayer::new()
                        .allow_origin([
                            "http://localhost:7700".parse::<axum::http::HeaderValue>().unwrap(),
                            "http://127.0.0.1:7700".parse::<axum::http::HeaderValue>().unwrap(),
                            "http://localhost:3000".parse::<axum::http::HeaderValue>().unwrap(),
                        ])
                        .allow_methods(Any)
                        .allow_headers(Any));
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
    let (ollama_port_tx,   ollama_port_rx)   = watch::channel(None::<u16>);
    let (vllm_port_tx,     vllm_port_rx)     = watch::channel(None::<u16>);
    // llama.cpp and llama-box are different binaries with the same API.
    // Both discovery entries feed into a single merged watch channel.
    let (llamacpp_port_tx, llamacpp_port_rx) = watch::channel(None::<u16>);
    let (llamacpp_disc_tx, llamacpp_disc_rx) = watch::channel(None::<u16>);
    let (llamabox_disc_tx, llamabox_disc_rx) = watch::channel(None::<u16>);

    // Seed channels: config overrides take precedence over process auto-detection.
    // Config overrides are used when the runtime runs as a different OS user and
    // the agent cannot read its process cmdline (cross-user /proc restriction).
    let initial = process_discovery::scan_runtimes();
    let rp = config.runtime_ports.as_ref();
    let ollama_cfg = rp.and_then(|r| r.ollama);
    let vllm_cfg   = rp.and_then(|r| r.vllm);
    let ollama_port   = ollama_cfg.or_else(|| initial.get("ollama").copied());
    let vllm_port     = vllm_cfg  .or_else(|| initial.get("vllm").copied());
    let llamacpp_port = initial.get("llamacpp").copied().or_else(|| initial.get("llama-box").copied());
    // When the proxy is enabled, the harvester + probe must talk to Ollama
    // directly on its moved port (e.g. 11435), NOT through the proxy on 11434.
    // The proxy occupies the default port, so auto-discovery would incorrectly
    // connect the harvester to the proxy instead of the real Ollama process.
    let effective_ollama_port = if proxy_arc.is_some() {
        Some(proxy_cfg.ollama_port) // e.g. 11435 — where Ollama actually listens
    } else {
        ollama_port
    };
    if let Some(p) = effective_ollama_port { let _ = ollama_port_tx.send(Some(p)); }
    if let Some(p) = vllm_port     { let _ = vllm_port_tx.send(Some(p)); }
    if let Some(p) = llamacpp_port { let _ = llamacpp_port_tx.send(Some(p)); }

    // Merge llamacpp + llama-box discovery into the single harvester channel.
    {
        let merged_tx = llamacpp_port_tx;
        tokio::spawn(async move {
            let mut rx_cpp = llamacpp_disc_rx;
            let mut rx_box = llamabox_disc_rx;
            loop {
                tokio::select! {
                    Ok(()) = rx_cpp.changed() => { let _ = merged_tx.send(*rx_cpp.borrow()); }
                    Ok(()) = rx_box.changed() => { let _ = merged_tx.send(*rx_box.borrow()); }
                    else => break,
                }
            }
        });
    }

    // Start the background discovery loop (30 s interval).
    // Runtimes with a TOML config override are excluded from the loop —
    // the override is authoritative and must never be overwritten by
    // auto-discovery (Priority of Truth: TOML > cmdline > socket scan).
    let mut discovery_txs: std::collections::HashMap<&str, _> = Default::default();
    // When proxy is enabled, ollama port is fixed to proxy_cfg.ollama_port —
    // do not let auto-discovery overwrite it (same logic as TOML override).
    if ollama_cfg.is_none() && proxy_arc.is_none() { discovery_txs.insert("ollama", ollama_port_tx); }
    if vllm_cfg.is_none()   { discovery_txs.insert("vllm",   vllm_port_tx);   }
    discovery_txs.insert("llamacpp",  llamacpp_disc_tx);
    discovery_txs.insert("llama-box", llamabox_disc_tx);
    process_discovery::start_discovery_loop(discovery_txs, 30);

    // Proxy ports and runtime overrides are immutable after startup — compute once.
    let proxy_listen = if proxy_arc.is_some() { Some(11434u16) } else { None };
    let proxy_target = if proxy_arc.is_some() { Some(proxy_cfg.ollama_port) } else { None };
    let runtime_overrides: Option<String> = {
        let rp = config.runtime_ports.as_ref();
        let mut names = Vec::new();
        if rp.and_then(|r| r.ollama).is_some() { names.push("ollama"); }
        if rp.and_then(|r| r.vllm).is_some()   { names.push("vllm"); }
        if names.is_empty() { None } else { Some(names.join(",")) }
    };

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
    let llamacpp_metrics      = harvester::start_llamacpp_harvester(llamacpp_port_rx, Arc::clone(&apple_metrics), Arc::clone(&nvidia_metrics));

    // Shared CPU usage for idle-thermal override (IEEE f32 bits in AtomicU32).
    let cpu_usage_atomic = Arc::new(std::sync::atomic::AtomicU32::new(0_f32.to_bits()));

    // WES v2 — 2 s thermal-penalty sampler (30-sample rolling window).
    // Must start after the platform harvesters above so it has data to read.
    let wes_metrics = start_wes_sampler(
        Arc::clone(&apple_metrics),
        Arc::clone(&nvidia_metrics),
        Arc::clone(&linux_thermal_metrics),
        Arc::clone(&cpu_usage_atomic),
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

    let model_baseline_cache: ModelBaselineCache = Arc::new(Mutex::new(None));

    let broadcast_tx          = start_metrics_broadcaster(
        Arc::clone(&apple_metrics),
        Arc::clone(&nvidia_metrics),
        Arc::clone(&ollama_metrics),
        Arc::clone(&rapl_metrics),
        Arc::clone(&linux_thermal_metrics),
        Arc::clone(&vllm_metrics),
        Arc::clone(&llamacpp_metrics),
        Arc::clone(&live_events),
        Arc::clone(&wes_metrics),
        swap_metrics.clone(),
        Arc::clone(&probe_active),
        proxy_listen,
        proxy_target,
        runtime_overrides.clone(),
        config.node_id.clone(),
        Arc::clone(&model_baseline_cache),
        Arc::clone(&cpu_usage_atomic),
    );

    // Shared observation cache — written by the 10 s evaluator task, read by
    // cloud_push (embed in telemetry JSON) and handle_observations (GET /api/observations).
    #[cfg(not(target_env = "musl"))]
    let observation_cache: ObservationCache = Arc::new(Mutex::new(Vec::new()));
    #[cfg(target_env = "musl")]
    let observation_cache: Arc<Mutex<Vec<()>>> = Arc::new(Mutex::new(Vec::new()));

    // Start cloud telemetry push loop (2 s cadence, gated on session_token).
    #[cfg(not(target_env = "musl"))]
    cloud_push::start_cloud_push(
        Arc::clone(&pairing_state),
        broadcast_tx.clone(),
        Arc::clone(&observation_cache),
    );
    #[cfg(target_env = "musl")]
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

                // Trace writer — receives traces from the proxy and persists to DuckDB.
                {
                    let store_clone = s.clone();
                    let mut rx = trace_rx;
                    tokio::spawn(async move {
                        while let Some(trace) = rx.recv().await {
                            let st = store_clone.clone();
                            let _ = tokio::task::spawn_blocking(move || {
                                st.write_trace(&trace);
                            }).await;
                        }
                    });
                }

                // Model baseline updater — watches for model changes and queries
                // DuckDB for per-model Normal-thermal baseline (median tok/s, watts).
                {
                    let store_clone = s.clone();
                    let ollama_clone = Arc::clone(&ollama_metrics);
                    let baseline_clone = Arc::clone(&model_baseline_cache);
                    let node_id_clone = config.node_id.clone();
                    tokio::spawn(async move {
                        let mut last_model: Option<String> = None;
                        let mut interval = tokio::time::interval(Duration::from_secs(5));
                        loop {
                            interval.tick().await;
                            let current = ollama_clone
                                .lock()
                                .map(|g| g.ollama_active_model.clone())
                                .unwrap_or(None);
                            let changed = match (&last_model, &current) {
                                (Some(prev), Some(cur)) => prev != cur,
                                (None, Some(_))         => true,
                                (Some(_), None)         => {
                                    if let Ok(mut b) = baseline_clone.lock() { *b = None; }
                                    last_model = None;
                                    continue;
                                }
                                (None, None) => false,
                            };
                            if changed {
                                if let Some(ref model_name) = current {
                                    let st = store_clone.clone();
                                    let nid = node_id_clone.clone();
                                    let mn = model_name.clone();
                                    let result = tokio::task::spawn_blocking(move || {
                                        st.query_model_baseline(&nid, &mn)
                                    }).await;
                                    if let Ok(Ok(Some((tps, watts, count)))) = result {
                                        let wes = if watts > 0.0 { (tps / watts) as f32 } else { 0.0 };
                                        if let Ok(mut b) = baseline_clone.lock() {
                                            *b = Some((tps as f32, wes, count));
                                        }
                                    } else {
                                        if let Ok(mut b) = baseline_clone.lock() { *b = None; }
                                    }
                                    last_model = current;
                                }
                            }
                        }
                    });
                }

                // Observation evaluator — runs every 10 s, writes to shared cache.
                // Patterns A–R (except E, which is fleet-only) are evaluated against
                // the DuckDB 10-min buffer. The cache is read by cloud_push to embed
                // observations in the telemetry JSON for fleet dashboards.
                {
                    let store_clone = s.clone();
                    let nvidia_clone = Arc::clone(&nvidia_metrics);
                    let ollama_clone = Arc::clone(&ollama_metrics);
                    let apple_clone  = Arc::clone(&apple_metrics);
                    let node_id_clone = config.node_id.clone();
                    let obs_cache = Arc::clone(&observation_cache);
                    tokio::spawn(async move {
                        // Wait for DuckDB to accumulate a few samples before first eval.
                        tokio::time::sleep(Duration::from_secs(15)).await;
                        let mut interval = tokio::time::interval(Duration::from_secs(10));
                        loop {
                            interval.tick().await;
                            let st  = store_clone.clone();
                            let nid = node_id_clone.clone();
                            let nv  = nvidia_clone.lock().map(|g| g.clone()).unwrap_or_default();
                            let ol  = ollama_clone.lock().map(|g| g.clone()).unwrap_or_default();
                            let ap  = apple_clone.lock().map(|g| g.clone()).unwrap_or_default();
                            let pcie = PcieSnapshot {
                                link_width:     nv.pcie_link_width,
                                link_max_width: nv.pcie_link_max_width,
                            };
                            let hostname = System::host_name().unwrap_or_else(|| nid.clone());
                            let result = tokio::task::spawn_blocking(move || {
                                match st.query_observation_window(&nid, 600_000) {
                                    Ok(samples) => {
                                        let mut obs = evaluate_local_observations(&samples, &pcie, &nid, &hostname);
                                        // Pattern O — VRAM Overcommit (point-in-time, no history needed)
                                        if let Some(o) = evaluate_vram_overcommit(&ol, &nv, &ap, &nid, &hostname) {
                                            obs.push(o);
                                        }
                                        Some(obs)
                                    }
                                    Err(e) => {
                                        eprintln!("[obs] evaluation error: {e}");
                                        None
                                    }
                                }
                            }).await;
                            if let Ok(Some(observations)) = result {
                                if let Ok(mut cache) = obs_cache.lock() {
                                    *cache = observations;
                                }
                            }
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

    // Emit startup event — placed after store init so the event is persisted
    // to DuckDB on first write.  Still well before the first broadcast tick.
    push_event(
        &live_events,
        &recent_events_log,
        #[cfg(not(target_env = "musl"))]
        &metrics_store,
        &config.node_id,
        LiveActivityEvent {
            message:      format!("Agent started · v{}", env!("CARGO_PKG_VERSION")),
            timestamp_ms: now_ms(),
            level:        "info",
            event_type:   Some("startup"),
        },
    );

    // Restrict CORS to localhost origins only. Prevents malicious webpages on
    // external domains from reading telemetry data via JavaScript.
    // When bind_address is 0.0.0.0, LAN users can still access via browser
    // navigation — CORS only blocks cross-origin JS fetch/XHR.
    let cors = CorsLayer::new()
        .allow_origin([
            "http://localhost:7700".parse::<axum::http::HeaderValue>().unwrap(),
            "http://127.0.0.1:7700".parse::<axum::http::HeaderValue>().unwrap(),
            "http://localhost:3000".parse::<axum::http::HeaderValue>().unwrap(),  // dev server
        ])
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
            .route("/api/pair/disconnect",post(handle_pair_disconnect))
            // MCP (Model Context Protocol) — JSON-RPC 2.0 for AI agents
            .route("/mcp",                      post(handle_mcp))
            .route("/.well-known/mcp.json",     get(handle_mcp_manifest));

        // Wire store-backed routes only when DuckDB opened successfully.
        // Includes: /api/history, /api/insights/dismiss (POST), /api/insights/dismissed (GET),
        // /api/observations (local Patterns A/B/J/L).
        #[cfg(not(target_env = "musl"))]
        let r = if let Some(ref st) = metrics_store {
            r.route("/api/history",             get(handle_history))
             .route("/api/traces",              get(handle_traces))
             .route("/api/events/history",      get(handle_events_history))
             .route("/api/export",              get(handle_export))
             .route("/api/insights/dismiss",    post(handle_dismiss))
             .route("/api/insights/dismissed",  get(handle_dismissed_list))
             .route("/api/observations",        get(handle_observations))
             .layer(axum::extract::Extension(st.clone()))
             .layer(axum::extract::Extension(Arc::clone(&observation_cache)))
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
         .layer(axum::extract::Extension(llamacpp_metrics))
         .layer(axum::extract::Extension(wes_metrics))
         .layer(axum::extract::Extension(swap_metrics))
         .layer(axum::extract::Extension(Arc::clone(&recent_events_log)))
         .layer(axum::extract::Extension(broadcast_tx))
         .layer(axum::extract::Extension(probe_active))
         .layer(axum::extract::Extension(NodeId(Arc::new(config.node_id.clone()))))
         .layer(axum::extract::Extension(ProxyPorts { listen: proxy_listen, target: proxy_target, runtime_overrides: runtime_overrides }))
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
        // Default to 127.0.0.1 (localhost only) for security. Agents running as
        // a fleet node should set bind_address = "0.0.0.0" in config.toml to accept
        // LAN connections (e.g., for proxy mode or remote dashboard access).
        let bind_addr = config.bind_address.as_deref().unwrap_or("127.0.0.1");
        match tokio::net::TcpListener::bind(format!("{bind_addr}:{port}")).await {
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

