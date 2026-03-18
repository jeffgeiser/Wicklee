//! Runtime process discovery — cross-platform, port-free detection.
//!
//! Instead of probing hardcoded ports, the agent scans running processes on a
//! regular interval. For each known inference runtime it reads the listening
//! port directly from the process's command-line arguments (falling back to the
//! well-known default only if `--port` is absent), then delivers the result
//! through a `watch` channel so harvesters can react to changes without
//! requiring a restart.
//!
//! # Extensibility
//! To add a new inference runtime, append one entry to [`RUNTIME_SPECS`].
//! The scanner, discovery loop, and harvester watch-channel lifecycle are
//! fully generic — no per-runtime code is required anywhere else.
//!
//! # Platform support
//! Uses [`sysinfo`] for process enumeration, which is cross-platform: Linux
//! (`/proc`), macOS (`sysctl`), and Windows (`CreateToolhelp32Snapshot`).
//! No elevated permissions are required.

use std::collections::HashMap;
use tokio::sync::watch;

// ── Runtime specification ─────────────────────────────────────────────────────

/// Declarative description of a single inference runtime.
///
/// All discovery logic is derived entirely from this struct — no per-runtime
/// code lives outside [`RUNTIME_SPECS`].
pub struct RuntimeSpec {
    /// Human-readable name used in logs and as the map key in harvesters.
    pub name: &'static str,

    /// Process binary names (case-insensitive basename) that unambiguously
    /// identify this runtime without inspecting further arguments.
    ///
    /// Example: `["ollama"]` — any process named `ollama` is the daemon.
    pub exact_binary: &'static [&'static str],

    /// Substrings searched across all command-line arguments.
    ///
    /// A match here identifies module-based runtimes launched through an
    /// interpreter (e.g. `python -m vllm.entrypoints.openai.api_server`).
    /// Ignored when `exact_binary` already matched.
    pub cmdline_markers: &'static [&'static str],

    /// CLI flag that carries the listening port in the process's argv.
    pub port_arg: &'static str,

    /// Port used when `port_arg` is absent from the command line.
    pub default_port: u16,
}

impl RuntimeSpec {
    /// Returns `true` if the described process matches this runtime.
    ///
    /// Markers are matched against the **full joined command line**, not against
    /// individual argv entries. This handles invocations like
    /// `python3 /path/to/bin/vllm serve --port 18010` where the runtime name
    /// and subcommand appear in adjacent-but-separate argv slots.
    pub fn matches(&self, binary_name: &str, cmd: &[String]) -> bool {
        // Exact binary name is the cheapest check — do it first.
        if self
            .exact_binary
            .iter()
            .any(|&b| binary_name.eq_ignore_ascii_case(b))
        {
            return true;
        }
        // Join all argv entries into one string so markers that span arg
        // boundaries (e.g. "vllm serve" as two separate tokens) still match.
        if !self.cmdline_markers.is_empty() {
            let full_cmd = cmd.join(" ");
            return self.cmdline_markers.iter().any(|&m| full_cmd.contains(m));
        }
        false
    }

    /// Returns `true` if this process has an explicit `--port <N>` or
    /// `--port=<N>` argument. Used by the scanner to prefer the main server
    /// process over worker sub-processes that inherit the default port.
    pub fn has_explicit_port(&self, cmd: &[String]) -> bool {
        let eq_prefix = format!("{}=", self.port_arg);
        cmd.iter().enumerate().any(|(i, arg)| {
            (arg == self.port_arg && cmd.get(i + 1).and_then(|v| v.parse::<u16>().ok()).is_some())
                || arg.strip_prefix(&eq_prefix).and_then(|s| s.parse::<u16>().ok()).is_some()
        })
    }

    /// Extracts the listening port from cmdline args.
    ///
    /// Handles both `--port 8001` (space-separated) and `--port=8001` (equals)
    /// forms. Falls back to [`Self::default_port`] when the flag is absent.
    pub fn extract_port(&self, cmd: &[String]) -> u16 {
        let eq_prefix = format!("{}=", self.port_arg);
        for (i, arg) in cmd.iter().enumerate() {
            // --port 8001
            if arg == self.port_arg {
                if let Some(val) = cmd.get(i + 1).and_then(|v| v.parse::<u16>().ok()) {
                    return val;
                }
            }
            // --port=8001
            if let Some(suffix) = arg.strip_prefix(&eq_prefix) {
                if let Ok(val) = suffix.parse::<u16>() {
                    return val;
                }
            }
        }
        self.default_port
    }
}

// ── Runtime registry ──────────────────────────────────────────────────────────

/// All known inference runtimes.
///
/// **To add a new runtime: append one entry here. Nothing else changes.**
/// The scanner and harvesters are fully generic over this slice.
pub const RUNTIME_SPECS: &[RuntimeSpec] = &[
    RuntimeSpec {
        name:            "ollama",
        exact_binary:    &["ollama"],
        cmdline_markers: &[],
        port_arg:        "--port",
        default_port:    11434,
    },
    RuntimeSpec {
        name:            "vllm",
        // vLLM ships both a native `vllm` CLI and Python module invocations.
        exact_binary:    &["vllm"],
        cmdline_markers: &["vllm.entrypoints", "vllm serve", "-m vllm"],
        port_arg:        "--port",
        default_port:    8000,
    },
    // ── Add future runtimes below — one entry each ────────────────────────────
    // RuntimeSpec { name: "llamacpp",  exact_binary: &["llama-server"],              cmdline_markers: &[],              port_arg: "--port", default_port: 8080 },
    // RuntimeSpec { name: "lmstudio",  exact_binary: &["lms"],                       cmdline_markers: &[],              port_arg: "--port", default_port: 1234 },
    // RuntimeSpec { name: "tgi",       exact_binary: &["text-generation-launcher"],  cmdline_markers: &[],              port_arg: "--port", default_port: 3000 },
    // RuntimeSpec { name: "triton",    exact_binary: &["tritonserver"],              cmdline_markers: &[],              port_arg: "--http-port", default_port: 8000 },
];

// ── Watch channel types ───────────────────────────────────────────────────────

/// Receives the current state of a runtime: `Some(port)` = running, `None` = not found.
pub type PortRx = watch::Receiver<Option<u16>>;
/// Sends runtime state updates into a harvester's watch channel.
pub type PortTx = watch::Sender<Option<u16>>;

// ── Process scanner ───────────────────────────────────────────────────────────

/// Scans all running processes and returns a map of `runtime_name → port`
/// for every runtime that is currently active.
///
/// Uses [`sysinfo`] for cross-platform process enumeration — no `/proc`
/// parsing, no subprocesses, no elevated permissions required.
///
/// When multiple processes match the same runtime (e.g. a main server and
/// its worker sub-processes), the one with an **explicit `--port` flag** wins.
/// This ensures non-standard ports are always discovered correctly.
pub fn scan_runtimes() -> HashMap<&'static str, u16> {
    let mut sys = sysinfo::System::new();
    sys.refresh_processes();

    // Track (has_explicit_port, port) per runtime so we can upgrade a
    // default-port candidate to an explicit-port one if found later.
    let mut candidates: HashMap<&'static str, (bool, u16)> = HashMap::new();

    for process in sys.processes().values() {
        // Short-circuit only once every runtime has an explicit-port match.
        let all_confirmed = candidates.len() == RUNTIME_SPECS.len()
            && candidates.values().all(|&(explicit, _)| explicit);
        if all_confirmed {
            break;
        }

        let name = process.name().to_string();
        let cmd: Vec<String> = process.cmd().to_vec();

        for spec in RUNTIME_SPECS {
            // Already have a confirmed explicit-port match — nothing to improve.
            if candidates.get(spec.name).map_or(false, |&(explicit, _)| explicit) {
                continue;
            }
            if !spec.matches(&name, &cmd) {
                continue;
            }
            let explicit = spec.has_explicit_port(&cmd);
            let port     = spec.extract_port(&cmd);
            // Record this candidate if:
            //   • No candidate yet for this runtime, OR
            //   • This process has an explicit port (upgrades a default-port hit).
            if !candidates.contains_key(spec.name) || explicit {
                candidates.insert(spec.name, (explicit, port));
            }
            break; // a process matches at most one runtime
        }
    }

    candidates.into_iter().map(|(name, (_, port))| (name, port)).collect()
}

// ── Discovery loop ────────────────────────────────────────────────────────────

/// Spawns a background task that scans processes every `interval_secs` seconds
/// and pushes discovered ports into the provided watch channels.
///
/// - When a runtime appears or changes port: sends `Some(port)`.
/// - When a runtime disappears: sends `None`.
/// - Sends are suppressed when the value has not changed, so harvesters are
///   never woken spuriously between scan cycles.
pub fn start_discovery_loop(txs: HashMap<&'static str, PortTx>, interval_secs: u64) {
    tokio::spawn(async move {
        let mut ticker =
            tokio::time::interval(std::time::Duration::from_secs(interval_secs));
        // If a scan takes longer than the interval (unlikely), skip missed ticks
        // rather than firing a burst of back-to-back scans.
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            ticker.tick().await;

            let active: HashMap<&str, u16> = scan_runtimes()
                .into_iter()
                .map(|(n, p)| (n, p))
                .collect();

            for (name, tx) in &txs {
                let new_val = active.get(name).copied();
                // Only send when the value actually changed.
                if *tx.borrow() != new_val {
                    let _ = tx.send(new_val);
                    match new_val {
                        Some(p) => eprintln!("[discovery] {name} → :{p}"),
                        None    => eprintln!("[discovery] {name} not running"),
                    }
                }
            }
        }
    });
}
