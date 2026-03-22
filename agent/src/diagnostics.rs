use crate::WickleeConfig;
use crate::process_discovery;
use std::time::Duration;

#[cfg(any(all(target_os = "linux", not(target_env = "musl")), target_os = "windows"))]
use nvml_wrapper::{enum_wrappers::device::TemperatureSensor, Nvml};

// ── Startup Diagnostics ───────────────────────────────────────────────────────
//
// Runs once at boot. Prints a clean bordered summary to stdout showing only
// what is relevant on this platform. Silent absence means N/A — no SKIP lines.

pub(crate) async fn run_startup_diagnostics(node_id: &str, pairing_status: &str, port: u16, cfg_ref: &WickleeConfig) {
    // Format one 48-column box row: ║   KEY     VALUE (padded/truncated to fit)  ║
    let row = |key: &str, val: &str| -> String {
        let inner = format!("   {:<7}{}", key, val);
        let capped = if inner.chars().count() <= 46 {
            format!("{:<46}", inner)
        } else {
            inner.chars().take(43).collect::<String>() + "..."
        };
        format!("║{}║", capped)
    };
    let sep       = "╠══════════════════════════════════════════════╣";
    let top       = "╔══════════════════════════════════════════════╗";
    let bot       = "╚══════════════════════════════════════════════╝";
    let blank_row = "║                                              ║";

    // ── Banner ────────────────────────────────────────────────────────────────
    println!("{top}");
    println!("{blank_row}");
    println!("{}", row("", &format!("Wicklee Sentinel  ·  v{}", env!("CARGO_PKG_VERSION"))));
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
        match tokio::process::Command::new("powermetrics")
            .args(["-n", "1", "-i", "500", "--samplers", "cpu_power"])
            .output().await
        {
            Ok(out) if out.status.success() =>
                platform_rows.push(row("Power", "powermetrics  ✓  (root)")),
            _ =>
                platform_rows.push(row("Power", "powermetrics needs root for cpu_power_w")),
        }
    }

    // Linux: NVML (glibc only) + RAPL CPU power
    #[cfg(target_os = "linux")]
    {
        // NVML — not available in musl builds
        #[cfg(not(target_env = "musl"))]
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
                        if let Ok(mw) = dev.power_usage() {
                            platform_rows.push(row("GPU Pwr", &format!("{:.0}W", mw as f64 / 1000.0)));
                        }
                    }
                }
            }
            Err(_) => {} // no NVIDIA on this machine — silent
        }

        // RAPL CPU power (powercap, no sudo needed)
        {
            let found = crate::RAPL_PATHS.iter().find(|(path, _)| crate::read_rapl_uj(path).is_some());
            if let Some((path, label)) = found {
                if let Some(e1) = crate::read_rapl_uj(path) {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    if let Some(e2) = crate::read_rapl_uj(path) {
                        let power_w = if e2 > e1 { (e2 - e1) as f64 / 500_000.0 } else { 0.0 };
                        platform_rows.push(row("CPU Pwr", &format!("{power_w:.1}W  (RAPL/{label})")));
                    }
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

        // Ollama
        if let Some(&port) = discovered.get("ollama") {
            let model_hint = async {
                let resp = client
                    .get(format!("http://127.0.0.1:{port}/api/ps"))
                    .send().await.ok()?;
                let json: serde_json::Value = resp.json().await.ok()?;
                let name = json["models"].as_array()?.first()?["name"].as_str()?.to_string();
                Some(format!("{} loaded", name))
            }.await.unwrap_or_else(|| "running (no model loaded)".to_string());
            println!("{}", row("Ollama", &format!(":{port} · {model_hint}")));
        } else {
            println!("{}", row("Ollama", "not running"));
        }

        // vLLM — check config override first, then process scan
        let vllm_cfg_port  = cfg_ref.runtime_ports.as_ref().and_then(|r| r.vllm);
        let vllm_auto_port = discovered.get("vllm").copied();
        let vllm_port      = vllm_cfg_port.or(vllm_auto_port);
        let vllm_source    = if vllm_cfg_port.is_some() { " (config)" } else { "" };
        if let Some(port) = vllm_port {
            let up = client
                .get(format!("http://127.0.0.1:{port}/health"))
                .send().await
                .map(|r| r.status().is_success())
                .unwrap_or(false);
            println!("{}", row("vLLM", &format!(":{port}{vllm_source} · {}", if up { "healthy" } else { "starting up" })));
        } else {
            println!("{}", row("vLLM", "not detected  →  set runtime_ports.vllm in config"));
            // On Linux, a cross-user vLLM process (e.g. owned by a service account)
            // can be auto-discovered without any config by granting cap_sys_ptrace.
            // Print the hint so operators know how to enable zero-config detection.
            #[cfg(target_os = "linux")]
            println!("       hint: sudo setcap cap_sys_ptrace+ep $(which wicklee)  # zero-config cross-user detection");
        }
    }

    println!("{bot}");
}
