use crate::WickleeConfig;
use crate::process_discovery;
use std::time::Duration;

#[cfg(any(all(target_os = "linux", not(target_env = "musl")), target_os = "windows"))]
use nvml_wrapper::{enum_wrappers::device::TemperatureSensor, Nvml};

// ── Startup Diagnostics ───────────────────────────────────────────────────────
//
// Runs once at boot. Prints a clean bordered summary to stdout showing only
// what is relevant on this platform. Silent absence means N/A — no SKIP lines.

/// Returns the platform-specific config.toml path for use in diagnostic hints.
fn config_path_hint() -> &'static str {
    #[cfg(target_os = "macos")]
    { "/Library/Application Support/Wicklee/config.toml" }
    #[cfg(target_os = "linux")]
    { "/etc/wicklee/config.toml" }
    #[cfg(target_os = "windows")]
    { "%ProgramData%\\Wicklee\\config.toml" }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    { "config.toml" }
}

pub(crate) async fn run_startup_diagnostics(node_id: &str, pairing_status: &str, port: u16, cfg_ref: &WickleeConfig) {
    // Format one 64-column box row: ║   KEY     VALUE (padded/truncated to fit)  ║
    // v0.8.2: widened from 48 → 64 cols so longer Ollama / vLLM status lines
    // ("running (no model loaded)", "not detected → set runtime_ports.vllm in
    // config") no longer truncate mid-word. Still comfortable in 80-col terms.
    let row = |key: &str, val: &str| -> String {
        let inner = if key.is_empty() { format!("   {val}") } else { format!("   {:<8} {}", key, val) };
        let capped = if inner.chars().count() <= 62 {
            format!("{:<62}", inner)
        } else {
            inner.chars().take(59).collect::<String>() + "..."
        };
        format!("║{}║", capped)
    };
    let sep       = "╠══════════════════════════════════════════════════════════════╣";
    let top       = "╔══════════════════════════════════════════════════════════════╗";
    let bot       = "╚══════════════════════════════════════════════════════════════╝";
    let blank_row = "║                                                              ║";

    // ── Banner ────────────────────────────────────────────────────────────────
    println!("{top}");
    println!("{blank_row}");
    println!("{}", row("", &format!("Wicklee Agent  ·  v{}", env!("CARGO_PKG_VERSION"))));
    println!("{}", row("", &format!("http://localhost:{port}")));
    println!("{blank_row}");
    println!("{sep}");

    // ── Identity ─────────────────────────────────────────────────────────────
    println!("{}", row("Node", node_id));
    println!("{}", row("Pairing", pairing_status));

    // ── Platform rows (only what's relevant on this OS) ───────────────────────
    let mut platform_rows: Vec<String> = Vec::new();

    // macOS: pmset thermal + ioreg GPU util + powermetrics power
    #[cfg(target_os = "macos")]
    {
        // pmset -g therm → CPU thermal throttle state
        if let Ok(out) = tokio::process::Command::new("pmset")
            .args(["-g", "therm"]).output().await
        {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(state) = crate::parse_pmset_therm(&text) {
                platform_rows.push(row("Thermal", &state));
            }
        }

        // ioreg IOAccelerator → GPU utilization
        if let Ok(out) = tokio::process::Command::new("ioreg")
            .args(["-r", "-c", "IOAccelerator"]).output().await
        {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(v) = crate::parse_ioreg_gpu(&text) {
                platform_rows.push(row("GPU", &format!("{v}%  (IOAccelerator)")));
            }
        }

        // powermetrics → CPU power draw (requires root)
        // When --status is run as a non-root user, powermetrics will fail — but
        // the LaunchDaemon runs as root and CAN collect power data. Check the
        // live daemon's metrics endpoint first; only report the problem if both
        // the daemon and local powermetrics are unavailable.
        let daemon_has_power = async {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(2))
                .build().ok()?;
            let resp = client
                .get(format!("http://127.0.0.1:{port}/api/metrics/snapshot"))
                .send().await.ok()?;
            let json: serde_json::Value = resp.json().await.ok()?;
            // apple_soc_power_w is populated only when powermetrics succeeds
            json.get("apple_soc_power_w")
                .and_then(|v| v.as_f64())
                .filter(|&w| w > 0.0)
        }.await;
        if let Some(watts) = daemon_has_power {
            platform_rows.push(row("Power", &format!("{watts:.1}W  (powermetrics via daemon)")));
        } else {
            // Daemon not running or not reporting power — try direct
            match tokio::process::Command::new("powermetrics")
                .args(["-n", "1", "-i", "500", "--samplers", "cpu_power"])
                .output().await
            {
                Ok(out) if out.status.success() =>
                    platform_rows.push(row("Power", "powermetrics  ✓  (root)")),
                _ =>
                    platform_rows.push(row("Power", "run with sudo for power data, or check daemon")),
            }
        }
    }

    // Linux: NVML (glibc only) + RAPL CPU power
    #[cfg(target_os = "linux")]
    {
        // NVML — not available in musl builds
        #[cfg(not(target_env = "musl"))]
        // No NVIDIA on this machine → Err, and we stay silent.
        if let Ok(nvml) = Nvml::init() {
                let count = nvml.device_count().unwrap_or(0);
                if count > 0
                    && let Ok(dev) = nvml.device_by_index(0) {
                        let name = dev.name().unwrap_or_else(|_| "GPU".to_string());
                        let temp = dev.temperature(TemperatureSensor::Gpu)
                            .map(|t| format!("{t}°C"))
                            .unwrap_or_else(|_| "?°C".to_string());
                        let util = dev.utilization_rates()
                            .map(|u| format!("{}%", u.gpu))
                            .unwrap_or_else(|_| "?%".to_string());
                        platform_rows.push(row("GPU", &format!("{name}  {temp}  {util}")));
                        if let Ok(mem) = dev.memory_info() {
                            let used  = mem.used  as f64 / 1_073_741_824.0;
                            let total = mem.total as f64 / 1_073_741_824.0;
                            platform_rows.push(row("VRAM", &format!("{used:.1} / {total:.1} GB")));
                        }
                        if let Ok(mw) = dev.power_usage() {
                            platform_rows.push(row("GPU Pwr", &format!("{:.0}W", mw as f64 / 1000.0)));
                        }
                    }
        }

        // RAPL CPU power (powercap, no sudo needed)
        {
            let found = crate::RAPL_PATHS.iter().find(|(path, _)| crate::read_rapl_uj(path).is_some());
            if let Some((path, label)) = found
                && let Some(e1) = crate::read_rapl_uj(path) {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    if let Some(e2) = crate::read_rapl_uj(path) {
                        let power_w = if e2 > e1 { (e2 - e1) as f64 / 500_000.0 } else { 0.0 };
                        platform_rows.push(row("CPU Pwr", &format!("{power_w:.1}W  (RAPL/{label})")));
                    }
                }
        }
    }

    // Windows: NVML GPU
    #[cfg(target_os = "windows")]
    match Nvml::init() {
        Ok(nvml) => {
            let count = nvml.device_count().unwrap_or(0);
            if count > 0 {
                if let Ok(dev) = nvml.device_by_index(0) {
                    let name = dev.name().unwrap_or_else(|_| "GPU".to_string());
                    let temp = dev.temperature(TemperatureSensor::Gpu)
                        .map(|t| format!("{t}°C"))
                        .unwrap_or_else(|_| "?°C".to_string());
                    let util = dev.utilization_rates()
                        .map(|u| format!("{}%", u.gpu))
                        .unwrap_or_else(|_| "?%".to_string());
                    platform_rows.push(row("GPU", &format!("{name}  {temp}  {util}")));
                    if let Ok(mem) = dev.memory_info() {
                        let used  = mem.used  as f64 / 1_073_741_824.0;
                        let total = mem.total as f64 / 1_073_741_824.0;
                        platform_rows.push(row("VRAM", &format!("{used:.1} / {total:.1} GB")));
                    }
                }
            }
        }
        Err(_) => {}
    }

    if !platform_rows.is_empty() {
        println!("{sep}");
        for r in &platform_rows {
            println!("{r}");
        }
    }

    // ── Runtime (all platforms) ───────────────────────────────────────────────
    println!("{sep}");

    // ── Inference runtime detection (process-first, port-agnostic) ──────────
    {
        let discovered = process_discovery::scan_runtimes();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap_or_default();

        // Ollama — resolved by the shared resolver, so this box reports the
        // port the harvester will actually use. It used to read config.toml
        // and the process scan only, which meant an agent started with
        // WICKLEE_OLLAMA_PORT printed ":11434 (auto)" while being pointed
        // somewhere else entirely.
        let ollama_res = process_discovery::resolve_port(
            cfg_ref.runtime_ports.as_ref().and_then(|r| r.ollama),
            process_discovery::env_port("ollama"),
            discovered.get("ollama").copied(),
        );
        let ollama_port   = ollama_res.map(|(p, _)| p);
        let ollama_source = ollama_res.map(|(_, src)| src.label()).unwrap_or("auto");
        let ollama_pinned = ollama_res.is_some_and(|(_, src)| src.is_pinned());
        if let Some(port) = ollama_port {
            // Two separate questions, because one `?` chain conflated them:
            // did /api/ps answer, and did it list a model. An idle Ollama
            // answers with an empty list, which used to read as "the API did
            // not answer" and fired the Port Doctor warning at a perfectly
            // healthy runtime — while a dead port printed "running (no model
            // loaded)". A failed read is not an empty result.
            let ps: Option<serde_json::Value> = async {
                let resp = client
                    .get(format!("http://127.0.0.1:{port}/api/ps"))
                    .send().await.ok()?;
                resp.json().await.ok()
            }.await;

            let api_ok = ps.is_some();
            let hint = match &ps {
                None => "not responding".to_string(),
                Some(json) => match json["models"]
                    .as_array()
                    .and_then(|a| a.first())
                    .and_then(|m| m["name"].as_str())
                {
                    Some(name) => format!("{name} loaded"),
                    None => "running (no model loaded)".to_string(),
                },
            };
            println!("{}", row("Ollama", &format!(":{port} ({ollama_source}) · {hint}")));

            // Port Doctor: API did not answer on a non-default discovered
            // port = probably a worker socket, and the harvester will fall
            // back. A pinned port gets the opposite advice, because the
            // harvester will not move off it.
            if !api_ok && port != 11434 && !ollama_pinned {
                println!("  ⚠️  Ollama process found on :{port} but the API did not answer.");
                println!("     This is likely an internal worker socket, not the API.");
                println!("     The agent will auto-fallback to :11434 at runtime.");
            } else if !api_ok && ollama_pinned {
                println!("  ⚠️  Ollama API did not answer on :{port}, which was set explicitly.");
                println!("     The agent will keep retrying that port and will not fall back,");
                println!("     so nothing is harvested until something answers there.");
            }
        } else {
            println!("{}", row("Ollama", "not running"));
        }

        // vLLM — check config override first, then process scan.
        // Port Doctor: when auto-discovered on the default port (:8000) and the API
        // doesn't respond, warn the user — they likely need a config override.
        let vllm_res = process_discovery::resolve_port(
            cfg_ref.runtime_ports.as_ref().and_then(|r| r.vllm),
            process_discovery::env_port("vllm"),
            discovered.get("vllm").copied(),
        );
        let vllm_port   = vllm_res.map(|(p, _)| p);
        let vllm_source = vllm_res.map(|(_, src)| src.label()).unwrap_or("auto");
        if let Some(port) = vllm_port {
            let up = client
                .get(format!("http://127.0.0.1:{port}/health"))
                .send().await
                .map(|r| r.status().is_success())
                .unwrap_or(false);
            let status_str = if up { "healthy" } else { "starting up" };
            println!("{}", row("vLLM", &format!(":{port} ({vllm_source}) · {status_str}")));

            // Port Doctor: default port + API not responding = likely wrong port
            if !up && !vllm_res.is_some_and(|(_, src)| src.is_pinned()) && port == 8000 {
                println!("  ⚠️  vLLM detected but API not responding on :8000.");
                println!("     If vLLM uses a non-default port, add to config:");
                let cfg_path = config_path_hint();
                println!("     {cfg_path}");
                println!("       [runtime_ports]");
                println!("       vllm = 18010");
            }
        } else {
            println!("{}", row("vLLM", "not detected  →  set runtime_ports.vllm in config"));
            #[cfg(target_os = "linux")]
            println!("       hint: sudo setcap cap_sys_ptrace+ep $(which wicklee)  # zero-config cross-user detection");
        }

        // Ollama Port Doctor: same check for Ollama on default port
        // (already handled above via the health check in the port validation harvester)
    }

    println!("{bot}");
}
