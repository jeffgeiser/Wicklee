//! Runtime process discovery — cross-platform, port-free detection.
//!
//! Instead of probing hardcoded ports, the agent scans running processes on a
//! regular interval. For each known inference runtime it resolves the listening
//! port through a three-tier **Priority of Truth** chain:
//!
//! 1. **TOML override** — `[runtime_ports]` in `~/.wicklee/config.toml`
//!    (handled by the caller, not this module).
//! 2. **Cmdline arg scan** — reads `--port <N>` / `--port=<N>` from the
//!    process's argv via [`sysinfo`]. Works for processes owned by the same OS
//!    user. Prefers the process with an explicit `--port` flag over worker
//!    sub-processes that inherit the default.
//! 3. **Socket inode scan** (Linux only) — when cmdline is empty (cross-user
//!    process) or contains no explicit port, resolves the listening port by
//!    reading `/proc/{pid}/fd/` for socket inodes and cross-referencing with
//!    `/proc/net/tcp` and `/proc/net/tcp6` (both world-readable, no elevated
//!    permissions needed).
//!
//! For zero-config cross-user deployments (e.g. vLLM running as a different OS
//! user), grant `cap_sys_ptrace` so sysinfo can read the foreign process's
//! cmdline:
//! ```text
//! sudo setcap cap_sys_ptrace+ep $(which wicklee)
//! ```
//! Without `cap_sys_ptrace` the socket scan still resolves the port as long as
//! the process has at least one open listening socket (which is always true for
//! a running inference server).
//!
//! # Extensibility
//! To add a new inference runtime, append one entry to [`RUNTIME_SPECS`].
//! The scanner, discovery loop, and harvester watch-channel lifecycle are
//! fully generic — no per-runtime code is required anywhere else.
//!
//! # Platform support
//! Uses [`sysinfo`] for process enumeration, which is cross-platform: Linux
//! (`/proc`), macOS (`sysctl`), and Windows (`CreateToolhelp32Snapshot`).
//! The Tier-3 socket scan is Linux-only; on macOS/Windows the scan gracefully
//! skips Tier 3 and falls back to the default port.
//! No elevated permissions are required for Tier 2 or Tier 3.

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
    // llama.cpp: port discovery only in v0.4.37.
    // inference_active harvester (GET /health) deferred to v0.4.38.
    RuntimeSpec {
        name:            "llamacpp",
        exact_binary:    &["llama-server"],
        cmdline_markers: &["llama-server", "llama_server"],
        port_arg:        "--port",
        default_port:    8080,
    },
    // llama-box (llama.cpp single-binary distribution)
    RuntimeSpec {
        name:            "llama-box",
        exact_binary:    &["llama-box"],
        cmdline_markers: &["llama-box"],
        port_arg:        "--port",
        default_port:    8080,
    },
    // RuntimeSpec { name: "lmstudio",  exact_binary: &["lms"],                       cmdline_markers: &[],              port_arg: "--port", default_port: 1234 },
    // RuntimeSpec { name: "tgi",       exact_binary: &["text-generation-launcher"],  cmdline_markers: &[],              port_arg: "--port", default_port: 3000 },
    // RuntimeSpec { name: "triton",    exact_binary: &["tritonserver"],              cmdline_markers: &[],              port_arg: "--http-port", default_port: 8000 },
];

// ── Watch channel types ───────────────────────────────────────────────────────

/// Receives the current state of a runtime: `Some(port)` = running, `None` = not found.
pub type PortRx = watch::Receiver<Option<u16>>;
/// Sends runtime state updates into a harvester's watch channel.
pub type PortTx = watch::Sender<Option<u16>>;

// ── Tier-3: Linux socket-inode scan ──────────────────────────────────────────

/// Collects all socket inodes held open by `pid` by reading `/proc/{pid}/fd/`.
///
/// Each fd that is a socket symlink looks like `socket:[12345678]`.
/// Returns an empty set when the directory is unreadable (cross-user, missing
/// `cap_sys_ptrace`).
#[cfg(target_os = "linux")]
fn socket_inodes_for_pid(pid: u32) -> std::collections::HashSet<u64> {
    let fd_dir = format!("/proc/{}/fd", pid);
    let mut inodes = std::collections::HashSet::new();
    let Ok(entries) = std::fs::read_dir(&fd_dir) else {
        return inodes;
    };
    for entry in entries.flatten() {
        if let Ok(target) = std::fs::read_link(entry.path()) {
            let s = target.to_string_lossy();
            // socket fds resolve to "socket:[inode]"
            if let Some(inner) = s.strip_prefix("socket:[").and_then(|s| s.strip_suffix(']')) {
                if let Ok(inode) = inner.parse::<u64>() {
                    inodes.insert(inode);
                }
            }
        }
    }
    inodes
}

/// Parses a `/proc/net/tcp` or `/proc/net/tcp6` file and returns a map of
/// `inode → local_port` for sockets in LISTEN state (hex state field `0A`).
///
/// Both files are world-readable — no elevated permissions required.
#[cfg(target_os = "linux")]
fn listening_inode_to_port(path: &str) -> HashMap<u64, u16> {
    let mut map = HashMap::new();
    let Ok(content) = std::fs::read_to_string(path) else {
        return map;
    };
    for line in content.lines().skip(1) {
        // Columns: sl  local_address  rem_address  state  tx_q:rx_q  ...  inode
        // Example: "  0: 00000000:1F92 00000000:0000 0A  00000000:00000000 00:00000000 00000000  1000  0  12345678 ..."
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 10 {
            continue;
        }
        // state is field [3]; "0A" = TCP_LISTEN
        if cols[3] != "0A" {
            continue;
        }
        // local_address is field [1]: "<hex_ip>:<hex_port>"
        let local_addr = cols[1];
        let Some(colon_pos) = local_addr.rfind(':') else { continue };
        let port_hex = &local_addr[colon_pos + 1..];
        let Ok(port) = u16::from_str_radix(port_hex, 16) else { continue };
        // inode is field [9]
        let Ok(inode) = cols[9].parse::<u64>() else { continue };
        map.insert(inode, port);
    }
    map
}

/// **Tier-3 discovery**: resolves the port a process is listening on via
/// socket inodes — no cmdline access required.
///
/// Algorithm:
/// 1. Read `/proc/{pid}/fd/` symlinks to collect this process's socket inodes.
/// 2. Cross-reference with `/proc/net/tcp6` then `/proc/net/tcp` (both
///    world-readable) for entries in LISTEN state.
/// 3. Return the first matching local port.
///
/// Returns `Some(port)` on success, `None` when:
/// - Not running on Linux (compile-time excluded on other platforms).
/// - `/proc/{pid}/fd/` is unreadable (cross-user without `cap_sys_ptrace`).
/// - No matching LISTEN socket is found for this PID.
///
/// Note: `/proc/net/tcp` and `/proc/net/tcp6` are **world-readable** regardless
/// of the process owner — only reading `/proc/{pid}/fd/` requires same-user or
/// `cap_sys_ptrace`. This means even when cmdline is empty (other-user process),
/// the socket scan succeeds as long as the agent can read the fd directory.
#[cfg(target_os = "linux")]
pub fn socket_port_for_pid(pid: u32) -> Option<u16> {
    let inodes = socket_inodes_for_pid(pid);
    if inodes.is_empty() {
        return None;
    }
    // Prefer tcp6 — dual-stack servers bind on ":::" which appears there even
    // for IPv4-mapped connections. Fall through to tcp for IPv4-only servers.
    for table in &["/proc/net/tcp6", "/proc/net/tcp"] {
        let listen_map = listening_inode_to_port(table);
        for inode in &inodes {
            if let Some(&port) = listen_map.get(inode) {
                return Some(port);
            }
        }
    }
    None
}

/// Stub for non-Linux targets — Tier 3 is a no-op; always returns `None`.
#[cfg(not(target_os = "linux"))]
pub fn socket_port_for_pid(_pid: u32) -> Option<u16> {
    None
}

// ── Process scanner ───────────────────────────────────────────────────────────

/// Scans all running processes and returns a map of `runtime_name → port`
/// for every runtime that is currently active.
///
/// Port resolution follows the **Priority of Truth** chain (Tiers 2–3):
///
/// 1. If a process has an explicit `--port <N>` flag in its argv → use that.
/// 2. If cmdline is unavailable (cross-user) or has no `--port` flag, attempt
///    a Linux socket-inode scan ([`socket_port_for_pid`]) to read the actual
///    listening port from the kernel's TCP table.
/// 3. Fall back to the runtime's `default_port` if neither tier resolves.
///
/// Tier-1 (TOML override) is applied by the caller before the scan result is
/// used — this function returns only auto-discovered ports.
///
/// When multiple processes match the same runtime (e.g. main server + worker
/// sub-processes), the one with an **explicit `--port` flag** wins over a
/// default-port candidate, and an explicit-port candidate suppresses Tier 3.
pub fn scan_runtimes() -> HashMap<&'static str, u16> {
    let mut sys = sysinfo::System::new();
    sys.refresh_processes();

    // Per-runtime candidate state:
    //   explicit  — true when at least one matching process had an explicit --port flag.
    //   port      — the resolved port (explicit wins; default used as placeholder).
    //   pids      — ALL matching PIDs accumulated for Tier-3 socket scanning.
    //               Multiple processes match the same runtime when a main server
    //               spawns worker subprocesses (e.g. vLLM + its Torch workers).
    //               We need all of them so Tier 3 can scan each and find the one
    //               actually listening on the user-configured non-default port.
    struct Candidate {
        explicit: bool,
        port:     u16,
        pids:     Vec<u32>,
    }
    let mut candidates: HashMap<&'static str, Candidate> = HashMap::new();

    for process in sys.processes().values() {
        // Short-circuit only once every runtime has an explicit-port match.
        let all_confirmed = candidates.len() == RUNTIME_SPECS.len()
            && candidates.values().all(|c| c.explicit);
        if all_confirmed { break; }

        let name = process.name().to_string();
        let cmd: Vec<String> = process.cmd().to_vec();
        let pid = process.pid().as_u32();

        for spec in RUNTIME_SPECS {
            if candidates.get(spec.name).map_or(false, |c| c.explicit) {
                continue; // already locked in with an explicit port
            }
            if !spec.matches(&name, &cmd) { continue; }

            let explicit = spec.has_explicit_port(&cmd);
            let port     = spec.extract_port(&cmd);

            match candidates.get_mut(spec.name) {
                Some(c) if explicit => {
                    // Hard upgrade: switch to the process that has --port <N>.
                    c.explicit = true;
                    c.port     = port;
                    c.pids     = vec![pid];
                }
                Some(c) => {
                    // Another non-explicit match (likely a worker subprocess).
                    // Accumulate its PID so Tier 3 can scan it too.
                    c.pids.push(pid);
                }
                None => {
                    candidates.insert(spec.name, Candidate { explicit, port, pids: vec![pid] });
                }
            }
            break; // a process matches at most one runtime
        }
    }

    // Tier 3: for any runtime whose port is still unconfirmed (no explicit --port
    // flag found in any process's argv), attempt a socket-inode scan on EVERY
    // matching PID.  Worker sub-processes typically bind internal sockets on the
    // runtime's default port; the main server binds on the configured port.
    // Strategy: prefer the first PID whose listening socket port differs from the
    // runtime's default_port — that is the user-configured main server.
    candidates
        .into_iter()
        .map(|(name, c)| {
            if c.explicit {
                return (name, c.port);
            }
            let spec = RUNTIME_SPECS.iter().find(|s| s.name == name).unwrap();
            let mut result = c.port; // start with default as fallback
            for pid in &c.pids {
                if let Some(sp) = socket_port_for_pid(*pid) {
                    if sp != spec.default_port {
                        // Non-default → this is the main server, not a worker.
                        // (Logged only by the discovery loop on change, not per-scan.)
                        result = sp;
                        break;
                    }
                    // Confirms the runtime is running; keep scanning for non-default.
                    result = sp;
                }
            }
            (name, result)
        })
        .collect()
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
