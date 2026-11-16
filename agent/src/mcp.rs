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
        "description": "Sovereign GPU fleet monitor for local AI inference. Hardware telemetry and inference state, plus what is loaded on this host, whether a model can run without displacing another, and findings about slow or unstable inference with the evidence behind each one.",
        "transport": { "type": "http", "url": "/mcp" },
        "capabilities": {
            "tools": true,
            "resources": true,
        }
    }))
}

/// One of a tool call's arguments, as a string.
///
/// Tools take their arguments the way the routes take query parameters, so
/// the two surfaces accept the same words for the same thing.
fn tool_arg(req: &JsonRpcRequest, name: &str) -> Option<String> {
    req.params
        .as_ref()?
        .get("arguments")?
        .get(name)?
        .as_str()
        .map(str::to_string)
}

/// A handler's response body, as text.
///
/// The three /v1 tools pass through whatever their route returned, including
/// its error bodies: a tool that reported success where the route reported 404
/// would be a second implementation of the route's own rules.
async fn response_body(resp: axum::response::Response) -> String {
    match axum::body::to_bytes(resp.into_body(), 1024 * 1024).await {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) => serde_json::json!({
            "error": format!("the route produced a body this tool could not read: {e}"),
        })
        .to_string(),
    }
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
            "name": "wicklee_state",
            "description": "What is installed and loaded on this host: every model with its residency, the context it is running at, its measured footprint, whether any of it sits outside accelerator memory, and when a real caller last used it. Also records which response fields this runtime actually returns, so a caller can tell an unknown from a zero.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "wicklee_readiness",
            "description": "Call before starting a task to see whether a model can run without displacing another. Answers ready_now, requires_loading or would_displace for each installed model, with the memory headroom and the evidence behind the answer. Pass a model name to ask about one. Do not treat requires_loading as safe when the answer carries coexistence: \"unverified\" — that means the model fits by memory accounting while another model is resident, and on the one host measured so far the runtime evicted a resident model in 5 of 6 such cases. Loading it may still displace work in progress.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "model": {
                        "type": "string",
                        "description": "One model to answer about, e.g. \"qwen3:8b\". Omit for every installed model."
                    }
                }
            }
        },
        {
            "name": "wicklee_inspect",
            "description": "Current findings about slow or unstable inference on this host, each with the evidence behind it: what was observed, what may follow from it, and what was measured. Also lists what could not be checked and why, so a gap reads as a gap rather than as a clean bill of health.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "since": {
                        "type": "string",
                        "description": "How far back to look, e.g. \"24h\", \"90m\" or \"7d\". Defaults to the rules' own windows."
                    }
                }
            }
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
    // The whole request rather than `Json<JsonRpcRequest>`, for two reasons.
    //
    // Axum stops implementing `Handler` past sixteen extractors, and the three
    // /v1 tools need five more things than this handler used to take: the
    // runtime port, the capability record, the residency tracker, the store
    // and the observation cache. Taking the request itself is one extractor
    // for all of them.
    //
    // And it lets a malformed body answer as JSON-RPC. `Json<T>` rejects with
    // a 400 and a plain-text reason, which a JSON-RPC client has no way to
    // read; a parse error is -32700 and belongs in the envelope.
    request: axum::extract::Request,
) -> Json<JsonRpcResponse> {
    let (parts, body) = request.into_parts();
    let port_rx = match parts.extensions.get::<OllamaPortRx>() {
        Some(OllamaPortRx(rx)) => rx.clone(),
        // Only reachable if the router stopped layering it, which would break
        // every /v1 route too. Answered rather than panicked.
        None => {
            return Json(JsonRpcResponse::error(
                serde_json::Value::Null,
                -32603,
                "this agent is not serving the runtime port to its own handlers".to_string(),
            ));
        }
    };
    let caps = match parts.extensions.get::<crate::caps::SharedCaps>() {
        Some(c) => c.clone(),
        None => {
            return Json(JsonRpcResponse::error(
                serde_json::Value::Null,
                -32603,
                "this agent has no capability record".to_string(),
            ));
        }
    };
    let residency = match parts.extensions.get::<crate::residency::SharedTracker>() {
        Some(r) => Arc::clone(r),
        None => {
            return Json(JsonRpcResponse::error(
                serde_json::Value::Null,
                -32603,
                "this agent has no residency tracker".to_string(),
            ));
        }
    };
    #[cfg(not(target_env = "musl"))]
    let store: crate::http_api::MaybeStore = parts
        .extensions
        .get::<crate::store::Store>()
        .cloned()
        .map(axum::extract::Extension);
    #[cfg(not(target_env = "musl"))]
    let observations: crate::http_api::MaybeObservations = parts
        .extensions
        .get::<crate::observations::ObservationCache>()
        .cloned()
        .map(axum::extract::Extension);
    // On musl there is no DuckDB, so neither exists and the handler serves
    // the in-memory evaluation — the same as the HTTP route does there.
    #[cfg(target_env = "musl")]
    let store: crate::http_api::MaybeStore = None;
    #[cfg(target_env = "musl")]
    let observations: crate::http_api::MaybeObservations = None;

    let bytes = match axum::body::to_bytes(body, 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => {
            return Json(JsonRpcResponse::error(serde_json::Value::Null, -32700, format!("could not read the request body: {e}")));
        }
    };
    let req: JsonRpcRequest = match serde_json::from_slice(&bytes) {
        Ok(r) => r,
        Err(e) => {
            return Json(JsonRpcResponse::error(serde_json::Value::Null, -32700, format!("not a JSON-RPC request: {e}")));
        }
    };
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

                // ── The /v1 surface, as tools ────────────────────────────────
                //
                // Each one calls the same handler the HTTP route calls and
                // passes its body through. That is how "tool output equals the
                // HTTP JSON" is true by construction rather than by two
                // implementations agreeing for now — and it is why these three
                // do not fetch over loopback the way the older tools do, which
                // also spares them the hardcoded :7700 those carry.
                //
                // `fingerprint` and `verify` are deliberately absent. They are
                // the only routes that load models, and an agent able to
                // trigger one could take a colleague's model out of memory
                // while answering a question about it.
                "wicklee_state" => {
                    let body = handle_v1_state(
                        axum::extract::Extension(OllamaPortRx(port_rx.clone())),
                        axum::extract::Extension(caps.clone()),
                        axum::extract::Extension(Arc::clone(&residency)),
                        axum::extract::Extension(node_id.clone()),
                    )
                    .await;
                    Json(JsonRpcResponse::success(id, serde_json::json!({
                        "content": [{ "type": "text", "text": serde_json::to_string_pretty(&body.0).unwrap_or_default() }]
                    })))
                }

                "wicklee_readiness" => {
                    let mut query = std::collections::HashMap::new();
                    if let Some(m) = tool_arg(&req, "model") {
                        query.insert("model".to_string(), m);
                    }
                    let resp = handle_v1_readiness(
                        axum::extract::Extension(OllamaPortRx(port_rx.clone())),
                        axum::extract::Query(query),
                        axum::extract::Extension(Arc::clone(&residency)),
                        axum::extract::Extension(caps.clone()),
                        axum::extract::Extension(Arc::clone(&apple_metrics)),
                        axum::extract::Extension(Arc::clone(&nvidia_metrics)),
                        axum::extract::Extension(node_id.clone()),
                    )
                    .await;
                    Json(JsonRpcResponse::success(id, serde_json::json!({
                        "content": [{ "type": "text", "text": response_body(resp).await }]
                    })))
                }

                "wicklee_inspect" => {
                    let mut query = std::collections::HashMap::new();
                    if let Some(w) = tool_arg(&req, "since") {
                        query.insert("since".to_string(), w);
                    }
                    let resp = handle_v1_inspect(
                        axum::extract::Extension(OllamaPortRx(port_rx.clone())),
                        axum::extract::Query(query),
                        axum::extract::Extension(Arc::clone(&residency)),
                        axum::extract::Extension(caps.clone()),
                        axum::extract::Extension(Arc::clone(&apple_metrics)),
                        axum::extract::Extension(Arc::clone(&nvidia_metrics)),
                        axum::extract::Extension(node_id.clone()),
                        // Moved, not cloned: this is their only use, and on a
                        // build with no store both are the unit type, where a
                        // clone of a Copy value is a clippy error.
                        store,
                        observations,
                    )
                    .await;
                    Json(JsonRpcResponse::success(id, serde_json::json!({
                        "content": [{ "type": "text", "text": response_body(resp).await }]
                    })))
                }

                // Retired in step 6's successor: readiness and inspect replace
                // them. Answered with a pointer rather than "unknown tool",
                // because an agent that called one yesterday deserves to be
                // told where the answer moved rather than that it vanished.
                "get_model_fit" => Json(JsonRpcResponse::error(
                    id,
                    -32601,
                    "get_model_fit is retired. Call wicklee_readiness instead: it answers whether \
                     a model can run now, what it would displace, and the evidence for both — \
                     measured rather than scored."
                        .to_string(),
                )),
                "get_observations" => Json(JsonRpcResponse::error(
                    id,
                    -32601,
                    "get_observations is retired. Call wicklee_inspect instead: it carries the same \
                     hardware patterns plus the diagnostic rules, each statement labelled by the \
                     evidence behind it."
                        .to_string(),
                )),

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

#[cfg(test)]
mod tool_surface_tests {
    use super::*;

    /// The tool list is the contract an agent reads once and caches, so a
    /// silent addition or removal is a broken integration somewhere else.
    /// Pinned here, with the retired names kept out on purpose.
    #[test]
    fn the_tool_list_is_exactly_the_published_surface() {
        let tools = mcp_tools_list();
        let names: Vec<&str> = tools
            .as_array()
            .expect("an array")
            .iter()
            .map(|t| t["name"].as_str().expect("a name"))
            .collect();
        assert_eq!(
            names,
            [
                "get_node_status",
                "get_inference_state",
                "get_active_models",
                "get_metrics_history",
                "wicklee_state",
                "wicklee_readiness",
                "wicklee_inspect",
            ],
        );
        // Retired in step 7. Readiness and inspect replace them, and a call to
        // either is answered with that pointer rather than "unknown tool".
        assert!(!names.contains(&"get_model_fit"));
        assert!(!names.contains(&"get_observations"));
        // Neither test run is exposed: an agent that could trigger one could
        // take a colleague's model out of memory while answering a question.
        assert!(!names.iter().any(|n| n.contains("fingerprint") || n.contains("verify")));

        // Every tool declares a schema, even the ones taking no arguments: an
        // absent inputSchema makes some clients refuse the tool outright.
        for t in tools.as_array().expect("an array") {
            assert_eq!(t["inputSchema"]["type"], "object", "{}", t["name"]);
            assert!(t["description"].as_str().is_some_and(|d| d.len() > 40), "{}", t["name"]);
        }
    }
}
