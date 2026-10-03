//! Platform hardware probes: macOS/Windows/Linux thermal, chip names, RAPL, swap, memory pressure, powermetrics, port eviction.
//! Split out of main.rs; items are pub(crate) and re-exported at the crate root.

use super::*;

// ── Hardware Helpers ──────────────────────────────────────────────────────────

/// Thermal via sysctl — Intel-only key; returns None on Apple Silicon.
#[cfg(target_os = "macos")]
pub(crate) fn read_thermal_sysctl() -> Option<String> {
    use sysctl::Sysctl;
    let ctl = sysctl::Ctl::new("machdep.xcpm.cpu_thermal_level").ok()?;
    let val: i32 = ctl.value_string().ok()?.trim().parse().ok()?;
    Some(match val {
        0 => "Normal",
        1 => "Elevated",
        2 => "High",
        _ => "Critical",
    }.to_string())
}

/// Windows thermal via WMI — queries MSAcpi_ThermalZoneTemperature.
/// Temperature is in tenths of Kelvin; convert to Celsius for state mapping.
/// Annotated as "estimated" in UI (thermal_source: "wmi").
///
/// Blocking (spawns wmic) — call via `spawn_blocking`.
#[cfg(target_os = "windows")]
pub(crate) fn read_thermal_wmi() -> Option<String> {
    // Use wmic to query thermal zone temperature.
    let output = std::process::Command::new("wmic")
        .args([
            "/namespace:\\\\root\\wmi",
            "path", "MSAcpi_ThermalZoneTemperature",
            "get", "CurrentTemperature",
            "/format:value",
        ])
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Parse "CurrentTemperature=NNNNN" — value is tenths of Kelvin.
    let temp_dk: f64 = stdout.lines()
        .filter_map(|line| {
            let line = line.trim();
            line.strip_prefix("CurrentTemperature=")
                .and_then(|v| v.trim().parse::<f64>().ok())
        })
        .max_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))?;

    let temp_c = (temp_dk / 10.0) - 273.15;
    let state = match temp_c {
        t if t < 70.0 => "Normal",
        t if t < 80.0 => "Fair",
        t if t < 90.0 => "Serious",
        _              => "Critical",
    };
    Some(state.to_string())
}

/// GPU wired memory limit via `sysctl iogpu.wired_limit_mb` — Apple Silicon only.
///
/// macOS enforces a per-process GPU wired memory budget that is independent of
/// total RAM. On M-series chips this is typically ~75% of physical memory.
/// The sysctl exists only on Apple Silicon; returns None on Intel / non-macOS.
/// No sudo required.
///
/// M4 chips use dynamic wired memory management (`iogpu.dynamic_lwm: 1`) and
/// report `wired_limit_mb: 0`. When this happens, fall back to 75% of total
/// physical RAM as the estimated GPU budget — matching Apple's documented
/// unified memory allocation ratio.
#[cfg(target_os = "macos")]
pub(crate) fn read_iogpu_wired_limit_mb() -> Option<u64> {
    use sysctl::Sysctl;
    let ctl = sysctl::Ctl::new("iogpu.wired_limit_mb").ok()?;
    let s = ctl.value_string().ok()?;
    let val = s.trim().parse::<u64>().ok()?;
    if val > 0 {
        return Some(val);
    }
    // M4 dynamic wired memory: wired_limit_mb == 0 means no static cap.
    // Estimate 75% of physical RAM as the effective GPU budget.
    let memsize_ctl = sysctl::Ctl::new("hw.memsize").ok()?;
    let memsize_str = memsize_ctl.value_string().ok()?;
    let total_bytes = memsize_str.trim().parse::<u64>().ok()?;
    Some(total_bytes * 3 / 4 / 1024 / 1024) // 75% of total, in MB
}

/// Thermal via `pmset -g therm` — works on Apple Silicon, no sudo.
///
/// Parses `CPU_Speed_Limit` (or `CPU_Scheduler_Limit` as fallback):
///   100    → Normal
///   80-99  → Elevated
///   50-79  → High
///   < 50   → Critical
#[cfg(target_os = "macos")]
pub(crate) async fn read_thermal_pmset() -> Option<String> {
    let out = tokio::process::Command::new("pmset")
        .args(["-g", "therm"])
        .output()
        .await
        .ok()?;
    if !out.status.success() { return None; }
    parse_pmset_therm(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(target_os = "macos")]
pub(crate) fn parse_pmset_therm(output: &str) -> Option<String> {
    for line in output.lines() {
        let line = line.trim();

        // Intel / older macOS: CPU_Speed_Limit or CPU_Scheduler_Limit = N
        let speed_val = if let Some(rest) = line.strip_prefix("CPU_Speed_Limit") {
            Some(rest)
        } else { line.strip_prefix("CPU_Scheduler_Limit") };
        if let Some(rest) = speed_val {
            let val: u32 = rest
                .trim_start_matches([' ', '='])
                .trim()
                .parse()
                .ok()?;
            return Some(match val {
                100     => "Normal",
                80..=99 => "Elevated",
                50..=79 => "High",
                _       => "Critical",
            }.to_string());
        }

        // Apple Silicon / macOS Ventura+: "No thermal warning level: N"
        // 0 = not throttling (Normal); any other value means throttled.
        if let Some(rest) = line.strip_prefix("No thermal warning level:") {
            let val: u32 = rest.trim().parse().unwrap_or(0);
            return Some(if val == 0 { "Normal" } else { "Elevated" }.to_string());
        }

        // Apple Silicon macOS Sequoia+: pmset reports notes instead of numeric keys.
        // "Note: No thermal warning level has been recorded" → no throttling = Normal.
        if line.starts_with("Note: No thermal warning level") {
            return Some("Normal".to_string());
        }
        // "Note: No performance warning level has been recorded" → also Normal signal.
        if line.starts_with("Note: No performance warning level") {
            return Some("Normal".to_string());
        }

        // Apple Silicon alternative: "Thermal Warning Level = N"
        if let Some(rest) = line.strip_prefix("Thermal Warning Level") {
            let val: u32 = rest
                .trim_start_matches([' ', '='])
                .trim()
                .parse()
                .unwrap_or(0);
            return Some(match val {
                0 => "Normal",
                1 => "Elevated",
                2 => "High",
                _ => "Critical",
            }.to_string());
        }
    }
    None
}

/// GPU utilization via ioreg — no sudo.
/// Tries `IOAccelerator` first (Intel/AMD), then `IOGPUDevice` (Apple Silicon AGX).
#[cfg(target_os = "macos")]
pub(crate) async fn read_gpu_ioreg() -> Option<f32> {
    for class in &["IOAccelerator", "IOGPUDevice"] {
        if let Some(v) = try_ioreg_class(class).await {
            return Some(v);
        }
    }
    None
}

#[cfg(target_os = "macos")]
pub(crate) async fn try_ioreg_class(class: &str) -> Option<f32> {
    let out = tokio::process::Command::new("ioreg")
        .args(["-r", "-c", class])
        .output()
        .await
        .ok()?;
    if !out.status.success() { return None; }
    parse_ioreg_gpu(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(target_os = "macos")]
pub(crate) fn parse_ioreg_gpu(text: &str) -> Option<f32> {
    for line in text.lines() {
        // Intel / AMD: "Device Utilization %" = N  (integer percent, e.g. 42)
        if let Some(pos) = line.find("\"Device Utilization %\"") {
            let after = &line[pos + "\"Device Utilization %\"".len()..];
            let after = after.trim_start_matches([':', ' ', '=']);
            let num: String = after
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            if let Ok(v) = num.parse::<f32>() {
                return Some(v);
            }
        }

        // Apple Silicon AGX (AGXAcceleratorG14G etc.):
        // "GPU Core Utilization" = N  — float 0.0–1.0 in ioreg output.
        if let Some(pos) = line.find("\"GPU Core Utilization\"") {
            let after = &line[pos + "\"GPU Core Utilization\"".len()..];
            // ioreg formats as: "key" = value  (value may be unquoted float)
            let after = after.trim_start_matches([':', ' ', '=', '"']);
            let num: String = after
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            if let Ok(v) = num.parse::<f32>() {
                // AGX reports 0.0–1.0; multiply by 100 to get percent.
                // Guard against already-percent values (> 1.0) just in case.
                return Some(if v <= 1.0 { v * 100.0 } else { v });
            }
        }
    }
    None
}

/// Apple Silicon chip name via `system_profiler SPHardwareDataType`.
/// Parses the "Chip:" line which reads e.g. "Apple M3 Pro" directly.
/// Falls back to None on non-Apple hardware or if the command is unavailable.
#[cfg(target_os = "macos")]
pub(crate) async fn read_apple_chip_name() -> Option<String> {
    let out = tokio::process::Command::new("system_profiler")
        .arg("SPHardwareDataType")
        .output()
        .await
        .ok()?;
    if !out.status.success() { return None; }
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        // Output contains lines like "      Chip: Apple M3 Pro"
        if let Some(rest) = line.trim().strip_prefix("Chip:") {
            let name = rest.trim().to_string();
            if !name.is_empty() { return Some(name); }
        }
    }
    None
}


/// CPU model name from `/proc/cpuinfo` on Linux.
/// Reads the "model name" field and strips noisy suffixes so the UI gets a
/// clean string like "AMD EPYC 7302P" or "Intel Xeon Gold 6154".
///
/// ARM processors (e.g. NVIDIA Grace, Ampere Altra) often omit "model name"
/// from /proc/cpuinfo entirely.  When the field is absent we fall back to
/// /sys/firmware/devicetree/base/model which carries the platform board name
/// (e.g. "NVIDIA GH200 480GB" on a Grace Hopper Superchip, or "NVIDIA DGX
/// Spark" on the Grace Blackwell desktop system).  This is readable without
/// elevated privileges on most ARM Linux distributions.
#[cfg(target_os = "linux")]
pub(crate) fn read_linux_chip_name() -> Option<String> {
    // ── Primary: /proc/cpuinfo "model name" (x86, some ARM) ──────────────────
    let from_cpuinfo = (|| -> Option<String> {
        let content = std::fs::read_to_string("/proc/cpuinfo").ok()?;
        let raw = content.lines()
            .find(|l| l.starts_with("model name"))?.split_once(':')?.1
            .trim()
            .to_string();

        // Strip " @ X.XXGHz" clock speed annotation
        let raw = if let Some(pos) = raw.find(" @") { raw[..pos].to_string() } else { raw };

        // Drop trailing words that are pure noise: "CPU", "Processor", or "N-Core"
        let words: Vec<&str> = raw.split_whitespace().collect();
        let end = words.iter().position(|w| {
            *w == "CPU" || *w == "Processor" || w.ends_with("-Core")
        }).unwrap_or(words.len());
        let trimmed = words[..end].join(" ");

        // Strip trademark noise: (R) (TM) ® ™
        let clean = trimmed
            .replace("(R)", "").replace("(TM)", "")
            .replace(['\u{00ae}', '\u{2122}'], "");

        let result = clean.split_whitespace().collect::<Vec<_>>().join(" ");
        if result.is_empty() { None } else { Some(result) }
    })();

    if from_cpuinfo.is_some() { return from_cpuinfo; }

    // ── Fallback: device-tree model (ARM Linux — NVIDIA Grace, Ampere, etc.) ─
    // The board model string is null-terminated; strip the trailing NUL.
    if let Ok(raw) = std::fs::read_to_string("/sys/firmware/devicetree/base/model") {
        let s = raw.trim_end_matches('\0').trim().to_string();
        if !s.is_empty() { return Some(s); }
    }

    None
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn read_linux_chip_name() -> Option<String> { None }

// ── Linux RAPL CPU Power Harvester ────────────────────────────────────────────
//
// Reads the kernel powercap interface — no sudo, no extra libraries.
// Samples the energy counter twice with a 500 ms gap; power = ΔµJ / Δµs (= Watts).
//
// Enumerates and SUMS every top-level RAPL package domain (e.g. intel-rapl:0,
// intel-rapl:1 on a dual-socket box) so multi-socket total package power is
// reported, not just socket 0. Subdomains (intel-rapl:0:0) and the duplicate
// MMIO interface (intel-rapl-mmio:*) are excluded to avoid double-counting.
// Falls back to the legacy single-path layout (amd-core / older kernels) when
// no standard package domain is found.

#[cfg(target_os = "linux")]
pub(crate) const RAPL_PATHS: &[(&str, &str)] = &[
    ("/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj", "intel-rapl"),
    ("/sys/class/powercap/intel-rapl:0/energy_uj",            "intel-rapl:0"),
    ("/sys/class/powercap/amd-core/amd-core:0/energy_uj",     "amd-core"),
];

#[cfg(target_os = "linux")]
pub(crate) fn read_rapl_uj(path: &str) -> Option<u64> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

/// Enumerate the `energy_uj` paths of every top-level RAPL package domain.
///
/// Top-level zones are named `intel-rapl:N` / `amd-core:N` (exactly one colon
/// group). Subdomains `intel-rapl:N:M` (core/uncore/dram — would double-count
/// against the package) and the `intel-rapl-mmio:*` mirror interface are
/// excluded. On a dual-socket box this returns both `intel-rapl:0` and
/// `intel-rapl:1`, whose powers the caller sums.
#[cfg(target_os = "linux")]
pub(crate) fn discover_rapl_domains() -> Vec<String> {
    let mut domains = Vec::new();
    if let Ok(entries) = std::fs::read_dir("/sys/class/powercap") {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            // `starts_with("intel-rapl:")` excludes "intel-rapl-mmio:*"; the
            // single-colon count excludes the "intel-rapl:N:M" subdomains.
            let is_package = (name.starts_with("intel-rapl:") || name.starts_with("amd-core:"))
                && name.matches(':').count() == 1;
            if is_package {
                let path = format!("/sys/class/powercap/{name}/energy_uj");
                if read_rapl_uj(&path).is_some() {
                    domains.push(path);
                }
            }
        }
    }
    domains.sort(); // deterministic order across ticks
    domains
}

/// Returns a shared `Option<f32>` updated every ~500 ms with the package CPU power
/// in Watts (Linux RAPL powercap).  Stays `None` on non-Linux or when no RAPL sysfs
/// node is found (older kernels, certain VMs, or AMD pre-Zen platforms).
pub(crate) fn start_rapl_harvester() -> Arc<Mutex<Option<f32>>> {
    let shared = Arc::new(Mutex::new(None::<f32>));

    #[cfg(target_os = "linux")]
    {
        let shared_clone = Arc::clone(&shared);
        tokio::spawn(async move {
            // Prefer enumerating every package domain (multi-socket → summed).
            let mut domains = discover_rapl_domains();
            if domains.is_empty() {
                // Legacy fallback for older/non-standard layouts (amd-core, the
                // subdirectory variant) that the enumeration above doesn't match.
                if let Some((path, _)) = RAPL_PATHS.iter().find(|(p, _)| read_rapl_uj(p).is_some()) {
                    domains.push((*path).to_string());
                }
            }
            if domains.is_empty() { return; }

            // Sum the energy counters across all package domains. Returns None
            // only when every domain read fails (transient sysfs error).
            let read_total = |ds: &[String]| -> Option<u64> {
                let mut sum = 0_u64;
                let mut any = false;
                for d in ds {
                    if let Some(v) = read_rapl_uj(d) {
                        sum = sum.wrapping_add(v);
                        any = true;
                    }
                }
                any.then_some(sum)
            };

            loop {
                let Some(e1) = read_total(&domains) else {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                };
                let t1 = std::time::Instant::now();
                tokio::time::sleep(Duration::from_millis(500)).await;
                let Some(e2) = read_total(&domains) else { continue; };

                let elapsed_us = t1.elapsed().as_micros() as f64;
                // Skip sample on counter rollover (any domain wrapping makes the
                // summed delta non-monotonic) — extremely rare in a 500 ms window.
                if e2 > e1 && elapsed_us > 0.0 {
                    let power_w = (e2 - e1) as f64 / elapsed_us; // µJ / µs = W
                    if let Ok(mut guard) = shared_clone.lock() {
                        *guard = Some(power_w as f32);
                    }
                }

                // Hold ~500 ms before the next sample so the loop runs at ~1 Hz.
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        });
    }

    shared
}

// ── Swap Write Rate Harvester ─────────────────────────────────────────────────
//
// Samples the OS swap-out page counter once every 2 s and converts the delta
// to MB/s.  Zero-privilege — reads kernel counters directly on Linux;
// spawns a single `vm_stat` on macOS.
//
// Platform sources:
//   Linux:   /proc/vmstat → pswpout (cumulative swap-out pages, 4096 bytes each)
//   macOS:   vm_stat      → Swapouts (cumulative, page size from header)
//   Windows: None (WMI-based implementation deferred to Phase 6)
//
// Newtype wrapper prevents Axum extension collision with rapl_metrics which
// is the same inner type (Arc<Mutex<Option<f32>>>).

#[derive(Clone)]
pub(crate) struct SwapMetrics(pub(crate) Arc<Mutex<Option<f32>>>);

impl SwapMetrics {
    pub(crate) fn read(&self) -> Option<f32> {
        self.0.lock().map(|g| *g).unwrap_or(None)
    }
}

pub(crate) fn start_swap_harvester() -> SwapMetrics {
    let inner  = Arc::new(Mutex::new(None::<f32>));
    let shared = SwapMetrics(Arc::clone(&inner));

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        tokio::spawn(async move {
            // Each reading is the end of one window and the start of the next,
            // so the counter is read once per 2 s (one vm_stat spawn on macOS).
            let mut before = read_swap_pages_out().await;
            loop {
                tokio::time::sleep(Duration::from_secs(2)).await;
                let after  = read_swap_pages_out().await;

                if let (Some((b_pages, b_ps)), Some((a_pages, a_ps))) = (before, after)
                    && a_pages >= b_pages {
                        let page_size = ((b_ps + a_ps) / 2) as f64;
                        // (delta_pages × page_size_bytes) / 1_000_000 bytes/MB / 2 seconds
                        let mb_s = ((a_pages - b_pages) as f64 * page_size / 1_000_000.0 / 2.0) as f32;
                        if let Ok(mut guard) = inner.lock() {
                            *guard = Some(mb_s);
                        }
                    }
                before = after;
            }
        });
    }

    shared
}

/// Returns (cumulative_swap_out_pages, page_size_bytes).
/// Returns None when the platform counter is unavailable or the read fails.
#[cfg(target_os = "linux")]
pub(crate) async fn read_swap_pages_out() -> Option<(u64, u64)> {
    // Linux page size is always 4096 on x86_64 and almost always on aarch64.
    // /proc/vmstat pswpout counts pages swapped out since boot.
    let content = std::fs::read_to_string("/proc/vmstat").ok()?;
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("pswpout ") {
            let pages: u64 = rest.trim().parse().ok()?;
            return Some((pages, 4096));
        }
    }
    None
}

#[cfg(target_os = "macos")]
pub(crate) async fn read_swap_pages_out() -> Option<(u64, u64)> {
    let out = tokio::process::Command::new("vm_stat")
        .output()
        .await
        .ok()?;
    if !out.status.success() { return None; }
    parse_vm_stat_swapouts(&String::from_utf8_lossy(&out.stdout))
}

/// Parse vm_stat output for the Swapouts counter and page size.
///
/// Example header: "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
/// Example data line: "Swapouts:                               104."
#[cfg(target_os = "macos")]
pub(crate) fn parse_vm_stat_swapouts(text: &str) -> Option<(u64, u64)> {
    let mut page_size: u64 = 4096;   // default; overridden by header
    let mut swapouts:  Option<u64> = None;

    for line in text.lines() {
        // Parse page size from the header line.
        if line.starts_with("Mach Virtual Memory Statistics:") {
            if let Some(pos) = line.find("page size of ") {
                let rest = &line[pos + "page size of ".len()..];
                let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                if let Ok(v) = num.parse::<u64>() { page_size = v; }
            }
        }
        // Parse the Swapouts counter (trailing period stripped).
        if let Some(rest) = line.strip_prefix("Swapouts:") {
            let s = rest.trim().trim_end_matches('.');
            swapouts = s.parse::<u64>().ok();
        }
    }

    swapouts.map(|s| (s, page_size))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(crate) async fn read_swap_pages_out() -> Option<(u64, u64)> {
    None
}

// ── Linux thermal state ────────────────────────────────────────────────────────
//
// Two paths, tried in priority order:
//
//   1. AMD (k10temp present) — clock ratio + Tdie temperature tie-breaker.
//      Clock ratio = avg(scaling_cur_freq) / cpuinfo_max_freq.
//      Thresholds:  ≥0.95 → Normal (1.00)
//                   ≥0.80 → Fair   (1.25)
//                   ≥0.60 → Serious (1.75)
//                   < 0.60 → Critical (2.50)
//      Tie-breaker: Tdie > 85 °C bumps to at least Serious.
//      Source tag: "clock_ratio"
//
//   2. Generic sysfs — max temp across all /sys/class/thermal/thermal_zone*/temp.
//      < 70 °C → Normal  |  70–79 °C → Fair  |  80–89 °C → Serious  |  ≥90 °C → Critical
//      Source tag: "sysfs"
//
// Returns None when no thermal interface is available on this kernel/container.

/// Shared result from the Linux thermal harvester.  Carried alongside the state
/// string so the WES sampler can use direct_penalty (AMD clock-ratio path) or fall
/// back to thermal_penalty_v2(state) (generic sysfs path).
#[derive(Clone)]
pub(crate) struct LinuxThermalResult {
    pub(crate) state:          String,       // "Normal" | "Fair" | "Serious" | "Critical"
    pub(crate) source:         &'static str, // "clock_ratio" | "sysfs"
    pub(crate) direct_penalty: Option<f32>,  // Some on AMD path (can exceed 2.0); None on sysfs path
    /// Raw clock ratio (cur/max) from the AMD path.  None on the generic sysfs path.
    /// Frontend converts to clock_throttle_pct = (1.0 - ratio) * 100.
    pub(crate) clock_ratio:    Option<f64>,
}

// Helper functions — Linux only.

#[cfg(target_os = "linux")]
pub(crate) fn find_hwmon(target: &str) -> Option<std::path::PathBuf> {
    let dir = std::path::Path::new("/sys/class/hwmon");
    if !dir.exists() { return None; }
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        if let Ok(name) = std::fs::read_to_string(entry.path().join("name"))
            && name.trim() == target { return Some(entry.path()); }
    }
    None
}

#[cfg(target_os = "linux")]
/// Read Tdie from k10temp hwmon (millidegrees → °C).
/// Tries temp2_input (Zen2+ Tdie) then temp1_input (older Zen / Tctl).
pub(crate) fn read_k10temp_tdie_c(hwmon: &std::path::Path) -> Option<f64> {
    for name in &["temp2_input", "temp1_input"] {
        if let Ok(raw) = std::fs::read_to_string(hwmon.join(name))
            && let Ok(mc) = raw.trim().parse::<i64>() {
                return Some(mc as f64 / 1000.0);
            }
    }
    None
}

#[cfg(target_os = "linux")]
/// Hardware-max CPU frequency (kHz).  Reads cpuinfo_max_freq first (true hardware
/// ceiling), falls back to scaling_max_freq (OS-set limit, usually the same).
pub(crate) fn read_cpu_max_freq_khz() -> Option<u64> {
    let base = std::path::Path::new("/sys/devices/system/cpu/cpu0/cpufreq");
    for file in &["cpuinfo_max_freq", "scaling_max_freq"] {
        if let Ok(raw) = std::fs::read_to_string(base.join(file))
            && let Ok(khz) = raw.trim().parse::<u64>()
                && khz > 0 { return Some(khz); }
    }
    None
}

#[cfg(target_os = "linux")]
/// Average scaling_cur_freq across all logical CPUs (cpu0…cpuN directories).
pub(crate) fn read_avg_cur_freq_khz() -> Option<u64> {
    let cpu_dir = std::path::Path::new("/sys/devices/system/cpu");
    let mut sum: u64 = 0;
    let mut count: u32 = 0;
    for entry in std::fs::read_dir(cpu_dir).ok()?.flatten() {
        let fname = entry.file_name();
        let s = fname.to_string_lossy();
        // Match cpu0, cpu1, … cpuN — skip cpufreq, cpuidle, power, etc.
        if s.starts_with("cpu") && s[3..].parse::<u32>().is_ok()
            && let Ok(raw) = std::fs::read_to_string(
                entry.path().join("cpufreq/scaling_cur_freq")
            )
                && let Ok(khz) = raw.trim().parse::<u64>() {
                    sum += khz;
                    count += 1;
                }
    }
    if count == 0 { return None; }
    Some(sum / count as u64)
}

#[cfg(target_os = "linux")]
/// Convert AMD clock ratio + optional Tdie into a `LinuxThermalResult`.
pub(crate) fn amd_clock_ratio_result(ratio: f64, tdie_c: Option<f64>) -> LinuxThermalResult {
    let (state, penalty): (&str, f32) = if ratio >= 0.95 {
        ("Normal",   1.00)
    } else if ratio >= 0.80 {
        ("Fair",     1.25)
    } else if ratio >= 0.60 {
        ("Serious",  1.75)
    } else {
        ("Critical", 2.50)   // severe throttle — higher than the 4-state cap of 2.0
    };

    // Reconcile the clock-ratio verdict against the temperature reading.
    // Depressed clocks alone do NOT imply thermal throttling — demand-based DVFS
    // idles the clocks on a cold, unloaded CPU. Real throttling only happens near
    // Tjmax (~90-100 °C), so the die must actually be hot to count as throttling.
    let (state, penalty) = match tdie_c {
        // Hot die + reduced clocks → confirmed thermal stress, at least Serious.
        Some(t) if t > 85.0 && penalty < 1.75 => ("Serious", 1.75_f32),
        // Cool die (< 75 °C): low clocks are idle DVFS, not throttling → Normal,
        // regardless of how far the clock ratio has dropped.
        Some(t) if t < 75.0 => ("Normal", 1.00_f32),
        // No temperature sensor: can't confirm thermal stress, so a low clock
        // ratio is more likely idle DVFS — cap at "Fair".
        None if penalty > 1.25 => ("Fair", 1.25_f32),
        // 75–85 °C with a temp reading: keep the clock-ratio verdict (gray zone).
        _ => (state, penalty),
    };

    LinuxThermalResult {
        state:          state.to_string(),
        source:         "clock_ratio",
        direct_penalty: Some(penalty),
        clock_ratio:    Some(ratio),
    }
}

#[cfg(target_os = "linux")]
/// Read Intel coretemp max temperature (millidegrees → °C).
/// Scans all temp*_input entries and returns the highest.
pub(crate) fn read_coretemp_max_c(hwmon: &std::path::Path) -> Option<f64> {
    let mut max_c: Option<f64> = None;
    for entry in std::fs::read_dir(hwmon).ok()?.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with("temp") && name_str.ends_with("_input")
            && let Ok(raw) = std::fs::read_to_string(entry.path())
                && let Ok(mc) = raw.trim().parse::<i64>() {
                    let c = mc as f64 / 1000.0;
                    max_c = Some(max_c.map_or(c, |p: f64| p.max(c)));
                }
    }
    max_c
}

#[cfg(target_os = "linux")]
pub(crate) fn harvest_linux_thermal(max_freq_khz: Option<u64>) -> Option<LinuxThermalResult> {
    // Resolve the hwmon nodes once — each lookup scans /sys/class/hwmon, and the
    // branches below would otherwise re-scan it up to four times per tick.
    let k10temp_hwmon = find_hwmon("k10temp");
    let coretemp_hwmon = find_hwmon("coretemp");

    // ── AMD path: k10temp + clock ratio ──────────────────────────────────────
    if let Some(hwmon) = &k10temp_hwmon
        && let (Some(max_khz), Some(cur_khz)) = (max_freq_khz, read_avg_cur_freq_khz())
            && max_khz > 0 {
                let ratio  = cur_khz as f64 / max_khz as f64;
                let tdie_c = read_k10temp_tdie_c(hwmon);
                return Some(amd_clock_ratio_result(ratio, tdie_c));
            }
        // k10temp present but cpufreq unavailable — fall through to generic path.

    // ── Intel path: coretemp hwmon + clock ratio ─────────────────────────────
    // coretemp provides direct per-core temperature readings on Intel CPUs.
    // Combined with clock ratio for thermal state determination.
    if let Some(hwmon) = &coretemp_hwmon {
        let temp_c = read_coretemp_max_c(hwmon);
        // Try clock ratio first (same approach as AMD)
        if let (Some(max_khz), Some(cur_khz)) = (max_freq_khz, read_avg_cur_freq_khz())
            && max_khz > 0 {
                let ratio = cur_khz as f64 / max_khz as f64;
                // Use same clock ratio mapping as AMD, with coretemp as tie-breaker
                let mut result = amd_clock_ratio_result(ratio, temp_c);
                result.source = "coretemp";
                return Some(result);
            }
        // coretemp present but cpufreq unavailable — use temperature directly
        if let Some(tc) = temp_c {
            let state = match tc {
                t if t < 70.0 => "Normal",
                t if t < 80.0 => "Fair",
                t if t < 90.0 => "Serious",
                _              => "Critical",
            };
            return Some(LinuxThermalResult {
                state:          state.to_string(),
                source:         "coretemp",
                direct_penalty: None,
                clock_ratio:    None,
            });
        }
    }

    // ── Generic Intel/other: clock ratio without dedicated hwmon ─────────────
    // If no k10temp or coretemp hwmon, but cpufreq is available, use clock ratio.
    if k10temp_hwmon.is_none() && coretemp_hwmon.is_none()
        && let (Some(max_khz), Some(cur_khz)) = (max_freq_khz, read_avg_cur_freq_khz())
            && max_khz > 0 {
                let ratio = cur_khz as f64 / max_khz as f64;
                let mut result = amd_clock_ratio_result(ratio, None);
                result.source = "clock_ratio";
                return Some(result);
            }

    // ── Generic path: /sys/class/thermal zone max ─────────────────────────────
    let thermal_dir = std::path::Path::new("/sys/class/thermal");
    if !thermal_dir.exists() { return None; }

    let mut max_temp_c: Option<f64> = None;
    for entry in std::fs::read_dir(thermal_dir).ok()?.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("thermal_zone") { continue; }
        let Ok(raw) = std::fs::read_to_string(entry.path().join("temp")) else { continue; };
        let Ok(mc): Result<i64, _> = raw.trim().parse() else { continue; };
        let temp_c = mc as f64 / 1000.0;
        max_temp_c = Some(max_temp_c.map_or(temp_c, |p: f64| p.max(temp_c)));
    }

    let temp = max_temp_c?;
    let state = match temp {
        t if t < 70.0 => "Normal",
        t if t < 80.0 => "Fair",      // canonical name (was "Elevated" — penalty was wrongly 1.0)
        t if t < 90.0 => "Serious",
        _              => "Critical",
    };
    Some(LinuxThermalResult {
        state:          state.to_string(),
        source:         "sysfs",
        direct_penalty: None,   // derived via thermal_penalty_v2(state)
        clock_ratio:    None,
    })
}

/// Returns a shared `Option<LinuxThermalResult>` updated every 5 s.
/// Stays `None` on non-Linux targets and when no thermal interface is available.
pub(crate) fn start_linux_thermal_harvester() -> Arc<Mutex<Option<LinuxThermalResult>>> {
    let shared = Arc::new(Mutex::new(None::<LinuxThermalResult>));

    #[cfg(target_os = "linux")]
    {
        let shared_clone = Arc::clone(&shared);
        tokio::spawn(async move {
            // Cache hardware-max frequency once — it never changes at runtime.
            // Used by the AMD clock-ratio path; None on non-AMD or no cpufreq.
            let max_freq_khz = read_cpu_max_freq_khz();

            let mut interval = tokio::time::interval(Duration::from_secs(5));
            loop {
                interval.tick().await;
                let result = harvest_linux_thermal(max_freq_khz);
                if let Ok(mut guard) = shared_clone.lock() {
                    *guard = result;
                }
            }
        });
    }

    shared
}

/// Memory pressure via `vm_stat` — no sudo required.
///
/// Formula (matches Activity Monitor "Used" definition):
///   in_use = wired + active          ← cannot be reclaimed without eviction
///   total  = free + active + inactive + speculative + wired
///   pressure % = in_use / total × 100
///
/// Inactive and speculative pages are reclaimable cached data — excluding them
/// prevents the metric from reading 99% on a healthy system.
#[cfg(target_os = "macos")]
pub(crate) async fn read_memory_pressure_vmstat() -> Option<f32> {
    let out = tokio::process::Command::new("vm_stat")
        .output()
        .await
        .ok()?;
    if !out.status.success() { return None; }
    parse_vmstat_pressure(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(target_os = "macos")]
pub(crate) fn parse_vmstat_pressure(text: &str) -> Option<f32> {
    let mut free:        u64 = 0;
    let mut active:      u64 = 0;
    let mut inactive:    u64 = 0;
    let mut speculative: u64 = 0;
    let mut wired:       u64 = 0;
    let mut compressor:  u64 = 0; // physical RAM consumed by the macOS memory compressor
    let mut found_any = false;

    for line in text.lines() {
        let line = line.trim();
        // Each vm_stat line is "Label:    NNN." — strip trailing dot, parse integer.
        let parse_val = |prefix: &str| -> Option<u64> {
            let rest = line.strip_prefix(prefix)?;
            rest.trim().trim_end_matches('.').trim().parse().ok()
        };
        if      let Some(v) = parse_val("Pages free:")                    { free = v;        found_any = true; }
        else if let Some(v) = parse_val("Pages active:")                  { active = v;      found_any = true; }
        else if let Some(v) = parse_val("Pages inactive:")                { inactive = v;    found_any = true; }
        else if let Some(v) = parse_val("Pages speculative:")             { speculative = v; found_any = true; }
        else if let Some(v) = parse_val("Pages wired down:")              { wired = v;       found_any = true; }
        else if let Some(v) = parse_val("Pages occupied by compressor:")  { compressor = v;  found_any = true; }
    }

    if !found_any { return None; }
    // Include compressor pages in both numerator and denominator — on M-series Macs under
    // memory pressure the compressor can consume 1–2 GB, and omitting it understates pressure.
    let in_use = wired + active + compressor;
    let total  = free + active + inactive + speculative + wired + compressor;
    if total == 0 { return None; }
    Some((in_use as f32 / total as f32) * 100.0)
}

// ── Ghost-Killer ─────────────────────────────────────────────────────────────
// If port {port} is held by a previous wicklee process, send SIGTERM then
// SIGKILL and wait for the port to be released before the caller retries bind.
// Returns true when the port has been freed, false when it couldn't be evicted
// (not a wicklee process, permission denied, or OS doesn't have lsof/ps).
#[cfg(not(target_os = "windows"))]
pub(crate) async fn try_evict_port(port: u16) -> bool {
    // Step 1: find the PID holding the port.
    let lsof = tokio::process::Command::new("lsof")
        .args(["-ti", &format!("tcp:{port}")])
        .output().await;
    let Ok(lsof_out) = lsof else { return false };
    let pid_str = String::from_utf8_lossy(&lsof_out.stdout).trim().to_string();
    let Ok(_pid) = pid_str.parse::<u32>() else { return false };

    // Step 2: confirm the process is a wicklee binary (not some other service).
    let ps = tokio::process::Command::new("ps")
        .args(["-p", &pid_str, "-o", "comm="])
        .output().await;
    let Ok(ps_out) = ps else { return false };
    let proc_name = String::from_utf8_lossy(&ps_out.stdout).trim().to_lowercase();
    if !proc_name.contains("wicklee") { return false; }

    eprintln!("  Replacing previous wicklee instance (PID {pid_str})…");

    // Step 3: SIGTERM — allow graceful shutdown.
    let _ = tokio::process::Command::new("kill")
        .args(["-TERM", &pid_str])
        .status().await;

    // Step 4: poll up to 2 s for the port to be free.
    for _ in 0..4 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let check = tokio::process::Command::new("lsof")
            .args(["-ti", &format!("tcp:{port}")])
            .output().await;
        if check.map(|o| o.stdout.trim_ascii().is_empty()).unwrap_or(true) {
            return true;
        }
    }

    // Step 5: SIGKILL if still alive after 2 s.
    let _ = tokio::process::Command::new("kill")
        .args(["-KILL", &pid_str])
        .status().await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    true
}

/// powermetrics — parses CPU/GPU/SoC power and memory pressure.
/// The process may already be root (launchd service) or not; powermetrics
/// requires root for power sampling. When run without root it typically
/// exits non-zero — we surface the stderr so ops can diagnose permissions.
#[cfg(target_os = "macos")]
pub(crate) async fn try_powermetrics_nosudo() -> Option<AppleSiliconMetrics> {
    let out = tokio::process::Command::new("powermetrics")
        // 5000 ms window: M2 token-decode is bursty (~28 ms/token at 35 tok/s).
        // A 500 ms window can catch the inter-token idle and report ~1–2 W when the
        // true average is 3–5 W.  5000 ms spans ≥175 decode steps, covering the full
        // chip duty-cycle for an accurate average power reading.
        .args(["--samplers", "cpu_power,gpu_power,thermal", "-n", "1", "-i", "5000"])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        if !stderr.trim().is_empty() {
            eprintln!("[power] powermetrics failed: {}", stderr.trim());
            eprintln!("[power] hint: run as root (sudo wicklee --install-service) for SoC power data");
        }
        return None;
    }
    let result = parse_powermetrics(&String::from_utf8_lossy(&out.stdout));
    // Debug: warn if we got cpu_power but no soc_power — suggests parse miss
    if result.cpu_power_w.is_some() && result.soc_power_w.is_none() {
        eprintln!("[power] parsed cpu_power_w={:.1}W but soc_power_w=None — Combined Power line not found",
            result.cpu_power_w.unwrap_or(0.0));
    }
    Some(result)
}

/// Whether to emit the per-sample powermetrics diagnostics (label dump + power
/// breakdown). Off by default — set WICKLEE_DEBUG_POWER=1 to enable. Without
/// this gate these printed on every ~5 s sample forever, growing the log file.
#[cfg(target_os = "macos")]
pub(crate) fn power_debug_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("WICKLEE_DEBUG_POWER").is_ok())
}

#[cfg(target_os = "macos")]
pub(crate) fn parse_powermetrics(output: &str) -> AppleSiliconMetrics {
    let mut m = AppleSiliconMetrics::default();
    for line in output.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("CPU Power: ") {
            m.cpu_power_w = parse_mw(rest);
        } else if let Some(rest) = line.strip_prefix("E-Cluster Power: ")
            .or_else(|| line.strip_prefix("E-core Power: "))
        {
            m.ecpu_power_w = parse_mw(rest);
        } else if let Some(rest) = line.strip_prefix("P-Cluster Power: ")
            .or_else(|| line.strip_prefix("P-core Power: "))
        {
            m.pcpu_power_w = parse_mw(rest);
        } else if let Some(rest) = line.strip_prefix("GPU Power: ") {
            m.gpu_power_w = parse_mw(rest);
        } else if let Some(rest) = line.strip_prefix("ANE Power: ") {
            // Apple Neural Engine power — present on some macOS versions as a separate line
            m.ane_power_w = parse_mw(rest);
        } else if let Some(rest) =
            // macOS 13-14 (Ventura/Sonoma): "Combined Power (CPU + GPU + ANE): XXXX mW"
            line.strip_prefix("Combined Power (CPU + GPU + ANE): ")
            // macOS 15 (Sequoia) variant observed in the wild — parenthetical dropped
            .or_else(|| line.strip_prefix("Combined Power: "))
            // Older Intel-era label still seen on some Mx configurations
            .or_else(|| line.strip_prefix("Package Power: "))
            // Sequoia 15.2+ renames the combined line on Apple Silicon
            .or_else(|| line.strip_prefix("SoC Power: "))
            // Additional observed variant on some M-series configurations
            .or_else(|| line.strip_prefix("System Power: "))
        {
            m.soc_power_w = parse_mw(rest);
        } else if let Some(rest) = line.strip_prefix("GPU Active residency: ")
            // macOS Sequoia (24D+) changed the label to include "HW" — handle both.
            .or_else(|| line.strip_prefix("GPU HW active residency: "))
        {
            m.gpu_utilization_percent = parse_percent(rest);
        } else if let Some(rest) = line.strip_prefix("System Memory Pressure: ")
            .or_else(|| line.strip_prefix("Memory Pressure: "))
        {
            m.memory_pressure_percent = parse_percent(rest);
        } else if let Some(rest) = line.strip_prefix("Thermal level: ")
            .or_else(|| line.strip_prefix("Thermal pressure: "))
        {
            let state = rest.split_whitespace().next().unwrap_or("").to_string();
            if !state.is_empty() { m.thermal_state = Some(state); }
        }
    }

    // Diagnostic: dump every "Power" line from the raw output so operators can
    // see the exact labels powermetrics uses on this macOS version.  This lets
    // us catch label changes (e.g. "Combined Power" → "SoC Power" in Sequoia)
    // without guessing.  Log prefix [pm_raw] — filter with:
    //   sudo tail -f /var/log/wicklee.log | grep '\[pm_raw\]'
    if power_debug_enabled() {
        for line in output.lines() {
            let t = line.trim();
            let lower = t.to_ascii_lowercase();
            if lower.contains("power") || lower.contains("residency") {
                eprintln!("[pm_raw] {t}");
            }
        }
    }

    // Synthesize soc_power_w from components if the combined line was absent.
    // This handles macOS versions that omit "Combined Power" but still output
    // individual CPU + GPU + ANE lines.
    if m.soc_power_w.is_none()
        && (m.cpu_power_w.is_some() || m.gpu_power_w.is_some() || m.ane_power_w.is_some()) {
            let total = m.cpu_power_w.unwrap_or(0.0)
                + m.gpu_power_w.unwrap_or(0.0)
                + m.ane_power_w.unwrap_or(0.0);
            if total > 0.1 { m.soc_power_w = Some(total); }
        }

    // Diagnostic: log the power component breakdown so operators can verify
    // GPU + ANE rails are being captured during active inference.
    if power_debug_enabled() {
        eprintln!("[power] soc={:.2}W  (cpu={:.2} + gpu={:.2} + ane={:.2})",
            m.soc_power_w.unwrap_or(0.0),
            m.cpu_power_w.unwrap_or(0.0),
            m.gpu_power_w.unwrap_or(0.0),
            m.ane_power_w.unwrap_or(0.0));
    }

    m
}

#[cfg(target_os = "macos")]
pub(crate) fn parse_mw(s: &str) -> Option<f32> {
    let n: f32 = s.split_whitespace().next()?.parse().ok()?;
    Some(n / 1000.0)
}
#[cfg(target_os = "macos")]
pub(crate) fn parse_percent(s: &str) -> Option<f32> {
    s.trim_end_matches('%').split_whitespace().next()?.parse().ok()
}

#[cfg(all(test, target_os = "linux"))]
mod thermal_tests {
    use super::*;

    #[test]
    fn cool_die_with_low_clocks_is_not_throttling() {
        // The bug: an idle CPU drops its clocks via demand-based DVFS, which the
        // raw clock-ratio mapping reads as Critical. With a cool temp reading it
        // must be Normal — a cold chip cannot be thermally throttled.
        let r = amd_clock_ratio_result(0.30, Some(40.0));
        assert_eq!(r.state, "Normal");
        assert_eq!(r.direct_penalty, Some(1.00));
    }

    #[test]
    fn hot_die_with_reduced_clocks_escalates_to_at_least_serious() {
        // 90 °C with a mild clock drop (would be "Fair" on ratio alone) is real
        // thermal pressure → at least Serious.
        let r = amd_clock_ratio_result(0.85, Some(90.0));
        assert_eq!(r.state, "Serious");
        assert!(r.direct_penalty.unwrap() >= 1.75);
    }

    #[test]
    fn severe_throttle_when_hot_stays_critical() {
        let r = amd_clock_ratio_result(0.40, Some(95.0));
        assert_eq!(r.state, "Critical");
    }

    #[test]
    fn no_temp_sensor_caps_low_clocks_at_fair() {
        // Without a temperature we can't confirm throttling, so a deep clock drop
        // is capped at Fair rather than reported as Critical.
        let r = amd_clock_ratio_result(0.30, None);
        assert_eq!(r.state, "Fair");
        assert_eq!(r.direct_penalty, Some(1.25));
    }

    #[test]
    fn full_clocks_when_cool_are_normal() {
        let r = amd_clock_ratio_result(0.98, Some(55.0));
        assert_eq!(r.state, "Normal");
    }
}
