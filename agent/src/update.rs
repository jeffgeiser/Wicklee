//! Self-update: version check, release asset URLs, SHA256SUMS verification, binary replace + restart.
//! Split out of main.rs; items are pub(crate) and re-exported at the crate root.

use super::*;

/// Response shape of GET https://wicklee.dev/api/agent/version.
/// `download_url` is deliberately ignored: the agent builds the URL itself
/// from the tag (see `update_asset_urls`), so the version endpoint can only
/// choose WHICH published release, never where the binary comes from.
#[derive(Deserialize)]
pub(crate) struct AgentVersionResponse {
    pub(crate) latest: String,
}

/// Where release binaries are published. Auto-update downloads only from here.
pub(crate) const UPDATE_RELEASE_BASE: &str = "https://github.com/jeffgeiser/Wicklee/releases/download";

/// Release asset name for this build's platform (mirrors the cloud's map).
pub(crate) fn update_asset_name(platform: &str) -> Option<&'static str> {
    match platform {
        "darwin-aarch64"      => Some("wicklee-agent-darwin-aarch64"),
        "linux-x86_64"        => Some("wicklee-agent-linux-x86_64"),
        "linux-aarch64"       => Some("wicklee-agent-linux-aarch64"),
        "linux-x86_64-nvidia" => Some("wicklee-agent-linux-x86_64-nvidia"),
        "windows-x86_64"      => Some("wicklee-agent-windows-x86_64.exe"),
        _ => None,
    }
}

/// (binary URL, SHA256SUMS URL) for a release tag. The tag must be a plain
/// `vX.Y.Z` so it can't smuggle path segments into the URL.
pub(crate) fn update_asset_urls(tag: &str, asset: &str) -> Option<(String, String)> {
    let v = tag.strip_prefix('v')?;
    let parts: Vec<&str> = v.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|p| p.is_empty() || !p.chars().all(|c| c.is_ascii_digit())) {
        return None;
    }
    Some((
        format!("{UPDATE_RELEASE_BASE}/{tag}/{asset}"),
        format!("{UPDATE_RELEASE_BASE}/{tag}/SHA256SUMS"),
    ))
}

/// Expected hex digest for `asset` from `sha256sum` output (`<hex>  <name>`,
/// or `<hex> *<name>` in binary mode).
pub(crate) fn expected_sha256(sums: &str, asset: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let mut it = line.split_whitespace();
        let hash = it.next()?;
        let name = it.next()?.trim_start_matches('*');
        (name == asset && hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()))
            .then(|| hash.to_ascii_lowercase())
    })
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

// ── Self-Update ───────────────────────────────────────────────────────────────

/// Returns a static platform string that matches the GitHub release asset names,
/// e.g. "darwin-aarch64" → "wicklee-agent-darwin-aarch64".
// The fallback "unknown" literal is unreachable on every supported platform —
// suppress the warning rather than clutter with complex cfg(not(any(…))) guards.
#[allow(unreachable_code)]
pub(crate) fn agent_platform() -> &'static str {
    #[cfg(all(target_os = "macos",   target_arch = "aarch64"))]              { return "darwin-aarch64";      }
    // Linux x86_64 has two release binaries: the glibc/NVML build (no `no_nvml`
    // cfg) and the musl/static build (compiled with `RUSTFLAGS='--cfg no_nvml'`).
    // They must pull their own binary on auto-update — swapping them loses GPU metrics.
    #[cfg(all(target_os = "linux",   target_arch = "x86_64", not(no_nvml)))] { return "linux-x86_64-nvidia"; }
    #[cfg(all(target_os = "linux",   target_arch = "x86_64", no_nvml))]      { return "linux-x86_64";        }
    #[cfg(all(target_os = "linux",   target_arch = "aarch64"))]              { return "linux-aarch64";       }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]              { return "windows-x86_64";      }
    "unknown"
}

/// Returns true when `remote` is strictly newer than `current` (simple X.Y.Z
/// comparison — no pre-release handling needed for agent auto-updates).
pub(crate) fn is_newer_version(current: &str, remote: &str) -> bool {
    let parse = |v: &str| -> [u64; 3] {
        let s = v.trim_start_matches('v');
        let mut it = s.split('.').filter_map(|p| p.parse::<u64>().ok());
        [it.next().unwrap_or(0), it.next().unwrap_or(0), it.next().unwrap_or(0)]
    };
    parse(remote) > parse(current)
}

/// Checks https://wicklee.dev/api/agent/version, downloads the new binary when
/// a newer version is available, atomically replaces the current executable via
/// `self_replace::self_replace`, emits a Live Activity event, and restarts.
///
/// All error paths log to stderr and return without panicking — startup must
/// never be blocked or aborted due to a failed update check.
///
/// **Sovereign Mode gate**: if the agent is unpaired (no cloud_session_token),
/// the check is skipped entirely to honour the operator's no-outbound-traffic choice.
pub(crate) async fn check_and_apply_update(
    pairing_state:     Arc<Mutex<PairingState>>,
    live_events:       Arc<Mutex<Vec<LiveActivityEvent>>>,
    recent_events_log: Arc<Mutex<std::collections::VecDeque<LiveActivityEvent>>>,
) {
    // ── Sovereign Mode gate ────────────────────────────────────────────────────
    {
        let state = pairing_state.lock().unwrap();
        if state.cloud_session_token.is_none() {
            eprintln!("[update] sovereign mode — skipping update check (no fleet pairing)");
            return;
        }
    }

    let platform = agent_platform();
    if platform == "unknown" {
        eprintln!("[update] unrecognised platform — skipping update check");
        return;
    }

    let current = env!("CARGO_PKG_VERSION");
    eprintln!("[update] checking for update  current=v{current}  platform={platform}");

    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(10))
        .https_only(true)
        .user_agent(format!("wicklee-agent/{current}"))
        .build()
    {
        Ok(c)  => c,
        Err(e) => { eprintln!("[update] client build failed: {e}"); return; }
    };

    // ── Version check ──────────────────────────────────────────────────────────
    let url = format!("https://wicklee.dev/api/agent/version?platform={platform}");
    let resp = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r,
        Ok(r)  => { eprintln!("[update] version endpoint returned {}", r.status()); return; }
        Err(e) => { eprintln!("[update] version check failed: {e}"); return; }
    };

    let info: AgentVersionResponse = match resp.json::<AgentVersionResponse>().await {
        Ok(v)  => v,
        Err(e) => { eprintln!("[update] failed to parse version response: {e}"); return; }
    };

    if !is_newer_version(current, &info.latest) {
        eprintln!("[update] already up to date (v{current})");
        return;
    }

    let new_version = info.latest.trim_start_matches('v').to_string();
    let Some(asset) = update_asset_name(platform) else {
        eprintln!("[update] no release asset for platform {platform} — skipping");
        return;
    };
    let Some((binary_url, sums_url)) = update_asset_urls(&format!("v{new_version}"), asset) else {
        eprintln!("[update] refusing malformed release tag {:?}", info.latest);
        return;
    };
    eprintln!("[update] update available: v{current} → v{new_version}  downloading...");

    // ── Expected checksum (fail closed) ────────────────────────────────────────
    // The release's SHA256SUMS must list this asset; a release without one is
    // not installed. Protects against a truncated/corrupted/substituted download.
    let expected = match client.get(&sums_url).send().await {
        Ok(r) if r.status().is_success() => match r.text().await {
            Ok(t) => expected_sha256(&t, asset),
            Err(_) => None,
        },
        _ => None,
    };
    let Some(expected) = expected else {
        eprintln!("[update] no SHA256SUMS entry for {asset} in v{new_version} — not updating");
        return;
    };

    // ── Download binary ────────────────────────────────────────────────────────
    let download_resp = match client.get(&binary_url).send().await {
        Ok(r) if r.status().is_success() => r,
        Ok(r)  => { eprintln!("[update] download returned {}", r.status()); return; }
        Err(e) => { eprintln!("[update] download request failed: {e}"); return; }
    };

    let bytes = match download_resp.bytes().await {
        Ok(b) if !b.is_empty() => b,
        Ok(_)  => { eprintln!("[update] download completed with zero bytes — aborting"); return; }
        Err(e) => { eprintln!("[update] failed to read download body: {e}"); return; }
    };
    let actual = sha256_hex(&bytes);
    if actual != expected {
        eprintln!("[update] checksum mismatch for {asset}: expected {expected}, got {actual} — not updating");
        return;
    }

    // Write to a sibling temp file so rename stays on the same filesystem.
    let current_exe = match std::env::current_exe() {
        Ok(p)  => p,
        Err(e) => { eprintln!("[update] could not resolve current exe: {e}"); return; }
    };
    let tmp_path = current_exe.with_extension("update_tmp");

    if let Err(e) = std::fs::write(&tmp_path, &bytes) {
        eprintln!("[update] failed to write temp binary: {e}");
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            eprintln!("[update] binary is root-owned — re-run install to fix:");
            eprintln!("[update]   sudo curl -fsSL https://wicklee.dev/install.sh | bash");
        }
        return;
    }

    // chmod +x on Unix (Windows exe bits are not a thing).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match std::fs::metadata(&tmp_path) {
            Ok(m) => {
                let mut perms = m.permissions();
                perms.set_mode(0o755);
                if let Err(e) = std::fs::set_permissions(&tmp_path, perms) {
                    eprintln!("[update] chmod failed: {e}");
                    let _ = std::fs::remove_file(&tmp_path);
                    return;
                }
            }
            Err(e) => {
                eprintln!("[update] metadata read failed: {e}");
                let _ = std::fs::remove_file(&tmp_path);
                return;
            }
        }
    }

    // ── Atomic binary replacement via self-replace ─────────────────────────────
    if let Err(e) = self_replace::self_replace(&tmp_path) {
        eprintln!("[update] binary replacement failed: {e}");
        let _ = std::fs::remove_file(&tmp_path);
        return;
    }
    // temp file is now the old binary — clean it up on best-effort basis.
    let _ = std::fs::remove_file(&tmp_path);

    let msg = format!("Wicklee agent updated v{current} → v{new_version}");
    eprintln!("[update] {msg}  restarting...");

    // ── Emit Live Activity event ───────────────────────────────────────────────
    // Push before restarting so the broadcaster picks it up in the next tick.
    // Also push to recent_events_log so late-joining browsers see the update event.
    {
        let event = LiveActivityEvent {
            message:      msg.clone(),
            timestamp_ms: now_ms(),
            level:        "info",
            event_type:   Some("update"),
        };
        // Manual push here (not push_event) — the process restarts immediately
        // after, so there is no store handle to persist to.  The event reaches
        // connected browsers via the next broadcast tick before exit.
        live_events.lock().unwrap().push(event.clone());
        let mut log = recent_events_log.lock().unwrap();
        log.push_back(event);
        if log.len() > 20 { log.pop_front(); }
    }

    // Give the broadcaster one full tick to drain the event to all WebSocket clients.
    tokio::time::sleep(Duration::from_millis(200)).await;

    // ── Restart ────────────────────────────────────────────────────────────────
    let args: Vec<String> = std::env::args().skip(1).collect();
    match std::process::Command::new(&current_exe).args(&args).spawn() {
        Ok(_)  => std::process::exit(0),
        Err(e) => eprintln!("[update] restart failed — continuing on new binary: {e}"),
    }
}

#[cfg(test)]
mod update_integrity_tests {
    use super::*;

    #[test]
    fn asset_urls_are_pinned_to_github_and_reject_odd_tags() {
        let (bin, sums) = update_asset_urls("v0.7.3", "wicklee-agent-linux-x86_64").unwrap();
        assert_eq!(bin, "https://github.com/jeffgeiser/Wicklee/releases/download/v0.7.3/wicklee-agent-linux-x86_64");
        assert_eq!(sums, "https://github.com/jeffgeiser/Wicklee/releases/download/v0.7.3/SHA256SUMS");
        for bad in ["0.7.3", "v0.7", "v0.7.3.1", "v0.7.x", "v0.7.3/../../evil", "v..", "nightly"] {
            assert!(update_asset_urls(bad, "a").is_none(), "{bad} should be rejected");
        }
    }

    #[test]
    fn expected_sha256_parses_sha256sum_output() {
        let h = "a".repeat(64);
        let sums = format!("{h}  wicklee-agent-linux-x86_64\n{}  wicklee-agent-linux-aarch64\n", "b".repeat(64));
        assert_eq!(expected_sha256(&sums, "wicklee-agent-linux-x86_64"), Some(h.clone()));
        assert_eq!(expected_sha256(&format!("{h} *win.exe"), "win.exe"), Some(h.clone()));
        // Exact name match only; malformed digests are ignored.
        assert_eq!(expected_sha256(&sums, "wicklee-agent-linux-x86_64-nvidia"), None);
        assert_eq!(expected_sha256("xyz  wicklee-agent-linux-x86_64", "wicklee-agent-linux-x86_64"), None);
        assert_eq!(expected_sha256("", "a"), None);
    }

    #[test]
    fn sha256_hex_matches_known_vector() {
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn every_platform_has_an_asset() {
        for p in ["darwin-aarch64", "linux-x86_64", "linux-aarch64", "linux-x86_64-nvidia", "windows-x86_64"] {
            assert!(update_asset_name(p).is_some(), "{p}");
        }
        assert!(update_asset_name("unknown").is_none());
    }
}
