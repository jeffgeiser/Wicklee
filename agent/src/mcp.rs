//! MCP (Model Context Protocol) server: JSON-RPC types, HTTP endpoint and stdio transport.
//! Split out of main.rs; items are pub(crate) and re-exported at the crate root.

use super::*;

// ── MCP (Model Context Protocol) JSON-RPC 2.0 Types ─────────────────────────
// Lightweight MCP server — wraps existing agent endpoints for AI agent consumption.
// No additional crate dependencies; just serde_json over Axum.

#[derive(Deserialize)]
pub(crate) struct JsonRpcRequest {
    #[allow(dead_code)]
    pub(crate) jsonrpc: String,
    pub(crate) method: String,
    pub(crate) params: Option<serde_json::Value>,
    /// JSON-RPC notifications omit `id`. Default to Null so they deserialize.
    #[serde(default)]
    pub(crate) id: serde_json::Value,
}

#[derive(Serialize)]
pub(crate) struct JsonRpcResponse {
    pub(crate) jsonrpc: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<JsonRpcError>,
    pub(crate) id: serde_json::Value,
}

#[derive(Serialize)]
pub(crate) struct JsonRpcError {
    pub(crate) code: i32,
    pub(crate) message: String,
}

impl JsonRpcResponse {
    pub(crate) fn success(id: serde_json::Value, result: serde_json::Value) -> Self {
        Self { jsonrpc: "2.0", result: Some(result), error: None, id }
    }
    pub(crate) fn error(id: serde_json::Value, code: i32, message: String) -> Self {
        Self { jsonrpc: "2.0", result: None, error: Some(JsonRpcError { code, message }), id }
    }
}

// ── MCP Server ───────────────────────────────────────────────────────────────
// JSON-RPC 2.0 endpoint for AI agent consumption (Cursor, Claude Desktop, etc.).
// Wraps existing sensor data — no new shared state, no new dependencies.

pub(crate) async fn handle_mcp_manifest() -> Json<serde_json::Value> {
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

pub(crate) fn mcp_tools_list() -> serde_json::Value {
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
        },
        {
            "name": "get_model_fit",
            "description": "Analyzes how well the currently loaded model fits this node across three dimensions: Memory Fit (does it leave safe headroom?), Efficiency (WES score — tok/s per watt after thermal penalty), and Context Runway (how far the KV cache can grow before VRAM runs out). Returns structured scores and a plain-English summary suitable for answering 'can I run this model safely on this node?'",
            "inputSchema": { "type": "object", "properties": {} }
        }
    ])
}

pub(crate) fn mcp_resources_list() -> serde_json::Value {
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
pub(crate) fn build_mcp_node_snapshot(
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

pub(crate) async fn handle_mcp(
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

        // Get basic system info — only memory + the CPU list are read, so skip
        // the full process/disk/network enumeration `new_all()` would do.
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        sys.refresh_cpu();
        let total = sys.total_memory() / 1024 / 1024;
        let used  = sys.used_memory()  / 1024 / 1024;

        build_mcp_node_snapshot(
            &apple, &nvidia, &ollama, &vllm, &llamacpp, &wes,
            rapl, &lt, swap, &probe_active, sys.global_cpu_info().cpu_usage(),
            total, used, total.saturating_sub(used), sys.cpus().len(),
            &node_id.0, &hostname,
            proxy_ports.listen, proxy_ports.target,
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
                            "context_length": ollama.ollama_context_length,
                            "parameter_count": ollama.ollama_parameter_count,
                            "num_layers": ollama.ollama_num_layers,
                            "kv_heads": ollama.ollama_kv_heads,
                            "num_heads": ollama.ollama_num_heads,
                            "embedding_dim": ollama.ollama_embedding_dim,
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

                "get_observations" => {
                    // Fetch from local REST endpoint (backed by ObservationCache → DuckDB)
                    match local_http_client().get("http://127.0.0.1:7700/api/observations").send().await {
                        Ok(resp) if resp.status().is_success() => {
                            let body = resp.text().await.unwrap_or_else(|_| "{}".into());
                            Json(JsonRpcResponse::success(id, serde_json::json!({
                                "content": [{ "type": "text", "text": body }]
                            })))
                        }
                        _ => Json(JsonRpcResponse::success(id, serde_json::json!({
                            "content": [{ "type": "text", "text": "Observations endpoint unavailable — DuckDB may still be initializing." }]
                        }))),
                    }
                }
                "get_metrics_history" => {
                    let minutes = req.params.as_ref()
                        .and_then(|p| p.get("arguments"))
                        .and_then(|a| a.get("minutes"))
                        .and_then(|v| v.as_i64())
                        .unwrap_or(60).min(60);
                    let nid = node_id.0.as_str();
                    let url = format!("http://127.0.0.1:7700/api/history?node_id={nid}&minutes={minutes}");
                    match local_http_client().get(&url).send().await {
                        Ok(resp) if resp.status().is_success() => {
                            let body = resp.text().await.unwrap_or_else(|_| "{}".into());
                            Json(JsonRpcResponse::success(id, serde_json::json!({
                                "content": [{ "type": "text", "text": body }]
                            })))
                        }
                        _ => Json(JsonRpcResponse::success(id, serde_json::json!({
                            "content": [{ "type": "text", "text": "Metrics history unavailable — DuckDB may still be initializing." }]
                        }))),
                    }
                }

                "get_model_fit" => {
                    let ollama   = ollama_metrics.lock().map(|g| g.clone()).unwrap_or_default();
                    let nvidia   = nvidia_metrics.lock().map(|g| g.clone()).unwrap_or_default();
                    let apple    = apple_metrics.lock().map(|g| g.clone()).unwrap_or_default();
                    let wes      = wes_metrics.lock().map(|g| g.clone()).unwrap_or_default();

                    let mut sys = sysinfo::System::new();
                    sys.refresh_memory();
                    let total_mb     = sys.total_memory() / 1024 / 1024;
                    let available_mb = sys.available_memory() / 1024 / 1024;

                    // ── Determine active model info ──────────────────────────
                    let model_name = ollama.ollama_active_model.clone();
                    let model_gb   = ollama.ollama_model_size_gb;
                    let quant      = ollama.ollama_quantization.clone();
                    let tps        = ollama.ollama_tokens_per_second;

                    // ── Memory Fit ───────────────────────────────────────────
                    // Headroom = available RAM (or VRAM for NVIDIA). Score on
                    // how much room is left after the model is loaded.
                    let (vram_total_gb, _vram_used_gb, vram_available_gb) = match (
                        nvidia.nvidia_vram_total_mb, nvidia.nvidia_vram_used_mb
                    ) {
                        (Some(total), Some(used)) => {
                            let t = total as f64 / 1024.0;
                            let u = used  as f64 / 1024.0;
                            (Some(t), Some(u), Some(t - u))
                        }
                        _ => (None, None, None),
                    };

                    // Prefer VRAM for NVIDIA nodes; fall back to system RAM
                    let (memory_pool_label, pool_total_gb, pool_available_gb) = if let Some(avail) = vram_available_gb {
                        ("VRAM", vram_total_gb.unwrap_or(0.0), avail)
                    } else {
                        let total = total_mb as f64 / 1024.0;
                        let avail = available_mb as f64 / 1024.0;
                        ("RAM", total, avail)
                    };

                    let (memory_score, memory_label, memory_reason) = match model_gb {
                        Some(mgb) => {
                            let mgb = mgb as f64;
                            // Headroom after model = available that isn't consumed by the model
                            let headroom_gb = pool_available_gb;
                            let headroom_pct = if pool_total_gb > 0.0 {
                                headroom_gb / pool_total_gb * 100.0
                            } else { 0.0 };

                            if headroom_pct >= 20.0 {
                                ("good",
                                 "Good",
                                 format!("{mgb:.1} GB model leaves {headroom_gb:.1} GB headroom ({headroom_pct:.0}% of {memory_pool_label}) — comfortable."))
                            } else if headroom_pct >= 8.0 {
                                ("fair",
                                 "Fair",
                                 format!("{mgb:.1} GB model leaves {headroom_gb:.1} GB headroom ({headroom_pct:.0}% of {memory_pool_label}) — manageable but tight under long context."))
                            } else {
                                ("poor",
                                 "Poor",
                                 format!("{mgb:.1} GB model leaves only {headroom_gb:.1} GB headroom ({headroom_pct:.0}% of {memory_pool_label}) — KV cache growth will force swapping."))
                            }
                        }
                        None => ("unknown", "Unknown", "No model loaded or model size unavailable.".into()),
                    };

                    // ── WES Efficiency ───────────────────────────────────────
                    // WES = tok/s ÷ (watts × thermal_penalty)
                    // Levels: excellent >10, good 3–10, acceptable 1–3, low <1
                    let node_power_w: Option<f64> = apple.soc_power_w
                        .map(|w| w as f64)
                        .or_else(|| nvidia.nvidia_power_draw_w.map(|w| w as f64))
                        .or_else(|| apple.cpu_power_w.map(|w| w as f64));

                    let penalty = wes.penalty_avg.map(|p| p as f64).unwrap_or(1.0).max(0.01);

                    let (wes_score, wes_level, wes_reason) = match (tps, node_power_w) {
                        (Some(t), Some(w)) if w > 0.0 => {
                            let wes_val = t as f64 / (w * penalty);
                            let (level, _label) = if wes_val > 10.0 {
                                ("excellent", "Excellent")
                            } else if wes_val > 3.0 {
                                ("good", "Good")
                            } else if wes_val > 1.0 {
                                ("acceptable", "Acceptable")
                            } else {
                                ("low", "Low")
                            };
                            let reason = if penalty > 1.05 {
                                format!("{t:.1} tok/s at {w:.0} W with {:.0}% thermal penalty → WES {wes_val:.2}", (penalty - 1.0) * 100.0)
                            } else {
                                format!("{t:.1} tok/s at {w:.0} W → WES {wes_val:.2}")
                            };
                            (Some(wes_val), level, reason)
                        }
                        _ => (None, "unknown", "Inference not active — WES requires live tok/s and power readings.".into()),
                    };

                    // ── Context Runway ───────────────────────────────────────
                    // KV cache bytes = 2 × layers × kv_heads × head_dim × ctx_tokens × 2 (FP16)
                    let ctx_runway = (|| -> Option<serde_json::Value> {
                        let headroom_gb = if memory_pool_label == "VRAM" {
                            pool_available_gb
                        } else {
                            // Use available RAM but reserve 2 GB for OS
                            (pool_available_gb - 2.0).max(0.0)
                        };
                        if headroom_gb <= 0.0 { return None; }

                        // Try exact arch fields first
                        let (layers, kv_heads, head_dim, max_ctx, is_exact) =
                            if let (Some(l), Some(kv), Some(nh), Some(ed)) = (
                                ollama.ollama_num_layers,
                                ollama.ollama_kv_heads,
                                ollama.ollama_num_heads,
                                ollama.ollama_embedding_dim,
                            ) {
                                if nh == 0 { return None; }
                                let hd = ed / nh;
                                if hd == 0 { return None; }
                                let mc = ollama.ollama_context_length.unwrap_or(8_192);
                                (l, kv, hd, mc, true)
                            } else {
                                // Fallback: estimate from parameter count
                                let params = ollama.ollama_parameter_count?;
                                let b = params as f64 / 1e9;
                                let mc = ollama.ollama_context_length.unwrap_or(8_192);
                                // [minB, maxB, layers, kv_heads, head_dim]
                                let entry = if b < 2.0        { (22u64, 8u64, 64u64) }
                                    else if b < 4.5  { (28, 8, 128) }
                                    else if b < 9.0  { (32, 8, 128) }
                                    else if b < 18.0 { (40, 8, 128) }
                                    else if b < 40.0 { (48, 8, 128) }
                                    else if b < 80.0 { (80, 8, 128) }
                                    else             { (96, 8, 128) };
                                (entry.0, entry.1, entry.2, mc, false)
                            };

                        let headroom_bytes = headroom_gb * 1024.0 * 1024.0 * 1024.0;
                        let milestones = [4_096u64, 16_384, 32_768, 65_536, 131_072];
                        let approx_prefix = if is_exact { "" } else { "~" };

                        let mut points = Vec::new();
                        let mut max_fits_ctx: Option<u64> = None;

                        for &ctx in &milestones {
                            if ctx > max_ctx { break; }
                            // kv bytes = 2 × layers × kv_heads × head_dim × ctx × 2 (FP16)
                            let kv_bytes = 2.0 * layers as f64 * kv_heads as f64 * head_dim as f64 * ctx as f64 * 2.0;
                            let kv_gb    = kv_bytes / (1024.0_f64).powi(3);
                            let fits     = kv_bytes <= headroom_bytes;
                            if fits { max_fits_ctx = Some(ctx); }
                            points.push(serde_json::json!({
                                "ctx_tokens": ctx,
                                "ctx_label": format!("{}k", ctx / 1024),
                                "kv_gb": format!("{}{:.2}", approx_prefix, kv_gb),
                                "fits": fits,
                            }));
                        }

                        // Add model's own max_ctx if not a milestone
                        if !milestones.contains(&max_ctx) {
                            let kv_bytes = 2.0 * layers as f64 * kv_heads as f64 * head_dim as f64 * max_ctx as f64 * 2.0;
                            let kv_gb    = kv_bytes / (1024.0_f64).powi(3);
                            let fits     = kv_bytes <= headroom_bytes;
                            if fits { max_fits_ctx = Some(max_ctx); }
                            let label = if max_ctx >= 1_000_000 { format!("{}M", max_ctx / 1_000_000) }
                                        else { format!("{}k", max_ctx / 1_000) };
                            points.push(serde_json::json!({
                                "ctx_tokens": max_ctx,
                                "ctx_label": label,
                                "kv_gb": format!("{}{:.2}", approx_prefix, kv_gb),
                                "fits": fits,
                            }));
                        }

                        let summary = match max_fits_ctx {
                            None => {
                                let smallest_kv = 2.0 * layers as f64 * kv_heads as f64 * head_dim as f64 * 4096.0 * 2.0 / (1024.0_f64).powi(3);
                                format!("KV cache exceeds {headroom_gb:.1} GB headroom even at 4k context ({approx_prefix}{smallest_kv:.1} GB). Swapping likely.")
                            }
                            Some(mfc) if mfc >= max_ctx => {
                                format!("Full {}{} context window fits within {headroom_gb:.1} GB headroom. No context pressure.", approx_prefix, if max_ctx >= 1000 { format!("{}k", max_ctx/1000) } else { max_ctx.to_string() })
                            }
                            Some(mfc) => {
                                let label = if mfc >= 1000 { format!("{}k", mfc/1000) } else { mfc.to_string() };
                                format!("Context runway reaches {approx_prefix}{label} before KV cache exceeds {headroom_gb:.1} GB headroom.")
                            }
                        };

                        Some(serde_json::json!({
                            "max_ctx_tokens": max_ctx,
                            "headroom_gb": format!("{headroom_gb:.2}"),
                            "is_exact_arch": is_exact,
                            "milestones": points,
                            "max_fits_ctx": max_fits_ctx,
                            "summary": summary,
                        }))
                    })();

                    // ── Quant Recommendation ─────────────────────────────────
                    let quant_rec = (|| -> Option<serde_json::Value> {
                        let mgb     = model_gb? as f64;
                        let q       = quant.as_deref().unwrap_or("");
                        let avail   = pool_available_gb;

                        // Determine quant family by parsing bits from name
                        // e.g. "Q4_K_M" → 4, "Q8_0" → 8, "F16" → 16
                        let bits: Option<u32> = if q.starts_with('F') || q.starts_with('f') {
                            if q.contains("16") { Some(16) } else if q.contains("32") { Some(32) } else { None }
                        } else {
                            q.chars().find(|c| c.is_ascii_digit())
                                .and_then(|c| c.to_digit(10))
                        };

                        let (kind, headline, detail) = match bits {
                            Some(b) if b >= 8 => {
                                // At Q8/F16 — check if lower quant would help
                                let q4_size_est = mgb * 4.0 / (b as f64);
                                if avail < mgb * 0.25 {
                                    // Very tight — recommend downgrade
                                    ("downgrade",
                                     format!("Consider Q4_K_M — headroom too tight for {q}"),
                                     format!("Q4_K_M would reduce model footprint from {mgb:.1} GB to ~{q4_size_est:.1} GB, freeing ~{:.1} GB.", mgb - q4_size_est))
                                } else {
                                    // Enough room — Q8 is fine, note the speed trade-off
                                    ("lossless",
                                     format!("{q} offers minimal quality loss over F16"),
                                     "Memory fits. Note: Q8 is ~40% slower than Q4_K_M on memory-bandwidth-bound hardware. Acceptable if quality is the priority.".to_string())
                                }
                            }
                            Some(b) if b <= 3 => {
                                // Very low quant — suggest upgrade if room permits
                                let q4_size_est = mgb * 4.0 / (b as f64);
                                if avail > q4_size_est * 0.3 {
                                    ("upgrade",
                                     format!("Consider Q4_K_M — {q} may sacrifice too much quality"),
                                     format!("Q4_K_M at ~{q4_size_est:.1} GB would likely fit with {avail:.1} GB available and recover significant quality."))
                                } else {
                                    ("sweet-spot",
                                     format!("{q} is appropriate given memory constraints"),
                                     format!("Only {avail:.1} GB available — {q} is the best fit despite quality trade-offs."))
                                }
                            }
                            Some(4) | Some(5) | Some(6) => {
                                // Q4–Q6: sweet spot for most hardware
                                ("sweet-spot",
                                 format!("{q} is in the sweet spot for this hardware"),
                                 format!("Q4–Q6 models balance memory footprint, speed, and quality on memory-bandwidth-bound hardware. {mgb:.1} GB with {avail:.1} GB available."))
                            }
                            _ => {
                                // Unknown quant format
                                ("none",
                                 "Quantization format not recognized".into(),
                                 format!("Could not parse quant level from '{q}'. Check model details."))
                            }
                        };

                        Some(serde_json::json!({
                            "current_quant": q,
                            "kind": kind,
                            "headline": headline,
                            "detail": detail,
                        }))
                    })();

                    // ── Plain-English Summary ────────────────────────────────
                    let model_label = model_name.as_deref().unwrap_or("No model loaded");
                    let summary_parts: Vec<String> = {
                        let mut parts = Vec::new();
                        match memory_score {
                            "good"  => parts.push(format!("Memory fit is good ({memory_reason}).")),
                            "fair"  => parts.push(format!("Memory fit is fair — {memory_reason}")),
                            "poor"  => parts.push(format!("Memory is tight — {memory_reason}")),
                            _       => {}
                        }
                        match wes_level {
                            "excellent" | "good" => parts.push(format!("Efficiency is {wes_level} ({wes_reason}).")),
                            "acceptable"         => parts.push(format!("Efficiency is acceptable ({wes_reason}).")),
                            "low"                => parts.push(format!("Efficiency is low — {wes_reason}")),
                            _                    => {}
                        }
                        if let Some(ref r) = ctx_runway
                            && let Some(s) = r.get("summary").and_then(|v| v.as_str()) {
                                parts.push(s.to_string());
                            }
                        parts
                    };
                    let summary = if summary_parts.is_empty() {
                        "No model is currently loaded on this node.".to_string()
                    } else {
                        format!("{model_label}: {}", summary_parts.join(" "))
                    };

                    let result = serde_json::json!({
                        "model": model_name,
                        "quant": quant,
                        "model_size_gb": model_gb,
                        "memory_pool": memory_pool_label,
                        "pool_total_gb": pool_total_gb,
                        "pool_available_gb": pool_available_gb,
                        "memory_fit": {
                            "score": memory_score,
                            "label": memory_label,
                            "reason": memory_reason,
                        },
                        "efficiency": {
                            "wes": wes_score,
                            "level": wes_level,
                            "reason": wes_reason,
                        },
                        "context_runway": ctx_runway,
                        "quant_recommendation": quant_rec,
                        "summary": summary,
                    });

                    Json(JsonRpcResponse::success(id, serde_json::json!({
                        "content": [{ "type": "text", "text": serde_json::to_string_pretty(&result).unwrap_or_default() }]
                    })))
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
pub(crate) async fn run_mcp_stdio() {
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
