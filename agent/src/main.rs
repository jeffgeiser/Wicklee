#![recursion_limit = "256"]
// Allowed crate-wide, deliberately:
//   type_complexity     — sqlx row tuples and handler signatures; a named alias
//                         per site adds indirection without meaning.
//   too_many_arguments  — three functions take 13/18/20 parameters. That is a
//                         real smell, tracked as roadmap "Code Health" item 3
//                         (params structs), not something to paper over with
//                         per-site allows. Everything else is -D warnings in CI.
#![allow(clippy::type_complexity, clippy::too_many_arguments)]

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
mod scoring;
mod supervisor;
#[cfg(not(target_env = "musl"))]
mod store;
mod inference;
mod harvester;
mod proxy;
mod cloud_push;
mod service;
mod diagnostics;
mod runtime_config;

// Modules split out of this file (previously one ~8.3k-line main.rs).
mod config;
mod pairing;
mod update;
mod hardware;
mod samplers;
mod metrics;
mod observations;
#[cfg(not(target_env = "musl"))] // catalog/fit code is DuckDB-backed; dead on musl
mod model_fit;
mod http_api;
mod mcp;
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
use config::*;
use pairing::*;
use update::*;
use hardware::*;
use samplers::*;
use metrics::*;
use observations::*;
#[cfg(not(target_env = "musl"))]
use model_fit::*;
use http_api::*;
use mcp::*;

// ── Live Activity Events ──────────────────────────────────────────────────────

/// A timestamped log entry surfaced in the dashboard Live Activity panel.
/// Written by background tasks (e.g. self-update) and drained into every
/// MetricsPayload broadcast on the next 1 s tick.
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
    // The DuckDB insert takes the store mutex, which the hourly aggregation can
    // hold for seconds — so never run it on the caller's (async) thread. Fire-
    // and-forget on the blocking pool; the synchronous path is only a fallback
    // for callers outside a tokio runtime.
    #[cfg(not(target_env = "musl"))]
    if let Some(s) = store {
        let (s, node_id) = (s.clone(), node_id.to_string());
        let write = move || s.write_event(
            event.timestamp_ms as i64,
            &node_id,
            event.level,
            event.event_type,
            &event.message,
        );
        match tokio::runtime::Handle::try_current() {
            Ok(h)  => { h.spawn_blocking(write); }
            Err(_) => write(),
        }
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

                    // Store health — surfaces the "all my routes are missing
                    // because DuckDB init failed" failure mode that would
                    // otherwise be invisible. Falls back to no-op if /api/health
                    // is unreachable (e.g. older agent without the endpoint).
                    let health_url = format!("http://127.0.0.1:{port}/api/health");
                    if let Ok(resp) = reqwest::get(&health_url).await
                        && resp.status().is_success()
                            && let Ok(v) = resp.json::<serde_json::Value>().await {
                                let healthy = v["store_healthy"].as_bool().unwrap_or(false);
                                if healthy {
                                    println!("{}", row("Store", "healthy · DuckDB ok"));
                                } else {
                                    println!("{sep}");
                                    println!("{}", row("Store", "⚠ disabled · DuckDB init failed"));
                                    println!("{}", row("",      "Check /var/log/wicklee.log"));
                                    println!("{}", row("",      "for [store] error lines."));
                                    println!("{}", row("",      "~12 /api/* routes are offline:"));
                                    println!("{}", row("",      "model-candidates, sla, profile,"));
                                    println!("{}", row("",      "history, observations, …"));
                                }
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
                let nid = {
                    let mut state = pairing_state.lock().unwrap();
                    state.cloud_session_token = Some(token.clone());
                    state.status = PairingStatus::Connected { fleet_url: fleet_url.clone() };
                    state.node_id.clone()
                };
                update_config(|cfg| {
                    cfg.node_id = nid;
                    cfg.fleet_url = Some(fleet_url);
                    cfg.session_token = Some(token);
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
                    // No total `.timeout()` — it would cap the whole response
                    // and kill long streaming generations. read_timeout resets
                    // on every chunk (generous enough for a cold model load
                    // before the first byte); CHUNK_TIMEOUT covers stalls.
                    client:           reqwest::Client::builder()
                                        .connect_timeout(Duration::from_secs(10))
                                        .read_timeout(Duration::from_secs(300))
                                        .build()
                                        .unwrap_or_default(),
                    in_flight:        std::sync::atomic::AtomicU32::new(0),
                    last_done_ts:     Mutex::new(None),
                    node_id:          config.node_id.clone(),
                    #[cfg(not(target_env = "musl"))]
                    trace_tx:         Some(trace_tx.clone()),
                    per_model:        Mutex::new(std::collections::HashMap::new()),
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
    let (_sglang_port_tx, _sglang_port_rx) = watch::channel(None::<u16>); // ready for future harvester

    // Seed channels: config overrides take precedence over process auto-detection.
    // Config overrides are used when the runtime runs as a different OS user and
    // the agent cannot read its process cmdline (cross-user /proc restriction).
    let initial = process_discovery::scan_runtimes();
    let rp = config.runtime_ports.as_ref();
    // Port resolution: TOML config → env var → auto-discovery → default
    let env_port = |var: &str| -> Option<u16> { std::env::var(var).ok().and_then(|v| v.parse().ok()) };
    let ollama_cfg   = rp.and_then(|r| r.ollama).or_else(|| env_port("WICKLEE_OLLAMA_PORT"));
    let vllm_cfg     = rp.and_then(|r| r.vllm).or_else(|| env_port("WICKLEE_VLLM_PORT"));
    let llamacpp_cfg = rp.and_then(|r| r.llamacpp).or_else(|| env_port("WICKLEE_LLAMACPP_PORT"));
    let sglang_cfg   = rp.and_then(|r| r.sglang).or_else(|| env_port("WICKLEE_SGLANG_PORT"));
    let ollama_port   = ollama_cfg.or_else(|| initial.get("ollama").copied());
    let vllm_port     = vllm_cfg.or_else(|| initial.get("vllm").copied());
    let llamacpp_port = llamacpp_cfg.or_else(|| initial.get("llamacpp").copied().or_else(|| initial.get("llama-box").copied()));
    let sglang_port   = sglang_cfg.or_else(|| initial.get("sglang").copied());
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
    if let Some(p) = sglang_port  { let _ = _sglang_port_tx.send(Some(p)); }

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
    if vllm_cfg.is_none()     { discovery_txs.insert("vllm",      vllm_port_tx);     }
    if llamacpp_cfg.is_none() { discovery_txs.insert("llamacpp",  llamacpp_disc_tx);  }
    if llamacpp_cfg.is_none() { discovery_txs.insert("llama-box", llamabox_disc_tx);  }
    if sglang_cfg.is_none()   { discovery_txs.insert("sglang",   _sglang_port_tx);   }
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
    // v0.9.0: shared runtime-config cache populated by Ollama harvester (on
    // model change) and by dedicated vLLM / llama.cpp pollers below. Read by
    // GET /api/runtime-config and used to set the MetricsPayload availability
    // flag.
    let runtime_config_cache = runtime_config::new_cache();
    // Keep a receiver for /api/tags before the harvester takes ownership.
    let tags_port_rx = ollama_port_rx.clone();
    let probe_policy = ProbeConfig::policy(config.probe.as_ref());
    if probe_policy.enabled {
        eprintln!("[probe] idle probes every {} min (loaded models only)", probe_policy.interval.as_secs() / 60);
    }
    let (ollama_metrics, probe_active) = harvester::start_ollama_harvester(
        Arc::clone(&apple_metrics),
        Arc::clone(&nvidia_metrics),
        proxy_arc,
        ollama_port_rx,
        Arc::clone(&runtime_config_cache),
        probe_policy,
    );
    let rapl_metrics          = start_rapl_harvester();
    let linux_thermal_metrics = start_linux_thermal_harvester();
    // Runtime-config pollers below read the same discovery channels (which
    // honour `[runtime_ports]` overrides) rather than rescanning processes.
    let vllm_cfg_port_rx     = vllm_port_rx.clone();
    let llamacpp_cfg_port_rx = llamacpp_port_rx.clone();
    let vllm_metrics          = harvester::start_vllm_harvester(vllm_port_rx, Arc::clone(&apple_metrics), Arc::clone(&nvidia_metrics), Arc::clone(&probe_active), probe_policy);
    let llamacpp_metrics      = harvester::start_llamacpp_harvester(llamacpp_port_rx, Arc::clone(&apple_metrics), Arc::clone(&nvidia_metrics), Arc::clone(&probe_active), probe_policy);

    // v0.9.0: Runtime Config Surface — dedicated 5-min pollers for vLLM and
    // llama.cpp. Both run alongside the existing metrics harvesters and write
    // into the shared runtime_config_cache. First poll is delayed 30 s so we
    // don't slow first-paint.
    {
        let cache = Arc::clone(&runtime_config_cache);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap_or_default();
            let mut interval = tokio::time::interval(Duration::from_secs(300));
            loop {
                interval.tick().await;
                let Some(port) = *vllm_cfg_port_rx.borrow() else { continue; };
                let base = format!("http://127.0.0.1:{port}");
                match runtime_config::fetch_vllm_config(&client, &base).await {
                    Ok(config) => {
                        let model = config.model.clone();
                        if let Ok(mut c) = cache.lock() {
                            c.insert(model.clone(), config);
                        }
                        eprintln!("[runtime-config] vllm: cached config for {model}");
                    }
                    Err(reason) => {
                        eprintln!("[runtime-config] vllm: probe failed: {reason}");
                    }
                }
            }
        });
    }
    {
        let cache = Arc::clone(&runtime_config_cache);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap_or_default();
            let mut interval = tokio::time::interval(Duration::from_secs(300));
            loop {
                interval.tick().await;
                let Some(port) = *llamacpp_cfg_port_rx.borrow() else { continue; };
                let base = format!("http://127.0.0.1:{port}");
                match runtime_config::fetch_llamacpp_config(&client, &base).await {
                    Ok(config) => {
                        let model = config.model.clone();
                        if let Ok(mut c) = cache.lock() {
                            c.insert(model.clone(), config);
                        }
                        eprintln!("[runtime-config] llamacpp: cached config for {model}");
                    }
                    Err(reason) => {
                        eprintln!("[runtime-config] llamacpp: probe failed: {reason}");
                    }
                }
            }
        });
    }

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
        runtime_overrides,
        config.node_id.clone(),
        Arc::clone(&model_baseline_cache),
        Arc::clone(&cpu_usage_atomic),
        Arc::clone(&runtime_config_cache),
    );

    // Shared observation cache — written by the 10 s evaluator task, read by
    // cloud_push (embed in telemetry JSON) and handle_observations (GET /api/observations).
    #[cfg(not(target_env = "musl"))]
    let observation_cache: ObservationCache = Arc::new(Mutex::new(Vec::new()));
    #[cfg(target_env = "musl")]
    let observation_cache: Arc<Mutex<Vec<()>>> = Arc::new(Mutex::new(Vec::new()));

    // Deployment profile — governs observation sensitivity. Loaded from config,
    // switchable at runtime via PUT /api/deployment-profile; the 10 s evaluator
    // reads it each tick so a change takes effect within one cycle.
    let deployment_profile: Arc<Mutex<DeploymentProfile>> =
        Arc::new(Mutex::new(DeploymentProfile::from_config(config.deployment_profile.as_deref())));

    // Start cloud telemetry push loop (2 s cadence, gated on session_token).
    #[cfg(not(target_env = "musl"))]
    cloud_push::start_cloud_push(
        Arc::clone(&pairing_state),
        broadcast_tx.clone(),
        Arc::clone(&observation_cache),
        Arc::clone(&deployment_profile),
    );
    #[cfg(target_env = "musl")]
    cloud_push::start_cloud_push(Arc::clone(&pairing_state), broadcast_tx.clone(), Arc::clone(&deployment_profile));

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
                // The insert runs on the blocking pool: it's normally < 1 ms, but
                // the store mutex is also held by the hourly aggregation and by
                // heavy read queries, and waiting on it must not park a tokio
                // worker. Awaiting each write keeps inserts ordered and bounded
                // (a backlog shows up as broadcast lag → skipped frames).
                {
                    let s2  = s.clone();
                    let mut rx = broadcast_tx.subscribe();
                    tokio::spawn(async move {
                        loop {
                            match rx.recv().await {
                                Ok(json) => {
                                    match store::Sample::from_broadcast_json(&json) {
                                        Ok(sample) => {
                                            let st = s2.clone();
                                            match tokio::task::spawn_blocking(move || st.write_sample(sample)).await {
                                                Ok(Err(e)) => eprintln!("[store] write error: {e}"),
                                                Err(e)     => eprintln!("[store] write task failed: {e}"),
                                                Ok(Ok(())) => {}
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
                            if let Err(e) = sc.prune_expired_dismissals(now_ms() as i64) {
                                eprintln!("[store] dismissal prune error: {e}");
                            }
                            if let Err(e) = sc.run_aggregation(now_ms() as i64) {
                                eprintln!("[store] initial aggregation error: {e}");
                            }
                        }).await;

                        // interval_at: a plain interval() fires its first tick
                        // immediately, which re-ran the full aggregation (and
                        // prune + checkpoint) right after the initial run above.
                        let hour = Duration::from_secs(3_600);
                        let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + hour, hour);
                        loop {
                            tick.tick().await;
                            let sc = s2.clone();
                            let _ = tokio::task::spawn_blocking(move || {
                                // Housekeeping documented on the function itself:
                                // expired dismissal rows otherwise accumulate forever.
                                if let Err(e) = sc.prune_expired_dismissals(now_ms() as i64) {
                                    eprintln!("[store] dismissal prune error: {e}");
                                }
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
                            if changed
                                && let Some(ref model_name) = current {
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
                    let profile_for_obs = Arc::clone(&deployment_profile);
                    // Cache the Linux CPU model once — never changes at runtime.
                    // Used by `bandwidth_ceiling_reached` to look up memory bandwidth.
                    let linux_chip_name_obs = read_linux_chip_name();
                    tokio::spawn(async move {
                        // Wait for DuckDB to accumulate a few samples before first eval.
                        tokio::time::sleep(Duration::from_secs(15)).await;
                        let mut interval = tokio::time::interval(Duration::from_secs(10));
                        loop {
                            interval.tick().await;
                            let st  = store_clone.clone();
                            let nid = node_id_clone.clone();
                            // Re-read each tick so a runtime profile change takes
                            // effect within one 10 s cycle.
                            let tuning = profile_for_obs.lock()
                                .map(|p| p.tuning())
                                .unwrap_or_else(|_| DeploymentProfile::DedicatedServer.tuning());
                            let nv  = nvidia_clone.lock().map(|g| g.clone()).unwrap_or_default();
                            let ol  = ollama_clone.lock().map(|g| g.clone()).unwrap_or_default();
                            let ap  = apple_clone.lock().map(|g| g.clone()).unwrap_or_default();
                            let pcie = PcieSnapshot {
                                link_width:     nv.pcie_link_width,
                                link_max_width: nv.pcie_link_max_width,
                            };
                            let hostname = System::host_name().unwrap_or_else(|| nid.clone());
                            let chip_name_for_obs = linux_chip_name_obs.clone();
                            let result = tokio::task::spawn_blocking(move || {
                                match st.query_observation_window(&nid, 600_000) {
                                    Ok(samples) => {
                                        let mut obs = evaluate_local_observations(&samples, &pcie, &nid, &hostname, tuning);
                                        // Pattern O — VRAM Overcommit (point-in-time, no history needed)
                                        if let Some(o) = evaluate_vram_overcommit(&ol, &nv, &ap, &nid, &hostname) {
                                            obs.push(o);
                                        }
                                        // Pattern: Bandwidth Ceiling Reached — physics-explanation
                                        // pattern that suppresses the false-positive "Low efficiency"
                                        // narrative when a node is at its memory-bandwidth ceiling.
                                        if let Some(o) = evaluate_bandwidth_ceiling(
                                            &samples, &ol, &nv, &ap,
                                            chip_name_for_obs.as_deref(),
                                            &nid, &hostname,
                                        ) {
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
                            if let Ok(Some(observations)) = result
                                && let Ok(mut cache) = obs_cache.lock() {
                                    *cache = observations;
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

    // Store health flag — true when DuckDB opened cleanly. Surfaced via
    // /api/health so operators can diagnose "why are my routes missing"
    // with one curl. False = the entire store-gated block silently
    // dropped from the router.
    #[cfg(not(target_env = "musl"))]
    let store_healthy = StoreHealth(metrics_store.is_some());
    #[cfg(target_env = "musl")]
    let store_healthy = StoreHealth(false);

    // Build the router.  The /api/history route and its Extension are only
    // compiled in on non-musl targets where DuckDB is available.
    let app = {
        let r = Router::new()
            .route("/api/health",         get(handle_health))         // diagnostic — always live
            .route("/api/tags",           get(move || handle_tags(tags_port_rx.clone())))
            .route("/api/events/recent",  get(handle_events_recent))
            .route("/api/metrics",        get(handle_metrics))       // SSE fallback (1 Hz)
            .route("/api/metrics/snapshot", get(handle_metrics_snapshot)) // one-shot JSON of latest frame
            .route("/ws",                 get(handle_ws))             // WebSocket primary (1 Hz)
            .route("/api/pair/status",    get(handle_pair_status))
            .route("/api/pair/generate",  post(handle_pair_generate))
            .route("/api/pair/claim",     post(handle_pair_claim))
            .route("/api/pair/disconnect",post(handle_pair_disconnect))
            // MCP (Model Context Protocol) — JSON-RPC 2.0 for AI agents
            .route("/mcp",                      post(handle_mcp))
            .route("/.well-known/mcp.json",     get(handle_mcp_manifest))
            // v0.9.0: Runtime Config Surface — backed by in-memory cache,
            // available regardless of store health.
            .route("/api/runtime-config",       get(handle_runtime_config))
            .route("/api/deployment-profile",   get(handle_get_deployment_profile).put(handle_put_deployment_profile));

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
             .route("/api/profile",             get(handle_profile))
             .route("/api/sla",                 get(handle_sla))
             .route("/api/cost-by-model",       get(handle_cost_by_model))
             .route("/api/explain-slowdown",    get(handle_explain_slowdown))
             .route("/api/model-comparison",    get(handle_model_comparison))
             .route("/api/model-switches",     get(handle_model_switches))
             .route("/api/model-candidates",   get(handle_model_candidates))
             .layer(axum::extract::Extension(st.clone()))
             .layer(axum::extract::Extension(Arc::clone(&observation_cache)))
        } else {
            r
        };

        r.fallback(static_handler)
         .layer(axum::extract::Extension(store_healthy))
         .layer(axum::extract::Extension(Arc::clone(&pairing_state)))
         .layer(axum::extract::Extension(Arc::clone(&deployment_profile)))
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
         .layer(axum::extract::Extension(track_latest_frame(&broadcast_tx)))
         .layer(axum::extract::Extension(broadcast_tx))
         .layer(axum::extract::Extension(probe_active))
         .layer(axum::extract::Extension(NodeId(Arc::new(config.node_id.clone()))))
         .layer(axum::extract::Extension(ProxyPorts { listen: proxy_listen, target: proxy_target }))
         .layer(axum::extract::Extension(Arc::clone(&runtime_config_cache)))
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
