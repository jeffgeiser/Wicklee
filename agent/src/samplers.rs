//! Background hardware samplers: NVIDIA/NVML harvester, Apple Silicon/Windows metric harvesters, WES thermal sampler.
//! Split out of main.rs; items are pub(crate) and re-exported at the crate root.

use super::*;

#[cfg(any(all(target_os = "linux", not(target_env = "musl")), target_os = "windows"))]
pub(crate) fn nvml_memory_v2(lib: &nvml_wrapper_sys::bindings::NvmlLib, device_index: u32) -> Option<(u64, u64)> {
    use std::mem;
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

#[cfg(any(all(target_os = "linux", not(target_env = "musl")), target_os = "windows"))]
pub(crate) fn load_nvml_lib() -> Option<nvml_wrapper_sys::bindings::NvmlLib> {
    use nvml_wrapper_sys::bindings::NvmlLib;

    #[cfg(target_os = "linux")]
    let names: &[&str] = &["libnvidia-ml.so.1", "libnvidia-ml.so"];
    #[cfg(target_os = "windows")]
    let names: &[&str] = &["nvml.dll"];

    names.iter().find_map(|n| unsafe { NvmlLib::new(n).ok() })
}

pub(crate) fn start_nvidia_harvester() -> Arc<Mutex<NvidiaMetrics>> {
    let shared = Arc::new(Mutex::new(NvidiaMetrics::default()));

    #[cfg(any(all(target_os = "linux", not(target_env = "musl")), target_os = "windows"))]
    {
        let shared_clone = Arc::clone(&shared);
        tokio::spawn(async move {
            let nvml = match Nvml::init() {
                Ok(n) => n,
                Err(_) => return,
            };

            enum MemApi {
                V1,
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

                let sys_total_mb: u64 = {
                    let mut sys = sysinfo::System::new();
                    sys.refresh_memory();
                    sys.total_memory() / 1_048_576
                };

                let api = match probe.as_ref().map(|d| d.memory_info()) {
                    Some(Ok(mem)) if mem.total > 0 => MemApi::V1,
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

                let mut m = NvidiaMetrics { nvidia_gpu_name: gpu_name_cached.clone(), ..Default::default() };

                m.nvidia_gpu_utilization_percent =
                    device.utilization_rates().ok().map(|u| u.gpu as f32);

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
                        m.nvidia_gpu_temp_c
                            .map(|t| if t >= 90 { 1.1 } else { 1.0 })
                            .unwrap_or(1.0)
                    };

                    m.nvidia_throttle_penalty = Some(penalty);
                }

                if let (Ok(cur_mhz), Ok(max_mhz)) = (
                    device.clock_info(Clock::Graphics),
                    device.max_clock_info(Clock::Graphics),
                )
                    && max_mhz > 0 {
                        let ratio = cur_mhz as f32 / max_mhz as f32;
                        m.clock_throttle_pct = Some(((1.0 - ratio) * 100.0).clamp(0.0, 100.0));
                    }

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
        let wired_limit_mb = read_iogpu_wired_limit_mb();

        let pm_cache: Arc<Mutex<Option<AppleSiliconMetrics>>> = Arc::new(Mutex::new(None));
        {
            let pm_cache = Arc::clone(&pm_cache);
            tokio::spawn(async move {
                loop {
                    match try_powermetrics_nosudo().await {
                        Some(pm) => { if let Ok(mut g) = pm_cache.lock() { *g = Some(pm); } }
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

            m.thermal_state = read_thermal_sysctl();
            if m.thermal_state.is_none() {
                m.thermal_state = read_thermal_pmset().await;
            }

            m.gpu_utilization_percent = read_gpu_ioreg().await;

            m.memory_pressure_percent = read_memory_pressure_vmstat().await;

            let latest_pm = pm_cache.lock().ok().and_then(|g| g.clone());
            if let Some(pm) = latest_pm {
                m.cpu_power_w  = pm.cpu_power_w;
                m.ecpu_power_w = pm.ecpu_power_w;
                m.pcpu_power_w = pm.pcpu_power_w;
                m.gpu_power_w  = pm.gpu_power_w;
                m.ane_power_w  = pm.ane_power_w;
                m.soc_power_w  = pm.soc_power_w;
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
        _          => 1.00,
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
    cpu_usage_pct:         Arc<std::sync::atomic::AtomicU32>,
) -> Arc<Mutex<WesMetrics>> {
    let shared = Arc::new(Mutex::new(WesMetrics::default()));
    let shared_clone = Arc::clone(&shared);

    tokio::spawn(async move {
        let mut window: std::collections::VecDeque<f32> =
            std::collections::VecDeque::with_capacity(30);

        let mut interval = tokio::time::interval(Duration::from_secs(2));
        interval.tick().await;

        loop {
            interval.tick().await;

            let nvidia = nvidia_metrics.lock().map(|g| g.clone()).unwrap_or_default();
            let apple  = apple_metrics.lock().map(|g| g.clone()).unwrap_or_default();
            let linux  = linux_thermal_metrics.lock().map(|g| g.clone()).unwrap_or(None);

            let (penalty, source): (f32, &'static str) =
                if let Some(p) = nvidia.nvidia_throttle_penalty {
                    (p, "nvml")
                } else if let Some(ref state) = apple.thermal_state {
                    // macOS: pmset/sysctl. Windows: the platform harvester's
                    let src = if cfg!(target_os = "windows") { "wmi" } else { "iokit" };
                    (thermal_penalty_v2(state.as_str()), src)
                } else if let Some(ref lt) = linux {
                    let cpu_pct = f32::from_bits(cpu_usage_pct.load(std::sync::atomic::Ordering::Relaxed));
                    let p = if lt.source == "clock_ratio" && cpu_pct < 15.0 {
                        1.0
                    } else {
                        lt.direct_penalty.unwrap_or_else(|| thermal_penalty_v2(lt.state.as_str()))
                    };
                    (p, lt.source)
                } else {
                    (1.0, "unavailable")
                };

            if window.len() >= 30 {
                window.pop_front();
            }
            window.push_back(penalty);

            let n   = window.len() as f32;
            let avg = window.iter().copied().sum::<f32>() / n;
            let peak = window.iter().copied().fold(f32::NEG_INFINITY, f32::max);

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
