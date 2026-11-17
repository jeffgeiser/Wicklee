
/// C3 — Validates that a binary path is safe to embed in service descriptors.
///
/// launchd plists, systemd unit files, and Windows sc.exe descriptors are text
/// formats that the respective service managers parse with their own rules.
/// Embedding a path with shell metacharacters, XML-significant characters, or
/// newlines can silently corrupt the descriptor or enable local privilege
/// escalation when the service manager reloads it.
///
/// **Allowed (POSIX):** `[a-zA-Z0-9/_.-]` only.  Covers every normal Unix
/// install path (`/usr/local/bin/wicklee`, `/opt/wicklee/bin/wicklee`, etc.).
///
/// **Allowed (Windows):** drive letter + `:` + `[\\/a-zA-Z0-9_.- ]` only.
/// Spaces are common in Windows paths (`C:\Program Files\…`); they are handled
/// by quoting at the call site rather than here.
///
/// The check rejects `.` components and path traversal (`..`) unconditionally
/// regardless of platform, and enforces a sensible maximum path length.
///
/// If validation fails, `install_service` prints a clear human-readable error
/// and aborts rather than writing a potentially broken service descriptor.
#[cfg(not(target_os = "windows"))]
fn validate_binary_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 4096 {
        return Err(format!(
            "binary path length {} is out of range (1–4096 bytes)", path.len()
        ));
    }
    if !path.starts_with('/') {
        return Err("binary path must be absolute (must start with '/')".to_string());
    }
    if path.split('/').any(|component| component == "..") {
        return Err("binary path must not contain path traversal ('..') components".to_string());
    }
    for (i, b) in path.bytes().enumerate() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9'
            | b'/' | b'_' | b'.' | b'-' => {}
            _ => return Err(format!(
                "binary path contains unsafe byte 0x{b:02X} at index {i} — \
                 only [a-zA-Z0-9/_.-] are permitted in service paths; \
                 move the binary to a simpler path and re-run --install-service"
            )),
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn validate_binary_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 4096 {
        return Err(format!(
            "binary path length {} is out of range (1–4096 bytes)", path.len()
        ));
    }
    let bytes = path.as_bytes();
    if bytes.len() < 3
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || (bytes[2] != b'\\' && bytes[2] != b'/')
    {
        return Err(
            "Windows binary path must be absolute — expected format: C:\\...\\wicklee.exe"
                .to_string(),
        );
    }
    for component in path.split(['\\', '/']) {
        if component == ".." {
            return Err("binary path must not contain path traversal ('..') components".to_string());
        }
    }
    for (i, b) in bytes.iter().enumerate().skip(3) {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9'
            | b'\\' | b'/' | b'_' | b'.' | b'-' | b' ' => {}
            _ => return Err(format!(
                "binary path contains unsafe byte 0x{b:02X} at index {i} — \
                 only [a-zA-Z0-9\\\\/._- ] are permitted in Windows service paths"
            )),
        }
    }
    Ok(())
}

pub(crate) async fn install_service() {
    let current_exe = match std::env::current_exe() {
        Ok(p)  => p,
        Err(e) => { eprintln!("error: cannot determine executable path: {e}"); return; }
    };

    const CANONICAL_BIN: &str = "/usr/local/bin/wicklee";
    let needs_promote = current_exe.to_string_lossy() != CANONICAL_BIN;
    if needs_promote {
        #[cfg(target_os = "linux")]
        {
            let _ = tokio::process::Command::new("systemctl")
                .args(["stop", "wicklee"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status().await;
        }

        #[cfg(unix)]
        {
            let self_pid = std::process::id();
            let out = tokio::process::Command::new("lsof")
                .args(["-ti", "tcp:7700"])
                .output().await;
            if let Ok(o) = out {
                let pids: Vec<u32> = String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .filter_map(|l| l.trim().parse::<u32>().ok())
                    .filter(|p| *p != self_pid)
                    .collect();
                if !pids.is_empty() {
                    eprintln!("[install] stopping {} foreground process(es) holding :7700", pids.len());
                    for pid in &pids {
                        let _ = tokio::process::Command::new("kill")
                            .args(["-TERM", &pid.to_string()])
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null())
                            .status().await;
                    }
                    for _ in 0..6 {
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        let still = tokio::process::Command::new("lsof")
                            .args(["-ti", "tcp:7700"])
                            .output().await
                            .ok()
                            .map(|o| String::from_utf8_lossy(&o.stdout)
                                .lines()
                                .filter_map(|l| l.trim().parse::<u32>().ok())
                                .any(|p| p != self_pid))
                            .unwrap_or(false);
                        if !still { break; }
                    }
                    for pid in &pids {
                        let _ = tokio::process::Command::new("kill")
                            .args(["-KILL", &pid.to_string()])
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null())
                            .status().await;
                    }
                }
            }
        }
        let copy_status = tokio::process::Command::new("cp")
            .arg(&current_exe)
            .arg(CANONICAL_BIN)
            .status().await;
        match copy_status {
            Ok(s) if s.success() => {
                eprintln!("[install] promoted binary: {} → {CANONICAL_BIN}", current_exe.display());
                let _ = tokio::process::Command::new("chmod")
                    .args(["755", CANONICAL_BIN])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status().await;
            }
            Ok(s) => {
                eprintln!("error: cannot copy binary to {CANONICAL_BIN} (status: {s})");
                eprintln!("       Are you running with sudo? Service install needs root to");
                eprintln!("       write /usr/local/bin and register the systemd/launchd unit.");
                return;
            }
            Err(e) => {
                eprintln!("error: cp to {CANONICAL_BIN} failed: {e}");
                return;
            }
        }
    }

    let exe_str = CANONICAL_BIN.to_string();

    if let Err(msg) = validate_binary_path(&exe_str) {
        eprintln!("error: cannot install service — unsafe binary path: {msg}");
        eprintln!("       Move the wicklee binary to a path using only [a-zA-Z0-9/_.-]");
        eprintln!("       (e.g. /usr/local/bin/wicklee) and re-run --install-service.");
        return;
    }

    #[cfg(target_os = "macos")]
    {
        let plist = format!(
"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\"\n\
  \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\">\n\
<dict>\n\
    <key>Label</key>\n\
    <string>dev.wicklee.agent</string>\n\
    <key>ProgramArguments</key>\n\
    <array>\n\
        <string>{exe_str}</string>\n\
    </array>\n\
    <key>RunAtLoad</key>\n\
    <true/>\n\
    <key>KeepAlive</key>\n\
    <true/>\n\
    <key>StandardOutPath</key>\n\
    <string>/var/log/wicklee.log</string>\n\
    <key>StandardErrorPath</key>\n\
    <string>/var/log/wicklee.log</string>\n\
</dict>\n\
</plist>\n"
        );
        #[cfg(target_os = "macos")]
        if let Ok(users_dir) = std::fs::read_dir("/Users") {
            for entry in users_dir.flatten() {
                let old_plist = entry.path()
                    .join("Library/LaunchAgents/dev.wicklee.agent.plist");
                if old_plist.exists() {
                    eprintln!("[install] migrating LaunchAgent → LaunchDaemon for {}",
                        entry.path().display());
                    #[cfg(unix)]
                    let uid_val: u32 = {
                        use std::os::unix::fs::MetadataExt;
                        std::fs::metadata(entry.path()).map(|m| m.uid()).unwrap_or(501)
                    };
                    let _ = tokio::process::Command::new("launchctl")
                        .args(["bootout", &format!("gui/{uid_val}/dev.wicklee.agent")])
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status().await;
                    let _ = std::fs::remove_file(&old_plist);
                    eprintln!("[install] removed old LaunchAgent plist");
                }
            }
        }

        let plist_path = "/Library/LaunchDaemons/dev.wicklee.agent.plist";
        if let Err(e) = std::fs::write(plist_path, plist) {
            eprintln!("error: cannot write {plist_path}: {e}");
            eprintln!("       Run with sudo: sudo wicklee --install-service");
            return;
        }
        let _ = tokio::process::Command::new("chown")
            .args(["root:wheel", plist_path])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status().await;
        let _ = tokio::process::Command::new("chmod")
            .args(["644", plist_path])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status().await;
        let _ = tokio::process::Command::new("chown")
            .args(["-R", "root:wheel", "/Library/Application Support/Wicklee"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status().await;
        let label_loaded = tokio::process::Command::new("launchctl")
            .args(["list", "dev.wicklee.agent"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status().await
            .map(|s| s.success())
            .unwrap_or(false);

        if label_loaded {
            let _ = tokio::process::Command::new("launchctl")
                .args(["bootout", "system/dev.wicklee.agent"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status().await;

            let poll_start = std::time::Instant::now();
            let poll_timeout = std::time::Duration::from_secs(10);
            loop {
                let still_loaded = tokio::process::Command::new("launchctl")
                    .args(["list", "dev.wicklee.agent"])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status().await
                    .map(|s| s.success())
                    .unwrap_or(false);
                if !still_loaded { break; }
                if poll_start.elapsed() >= poll_timeout {
                    eprintln!("warning: launchd label still registered after 10s — proceeding with bootstrap");
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        }

        let mut bootstrap_ok = false;
        for attempt in 0..5u32 {
            let status = tokio::process::Command::new("launchctl")
                .args(["bootstrap", "system", plist_path])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status().await;
            match status {
                Ok(s) if s.success() => { bootstrap_ok = true; break; }
                Ok(_) if attempt < 4 => {
                    eprintln!("  launchctl bootstrap attempt {} failed, retrying…", attempt + 1);
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                }
                Ok(s) => {
                    eprintln!("error: launchctl bootstrap failed after 5 attempts (last status: {s})");
                    eprintln!("       The service plist is installed — try manually:");
                    eprintln!("       sudo launchctl bootstrap system {plist_path}");
                }
                Err(e) => { eprintln!("error: launchctl: {e}"); break; }
            }
        }
        if bootstrap_ok {
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            let running = tokio::process::Command::new("launchctl")
                .args(["list", "dev.wicklee.agent"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status().await
                .map(|s| s.success())
                .unwrap_or(false);
            println!("✓ Wicklee installed as a launchd service.");
            println!("  Starts automatically on boot (runs as root).");
            println!("  Plist: {plist_path}");
            println!("  Logs:  /var/log/wicklee.log");
            println!("  To remove: sudo wicklee --uninstall-service");
            if !running {
                eprintln!("warning: service registered but not yet visible in launchctl list.");
                eprintln!("         If http://localhost:7700 is unreachable, run:");
                eprintln!("         sudo launchctl bootstrap system {plist_path}");
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let svc_user = std::env::var("SUDO_USER")
            .unwrap_or_else(|_| {
                std::env::var("USER").unwrap_or_else(|_| "root".to_string())
            });
        let svc_home = if svc_user == "root" {
            "/root".to_string()
        } else {
            format!("/home/{svc_user}")
        };

        let unit = format!(
"[Unit]\n\
Description=Wicklee Agent\n\
After=network.target\n\
\n\
[Service]\n\
Type=simple\n\
User={svc_user}\n\
Environment=HOME={svc_home}\n\
ExecStart={exe_str}\n\
Restart=always\n\
RestartSec=5\n\
\n\
[Install]\n\
WantedBy=multi-user.target\n"
        );
        let unit_path = "/etc/systemd/system/wicklee.service";
        if let Err(e) = std::fs::write(unit_path, unit) {
            eprintln!("error: cannot write {unit_path}: {e}");
            eprintln!("       Run with sudo: sudo wicklee --install-service");
            return;
        }
        let _ = tokio::process::Command::new("systemctl")
            .args(["daemon-reload"])
            .status().await;
        let _ = tokio::process::Command::new("systemctl")
            .args(["enable", "wicklee"])
            .status().await;
        if svc_user != "root" {
            let owner_arg = format!("{}:{}", svc_user, svc_user);
            let _ = tokio::process::Command::new("chown")
                .args([&owner_arg, &exe_str])
                .status().await;
        }
        let status = tokio::process::Command::new("systemctl")
            .args(["restart", "wicklee"])
            .status().await;
        match status {
            Ok(s) if s.success() => {
                println!("✓ Wicklee installed as a systemd service.");
                println!("  Starts now and automatically on every boot.");
                println!("  Unit: {unit_path}");
                println!("  To remove: sudo wicklee --uninstall-service");
            }
            Ok(s) => eprintln!("error: systemctl restart exited with status {s}"),
            Err(e) => eprintln!("error: systemctl: {e}"),
        }
    }

    #[cfg(target_os = "windows")]
    {
        let status = tokio::process::Command::new("sc")
            .args(["create", "WickleeSentinel",
                   "binPath=", &exe_str,
                   "start=", "auto",
                   "DisplayName=", "Wicklee Agent"])
            .status().await;
        match status {
            Ok(s) if s.success() => {}
            Ok(s) => {
                eprintln!("error: sc create exited with status {s}");
                eprintln!("       Run from an elevated (Administrator) prompt.");
                return;
            }
            Err(e) => { eprintln!("error: sc: {e}"); return; }
        }
        let _ = tokio::process::Command::new("sc")
            .args(["description", "WickleeSentinel", "Wicklee Agent"])
            .status().await;
        let start = tokio::process::Command::new("sc")
            .args(["start", "WickleeSentinel"])
            .status().await;
        match start {
            Ok(s) if s.success() => {
                println!("+ Wicklee installed and started as a Windows service.");
                println!("  To remove: wicklee --uninstall-service  (run as Administrator)");
            }
            Ok(s) => eprintln!("warning: sc start exited with status {s} — service registered but not started"),
            Err(e) => eprintln!("error: sc start: {e}"),
        }
    }
}

pub(crate) async fn uninstall_service() {
    #[cfg(target_os = "macos")]
    {
        let plist_path = "/Library/LaunchDaemons/dev.wicklee.agent.plist";
        if !std::path::Path::new(plist_path).exists() {
            eprintln!("Service not installed (plist not found: {plist_path}).");
            return;
        }
        let _ = tokio::process::Command::new("launchctl")
            .args(["bootout", "system/dev.wicklee.agent"])
            .status().await;
        if let Err(e) = std::fs::remove_file(plist_path) {
            eprintln!("error: cannot remove {plist_path}: {e}");
            eprintln!("       Run with sudo: sudo wicklee --uninstall-service");
            return;
        }
        println!("✓ Wicklee Sentinel service removed.");
    }

    #[cfg(target_os = "linux")]
    {
        let unit_path = "/etc/systemd/system/wicklee.service";
        if !std::path::Path::new(unit_path).exists() {
            eprintln!("Service not installed (unit not found: {unit_path}).");
            return;
        }
        let _ = tokio::process::Command::new("systemctl")
            .args(["stop", "wicklee"])
            .status().await;
        let _ = tokio::process::Command::new("systemctl")
            .args(["disable", "wicklee"])
            .status().await;
        if let Err(e) = std::fs::remove_file(unit_path) {
            eprintln!("error: cannot remove {unit_path}: {e}");
            eprintln!("       Run with sudo: sudo wicklee --uninstall-service");
            return;
        }
        let _ = tokio::process::Command::new("systemctl")
            .args(["daemon-reload"])
            .status().await;
        println!("✓ Wicklee Sentinel service removed.");
    }

    #[cfg(target_os = "windows")]
    {
        let _ = tokio::process::Command::new("sc")
            .args(["stop", "WickleeSentinel"])
            .status().await;
        let del = tokio::process::Command::new("sc")
            .args(["delete", "WickleeSentinel"])
            .status().await;
        match del {
            Ok(s) if s.success() => println!("+ Wicklee Sentinel service removed."),
            Ok(s) => eprintln!("error: sc delete exited with status {s}\n       Run from an elevated (Administrator) prompt."),
            Err(e) => eprintln!("error: sc: {e}"),
        }
    }
}
