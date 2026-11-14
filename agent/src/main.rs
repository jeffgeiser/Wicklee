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
mod auth;
mod ollama_client;
mod caps;
mod residency;
mod findings;
mod readiness;
mod cli;
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
    // The version line is printed on every invocation — daemon startup and
    // sudo install/uninstall both benefit from an immediate "which build is
    // this?" confirmation. It goes to **stderr**, because Phase 1 adds
    // `wicklee ready --json` and `wicklee inspect --json` and a banner on
    // stdout would be the first line a caller pipes into jq. `--version` is
    // the exception: there the version is the command's output.
    let version_line = format!("wicklee-agent v{}", env!("CARGO_PKG_VERSION"));
    let version_flag = version_is_command_output(std::env::args());
    if version_flag {
        println!("{version_line}");
    } else {
        eprintln!("{version_line}");
    }

    // ── Subcommands ───────────────────────────────────────────────────────────
    // A first argument that does not start with `--` is a subcommand. Every
    // existing flag, and `wicklee` with no arguments, falls through untouched.
    //
    // This sits before the config is read, because a client subcommand has no
    // business touching it: load_or_create_config() *creates* a config when
    // none exists, and `wicklee ready` asking a running agent a question
    // should not write to disk. A typo must not boot a daemon either, so an
    // unrecognised subcommand exits rather than falling through.
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

    // ── --no-cloud ────────────────────────────────────────────────────────────
    // Read before the config, like the subcommands above, so a refusal costs
    // nothing and writes nothing.
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
        // Restore session_token so telemetry push resumes immediately after a restart.
        cloud_session_token: config.session_token.clone(),
        status: match config.fleet_url.clone() {
            Some(url) => PairingStatus::Connected { fleet_url: url },
            None      => PairingStatus::Unpaired,
        },
    }));

    if version_flag {
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

    // ── Inbound auth: the Remote access startup rule ──────────────────────────
    // Evaluated here, after every client-mode flag has returned (so `--status`
    // and `--mcp-stdio` still work on a misconfigured host) and before any task
    // is spawned or any port is bound. A non-loopback bind with no credential
    // refuses to start rather than exposing hardware, loaded models and the
    // writable /api/pair/claim and /mcp routes to the network.
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

        // Pairing is done — config is saved. The running service (systemd/launchd)
        // will pick up the new fleet_url + session_token on its next telemetry push.
        // Don't fall through to the server startup path, which would evict the
        // running service and confuse users with SIGTERM/shutdown messages.
        println!("\n  ✓ Pairing complete. The background service will connect to the fleet automatically.");
        println!("  Run `wicklee --status` to verify.\n");
        return;
    }

    // Run diagnostics first so the output appears before the banner
    let diag_status = match (pair_on_start, no_cloud) {
        (true, _) => "pending".to_string(),
        // The config still says paired, and that is worth seeing — but on its
        // own "connected" would be read as "this agent is feeding the fleet".
        (false, true) => format!("{initial_status} · no-cloud"),
        (false, false) => initial_status.to_string(),
    };
    diagnostics::run_startup_diagnostics(&config.node_id, &diag_status, port, &config).await;

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
    // Port resolution: TOML config → env var → auto-discovery. One resolver,
    // shared with diagnostics, returning the source alongside the number —
    // see process_discovery::resolve_port on why the source has to travel with
    // it. llama.cpp and llama-box are one harvester, so their two discovery
    // entries collapse before resolution.
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
    //
    // `ollama_port_pinned` is that same authority, named once and used twice:
    // here, to keep discovery out of the channel, and at the harvester, which
    // otherwise validates the port and falls back to :11434 on its own. Two
    // separate copies of this condition is how the override came to be
    // honoured in one place and silently discarded in the other.
    let ollama_port_pinned = pinned(ollama_res) || proxy_arc.is_some();
    let mut discovery_txs: std::collections::HashMap<&str, _> = Default::default();
    if !ollama_port_pinned { discovery_txs.insert("ollama", ollama_port_tx); }
    if !pinned(vllm_res)     { discovery_txs.insert("vllm",      vllm_port_tx);     }
    if !pinned(llamacpp_res) { discovery_txs.insert("llamacpp",  llamacpp_disc_tx);  }
    if !pinned(llamacpp_res) { discovery_txs.insert("llama-box", llamabox_disc_tx);  }
    if !pinned(sglang_res)   { discovery_txs.insert("sglang",   _sglang_port_tx);   }
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
    // /v1/state reads /api/tags on demand too, so it needs its own receiver.
    let state_port_rx = ollama_port_rx.clone();
    let probe_policy = ProbeConfig::policy(config.probe.as_ref());
    if probe_policy.enabled {
        eprintln!("[probe] idle probes every {} min (loaded models only)", probe_policy.interval.as_secs() / 60);
    }
    // Per-model residency state and the transition log. Fed by the harvester's
    // existing /api/ps poll — no new poller, per the Phase 1 architecture.
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
    // Not started under --no-cloud: the loop reads the session_token restored
    // from the shared config, so a second agent on a paired host would
    // otherwise interleave its own frames with the installed service's under
    // one node id, and the fleet has no way to tell the two writers apart.
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

                // Residency transition writer — drains the tracker's queue and
                // persists it. The tracker is fed by the harvester's existing
                // /api/ps poll; this only moves rows to disk, and until it
                // announces itself the tracker queues nothing.
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
            .route("/api/tags",           get(move |caps, residency| handle_tags(tags_port_rx.clone(), caps, residency)))
            // Not store-gated: it reads the residency log, which falls back to
            // the tracker's in-memory window when there is no DuckDB.
            .route("/api/model-switches", get(handle_model_switches))
            // ── /v1: the Phase 1 surface. Covered by the same inbound auth
            // middleware as /api and /mcp, applied as the outermost layer.
            .route("/v1/state", get(move |caps, residency, node_id| {
                handle_v1_state(state_port_rx.clone(), caps, residency, node_id)
            }))
            .route("/v1/readiness", get(handle_v1_readiness))
            .route("/api/events/recent",  get(handle_events_recent))
            .route("/api/metrics",        get(handle_metrics))       // SSE fallback (1 Hz)
            .route("/api/metrics/snapshot", get(handle_metrics_snapshot)) // one-shot JSON of latest frame
            .route("/ws",                 get(handle_ws))             // WebSocket primary (1 Hz)
            // /api/pair/status stays live under --no-cloud: it is local,
            // read-only, and is how a caller tells the two agents apart.
            .route("/api/pair/status",    get(handle_pair_status))
            // MCP (Model Context Protocol) — JSON-RPC 2.0 for AI agents
            .route("/mcp",                      post(handle_mcp))
            .route("/.well-known/mcp.json",     get(handle_mcp_manifest))
            // v0.9.0: Runtime Config Surface — backed by in-memory cache,
            // available regardless of store health.
            .route("/api/runtime-config",       get(handle_runtime_config))
            .route("/api/deployment-profile",   get(handle_get_deployment_profile).put(handle_put_deployment_profile));

        // The three pairing writes either reach the fleet or rewrite the
        // config file the installed service reads. Under --no-cloud they are
        // replaced by a handler that says so, rather than dropped: see
        // handle_pair_disabled on why a 404 here would mislead.
        let r = if no_cloud {
            r.route("/api/pair/generate",   post(handle_pair_disabled))
             .route("/api/pair/claim",      post(handle_pair_disabled))
             .route("/api/pair/disconnect", post(handle_pair_disabled))
        } else {
            r.route("/api/pair/generate",   post(handle_pair_generate))
             .route("/api/pair/claim",      post(handle_pair_claim))
             .route("/api/pair/disconnect", post(handle_pair_disconnect))
        };

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
             .route("/api/model-candidates",   get(handle_model_candidates))
             .layer(axum::extract::Extension(st.clone()))
             .layer(axum::extract::Extension(Arc::clone(&observation_cache)))
        } else {
            r
        };

        r.fallback(static_handler)
         .layer(axum::extract::Extension(store_healthy))
        .layer(axum::extract::Extension(CloudDisabled(no_cloud)))
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
         // The capability record, filled in live by the Ollama harvester from
         // the responses it sees and by /api/tags. Step 3 publishes it on
         // GET /v1/state and step 4 gates rules on it.
         .layer(axum::extract::Extension(Arc::clone(&ollama_caps)))
         .layer(axum::extract::Extension(Arc::clone(&residency_tracker)))
         .layer(cors)
         // Outermost layer: every route, including the embedded dashboard and
         // the static fallback, passes the peer-address and token check before
         // any handler or extractor runs.
         .layer(axum::middleware::from_fn_with_state(
             Arc::clone(&auth_policy),
             auth::require_auth,
         ))
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
    //
    // Skipped under --no-cloud. This one is not merely outbound: on finding a
    // newer build it downloads and replaces the binary on disk, which a
    // throwaway agent must never do to an installed one.
    if no_cloud {
        eprintln!("[no-cloud] self-update check skipped");
    } else {
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

    // `into_make_service_with_connect_info` is what puts ConnectInfo<SocketAddr>
    // into each request's extensions; without it the auth middleware has no
    // peer address to check and fails closed.
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
        // Phase 1 adds `wicklee ready --json | jq`. A banner on stdout would be
        // the first line jq reads, so every non-version invocation logs to
        // stderr instead.
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
        // Matched exactly, so these do not divert the banner to stdout.
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
            // Near misses must not disable the fleet by accident: an agent
            // that silently stops pushing is the failure this flag exists to
            // make visible, so it may only happen when asked for exactly.
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
            // Order of the two flags cannot change the answer.
            assert_eq!(
                no_cloud_conflict(["wicklee", flag, "--no-cloud"]).map(|(f, _)| f),
                Some(flag)
            );
            // And the flag on its own is still perfectly valid.
            assert!(no_cloud_conflict(["wicklee", flag]).is_none());
        }
        assert!(no_cloud_conflict(["wicklee", "--no-cloud"]).is_none());
        // --status and --mcp-stdio make no fleet request of their own, so
        // there is nothing for --no-cloud to contradict.
        assert!(no_cloud_conflict(["wicklee", "--no-cloud", "--status"]).is_none());
        assert!(no_cloud_conflict(["wicklee", "--no-cloud", "--mcp-stdio"]).is_none());
    }
}
