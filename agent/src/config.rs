//! Agent configuration (config.toml): WickleeConfig and friends, load/save/update, node-id derivation.
//! Split out of main.rs; items are pub(crate) and re-exported at the crate root.

use super::*;

// ── Fleet Pairing Types ───────────────────────────────────────────────────────

/// Optional transparent proxy configuration.
/// When enabled, the agent binds :11434 and forwards to Ollama on ollama_port.
/// Provides zero-lag inference detection and exact tok/s from done packets.
/// Requires the user to move Ollama to ollama_port (OLLAMA_HOST=127.0.0.1:11435).
#[derive(Serialize, Deserialize, Default, Clone)]
pub(crate) struct OllamaProxyConfig {
    /// Enable the transparent proxy. Default: false (Phase A /api/ps polling).
    #[serde(default)]
    pub(crate) enabled: bool,
    /// Port where Ollama listens after being moved. Default: 11435.
    #[serde(default = "default_proxy_ollama_port")]
    pub(crate) ollama_port: u16,
    /// Return 503 immediately when backend is unreachable rather than timing out.
    #[serde(default)]
    pub(crate) bypass_if_proxy_down: bool,
}

pub(crate) fn default_proxy_ollama_port() -> u16 { 11435 }

/// Explicit port overrides for inference runtimes.
///
/// When set, these values take precedence over process-based auto-detection.
/// Use when the runtime runs as a different OS user and the agent cannot read
/// its process cmdline (common on shared machines or managed deployments).
///
/// Example in ~/.wicklee/config.toml:
///
/// ```toml
/// [runtime_ports]
/// vllm   = 18010
/// ollama = 11434
/// ```
#[derive(Serialize, Deserialize, Default, Clone)]
pub(crate) struct RuntimePortsConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ollama: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) vllm: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) llamacpp: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) sglang: Option<u16>,
}

/// Idle-probe settings. Each probe is a real ~20-token generation against an
/// already-loaded model, used to measure the node's idle tok/s baseline
/// (IDLE-SPD). Probes never load a model; they fire only when the baseline is
/// missing, the model changed, or `interval_minutes` elapsed.
///
/// Example in config.toml:
///
/// ```toml
/// [probe]
/// enabled          = true   # false disables all synthetic probes
/// interval_minutes = 10     # minimum gap between probes (min 1)
/// ```
#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct ProbeConfig {
    #[serde(default = "default_probe_enabled")]
    pub(crate) enabled: bool,
    #[serde(default = "default_probe_interval_minutes")]
    pub(crate) interval_minutes: u64,
}

pub(crate) fn default_probe_enabled() -> bool { true }
pub(crate) fn default_probe_interval_minutes() -> u64 { 10 }

impl ProbeConfig {
    /// Resolve the optional `[probe]` section into the harvester policy.
    /// Absent section → defaults (enabled, 10 min). Interval is clamped to ≥ 1 min.
    pub(crate) fn policy(cfg: Option<&ProbeConfig>) -> harvester::ProbePolicy {
        match cfg {
            None => harvester::ProbePolicy::default(),
            Some(c) => harvester::ProbePolicy {
                enabled:  c.enabled,
                interval: Duration::from_secs(c.interval_minutes.max(1) * 60),
            },
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
pub(crate) struct WickleeConfig {
    pub(crate) node_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) fleet_url: Option<String>,
    /// Cloud session token — persisted so telemetry push resumes after restart.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) session_token: Option<String>,
    /// Optional transparent Ollama proxy configuration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) ollama_proxy: Option<OllamaProxyConfig>,
    /// Explicit port overrides — bypasses process-based auto-detection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) runtime_ports: Option<RuntimePortsConfig>,
    /// Network bind address. Default "127.0.0.1" (localhost only).
    /// Set to "0.0.0.0" to accept LAN connections (proxy mode, remote dashboard).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) bind_address: Option<String>,
    /// Deployment profile governing observation sensitivity:
    /// "sovereign_dev" | "dedicated_server" (default) | "production_fleet".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) deployment_profile: Option<String>,
    /// Idle-probe settings (`[probe]`). Absent → enabled, every 10 minutes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) probe: Option<ProbeConfig>,
}

#[derive(Clone)]
pub(crate) enum PairingStatus {
    Unpaired,
    Pending { code: String, expires_at: u64 },
    Connected { fleet_url: String },
}

pub(crate) struct PairingState {
    pub(crate) status:               PairingStatus,
    pub(crate) node_id:              String,
    /// Session token returned by the cloud backend after a successful claim.
    /// Present only while paired; used to authenticate telemetry pushes.
    pub(crate) cloud_session_token:  Option<String>,
}

#[derive(Serialize)]
pub(crate) struct PairingStatusResponse {
    pub(crate) status: &'static str,
    pub(crate) node_id: String,
    pub(crate) code: Option<String>,
    pub(crate) expires_at: Option<u64>,
    pub(crate) fleet_url: Option<String>,
}

// ── Fleet Pairing Helpers ─────────────────────────────────────────────────────

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// System-global config path — identical whether the process runs as root (launchd/systemd)
/// or as a normal user. This prevents the "two config files" problem where upgrading via
/// launchd creates a separate identity from the user's manually-run instance.
///
/// macOS:   /Library/Application Support/Wicklee/config.toml
/// Linux:   /etc/wicklee/config.toml
/// Windows: %APPDATA%\Wicklee\config.toml  (fallback: C:\ProgramData\Wicklee\config.toml)
pub(crate) fn config_path() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        Path::new("/Library/Application Support/Wicklee/config.toml").to_path_buf()
    }
    #[cfg(target_os = "linux")]
    {
        Path::new("/etc/wicklee/config.toml").to_path_buf()
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("APPDATA")
            .or_else(|_| std::env::var("PROGRAMDATA"))
            .unwrap_or_else(|_| r"C:\ProgramData".to_string());
        Path::new(&base).join("Wicklee").join("config.toml")
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        // Fallback for any other platform
        Path::new(".wicklee").join("config.toml")
    }
}

/// Legacy per-user config path (pre-v0.4.37). Used only for one-time migration.
pub(crate) fn legacy_config_path() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        // Try $HOME first; then derive from /etc/passwd for the effective uid.
        let home = std::env::var("HOME").ok().or_else(|| {
            let uid = unsafe { libc::getuid() };
            // Real user's home — look up uid=500+ first; if root (0) skip migration.
            if uid == 0 { return None; }
            let pw = unsafe { libc::getpwuid(uid) };
            if pw.is_null() { return None; }
            let dir = unsafe { std::ffi::CStr::from_ptr((*pw).pw_dir) };
            dir.to_str().ok().map(|s| s.to_string())
        })?;
        let legacy = Path::new(&home).join(".wicklee").join("config.toml");
        if legacy.exists() { Some(legacy) } else { None }
    }
    #[cfg(not(unix))]
    { None }
}

/// Parent directory of config_path() — the Wicklee system config dir.
/// Used for the metrics DB and any future agent-local state files.
pub(crate) fn wicklee_dir() -> PathBuf {
    config_path()
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf()
}


/// Read the platform hardware identity string — stable across reboots and reinstalls.
///
/// Sources by platform:
///   Linux  — `/etc/machine-id` (systemd) or `/var/lib/dbus/machine-id` (DBus fallback)
///   macOS  — `IOPlatformUUID` via `ioreg -rd1 -c IOPlatformExpertDevice`
///   Windows — `MachineGuid` from `HKLM\SOFTWARE\Microsoft\Cryptography`
///
/// Returns `None` when the platform ID is unavailable (some containers, live ISOs, etc.).
pub(crate) fn hardware_machine_id() -> Option<String> {
    // ── Linux ────────────────────────────────────────────────────────────────
    #[cfg(target_os = "linux")]
    {
        for path in &["/etc/machine-id", "/var/lib/dbus/machine-id"] {
            if let Ok(id) = std::fs::read_to_string(path) {
                let id = id.trim().to_string();
                if id.len() >= 8 {
                    return Some(id);
                }
            }
        }
    }

    // ── macOS ────────────────────────────────────────────────────────────────
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
        {
            let s = String::from_utf8_lossy(&out.stdout);
            for line in s.lines() {
                if line.contains("IOPlatformUUID") {
                    // Line: "IOPlatformUUID" = "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
                    if let Some(end) = line.rfind('"') {
                        let before = &line[..end];
                        if let Some(start) = before.rfind('"') {
                            let uuid = before[start + 1..].to_string();
                            if uuid.len() >= 8 {
                                return Some(uuid);
                            }
                        }
                    }
                }
            }
        }
    }

    // ── Windows ──────────────────────────────────────────────────────────────
    #[cfg(target_os = "windows")]
    {
        if let Ok(out) = std::process::Command::new("reg")
            .args(["query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"])
            .output()
        {
            let s = String::from_utf8_lossy(&out.stdout);
            for line in s.lines() {
                if line.contains("MachineGuid") {
                    if let Some(guid) = line.split_whitespace().last() {
                        if guid.len() >= 8 {
                            return Some(guid.to_string());
                        }
                    }
                }
            }
        }
    }

    None
}

/// 64-bit FNV-1a hash — deterministic, no external crates, no randomized seed
/// (unlike `std::hash::DefaultHasher`). Same input always produces the same
/// output, across processes and platforms.
pub(crate) fn fnv1a_64(s: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325; // FNV offset basis
    for &b in s.as_bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3); // FNV prime
    }
    hash
}

/// Generate a node identity (`WK-` + 16 hex digits).
///
/// Priority:
///   1. Hardware platform ID (machine-id / IOPlatformUUID / MachineGuid),
///      hashed to 64 bits — deterministic, so it survives reinstalls,
///      upgrades, and re-pairings on the same machine.
///   2. Random 64-bit fallback when the platform ID is unavailable
///      (containers, live ISOs, some CI). Random, not timestamp-based, so
///      two nodes booting in the same millisecond can't collide.
///
/// SECURITY: the suffix carries the FULL entropy of the source. The previous
/// implementation folded it to 16 bits (`WK-XXXX`, 65,536 values), which made
/// node IDs trivially enumerable — and since `nodes.wk_id` is a GLOBAL primary
/// key and `/api/pair/claim` is unauthenticated, an attacker could iterate the
/// whole space to rotate every node's session token (fleet-wide DoS) or hijack
/// ownership. 64 bits removes enumeration and the birthday-collision risk that
/// made unrelated customers' machines collide on the shared PK at ~300 nodes.
///
/// `load_or_create_config()` only calls this on first run (no existing
/// config.toml), so already-paired nodes keep their existing `WK-XXXX` id.
pub(crate) fn generate_node_id() -> String {
    if let Some(hw_id) = hardware_machine_id() {
        return format!("WK-{:016X}", fnv1a_64(&hw_id));
    }
    // Fallback: a fresh random 64-bit value (CSPRNG via uuid v4).
    let r = uuid::Uuid::new_v4();
    let bytes = r.as_bytes();
    let suffix = u64::from_be_bytes(bytes[0..8].try_into().unwrap());
    format!("WK-{suffix:016X}")
}

pub(crate) fn load_or_create_config() -> WickleeConfig {
    let path = config_path();

    // ── Load from system-global path ─────────────────────────────────────────
    if path.exists()
        && let Ok(content) = std::fs::read_to_string(&path)
            && let Ok(cfg) = toml::from_str::<WickleeConfig>(&content) {
                return cfg;
            }

    // ── One-time migration from legacy ~/.wicklee/config.toml (pre-v0.4.37) ──
    // If the system-global path doesn't exist yet but the user's home config
    // does, copy it over so the node_id and fleet pairing are preserved.
    if let Some(legacy) = legacy_config_path()
        && let Ok(content) = std::fs::read_to_string(&legacy)
            && let Ok(cfg) = toml::from_str::<WickleeConfig>(&content) {
                println!("  Migrating config from {} → {}", legacy.display(), path.display());
                save_config(&cfg);
                return cfg;
            }

    // ── First-run: generate a new identity ───────────────────────────────────
    let cfg = WickleeConfig { node_id: generate_node_id(), fleet_url: None, session_token: None, ollama_proxy: None, runtime_ports: None, bind_address: None, deployment_profile: None, probe: None };
    save_config(&cfg);
    cfg
}

pub(crate) fn save_config(cfg: &WickleeConfig) {
    let path = config_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(content) = toml::to_string(cfg) else { return };
    // Atomic write: write a sibling temp file, fsync, then rename over the
    // target. A plain fs::write can truncate config.toml if the agent crashes
    // mid-write, permanently losing the session_token / node identity. Rename
    // is atomic on the same filesystem, so a reader always sees either the old
    // or the new complete file.
    let tmp = path.with_extension("toml.tmp");
    {
        use std::io::Write;
        let Ok(mut f) = std::fs::File::create(&tmp) else { return };
        // 0600 before the rename so the published file is never world-readable.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = f.set_permissions(std::fs::Permissions::from_mode(0o600));
        }
        if f.write_all(content.as_bytes()).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return;
        }
        let _ = f.sync_all();
    }
    if std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Process-global serialization for config read-modify-write sequences.
pub(crate) static CONFIG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Atomically load → mutate → save the config under [`CONFIG_LOCK`].
///
/// The pairing/disconnect handlers each do `load → set a few fields → save`;
/// run concurrently (e.g. a user clicks "generate code" then "disconnect")
/// they could interleave and clobber each other's fields, silently dropping
/// the session token. Funnelling every mutation through here makes the whole
/// sequence atomic. Poison-tolerant: a panic elsewhere shouldn't wedge config
/// saves forever.
pub(crate) fn update_config(mutate: impl FnOnce(&mut WickleeConfig)) {
    let _guard = CONFIG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut cfg = load_or_create_config();
    mutate(&mut cfg);
    save_config(&cfg);
}

#[cfg(test)]
mod probe_config_tests {
    use super::*;

    #[test]
    fn absent_probe_section_defaults_enabled() {
        let cfg: WickleeConfig = toml::from_str(r#"node_id = "WK-1""#).unwrap();
        assert!(cfg.probe.is_none());
        let p = ProbeConfig::policy(cfg.probe.as_ref());
        assert!(p.enabled);
        assert_eq!(p.interval, Duration::from_secs(600));
    }

    #[test]
    fn probe_section_parses_and_clamps() {
        let cfg: WickleeConfig = toml::from_str(
            "node_id = \"WK-1\"\n[probe]\nenabled = false\n",
        ).unwrap();
        let p = ProbeConfig::policy(cfg.probe.as_ref());
        assert!(!p.enabled);
        assert_eq!(p.interval, Duration::from_secs(600));

        let cfg: WickleeConfig = toml::from_str(
            "node_id = \"WK-1\"\n[probe]\ninterval_minutes = 0\n",
        ).unwrap();
        let p = ProbeConfig::policy(cfg.probe.as_ref());
        assert!(p.enabled);
        assert_eq!(p.interval, Duration::from_secs(60));
    }
}

#[cfg(test)]
mod node_id_tests {
    use super::*;

    #[test]
    fn fnv1a_is_deterministic_and_wide() {
        // Same input → same hash (stable node id across restarts/reinstalls).
        let a = fnv1a_64("550e8400-e29b-41d4-a716-446655440000");
        let b = fnv1a_64("550e8400-e29b-41d4-a716-446655440000");
        assert_eq!(a, b);
        // Distinct machine-ids → distinct hashes (no 16-bit folding collisions).
        assert_ne!(fnv1a_64("machine-a"), fnv1a_64("machine-b"));
    }

    #[test]
    fn node_id_suffix_is_64_bit_not_16_bit() {
        // Two machine-ids that collided under the old 16-bit fold must now
        // produce different 16-hex-digit ids.
        let id1 = format!("WK-{:016X}", fnv1a_64("/etc/machine-id:aaaa"));
        let id2 = format!("WK-{:016X}", fnv1a_64("/etc/machine-id:bbbb"));
        assert_ne!(id1, id2);
        assert_eq!(id1.len(), 19); // "WK-" + 16 hex
    }
}
