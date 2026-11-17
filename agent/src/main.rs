#![recursion_limit = "256"]
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

mod config;
mod pairing;
mod update;
mod hardware;
mod samplers;
mod metrics;
mod observations;
#[cfg(not(target_env = "musl"))]
mod model_fit;
mod http_api;
mod mcp;
mod auth;
mod ollama_client;
mod caps;
mod residency;
mod findings;
mod receipts;
mod fingerprint;
mod readiness;
mod cli;
#[cfg(any(all(target_os = "linux", not(target_env = "musl")), target_os = "windows"))]
use nvml_wrapper::{bitmasks::device::ThrottleReasons, enum_wrappers::device::{Clock, TemperatureSensor}, Nvml};
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
#[allow(unused_variables)]
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

/// Whether the version line is the command's *output* rather than a log line.
///
/// It is output only for `--version` / `-V`, where the version is the whole
/// point of the invocation. Everywhere else — daemon startup, `--status`,
/// `--install-service`, and the `inspect` / `ready` / `findings` subcommands
/// Phase 1 adds — it is a "which build is this?" log line and belongs on
/// stderr, because stdout is reserved for machine-readable output.
fn version_is_command_output<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().any(|a| {
        let a = a.as_ref();
        a == "--version" || a == "-V"
    })
}

/// Whether `--no-cloud` was passed: run the agent with every outbound fleet
/// request suppressed for the life of the process.
///
/// This exists so a second agent can be started on a paired host — to exercise
/// a route, reproduce a bug, check a build — without that agent pushing
/// telemetry under the installed node's id, downloading and installing an
/// update over it, or writing pairing fields into the config file the
/// installed service reads. None of those are prevented by moving ports:
/// `PORT` isolates the listener, not the identity.
fn cloud_is_disabled<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().any(|a| a.as_ref() == "--no-cloud")
}

/// A flag `--no-cloud` cannot be combined with, and the reason.
///
/// `--no-cloud` governs *this* process. Combined with a flag that acts on the
/// installed service, or that is itself a request to the fleet, it would be
/// silently ignored — and a flag that appears to have been accepted while
/// doing nothing is worse than no flag, because the whole point of this one is
/// to be able to trust that nothing left the machine.
fn no_cloud_conflict<I, S>(args: I) -> Option<(&'static str, &'static str)>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    const CONFLICTS: &[(&str, &str)] = &[
        ("--pair", "pairing is itself a request to the fleet"),
        ("--install-service", "the installed service does not inherit it"),
        ("--uninstall-service", "the installed service does not inherit it"),
    ];
    let given: Vec<String> = args.into_iter().map(|a| a.as_ref().to_string()).collect();
    if !cloud_is_disabled(&given) {
        return None;
    }
    CONFLICTS
        .iter()
        .find(|(flag, _)| given.iter().any(|a| a == flag))
        .copied()
}

#[tokio::main]
async fn main() {
    let version_line = format!("wicklee-agent v{}", env!("CARGO_PKG_VERSION"));
    let version_flag = version_is_command_output(std::env::args());
    if version_flag {
        println!("{version_line}");
    } else {
        eprintln!("{version_line}");
    }

    match cli::parse(&std::env::args().skip(1).collect::<Vec<_>>()) {
        cli::Invocation::Agent => {}
        cli::Invocation::Run(cmd) => {
            let port: u16 =
                std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(7700);
            std::process::exit(cli::run(cmd, port).await);
        }
        cli::Invocation::Unknown(msg) => {
            eprintln!("{msg}");
            std::process::exit(2);
        }
    }

    if let Some((flag, why)) = no_cloud_conflict(std::env::args()) {
        eprintln!("[fatal] --no-cloud cannot be combined with {flag}: {why}.");
        std::process::exit(2);
    }
    let no_cloud = cloud_is_disabled(std::env::args());
    let pair_on_start = std::env::args().any(|a| a == "--pair");
    if no_cloud {
        eprintln!(
            "[no-cloud] fleet disabled for this process: no telemetry push, no \
             self-update, pairing routes refuse. Local routes are unaffected."
        );
    }

    let config = load_or_create_config();
    let initial_status = if config.fleet_url.is_some() { "connected" } else { "unpaired" };
    let pairing_state = Arc::new(Mutex::new(PairingState {
        node_id:             config.node_id.clone(),
        cloud_session_token: config.session_token.clone(),
        status: match config.fleet_url.clone() {
            Some(url) => PairingStatus::Connected { fleet_url: url },
            None      => PairingStatus::Unpaired,
        },
    }));

    if version_flag {
        return;
    }

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
                    let cfg_ref = &config;
                    let discovered = process_discovery::scan_runtimes();
                    let rp = cfg_ref.runtime_ports.as_ref();
                    let ollama_cfg = rp.and_then(|r| r.ollama);
                    let ollama_port = ollama_cfg.or_else(|| discovered.get("ollama").copied());
                    if let Some(p) = ollama_port {
                        let tag = if ollama_cfg.is_some() { " (config)" } else { "" };
                        println!("{}", row("Ollama", &format!(":{p}{tag} · detected")));
                    } else {
                        println!("{}", row("Ollama", "not running"));
                    }
                    let vllm_cfg = rp.and_then(|r| r.vllm);
                    let vllm_port = vllm_cfg.or_else(|| discovered.get("vllm").copied());
                    if let Some(p) = vllm_port {
                        let tag = if vllm_cfg.is_some() { " (config)" } else { "" };
                        println!("{}", row("vLLM", &format!(":{p}{tag} · detected")));
                    } else {
                        println!("{}", row("vLLM", "not running"));
                    }

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

    let bind_addr_cfg = config.bind_address.clone().unwrap_or_else(|| "127.0.0.1".to_string());
    let auth_policy = match auth::evaluate_startup(
        &bind_addr_cfg,
        config.auth_token.as_deref(),
        config.allow_unauthenticated.unwrap_or(false),
    ) {
        auth::StartupDecision::Proceed(p) => p,
        auth::StartupDecision::ProceedWithWarning(p, warning) => {
            eprintln!("[warn] ╔══════════════════════════════════════════════════════════════╗");
            eprintln!("[warn] ║  UNAUTHENTICATED REMOTE ACCESS                               ║");
            eprintln!("[warn] ╚══════════════════════════════════════════════════════════════╝");
            for line in warning.split('\n') {
                eprintln!("[warn] {line}");
            }
            p
        }
        auth::StartupDecision::Refuse(reason) => {
            eprintln!("[fatal] {reason}");
            std::process::exit(1);
        }
    };
    if auth_policy.non_loopback_bind && auth_policy.token.is_some() {
        eprintln!(
            "[auth] bound to {bind_addr_cfg} — requests from other machines must present \
             the configured {} as a bearer token",
            auth::TOKEN_KEY,
        );
    }
    let auth_policy = Arc::new(auth_policy);

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

        println!("\n  ✓ Pairing complete. The background service will connect to the fleet automatically.");
        println!("  Run `wicklee --status` to verify.\n");
        return;
    }

    let diag_status = match (pair_on_start, no_cloud) {
        (true, _) => "pending".to_string(),
        (false, true) => format!("{initial_status} · no-cloud"),
        (false, false) => initial_status.to_string(),
    };
    diagnostics::run_startup_diagnostics(&config.node_id, &diag_status, port, &config).await;

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

    let proxy_cfg = config.ollama_proxy.clone().unwrap_or_default();

    #[cfg(not(target_env = "musl"))]
    let (trace_tx, trace_rx) = tokio::sync::mpsc::unbounded_channel::<store::TraceRow>();

    let proxy_arc: Option<Arc<ProxyState>> = if proxy_cfg.enabled {
        match tokio::net::TcpListener::bind("127.0.0.1:11434").await {
            Ok(proxy_listener) => {
                let ps = Arc::new(ProxyState {
                    ollama_port:      proxy_cfg.ollama_port,
                    bypass_if_down:   proxy_cfg.bypass_if_proxy_down,
                    client:           reqwest::Client::builder()
                                        .connect_timeout(Duration::from_secs(10))
                                        .read_timeout(Duration::from_secs(300))
                                        .build()
                                        .unwrap_or_default(),
                    in_flight:        std::sync::atomic::AtomicU32::new(0),
                    last_done_ts:     Mutex::new(None),
                    #[cfg(not(target_env = "musl"))]
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

    let (ollama_port_tx,   ollama_port_rx)   = watch::channel(None::<u16>);
    let (vllm_port_tx,     vllm_port_rx)     = watch::channel(None::<u16>);
    let (llamacpp_port_tx, llamacpp_port_rx) = watch::channel(None::<u16>);
    let (llamacpp_disc_tx, llamacpp_disc_rx) = watch::channel(None::<u16>);
    let (llamabox_disc_tx, llamabox_disc_rx) = watch::channel(None::<u16>);
    let (_sglang_port_tx, _sglang_port_rx) = watch::channel(None::<u16>);

    let initial = process_discovery::scan_runtimes();
    let rp = config.runtime_ports.as_ref();
    let resolve = |runtime: &str, configured: Option<u16>, discovered: Option<u16>| {
        process_discovery::resolve_port(
            configured,
            process_discovery::env_port(runtime),
            discovered,
        )
    };
    let ollama_res = resolve("ollama", rp.and_then(|r| r.ollama), initial.get("ollama").copied());
    let vllm_res   = resolve("vllm",   rp.and_then(|r| r.vllm),   initial.get("vllm").copied());
    let llamacpp_res = resolve(
        "llamacpp",
        rp.and_then(|r| r.llamacpp),
        initial.get("llamacpp").copied().or_else(|| initial.get("llama-box").copied()),
    );
    let sglang_res = resolve("sglang", rp.and_then(|r| r.sglang), initial.get("sglang").copied());
    let pinned = |res: Option<(u16, process_discovery::PortSource)>| {
        res.is_some_and(|(_, src)| src.is_pinned())
    };
    let ollama_port   = ollama_res.map(|(p, _)| p);
    let vllm_port     = vllm_res.map(|(p, _)| p);
    let llamacpp_port = llamacpp_res.map(|(p, _)| p);
    let sglang_port   = sglang_res.map(|(p, _)| p);
    let effective_ollama_port = if proxy_arc.is_some() {
        Some(proxy_cfg.ollama_port)
    } else {
        ollama_port
    };
    if let Some(p) = effective_ollama_port { let _ = ollama_port_tx.send(Some(p)); }
    if let Some(p) = vllm_port     { let _ = vllm_port_tx.send(Some(p)); }
    if let Some(p) = llamacpp_port { let _ = llamacpp_port_tx.send(Some(p)); }
    if let Some(p) = sglang_port  { let _ = _sglang_port_tx.send(Some(p)); }

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

    let ollama_port_pinned = pinned(ollama_res) || proxy_arc.is_some();
    let mut discovery_txs: std::collections::HashMap<&str, _> = Default::default();
    if !ollama_port_pinned { discovery_txs.insert("ollama", ollama_port_tx); }
    if !pinned(vllm_res)     { discovery_txs.insert("vllm",      vllm_port_tx);     }
    if !pinned(llamacpp_res) { discovery_txs.insert("llamacpp",  llamacpp_disc_tx);  }
    if !pinned(llamacpp_res) { discovery_txs.insert("llama-box", llamabox_disc_tx);  }
    if !pinned(sglang_res)   { discovery_txs.insert("sglang",   _sglang_port_tx);   }
    process_discovery::start_discovery_loop(discovery_txs, 30);

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
    let runtime_config_cache = runtime_config::new_cache();
    let tags_port_rx = ollama_port_rx.clone();
    let v1_port_rx = OllamaPortRx(ollama_port_rx.clone());
    let probe_policy = ProbeConfig::policy(config.probe.as_ref());
    if probe_policy.enabled {
        eprintln!("[probe] idle probes every {} min (loaded models only)", probe_policy.interval.as_secs() / 60);
    }
    let residency_tracker: residency::SharedTracker =
        Arc::new(Mutex::new(residency::Tracker::new()));
    let (ollama_metrics, probe_active, ollama_caps) = harvester::start_ollama_harvester(
        Arc::clone(&apple_metrics),
        Arc::clone(&nvidia_metrics),
        proxy_arc,
        ollama_port_rx,
        ollama_port_pinned,
        Arc::clone(&runtime_config_cache),
        probe_policy,
        Arc::clone(&residency_tracker),
    );
    let rapl_metrics          = start_rapl_harvester();
    let linux_thermal_metrics = start_linux_thermal_harvester();
    let vllm_cfg_port_rx     = vllm_port_rx.clone();
    let llamacpp_cfg_port_rx = llamacpp_port_rx.clone();
    let vllm_metrics          = harvester::start_vllm_harvester(vllm_port_rx, Arc::clone(&apple_metrics), Arc::clone(&nvidia_metrics), Arc::clone(&probe_active), probe_policy);
    let llamacpp_metrics      = harvester::start_llamacpp_harvester(llamacpp_port_rx, Arc::clone(&apple_metrics), Arc::clone(&nvidia_metrics), Arc::clone(&probe_active), probe_policy);

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

    let cpu_usage_atomic = Arc::new(std::sync::atomic::AtomicU32::new(0_f32.to_bits()));

    let wes_metrics = start_wes_sampler(
        Arc::clone(&apple_metrics),
        Arc::clone(&nvidia_metrics),
        Arc::clone(&linux_thermal_metrics),
        Arc::clone(&cpu_usage_atomic),
    );

    let swap_metrics = start_swap_harvester();

    let live_events: Arc<Mutex<Vec<LiveActivityEvent>>> = Arc::new(Mutex::new(Vec::new()));

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

    #[cfg(not(target_env = "musl"))]
    let observation_cache: ObservationCache = Arc::new(Mutex::new(Vec::new()));

    let deployment_profile: Arc<Mutex<DeploymentProfile>> =
        Arc::new(Mutex::new(DeploymentProfile::from_config(config.deployment_profile.as_deref())));

    if no_cloud {
        eprintln!("[no-cloud] telemetry push not started");
    } else {
        #[cfg(not(target_env = "musl"))]
        cloud_push::start_cloud_push(
            Arc::clone(&pairing_state),
            broadcast_tx.clone(),
            Arc::clone(&observation_cache),
            Arc::clone(&deployment_profile),
        );
        #[cfg(target_env = "musl")]
        cloud_push::start_cloud_push(Arc::clone(&pairing_state), broadcast_tx.clone(), Arc::clone(&deployment_profile));
    }

    let latest_frame = metrics::track_latest_frame(&broadcast_tx);

    #[cfg(not(target_env = "musl"))]
    let metrics_store: Option<store::Store> = {
        let db_path = wicklee_dir().join("metrics.db");
        if let Some(dir) = db_path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        match store::Store::open(&db_path) {
            Ok(s) => {
                println!("[store] metrics db: {}", db_path.display());

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

                        let hour = Duration::from_secs(3_600);
                        let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + hour, hour);
                        loop {
                            tick.tick().await;
                            let sc = s2.clone();
                            let _ = tokio::task::spawn_blocking(move || {
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

                {
                    let store_clone = s.clone();
                    let tracker = Arc::clone(&residency_tracker);
                    let node_id_clone = config.node_id.clone();
                    let frame = latest_frame.clone();
                    let mut rx = trace_rx;
                    tokio::spawn(async move {
                        while let Some(trace) = rx.recv().await {
                            let states = match tracker.lock() {
                                Ok(t) => t.states().cloned().collect::<Vec<_>>(),
                                Err(_) => Vec::new(),
                            };
                            let refs: Vec<&residency::ModelState> = states.iter().collect();
                            let mut ambient = receipts::ambient_from_states(
                                &trace.model,
                                &refs,
                                trace.ts_ms,
                            );
                            ambient.thermal_state = frame
                                .0
                                .read()
                                .ok()
                                .and_then(|f| f.clone())
                                .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
                                .and_then(|v| {
                                    v.get("thermal_state")
                                        .and_then(|t| t.as_str())
                                        .map(str::to_string)
                                });
                            let receipt = receipts::from_proxy_trace(&trace, &ambient);
                            let (activity_model, activity_ts) =
                                (receipt.model.clone(), receipt.ts_ms);
                            let st = store_clone.clone();
                            let node_id = node_id_clone.clone();
                            let _ = tokio::task::spawn_blocking(move || {
                                st.write_trace(&trace);
                                if let Err(e) = st.write_receipt(&node_id, &receipt) {
                                    eprintln!("[receipts] proxy receipt not stored: {e}");
                                }
                            }).await;
                            if let Ok(mut t) = tracker.lock() {
                                t.note_activity(&activity_model, activity_ts);
                            }
                        }
                    });
                }

                {
                    let store_clone = s.clone();
                    let tracker = Arc::clone(&residency_tracker);
                    let node_id_clone = config.node_id.clone();
                    if let Ok(mut t) = tracker.lock() {
                        t.enable_persistence();
                    }
                    tokio::spawn(async move {
                        let mut interval = tokio::time::interval(Duration::from_secs(2));
                        loop {
                            interval.tick().await;
                            let batch = match tracker.lock() {
                                Ok(mut t) => t.take_pending(),
                                Err(_) => continue,
                            };
                            if batch.is_empty() {
                                continue;
                            }
                            let st = store_clone.clone();
                            let nid = node_id_clone.clone();
                            let _ = tokio::task::spawn_blocking(move || {
                                if let Err(e) = st.write_transitions(&nid, &batch) {
                                    eprintln!("[residency] transition write failed: {e}");
                                }
                            })
                            .await;
                        }
                    });
                }

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

                {
                    let store_clone = s.clone();
                    let nvidia_clone = Arc::clone(&nvidia_metrics);
                    let ollama_clone = Arc::clone(&ollama_metrics);
                    let apple_clone  = Arc::clone(&apple_metrics);
                    let node_id_clone = config.node_id.clone();
                    let obs_cache = Arc::clone(&observation_cache);
                    let profile_for_obs = Arc::clone(&deployment_profile);
                    let linux_chip_name_obs = read_linux_chip_name();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(15)).await;
                        let mut interval = tokio::time::interval(Duration::from_secs(10));
                        loop {
                            interval.tick().await;
                            let st  = store_clone.clone();
                            let nid = node_id_clone.clone();
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
                                        if let Some(o) = evaluate_vram_overcommit(&ol, &nv, &ap, &nid, &hostname) {
                                            obs.push(o);
                                        }
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
    #[cfg(target_env = "musl")]
    let metrics_store: Option<()> = None;

    #[cfg(target_env = "musl")]
    let receipt_memory: receipts::SharedMemoryReceipts = Default::default();
    #[cfg(not(target_env = "musl"))]
    let receipt_memory: () = ();

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

    let cors = CorsLayer::new()
        .allow_origin([
            "http://localhost:7700".parse::<axum::http::HeaderValue>().unwrap(),
            "http://127.0.0.1:7700".parse::<axum::http::HeaderValue>().unwrap(),
            "http://localhost:3000".parse::<axum::http::HeaderValue>().unwrap(),
        ])
        .allow_methods(Any)
        .allow_headers(Any);

    #[cfg(not(target_env = "musl"))]
    let store_healthy = StoreHealth(metrics_store.is_some());
    #[cfg(target_env = "musl")]
    let store_healthy = StoreHealth(false);

    let app = {
        let r = Router::new()
            .route("/api/health",         get(handle_health))
            .route("/api/tags",           get(move |caps, residency| handle_tags(tags_port_rx.clone(), caps, residency)))
            .route("/api/model-switches", get(handle_model_switches))
            .route("/v1/state", get(handle_v1_state))
            .route("/v1/readiness", get(handle_v1_readiness))
            .route("/v1/inspect",   get(handle_v1_inspect))
            .route("/v1/findings",  get(handle_v1_findings))
            .route(
                "/v1/receipts",
                get(handle_v1_receipts_get).post(handle_v1_receipts_post),
            )
            .route("/v1/fingerprint", post(handle_v1_fingerprint))
            .route("/v1/verify", post(handle_v1_verify))
            .route("/api/events/recent",  get(handle_events_recent))
            .route("/api/metrics",        get(handle_metrics))
            .route("/api/metrics/snapshot", get(handle_metrics_snapshot))
            .route("/ws",                 get(handle_ws))
            .route("/api/pair/status",    get(handle_pair_status))
            .route("/mcp",                      post(handle_mcp))
            .route("/.well-known/mcp.json",     get(handle_mcp_manifest))
            .route("/api/runtime-config",       get(handle_runtime_config))
            .route("/api/deployment-profile",   get(handle_get_deployment_profile).put(handle_put_deployment_profile));

        let r = if no_cloud {
            r.route("/api/pair/generate",   post(handle_pair_disabled))
             .route("/api/pair/claim",      post(handle_pair_disabled))
             .route("/api/pair/disconnect", post(handle_pair_disabled))
        } else {
            r.route("/api/pair/generate",   post(handle_pair_generate))
             .route("/api/pair/claim",      post(handle_pair_claim))
             .route("/api/pair/disconnect", post(handle_pair_disconnect))
        };

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
             .route("/api/model-candidates",   get(handle_model_candidates))
             .layer(axum::extract::Extension(st.clone()))
             .layer(axum::extract::Extension(Arc::clone(&observation_cache)))
        } else {
            r
        };

        r.fallback(static_handler)
         .layer(axum::extract::Extension(store_healthy))
        .layer(axum::extract::Extension(CloudDisabled(no_cloud)))
        .layer(axum::extract::Extension(v1_port_rx))
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
         .layer(axum::extract::Extension(latest_frame.clone()))
         .layer(axum::extract::Extension(broadcast_tx))
         .layer(axum::extract::Extension(probe_active))
         .layer(axum::extract::Extension(NodeId(Arc::new(config.node_id.clone()))))
         .layer(axum::extract::Extension(ProxyPorts { listen: proxy_listen, target: proxy_target }))
         .layer(axum::extract::Extension(Arc::clone(&runtime_config_cache)))
         .layer(axum::extract::Extension(Arc::clone(&ollama_caps)))
         .layer(axum::extract::Extension(Arc::clone(&residency_tracker)))
         .layer(axum::extract::Extension(receipt_memory))
         .layer(cors)
         .layer(axum::middleware::from_fn_with_state(
             Arc::clone(&auth_policy),
             auth::require_auth,
         ))
    };
    let _ = &metrics_store;

    let mut eviction_attempted = false;
    let listener = loop {
        let bind_addr = config.bind_address.as_deref().unwrap_or("127.0.0.1");
        match tokio::net::TcpListener::bind(format!("{bind_addr}:{port}")).await {
            Ok(l) => break l,
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                #[cfg(not(target_os = "windows"))]
                if !eviction_attempted {
                    eviction_attempted = true;
                    if try_evict_port(port).await {
                        println!("  ✓ Previous instance evicted. Starting on :{port}…");
                        continue;
                    }
                }
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

    if no_cloud {
        eprintln!("[no-cloud] self-update check skipped");
    } else {
        let pairing_state     = Arc::clone(&pairing_state);
        let live_events       = Arc::clone(&live_events);
        let recent_events_log = Arc::clone(&recent_events_log);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            check_and_apply_update(pairing_state, live_events, recent_events_log).await;
        });
    }

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

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
        .with_graceful_shutdown(shutdown)
        .await
        .expect("Server exited unexpectedly");

    eprintln!("[agent] clean shutdown complete");
}

#[cfg(test)]
mod version_output_tests {
    use super::{cloud_is_disabled, no_cloud_conflict, version_is_command_output};

    #[test]
    fn version_flags_put_it_on_stdout() {
        assert!(version_is_command_output(["wicklee", "--version"]));
        assert!(version_is_command_output(["wicklee", "-V"]));
    }

    #[test]
    fn everything_else_keeps_stdout_clean() {
        for args in [
            vec!["wicklee"],
            vec!["wicklee", "--status"],
            vec!["wicklee", "ready", "--json"],
            vec!["wicklee", "inspect", "--json"],
            vec!["wicklee", "findings"],
            vec!["wicklee", "--mcp-stdio"],
            vec!["wicklee", "--install-service"],
            vec!["wicklee", "--pair"],
        ] {
            assert!(
                !version_is_command_output(&args),
                "{args:?} must not print the banner to stdout",
            );
        }
    }

    #[test]
    fn a_version_substring_is_not_a_version_flag() {
        for args in [
            vec!["wicklee", "--versions"],
            vec!["wicklee", "--version-check"],
            vec!["wicklee", "-Version"],
        ] {
            assert!(!version_is_command_output(&args), "{args:?} is not --version");
        }
    }

    #[test]
    fn no_cloud_is_recognised_only_when_it_is_actually_passed() {
        assert!(cloud_is_disabled(["wicklee", "--no-cloud"]));
        assert!(cloud_is_disabled(["wicklee", "--no-cloud", "--pair"]));
        for args in [
            vec!["wicklee"],
            vec!["wicklee", "--status"],
            vec!["wicklee", "--nocloud"],
            vec!["wicklee", "--no-cloud-push"],
            vec!["wicklee", "no-cloud"],
        ] {
            assert!(!cloud_is_disabled(&args), "{args:?} must not disable the fleet");
        }
    }

    #[test]
    fn no_cloud_refuses_the_flags_that_would_ignore_it() {
        for flag in ["--pair", "--install-service", "--uninstall-service"] {
            let got = no_cloud_conflict(["wicklee", "--no-cloud", flag]);
            assert_eq!(got.map(|(f, _)| f), Some(flag), "{flag} must be refused");
            assert!(got.unwrap().1.len() > 10, "a refusal has to say why");
            assert_eq!(
                no_cloud_conflict(["wicklee", flag, "--no-cloud"]).map(|(f, _)| f),
                Some(flag)
            );
            assert!(no_cloud_conflict(["wicklee", flag]).is_none());
        }
        assert!(no_cloud_conflict(["wicklee", "--no-cloud"]).is_none());
        assert!(no_cloud_conflict(["wicklee", "--no-cloud", "--status"]).is_none());
        assert!(no_cloud_conflict(["wicklee", "--no-cloud", "--mcp-stdio"]).is_none());
    }
}
