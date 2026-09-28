//! Background hardware samplers: NVIDIA/NVML harvester, Apple Silicon/Windows metric harvesters, WES thermal sampler.
//! Split out of main.rs; items are pub(crate) and re-exported at the crate root.

use super::*;

// ── NVIDIA Harvester ──────────────────────────────────────────────────────────
//
// ── NVML memory info v2 helper ────────────────────────────────────────────────
//
// nvmlDeviceGetMemoryInfo (v1) returns NVML_ERROR_NOT_SUPPORTED on NVIDIA
// Grace Blackwell (GB10/GB200 Superchip) and similar unified-memory SoC
// designs where the GPU does not have a traditional dedicated framebuffer.
// nvmlDeviceGetMemoryInfo_v2 adds a `reserved` field and works correctly on
// these architectures.  nvml-wrapper 0.10 only wraps v1, so we call v2
// directly through the nvml-wrapper-sys bindings.
//
// This function takes an already-loaded NvmlLib (no dlopen inside the poll
// loop) and acquires the device handle internally.  The raw nvmlDevice_t
// pointer is created and consumed within this synchronous fn — it never
// escapes into the async task, keeping the future Send-safe.
//
// Returns (total_mb, used_mb) on success, None if v2 is also unsupported.
#[cfg(any(all(target_os = "linux", not(target_env = "musl")), target_os = "windows"))]
pub(crate) fn nvml_memory_v2(lib: &nvml_wrapper_sys::bindings::NvmlLib, device_index: u32) -> Option<(u64, u64)> {
    use std::mem;
    // NVML_STRUCT_VERSION(Memory, 2) = sizeof(nvmlMemory_v2_t) | (2 << 24)
    let version: u32 = (mem::size_of::<nvmlMemory_v2_t>() as u32) | (2_u32 << 24);

    unsafe {
        let handle_fn = lib.nvmlDeviceGetHandleByIndex_v2.as_ref().ok()?;
        let mem_fn    = lib.nvmlDeviceGetMemoryInfo_v2.as_ref().ok()?;

        let mut dev: nvmlDevice_t = std::ptr::null_mut();
        if handle_fn(device_index, &mut dev) != 0 { return None; }

        let mut info: nvmlMemory_v2_t = mem::zeroed();
        info.version = version;
        if mem_fn(dev, &mut info) != 0 || info.total == 0 { return None; }
        Some((info.total / 1_048_576, info.used / 1_048_576))
    }
}

// Helper: load libnvidia-ml at runtime to access v2 APIs not yet exposed by
// the nvml-wrapper safe layer.  The library is already in-process (loaded by
// Nvml::init()); the OS loader returns the same DSO handle reference-counted,
// so this is cheap and does not cause double-init.
#[cfg(any(all(target_os = "linux", not(target_env = "musl")), target_os = "windows"))]
pub(crate) fn load_nvml_lib() -> Option<nvml_wrapper_sys::bindings::NvmlLib> {
    use nvml_wrapper_sys::bindings::NvmlLib;

    #[cfg(target_os = "linux")]
    let names: &[&str] = &["libnvidia-ml.so.1", "libnvidia-ml.so"];
    #[cfg(target_os = "windows")]
    let names: &[&str] = &["nvml.dll"];

    names.iter().find_map(|n| unsafe { NvmlLib::new(n).ok() })
}

// Initialises NVML on the first call; if unavailable (no drivers, macOS, etc.)
// returns immediately with an all-None cache — no crash, no retry spam.
// Polls device 0 every 2 s for: GPU util, VRAM, temperature, board power draw.
// No sudo required on Linux — NVML reads through the kernel driver interface.
//
// Memory API selection — probed once at startup, held for the session lifetime:
//
//   V1       Standard discrete GPU (GeForce, RTX, A-series, H100, B100, B200…)
//            nvmlDeviceGetMemoryInfo works; reports dedicated GDDR/HBM directly.
//
//   V2(lib)  Hopper/Blackwell HBM systems where v1 returns NOT_SUPPORTED.
//            Uses nvmlDeviceGetMemoryInfo_v2 via the sys crate.
//
//   Unified  GB10 / DGX Spark — LPDDR5x unified memory, no dedicated VRAM
//            budget; nvidia-smi reports [N/A] for memory.total.  We instead:
//              • total  = system RAM (the full unified pool the GPU accesses)
//              • used   = sum of used_gpu_memory across running compute processes
//            This matches exactly what nvidia-smi shows per-process and gives
//            the fleet UI a meaningful VRAM utilisation signal.

pub(crate) fn start_nvidia_harvester() -> Arc<Mutex<NvidiaMetrics>> {
    let shared = Arc::new(Mutex::new(NvidiaMetrics::default()));

    #[cfg(any(all(target_os = "linux", not(target_env = "musl")), target_os = "windows"))]
    {
        let shared_clone = Arc::clone(&shared);
        tokio::spawn(async move {
            let nvml = match Nvml::init() {
                Ok(n) => n,
                Err(_) => return, // diagnostic already logged in run_startup_diagnostics
            };

            // ── One-time setup before the poll loop ───────────────────────────

            enum MemApi {
                V1,
                // Boxed: NvmlLib is a large table of fn pointers and would
                // otherwise dominate the enum's size (clippy::large_enum_variant).
                V2(Box<nvml_wrapper_sys::bindings::NvmlLib>),
                /// Unified-memory SoC: no discrete VRAM pool in NVML.
                /// `total_mb` is the system RAM total read once from /proc/meminfo
                /// (Linux) or GlobalMemoryStatusEx (Windows) — the full pool
                /// the GPU can access via NVLink-C2C or similar interconnects.
                Unified { total_mb: u64 },
            }

            let (gpu_name_cached, mem_api): (Option<String>, MemApi) = {
                let probe = nvml.device_by_index(0).ok();
                let name  = probe.as_ref().and_then(|d| d.name().ok());

                // System RAM total — used as the Unified pool denominator on
                // hardware where NVML reports no dedicated VRAM (GB10, etc.).
                // sysinfo is already a direct dependency and handles both Linux
                // (/proc/meminfo) and Windows (GlobalMemoryStatusEx) internally,
                // so no platform-specific code is needed here.
                let sys_total_mb: u64 = {
                    let mut sys = sysinfo::System::new();
                    sys.refresh_memory();
                    sys.total_memory() / 1_048_576
                };

                let api = match probe.as_ref().map(|d| d.memory_info()) {
                    // v1 works and reports a non-zero total → use it directly.
                    Some(Ok(mem)) if mem.total > 0 => MemApi::V1,
                    // v1 returned N/A or zero: try the v2 struct (Hopper / HBM Blackwell).
                    // If v2 also yields no data the device is a unified-memory SoC → Unified.
                    _ => match load_nvml_lib() {
                        Some(lib) if nvml_memory_v2(&lib, 0).is_some() => MemApi::V2(Box::new(lib)),
                        _ => MemApi::Unified { total_mb: sys_total_mb },
                    },
                };
                (name, api)
            };

            let mut interval = tokio::time::interval(Duration::from_secs(2));
            loop {
                interval.tick().await;

                let device = match nvml.device_by_index(0) {
                    Ok(d)  => d,
                    Err(_) => continue,
                };

                // Static properties — use the cached value, no NVML round-trip.
                let mut m = NvidiaMetrics { nvidia_gpu_name: gpu_name_cached.clone(), ..Default::default() };

                m.nvidia_gpu_utilization_percent =
                    device.utilization_rates().ok().map(|u| u.gpu as f32);

                // Memory — use whichever API was confirmed to work at startup.
                match &mem_api {
                    MemApi::V1 => {
                        if let Ok(mem) = device.memory_info() {
                            m.nvidia_vram_total_mb = Some(mem.total / 1_048_576);
                            m.nvidia_vram_used_mb  = Some(mem.used  / 1_048_576);
                        }
                    }
                    MemApi::V2(lib) => {
                        if let Some((total, used)) = nvml_memory_v2(lib, 0) {
                            m.nvidia_vram_total_mb = Some(total);
                            m.nvidia_vram_used_mb  = Some(used);
                        }
                    }
                    MemApi::Unified { total_mb } => {
                        // Sum GPU-resident allocations across all active compute
                        // processes.  This is the same accounting nvidia-smi uses
                        // to surface per-process memory on unified-memory SoCs.
                        use nvml_wrapper::enums::device::UsedGpuMemory;
                        let used_mb: u64 = device
                            .running_compute_processes()
                            .unwrap_or_default()
                            .iter()
                            .filter_map(|p| match p.used_gpu_memory {
                                UsedGpuMemory::Used(bytes) => Some(bytes / 1_048_576),
                                UsedGpuMemory::Unavailable => None,
                            })
                            .sum();
                        m.nvidia_vram_total_mb = Some(*total_mb);
                        m.nvidia_vram_used_mb  = Some(used_mb);
                    }
                }

                m.nvidia_gpu_temp_c =
                    device.temperature(TemperatureSensor::Gpu).ok();

                m.nvidia_power_draw_w =
                    device.power_usage().ok().map(|mw| mw as f32 / 1_000.0);

                // ── WES v2: NVML throttle-reason bitmask ─────────────────
                // Maps hardware clock-throttle reasons to a thermal penalty
                // factor. This is the most authoritative thermal signal on
                // NVIDIA hardware — no temperature inference required.
                //
                // Priority when multiple thermal bits are set: 2.5 (worst-case)
                //   HW_THERMAL_SLOWDOWN alone   → 2.0
                //   SW_THERMAL_SLOWDOWN alone   → 1.25
                //   HW_SLOWDOWN / HW_POWER_BRAKE alone → 1.25
                //   No throttle bits, temp ≥90°C → 1.1 (pre-throttle)
                //   No throttle bits, temp <90°C → 1.0 (healthy)
                if let Ok(reasons) = device.current_throttle_reasons() {
                    let hw_thermal  = reasons.contains(ThrottleReasons::HW_THERMAL_SLOWDOWN);
                    let sw_thermal  = reasons.contains(ThrottleReasons::SW_THERMAL_SLOWDOWN);
                    let hw_slowdown = reasons.contains(ThrottleReasons::HW_SLOWDOWN);
                    let pwr_brake   = reasons.contains(ThrottleReasons::HW_POWER_BRAKE_SLOWDOWN);

                    let thermal_count = [hw_thermal, sw_thermal, hw_slowdown, pwr_brake]
                        .iter()
                        .filter(|&&b| b)
                        .count();

                    let penalty: f32 = if thermal_count > 1 {
                        2.5
                    } else if hw_thermal {
                        2.0
                    } else if sw_thermal || hw_slowdown || pwr_brake {
                        1.25
                    } else {
                        // No throttle bits active — check pre-throttle threshold.
                        m.nvidia_gpu_temp_c
                            .map(|t| if t >= 90 { 1.1 } else { 1.0 })
                            .unwrap_or(1.0)
                    };

                    m.nvidia_throttle_penalty = Some(penalty);
                }

                // ── GPU clock throttle percentage ─────────────────────────────
                // (cur_graphics_mhz / max_graphics_mhz) → inverse is throttle %.
                // Zero-privilege; returns None on virtualised GPUs where clock
                // info is unavailable (safe — patterns gate on Some(_) density).
                if let (Ok(cur_mhz), Ok(max_mhz)) = (
                    device.clock_info(Clock::Graphics),
                    device.max_clock_info(Clock::Graphics),
                )
                    && max_mhz > 0 {
                        let ratio = cur_mhz as f32 / max_mhz as f32;
                        m.clock_throttle_pct = Some(((1.0 - ratio) * 100.0).clamp(0.0, 100.0));
                    }

                // ── PCIe link width ───────────────────────────────────────────
                // current_pcie_link_width() returns the negotiated lane count (1/4/8/16).
                // max_pcie_link_width() returns the maximum the card + slot support.
                // When current < max, the GPU is lane-degraded (wrong slot or failed lane).
                // Zero-privilege; returns NotSupported on virtualised guests.
                if let Ok(cur_w) = device.current_pcie_link_width() {
                    m.pcie_link_width = Some(cur_w);
                }
                if let Ok(max_w) = device.max_pcie_link_width() {
                    m.pcie_link_max_width = Some(max_w);
                }

                if let Ok(mut guard) = shared_clone.lock() {
                    *guard = m;
                }
            }
        });
    }

    shared
}

// ── Background Harvester ──────────────────────────────────────────────────────

/// Platform sensor harvester feeding `AppleSiliconMetrics`.
///
/// macOS: pmset / ioreg / vm_stat every 2 s + powermetrics every ~5 s.
/// Windows: WMI thermal zone only (the other fields have no Windows source).
/// Linux: nothing — every probe here is a macOS tool, and spawning them every
/// 2 s just to fail was pure overhead; Linux sensors have their own harvesters.
pub(crate) fn start_metrics_harvester() -> Arc<Mutex<AppleSiliconMetrics>> {
    let shared = Arc::new(Mutex::new(AppleSiliconMetrics::default()));

    #[cfg(target_os = "macos")]
    spawn_macos_metrics_harvester(Arc::clone(&shared));
    #[cfg(target_os = "windows")]
    spawn_windows_thermal_harvester(Arc::clone(&shared));

    shared
}

/// Windows thermal poll cadence. wmic is a heavyweight process spawn and
/// thermal zones move slowly, so there's no value in the 2 s macOS cadence.
#[cfg(target_os = "windows")]
pub(crate) const WMI_THERMAL_INTERVAL: Duration = Duration::from_secs(10);

/// Consecutive wmic failures after which the poller gives up for the life of
/// the process (wmic missing — it's deprecated/removed on newer Windows — or
/// MSAcpi_ThermalZoneTemperature unsupported/denied on this machine).
#[cfg(target_os = "windows")]
pub(crate) const WMI_MAX_CONSECUTIVE_FAILURES: u32 = 3;

#[cfg(target_os = "windows")]
pub(crate) fn spawn_windows_thermal_harvester(shared: Arc<Mutex<AppleSiliconMetrics>>) {
    tokio::spawn(async move {
        let mut failures = 0u32;
        let mut interval = tokio::time::interval(WMI_THERMAL_INTERVAL);
        loop {
            interval.tick().await;
            // wmic is a blocking std::process::Command — keep it off the
            // async workers.
            let state = tokio::task::spawn_blocking(read_thermal_wmi).await.ok().flatten();
            if state.is_some() { failures = 0; } else { failures += 1; }
            if let Ok(mut g) = shared.lock() { g.thermal_state = state; }
            if failures >= WMI_MAX_CONSECUTIVE_FAILURES {
                eprintln!("[thermal] WMI thermal zone unavailable — disabling Windows thermal polling");
                return;
            }
        }
    });
}

#[cfg(target_os = "macos")]
pub(crate) fn spawn_macos_metrics_harvester(shared_clone: Arc<Mutex<AppleSiliconMetrics>>) {
    tokio::spawn(async move {
        let chip_name = read_apple_chip_name().await;
        // Read once at startup — iogpu.wired_limit_mb reflects the hardware
        // budget, not runtime state. Apple Silicon only; None on Intel Macs.
        let wired_limit_mb = read_iogpu_wired_limit_mb();

        // powermetrics samples over a 5 s window (try_powermetrics_nosudo uses
        // `-i 5000`), so awaiting it inline would gate this whole loop to ~5 s and
        // staling the cheap thermal/GPU/memory reads. Run it on its own task and
        // have the 2 s loop below merge whatever the latest sample is.
        let pm_cache: Arc<Mutex<Option<AppleSiliconMetrics>>> = Arc::new(Mutex::new(None));
        {
            let pm_cache = Arc::clone(&pm_cache);
            tokio::spawn(async move {
                loop {
                    match try_powermetrics_nosudo().await {
                        // Success already blocked ~5 s, so this self-paces at ~5 s.
                        Some(pm) => { if let Ok(mut g) = pm_cache.lock() { *g = Some(pm); } }
                        // Unavailable (non-root / Intel Mac): returns fast — clear
                        // the cache and back off so we don't busy-spin.
                        None => {
                            if let Ok(mut g) = pm_cache.lock() { *g = None; }
                            tokio::time::sleep(Duration::from_secs(5)).await;
                        }
                    }
                }
            });
        }

        let mut interval = tokio::time::interval(Duration::from_secs(2));
        loop {
            interval.tick().await;

            let mut m = AppleSiliconMetrics {
                gpu_name:           chip_name.clone(),
                gpu_wired_limit_mb: wired_limit_mb,
                ..Default::default()
            };

            // 1. Thermal: sysctl (Intel) → pmset (M-series)
            m.thermal_state = read_thermal_sysctl();
            if m.thermal_state.is_none() {
                m.thermal_state = read_thermal_pmset().await;
            }

            // 2. GPU: IOAccelerator → IOGPUDevice (Apple Silicon AGX)
            m.gpu_utilization_percent = read_gpu_ioreg().await;

            // 3. Memory pressure via vm_stat (no sudo required)
            m.memory_pressure_percent = read_memory_pressure_vmstat().await;

            // 4. Power + thermal via powermetrics — read the latest sample from the
            //    background task (refreshed ~every 5 s) instead of blocking here.
            //    Copy all power fields: cpu, gpu, ane, and the combined SoC total.
            //    apple_soc_power_w (= soc_power_w) is the true ~13-20 W system draw
            //    during inference; cpu_power_w alone (~1.7-7 W) under-reports by 2-3×.
            let latest_pm = pm_cache.lock().ok().and_then(|g| g.clone());
            if let Some(pm) = latest_pm {
                m.cpu_power_w  = pm.cpu_power_w;
                m.ecpu_power_w = pm.ecpu_power_w;
                m.pcpu_power_w = pm.pcpu_power_w;
                m.gpu_power_w  = pm.gpu_power_w;  // GPU cluster power (W)
                m.ane_power_w  = pm.ane_power_w;  // Apple Neural Engine power (W)
                m.soc_power_w  = pm.soc_power_w;  // Combined SoC total — prefer this for WES
                if pm.memory_pressure_percent.is_some() {
                    m.memory_pressure_percent = pm.memory_pressure_percent;
                }
                if pm.thermal_state.is_some() { m.thermal_state = pm.thermal_state; }
                if m.gpu_utilization_percent.is_none() {
                    m.gpu_utilization_percent = pm.gpu_utilization_percent;
                }
            }

            if let Ok(mut guard) = shared_clone.lock() {
                *guard = m;
            }
        }
    });
}

// ── WES v2: Thermal Penalty Sampler ───────────────────────────────────────────
//
// Maps the current thermal_state string (or NVML bitmask result) to a numeric
// penalty factor, then maintains a 30-sample (60 s) rolling window per the WES v2
// spec. The window averages and peak are forwarded in every MetricsPayload.
//
// WES v2 penalty table (refined from v1 — Serious was 2.0, now 1.75):
//   Normal   → 1.00
//   Fair     → 1.25
//   Serious  → 1.75  ← changed from 2.0
//   Critical → 2.00
//
// Source tags:
//   "nvml"         — NVML throttle-reason bitmask (hardware-authoritative; NVIDIA only)
//   "iokit"        — macOS pmset / sysctl thermal level
//   "clock_ratio"  — AMD k10temp + scaling_cur_freq / cpuinfo_max_freq ratio
//   "sysfs"        — Linux /sys/class/thermal zone max (non-AMD fallback)
//   "unavailable"  — no thermal data on this platform

/// Resolve thermal state for the MetricsPayload, with idle CPU override.
///
/// When `thermal_source` is `clock_ratio` (Linux without hardware temp sensor),
/// low clock frequencies at idle are normal power-saving — NOT thermal throttling.
/// Force `Normal` when CPU usage is below 15% to avoid false thermal penalties.
#[cfg(target_os = "linux")]
pub(crate) fn resolve_thermal_state(
    apple_state: &Option<String>,
    linux_thermal: &Option<LinuxThermalResult>,
    cpu_usage_pct: f32,
) -> Option<String> {
    let raw = apple_state.clone()
        .or_else(|| linux_thermal.as_ref().map(|lt| lt.state.clone()));
    let is_clock_ratio = linux_thermal.as_ref()
        .is_some_and(|lt| lt.source == "clock_ratio");
    if is_clock_ratio && cpu_usage_pct < 15.0 && raw.as_deref() != Some("Normal") {
        Some("Normal".to_string())
    } else {
        raw
    }
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn resolve_thermal_state(
    apple_state: &Option<String>,
    linux_thermal: &Option<LinuxThermalResult>,
    cpu_usage_pct: f32,
) -> Option<String> {
    apple_state.clone()
        .or_else(|| linux_thermal.as_ref().map(|lt| {
            // Idle CPU override: clock_ratio at low CPU is frequency scaling, not throttle.
            // Must match the same logic in start_wes_sampler() so thermal_state and
            // penalty_avg stay consistent in the payload.
            if lt.source == "clock_ratio" && cpu_usage_pct < 15.0 {
                "Normal".to_string()
            } else {
                lt.state.clone()
            }
        }))
}

/// Maps a thermal-state string to the WES v2 penalty factor.
pub(crate) fn thermal_penalty_v2(state: &str) -> f32 {
    match state {
        "Critical" => 2.00,
        "Serious"  => 1.75,
        "Fair"     => 1.25,
        _          => 1.00,  // "Normal" and any unknown/empty value
    }
}

/// Snapshot of the WES thermal-penalty rolling window shared between the
/// sampler task and the 1 Hz broadcaster / SSE handler.
#[derive(Clone, Default)]
pub(crate) struct WesMetrics {
    /// Average thermal penalty over the last 30 samples (up to 60 s).
    /// None until the first sampler tick completes.
    pub(crate) penalty_avg:    Option<f32>,
    /// Peak (worst) penalty seen in the same window.
    pub(crate) penalty_peak:   Option<f32>,
    /// Source of the thermal data feeding this window.
    pub(crate) thermal_source: Option<String>,
    /// Number of samples currently in the window (1–30).
    pub(crate) sample_count:   u32,
}

/// Spawns a 2 s thermal-penalty sampling loop.
///
/// Priority (highest first):
///   1. `nvidia_metrics.nvidia_throttle_penalty` — NVML bitmask (authoritative)
///   2. `apple_metrics.thermal_state`            — macOS iokit
///   3. `linux_thermal_metrics`                  — Linux sysfs
///   4. Fallback: 1.0, source = "unavailable"
///
/// Maintains a `VecDeque` of up to 30 samples. Writes avg + peak + source + count
/// into the shared `WesMetrics` on every tick.
pub(crate) fn start_wes_sampler(
    apple_metrics:         Arc<Mutex<AppleSiliconMetrics>>,
    nvidia_metrics:        Arc<Mutex<NvidiaMetrics>>,
    linux_thermal_metrics: Arc<Mutex<Option<LinuxThermalResult>>>,
    cpu_usage_pct:         Arc<std::sync::atomic::AtomicU32>,  // IEEE f32 bits
) -> Arc<Mutex<WesMetrics>> {
    let shared = Arc::new(Mutex::new(WesMetrics::default()));
    let shared_clone = Arc::clone(&shared);

    tokio::spawn(async move {
        let mut window: std::collections::VecDeque<f32> =
            std::collections::VecDeque::with_capacity(30);

        let mut interval = tokio::time::interval(Duration::from_secs(2));
        // Discard the immediate first tick so the first real sample has data.
        interval.tick().await;

        loop {
            interval.tick().await;

            let nvidia = nvidia_metrics.lock().map(|g| g.clone()).unwrap_or_default();
            let apple  = apple_metrics.lock().map(|g| g.clone()).unwrap_or_default();
            let linux  = linux_thermal_metrics.lock().map(|g| g.clone()).unwrap_or(None);

            // Determine penalty + source (highest-quality source wins).
            // AMD clock_ratio path carries a direct_penalty (can exceed 2.0 for
            // severe throttle); sysfs path uses thermal_penalty_v2(state).
            let (penalty, source): (f32, &'static str) =
                if let Some(p) = nvidia.nvidia_throttle_penalty {
                    (p, "nvml")
                } else if let Some(ref state) = apple.thermal_state {
                    // macOS: pmset/sysctl. Windows: the platform harvester's
                    // WMI thermal-zone reading lands in the same field.
                    let src = if cfg!(target_os = "windows") { "wmi" } else { "iokit" };
                    (thermal_penalty_v2(state.as_str()), src)
                } else if let Some(ref lt) = linux {
                    let cpu_pct = f32::from_bits(cpu_usage_pct.load(std::sync::atomic::Ordering::Relaxed));
                    // Idle CPU override: clock_ratio at low CPU is frequency scaling, not throttle.
                    let p = if lt.source == "clock_ratio" && cpu_pct < 15.0 {
                        1.0
                    } else {
                        lt.direct_penalty.unwrap_or_else(|| thermal_penalty_v2(lt.state.as_str()))
                    };
                    (p, lt.source)
                } else {
                    (1.0, "unavailable")
                };

            // Rolling window: evict oldest sample when full.
            if window.len() >= 30 {
                window.pop_front();
            }
            window.push_back(penalty);

            let n   = window.len() as f32;
            let avg = window.iter().copied().sum::<f32>() / n;
            let peak = window.iter().copied().fold(f32::NEG_INFINITY, f32::max);

            // Round to 3 decimal places — avoids floating-point noise in JSON.
            let round3 = |v: f32| (v * 1_000.0).round() / 1_000.0;

            if let Ok(mut guard) = shared_clone.lock() {
                *guard = WesMetrics {
                    penalty_avg:    Some(round3(avg)),
                    penalty_peak:   Some(round3(peak)),
                    thermal_source: Some(source.to_string()),
                    sample_count:   window.len() as u32,
                };
            }
        }
    });

    shared
}
