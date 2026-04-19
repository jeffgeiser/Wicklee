use crate::{AppleSiliconMetrics, NvidiaMetrics, OllamaMetrics, VllmMetrics, LlamacppMetrics};
use crate::proxy::ProxyState;
use crate::process_discovery;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// GPU utilisation above this threshold (%) causes the probe to be skipped.
/// The dashboard estimation formula (peak × gpu_util%) covers the busy case,
/// so firing tokens into an already-loaded scheduler would only add noise.
const GPU_LOAD_THRESHOLD_PCT: f32 = 40.0;

/// Discovers the first model installed in Ollama via GET /api/tags.
///
/// Returns None when Ollama has no models installed or the request fails.
/// Used as a probe fallback when /api/ps shows no loaded model — Ollama will
/// auto-load the returned model when the subsequent /api/generate probe arrives.
/// This is identical behaviour to a user's first request on a fresh Ollama session.
async fn discover_first_ollama_model(client: &reqwest::Client, port: u16) -> Option<String> {
    let url = format!("http://127.0.0.1:{port}/api/tags");
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[ollama] /api/tags on :{port} failed: {e}");
            return None;
        }
    };
    if !resp.status().is_success() {
        eprintln!("[ollama] /api/tags on :{port} → HTTP {}", resp.status());
        return None;
    }
    let json: serde_json::Value = resp.json().await.ok()?;
    let models = json["models"].as_array();
    if models.map_or(true, |m| m.is_empty()) {
        eprintln!("[ollama] /api/tags on :{port} — no models installed");
        return None;
    }
    let name = models?
        .first()?
        .get("name")?
        .as_str()?
        .to_string();
    eprintln!("[ollama] probe fallback — no model in /api/ps, discovered: {name}");
    Some(name)
}

/// Result of the 20-token Ollama probe — expanded from bare tok/s to include
/// prefill speed, TTFT, and model load time.
#[derive(Default)]
struct OllamaProbeResult {
    tps:                Option<f32>,   // existing: eval_count / eval_duration
    prompt_eval_tps:    Option<f32>,   // prefill speed: prompt_eval_count / prompt_eval_duration
    ttft_ms:            Option<f32>,   // time-to-first-token: prompt_eval_duration in ms
    load_duration_ms:   Option<f32>,   // model load time: 0 = warm, >0 = cold start
}

/// Fires a non-streaming 20-token generate probe and returns timing metrics
/// derived from eval_count, eval_duration, prompt_eval_count, prompt_eval_duration,
/// and load_duration returned by Ollama.
async fn probe_ollama_tps(client: &reqwest::Client, port: u16, model: &str) -> OllamaProbeResult {
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
        Err(e) => { eprintln!("[ollama] probe {} → error: {}", url, e); return OllamaProbeResult::default(); }
    };

    if !resp.status().is_success() { return OllamaProbeResult::default(); }

    let text = match resp.text().await {
        Ok(t) => t,
        Err(_) => return OllamaProbeResult::default(),
    };

    let json = match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(j) => j,
        Err(_) => return OllamaProbeResult::default(),
    };

    let mut result = OllamaProbeResult::default();

    // Generation tok/s (existing logic)
    if let (Some(count), Some(dur_ns)) = (
        json["eval_count"].as_u64(),
        json["eval_duration"].as_u64(),
    ) {
        if count > 0 && dur_ns > 0 {
            let tps = count as f64 / (dur_ns as f64 / 1_000_000_000.0);
            if tps > 0.0 { result.tps = Some(tps as f32); }
        }
    }

    // Prefill speed + TTFT (Phase 2: new)
    if let (Some(pe_count), Some(pe_dur_ns)) = (
        json["prompt_eval_count"].as_u64(),
        json["prompt_eval_duration"].as_u64(),
    ) {
        // TTFT = prompt_eval_duration in milliseconds
        if pe_dur_ns > 0 {
            result.ttft_ms = Some(pe_dur_ns as f64 / 1_000_000.0 as f64).map(|v| v as f32);
            // Prefill tok/s
            if pe_count > 0 {
                let pe_tps = pe_count as f64 / (pe_dur_ns as f64 / 1_000_000_000.0);
                if pe_tps > 0.0 { result.prompt_eval_tps = Some(pe_tps as f32); }
            }
        }
    }

    // Model load duration (Phase 2: new — 0 when warm, >0 on cold start)
    if let Some(load_ns) = json["load_duration"].as_u64() {
        result.load_duration_ms = Some(load_ns as f64 / 1_000_000.0 as f64).map(|v| v as f32);
    }

    result
}

/// Fires a non-streaming 20-token completions probe against the vLLM
/// OpenAI-compatible API and returns tok/s derived from wall-clock timing.
///
/// Mirrors `probe_ollama_tps` semantics: the result represents the node's
/// **idle sustained throughput** — the baseline speed when the scheduler is
/// free, used to populate the IDLE-SPD label in the dashboard.
async fn probe_vllm_tps(client: &reqwest::Client, port: u16, model: &str) -> Option<f32> {
    let url = format!("http://127.0.0.1:{port}/v1/completions");
    let t0 = std::time::Instant::now();
    let resp = match client
        .post(&url)
        .json(&serde_json::json!({
            "model":       model,
            "prompt":      " ",
            "max_tokens":  20,
            "temperature": 0,
            "stream":      false,
        }))
        .send()
        .await
    {
        Ok(r)  => { eprintln!("[vllm] probe {url} → HTTP {}", r.status()); r }
        Err(e) => { eprintln!("[vllm] probe {url} → error: {e}"); return None; }
    };
    if !resp.status().is_success() { return None; }
    let elapsed = t0.elapsed().as_secs_f64();
    if elapsed <= 0.0 { return None; }
    let text = resp.text().await.ok()?;
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(n) = json["usage"]["completion_tokens"].as_u64() {
            if n > 0 {
                let tps = n as f64 / elapsed;
                if tps > 0.0 { return Some(tps as f32); }
            }
        }
    }
    None
}

// ── Attribution logic ─────────────────────────────────────────────────────────

pub(crate) struct AttributionResult {
    pub(crate) is_user_request: bool,
    pub(crate) consume_probe_flag: bool,
}

/// Determine whether an expires_at change should be attributed to a user request.
pub(crate) fn attribute_expires_change(
    probe_active: bool,
    probe_caused_next_reset: bool,
) -> AttributionResult {
    let is_probe_caused = probe_caused_next_reset && !probe_active;
    AttributionResult {
        is_user_request: !probe_active && !is_probe_caused,
        consume_probe_flag: is_probe_caused,
    }
}

pub(crate) fn start_ollama_harvester(
    apple:     Arc<Mutex<AppleSiliconMetrics>>,
    nvidia:    Arc<Mutex<NvidiaMetrics>>,
    proxy_arc: Option<Arc<ProxyState>>,
    port_rx: process_discovery::PortRx,
) -> (Arc<Mutex<OllamaMetrics>>, Arc<std::sync::atomic::AtomicBool>) {
    let shared = Arc::new(Mutex::new(OllamaMetrics::default()));
    // Atomic flag: true while the /api/generate probe is in-flight.
    // Owned here; cloned into the harvester task (for attribution) and
    // the probe task (to set/clear). Broadcast loops read it for Tier 3 gate.
    let probe_active: Arc<std::sync::atomic::AtomicBool> =
        Arc::new(std::sync::atomic::AtomicBool::new(false));

    // ── Main task: watch for port, poll /api/ps every 5s ────────────────────
    let shared_main = Arc::clone(&shared);
    let proxy_main  = proxy_arc.clone();
    let mut port_rx_main = port_rx.clone();
    let probe_active_harvester = Arc::clone(&probe_active);
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
            let discovered_port = port_rx_main.borrow().unwrap();

            // Validate the discovered port: the Tier 3 socket scan can pick up
            // internal worker-process sockets (e.g. ollama_llama_server on :34111)
            // that don't serve the Ollama HTTP API.  Hit /api/version as a quick
            // health check; if it fails, fall back to the runtime's default port.
            let port = {
                let check_url = format!("http://127.0.0.1:{discovered_port}/api/version");
                let api_ok = client.get(&check_url).send().await
                    .map(|r| r.status().is_success()).unwrap_or(false);
                if api_ok {
                    discovered_port
                } else {
                    // Use the RuntimeSpec default instead of hardcoding
                    let default_port: u16 = crate::process_discovery::default_port_for("ollama").unwrap_or(11434);
                    if discovered_port == default_port {
                        // Already tried default — nothing to fall back to.
                        eprintln!("[ollama] API not responding on :{default_port} — will retry");
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        continue; // back to outer wait loop
                    }
                    let fallback_url = format!("http://127.0.0.1:{default_port}/api/version");
                    let fallback_ok = client.get(&fallback_url).send().await
                        .map(|r| r.status().is_success()).unwrap_or(false);
                    if fallback_ok {
                        eprintln!(
                            "[ollama] :{discovered_port} is a worker socket (API returned 404), \
                             using default :{default_port}",
                        );
                        default_port
                    } else {
                        eprintln!(
                            "[ollama] API not responding on :{discovered_port} or :{default_port} — will retry"
                        );
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        continue; // back to outer wait loop
                    }
                }
            };
            // Store validated port so the probe task can read it.
            if let Ok(mut g) = shared_main.lock() { g.validated_port = Some(port); }
            let base = format!("http://127.0.0.1:{port}");
            eprintln!("[ollama] connected on :{port}");

            let mut interval      = tokio::time::interval(Duration::from_secs(5));
            let mut prev_expires:  Option<String>             = None;
            let mut prev_model:    Option<String>             = None;
            // Cached /api/show data — refreshed only when model changes.
            let mut cached_context_length:  Option<u64> = None;
            let mut cached_parameter_count: Option<u64> = None;
            // Architecture fields from /api/show — needed for KV cache math.
            let mut cached_num_layers:      Option<u64> = None;
            let mut cached_kv_heads:        Option<u64> = None;
            let mut cached_num_heads:       Option<u64> = None;
            let mut cached_embedding_dim:   Option<u64> = None;
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

                // Carry forward the previous shared state so the probe task's writes
                // (last_probe_start, last_probe_end) and attribution writes
                // (last_user_request_ts) survive across harvester ticks.
                // Without this, *g = m at the end of the loop would overwrite every
                // #[serde(skip)] field with None, destroying probe timing and the
                // 15 s user-request window.
                let prev_state = shared_main.lock().ok()
                    .map(|g| g.clone())
                    .unwrap_or_default();
                let mut m = OllamaMetrics {
                    ollama_running:           true,
                    ollama_tokens_per_second: prev_state.ollama_tokens_per_second,
                    last_probe_start:         prev_state.last_probe_start,
                    last_probe_end:           prev_state.last_probe_end,
                    last_user_request_ts:     prev_state.last_user_request_ts,
                    probe_caused_next_reset:  prev_state.probe_caused_next_reset,
                    validated_port:           prev_state.validated_port,
                    // Carry forward probe-derived latency fields (set every ~30s by probe task)
                    ollama_prompt_eval_tps:   prev_state.ollama_prompt_eval_tps,
                    ollama_ttft_ms:           prev_state.ollama_ttft_ms,
                    ollama_load_duration_ms:  prev_state.ollama_load_duration_ms,
                    // Carry forward /api/show-derived fields (refreshed on model change)
                    ollama_context_length:    prev_state.ollama_context_length,
                    ollama_parameter_count:   prev_state.ollama_parameter_count,
                    ollama_num_layers:        prev_state.ollama_num_layers,
                    ollama_kv_heads:          prev_state.ollama_kv_heads,
                    ollama_num_heads:         prev_state.ollama_num_heads,
                    ollama_embedding_dim:     prev_state.ollama_embedding_dim,
                    ..Default::default()
                };

                // Poll /api/ps for ALL loaded models and inference state.
                let mut ps_models: Vec<serde_json::Value> = Vec::new();
                if let Ok(resp) = client.get(format!("{base}/api/ps")).send().await {
                    if let Ok(json) = resp.json::<serde_json::Value>().await {
                        if let Some(arr) = json["models"].as_array() {
                            ps_models = arr.clone();
                        }
                    }
                }

                // Read per-model proxy stats (if proxy active).
                let proxy_model_stats: std::collections::HashMap<String, (f32, u64, u64, u64, std::time::Instant)> =
                    if let Some(ref ps) = proxy_main {
                        let map = ps.per_model.lock().unwrap();
                        map.iter().map(|(k, v)| (k.clone(), (v.last_tps, v.ttft_sum_ns, v.latency_sum_ns, v.request_count, v.last_done))).collect()
                    } else {
                        std::collections::HashMap::new()
                    };

                // Build per-model live metrics array.
                let mut live_models: Vec<crate::ModelLiveMetrics> = Vec::new();
                let mut most_recent_done: Option<(String, std::time::Instant)> = None;

                for entry in &ps_models {
                    let name = entry["name"].as_str().unwrap_or("").to_string();
                    let size_gb = entry["size"].as_u64().map(|b| b as f32 / 1_073_741_824.0);
                    let quant = entry["details"]["quantization_level"].as_str().map(|s| s.to_string());
                    let vram_mb = entry["size_vram"].as_u64().map(|b| b / (1024 * 1024));

                    let (tok_s, avg_ttft, avg_lat, req_count) = if let Some(&(tps, ttft_ns, lat_ns, cnt, _)) = proxy_model_stats.get(&name) {
                        let ttft = if cnt > 0 { Some((ttft_ns as f64 / cnt as f64 / 1_000_000.0) as f32) } else { None };
                        let lat  = if cnt > 0 { Some((lat_ns as f64 / cnt as f64 / 1_000_000.0) as f32) } else { None };
                        (Some(tps), ttft, lat, cnt)
                    } else {
                        (None, None, None, 0)
                    };

                    live_models.push(crate::ModelLiveMetrics {
                        model: name.clone(), size_gb, quantization: quant, vram_mb,
                        tok_s, avg_ttft_ms: avg_ttft, avg_latency_ms: avg_lat, request_count: req_count,
                        wes: None, // Computed in broadcast loop with power + thermal data
                    });

                    // Track most-recently-active model for singular field backwards compat
                    if let Some(&(_, _, _, _, done_ts)) = proxy_model_stats.get(&name) {
                        if most_recent_done.as_ref().map_or(true, |(_, t)| done_ts > *t) {
                            most_recent_done = Some((name.clone(), done_ts));
                        }
                    }
                }

                // Singular fields: use most-recently-active model (or first if no proxy stats).
                let primary_model = most_recent_done.as_ref().map(|(n, _)| n.as_str())
                    .or_else(|| ps_models.first().and_then(|m| m["name"].as_str()));
                if let Some(pm) = primary_model {
                    let pm_entry = ps_models.iter().find(|e| e["name"].as_str() == Some(pm));
                    m.ollama_active_model = Some(pm.to_string());
                    m.ollama_model_size_gb = pm_entry.and_then(|e| e["size"].as_u64()).map(|b| b as f32 / 1_073_741_824.0);
                    m.ollama_quantization = pm_entry.and_then(|e| e["details"]["quantization_level"].as_str()).map(|s| s.to_string());
                }

                // Fetch context_length + parameter_count from /api/show when primary model changes.
                let current_model = m.ollama_active_model.clone();
                if current_model != prev_model {
                    prev_model = current_model.clone();
                    if let Some(ref model_name) = current_model {
                        if let Ok(show_resp) = client.post(format!("{base}/api/show"))
                            .json(&serde_json::json!({ "name": model_name }))
                            .send().await
                        {
                            if let Ok(show_json) = show_resp.json::<serde_json::Value>().await {
                                let mi = &show_json["model_info"];
                                cached_context_length = mi["general.context_length"].as_u64()
                                    .or_else(|| mi["llama.context_length"].as_u64());
                                cached_parameter_count = mi["general.parameter_count"].as_u64()
                                    .or_else(|| mi["llama.parameter_count"].as_u64());
                                // Architecture fields for KV cache estimation.
                                // llama.block_count = transformer layer count.
                                // llama.attention.head_count_kv = KV heads (< total heads on GQA models).
                                // llama.attention.head_count = total attention heads.
                                // llama.embedding_length = model embedding dimension.
                                // head_dim = embedding_length / head_count (derived on the frontend).
                                cached_num_layers    = mi["llama.block_count"].as_u64();
                                cached_kv_heads      = mi["llama.attention.head_count_kv"].as_u64();
                                cached_num_heads     = mi["llama.attention.head_count"].as_u64();
                                cached_embedding_dim = mi["llama.embedding_length"].as_u64();
                            }
                        }
                    } else {
                        cached_context_length = None;
                        cached_parameter_count = None;
                    }
                }
                m.ollama_context_length = cached_context_length;
                m.ollama_parameter_count = cached_parameter_count;
                m.ollama_num_layers    = cached_num_layers;
                m.ollama_kv_heads      = cached_kv_heads;
                m.ollama_num_heads     = cached_num_heads;
                m.ollama_embedding_dim = cached_embedding_dim;

                // Detect inference activity via expires_at resets (use first model — same as before).
                if let Some(first) = ps_models.first() {
                    if let Some(exp_str) = first["expires_at"].as_str() {
                        let exp_owned = exp_str.to_string();
                        if prev_expires.as_deref() != Some(&exp_owned) {
                            last_infer_ts = Some(std::time::Instant::now());
                            let result = attribute_expires_change(
                                probe_active_harvester.load(std::sync::atomic::Ordering::Acquire),
                                m.probe_caused_next_reset,
                            );
                            if result.consume_probe_flag {
                                m.probe_caused_next_reset = false;
                            }
                            if result.is_user_request {
                                m.last_user_request_ts = Some(std::time::Instant::now());
                            }
                        }
                        prev_expires = Some(exp_owned);
                    }
                }

                // Set active_models only when >1 model (no payload bloat for single model).
                m.active_models = if live_models.len() > 1 { Some(live_models) } else { None };

                // Inference-active signal + proxy aggregate stats.
                if let Some(ref ps) = proxy_main {
                    let proxy_active = ps.inference_active.load(std::sync::atomic::Ordering::Relaxed);
                    let since_done   = ps.last_done_ts.lock().unwrap()
                        .map_or(false, |t| t.elapsed().as_secs() < 15);
                    m.ollama_inference_active = Some(proxy_active || since_done);
                    m.ollama_proxy_active = true;

                    // Most-recently-active model's tok/s for singular field
                    if let Some((ref name, _)) = most_recent_done {
                        if let Some(&(tps, _, _, _, _)) = proxy_model_stats.get(name) {
                            m.ollama_tokens_per_second = Some(tps);
                        }
                    }

                    // Aggregate across all models for singular proxy averages
                    let total_reqs: u64 = proxy_model_stats.values().map(|&(_, _, _, cnt, _)| cnt).sum();
                    if total_reqs > 0 {
                        let total_ttft: u64 = proxy_model_stats.values().map(|&(_, t, _, _, _)| t).sum();
                        let total_lat: u64 = proxy_model_stats.values().map(|&(_, _, l, _, _)| l).sum();
                        m.ollama_proxy_avg_ttft_ms    = Some((total_ttft as f64 / total_reqs as f64 / 1_000_000.0) as f32);
                        m.ollama_proxy_avg_latency_ms = Some((total_lat as f64 / total_reqs as f64 / 1_000_000.0) as f32);
                        m.ollama_proxy_request_count  = Some(total_reqs);
                    }

                    // Cleanup: remove proxy stats for models no longer loaded in Ollama
                    let loaded_names: std::collections::HashSet<String> = ps_models.iter()
                        .filter_map(|e| e["name"].as_str().map(|s| s.to_string())).collect();
                    let mut map = ps.per_model.lock().unwrap();
                    map.retain(|k, _| loaded_names.contains(k));
                } else {
                    // No proxy — fall back to /api/ps timer for inference detection.
                    m.ollama_inference_active =
                        Some(last_infer_ts.map_or(false, |t| t.elapsed().as_secs() < 15));
                }

                if let Ok(mut g) = shared_main.lock() { *g = m; }
            }
        }
    });

    // ── Probe task: scheduled 20-token benchmark every 30s ──────────────────
    // Runs on all nodes (with or without proxy). When the proxy is active and
    // has recent traffic (request in the last 60s), the probe skips — the proxy
    // provides exact tok/s, TTFT, and latency from real done packets, making
    // synthetic probes redundant and potentially disruptive.
    // When the proxy is active but IDLE (no recent traffic), the probe fires
    // to populate baseline TTFT, prefill speed, and load duration — fields the
    // proxy never provides (they're probe-only metrics).
    let proxy_for_probe = proxy_arc.clone();
    {
        let shared_probe = Arc::clone(&shared);
        let apple_probe  = Arc::clone(&apple);
        let nvidia_probe = Arc::clone(&nvidia);
        let probe_active_clone = Arc::clone(&probe_active);
        tokio::spawn(async move {
            // Generous timeout: CPU-only inference of 20 tokens can take several seconds.
            let probe_client = reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .unwrap_or_default();

            // ── Startup delay ────────────────────────────────────────────────
            // Tokio fires the first interval.tick() immediately.  The main task
            // also starts immediately and needs one HTTP round-trip to /api/ps
            // before ollama_active_model is populated.  Without this delay the
            // probe fires, finds ollama_active_model = None, skips, then waits
            // a full 30 s before trying again — causing the visible startup lag.
            // 7 s comfortably covers the /api/ps round-trip even on slow machines.
            tokio::time::sleep(Duration::from_secs(7)).await;

            let mut interval = tokio::time::interval(Duration::from_secs(30));
            loop {
                interval.tick().await;

                // Read the API-validated port from shared state (set by the main
                // harvester after health-checking). This avoids hitting internal
                // worker sockets that don't serve the Ollama HTTP API.
                let Some(port) = shared_probe.lock().ok().and_then(|g| g.validated_port) else {
                    // Main harvester hasn't validated a port yet — skip this cycle.
                    continue;
                };

                // Model resolution order:
                //   1. Currently loaded model from /api/ps  (preferred — already warm)
                //   2. First installed model from /api/tags (fallback — handles the
                //      restart case where keep_alive has already unloaded everything;
                //      Ollama auto-loads the model when the generate request arrives)
                //   3. None → skip this cycle (no models installed at all)
                let current_model = shared_probe.lock().ok()
                    .and_then(|g| if g.ollama_running { g.ollama_active_model.clone() } else { None });
                let model = if current_model.is_some() {
                    current_model
                } else {
                    discover_first_ollama_model(&probe_client, port).await
                };
                let Some(model) = model else {
                    eprintln!("[ollama] probe skip — no model found (not loaded + /api/tags empty) on :{port}");
                    continue;
                };

                // Read current GPU utilisation — NVIDIA takes priority, fall back to
                // Apple Silicon. None means no GPU sensor available (CPU-only node).
                let gpu_util: Option<f32> = nvidia_probe.lock().ok()
                    .and_then(|g| g.nvidia_gpu_utilization_percent)
                    .or_else(|| apple_probe.lock().ok().and_then(|g| g.gpu_utilization_percent));

                // Skip when GPU is clearly under load — retain the last successful
                // probe value so the UI shows "last known: N tok/s" rather than "—".
                // Clearing to None would flatline the display; the cached baseline is
                // a better approximation than nothing during high-load windows.
                //
                // Exception: if no baseline exists yet (fresh start / first run), always
                // fire the probe regardless of GPU load.  Without a first successful probe
                // the "retain cached" path has nothing to retain, leaving the UI blank.
                // One probe under load is acceptable — it establishes the peak reference
                // that all subsequent GPU-scaled estimates depend on.
                let has_baseline = shared_probe.lock().ok()
                    .map(|g| g.ollama_tokens_per_second.is_some())
                    .unwrap_or(false);
                if !has_baseline {
                    eprintln!(
                        "[ollama] no baseline yet — forcing initial probe despite GPU at {:.0}%",
                        gpu_util.unwrap_or(0.0),
                    );
                } else if gpu_util.map_or(false, |u| u >= GPU_LOAD_THRESHOLD_PCT) {
                    eprintln!(
                        "[ollama] probe skipped — GPU at {:.0}% (≥{:.0}%), retaining cached baseline",
                        gpu_util.unwrap_or(0.0), GPU_LOAD_THRESHOLD_PCT,
                    );
                    continue;
                }

                // When proxy is active with recent traffic, skip — proxy provides
                // exact tok/s from done packets; probing would interfere.
                if let Some(ref ps) = proxy_for_probe {
                    let recent_req = ps.last_done_ts.lock().unwrap()
                        .map_or(false, |t| t.elapsed().as_secs() < 60);
                    if recent_req {
                        continue; // proxy has fresh production data — no probe needed
                    }
                }

                // GPU is idle enough — fire the full 20-token benchmark.
                // Set probe_active = true before the HTTP call; Drop guard resets it
                // to false even if the future is cancelled or panics (scopeguard).
                // Set last_probe_start now; last_probe_end after it returns.
                // ollama_is_probing (frontend display) uses last_probe_end + 5 s cool-down.
                if let Ok(mut g) = shared_probe.lock() {
                    g.last_probe_start = Some(std::time::Instant::now());
                    g.last_probe_end   = None; // clear end so is_probing_display() knows it's running
                }
                probe_active_clone.store(true, std::sync::atomic::Ordering::SeqCst);
                // Drop guard: resets probe_active = false even on panic or cancellation.
                // scopeguard::defer! expands to a let-binding — do NOT wrap in another let.
                scopeguard::defer! {
                    probe_active_clone.store(false, std::sync::atomic::Ordering::SeqCst);
                }
                let probe_result = probe_ollama_tps(&probe_client, port, &model).await;
                if let Ok(mut g) = shared_probe.lock() {
                    g.ollama_tokens_per_second   = probe_result.tps;
                    g.ollama_prompt_eval_tps     = probe_result.prompt_eval_tps;
                    g.ollama_ttft_ms             = probe_result.ttft_ms;
                    g.ollama_load_duration_ms    = probe_result.load_duration_ms;
                    g.last_probe_end = Some(std::time::Instant::now());
                    // Tell the harvester: the next expires_at change you see is mine.
                    // The harvester will consume this flag and skip attribution for
                    // that single change. Any further changes are user requests.
                    g.probe_caused_next_reset = true;
                }
                // defer guard drops here → probe_active = false
            }
        });
    }

    (shared, probe_active)
}

// ── vLLM Harvester ──────────────────────────────────────────────────────────────────────────────
//
// Polls the vLLM Prometheus /metrics endpoint on the port discovered by the
// process scanner. Called on a 2 s tick with a 500 ms timeout per call.
// No full Prometheus parser: lines are matched by metric-name prefix.

/// Result of a single vLLM Prometheus /metrics poll.
/// Named struct instead of positional tuple for clarity and extensibility.
#[derive(Default)]
struct VllmHarvestResult {
    running:              bool,
    model_name:           Option<String>,
    tokens_per_sec:       Option<f32>,
    cache_usage_perc:     Option<f32>,
    requests_running:     Option<u32>,
    // Phase 1: queue/saturation gauges
    requests_waiting:     Option<u32>,
    requests_swapped:     Option<u32>,
    // Phase 3 (histogram deltas): raw _sum/_count accumulators for windowed averages
    ttft_sum:             Option<f64>,
    ttft_count:           Option<u64>,
    e2e_sum:              Option<f64>,
    e2e_count:            Option<u64>,
    queue_time_sum:       Option<f64>,
    queue_time_count:     Option<u64>,
    prompt_tokens_total:  Option<u64>,
    gen_tokens_total:     Option<u64>,
}

/// Probe vLLM once on `port`. Never panics on malformed input.
async fn harvest_vllm(port: u16) -> VllmHarvestResult {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
    {
        Ok(c)  => c,
        Err(_) => return VllmHarvestResult::default(),
    };

    // Explicit 127.0.0.1 (not localhost) to avoid Windows resolving localhost → ::1.
    let resp = match client.get(format!("http://127.0.0.1:{port}/metrics")).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return VllmHarvestResult::default(),
    };

    let text = match resp.text().await {
        Ok(t)  => t,
        Err(_) => return VllmHarvestResult { running: true, ..Default::default() },
    };

    let mut r = VllmHarvestResult { running: true, ..Default::default() };

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
        let raw_value: Option<f64> = line.split_whitespace().last()
            .and_then(|s| s.parse().ok());
        let value_f32: Option<f32> = raw_value.map(|v| v as f32);

        // Extract model_name="..." from the label string (first occurrence wins).
        if r.model_name.is_none() {
            if let Some(start) = line.find("model_name=\"") {
                let rest = &line[start + 12..];
                if let Some(end) = rest.find('"') {
                    r.model_name = Some(rest[..end].to_string());
                }
            }
        }

        let parse_u32 = |v: Option<f32>| -> Option<u32> {
            v.and_then(|v| if v >= 0.0 && v < u32::MAX as f32 { Some(v as u32) } else { None })
        };
        let parse_u64 = |v: Option<f64>| -> Option<u64> {
            v.and_then(|v| if v >= 0.0 { Some(v as u64) } else { None })
        };

        match metric_name.trim() {
            // ── Existing gauges ──────────────────────────────────────────────────
            "vllm:avg_generation_throughput_toks_per_s" => {
                r.tokens_per_sec = value_f32.filter(|&v| v > 0.1);
            }
            "vllm:gpu_cache_usage_perc" | "vllm:kv_cache_usage_perc" => {
                r.cache_usage_perc = value_f32.map(|v| v * 100.0);
            }
            "vllm:num_requests_running" => {
                r.requests_running = parse_u32(value_f32);
            }
            // ── Phase 1: queue/saturation gauges ────────────────────────────────
            "vllm:num_requests_waiting" => {
                r.requests_waiting = parse_u32(value_f32);
            }
            "vllm:num_requests_swapped" => {
                r.requests_swapped = parse_u32(value_f32);
            }
            // ── Phase 3: histogram _sum/_count for windowed averages ────────────
            "vllm:time_to_first_token_seconds_sum" => {
                r.ttft_sum = raw_value;
            }
            "vllm:time_to_first_token_seconds_count" => {
                r.ttft_count = parse_u64(raw_value);
            }
            "vllm:e2e_request_latency_seconds_sum" | "vllm:request_inference_time_seconds_sum" => {
                r.e2e_sum = raw_value;
            }
            "vllm:e2e_request_latency_seconds_count" | "vllm:request_inference_time_seconds_count" => {
                r.e2e_count = parse_u64(raw_value);
            }
            "vllm:request_queue_time_seconds_sum" => {
                r.queue_time_sum = raw_value;
            }
            "vllm:request_queue_time_seconds_count" => {
                r.queue_time_count = parse_u64(raw_value);
            }
            "vllm:request_prompt_tokens_sum" => {
                r.prompt_tokens_total = parse_u64(raw_value);
            }
            "vllm:request_generation_tokens_sum" => {
                r.gen_tokens_total = parse_u64(raw_value);
            }
            _ => {}
        }
    }

    r
}

/// Spawns a 2 s polling loop that watches for vLLM via the discovery channel,
/// then polls the Prometheus /metrics endpoint on the discovered port.
///
/// Also spawns a 30 s idle-probe task that fires `probe_vllm_tps` when the
/// scheduler is idle (`num_requests_running == 0`) and the GPU is below the
/// load threshold — the result populates `vllm_tokens_per_sec` as the IDLE-SPD
/// baseline, exactly mirroring the Ollama probe behaviour.
pub(crate) fn start_vllm_harvester(
    port_rx: process_discovery::PortRx,
    apple:       Arc<Mutex<AppleSiliconMetrics>>,
    nvidia:      Arc<Mutex<NvidiaMetrics>>,
) -> Arc<Mutex<VllmMetrics>> {
    let shared = Arc::new(Mutex::new(VllmMetrics::default()));

    // ── Main task: 2 s Prometheus /metrics poll ──────────────────────────────
    let shared_main  = Arc::clone(&shared);
    let mut port_rx_main = port_rx.clone();
    tokio::spawn(async move {
        loop {
            // Wait until discovery reports vLLM is running.
            loop {
                if port_rx_main.borrow().is_some() { break; }
                if port_rx_main.changed().await.is_err() { return; }
            }
            let port = port_rx_main.borrow().unwrap();
            eprintln!("[vllm] connected on :{port}");

            let mut interval = tokio::time::interval(Duration::from_secs(2));

            loop {
                interval.tick().await;

                if port_rx_main.has_changed().unwrap_or(false) {
                    match *port_rx_main.borrow_and_update() {
                        None => {
                            eprintln!("[vllm] process gone — clearing metrics");
                            if let Ok(mut g) = shared_main.lock() { *g = VllmMetrics::default(); }
                            break;
                        }
                        Some(new_port) if new_port != port => { break; }
                        _ => {}
                    }
                }

                let h = harvest_vllm(port).await;
                if let Ok(mut g) = shared_main.lock() {
                    if !h.running {
                        *g = VllmMetrics::default();
                    } else {
                        g.vllm_running          = true;
                        if let Some(m) = h.model_name  { g.vllm_model_name = Some(m); }
                        // Only overwrite tok/s with live Prometheus value when the
                        // scheduler is actively generating (filter_out_zero applied
                        // upstream). When idle (None), preserve the probe baseline.
                        if h.tokens_per_sec.is_some()  { g.vllm_tokens_per_sec = h.tokens_per_sec; }
                        g.vllm_cache_usage_perc  = h.cache_usage_perc;
                        g.vllm_requests_running  = h.requests_running;
                        g.vllm_requests_waiting  = h.requests_waiting;
                        g.vllm_requests_swapped  = h.requests_swapped;

                        // Phase 3: compute windowed averages from histogram deltas
                        // TTFT
                        if let (Some(sum), Some(count)) = (h.ttft_sum, h.ttft_count) {
                            if let (Some(ps), Some(pc)) = (g.prev_ttft_sum, g.prev_ttft_count) {
                                let dc = count.saturating_sub(pc);
                                if dc >= 1 { // at least 1 new request in the window
                                    let ds = sum - ps;
                                    g.vllm_avg_ttft_ms = Some((ds / dc as f64 * 1000.0) as f32);
                                }
                            }
                            g.prev_ttft_sum   = Some(sum);
                            g.prev_ttft_count = Some(count);
                        }
                        // E2E latency
                        if let (Some(sum), Some(count)) = (h.e2e_sum, h.e2e_count) {
                            if let (Some(ps), Some(pc)) = (g.prev_e2e_sum, g.prev_e2e_count) {
                                let dc = count.saturating_sub(pc);
                                if dc >= 3 {
                                    let ds = sum - ps;
                                    g.vllm_avg_e2e_latency_ms = Some((ds / dc as f64 * 1000.0) as f32);
                                }
                            }
                            g.prev_e2e_sum   = Some(sum);
                            g.prev_e2e_count = Some(count);
                        }
                        // Queue time
                        if let (Some(sum), Some(count)) = (h.queue_time_sum, h.queue_time_count) {
                            if let (Some(ps), Some(pc)) = (g.prev_queue_time_sum, g.prev_queue_time_count) {
                                let dc = count.saturating_sub(pc);
                                if dc >= 3 {
                                    let ds = sum - ps;
                                    g.vllm_avg_queue_time_ms = Some((ds / dc as f64 * 1000.0) as f32);
                                }
                            }
                            g.prev_queue_time_sum   = Some(sum);
                            g.prev_queue_time_count = Some(count);
                        }
                        // Token counters
                        g.vllm_prompt_tokens_total = h.prompt_tokens_total;
                        g.vllm_generation_tokens_total = h.gen_tokens_total;
                    }
                }
            }
        }
    });

    // ── Probe task: 30 s idle tok/s measurement (IDLE-SPD baseline) ─────────
    let shared_probe = Arc::clone(&shared);
    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_default();

        // Brief startup delay — gives the main task (2 s Prometheus poll) time to
        // populate vllm_model_name before the first probe fires.  Mirrors the
        // Ollama probe delay; 7 s is generous for the 2 s main-task cycle.
        tokio::time::sleep(Duration::from_secs(7)).await;

        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;

            // Read port and model while idle — bail if not ready.
            let (port, model) = {
                let g = match shared_probe.lock() { Ok(g) => g, Err(_) => continue };
                if !g.vllm_running { continue; }
                if g.vllm_requests_running.map_or(false, |r| r > 0) { continue; }
                let port  = match *port_rx.borrow() { Some(p) => p, None => continue };
                let model = match g.vllm_model_name.clone() { Some(m) => m, None => continue };
                (port, model)
            };

            // Skip when GPU is already under load — same gate as Ollama probe.
            // Exception: no baseline yet → force the first probe to establish a reference.
            let gpu_util: Option<f32> = nvidia.lock().ok()
                .and_then(|g| g.nvidia_gpu_utilization_percent)
                .or_else(|| apple.lock().ok().and_then(|g| g.gpu_utilization_percent));
            let vllm_has_baseline = shared_probe.lock().ok()
                .map(|g| g.vllm_tokens_per_sec.is_some())
                .unwrap_or(false);
            if !vllm_has_baseline {
                eprintln!(
                    "[vllm] no baseline yet — forcing initial probe despite GPU at {:.0}%",
                    gpu_util.unwrap_or(0.0),
                );
            } else if gpu_util.map_or(false, |u| u >= GPU_LOAD_THRESHOLD_PCT) {
                eprintln!(
                    "[vllm] probe skipped — GPU at {:.0}% (≥{:.0}%), retaining cached baseline",
                    gpu_util.unwrap_or(0.0), GPU_LOAD_THRESHOLD_PCT
                );
                continue; // retain last probe value — UI shows "last known: N tok/s"
            }

            eprintln!("[vllm] probing idle tok/s on :{port} model={model}");
            if let Some(tps) = probe_vllm_tps(&client, port, &model).await {
                eprintln!("[vllm] idle probe → {tps:.1} tok/s");
                if let Ok(mut g) = shared_probe.lock() {
                    g.vllm_tokens_per_sec = Some(tps);
                    g.last_probe_end = Some(std::time::Instant::now());
                }
            }
        }
    });

    shared
}

// ── llama.cpp / llama-box harvester ──────────────────────────────────────────

/// Poll llama.cpp's `/health?include_slots` endpoint.
/// Returns (running, model_name, slots_processing).
async fn harvest_llamacpp(port: u16) -> (bool, Option<String>, Option<u32>) {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
    {
        Ok(c)  => c,
        Err(_) => return (false, None, None),
    };

    // /health?include_slots returns { "status": "ok", "slots_idle": N, "slots_processing": N }
    let resp = match client
        .get(format!("http://127.0.0.1:{port}/health?include_slots"))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return (false, None, None),
    };

    let json: serde_json::Value = match resp.json().await {
        Ok(j)  => j,
        Err(_) => return (true, None, None),
    };

    let status = json["status"].as_str().unwrap_or("");
    if status != "ok" {
        // "loading model", "error", etc. — server is up but not ready.
        return (true, None, None);
    }

    let slots_processing = json["slots_processing"]
        .as_u64()
        .map(|v| v as u32);

    // Model name: not in /health response. Fetch from /slots (first slot's "model" field).
    let model_name = match client
        .get(format!("http://127.0.0.1:{port}/slots"))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            r.json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|arr| {
                    arr.as_array()?
                        .first()?
                        .get("model")?
                        .as_str()
                        .map(|s| s.to_string())
                })
        }
        _ => None,
    };

    (true, model_name, slots_processing)
}

/// Fires a non-streaming 20-token completions probe against the llama.cpp
/// OpenAI-compatible API and returns tok/s derived from wall-clock timing.
///
/// Mirrors `probe_vllm_tps` semantics: idle sustained throughput baseline.
async fn probe_llamacpp_tps(client: &reqwest::Client, port: u16, model: &str) -> Option<f32> {
    let url = format!("http://127.0.0.1:{port}/v1/completions");
    let t0 = std::time::Instant::now();
    let resp = match client
        .post(&url)
        .json(&serde_json::json!({
            "model":       model,
            "prompt":      " ",
            "max_tokens":  20,
            "temperature": 0,
            "stream":      false,
        }))
        .send()
        .await
    {
        Ok(r)  => { eprintln!("[llamacpp] probe {url} → HTTP {}", r.status()); r }
        Err(e) => { eprintln!("[llamacpp] probe {url} → error: {e}"); return None; }
    };
    if !resp.status().is_success() { return None; }
    let elapsed = t0.elapsed().as_secs_f64();
    if elapsed <= 0.0 { return None; }
    let text = resp.text().await.ok()?;
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(n) = json["usage"]["completion_tokens"].as_u64() {
            if n > 0 {
                let tps = n as f64 / elapsed;
                if tps > 0.0 { return Some(tps as f32); }
            }
        }
    }
    None
}

/// Spawns a 2 s polling loop that watches for llama.cpp via the discovery channel,
/// then polls the `/health?include_slots` endpoint on the discovered port.
///
/// Also spawns a 30 s idle-probe task that fires `probe_llamacpp_tps` when the
/// scheduler is idle (`slots_processing == 0`) and the GPU is below the
/// load threshold — the result populates `llamacpp_tokens_per_sec` as the IDLE-SPD
/// baseline, exactly mirroring the vLLM probe behaviour.
pub(crate) fn start_llamacpp_harvester(
    port_rx: process_discovery::PortRx,
    apple:   Arc<Mutex<AppleSiliconMetrics>>,
    nvidia:  Arc<Mutex<NvidiaMetrics>>,
) -> Arc<Mutex<LlamacppMetrics>> {
    let shared = Arc::new(Mutex::new(LlamacppMetrics::default()));

    // ── Main task: 2 s /health?include_slots poll ────────────────────────────
    let shared_main = Arc::clone(&shared);
    let mut port_rx_main = port_rx.clone();
    tokio::spawn(async move {
        loop {
            // Wait until discovery reports llama.cpp/llama-box is running.
            loop {
                if port_rx_main.borrow().is_some() { break; }
                if port_rx_main.changed().await.is_err() { return; }
            }
            let port = port_rx_main.borrow().unwrap();
            eprintln!("[llamacpp] connected on :{port}");

            let mut interval = tokio::time::interval(Duration::from_secs(2));

            loop {
                interval.tick().await;

                if port_rx_main.has_changed().unwrap_or(false) {
                    match *port_rx_main.borrow_and_update() {
                        None => {
                            eprintln!("[llamacpp] process gone — clearing metrics");
                            if let Ok(mut g) = shared_main.lock() { *g = LlamacppMetrics::default(); }
                            break;
                        }
                        Some(new_port) if new_port != port => { break; }
                        _ => {}
                    }
                }

                let (running, model, slots) = harvest_llamacpp(port).await;
                if let Ok(mut g) = shared_main.lock() {
                    if !running {
                        *g = LlamacppMetrics::default();
                    } else {
                        g.llamacpp_running = true;
                        if let Some(m) = model { g.llamacpp_model_name = Some(m); }
                        g.llamacpp_slots_processing = slots;
                    }
                }
            }
        }
    });

    // ── Probe task: 30 s idle tok/s measurement (IDLE-SPD baseline) ──────────
    let shared_probe = Arc::clone(&shared);
    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_default();

        // Brief startup delay — gives the main task time to populate model name.
        tokio::time::sleep(Duration::from_secs(7)).await;

        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;

            // Read port and model while idle — bail if not ready.
            let (port, model) = {
                let g = match shared_probe.lock() { Ok(g) => g, Err(_) => continue };
                if !g.llamacpp_running { continue; }
                if g.llamacpp_slots_processing.map_or(false, |s| s > 0) { continue; }
                let port  = match *port_rx.borrow() { Some(p) => p, None => continue };
                let model = match g.llamacpp_model_name.clone() { Some(m) => m, None => continue };
                (port, model)
            };

            // Skip when GPU is already under load — same gate as vLLM probe.
            let gpu_util: Option<f32> = nvidia.lock().ok()
                .and_then(|g| g.nvidia_gpu_utilization_percent)
                .or_else(|| apple.lock().ok().and_then(|g| g.gpu_utilization_percent));
            let has_baseline = shared_probe.lock().ok()
                .map(|g| g.llamacpp_tokens_per_sec.is_some())
                .unwrap_or(false);
            if !has_baseline {
                eprintln!(
                    "[llamacpp] no baseline yet — forcing initial probe despite GPU at {:.0}%",
                    gpu_util.unwrap_or(0.0),
                );
            } else if gpu_util.map_or(false, |u| u >= GPU_LOAD_THRESHOLD_PCT) {
                eprintln!(
                    "[llamacpp] probe skipped — GPU at {:.0}% (≥{:.0}%), retaining cached baseline",
                    gpu_util.unwrap_or(0.0), GPU_LOAD_THRESHOLD_PCT
                );
                continue;
            }

            eprintln!("[llamacpp] probing idle tok/s on :{port} model={model}");
            if let Some(tps) = probe_llamacpp_tps(&client, port, &model).await {
                eprintln!("[llamacpp] idle probe → {tps:.1} tok/s");
                if let Ok(mut g) = shared_probe.lock() {
                    g.llamacpp_tokens_per_sec = Some(tps);
                    g.last_probe_end = Some(std::time::Instant::now());
                }
            }
        }
    });

    shared
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attribution_user_request_when_no_probe() {
        let r = attribute_expires_change(false, false);
        assert!(r.is_user_request);
        assert!(!r.consume_probe_flag);
    }

    #[test]
    fn attribution_probe_active_not_user() {
        let r = attribute_expires_change(true, false);
        assert!(!r.is_user_request);
        assert!(!r.consume_probe_flag);
    }

    #[test]
    fn attribution_probe_caused_reset_consumed() {
        let r = attribute_expires_change(false, true);
        assert!(!r.is_user_request);
        assert!(r.consume_probe_flag);
    }

    #[test]
    fn attribution_probe_active_with_flag_still_not_user() {
        // probe_active=true means probe_caused_next_reset doesn't matter
        let r = attribute_expires_change(true, true);
        assert!(!r.is_user_request);
        assert!(!r.consume_probe_flag); // flag not consumed because probe_active overrides
    }
}
