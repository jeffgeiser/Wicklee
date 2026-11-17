use crate::{AppleSiliconMetrics, NvidiaMetrics, OllamaMetrics, VllmMetrics, LlamacppMetrics};
use crate::caps::SharedCaps;
use crate::ollama_client::{GenerateResponse, PsResponse};
use crate::proxy::ProxyState;
use crate::process_discovery;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// GPU utilisation above this threshold (%) causes the probe to be skipped.
/// The dashboard estimation formula (peak × gpu_util%) covers the busy case,
/// so firing tokens into an already-loaded scheduler would only add noise.
const GPU_LOAD_THRESHOLD_PCT: f32 = 40.0;

/// How often the probe tasks wake to check whether a probe is due. Cheap —
/// each wake only reads shared state; an actual generation fires at most once
/// per [`ProbePolicy::interval`] (or when no baseline exists / the model changed).
const PROBE_CHECK_TICK: Duration = Duration::from_secs(30);

/// Extra time a successful baseline stays "fresh" past the probe interval, so
/// IDLE-SPD doesn't flicker to IDLE while the next scheduled probe is pending.
const BASELINE_FRESH_SLACK: Duration = Duration::from_secs(60);

/// Idle-probe policy, from the `[probe]` section of config.toml.
///
/// Each probe is a real ~20-token generation, so it costs GPU time and (for
/// Ollama) resets the model's keep_alive timer. Probes therefore fire only when
/// the baseline is missing, the model changed, or the last attempt is older
/// than `interval` — never on every tick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ProbePolicy {
    /// false → no probe tasks are spawned at all (IDLE-SPD / baseline tok/s
    /// then come only from the proxy or runtime-reported metrics).
    pub(crate) enabled:  bool,
    /// Minimum time between probes once a baseline for the current model exists.
    pub(crate) interval: Duration,
}

impl Default for ProbePolicy {
    fn default() -> Self {
        Self { enabled: true, interval: Duration::from_secs(600) }
    }
}

/// Whether a scheduled probe is due. A missing baseline or a model change makes
/// it due immediately; otherwise it waits until `interval` has elapsed since
/// the last attempt (successful or not — a failing runtime isn't hammered).
pub(crate) fn probe_due(
    has_baseline:      bool,
    last_probed_model: Option<&str>,
    model:             &str,
    last_attempt:      Option<std::time::Instant>,
    interval:          Duration,
    now:               std::time::Instant,
) -> bool {
    if !has_baseline || last_probed_model != Some(model) {
        return true;
    }
    last_attempt.is_none_or(|t| now.saturating_duration_since(t) >= interval)
}

/// Number of tokens the idle probe generates. Small on purpose: the probe
/// exists to time a warm model, not to produce output.
const PROBE_TOKENS: u32 = 20;

/// True when an Ollama `/api/ps` response lists `model` as currently loaded.
///
/// Production code goes through [`probe_target`], which answers residency and
/// the running context in one pass. This remains as the subject of
/// `ps_lists_model_matches_loaded_only`, which covers the name-or-model field
/// matching that `PsResponse::find` does for both callers.
#[cfg(test)]
fn ps_lists_model(ps: &PsResponse, model: &str) -> bool {
    ps.find(model).is_some()
}

/// What a `/api/version` check against a candidate port actually observed.
///
/// Three outcomes, not two. The old code collapsed every failure into one
/// message — "is a worker socket (API returned 404)" — which it printed even
/// for a port with nothing listening on it at all. Those are different facts
/// with different fixes, and saying the wrong one sends the reader looking for
/// a process that does not exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApiCheck {
    /// Answered 2xx: this is the Ollama HTTP API.
    Ok,
    /// Something answered, but it is not the Ollama API — an internal worker
    /// socket (`ollama_llama_server`), or an unrelated service.
    NotOllama(u16),
    /// Nothing answered. `timed_out` separates "the connection was refused"
    /// from "it was accepted and then nothing came back".
    NoAnswer { timed_out: bool },
}

impl ApiCheck {
    /// Classify a `reqwest` outcome.
    pub(crate) fn of<T>(outcome: &Result<T, reqwest::Error>, status: Option<u16>) -> Self {
        match (outcome, status) {
            (Ok(_), Some(code)) if (200..300).contains(&code) => ApiCheck::Ok,
            (Ok(_), Some(code)) => ApiCheck::NotOllama(code),
            (Ok(_), None) => ApiCheck::NoAnswer { timed_out: false },
            (Err(e), _) => ApiCheck::NoAnswer { timed_out: e.is_timeout() },
        }
    }

    pub(crate) fn is_ok(self) -> bool {
        self == ApiCheck::Ok
    }

    /// What was observed, in words, for the log.
    pub(crate) fn describe(self, port: u16) -> String {
        match self {
            ApiCheck::Ok => format!(":{port} serves the Ollama API"),
            ApiCheck::NotOllama(code) => format!(
                "something is listening on :{port} but it is not the Ollama API (HTTP {code})"
            ),
            ApiCheck::NoAnswer { timed_out: false } => {
                format!("nothing is listening on :{port}")
            }
            ApiCheck::NoAnswer { timed_out: true } => format!(
                ":{port} accepted the connection but did not answer /api/version in time"
            ),
        }
    }
}

/// Hit `/api/version` on one port and say what was there.
///
/// Records the version string in the capability record on success. That is
/// informational only — capabilities are never inferred from a version
/// number, only from responses actually seen.
async fn check_ollama_api(client: &reqwest::Client, port: u16, caps: &SharedCaps) -> ApiCheck {
    let url = format!("http://127.0.0.1:{port}/api/version");
    let sent = client.get(&url).send().await;
    let status = sent.as_ref().ok().map(|r| r.status().as_u16());
    let check = ApiCheck::of(&sent, status);
    if check.is_ok()
        && let Ok(r) = sent
        && let Ok(v) = r.json::<crate::ollama_client::VersionResponse>().await
        && let Ok(mut c) = caps.lock()
    {
        c.observe_version(v.version.as_deref());
    }
    check
}

/// What the probe is allowed to do for one model, decided from a fresh
/// `/api/ps` read taken immediately before firing.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ProbeTarget {
    /// Resident, and its running context is known. Probe with this `num_ctx`.
    Probe { num_ctx: u64 },
    /// Not listed as loaded. Probing would make Ollama load it (multi-GB, and
    /// it resets the keep_alive timer), so skip.
    NotResident,
    /// Loaded, but `/api/ps` did not report a `context_length`. Skip rather
    /// than guess — see [`probe_request_body`] for why omitting `num_ctx` is
    /// not a safe default.
    ContextUnknown,
}

/// Decide what to do about `model`, given a `/api/ps` response.
pub(crate) fn probe_target(ps: &PsResponse, model: &str) -> ProbeTarget {
    let Some(entry) = ps.find(model) else { return ProbeTarget::NotResident };
    match entry.context_length.filter(|n| *n > 0) {
        Some(num_ctx) => ProbeTarget::Probe { num_ctx },
        None          => ProbeTarget::ContextUnknown,
    }
}

/// Body of the idle probe's `/api/generate` request.
///
/// `num_ctx` is **mandatory**, and that is the whole point of this function
/// existing. Step 0 verification item V3 measured that a request which omits
/// `num_ctx` makes Ollama *reload the model at the server default* — 65536 →
/// 4096 and 8192 → 4096, each with a multi-second `load_duration` on a model
/// that was already resident. The probe used to omit it, so on any host
/// running a non-default context it silently destroyed that context every
/// probe interval and charged the user a reload for it.
///
/// Passing the context that `/api/ps` reports as *currently running* keeps the
/// loaded configuration exactly as it was. There is no safe fallback value:
/// any guess that differs from the running context causes the same reload, so
/// an unknown context means no probe (see [`ProbeTarget::ContextUnknown`]).
///
/// `keep_alive` is still deliberately absent — Ollama has no "leave the expiry
/// as it is" value, so sending one would override the operator's own
/// `OLLAMA_KEEP_ALIVE`.
pub(crate) fn probe_request_body(model: &str, num_ctx: u64) -> serde_json::Value {
    serde_json::json!({
        "model":   model,
        "prompt":  " ",
        "stream":  false,
        "options": { "num_predict": PROBE_TOKENS, "num_ctx": num_ctx }
    })
}

/// Re-reads `/api/ps` immediately before a probe and decides what to do. The
/// harvester's own view can be up to 5 s old. Any transport or parse failure
/// is treated as "not resident" → skip.
async fn ollama_probe_target(client: &reqwest::Client, port: u16, model: &str) -> ProbeTarget {
    let url = format!("http://127.0.0.1:{port}/api/ps");
    match client.get(&url).timeout(Duration::from_secs(3)).send().await {
        Ok(r) if r.status().is_success() => match r.json::<PsResponse>().await {
            Ok(ps) => probe_target(&ps, model),
            Err(_) => ProbeTarget::NotResident,
        },
        _ => ProbeTarget::NotResident,
    }
}

/// Result of the 20-token Ollama probe — expanded from bare tok/s to include
/// prefill speed, TTFT, and model load time.
#[derive(Default)]
struct OllamaProbeResult {
    tps:                Option<f32>,
    prompt_eval_tps:    Option<f32>,
    ttft_ms:            Option<f32>,
    load_duration_ms:   Option<f32>,
}

/// Fires a non-streaming 20-token generate probe and returns timing metrics
/// derived from eval_count, eval_duration, prompt_eval_count, prompt_eval_duration,
/// and load_duration returned by Ollama.
async fn probe_ollama_tps(
    client:  &reqwest::Client,
    port:    u16,
    model:   &str,
    num_ctx: u64,
    caps:    Option<&SharedCaps>,
) -> OllamaProbeResult {
    let url = format!("http://127.0.0.1:{port}/api/generate");
    let resp = match client
        .post(&url)
        .json(&probe_request_body(model, num_ctx))
        .send()
        .await
    {
        Ok(r)  => { eprintln!("[ollama] probe {} → HTTP {}", url, r.status()); r }
        Err(e) => { eprintln!("[ollama] probe {} → error: {}", url, e); return OllamaProbeResult::default(); }
    };

    if !resp.status().is_success() { return OllamaProbeResult::default(); }

    let Ok(done) = resp.json::<GenerateResponse>().await else {
        return OllamaProbeResult::default();
    };
    if let Some(c) = caps && let Ok(mut c) = c.lock() { c.observe_generate(&done); }

    OllamaProbeResult {
        tps:              done.eval_tps(),
        prompt_eval_tps:  done.prompt_eval_tps(),
        ttft_ms:          done.prompt_eval_ms(),
        load_duration_ms: done.load_ms(),
    }
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
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text)
        && let Some(n) = json["usage"]["completion_tokens"].as_u64()
            && n > 0 {
                let tps = n as f64 / elapsed;
                if tps > 0.0 { return Some(tps as f32); }
            }
    None
}

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

/// Starts the Ollama harvester.
///
/// Returns the shared metrics, the probe-in-flight flag, and the
/// [`RuntimeCaps`](crate::caps::RuntimeCaps) record this harvester fills in
/// from the responses it actually sees. Nothing reads the capability record
/// yet — the rules that gate on it arrive in step 4 and `/v1/state` in step 3 —
/// but it is populated live from here so those steps inherit real data rather
/// than a record that has to be backfilled.
pub(crate) fn start_ollama_harvester(
    apple:     Arc<Mutex<AppleSiliconMetrics>>,
    nvidia:    Arc<Mutex<NvidiaMetrics>>,
    proxy_arc: Option<Arc<ProxyState>>,
    port_rx: process_discovery::PortRx,
    port_pinned: bool,
    runtime_config_cache: crate::runtime_config::RuntimeConfigCache,
    probe_policy: ProbePolicy,
    residency: crate::residency::SharedTracker,
) -> (Arc<Mutex<OllamaMetrics>>, Arc<std::sync::atomic::AtomicBool>, SharedCaps) {
    let shared = Arc::new(Mutex::new(OllamaMetrics::default()));
    let caps: SharedCaps = Arc::new(Mutex::new(crate::caps::RuntimeCaps::default()));
    let probe_active: Arc<std::sync::atomic::AtomicBool> =
        Arc::new(std::sync::atomic::AtomicBool::new(false));

    let shared_main = Arc::clone(&shared);
    let proxy_main  = proxy_arc.clone();
    let port_rx_main = port_rx.clone();
    let probe_active_harvester = Arc::clone(&probe_active);
    let rc_cache = runtime_config_cache.clone();
    let caps_harvester = Arc::clone(&caps);
    let residency_harvester = Arc::clone(&residency);
    crate::supervisor::supervise_until("ollama-harvester", move || {
        let shared_main = shared_main.clone();
        let proxy_main = proxy_main.clone();
        let mut port_rx_main = port_rx_main.clone();
        let probe_active_harvester = probe_active_harvester.clone();
        let rc_cache = rc_cache.clone();
        let caps_main = Arc::clone(&caps_harvester);
        let residency_main = Arc::clone(&residency_harvester);
        async move {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap_or_default();

        loop {
            loop {
                if port_rx_main.borrow().is_some() { break; }
                if port_rx_main.changed().await.is_err() { return std::ops::ControlFlow::Break(()); }
            }
            let discovered_port = port_rx_main.borrow().unwrap();

            let port = {
                let check = check_ollama_api(&client, discovered_port, &caps_main).await;
                if check.is_ok() {
                    discovered_port
                } else if port_pinned {
                    eprintln!(
                        "[ollama] {} — :{discovered_port} was set explicitly, so not \
                         falling back to another port; will retry",
                        check.describe(discovered_port),
                    );
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                } else {
                    let default_port: u16 = crate::process_discovery::default_port_for("ollama").unwrap_or(11434);
                    if discovered_port == default_port {
                        eprintln!(
                            "[ollama] {} — will retry",
                            check.describe(default_port),
                        );
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        continue;
                    }
                    let fallback = check_ollama_api(&client, default_port, &caps_main).await;
                    if fallback.is_ok() {
                        eprintln!(
                            "[ollama] {}, using default :{default_port}",
                            check.describe(discovered_port),
                        );
                        default_port
                    } else {
                        eprintln!(
                            "[ollama] {}; {} — will retry",
                            check.describe(discovered_port),
                            fallback.describe(default_port),
                        );
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        continue;
                    }
                }
            };
            if let Ok(mut g) = shared_main.lock() { g.validated_port = Some(port); }
            let base = format!("http://127.0.0.1:{port}");
            eprintln!("[ollama] connected on :{port}");

            let mut interval      = tokio::time::interval(Duration::from_secs(5));
            let mut prev_expires:  Option<String>             = None;
            let mut prev_model:    Option<String>             = None;
            let mut cached_context_length:  Option<u64> = None;
            let mut cached_parameter_count: Option<u64> = None;
            let mut cached_num_layers:      Option<u64> = None;
            let mut cached_kv_heads:        Option<u64> = None;
            let mut cached_kv_head_layers:  Option<u64> = None;
            let mut cached_num_heads:       Option<u64> = None;
            let mut cached_embedding_dim:   Option<u64> = None;
            let mut last_infer_ts: Option<std::time::Instant> = None;

            loop {
                interval.tick().await;

                if port_rx_main.has_changed().unwrap_or(false) {
                    match *port_rx_main.borrow_and_update() {
                        None => {
                            eprintln!("[ollama] process gone — clearing metrics");
                            if let Ok(mut g) = shared_main.lock() { *g = OllamaMetrics::default(); }
                            break;
                        }
                        Some(new_port) if new_port != port => {
                            break;
                        }
                        _ => {}
                    }
                }

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
                    baseline_fresh_until:     prev_state.baseline_fresh_until,
                    ollama_prompt_eval_tps:   prev_state.ollama_prompt_eval_tps,
                    ollama_ttft_ms:           prev_state.ollama_ttft_ms,
                    ollama_load_duration_ms:  prev_state.ollama_load_duration_ms,
                    ollama_context_length:    prev_state.ollama_context_length,
                    ollama_parameter_count:   prev_state.ollama_parameter_count,
                    ollama_num_layers:        prev_state.ollama_num_layers,
                    ollama_kv_heads:          prev_state.ollama_kv_heads,
                    ollama_kv_head_layers:    prev_state.ollama_kv_head_layers,
                    ollama_num_heads:         prev_state.ollama_num_heads,
                    ollama_embedding_dim:     prev_state.ollama_embedding_dim,
                    ..Default::default()
                };

                let mut ps = crate::ollama_client::PsResponse::default();
                let mut ps_ok = false;
                if let Ok(resp) = client.get(format!("{base}/api/ps")).send().await
                    && let Ok(parsed) = resp.json::<crate::ollama_client::PsResponse>().await {
                        ps = parsed;
                        ps_ok = true;
                    }
                if let Ok(mut c) = caps_main.lock() { c.observe_ps(&ps); }
                let ps_models = &ps.models;

                let proxy_model_stats: std::collections::HashMap<String, (f32, u64, u64, u64, std::time::Instant)> =
                    if let Some(ref ps) = proxy_main {
                        let map = ps.per_model.lock().unwrap();
                        map.iter().map(|(k, v)| (k.clone(), (v.last_tps, v.ttft_sum_ns, v.latency_sum_ns, v.request_count, v.last_done))).collect()
                    } else {
                        std::collections::HashMap::new()
                    };

                let mut live_models: Vec<crate::ModelLiveMetrics> = Vec::new();
                let mut most_recent_done: Option<(String, std::time::Instant)> = None;

                for entry in ps_models {
                    let name = entry.name.clone().unwrap_or_default();
                    let size_gb = entry.size.map(|b| b as f32 / 1_073_741_824.0);
                    let quant = entry.details.quantization_level.clone();
                    let vram_mb = entry.size_vram.map(|b| b / (1024 * 1024));

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
                        wes: None,
                    });

                    if let Some(&(_, _, _, _, done_ts)) = proxy_model_stats.get(&name)
                        && most_recent_done.as_ref().is_none_or(|(_, t)| done_ts > *t) {
                            most_recent_done = Some((name.clone(), done_ts));
                        }
                }

                let primary_model = most_recent_done.as_ref().map(|(n, _)| n.as_str())
                    .or_else(|| ps_models.first().and_then(|m| m.name.as_deref()));
                if let Some(pm) = primary_model {
                    let pm_entry = ps.find(pm);
                    m.ollama_active_model = Some(pm.to_string());
                    m.ollama_model_size_gb = pm_entry.and_then(|e| e.size).map(|b| b as f32 / 1_073_741_824.0);
                    m.ollama_quantization = pm_entry.and_then(|e| e.details.quantization_level.clone());
                }

                let current_model = m.ollama_active_model.clone();
                if current_model != prev_model {
                    prev_model = current_model.clone();
                    if let Some(ref model_name) = current_model {
                        if let Ok(show_resp) = client.post(format!("{base}/api/show"))
                            .json(&serde_json::json!({ "name": model_name }))
                            .send().await
                            && let Ok(show_json) = show_resp.json::<serde_json::Value>().await {
                                let show: crate::ollama_client::ShowResponse =
                                    serde_json::from_value(show_json.clone()).unwrap_or_default();
                                let arch = show.model_info.architecture(show.details.family.as_deref());
                                let arch = arch.as_deref();
                                let mi = &show.model_info;
                                cached_context_length  = mi.arch_u64(arch, "context_length");
                                cached_parameter_count = mi.arch_u64(arch, "parameter_count");
                                cached_num_layers      = mi.arch_u64(arch, "block_count");
                                let kv = mi.arch_value(arch, "attention.head_count_kv");
                                cached_kv_heads = kv.and_then(crate::ollama_client::ArchValue::scalar);
                                cached_kv_head_layers = kv.and_then(|v| {
                                    v.layer_total().or_else(|| {
                                        v.scalar()
                                            .zip(cached_num_layers)
                                            .map(|(heads, layers)| heads.saturating_mul(layers))
                                    })
                                });
                                if let Some(v) = kv
                                    && let (Some(entries), Some(blocks)) = (v.layers(), cached_num_layers)
                                    && u64::from(entries) != blocks
                                {
                                    eprintln!(
                                        "[ollama] /api/show for {model_name}: head_count_kv has \
                                         {entries} entries against block_count {blocks} — not read \
                                         as a layer vector"
                                    );
                                    cached_kv_head_layers = None;
                                }
                                cached_num_heads       = mi.arch_u64(arch, "attention.head_count");
                                cached_embedding_dim   = mi.arch_u64(arch, "embedding_length");
                                if cached_num_layers.is_none() {
                                    eprintln!(
                                        "[ollama] /api/show for {model_name}: no architecture keys \
                                         under {:?} — KV-cache fields unavailable",
                                        arch.unwrap_or("<unknown>"),
                                    );
                                }

                                let cfg = crate::runtime_config::build_ollama_config(model_name, &show_json);
                                if let Ok(mut c) = rc_cache.lock() {
                                    c.insert(model_name.clone(), cfg);
                                    eprintln!("[runtime-config] ollama: cached config for {model_name}");
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
                m.ollama_kv_head_layers = cached_kv_head_layers;
                m.ollama_num_heads     = cached_num_heads;
                m.ollama_embedding_dim = cached_embedding_dim;

                let mut expires_changed = false;
                if let Some(first) = ps_models.first()
                    && let Some(exp_str) = first.expires_at.as_deref() {
                        let exp_owned = exp_str.to_string();
                        if prev_expires.as_deref() != Some(&exp_owned) {
                            last_infer_ts = Some(std::time::Instant::now());
                            expires_changed = true;
                        }
                        prev_expires = Some(exp_owned);
                    }

                m.active_models = if live_models.len() > 1 { Some(live_models) } else { None };

                let mut harvester_set_tps = false;
                if let Some(ref ps) = proxy_main {
                    let proxy_active = ps.in_flight.load(std::sync::atomic::Ordering::Relaxed) > 0;
                    let since_done   = ps.last_done_ts.lock().unwrap()
                        .is_some_and(|t| t.elapsed().as_secs() < 15);
                    m.ollama_inference_active = Some(proxy_active || since_done);
                    m.ollama_proxy_active = true;

                    if let Some((ref name, _)) = most_recent_done
                        && let Some(&(tps, _, _, _, _)) = proxy_model_stats.get(name) {
                            m.ollama_tokens_per_second = Some(tps);
                            harvester_set_tps = true;
                        }

                    let total_reqs: u64 = proxy_model_stats.values().map(|&(_, _, _, cnt, _)| cnt).sum();
                    if total_reqs > 0 {
                        let total_ttft: u64 = proxy_model_stats.values().map(|&(_, t, _, _, _)| t).sum();
                        let total_lat: u64 = proxy_model_stats.values().map(|&(_, _, l, _, _)| l).sum();
                        m.ollama_proxy_avg_ttft_ms    = Some((total_ttft as f64 / total_reqs as f64 / 1_000_000.0) as f32);
                        m.ollama_proxy_avg_latency_ms = Some((total_lat as f64 / total_reqs as f64 / 1_000_000.0) as f32);
                        m.ollama_proxy_request_count  = Some(total_reqs);
                    }

                    let loaded_names: std::collections::HashSet<String> = ps_models.iter()
                        .filter_map(|e| e.name.clone()).collect();
                    let mut map = ps.per_model.lock().unwrap();
                    map.retain(|k, _| loaded_names.contains(k));
                } else {
                    m.ollama_inference_active =
                        Some(last_infer_ts.is_some_and(|t| t.elapsed().as_secs() < 15));
                }

                let mut poll_actor = crate::residency::Actor::User;
                if let Ok(mut g) = shared_main.lock() {
                    m.last_probe_start        = g.last_probe_start;
                    m.last_probe_end          = g.last_probe_end;
                    m.baseline_fresh_until    = g.baseline_fresh_until;
                    m.ollama_prompt_eval_tps  = g.ollama_prompt_eval_tps;
                    m.ollama_ttft_ms          = g.ollama_ttft_ms;
                    m.ollama_load_duration_ms = g.ollama_load_duration_ms;
                    if !harvester_set_tps {
                        m.ollama_tokens_per_second = g.ollama_tokens_per_second;
                    }

                    let probe_active =
                        probe_active_harvester.load(std::sync::atomic::Ordering::Acquire);
                    m.probe_caused_next_reset = g.probe_caused_next_reset;
                    let last_user_request_before = m.last_user_request_ts;
                    let mut probe_caused_this_tick = false;
                    if expires_changed {
                        let result =
                            attribute_expires_change(probe_active, g.probe_caused_next_reset);
                        if result.consume_probe_flag {
                            m.probe_caused_next_reset = false;
                            probe_caused_this_tick = true;
                        }
                        if result.is_user_request {
                            m.last_user_request_ts = Some(std::time::Instant::now());
                        }
                    }
                    if probe_active || probe_caused_this_tick {
                        poll_actor = crate::residency::Actor::Probe;
                    }

                    m.fingerprint_active = g.fingerprint_active;
                    m.fingerprint_caused_next_reset = g.fingerprint_caused_next_reset;
                    let mut fingerprint_caused_this_tick = false;
                    if expires_changed && !g.fingerprint_active && g.fingerprint_caused_next_reset {
                        m.fingerprint_caused_next_reset = false;
                        fingerprint_caused_this_tick = true;
                    }
                    if g.fingerprint_active || fingerprint_caused_this_tick {
                        poll_actor = crate::residency::Actor::Fingerprint;
                        m.last_user_request_ts = last_user_request_before;
                    }

                    *g = m;
                }

                if ps_ok {
                    let poll = crate::residency::Poll::from_ps(
                        &ps,
                        crate::residency::now_ms(),
                        poll_actor,
                    );
                    if let Ok(mut tracker) = residency_main.lock() {
                        tracker.observe(&poll);
                    }
                }
            }
        }
        }
    });

    if !probe_policy.enabled {
        eprintln!("[ollama] idle probe disabled ([probe] enabled = false)");
        return (shared, probe_active, caps);
    }
    let proxy_for_probe = proxy_arc.clone();
    {
        let caps_probe = Arc::clone(&caps);
        let shared_probe = Arc::clone(&shared);
        let apple_probe  = Arc::clone(&apple);
        let nvidia_probe = Arc::clone(&nvidia);
        let probe_active_clone = Arc::clone(&probe_active);
        tokio::spawn(async move {
            let probe_client = reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .unwrap_or_default();

            tokio::time::sleep(Duration::from_secs(7)).await;

            let mut last_attempt:      Option<std::time::Instant> = None;
            let mut last_probed_model: Option<String>             = None;
            let mut interval = tokio::time::interval(PROBE_CHECK_TICK);
            loop {
                interval.tick().await;

                let Some(port) = shared_probe.lock().ok().and_then(|g| g.validated_port) else {
                    continue;
                };

                let Some(model) = shared_probe.lock().ok()
                    .and_then(|g| if g.ollama_running { g.ollama_active_model.clone() } else { None })
                else {
                    continue;
                };

                let has_baseline = shared_probe.lock().ok()
                    .map(|g| g.ollama_tokens_per_second.is_some())
                    .unwrap_or(false);
                if !probe_due(
                    has_baseline, last_probed_model.as_deref(), &model,
                    last_attempt, probe_policy.interval, std::time::Instant::now(),
                ) {
                    continue;
                }

                let gpu_util: Option<f32> = nvidia_probe.lock().ok()
                    .and_then(|g| g.nvidia_gpu_utilization_percent)
                    .or_else(|| apple_probe.lock().ok().and_then(|g| g.gpu_utilization_percent));

                if !has_baseline {
                    eprintln!(
                        "[ollama] no baseline yet — forcing initial probe despite GPU at {:.0}%",
                        gpu_util.unwrap_or(0.0),
                    );
                } else if gpu_util.is_some_and(|u| u >= GPU_LOAD_THRESHOLD_PCT) {
                    eprintln!(
                        "[ollama] probe skipped — GPU at {:.0}% (≥{:.0}%), retaining cached baseline",
                        gpu_util.unwrap_or(0.0), GPU_LOAD_THRESHOLD_PCT,
                    );
                    continue;
                }

                if let Some(ref ps) = proxy_for_probe {
                    let recent_req = ps.last_done_ts.lock().unwrap()
                        .is_some_and(|t| t.elapsed().as_secs() < 60);
                    if recent_req {
                        continue;
                    }
                }

                let num_ctx = match ollama_probe_target(&probe_client, port, &model).await {
                    ProbeTarget::Probe { num_ctx } => num_ctx,
                    ProbeTarget::NotResident => {
                        eprintln!("[ollama] probe skip — {model} no longer resident on :{port}");
                        continue;
                    }
                    ProbeTarget::ContextUnknown => {
                        eprintln!(
                            "[ollama] probe skip — {model} is loaded but /api/ps reports no \
                             context_length; probing would reset its context"
                        );
                        last_attempt      = Some(std::time::Instant::now());
                        last_probed_model = Some(model.clone());
                        continue;
                    }
                };
                last_attempt      = Some(std::time::Instant::now());
                last_probed_model = Some(model.clone());

                if let Ok(mut g) = shared_probe.lock() {
                    g.last_probe_start = Some(std::time::Instant::now());
                    g.last_probe_end   = None;
                }
                probe_active_clone.store(true, std::sync::atomic::Ordering::SeqCst);
                scopeguard::defer! {
                    probe_active_clone.store(false, std::sync::atomic::Ordering::SeqCst);
                }
                let probe_result =
                    probe_ollama_tps(&probe_client, port, &model, num_ctx, Some(&caps_probe)).await;
                if let Ok(mut g) = shared_probe.lock() {
                    if let Some(tps)  = probe_result.tps              {
                        g.ollama_tokens_per_second = Some(tps);
                        g.baseline_fresh_until = Some(
                            std::time::Instant::now() + probe_policy.interval + BASELINE_FRESH_SLACK,
                        );
                    }
                    if let Some(pe)   = probe_result.prompt_eval_tps  { g.ollama_prompt_eval_tps   = Some(pe); }
                    if let Some(tt)   = probe_result.ttft_ms          { g.ollama_ttft_ms           = Some(tt); }
                    if let Some(ld)   = probe_result.load_duration_ms { g.ollama_load_duration_ms  = Some(ld); }
                    g.last_probe_end = Some(std::time::Instant::now());
                    g.probe_caused_next_reset = true;
                }
            }
        });
    }

    (shared, probe_active, caps)
}

/// Result of a single vLLM Prometheus /metrics poll.
/// Named struct instead of positional tuple for clarity and extensibility.
#[derive(Default)]
struct VllmHarvestResult {
    running:              bool,
    model_name:           Option<String>,
    tokens_per_sec:       Option<f32>,
    cache_usage_perc:     Option<f32>,
    requests_running:     Option<u32>,
    requests_waiting:     Option<u32>,
    requests_swapped:     Option<u32>,
    ttft_sum:             Option<f64>,
    ttft_count:           Option<u64>,
    e2e_sum:              Option<f64>,
    e2e_count:            Option<u64>,
    queue_time_sum:       Option<f64>,
    queue_time_count:     Option<u64>,
    prompt_tokens_total:  Option<u64>,
    gen_tokens_total:     Option<u64>,
}

/// Fetch the `max_model_len` field from vLLM's OpenAI-compatible
/// `/v1/models` endpoint.  Returns None on network error, non-200, or
/// unexpected JSON shape.
///
/// Cached per (model_name, port) by the caller — vLLM's model catalogue
/// only changes when the engine restarts, so polling on every tick would
/// be wasteful.  Network timeout 1 second; failures degrade gracefully
/// to None and the frontend falls back to the conservative 8 192 default.
async fn fetch_vllm_max_model_len(client: &reqwest::Client, port: u16) -> Option<u64> {
    let resp = client
        .get(format!("http://127.0.0.1:{port}/v1/models"))
        .timeout(Duration::from_millis(1_000))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() { return None; }
    let body: serde_json::Value = resp.json().await.ok()?;
    body.get("data")
        .and_then(|d| d.as_array())
        .and_then(|arr| arr.first())
        .and_then(|m| m.get("max_model_len"))
        .and_then(|v| v.as_u64())
}

/// Probe vLLM once on `port`. Never panics on malformed input.
/// `client` is built once per harvester task (500 ms timeout) and reused.
async fn harvest_vllm(client: &reqwest::Client, port: u16) -> VllmHarvestResult {
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
        if line.starts_with('#') { continue; }

        let metric_name = if let Some(brace) = line.find('{') {
            &line[..brace]
        } else if let Some(space) = line.find(' ') {
            &line[..space]
        } else {
            continue;
        };

        let raw_value: Option<f64> = line.split_whitespace().last()
            .and_then(|s| s.parse().ok());
        let value_f32: Option<f32> = raw_value.map(|v| v as f32);

        if r.model_name.is_none()
            && let Some(start) = line.find("model_name=\"") {
                let rest = &line[start + 12..];
                if let Some(end) = rest.find('"') {
                    r.model_name = Some(rest[..end].to_string());
                }
            }

        let parse_u32 = |v: Option<f32>| -> Option<u32> {
            v.and_then(|v| if v >= 0.0 && v < u32::MAX as f32 { Some(v as u32) } else { None })
        };
        let parse_u64 = |v: Option<f64>| -> Option<u64> {
            v.and_then(|v| if v >= 0.0 { Some(v as u64) } else { None })
        };

        match metric_name.trim() {
            "vllm:avg_generation_throughput_toks_per_s" => {
                r.tokens_per_sec = value_f32.filter(|&v| v > 0.1);
            }
            "vllm:gpu_cache_usage_perc" | "vllm:kv_cache_usage_perc" => {
                r.cache_usage_perc = value_f32.map(|v| v * 100.0);
            }
            "vllm:num_requests_running" => {
                r.requests_running = parse_u32(value_f32);
            }
            "vllm:num_requests_waiting" => {
                r.requests_waiting = parse_u32(value_f32);
            }
            "vllm:num_requests_swapped" => {
                r.requests_swapped = parse_u32(value_f32);
            }
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
/// Also spawns a scheduled idle-probe task (see [`ProbePolicy`]) that fires `probe_vllm_tps` when the
/// scheduler is idle (`num_requests_running == 0`) and the GPU is below the
/// load threshold — the result populates `vllm_tokens_per_sec` as the IDLE-SPD
/// baseline, exactly mirroring the Ollama probe behaviour.
pub(crate) fn start_vllm_harvester(
    port_rx: process_discovery::PortRx,
    apple:       Arc<Mutex<AppleSiliconMetrics>>,
    nvidia:      Arc<Mutex<NvidiaMetrics>>,
    probe_active: Arc<std::sync::atomic::AtomicBool>,
    probe_policy: ProbePolicy,
) -> Arc<Mutex<VllmMetrics>> {
    let shared = Arc::new(Mutex::new(VllmMetrics::default()));

    let shared_main  = Arc::clone(&shared);
    let port_rx_main = port_rx.clone();
    crate::supervisor::supervise_until("vllm-harvester", move || {
        let shared_main = shared_main.clone();
        let mut port_rx_main = port_rx_main.clone();
        async move {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(500))
            .build()
            .unwrap_or_default();
        loop {
            loop {
                if port_rx_main.borrow().is_some() { break; }
                if port_rx_main.changed().await.is_err() { return std::ops::ControlFlow::Break(()); }
            }
            let port = port_rx_main.borrow().unwrap();
            eprintln!("[vllm] connected on :{port}");

            let mut interval = tokio::time::interval(Duration::from_secs(2));
            let mut cached_model_name:  Option<String> = None;
            let mut cached_max_ctx:     Option<u64>    = None;

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

                let h = harvest_vllm(&client, port).await;

                if let Some(ref name) = h.model_name
                    && cached_model_name.as_deref() != Some(name.as_str()) {
                        cached_max_ctx    = fetch_vllm_max_model_len(&client, port).await;
                        cached_model_name = Some(name.clone());
                    }

                if let Ok(mut g) = shared_main.lock() {
                    if !h.running {
                        *g = VllmMetrics::default();
                        cached_model_name = None;
                        cached_max_ctx    = None;
                    } else {
                        g.vllm_running          = true;
                        if let Some(m) = h.model_name  { g.vllm_model_name = Some(m); }
                        g.vllm_max_model_len    = cached_max_ctx;
                        if h.tokens_per_sec.is_some()  { g.vllm_tokens_per_sec = h.tokens_per_sec; }
                        g.vllm_cache_usage_perc  = h.cache_usage_perc;
                        g.vllm_requests_running  = h.requests_running;
                        g.vllm_requests_waiting  = h.requests_waiting;
                        g.vllm_requests_swapped  = h.requests_swapped;

                        if let (Some(sum), Some(count)) = (h.ttft_sum, h.ttft_count) {
                            if let (Some(ps), Some(pc)) = (g.prev_ttft_sum, g.prev_ttft_count) {
                                let dc = count.saturating_sub(pc);
                                if dc >= 1 {
                                    let ds = sum - ps;
                                    g.vllm_avg_ttft_ms = Some((ds / dc as f64 * 1000.0) as f32);
                                }
                            }
                            g.prev_ttft_sum   = Some(sum);
                            g.prev_ttft_count = Some(count);
                        }
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
                        g.vllm_prompt_tokens_total = h.prompt_tokens_total;
                        g.vllm_generation_tokens_total = h.gen_tokens_total;
                    }
                }
            }
        }
        }
    });

    if !probe_policy.enabled {
        eprintln!("[vllm] idle probe disabled ([probe] enabled = false)");
        return shared;
    }
    let shared_probe = Arc::clone(&shared);
    let probe_active_probe = Arc::clone(&probe_active);
    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_default();

        tokio::time::sleep(Duration::from_secs(7)).await;

        let mut last_attempt:      Option<std::time::Instant> = None;
        let mut last_probed_model: Option<String>             = None;
        let mut interval = tokio::time::interval(PROBE_CHECK_TICK);
        loop {
            interval.tick().await;

            let (port, model) = {
                let g = match shared_probe.lock() { Ok(g) => g, Err(_) => continue };
                if !g.vllm_running { continue; }
                if g.vllm_requests_running.is_some_and(|r| r > 0) { continue; }
                let port  = match *port_rx.borrow() { Some(p) => p, None => continue };
                let model = match g.vllm_model_name.clone() { Some(m) => m, None => continue };
                (port, model)
            };

            let vllm_has_baseline = shared_probe.lock().ok()
                .map(|g| g.vllm_tokens_per_sec.is_some())
                .unwrap_or(false);
            if !probe_due(
                vllm_has_baseline, last_probed_model.as_deref(), &model,
                last_attempt, probe_policy.interval, std::time::Instant::now(),
            ) {
                continue;
            }

            let gpu_util: Option<f32> = nvidia.lock().ok()
                .and_then(|g| g.nvidia_gpu_utilization_percent)
                .or_else(|| apple.lock().ok().and_then(|g| g.gpu_utilization_percent));
            if !vllm_has_baseline {
                eprintln!(
                    "[vllm] no baseline yet — forcing initial probe despite GPU at {:.0}%",
                    gpu_util.unwrap_or(0.0),
                );
            } else if gpu_util.is_some_and(|u| u >= GPU_LOAD_THRESHOLD_PCT) {
                eprintln!(
                    "[vllm] probe skipped — GPU at {:.0}% (≥{:.0}%), retaining cached baseline",
                    gpu_util.unwrap_or(0.0), GPU_LOAD_THRESHOLD_PCT
                );
                continue;
            }

            last_attempt      = Some(std::time::Instant::now());
            last_probed_model = Some(model.clone());
            eprintln!("[vllm] probing idle tok/s on :{port} model={model}");
            probe_active_probe.store(true, std::sync::atomic::Ordering::SeqCst);
            scopeguard::defer! {
                probe_active_probe.store(false, std::sync::atomic::Ordering::SeqCst);
            }
            if let Some(tps) = probe_vllm_tps(&client, port, &model).await {
                eprintln!("[vllm] idle probe → {tps:.1} tok/s");
                if let Ok(mut g) = shared_probe.lock() {
                    g.vllm_tokens_per_sec = Some(tps);
                    g.last_probe_end = Some(std::time::Instant::now());
                    g.baseline_fresh_until = Some(
                        std::time::Instant::now() + probe_policy.interval + BASELINE_FRESH_SLACK,
                    );
                }
            }
        }
    });

    shared
}

/// Poll llama.cpp's `/health?include_slots` endpoint.
/// Returns (running, model_name, slots_processing).
/// `client` is built once per harvester task (500 ms timeout) and reused.
async fn harvest_llamacpp(client: &reqwest::Client, port: u16) -> (bool, Option<String>, Option<u32>) {
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
        return (true, None, None);
    }

    let slots_processing = json["slots_processing"]
        .as_u64()
        .map(|v| v as u32);

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
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text)
        && let Some(n) = json["usage"]["completion_tokens"].as_u64()
            && n > 0 {
                let tps = n as f64 / elapsed;
                if tps > 0.0 { return Some(tps as f32); }
            }
    None
}

/// Spawns a 2 s polling loop that watches for llama.cpp via the discovery channel,
/// then polls the `/health?include_slots` endpoint on the discovered port.
///
/// Also spawns a scheduled idle-probe task (see [`ProbePolicy`]) that fires `probe_llamacpp_tps` when the
/// scheduler is idle (`slots_processing == 0`) and the GPU is below the
/// load threshold — the result populates `llamacpp_tokens_per_sec` as the IDLE-SPD
/// baseline, exactly mirroring the vLLM probe behaviour.
pub(crate) fn start_llamacpp_harvester(
    port_rx: process_discovery::PortRx,
    apple:   Arc<Mutex<AppleSiliconMetrics>>,
    nvidia:  Arc<Mutex<NvidiaMetrics>>,
    probe_active: Arc<std::sync::atomic::AtomicBool>,
    probe_policy: ProbePolicy,
) -> Arc<Mutex<LlamacppMetrics>> {
    let shared = Arc::new(Mutex::new(LlamacppMetrics::default()));

    let shared_main = Arc::clone(&shared);
    let port_rx_main = port_rx.clone();
    crate::supervisor::supervise_until("llamacpp-harvester", move || {
        let shared_main = shared_main.clone();
        let mut port_rx_main = port_rx_main.clone();
        async move {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(500))
            .build()
            .unwrap_or_default();
        loop {
            loop {
                if port_rx_main.borrow().is_some() { break; }
                if port_rx_main.changed().await.is_err() { return std::ops::ControlFlow::Break(()); }
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

                let (running, model, slots) = harvest_llamacpp(&client, port).await;
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
        }
    });

    if !probe_policy.enabled {
        eprintln!("[llamacpp] idle probe disabled ([probe] enabled = false)");
        return shared;
    }
    let shared_probe = Arc::clone(&shared);
    let probe_active_probe = Arc::clone(&probe_active);
    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_default();

        tokio::time::sleep(Duration::from_secs(7)).await;

        let mut last_attempt:      Option<std::time::Instant> = None;
        let mut last_probed_model: Option<String>             = None;
        let mut interval = tokio::time::interval(PROBE_CHECK_TICK);
        loop {
            interval.tick().await;

            let (port, model) = {
                let g = match shared_probe.lock() { Ok(g) => g, Err(_) => continue };
                if !g.llamacpp_running { continue; }
                if g.llamacpp_slots_processing.is_some_and(|s| s > 0) { continue; }
                let port  = match *port_rx.borrow() { Some(p) => p, None => continue };
                let model = match g.llamacpp_model_name.clone() { Some(m) => m, None => continue };
                (port, model)
            };

            let has_baseline = shared_probe.lock().ok()
                .map(|g| g.llamacpp_tokens_per_sec.is_some())
                .unwrap_or(false);
            if !probe_due(
                has_baseline, last_probed_model.as_deref(), &model,
                last_attempt, probe_policy.interval, std::time::Instant::now(),
            ) {
                continue;
            }

            let gpu_util: Option<f32> = nvidia.lock().ok()
                .and_then(|g| g.nvidia_gpu_utilization_percent)
                .or_else(|| apple.lock().ok().and_then(|g| g.gpu_utilization_percent));
            if !has_baseline {
                eprintln!(
                    "[llamacpp] no baseline yet — forcing initial probe despite GPU at {:.0}%",
                    gpu_util.unwrap_or(0.0),
                );
            } else if gpu_util.is_some_and(|u| u >= GPU_LOAD_THRESHOLD_PCT) {
                eprintln!(
                    "[llamacpp] probe skipped — GPU at {:.0}% (≥{:.0}%), retaining cached baseline",
                    gpu_util.unwrap_or(0.0), GPU_LOAD_THRESHOLD_PCT
                );
                continue;
            }

            last_attempt      = Some(std::time::Instant::now());
            last_probed_model = Some(model.clone());
            eprintln!("[llamacpp] probing idle tok/s on :{port} model={model}");
            probe_active_probe.store(true, std::sync::atomic::Ordering::SeqCst);
            scopeguard::defer! {
                probe_active_probe.store(false, std::sync::atomic::Ordering::SeqCst);
            }
            if let Some(tps) = probe_llamacpp_tps(&client, port, &model).await {
                eprintln!("[llamacpp] idle probe → {tps:.1} tok/s");
                if let Ok(mut g) = shared_probe.lock() {
                    g.llamacpp_tokens_per_sec = Some(tps);
                    g.last_probe_end = Some(std::time::Instant::now());
                    g.baseline_fresh_until = Some(
                        std::time::Instant::now() + probe_policy.interval + BASELINE_FRESH_SLACK,
                    );
                }
            }
        }
    });

    shared
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three outcomes have to stay distinguishable, because the fallback
    /// decision and the log line both read them.
    #[test]
    fn an_api_check_says_which_of_the_three_things_happened() {
        let ok: Result<(), reqwest::Error> = Ok(());
        assert_eq!(ApiCheck::of(&ok, Some(200)), ApiCheck::Ok);
        assert_eq!(ApiCheck::of(&ok, Some(204)), ApiCheck::Ok);
        assert_eq!(ApiCheck::of(&ok, Some(404)), ApiCheck::NotOllama(404));
        assert_eq!(ApiCheck::of(&ok, Some(503)), ApiCheck::NotOllama(503));
        assert_eq!(ApiCheck::of(&ok, Some(302)), ApiCheck::NotOllama(302));
        assert!(ApiCheck::Ok.is_ok());
        assert!(!ApiCheck::NotOllama(404).is_ok());
        assert!(!ApiCheck::NoAnswer { timed_out: false }.is_ok());
    }

    /// The bug this replaces: every failure printed "is a worker socket (API
    /// returned 404)", including a port with nothing on it, which sent the
    /// reader looking for a process that did not exist.
    #[test]
    fn the_log_line_does_not_claim_a_worker_socket_when_the_port_is_empty() {
        let empty = ApiCheck::NoAnswer { timed_out: false }.describe(11999);
        assert_eq!(empty, "nothing is listening on :11999");
        assert!(!empty.contains("404"), "got: {empty}");
        assert!(!empty.to_lowercase().contains("worker"), "got: {empty}");

        let worker = ApiCheck::NotOllama(404).describe(34111);
        assert!(worker.contains(":34111"), "got: {worker}");
        assert!(worker.contains("404"), "got: {worker}");
        assert!(worker.contains("not the Ollama API"), "got: {worker}");

        let hung = ApiCheck::NoAnswer { timed_out: true }.describe(11434);
        assert!(hung.contains("did not answer"), "got: {hung}");
        assert!(!hung.contains("nothing is listening"), "got: {hung}");

        for (check, port) in [
            (ApiCheck::Ok, 11434u16),
            (ApiCheck::NotOllama(404), 34111),
            (ApiCheck::NoAnswer { timed_out: false }, 11999),
            (ApiCheck::NoAnswer { timed_out: true }, 8000),
        ] {
            assert!(check.describe(port).contains(&format!(":{port}")), "{check:?}");
        }
    }

    const TEN_MIN: Duration = Duration::from_secs(600);

    #[test]
    fn probe_due_without_baseline() {
        let now = std::time::Instant::now();
        assert!(probe_due(false, Some("m"), "m", Some(now), TEN_MIN, now));
    }

    #[test]
    fn probe_not_due_while_baseline_fresh() {
        let now = std::time::Instant::now();
        let last = now - Duration::from_secs(30);
        assert!(!probe_due(true, Some("m"), "m", Some(last), TEN_MIN, now));
    }

    #[test]
    fn probe_due_once_interval_elapsed() {
        let now = std::time::Instant::now();
        let last = now - TEN_MIN;
        assert!(probe_due(true, Some("m"), "m", Some(last), TEN_MIN, now));
    }

    #[test]
    fn probe_due_on_model_change() {
        let now = std::time::Instant::now();
        let last = now - Duration::from_secs(5);
        assert!(probe_due(true, Some("old"), "new", Some(last), TEN_MIN, now));
        assert!(probe_due(true, None, "m", None, TEN_MIN, now));
    }

    fn ps_with(model: &str, context_length: Option<u64>) -> PsResponse {
        let mut entry = serde_json::json!({
            "name":      model,
            "model":     model,
            "size":      5_280_104_447u64,
            "size_vram": 5_280_104_447u64,
            "digest":    "46e0c10c039e",
            "expires_at": "2026-11-13T09:26:44.305831-05:00",
        });
        if let Some(n) = context_length {
            entry["context_length"] = serde_json::json!(n);
        }
        serde_json::from_value(serde_json::json!({ "models": [entry] })).unwrap()
    }

    fn ps_json(v: serde_json::Value) -> PsResponse {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn probe_body_always_carries_the_running_context() {
        let body = probe_request_body("llama3.1:8b", 32768);
        assert_eq!(body["options"]["num_ctx"], 32768);
        assert_eq!(body["options"]["num_predict"], 20);
        assert_eq!(body["model"], "llama3.1:8b");
        assert_eq!(body["stream"], false);
        assert!(body.get("keep_alive").is_none(), "probe must not send keep_alive");
    }

    #[test]
    fn probe_does_not_change_a_models_context() {
        for running in [4096u64, 8192, 32768, 65536, 262144] {
            let ps = ps_with("qwen3.5:4b", Some(running));
            let ProbeTarget::Probe { num_ctx } = probe_target(&ps, "qwen3.5:4b") else {
                panic!("expected Probe for a resident model with context {running}");
            };
            assert_eq!(num_ctx, running, "probe must mirror the running context");
            let body = probe_request_body("qwen3.5:4b", num_ctx);
            assert_eq!(
                body["options"]["num_ctx"].as_u64(),
                Some(running),
                "probe body must request the context the model is already running",
            );
        }
    }

    #[test]
    fn probe_skips_when_the_running_context_is_unknown() {
        let ps = ps_with("llama3.1:8b", None);
        assert_eq!(probe_target(&ps, "llama3.1:8b"), ProbeTarget::ContextUnknown);

        assert_eq!(probe_target(&ps_with("llama3.1:8b", Some(0)), "llama3.1:8b"), ProbeTarget::ContextUnknown);
        let stringy = ps_json(serde_json::json!({
            "models": [{ "name": "llama3.1:8b", "context_length": "4096" }]
        }));
        assert_eq!(probe_target(&stringy, "llama3.1:8b"), ProbeTarget::ContextUnknown);
    }

    #[test]
    fn probe_skips_a_model_that_is_not_loaded() {
        let ps = ps_with("llama3.1:8b", Some(4096));
        assert_eq!(probe_target(&ps, "qwen3.5:9b"), ProbeTarget::NotResident);
        assert_eq!(
            probe_target(&ps_json(serde_json::json!({ "models": [] })), "llama3.1:8b"),
            ProbeTarget::NotResident,
        );
        assert_eq!(
            probe_target(&ps_json(serde_json::json!({})), "llama3.1:8b"),
            ProbeTarget::NotResident,
        );
    }

    #[test]
    fn probe_target_matches_on_either_name_or_model_field() {
        let only_model = ps_json(serde_json::json!({
            "models": [{ "model": "qwen3.5:4b", "context_length": 4096 }]
        }));
        assert_eq!(
            probe_target(&only_model, "qwen3.5:4b"),
            ProbeTarget::Probe { num_ctx: 4096 },
        );
    }

    #[test]
    fn ps_lists_model_matches_loaded_only() {
        let ps = ps_json(serde_json::json!({ "models": [
            { "name": "llama3.2:3b", "model": "llama3.2:3b" }
        ]}));
        assert!(ps_lists_model(&ps, "llama3.2:3b"));
        assert!(!ps_lists_model(&ps, "qwen2.5:7b"));
        assert!(!ps_lists_model(&ps_json(serde_json::json!({ "models": [] })), "llama3.2:3b"));
        assert!(!ps_lists_model(&ps_json(serde_json::json!({})), "llama3.2:3b"));
    }

    #[test]
    fn probe_policy_default_is_enabled_ten_minutes() {
        let p = ProbePolicy::default();
        assert!(p.enabled);
        assert_eq!(p.interval, TEN_MIN);
    }

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
        let r = attribute_expires_change(true, true);
        assert!(!r.is_user_request);
        assert!(!r.consume_probe_flag);
    }
}
