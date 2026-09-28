//! Metric payload types (runtime metrics, MetricsPayload), the 1 Hz broadcaster, snapshot and WebSocket feed.
//! Split out of main.rs; items are pub(crate) and re-exported at the crate root.

use super::*;

/// Per-model live metrics for concurrent model tracking.
/// Populated from `/api/ps` + proxy per-model accumulators.
#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub(crate) struct ModelLiveMetrics {
    pub(crate) model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) size_gb: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) quantization: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) vram_mb: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tok_s: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) avg_ttft_ms: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) avg_latency_ms: Option<f32>,
    #[serde(default)]
    pub(crate) request_count: u64,
    /// Per-model WES: tok/s ÷ (proportional_watts × thermal_penalty).
    /// Proportional watts estimated from VRAM share of total GPU memory.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) wes: Option<f32>,
}

// Ollama runtime metrics — populated when Ollama is detected on 127.0.0.1:11434.
// All fields are Option/bool-default so the payload serialises cleanly when absent.
#[derive(Serialize, Clone, Default)]
pub(crate) struct OllamaMetrics {
    pub(crate) ollama_running:           bool,
    pub(crate) ollama_active_model:      Option<String>,
    pub(crate) ollama_model_size_gb:     Option<f32>,
    pub(crate) ollama_quantization:      Option<String>,
    /// Context window size from /api/show model_info (e.g. 8192, 131072).
    pub(crate) ollama_context_length:    Option<u64>,
    /// Parameter count from /api/show model_info (e.g. 7_000_000_000 for 7B).
    pub(crate) ollama_parameter_count:   Option<u64>,
    /// Number of transformer layers (llama.block_count). Used for KV cache math.
    pub(crate) ollama_num_layers:        Option<u64>,
    /// Number of KV attention heads (llama.attention.head_count_kv).
    /// For GQA models this is < num_heads; for MHA it equals num_heads.
    /// KV cache scales with kv_heads, not total heads — critical for GQA accuracy.
    pub(crate) ollama_kv_heads:          Option<u64>,
    /// Total attention heads (llama.attention.head_count).
    /// Used with embedding_dim to derive head_dim = embedding_dim / num_heads.
    pub(crate) ollama_num_heads:         Option<u64>,
    /// Model embedding dimension (llama.embedding_length).
    /// head_dim = embedding_dim / num_heads (integer, typically 64, 128, or 256).
    pub(crate) ollama_embedding_dim:     Option<u64>,
    /// Sustained tok/s: eval_rate from Ollama /api/generate scheduled probe ([probe] in config.toml).
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
    /// When true, tok/s comes from done-packet eval_count/eval_duration rather than the scheduled probe.
    #[serde(default)]
    pub(crate) ollama_proxy_active: bool,
    /// Live TTFT from proxy done packets (rolling average, ms). Null when proxy inactive.
    pub(crate) ollama_proxy_avg_ttft_ms: Option<f32>,
    /// Live E2E latency from proxy done packets (rolling average, ms). Null when proxy inactive.
    pub(crate) ollama_proxy_avg_latency_ms: Option<f32>,
    /// Total requests proxied since agent start.
    pub(crate) ollama_proxy_request_count: Option<u64>,
    /// Per-model live metrics when multiple models are loaded concurrently.
    /// Only populated when >1 model is loaded (omitted for single model to keep payload lean).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) active_models: Option<Vec<ModelLiveMetrics>>,
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
    /// Set by the probe task on success to `now + probe interval + slack`.
    /// While in the future, the tok/s baseline counts as fresh for IDLE-SPD
    /// even though probes now fire only every few minutes.
    #[serde(skip)]
    pub(crate) baseline_fresh_until: Option<std::time::Instant>,
}

impl OllamaMetrics {
    /// True for 30 s after the probe completes. Gates Tier 3 physics (GPU
    /// residency lingers after the probe) and triggers IDLE-SPD; attribution
    /// uses the probe_active AtomicBool instead.
    pub(crate) fn recent_probe_baseline(&self) -> bool {
        self.last_probe_end.is_some_and(|t| t.elapsed().as_secs() < 30)
    }

    /// True while the last successful probe's baseline is still within its
    /// scheduled refresh window — keeps IDLE-SPD steady between probes.
    pub(crate) fn fresh_probe_baseline(&self) -> bool {
        self.baseline_fresh_until.is_some_and(|t| t > std::time::Instant::now())
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
    /// Model's actual context window (`max_model_len` from `/v1/models`).
    /// Replaces the 8192 conservative default in the frontend Context
    /// Runway calculation.  None when /v1/models is unreachable or returns
    /// an unexpected shape (e.g. older vLLM builds).
    pub(crate) vllm_max_model_len:    Option<u64>,
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
    /// Set when the scheduled idle probe completes. Used for IDLE-SPD display state.
    #[serde(skip)]
    pub(crate) last_probe_end: Option<std::time::Instant>,
    /// See OllamaMetrics::baseline_fresh_until.
    #[serde(skip)]
    pub(crate) baseline_fresh_until: Option<std::time::Instant>,
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
        self.last_probe_end.is_some_and(|t| t.elapsed().as_secs() < 30)
    }

    /// Mirrors OllamaMetrics::fresh_probe_baseline().
    pub(crate) fn fresh_probe_baseline(&self) -> bool {
        self.baseline_fresh_until.is_some_and(|t| t > std::time::Instant::now())
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
    /// Set when the scheduled idle probe completes. Used for IDLE-SPD display state.
    #[serde(skip)]
    pub(crate) last_probe_end: Option<std::time::Instant>,
    /// See OllamaMetrics::baseline_fresh_until.
    #[serde(skip)]
    pub(crate) baseline_fresh_until: Option<std::time::Instant>,
}

impl LlamacppMetrics {
    /// True for 30 s after the probe completes — mirrors OllamaMetrics::recent_probe_baseline().
    pub(crate) fn recent_probe_baseline(&self) -> bool {
        self.last_probe_end.is_some_and(|t| t.elapsed().as_secs() < 30)
    }

    /// Mirrors OllamaMetrics::fresh_probe_baseline().
    pub(crate) fn fresh_probe_baseline(&self) -> bool {
        self.baseline_fresh_until.is_some_and(|t| t > std::time::Instant::now())
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
    pub(crate) nvidia_gpu_name:                Option<String>,
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
pub(crate) struct MetricsPayload {
    pub(crate) node_id:                 String,
    /// Human-readable machine hostname (e.g. "DESKTOP-XYZ", "JEFFs-MacBook-Pro.local").
    pub(crate) hostname:                String,
    /// GPU model name — NVIDIA: nvmlDeviceGetName; Apple: system_profiler chip name.
    /// None when neither NVML nor ioreg can provide a name.
    pub(crate) gpu_name:                Option<String>,
    /// CPU/chip model name for non-GPU nodes — Linux: /proc/cpuinfo "model name".
    /// Displayed as the subtitle in the fleet UI when gpu_name is absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) chip_name:               Option<String>,
    pub(crate) cpu_usage_percent:       f32,
    pub(crate) total_memory_mb:         u64,
    pub(crate) used_memory_mb:          u64,
    pub(crate) available_memory_mb:     u64,
    pub(crate) cpu_core_count:          usize,
    pub(crate) timestamp_ms:            u64,
    // Apple Silicon deep-metal
    pub(crate) cpu_power_w:             Option<f32>,
    pub(crate) ecpu_power_w:            Option<f32>,
    pub(crate) pcpu_power_w:            Option<f32>,
    /// GPU power draw from powermetrics "GPU Power:" line.
    /// Use soc_power_w for total WES power calculation (it includes CPU + GPU + ANE).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) apple_gpu_power_w:       Option<f32>,
    /// Total SoC power from powermetrics "Combined Power (CPU + GPU + ANE):" line.
    /// This is the authoritative total power for Apple Silicon WES calculation.
    /// Prefer this over cpu_power_w + apple_gpu_power_w.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) apple_soc_power_w:       Option<f32>,
    pub(crate) gpu_utilization_percent: Option<f32>,
    pub(crate) memory_pressure_percent: Option<f32>,
    pub(crate) thermal_state:           Option<String>,
    /// GPU wired memory budget in MB — from `sysctl iogpu.wired_limit_mb`.
    /// Represents the maximum unified memory macOS reserves for GPU access
    /// (typically ~75% of physical RAM). None on non-Apple-Silicon nodes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) gpu_wired_limit_mb:      Option<u64>,
    // NVIDIA GPU fields (null on non-NVIDIA platforms)
    pub(crate) nvidia_gpu_utilization_percent: Option<f32>,
    pub(crate) nvidia_vram_used_mb:            Option<u64>,
    pub(crate) nvidia_vram_total_mb:           Option<u64>,
    pub(crate) nvidia_gpu_temp_c:              Option<u32>,
    pub(crate) nvidia_power_draw_w:            Option<f32>,
    // Ollama runtime (null/false when Ollama not running)
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub(crate) ollama_running:           bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ollama_active_model:      Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ollama_model_size_gb:     Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ollama_quantization:      Option<String>,
    /// Sustained tok/s from the scheduled probe (eval_rate field from Ollama). None until first probe completes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ollama_tokens_per_second: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ollama_prompt_eval_tps: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ollama_ttft_ms: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ollama_load_duration_ms: Option<f32>,
    /// True when a request completed within the last 35s. Derived from /api/ps expires_at resets.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ollama_inference_active: Option<bool>,
    /// True when the Wicklee transparent proxy is active on :11434.
    /// Frontend uses this to label tok/s as "live" (not "live estimate").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ollama_proxy_active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ollama_proxy_avg_ttft_ms: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ollama_proxy_avg_latency_ms: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ollama_proxy_request_count: Option<u64>,
    /// Per-model live metrics when multiple models are loaded concurrently.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) active_models: Option<Vec<ModelLiveMetrics>>,
    /// True when this node has runtime launch-config snapshots cached and
    /// available via GET /api/runtime-config?model=<name>. Lets the frontend
    /// decide whether to render the "Config" pill/link without round-tripping
    /// to a separate endpoint just to find out. The full config payload (which
    /// can include template + system prompt) is fetched on demand to keep the
    /// 1Hz SSE stream small. v0.9.0+ (Runtime Config Surface).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) runtime_config_available: Option<bool>,
    /// Port the proxy listens on (e.g. 11434). None when proxy is disabled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) proxy_listen_port: Option<u16>,
    /// Port the proxy forwards to (the real Ollama port, e.g. 11435). None when proxy is disabled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) proxy_target_port: Option<u16>,
    /// Comma-separated runtime names with [runtime_ports] config overrides (e.g. "vllm" or "ollama,vllm").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) runtime_port_overrides: Option<String>,
    /// True while the agent's background probe is running AND for 5 s afterward
    /// (see `OllamaMetrics::is_probing_display`).
    /// Frontend uses this to show IDLE-SPD instead of LIVE during probe activity —
    /// the probe fires a real Ollama request which would otherwise look like a user session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ollama_is_probing: Option<bool>,
    // Ollama model architecture (from /api/show model_info — refreshed on model change)
    /// Context window size in tokens (llama.context_length or general.context_length).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ollama_context_length: Option<u64>,
    /// Total parameter count (general.parameter_count or llama.parameter_count).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ollama_parameter_count: Option<u64>,
    /// Transformer layer count (llama.block_count). Required for KV cache estimation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ollama_num_layers: Option<u64>,
    /// KV attention heads (llama.attention.head_count_kv).
    /// Less than num_heads on GQA models (Llama 3, Mistral, Phi) — KV cache scales with this.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ollama_kv_heads: Option<u64>,
    /// Total attention heads (llama.attention.head_count). Used to derive head_dim.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ollama_num_heads: Option<u64>,
    /// Model embedding dimension (llama.embedding_length).
    /// head_dim = embedding_dim / num_heads (computed on the frontend).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ollama_embedding_dim: Option<u64>,
    // vLLM runtime (null/false when vLLM not running)
    #[serde(default)]
    pub(crate) vllm_running:          bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) vllm_model_name:       Option<String>,
    /// Model's `max_model_len` — actual context window the engine will accept.
    /// Pulled from `/v1/models` once per model change.  Powers Context Runway
    /// projections on vLLM nodes so they match the model's real ceiling
    /// instead of the 8 192 conservative default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) vllm_max_model_len:    Option<u64>,
    /// Effective weight dtype/quant of the running vLLM engine, captured from
    /// the process command line (--quantization wins over --dtype) and
    /// normalized to canonical quant tags (AWQ / GPTQ / FP8 / BF16 / ...).
    /// None when vLLM is idle, flags are absent (--dtype auto), or the
    /// cmdline is unreadable (cross-user without cap_sys_ptrace). The
    /// frontend prefers this over name-based quant parsing when sizing
    /// vLLM weights — eliminating the FP16 over-estimate for explicit
    /// FP8 / AWQ / GPTQ deployments.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) vllm_dtype:            Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) vllm_tokens_per_sec:   Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) vllm_cache_usage_perc: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) vllm_requests_running: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) vllm_requests_waiting: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) vllm_requests_swapped: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) vllm_avg_ttft_ms: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) vllm_avg_e2e_latency_ms: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) vllm_avg_queue_time_ms: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) vllm_prompt_tokens_total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) vllm_generation_tokens_total: Option<u64>,
    // llama.cpp / llama-box runtime (null/false when not running)
    #[serde(default)]
    pub(crate) llamacpp_running:          bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) llamacpp_model_name:       Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) llamacpp_tokens_per_sec:   Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) llamacpp_slots_processing: Option<u32>,
    /// Compile-time OS — "macOS" | "Linux" | "Windows". Cannot be inferred incorrectly.
    pub(crate) os: String,
    /// Compile-time CPU architecture — "x86_64" | "aarch64". Constant across the process lifetime.
    /// Frontend uses this to label ARM Linux nodes correctly in the identity column.
    pub(crate) arch: String,
    /// Drain-on-send event log. Normally empty; populated when background tasks
    /// (e.g. self-update) emit a notable event. Frontend renders as Live Activity entries.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub(crate) live_activities: Vec<LiveActivityEvent>,

    // ── WES v2 thermal-penalty window ─────────────────────────────────────────
    // All optional — None until the first 2 s sampler tick completes (≈2 s after start).
    // The cloud backend stores these in the reserved DuckDB columns (Phase 4B).

    /// Average thermal penalty over the last 30 samples (up to 60 s rolling window).
    /// 1.0 = no penalty (healthy), >1.0 = throttled. Three decimal places.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) penalty_avg:    Option<f32>,
    /// Worst (highest) penalty seen in the same 60 s window. Alert threshold: >1.75.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) penalty_peak:   Option<f32>,
    /// Source of the thermal data: "nvml" | "iokit" | "sysfs" | "unavailable".
    /// "nvml" = hardware-authoritative bitmask. Others = state-string inference.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) thermal_source: Option<String>,
    /// Number of samples in the current window (1–30). Low values mean the agent
    /// just started or restarted — treat avg/peak as provisional.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) sample_count:   Option<u32>,
    /// WES formula version. 1 = original (Serious=2.0). 2 = refined (Serious=1.75, NVML bitmask).
    /// Increment here when the formula changes; version-stamps all benchmarks in DuckDB.
    pub(crate) wes_version:    u8,
    /// Swap device write rate in MB/s.
    /// Linux: /proc/vmstat pswpout delta. macOS: vm_stat Swapouts delta.
    /// Absent (None) on Windows and agents that lack the swap harvester.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) swap_write_mb_s: Option<f32>,
    /// GPU clock throttle percentage: 0 = full speed, 100 = fully throttled.
    /// NVIDIA: derived from nvmlDeviceGetClockInfo(GRAPHICS) / nvmlDeviceGetMaxClockInfo.
    /// AMD/Linux: derived from scaling_cur_freq / cpuinfo_max_freq (clock_ratio path only).
    /// None on macOS, Windows, non-AMD Linux without cpufreq, and musl builds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) clock_throttle_pct: Option<f32>,
    /// Current PCIe link width in lanes (1/4/8/16). NVIDIA only; None on non-NVIDIA.
    /// Pattern L fires when pcie_link_width < pcie_link_max_width (lane-degraded slot).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) pcie_link_width:     Option<u32>,
    /// Maximum PCIe link width the GPU + slot support. Paired with pcie_link_width.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) pcie_link_max_width: Option<u32>,
    /// Per-model baseline tok/s from 7-day DuckDB history at Normal thermal state.
    /// Populated on model change, cached until model changes again. None when
    /// insufficient history (< 100 Normal-thermal samples) or musl builds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_baseline_tps: Option<f32>,
    /// Per-model baseline WES computed from historical median tok/s and watts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_baseline_wes: Option<f32>,
    /// Number of Normal-thermal samples used to compute the baseline.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_baseline_samples: Option<u32>,
    /// Compile-time agent version from Cargo.toml (e.g. "0.4.36").
    /// The frontend compares this against its own build-time UI version to detect
    /// stale cached interfaces and prompt a hard-reload.
    pub(crate) agent_version: String,
    /// Authoritative inference state, computed once by compute_inference_state().
    /// "idle-spd" | "live" | "busy" | "idle"
    /// Sent to both the local WebSocket and the cloud telemetry API so both
    /// surfaces always display the same label — no frontend re-computation needed.
    pub(crate) inference_state: String,
}

// ── 1 Hz Metrics Broadcaster (WebSocket feed) ─────────────────────────────────

/// Spawns a 1 s broadcast loop that serialises MetricsPayload and broadcasts
/// the JSON string to every active WebSocket subscriber.
/// 1 Hz keeps the display-layer rolling windows (8–12 samples) covering 8–12 s,
/// matching the effective smoothing depth of the cloud fleet dashboard.
/// The broadcast channel has capacity 64 — lagged subscribers simply skip frames.
/// Shared per-model baseline cache. Updated by the broadcast loop when model changes.
/// Tuple: (baseline_tps, baseline_wes, sample_count).
pub(crate) type ModelBaselineCache = Arc<Mutex<Option<(f32, f32, u32)>>>;

/// Latest JSON frame published by the metrics broadcaster. Backs the one-shot
/// `GET /api/metrics/snapshot` (`/api/metrics` itself is an SSE stream, so
/// `curl | jq` against it never terminates).
#[derive(Clone, Default)]
pub(crate) struct LatestFrame(pub(crate) Arc<std::sync::RwLock<Option<String>>>);

/// Subscribe to the broadcaster and keep only the most recent frame.
pub(crate) fn track_latest_frame(tx: &broadcast::Sender<String>) -> LatestFrame {
    use tokio::sync::broadcast::error::RecvError;
    let latest = LatestFrame::default();
    let slot = latest.clone();
    let mut rx = tx.subscribe();
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(json) => {
                    if let Ok(mut g) = slot.0.write() { *g = Some(json); }
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed)    => break,
            }
        }
    });
    latest
}

pub(crate) async fn handle_metrics_snapshot(
    axum::extract::Extension(latest): axum::extract::Extension<LatestFrame>,
) -> axum::response::Response {
    match latest.0.read().ok().and_then(|g| g.clone()) {
        Some(json) => (
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            json,
        ).into_response(),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "no metrics frame yet — retry in a second" })),
        ).into_response(),
    }
}

pub(crate) fn start_metrics_broadcaster(
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
    runtime_config_cache:  runtime_config::RuntimeConfigCache,
) -> broadcast::Sender<String> {
    let (tx, _) = broadcast::channel::<String>(64);
    let tx_clone = tx.clone();

    // Supervised: the metrics broadcast loop is the agent's most critical
    // background task — if it dies, ALL telemetry stops. It's a pure infinite
    // loop (no intentional exit), so the supervisor only restarts it on panic.
    // State is cloned per-run in the factory prelude; the loop body is
    // unchanged, so a restart re-runs warm-up and continues identically.
    supervisor::supervise("metrics-broadcast", move || {
        // Clone per-run state so the factory is callable on each restart.
        let tx_clone = tx_clone.clone();
        let config_node_id = config_node_id.clone();
        let cpu_usage_atomic = cpu_usage_atomic.clone();
        let apple_metrics = apple_metrics.clone();
        let nvidia_metrics = nvidia_metrics.clone();
        let ollama_metrics = ollama_metrics.clone();
        let vllm_metrics = vllm_metrics.clone();
        let llamacpp_metrics = llamacpp_metrics.clone();
        let rapl_metrics = rapl_metrics.clone();
        let linux_thermal_metrics = linux_thermal_metrics.clone();
        let wes_metrics = wes_metrics.clone();
        let swap_metrics = swap_metrics.clone();
        let model_baseline = model_baseline.clone();
        let live_events = live_events.clone();
        let probe_active = probe_active.clone();
        let runtime_config_cache = runtime_config_cache.clone();
        let runtime_port_overrides = runtime_port_overrides.clone();
        async move {
        // Only CPU + memory are read below; `new()` skips the process/disk/
        // network enumeration that `new_all()` would perform.
        let mut sys = System::new();
        let node_id = config_node_id;
        let hostname = System::host_name()
            .unwrap_or_else(|| node_id.clone());

        // Cache chip_name once — CPU model never changes at runtime.
        let linux_chip_name = read_linux_chip_name();

        // Warm-up: two reads separated by 200 ms gives sysinfo an accurate CPU delta.
        sys.refresh_cpu();
        sys.refresh_memory();
        tokio::time::sleep(Duration::from_millis(200)).await;

        let mut interval = tokio::time::interval(Duration::from_millis(1_000));
        loop {
            interval.tick().await;
            // This loop only reads CPU usage and memory from `sys`; refresh just
            // those rather than `refresh_all()`, which would also re-enumerate
            // every process/disk/network each second for no benefit.
            sys.refresh_cpu();
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
                active_models: {
                    // Enrich per-model metrics with WES using power + thermal data.
                    let total_power = apple.soc_power_w
                        .or(nvidia.nvidia_power_draw_w)
                        .or(rapl_power);
                    let penalty = wes.penalty_avg.unwrap_or(1.0);
                    let total_vram: u64 = ollama.active_models.as_ref()
                        .map(|v| v.iter().filter_map(|m| m.vram_mb).sum()).unwrap_or(0);
                    ollama.active_models.as_ref().map(|models| {
                        models.iter().map(|m| {
                            let mut enriched = m.clone();
                            if let (Some(tps), Some(pw), Some(vram)) = (m.tok_s, total_power, m.vram_mb)
                                && total_vram > 0 && pw > 0.1 && tps > 0.0 {
                                    let share = vram as f32 / total_vram as f32;
                                    let model_watts = pw * share;
                                    enriched.wes = Some(tps / (model_watts * penalty));
                                }
                            enriched
                        }).collect()
                    })
                },
                // v0.9.0: Runtime Config Surface. Some(true) once any model
                // has a cached config; None otherwise (saves payload bytes
                // when the feature can't be used yet).
                runtime_config_available: {
                    let c = runtime_config_cache.lock().unwrap();
                    if c.is_empty() { None } else { Some(true) }
                },
                proxy_listen_port,
                proxy_target_port,
                runtime_port_overrides: runtime_port_overrides.clone(),
                ollama_is_probing:        ollama_is_probing_flag,
                ollama_context_length:    ollama.ollama_context_length,
                ollama_parameter_count:   ollama.ollama_parameter_count,
                ollama_num_layers:        ollama.ollama_num_layers,
                ollama_kv_heads:          ollama.ollama_kv_heads,
                ollama_num_heads:         ollama.ollama_num_heads,
                ollama_embedding_dim:     ollama.ollama_embedding_dim,
                ollama_quantization:      ollama.ollama_quantization,
                ollama_tokens_per_second:  ollama.ollama_tokens_per_second,
                ollama_prompt_eval_tps:    ollama.ollama_prompt_eval_tps,
                ollama_ttft_ms:            ollama.ollama_ttft_ms,
                ollama_load_duration_ms:   ollama.ollama_load_duration_ms,
                vllm_running:          vllm.vllm_running,
                vllm_model_name:       vllm.vllm_model_name,
                vllm_max_model_len:    vllm.vllm_max_model_len,
                vllm_dtype:            crate::process_discovery::vllm_effective_dtype(),
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
        } // async move
    }); // supervise

    tx
}

// ── WebSocket Handler ─────────────────────────────────────────────────────────

pub(crate) async fn handle_ws(
    ws: WebSocketUpgrade,
    axum::extract::Extension(tx): axum::extract::Extension<broadcast::Sender<String>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| ws_session(socket, tx))
}

pub(crate) async fn ws_session(mut socket: WebSocket, tx: broadcast::Sender<String>) {
    let mut rx = tx.subscribe();
    loop {
        match rx.recv().await {
            Ok(json) => {
                if socket.send(Message::Text(json)).await.is_err() {
                    break; // client disconnected
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => continue, // skip stale frames
            Err(broadcast::error::RecvError::Closed)    => break,
        }
    }
}

#[cfg(test)]
mod metrics_snapshot_tests {
    use super::*;

    #[tokio::test]
    async fn snapshot_returns_latest_broadcast_frame() {
        let (tx, _) = broadcast::channel::<String>(4);
        let latest = track_latest_frame(&tx);

        let resp = handle_metrics_snapshot(axum::extract::Extension(latest.clone())).await;
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);

        tx.send(r#"{"n":1}"#.into()).unwrap();
        tx.send(r#"{"n":2}"#.into()).unwrap();
        for _ in 0..100 {
            if latest.0.read().unwrap().as_deref() == Some(r#"{"n":2}"#) { break; }
            tokio::task::yield_now().await;
        }
        let resp = handle_metrics_snapshot(axum::extract::Extension(latest)).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.headers()[axum::http::header::CONTENT_TYPE], "application/json");
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&body[..], br#"{"n":2}"#);
    }
}
