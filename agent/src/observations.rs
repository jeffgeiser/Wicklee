//! Local observations: deployment profiles, the hardware pattern engine, bandwidth tables, GET /api/observations.
//! Split out of main.rs; items are pub(crate) and re-exported at the crate root.

use super::*;

// ── Local Observations (16 hardware patterns) ────────────────────────────────
//
// Server-side evaluation of 16 hardware-focused patterns against the 10-min
// DuckDB buffer. Returned by GET /api/observations for the localhost frontend
// and pushed to the cloud for fleet views via the observation cache.

/// Shared cache of the latest evaluated observations.  Written by the 10 s
/// observation evaluator task; read by cloud_push (embed in telemetry) and
/// handle_observations (GET /api/observations).
#[cfg(not(target_env = "musl"))]
pub(crate) type ObservationCache = Arc<Mutex<Vec<LocalObservation>>>;

#[cfg(not(target_env = "musl"))]
#[derive(Serialize, Clone)]
pub(crate) struct LocalObservation {
    pub(crate) pattern_id:       &'static str,
    pub(crate) severity:         &'static str,
    pub(crate) title:            String,
    pub(crate) hook:             String,
    pub(crate) body:             String,
    pub(crate) recommendation:   String,
    pub(crate) resolution_steps: Vec<String>,
    pub(crate) action_id:        &'static str,
    pub(crate) confidence:       &'static str,
    pub(crate) confidence_ratio: f64,
    pub(crate) first_fired_ms:   i64,
    pub(crate) node_id:          String,
    pub(crate) hostname:         String,
}

#[cfg(not(target_env = "musl"))]
impl LocalObservation {
    /// Machine-readable routing signal for agent/NRO consumers.
    /// Computed from pattern_id + severity — not stored, derived on access.
    pub(crate) fn routing_hint(&self) -> &'static str {
        routing_hint_for(self.pattern_id, self.severity)
    }
}

/// Map pattern + severity to a machine-readable routing signal.
#[cfg(not(target_env = "musl"))]
pub(crate) fn routing_hint_for(pattern_id: &str, severity: &str) -> &'static str {
    match (pattern_id, severity) {
        // Critical severity = steer away immediately
        (_, "critical") => "steer_away",
        // Patterns that indicate the node shouldn't receive new traffic
        ("thermal_drain", _) | ("nvidia_thermal_redline", _) | ("swap_io_pressure", _)
        | ("vram_overcommit", _) | ("bandwidth_saturation", _) => "steer_away",
        // Patterns that indicate reducing concurrency
        ("vllm_kv_cache_saturation", _) | ("vllm_queue_saturation", _)
        | ("ttft_regression", _) | ("latency_spike", _) | ("power_jitter", _) => "reduce_batch",
        // Patterns that indicate monitoring but node is still usable
        ("wes_velocity_drop", _) | ("memory_trajectory", _) | ("clock_drift", _)
        | ("efficiency_drag", _) | ("power_gpu_decoupling", _)
        | ("bandwidth_ceiling_reached", _) => "monitor",
        // Everything else (phantom_load, pcie_lane_degradation)
        _ => "monitor",
    }
}

/// PCIe state snapshot from live NvidiaMetrics (not stored in DuckDB).
#[cfg(not(target_env = "musl"))]
pub(crate) struct PcieSnapshot {
    pub(crate) link_width:     Option<u32>,
    pub(crate) link_max_width: Option<u32>,
}

// ── Pattern-engine math helpers ──────────────────────────────────────────────

pub(crate) fn obs_mean(values: &[f64]) -> f64 {
    if values.is_empty() { return 0.0; }
    values.iter().sum::<f64>() / values.len() as f64
}

pub(crate) fn obs_stddev(values: &[f64]) -> f64 {
    if values.len() < 2 { return 0.0; }
    let m = obs_mean(values);
    let var = values.iter().map(|&v| (v - m).powi(2)).sum::<f64>() / (values.len() - 1) as f64;
    var.sqrt()
}

/// Ordinary least-squares slope over an ordered series (index = x, value = y).
/// Returns units-per-sample; caller multiplies by samples/min to get per-minute slope.
pub(crate) fn obs_linear_slope(values: &[f64]) -> f64 {
    let n = values.len() as f64;
    if n < 2.0 { return 0.0; }
    let sum_x:  f64 = (0..values.len()).map(|i| i as f64).sum();
    let sum_y:  f64 = values.iter().sum();
    let sum_xy: f64 = values.iter().enumerate().map(|(i, &y)| i as f64 * y).sum();
    let sum_x2: f64 = (0..values.len()).map(|i| (i as f64).powi(2)).sum();
    let denom = n * sum_x2 - sum_x * sum_x;
    if denom.abs() < f64::EPSILON { 0.0 } else { (n * sum_xy - sum_x * sum_y) / denom }
}

pub(crate) fn obs_confidence(ratio: f64) -> &'static str {
    if ratio >= 0.9 { "high" } else if ratio >= 0.5 { "moderate" } else { "building" }
}

/// Deployment profile — a single intent declaration that coherently shifts
/// the sensitivity of every local observation pattern, replacing per-pattern
/// threshold knobs. Persisted in config.toml as `deployment_profile` and
/// switchable at runtime via PUT /api/deployment-profile.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum DeploymentProfile {
    /// Laptop / workstation running inference alongside other workloads.
    /// High evidence bar + confidence floor so mixed-use noise doesn't fire.
    SovereignDev,
    /// Single-purpose inference node — standard thresholds (the baseline the
    /// patterns were originally tuned for).
    DedicatedServer,
    /// Serving real users where latency matters — aggressive early warning:
    /// less sustained evidence required, so degradations surface sooner.
    ProductionFleet,
}

/// Coherent tuning knobs derived from a profile and applied at the chokepoints
/// shared by all patterns. `Copy` so it can be moved into the eval closure.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ProfileTuning {
    /// Multiplies the evidence-window density requirement every pattern derives
    /// from `min_density_5m` / `min_density_10m`. >1 demands more sustained
    /// data (conservative); <1 fires with less (aggressive).
    pub density_scale: f64,
    /// The sustained-fraction gate — the share of the window that must show the
    /// condition before a ratio-gated pattern fires (baseline 0.70).
    pub evidence_ratio: f64,
    /// Observations below this confidence_ratio are dropped before return.
    pub min_confidence: f64,
}

impl DeploymentProfile {
    pub(crate) fn from_config(s: Option<&str>) -> Self {
        match s {
            Some("sovereign_dev")    => DeploymentProfile::SovereignDev,
            Some("production_fleet") => DeploymentProfile::ProductionFleet,
            // None or "dedicated_server" or anything unrecognized → the safe default.
            _ => DeploymentProfile::DedicatedServer,
        }
    }

    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            DeploymentProfile::SovereignDev    => "sovereign_dev",
            DeploymentProfile::DedicatedServer => "dedicated_server",
            DeploymentProfile::ProductionFleet => "production_fleet",
        }
    }

    pub(crate) fn tuning(&self) -> ProfileTuning {
        match self {
            DeploymentProfile::SovereignDev =>
                ProfileTuning { density_scale: 1.15, evidence_ratio: 0.85, min_confidence: 0.50 },
            DeploymentProfile::DedicatedServer =>
                ProfileTuning { density_scale: 1.00, evidence_ratio: 0.70, min_confidence: 0.00 },
            DeploymentProfile::ProductionFleet =>
                ProfileTuning { density_scale: 0.65, evidence_ratio: 0.55, min_confidence: 0.00 },
        }
    }
}

/// Pure evaluation function — no side effects, no stored state.
/// Takes a 10-minute window of DuckDB samples + live PCIe state and returns
/// any observations that meet their gating criteria.
#[cfg(not(target_env = "musl"))]
pub(crate) fn evaluate_local_observations(
    samples:  &[store::ObsSample],
    pcie:     &PcieSnapshot,
    node_id:  &str,
    hostname: &str,
    tuning:   ProfileTuning,
) -> Vec<LocalObservation> {
    let mut obs = Vec::new();
    let now_ms = now_ms() as i64;

    // 5-minute window — used by patterns A/B/H/J/K. Density requirement is
    // scaled by the deployment profile so all patterns shift coherently.
    let min_density_5m = (210.0 * tuning.density_scale) as usize;   // baseline: 70% of 300s at 1 Hz
    let cutoff_5m = now_ms - 300_000_i64;
    let window: Vec<&store::ObsSample> = samples.iter()
        .filter(|s| s.ts_ms >= cutoff_5m)
        .collect();

    // 10-minute window — used by patterns C/F
    let min_density_10m = (420.0 * tuning.density_scale) as usize;  // baseline: 70% of 600s at 1 Hz
    let cutoff_10m = now_ms - 600_000_i64;
    let long_window: Vec<&store::ObsSample> = samples.iter()
        .filter(|s| s.ts_ms >= cutoff_10m)
        .collect();

    // ── Pattern A: Thermal Performance Drain ─────────────────────────────
    // thermal_state != "Normal" sustained 5 min + tok/s visible during window.
    // Hook: tok/s delta vs Normal-thermal baseline.
    if window.len() >= min_density_5m {
        let thermal_samples: Vec<&store::ObsSample> = window.iter()
            .filter(|s| s.thermal_state.as_deref().is_some_and(|t| t != "Normal"))
            .copied()
            .collect();
        let normal_samples: Vec<&store::ObsSample> = window.iter()
            .filter(|s| s.thermal_state.as_deref() == Some("Normal"))
            .copied()
            .collect();

        let thermal_ratio = thermal_samples.len() as f64 / window.len() as f64;

        if thermal_ratio >= tuning.evidence_ratio {
            // Compute tok/s means for throttled vs Normal baselines
            let throttled_tps: Vec<f64> = thermal_samples.iter()
                .filter_map(|s| s.tps)
                .filter(|t| *t > 0.0)
                .collect();
            let normal_tps: Vec<f64> = normal_samples.iter()
                .filter_map(|s| s.tps)
                .filter(|t| *t > 0.0)
                .collect();

            if !throttled_tps.is_empty() {
                let throttled_avg = throttled_tps.iter().sum::<f64>() / throttled_tps.len() as f64;
                let (hook, body, degradation_pct) = if !normal_tps.is_empty() {
                    let normal_avg = normal_tps.iter().sum::<f64>() / normal_tps.len() as f64;
                    let delta = normal_avg - throttled_avg;
                    let pct = if normal_avg > 0.0 { (delta / normal_avg) * 100.0 } else { 0.0 };
                    (
                        format!("-{:.1} tok/s ({:.0}% below Normal baseline)", delta.max(0.0), pct.max(0.0)),
                        format!(
                            "Thermal state has been elevated for {:.0}% of the last 5 minutes. \
                             Throughput averages {:.1} tok/s under thermal pressure vs {:.1} tok/s \
                             at Normal — a {:.0}% performance drain.",
                            thermal_ratio * 100.0, throttled_avg, normal_avg, pct.max(0.0),
                        ),
                        pct,
                    )
                } else {
                    // No Normal baseline — still report the throttle
                    (
                        format!("{:.1} tok/s under thermal pressure", throttled_avg),
                        format!(
                            "Thermal state has been elevated for {:.0}% of the last 5 minutes \
                             with no Normal-thermal baseline available for comparison. \
                             Current throughput: {:.1} tok/s.",
                            thermal_ratio * 100.0, throttled_avg,
                        ),
                        0.0,
                    )
                };

                // Only fire if degradation > 8% (spec threshold)
                if degradation_pct > 8.0 || normal_tps.is_empty() {
                    let confidence_ratio = (thermal_ratio).min(1.0);
                    obs.push(LocalObservation {
                        pattern_id:       "thermal_drain",
                        severity:         if degradation_pct > 20.0 { "critical" } else { "warning" },
                        title:            "Thermal Performance Drain".into(),
                        hook,
                        body,
                        recommendation:   "Reduce ambient temperature or improve airflow around the node. \
                                           If persistent, consider offloading inference to a cooler node."
                                           .into(),
                        resolution_steps: vec![
                            "Check ambient temperature and airflow around the machine".into(),
                            "Run: pmset -g therm (macOS) or check /sys/class/thermal (Linux)".into(),
                            "If model is large, consider a smaller quantization to reduce heat output".into(),
                        ],
                        action_id:        "check_thermal_zone",
                        confidence:       if confidence_ratio >= 0.9 { "high" } else if confidence_ratio >= 0.5 { "moderate" } else { "building" },
                        confidence_ratio,
                        first_fired_ms:   now_ms,
                        node_id:          node_id.into(),
                        hostname:         hostname.into(),
                    });
                }
            }
        }
    }

    // ── Pattern B: Phantom Load ──────────────────────────────────────────
    // Model loaded + power > 5W + tok/s < 0.5 for 5 min at 70% density.
    if window.len() >= min_density_5m {
        let phantom_samples: Vec<&store::ObsSample> = window.iter()
            .filter(|s| {
                let model_loaded = s.model.is_some();
                let power = s.gpu_power_w.or(s.cpu_power_w).unwrap_or(0.0);
                let tps = s.tps.unwrap_or(0.0);
                model_loaded && power > 5.0 && tps < 0.5
            })
            .copied()
            .collect();

        let phantom_ratio = phantom_samples.len() as f64 / window.len() as f64;

        if phantom_ratio >= tuning.evidence_ratio {
            let avg_watts: f64 = phantom_samples.iter()
                .filter_map(|s| s.gpu_power_w.or(s.cpu_power_w))
                .sum::<f64>() / phantom_samples.len().max(1) as f64;
            // Cost estimate: $/day at the fleet-wide default rate. Keep in
            // sync with cloud DEFAULT_KWH_RATE_USD and the frontend's
            // ELECTRICITY_RATE_USD_PER_KWH (utils/efficiency.ts) — all 0.16.
            let kwh_rate = 0.16;
            let cost_per_day = (avg_watts / 1000.0) * 24.0 * kwh_rate;
            let model_name = phantom_samples.last()
                .and_then(|s| s.model.as_deref())
                .unwrap_or("unknown");

            let confidence_ratio = phantom_ratio.min(1.0);
            obs.push(LocalObservation {
                pattern_id:       "phantom_load",
                severity:         "warning",
                title:            "Phantom Load Detected".into(),
                hook:             format!("-${:.2}/day · {:.0}W idle", cost_per_day, avg_watts),
                body:             format!(
                    "Model \"{}\" is loaded in VRAM and drawing {:.0}W with zero inference activity \
                     for the last 5 minutes. This is pure idle cost — {:.0}% of samples show \
                     no useful work being done.",
                    model_name, avg_watts, phantom_ratio * 100.0,
                ),
                recommendation:   "Unload the idle model to reclaim VRAM and reduce power draw. \
                                   If the model is needed soon, set a keep-alive timer instead."
                                   .into(),
                resolution_steps: vec![
                    format!("Run: ollama stop {}", model_name),
                    "Or: ollama ps  (verify model is still loaded)".into(),
                    "Consider: OLLAMA_KEEP_ALIVE=5m to auto-unload after inactivity".into(),
                ],
                action_id:        "investigate_phantom",
                confidence:       if confidence_ratio >= 0.9 { "high" } else if confidence_ratio >= 0.5 { "moderate" } else { "building" },
                confidence_ratio,
                first_fired_ms:   now_ms,
                node_id:          node_id.into(),
                hostname:         hostname.into(),
            });
        }
    }

    // ── Pattern J: Swap I/O Pressure ─────────────────────────────────────
    // swap_write_mb_s > 2.0 sustained 5 min.
    if window.len() >= min_density_5m {
        let swap_samples: Vec<&store::ObsSample> = window.iter()
            .filter(|s| s.swap_write_mb_s.unwrap_or(0.0) > 2.0)
            .copied()
            .collect();

        let swap_ratio = swap_samples.len() as f64 / window.len() as f64;

        if swap_ratio >= tuning.evidence_ratio {
            let avg_swap: f64 = swap_samples.iter()
                .filter_map(|s| s.swap_write_mb_s)
                .sum::<f64>() / swap_samples.len().max(1) as f64;
            let is_storm = avg_swap > 10.0;
            let avg_tps: Option<f64> = {
                let tps_vals: Vec<f64> = window.iter()
                    .filter_map(|s| s.tps)
                    .filter(|t| *t > 0.0)
                    .collect();
                if tps_vals.is_empty() { None } else { Some(tps_vals.iter().sum::<f64>() / tps_vals.len() as f64) }
            };

            let confidence_ratio = swap_ratio.min(1.0);
            obs.push(LocalObservation {
                pattern_id:       "swap_io_pressure",
                severity:         if is_storm { "critical" } else { "warning" },
                title:            if is_storm { "Swap Storm".into() } else { "Swap I/O Pressure".into() },
                hook:             format!(
                    "{:.1} MB/s swap{}",
                    avg_swap,
                    avg_tps.map(|t| format!(" · {:.1} tok/s", t)).unwrap_or_default(),
                ),
                body:             format!(
                    "Sustained swap write rate of {:.1} MB/s over {:.0}% of the last 5 minutes{}. \
                     Swap pressure forces the OS to page model weights to disk, dramatically \
                     increasing inference latency.",
                    avg_swap, swap_ratio * 100.0,
                    if is_storm { " — this is a swap storm (>10 MB/s)" } else { "" },
                ),
                recommendation:   "Reduce memory pressure by unloading idle models or switching to \
                                   a smaller quantization. If possible, add physical RAM."
                                   .into(),
                resolution_steps: vec![
                    "Run: ollama ps  (check loaded model count and VRAM usage)".into(),
                    "Evict idle models: ollama stop <model>".into(),
                    "Consider a smaller quantization (e.g., Q4_K_M → Q4_0)".into(),
                    "Monitor: vm_stat 1 (macOS) or vmstat 1 (Linux)".into(),
                ],
                action_id:        "evict_idle_models",
                confidence:       if confidence_ratio >= 0.9 { "high" } else if confidence_ratio >= 0.5 { "moderate" } else { "building" },
                confidence_ratio,
                first_fired_ms:   now_ms,
                node_id:          node_id.into(),
                hostname:         hostname.into(),
            });
        }
    }

    // ── Pattern L: PCIe Lane Degradation ─────────────────────────────────
    // Point-in-time: pcie_link_width < pcie_link_max_width (NVIDIA only).
    if let (Some(cur), Some(max)) = (pcie.link_width, pcie.link_max_width)
        && cur < max {
            obs.push(LocalObservation {
                pattern_id:       "pcie_lane_degradation",
                severity:         if cur <= max / 2 { "critical" } else { "warning" },
                title:            "PCIe Lane Degradation".into(),
                hook:             format!("x{} in x{} slot", cur, max),
                body:             format!(
                    "GPU is negotiating {} PCIe lanes but the slot supports {}. \
                     This reduces GPU↔CPU bandwidth by {:.0}%, which can bottleneck \
                     large model weight transfers and KV cache synchronisation.",
                    cur, max, (1.0 - cur as f64 / max as f64) * 100.0,
                ),
                recommendation:   "Reseat the GPU in its PCIe slot. Check for dust, bent pins, \
                                   or a loose riser cable. Verify BIOS PCIe settings."
                                   .into(),
                resolution_steps: vec![
                    "Power off and reseat the GPU in the PCIe slot".into(),
                    "Inspect the slot and card edge connector for debris or damage".into(),
                    "Check BIOS: ensure PCIe link speed is set to Auto or Gen4/Gen5".into(),
                    "Run: nvidia-smi -q -d PCIE  (confirm current negotiated width)".into(),
                ],
                action_id:        "check_power_limits",
                confidence:       "high",
                confidence_ratio: 1.0,
                first_fired_ms:   now_ms,
                node_id:          node_id.into(),
                hostname:         hostname.into(),
            });
        }

    // ── Pattern C: WES Velocity Drop ─────────────────────────────────────
    // Efficiency score declining before thermal state changes — early warning.
    // Window: 10 min; fires if WES slope < -0.5/min AND total drop > 10%.
    // Suppressed when thermal is already Serious/Critical (Pattern A covers it).
    if long_window.len() >= min_density_10m {
        // Compute WES per sample: tps / (power × penalty).  penalty defaults to 1.0.
        let wes_vals: Vec<f64> = long_window.iter()
            .filter_map(|s| {
                let tps   = s.tps?;
                let power = s.gpu_power_w.or(s.cpu_power_w)?;
                if power <= 0.0 { return None; }
                let penalty = s.penalty_avg.unwrap_or(1.0).max(1.0);
                Some(tps / (power * penalty))
            })
            .collect();

        let dense_enough = wes_vals.len() >= (min_density_10m as f64 * 0.7) as usize;
        let latest_thermal = long_window.last()
            .and_then(|s| s.thermal_state.as_deref());
        let is_already_hot = matches!(latest_thermal, Some("Serious") | Some("Critical"));

        if dense_enough && !is_already_hot {
            // At 1 Hz, 60 samples = 1 minute
            let slope_per_sample = obs_linear_slope(&wes_vals);
            let slope_per_min    = slope_per_sample * 60.0;

            if slope_per_min < -0.5 {
                let first_wes = wes_vals[0];
                let last_wes  = wes_vals[wes_vals.len() - 1];
                let drop_pct  = if first_wes > 0.0 { ((first_wes - last_wes) / first_wes) * 100.0 } else { 0.0 };

                if drop_pct >= 10.0 {
                    let minutes_to_half = if last_wes > 0.0 && slope_per_min < 0.0 {
                        Some((last_wes / 2.0) / slope_per_min.abs())
                    } else { None };
                    let observed_min = (wes_vals.len() as f64 / 60.0).round() as u64;
                    let ratio = ((wes_vals.len() as f64 / 60.0) / 10.0_f64).min(1.0);

                    let eta_note = match minutes_to_half {
                        Some(m) if m < 30.0 => format!(" WES may halve in ~{} min at this rate.", m.round() as u64),
                        _ => String::new(),
                    };

                    obs.push(LocalObservation {
                        pattern_id:       "wes_velocity_drop",
                        severity:         "warning",
                        title:            "WES Velocity Drop".into(),
                        hook:             format!("{:.1} WES/min · {:.0}% drop", slope_per_min, drop_pct),
                        body:             format!(
                            "{hostname}'s efficiency score has been declining at {:.1} WES/min for the \
                             last {observed_min} min ({:.0} → {:.0} WES). Thermal state has not yet \
                             changed — this is an early warning.{eta_note}",
                            slope_per_min.abs(), first_wes, last_wes,
                        ),
                        recommendation:   format!(
                            "Reduce workload on {hostname} now — check ambient temperature, competing \
                             background processes, and VRAM allocation.{eta_note}",
                        ),
                        resolution_steps: vec![
                            "Monitor WES: watch -n 30 \"curl -s http://localhost:7700/api/metrics/snapshot | jq '[.active_models[]? | {model, wes}]'\"".into(),
                            "Reduce OLLAMA_NUM_PARALLEL to 1 to slow the WES decline".into(),
                            "Check if background processes (backups, builds) started recently".into(),
                            "If WES drops below 5 within 5 min, treat as Pattern A — enact physical cooling".into(),
                        ],
                        action_id:        "check_thermal_zone",
                        confidence:       obs_confidence(ratio),
                        confidence_ratio: ratio,
                        first_fired_ms:   now_ms,
                        node_id:          node_id.into(),
                        hostname:         hostname.into(),
                    });
                }
            }
        }
    }

    // ── Pattern F: Memory Pressure Trajectory ────────────────────────────
    // Memory pressure climbing — projected to hit critical threshold.
    // Window: 10 min; fires if rising trend will hit 85% within 30 min.
    // Apple Silicon only (mem_pressure_pct not available on NVIDIA nodes).
    if long_window.len() >= min_density_10m {
        let mem_vals: Vec<f64> = long_window.iter()
            .filter_map(|s| s.mem_pressure_pct)
            .collect();

        let dense_enough = mem_vals.len() >= (min_density_10m as f64 * 0.7) as usize;

        if dense_enough {
            let current_mem = *mem_vals.last().unwrap();

            // Suppress if already critical — a separate MemoryExhaustionCard handles that
            if current_mem < 80.0 {
                let slope_per_sample = obs_linear_slope(&mem_vals);

                if slope_per_sample > 0.0 {
                    let slope_per_min = slope_per_sample * 60.0;
                    let headroom  = 85.0 - current_mem;
                    let eta_min   = headroom / slope_per_min;

                    if eta_min > 0.0 && eta_min <= 30.0 {
                        let eta_rounded = eta_min.round() as u64;
                        let ratio = ((mem_vals.len() as f64 / 60.0) / 10.0_f64).min(1.0);

                        obs.push(LocalObservation {
                            pattern_id:       "memory_trajectory",
                            severity:         "warning",
                            title:            "Memory Pressure Trajectory".into(),
                            hook:             format!("Critical in ~{eta_rounded}m"),
                            body:             format!(
                                "{hostname}'s memory pressure is rising at {slope_per_min:.1}%/min \
                                 (currently {current_mem:.0}%). At this rate it will hit the critical \
                                 threshold (85%) in ~{eta_rounded} min. Swap activity and inference \
                                 stalls follow immediately after.",
                            ),
                            recommendation:   "Unload the largest loaded model now to arrest the \
                                               pressure rise before swap activity begins. Run `ollama ps` \
                                               to identify the largest resident model and `ollama stop \
                                               <model>` to release it.".into(),
                            resolution_steps: vec![
                                "Check loaded models: `ollama ps` — note memory footprint of each".into(),
                                "Unload the largest model: `ollama stop <model-name>`".into(),
                                "Close memory-heavy background processes: browsers, IDEs, Docker".into(),
                                "Verify pressure decreasing: `curl http://localhost:7700/api/metrics/snapshot | jq .memory_pressure_percent`".into(),
                                "Prevent recurrence: set OLLAMA_MAX_LOADED_MODELS=1".into(),
                            ],
                            action_id:        "evict_idle_models",
                            confidence:       obs_confidence(ratio),
                            confidence_ratio: ratio,
                            first_fired_ms:   now_ms,
                            node_id:          node_id.into(),
                            hostname:         hostname.into(),
                        });
                    }
                }
            }
        }
    }

    // ── Pattern H: Power Jitter ───────────────────────────────────────────
    // Power draw CoV > 20% during active inference — PSU/VRM stress or thundering herd.
    // Window: 5 min; requires mean watts > 30 and mean tok/s > 0.5.
    if window.len() >= min_density_5m {
        let watts_vals: Vec<f64> = window.iter()
            .filter_map(|s| s.gpu_power_w.or(s.cpu_power_w))
            .collect();

        let dense_enough = watts_vals.len() >= (min_density_5m as f64 * 0.7) as usize;

        if dense_enough {
            let avg_watts = obs_mean(&watts_vals);

            if avg_watts >= 30.0 {
                let tps_vals: Vec<f64> = window.iter()
                    .filter_map(|s| s.tps)
                    .filter(|&t| t > 0.0)
                    .collect();
                let avg_tps = if tps_vals.is_empty() { 0.0 } else { obs_mean(&tps_vals) };

                if avg_tps >= 0.5 {
                    let sd  = obs_stddev(&watts_vals);
                    let cov = sd / avg_watts;

                    if cov >= 0.20 {
                        let tps_cov = if tps_vals.len() >= 3 {
                            obs_stddev(&tps_vals) / obs_mean(&tps_vals).max(f64::EPSILON)
                        } else { 0.0 };
                        let is_thundering_herd = tps_cov > 0.25;
                        let observed_min = 5_u64;
                        let ratio = (watts_vals.len() as f64 / (min_density_5m as f64 / 0.7)).min(1.0);

                        let recommendation = if is_thundering_herd {
                            format!(
                                "Power variance ({:.0}% CoV) coupled with throughput variance — consistent \
                                 with thundering herd load. Reduce OLLAMA_NUM_PARALLEL and introduce a \
                                 request queue to smooth bursty traffic.",
                                cov * 100.0,
                            )
                        } else {
                            format!(
                                "Power draw variance ({:.0}% CoV at {avg_watts:.0}W average) indicates \
                                 the GPU is cycling between saturation and near-idle. Check load balancer \
                                 dispatch for bursty traffic. Sustained dynamic load accelerates PSU/VRM wear.",
                                cov * 100.0,
                            )
                        };

                        obs.push(LocalObservation {
                            pattern_id:       "power_jitter",
                            severity:         "warning",
                            title:            "Power Jitter".into(),
                            hook:             format!(
                                "±{sd:.0}W · {:.0}% CoV{}",
                                cov * 100.0,
                                if is_thundering_herd { " · thundering herd" } else { "" },
                            ),
                            body:             format!(
                                "{hostname}'s power draw has a {:.0}% coefficient of variation \
                                 (±{sd:.0}W around {avg_watts:.0}W average) over the last \
                                 {observed_min} min.{} Stable inference has predictable power draw. \
                                 High variance is a leading indicator of PSU/VRM stress.",
                                cov * 100.0,
                                if is_thundering_herd {
                                    " Throughput variance is also elevated — the GPU is cycling \
                                     between full saturation and near-idle in sync with bursty batches."
                                } else { "" },
                            ),
                            recommendation,
                            resolution_steps: if is_thundering_herd { vec![
                                "Check load balancer — are requests arriving in synchronized waves?".into(),
                                "Add a request queue (FIFO dispatch) to smooth bursty traffic".into(),
                                "Reduce OLLAMA_NUM_PARALLEL to 1–2 to prevent excessive context switching".into(),
                                "Target < 15% CoV to confirm the fix worked".into(),
                            ]} else { vec![
                                "Verify PSU headroom: rated wattage should be ≥ 20% above peak draw".into(),
                                "Check VRM temperatures if sensors available — target < 85°C under load".into(),
                                "Reduce inference concurrency: set OLLAMA_NUM_PARALLEL=1".into(),
                                "Check for bursty workload patterns — add client-side request smoothing".into(),
                            ]},
                            action_id:        "reduce_batch_size",
                            confidence:       obs_confidence(ratio),
                            confidence_ratio: ratio,
                            first_fired_ms:   now_ms,
                            node_id:          node_id.into(),
                            hostname:         hostname.into(),
                        });
                    }
                }
            }
        }
    }

    // ── Pattern K: Clock Drift ────────────────────────────────────────────
    // GPU clocks throttled during inference despite Normal thermals — power cap or driver limit.
    // Window: 5 min; fires if avg throttle > 15% with tps > 0.5 and Normal thermals.
    if window.len() >= min_density_5m {
        let clock_vals: Vec<f64> = window.iter()
            .filter_map(|s| s.clock_throttle_pct)
            .collect();

        let dense_enough = clock_vals.len() >= (min_density_5m as f64 * 0.7) as usize;

        if dense_enough {
            let avg_throttle = obs_mean(&clock_vals);

            if avg_throttle >= 15.0 {
                let tps_vals: Vec<f64> = window.iter()
                    .filter_map(|s| s.tps)
                    .filter(|&t| t > 0.0)
                    .collect();
                let avg_tps = if tps_vals.is_empty() { 0.0 } else { obs_mean(&tps_vals) };

                if avg_tps >= 0.5 {
                    // Only fire when thermals are Normal — Pattern A covers hot+throttled
                    let hot_count = window.iter()
                        .filter(|s| s.thermal_state.as_deref().is_some_and(|t| t != "Normal"))
                        .count();
                    let hot_ratio = hot_count as f64 / window.len() as f64;

                    if hot_ratio <= 0.30 {
                        let is_severe   = avg_throttle >= 35.0;
                        let speed_pct   = 100.0 - avg_throttle;
                        let implied_tps = if avg_throttle > 0.0 {
                            Some(avg_tps / (speed_pct / 100.0))
                        } else { None };
                        let ratio = (clock_vals.len() as f64 / (min_density_5m as f64 / 0.7)).min(1.0);

                        obs.push(LocalObservation {
                            pattern_id:       "clock_drift",
                            severity:         if is_severe { "critical" } else { "warning" },
                            title:            if is_severe {
                                "Severe Clock Throttle During Inference".into()
                            } else {
                                "Clock Drift During Inference".into()
                            },
                            hook:             format!(
                                "{avg_throttle:.0}% throttled · running at {speed_pct:.0}% of rated clock · {avg_tps:.1} tok/s",
                            ),
                            body:             format!(
                                "{hostname} is sustaining {avg_throttle:.0}% clock throttling while \
                                 inference is active, despite Normal thermal state. Running at {speed_pct:.0}% \
                                 of rated frequency — due to a power limit, BIOS cap, or OS power governor.{}\
                                 {}",
                                implied_tps.map(|t| format!(" At full clock speed, throughput would be ~{t:.1} tok/s (current: {avg_tps:.1}).")).unwrap_or_default(),
                                if is_severe { " At this throttle level, hardware is significantly underperforming spec." } else { "" },
                            ),
                            recommendation:   "Check and lift the power limit or clock cap constraining \
                                               this node. On Linux, set the CPU governor to `performance`. \
                                               On Apple Silicon, ensure AC power with Performance mode enabled.".into(),
                            resolution_steps: vec![
                                "Verify throttle: `curl http://localhost:7700/api/metrics/snapshot | jq .clock_throttle_pct`".into(),
                                "Linux CPU governor: `sudo cpupower frequency-set -g performance`".into(),
                                "NVIDIA: `nvidia-smi -q -d CLOCK | grep -A4 'Clocks Throttle'`".into(),
                                "Apple Silicon: System Settings → Battery → Options → disable 'Limit CPU speed'".into(),
                            ],
                            action_id:        "check_power_limits",
                            confidence:       obs_confidence(ratio),
                            confidence_ratio: ratio,
                            first_fired_ms:   now_ms,
                            node_id:          node_id.into(),
                            hostname:         hostname.into(),
                        });
                    }
                }
            }
        }
    }

    // ── Pattern N: NVIDIA Thermal Redline ────────────────────────────────
    // NVIDIA GPU temperature above safe operating range.
    // Dual-path: sustained >85°C for 2 min (warning) OR instantaneous >90°C (critical).
    {
        // Instantaneous path: latest sample > 90°C
        let instant_temp: Option<i32> = window.last()
            .and_then(|s| s.nvidia_gpu_temp_c)
            .filter(|&t| t > 90);

        // Sustained path: >85°C for 2 min (120 samples), 70% density
        let sustained_result: Option<(f64, f64)> = {
            let temp_samples: Vec<i32> = window.iter()
                .filter_map(|s| s.nvidia_gpu_temp_c)
                .collect();
            if temp_samples.len() >= 84 {  // 70% of 120
                let hot_samples: Vec<f64> = temp_samples.iter()
                    .filter(|&&t| t > 85)
                    .map(|&t| t as f64)
                    .collect();
                if hot_samples.len() >= (temp_samples.len() as f64 * 0.70) as usize {
                    let avg = obs_mean(&hot_samples);
                    let ratio = (temp_samples.len() as f64 / 120.0).min(1.0);
                    Some((avg, ratio))
                } else { None }
            } else { None }
        };

        if instant_temp.is_some() || sustained_result.is_some() {
            let (temp, is_critical, confidence_ratio) = if let Some(t) = instant_temp {
                (t as f64, true, 1.0_f64)
            } else {
                let (avg, ratio) = sustained_result.unwrap();
                (avg, avg > 90.0, ratio)
            };

            obs.push(LocalObservation {
                pattern_id:       "nvidia_thermal_redline",
                severity:         if is_critical { "critical" } else { "warning" },
                title:            if is_critical {
                    "NVIDIA GPU Critical Temperature".into()
                } else {
                    "NVIDIA GPU Thermal Redline".into()
                },
                hook:             format!("{temp:.0}°C GPU temperature"),
                body:             if is_critical {
                    format!(
                        "{hostname}'s NVIDIA GPU is at {temp:.0}°C — exceeding the 90°C critical \
                         threshold. The driver will aggressively throttle clocks and may shut down \
                         the GPU to prevent damage.",
                    )
                } else {
                    format!(
                        "{hostname}'s NVIDIA GPU is sustained above 85°C. Thermal throttling \
                         reduces clock frequency and inference throughput progressively.",
                    )
                },
                recommendation:   if is_critical {
                    "Immediately reduce GPU load: stop inference, check fan operation, and verify \
                     airflow. If temperature doesn't drop within 60 seconds, power off to prevent \
                     hardware damage.".into()
                } else {
                    "Check case airflow and fan curves. Consider lowering the power limit with \
                     `nvidia-smi -pl` to reduce thermal output.".into()
                },
                resolution_steps: vec![
                    "Check temperature and throttle: `nvidia-smi --query-gpu=temperature.gpu,clocks_throttle_reasons.active --format=csv,noheader`".into(),
                    "Verify fan: `nvidia-smi --query-gpu=fan.speed --format=csv,noheader` — 0% may indicate failed fan".into(),
                    "Lower power limit: `sudo nvidia-smi -pl <watts>` (try 80% of TDP)".into(),
                    "Check ambient temperature and dust buildup on heatsink".into(),
                ],
                action_id:        "check_thermal_zone",
                confidence:       obs_confidence(confidence_ratio),
                confidence_ratio,
                first_fired_ms:   now_ms,
                node_id:          node_id.into(),
                hostname:         hostname.into(),
            });
        }
    }

    // ── Pattern D: Power-GPU Decoupling ──────────────────────────────────
    // High watts + active inference + low GPU utilization.
    // Inference is CPU-bound or memory-bound, not GPU-bound.
    // Uses 5-min window; requires gpu_util_pct data.
    {
        let min_gpu_density = (min_density_5m as f64 * 0.7) as usize;
        let gpu_count = window.iter().filter(|s| s.gpu_util_pct.is_some()).count();

        if gpu_count >= min_gpu_density {
            // Qualifying samples: high watts + inference active + low GPU util
            let decoupled: Vec<&&store::ObsSample> = window.iter()
                .filter(|s| {
                    let watts = s.gpu_power_w.unwrap_or(0.0) + s.cpu_power_w.unwrap_or(0.0);
                    watts > 50.0
                        && s.tps.unwrap_or(0.0) > 0.0
                        && s.gpu_util_pct.unwrap_or(100.0) < 20.0
                })
                .collect();

            let min_decoupled = (min_density_5m as f64 * 0.6) as usize;
            if decoupled.len() >= min_decoupled {
                let watts_vals: Vec<f64> = decoupled.iter()
                    .map(|s| s.gpu_power_w.unwrap_or(0.0) + s.cpu_power_w.unwrap_or(0.0))
                    .collect();
                let gpu_util_vals: Vec<f64> = decoupled.iter()
                    .filter_map(|s| s.gpu_util_pct)
                    .collect();
                let tps_vals: Vec<f64> = decoupled.iter()
                    .filter_map(|s| s.tps)
                    .collect();

                let avg_watts    = obs_mean(&watts_vals);
                let avg_gpu_util = if gpu_util_vals.is_empty() { 0.0 } else { obs_mean(&gpu_util_vals) };
                let avg_tps      = if tps_vals.is_empty() { 0.0 } else { obs_mean(&tps_vals) };
                let ratio        = (decoupled.len() as f64 / min_density_5m as f64).min(1.0);

                obs.push(LocalObservation {
                    pattern_id:       "power_gpu_decoupling",
                    severity:         "warning",
                    title:            "Power-GPU Decoupling".into(),
                    hook:             format!("{avg_gpu_util:.0}% GPU · {avg_watts:.0}W"),
                    body:             format!(
                        "{hostname} is drawing {avg_watts:.0}W and generating {avg_tps:.1} tok/s, \
                         but GPU utilization is only {avg_gpu_util:.0}% — significantly below what \
                         the power draw suggests. Inference appears CPU-bound or memory-bound. \
                         Common causes: large context window filling KV cache, CPU-offloaded layers \
                         in a mixed quantization, or a batch size too small to saturate GPU SIMD lanes.",
                    ),
                    recommendation:   "Try reducing concurrent context length or switching to a \
                                       quantization with fewer CPU-offloaded layers (e.g. Q4_K_M over \
                                       Q2_K). If using vLLM, tune --max-num-batched-tokens to the \
                                       GPU-saturating sweet spot.".into(),
                    resolution_steps: vec![
                        "Check GPU util: `curl http://localhost:7700/api/metrics/snapshot | jq '{gpu_util:.nvidia_gpu_utilization_percent,cpu_w:.cpu_power_w,tok_s:.ollama_tokens_per_second}'`".into(),
                        "Set all layers to GPU: OLLAMA_NUM_GPU=99 ollama serve".into(),
                        "Switch to Q4_K_M: `ollama pull <model>:q4_K_M` — fully GPU-offloads vs Q2_K".into(),
                        "For vLLM: raise --max-num-seqs to create batches that saturate GPU SIMD lanes".into(),
                        "Trim max_tokens in your app — KV cache fills CPU memory when context > VRAM".into(),
                    ],
                    action_id:        "reduce_batch_size",
                    confidence:       obs_confidence(ratio),
                    confidence_ratio: ratio,
                    first_fired_ms:   now_ms,
                    node_id:          node_id.into(),
                    hostname:         hostname.into(),
                });
            }
        }
    }

    // ── Pattern G: Bandwidth Saturation ──────────────────────────────────
    // GPU compute utilization is low despite active inference and high memory
    // pressure — the GPU cores are stalled waiting for weights from VRAM/memory bus.
    // Uses 5-min window for recent state; 10-min window for WES session peak.
    {
        let min_gpu_density = (min_density_5m as f64 * 0.7) as usize;
        let gpu_samples: Vec<&&store::ObsSample> = window.iter()
            .filter(|s| s.gpu_util_pct.is_some())
            .collect();

        if gpu_samples.len() >= min_gpu_density {
            let avg_gpu_util: f64 = {
                let v: Vec<f64> = gpu_samples.iter().filter_map(|s| s.gpu_util_pct).collect();
                if v.is_empty() { 100.0 } else { obs_mean(&v) }
            };
            let tps_vals: Vec<f64> = window.iter().filter_map(|s| s.tps).collect();
            let avg_tps = if tps_vals.is_empty() { 0.0 } else { obs_mean(&tps_vals) };

            // GPU compute must be low AND inference active
            if avg_gpu_util < 45.0 && avg_tps >= 0.5 {
                // Thermals must be Normal — not a thermal issue
                let hot_count = window.iter()
                    .filter(|s| s.thermal_state.as_deref().map(|t| t != "Normal").unwrap_or(false))
                    .count();
                let hot_limit = (min_density_5m as f64 * 0.3) as usize;

                if hot_count <= hot_limit {
                    // Memory pressure: VRAM path (NVIDIA) or unified memory (Apple Silicon)
                    let vram_samples: Vec<&&store::ObsSample> = window.iter()
                        .filter(|s| s.vram_used_mb.is_some() && s.vram_total_mb.map(|v| v > 0).unwrap_or(false))
                        .collect();
                    let vram_density = (min_density_5m as f64 * 0.5) as usize;

                    let (mem_pressure_ok, vram_pct_display, mem_label) =
                        if vram_samples.len() >= vram_density {
                            let avg_vram_pct: f64 = {
                                let v: Vec<f64> = vram_samples.iter()
                                    .map(|s| s.vram_used_mb.unwrap() as f64 / s.vram_total_mb.unwrap() as f64 * 100.0)
                                    .collect();
                                obs_mean(&v)
                            };
                            (avg_vram_pct >= 80.0, avg_vram_pct, "VRAM")
                        } else {
                            let mem_vals: Vec<f64> = window.iter()
                                .filter_map(|s| s.mem_pressure_pct)
                                .collect();
                            if mem_vals.len() >= vram_density {
                                let avg_mem = obs_mean(&mem_vals);
                                (avg_mem >= 70.0, avg_mem, "memory")
                            } else {
                                (false, 0.0, "memory")
                            }
                        };

                    if mem_pressure_ok {
                        // WES drop: compare 10-min session peak vs 5-min recent
                        let compute_wes = |s: &&store::ObsSample| -> Option<f64> {
                            let tps = s.tps.filter(|&t| t > 0.0)?;
                            let watts = s.gpu_power_w.unwrap_or(0.0) + s.cpu_power_w.unwrap_or(0.0);
                            if watts <= 0.0 { return None; }
                            let penalty = s.penalty_avg.unwrap_or(1.0);
                            Some(tps / (watts * penalty))
                        };

                        let session_wes: Vec<f64> = long_window.iter().filter_map(compute_wes).collect();
                        let recent_wes:  Vec<f64> = window.iter().filter_map(compute_wes).collect();

                        if session_wes.len() >= 5 && recent_wes.len() >= (min_density_5m as f64 * 0.5) as usize {
                            let peak_wes   = session_wes.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                            let recent_avg = obs_mean(&recent_wes);
                            let wes_drop   = if peak_wes > 0.0 { (peak_wes - recent_avg) / peak_wes * 100.0 } else { 0.0 };

                            if wes_drop >= 35.0 {
                                let ratio = (gpu_samples.len() as f64 / min_density_5m as f64).min(1.0);
                                obs.push(LocalObservation {
                                    pattern_id:       "bandwidth_saturation",
                                    severity:         "warning",
                                    title:            "Bandwidth Saturation".into(),
                                    hook:             format!("{avg_gpu_util:.0}% GPU · {vram_pct_display:.0}% {mem_label} · −{wes_drop:.0}% WES"),
                                    body:             format!(
                                        "{hostname} is generating {avg_tps:.1} tok/s at only \
                                         {avg_gpu_util:.0}% GPU utilization with {vram_pct_display:.0}% \
                                         {mem_label} occupied. Thermals are Normal — the GPU cores are \
                                         idle waiting for model weight data from {mem_label}, not blocked \
                                         by compute or temperature. WES has dropped {wes_drop:.0}% from \
                                         its session peak. This is the {mem_label} bandwidth ceiling: \
                                         model weights saturate the bus faster than the GPU can consume them.",
                                    ),
                                    recommendation:   format!(
                                        "Reduce quantization (e.g. Q8 → Q4) to cut {mem_label} bandwidth \
                                         demand by ~50%, or switch to a lower parameter count model to \
                                         recover throughput.",
                                    ),
                                    resolution_steps: vec![
                                        "Confirm bottleneck: `curl http://localhost:7700/api/metrics/snapshot | jq '{gpu_util:.nvidia_gpu_utilization_percent,vram_used:.nvidia_vram_used_mb,vram_total:.nvidia_vram_total_mb}'`".into(),
                                        "Switch to lower quantization to halve bandwidth demand: `ollama pull <model>:q4_K_M`".into(),
                                        "If already on Q4, try Q3_K_M or Q2_K — quality trade-off worth the bandwidth recovery".into(),
                                        "Reduce context window size — longer contexts increase KV cache weight streaming".into(),
                                        "Consider a hardware upgrade to a node with higher memory bandwidth for sustained relief".into(),
                                    ],
                                    action_id:        "switch_quantization",
                                    confidence:       obs_confidence(ratio),
                                    confidence_ratio: ratio,
                                    first_fired_ms:   now_ms,
                                    node_id:          node_id.into(),
                                    hostname:         hostname.into(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // ── Pattern I: Efficiency Penalty Drag ───────────────────────────────
    // WES penalty_avg is persistently elevated despite Normal thermals and active
    // GPU — indicates workload configuration overhead (context length, batch
    // fragmentation, KV cache pressure, MoE routing overhead).
    // Requires penalty_avg data (written by agent since Phase 2 migration).
    {
        let penalty_vals: Vec<f64> = window.iter().filter_map(|s| s.penalty_avg).collect();
        let min_pen_density = (min_density_5m as f64 * 0.7) as usize;

        if penalty_vals.len() >= min_pen_density {
            let avg_multiplier = obs_mean(&penalty_vals);
            // multiplier 1.0 = no penalty; skip early if no real overhead
            if avg_multiplier > 1.0 {
                // Efficiency loss fraction: 1 - (1/multiplier)
                // e.g. multiplier 1.75 → 43% loss
                let avg_penalty = 1.0 - (1.0 / avg_multiplier);

                if avg_penalty >= 0.30 {
                    let tps_vals: Vec<f64> = window.iter().filter_map(|s| s.tps).collect();
                    let avg_tps = if tps_vals.is_empty() { 0.0 } else { obs_mean(&tps_vals) };

                    if avg_tps >= 0.5 {
                        // Thermals must be Normal
                        let hot_count = window.iter()
                            .filter(|s| s.thermal_state.as_deref().map(|t| t != "Normal").unwrap_or(false))
                            .count();
                        let hot_limit = (min_density_5m as f64 * 0.3) as usize;

                        // GPU must be working (not decoupled — Pattern D territory)
                        let gpu_vals: Vec<f64> = window.iter().filter_map(|s| s.gpu_util_pct).collect();
                        let avg_gpu = if gpu_vals.len() >= (min_density_5m as f64 * 0.5) as usize {
                            obs_mean(&gpu_vals)
                        } else { 50.0 }; // assume ok if no GPU data

                        // Not memory-bound (not Pattern F or G territory)
                        let mem_vals: Vec<f64> = window.iter().filter_map(|s| s.mem_pressure_pct).collect();
                        let avg_mem = if mem_vals.is_empty() { 0.0 } else { obs_mean(&mem_vals) };

                        let vram_samples: Vec<&&store::ObsSample> = window.iter()
                            .filter(|s| s.vram_used_mb.is_some() && s.vram_total_mb.map(|v| v > 0).unwrap_or(false))
                            .collect();
                        let avg_vram_pct = if vram_samples.len() >= (min_density_5m as f64 * 0.5) as usize {
                            let v: Vec<f64> = vram_samples.iter()
                                .map(|s| s.vram_used_mb.unwrap() as f64 / s.vram_total_mb.unwrap() as f64 * 100.0)
                                .collect();
                            obs_mean(&v)
                        } else { 0.0 };

                        if hot_count <= hot_limit && avg_gpu >= 30.0 && avg_mem < 75.0 && avg_vram_pct < 80.0 {
                            let penalty_pct = (avg_penalty * 100.0) as u32;
                            let lost_tok_s  = avg_tps * (avg_multiplier - 1.0);

                            // Implied max WES without penalty
                            let wes_vals: Vec<f64> = window.iter()
                                .filter_map(|s| {
                                    let tps = s.tps.filter(|&t| t > 0.0)?;
                                    let watts = s.gpu_power_w.unwrap_or(0.0) + s.cpu_power_w.unwrap_or(0.0);
                                    if watts <= 0.0 { return None; }
                                    Some(tps / (watts * s.penalty_avg.unwrap_or(1.0)))
                                })
                                .collect();
                            let avg_wes     = if wes_vals.is_empty() { None } else { Some(obs_mean(&wes_vals)) };
                            let implied_max = avg_wes.map(|w| w * avg_multiplier);

                            let ratio = (penalty_vals.len() as f64 / min_density_5m as f64).min(1.0);
                            obs.push(LocalObservation {
                                pattern_id:       "efficiency_drag",
                                severity:         "warning",
                                title:            "Efficiency Penalty Drag".into(),
                                hook:             format!("{penalty_pct}% WES penalty · {lost_tok_s:.1} tok/s headroom being lost"),
                                body:             format!(
                                    "{hostname} is sustaining a {penalty_pct}% WES efficiency penalty \
                                     despite Normal thermals, active GPU utilization, and no memory \
                                     saturation. The penalty_avg field captures overhead not caused by \
                                     heat or bandwidth — context window size, batch fragmentation, \
                                     KV cache pressure, or expert routing overhead in MoE models.{}",
                                    match implied_max.zip(avg_wes) {
                                        Some((imp, cur)) => format!(" Without this penalty, WES would be ~{imp:.0} (current: {cur:.0})."),
                                        None => String::new(),
                                    }
                                ),
                                recommendation:   "This penalty is recoverable through workload \
                                                   configuration. Reduce maximum context window to the \
                                                   shortest that meets quality needs, and increase batch \
                                                   concurrency slightly to better saturate the GPU pipeline. \
                                                   If using a MoE model (e.g. Mixtral), ensure all experts \
                                                   are VRAM-resident.".into(),
                                resolution_steps: vec![
                                    "Check penalty: `curl http://localhost:7700/api/metrics/snapshot | jq .penalty_avg` — confirm consistently > 1.30".into(),
                                    "Reduce context window: lower max_tokens or num_ctx to 2048–4096 in your application".into(),
                                    "Increase batch slightly: OLLAMA_NUM_PARALLEL=2 (more concurrent reqs fill GPU pipeline bubbles)".into(),
                                    "MoE models (Mixtral, Qwen-MoE): verify all expert weights are VRAM-resident with `ollama ps`".into(),
                                    "vLLM: enable --enable-chunked-prefill to reduce KV cache fragmentation from variable-length requests".into(),
                                ],
                                action_id:        "reduce_batch_size",
                                confidence:       obs_confidence(ratio),
                                confidence_ratio: ratio,
                                first_fired_ms:   now_ms,
                                node_id:          node_id.into(),
                                hostname:         hostname.into(),
                            });
                        }
                    }
                }
            }
        }
    }

    // ── Pattern M: vLLM KV Cache Saturation ──────────────────────────────
    // vLLM's KV cache is persistently full — the scheduler cannot admit new
    // sequences; requests queue, get preempted, or return 503.
    // Uses 5-min window; only fires on nodes running vLLM (field is None elsewhere).
    {
        let cache_vals: Vec<f64> = window.iter()
            .filter_map(|s| s.vllm_cache_usage_perc)
            .collect();
        let min_cache_density = (min_density_5m as f64 * 0.7) as usize;

        if cache_vals.len() >= min_cache_density {
            let saturated_count = cache_vals.iter().filter(|&&v| v > 90.0).count();
            let min_saturated   = (cache_vals.len() as f64 * 0.7) as usize;

            if saturated_count >= min_saturated {
                let avg_cache: f64 = cache_vals.iter()
                    .filter(|&&v| v > 90.0)
                    .sum::<f64>() / saturated_count as f64;

                // Check for back-pressure from queue_depth
                let queue_vals: Vec<f64> = window.iter()
                    .filter_map(|s| s.queue_depth.filter(|&q| q > 0).map(|q| q as f64))
                    .collect();
                let avg_queue = if queue_vals.is_empty() { 0.0 } else { obs_mean(&queue_vals) };

                let ratio = (cache_vals.len() as f64 / min_density_5m as f64).min(1.0);
                obs.push(LocalObservation {
                    pattern_id:       "vllm_kv_cache_saturation",
                    severity:         "warning",
                    title:            "vLLM KV Cache Saturation".into(),
                    hook:             format!("{avg_cache:.0}% KV cache full"),
                    body:             format!(
                        "{hostname}'s vLLM KV cache has been above 90% for the last 5 min \
                         (avg {avg_cache:.1}%). When the cache fills, the scheduler cannot \
                         admit new sequences — incoming requests queue, get preempted, or \
                         return 503.{}",
                        if avg_queue > 0.0 {
                            format!(" Currently {avg_queue:.0} requests queued on average — confirming back-pressure.")
                        } else { String::new() }
                    ),
                    recommendation:   "Reduce concurrent load: lower --max-num-seqs or \
                                       --max-num-batched-tokens to free KV cache headroom. \
                                       If demand is sustained, scale horizontally or switch \
                                       to a smaller model/quantization.".into(),
                    resolution_steps: vec![
                        "Check KV cache: `curl http://localhost:7700/api/metrics/snapshot | jq .vllm_cache_usage_perc`".into(),
                        "Reduce concurrent sequences: restart vLLM with --max-num-seqs 4 (default is often 256)".into(),
                        "Lower batched tokens: --max-num-batched-tokens 2048 reduces per-batch KV footprint".into(),
                        "Long contexts: --max-model-len to cap per-sequence KV allocation".into(),
                        "Monitor: `watch -n 5 \"curl -s http://localhost:7700/api/metrics/snapshot | jq .vllm_cache_usage_perc\"`".into(),
                    ],
                    action_id:        "reduce_batch_size",
                    confidence:       obs_confidence(ratio),
                    confidence_ratio: ratio,
                    first_fired_ms:   now_ms,
                    node_id:          node_id.into(),
                    hostname:         hostname.into(),
                });
            }
        }
    }

    // ── Pattern P: TTFT Regression ───────────────────────────────────────
    // Time-to-first-token is trending upward, indicating growing inference
    // latency for users — KV cache thrash, memory pressure, or queue build-up.
    // Uses 10-min window; requires ≥ 10 samples with valid ttft_ms.
    {
        let ttft_vals: Vec<(usize, f64)> = long_window.iter()
            .enumerate()
            .filter_map(|(i, s)| s.ttft_ms.map(|v| (i, v)))
            .collect();

        if ttft_vals.len() >= 10 {
            // Rebuild as sequential values for OLS (use position-in-window, not ts)
            let ttft_seq: Vec<f64> = ttft_vals.iter().map(|(_, v)| *v).collect();
            let mean_ttft = obs_mean(&ttft_seq);

            // OLS slope of TTFT vs. sample index (X = position in the filtered
            // series, not wall-clock — TTFT samples only exist on inference
            // events, so spacing is irregular). The * 6.0 below converts the
            // per-sample slope to an approximate per-minute rate assuming the
            // typical ~10 s spacing between inference events; treat the ms/min
            // figure as a trend indicator, not an exact rate.
            let n = ttft_seq.len() as f64;
            let x_mean = (n - 1.0) / 2.0;
            let slope_raw: f64 = {
                let num: f64 = ttft_seq.iter().enumerate()
                    .map(|(i, &y)| (i as f64 - x_mean) * (y - mean_ttft))
                    .sum();
                let den: f64 = ttft_seq.iter().enumerate()
                    .map(|(i, _)| (i as f64 - x_mean).powi(2))
                    .sum();
                if den.abs() < 1e-9 { 0.0 } else { num / den }
            };
            let slope_per_min = slope_raw * 6.0;

            // Recent tail: last 30% of ttft samples vs full mean
            let tail_start = (ttft_seq.len() as f64 * 0.70) as usize;
            let tail_vals: Vec<f64> = ttft_seq[tail_start..].to_vec();
            let tail_mean = if tail_vals.is_empty() { mean_ttft } else { obs_mean(&tail_vals) };

            let is_critical = slope_per_min > 25.0 || tail_mean > 2000.0;
            let fire = (slope_per_min > 5.0 && mean_ttft > 100.0) || tail_mean > 2000.0;

            if fire {
                let ratio = ((ttft_vals.len() as f64 - 10.0) / 50.0).clamp(0.3, 1.0);
                obs.push(LocalObservation {
                    pattern_id:       "ttft_regression",
                    severity:         if is_critical { "critical" } else { "warning" },
                    title:            "TTFT Regression".into(),
                    hook:             format!("TTFT +{slope_per_min:.0} ms/min, avg {mean_ttft:.0} ms"),
                    body:             {
                        // Enrich with contributing hardware factors from the window
                        let kv_vals: Vec<f64> = window.iter().filter_map(|s| s.vllm_cache_usage_perc).collect();
                        let q_vals: Vec<f64> = window.iter().filter_map(|s| s.queue_depth.map(|q| q as f64)).collect();
                        let p_vals: Vec<f64> = window.iter().filter_map(|s| s.penalty_avg).collect();
                        let mut factors = Vec::new();
                        if !kv_vals.is_empty() { let avg = obs_mean(&kv_vals); if avg > 75.0 { factors.push(format!("KV cache at {avg:.0}%")); } }
                        if !q_vals.is_empty() { let avg = obs_mean(&q_vals); if avg >= 2.0 { factors.push(format!("queue depth {avg:.0}")); } }
                        if !p_vals.is_empty() { let avg = obs_mean(&p_vals); if avg > 1.2 { factors.push(format!("thermal penalty {avg:.2}x")); } }
                        let factor_str = if factors.is_empty() { String::new() } else { format!(" Contributing factors: {}.", factors.join(", ")) };
                        format!(
                            "{hostname}'s time-to-first-token is trending upward (+{slope_per_min:.0} ms/min). \
                             Current mean TTFT is {mean_ttft:.0} ms{}.{factor_str}",
                            if tail_mean > mean_ttft * 1.3 {
                                format!(" with recent tail at {tail_mean:.0} ms")
                            } else { String::new() },
                        )
                    },
                    recommendation:   if is_critical {
                        "TTFT is critically high or accelerating fast. Reduce concurrent requests, \
                         check vLLM queue depth, and consider a shorter context window or smaller batch size.".into()
                    } else {
                        "Monitor for continued TTFT growth. Check KV cache hit rate and memory pressure. \
                         Reducing max_model_len or increasing GPU VRAM allocation can stabilize TTFT.".into()
                    },
                    resolution_steps: vec![
                        "vLLM queue: `curl http://localhost:18010/metrics | grep vllm:num_requests_waiting`".into(),
                        "vLLM KV cache: `curl http://localhost:18010/metrics | grep vllm:gpu_cache_usage_perc`".into(),
                        "Reduce concurrent load: lower `--max-num-seqs` in vLLM launch args".into(),
                        "Check memory pressure: `curl http://localhost:7700/api/metrics/snapshot | jq .memory_pressure_percent`".into(),
                    ],
                    action_id:        "check_inference_latency",
                    confidence:       obs_confidence(ratio),
                    confidence_ratio: ratio,
                    first_fired_ms:   now_ms,
                    node_id:          node_id.into(),
                    hostname:         hostname.into(),
                });
            }
        }
    }

    // ── Pattern Q: Latency Spike ─────────────────────────────────────────
    // E2E inference latency has spiked significantly compared to the window
    // baseline — indicates sudden degradation (thermal event, preemption, swap).
    // Uses 10-min window; requires ≥ 10 samples with valid avg_latency_ms.
    {
        let lat_vals: Vec<f64> = long_window.iter()
            .filter_map(|s| s.avg_latency_ms)
            .collect();

        if lat_vals.len() >= 10 {
            let baseline_end = (lat_vals.len() as f64 * 0.60) as usize;
            let baseline: Vec<f64> = lat_vals[..baseline_end].to_vec();
            let recent:   Vec<f64> = lat_vals[baseline_end..].to_vec();

            let baseline_mean = obs_mean(&baseline);
            let recent_mean   = obs_mean(&recent);

            // Spike ratio: how much worse is the recent window vs baseline?
            let spike_ratio = if baseline_mean > 1.0 {
                recent_mean / baseline_mean
            } else { 1.0 };

            let is_critical = spike_ratio > 3.0 || recent_mean > 10_000.0;
            // Fire if recent is 1.5× baseline AND recent is meaningfully slow
            let fire = spike_ratio >= 1.5 && recent_mean > 500.0;

            if fire {
                let ratio = ((spike_ratio - 1.5) / 1.5).clamp(0.3, 1.0);
                obs.push(LocalObservation {
                    pattern_id:       "latency_spike",
                    severity:         if is_critical { "critical" } else { "warning" },
                    title:            "Inference Latency Spike".into(),
                    hook:             format!("Latency {spike_ratio:.1}× baseline ({recent_mean:.0} ms)"),
                    body:             {
                        let kv_vals: Vec<f64> = window.iter().filter_map(|s| s.vllm_cache_usage_perc).collect();
                        let q_vals: Vec<f64> = window.iter().filter_map(|s| s.queue_depth.map(|q| q as f64)).collect();
                        let p_vals: Vec<f64> = window.iter().filter_map(|s| s.penalty_avg).collect();
                        let sw_vals: Vec<f64> = window.iter().filter_map(|s| s.swap_write_mb_s).collect();
                        let mut factors = Vec::new();
                        if !kv_vals.is_empty() { let avg = obs_mean(&kv_vals); if avg > 75.0 { factors.push(format!("KV cache at {avg:.0}%")); } }
                        if !q_vals.is_empty() { let avg = obs_mean(&q_vals); if avg >= 2.0 { factors.push(format!("queue depth {avg:.0}")); } }
                        if !p_vals.is_empty() { let avg = obs_mean(&p_vals); if avg > 1.2 { factors.push(format!("thermal penalty {avg:.2}x")); } }
                        if !sw_vals.is_empty() { let avg = obs_mean(&sw_vals); if avg > 2.0 { factors.push(format!("swap at {avg:.1} MB/s")); } }
                        let factor_str = if factors.is_empty() { String::new() } else { format!(" Contributing factors: {}.", factors.join(", ")) };
                        format!(
                            "{hostname} is experiencing a {spike_ratio:.1}× spike in E2E inference latency \
                             (recent: {recent_mean:.0} ms vs baseline: {baseline_mean:.0} ms).{factor_str}",
                        )
                    },
                    recommendation:   if is_critical {
                        "Latency has degraded critically. Investigate thermal state, memory pressure, \
                         and swap usage. Consider restarting the inference server if it does not recover.".into()
                    } else {
                        "Check for correlated thermal events or memory pressure spikes that may have \
                         caused this latency increase. Monitor over the next few minutes for recovery.".into()
                    },
                    resolution_steps: vec![
                        "Check thermal state: `curl http://localhost:7700/api/metrics/snapshot | jq .thermal_state`".into(),
                        "Check swap: `curl http://localhost:7700/api/metrics/snapshot | jq .swap_write_mb_s`".into(),
                        "vLLM preemption metric: `curl http://localhost:18010/metrics | grep vllm:num_preemptions`".into(),
                        "Ollama running requests: `curl http://localhost:11434/api/ps`".into(),
                    ],
                    action_id:        "check_inference_latency",
                    confidence:       obs_confidence(ratio),
                    confidence_ratio: ratio,
                    first_fired_ms:   now_ms,
                    node_id:          node_id.into(),
                    hostname:         hostname.into(),
                });
            }
        }
    }

    // ── Pattern R: vLLM Queue Saturation ────────────────────────────────
    // vLLM's waiting request queue is persistently backlogged, meaning the
    // GPU cannot drain requests as fast as they arrive.
    // Uses 5-min window; requires ≥ 10 samples with valid queue_depth.
    // Only fires on nodes running vLLM (queue_depth is None for Ollama/llama.cpp).
    {
        let queue_vals: Vec<f64> = window.iter()
            .filter_map(|s| s.queue_depth.map(|q| q as f64))
            .collect();

        if queue_vals.len() >= 10 {
            let avg_queue = obs_mean(&queue_vals);
            let max_queue = queue_vals.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

            // OLS slope to detect queue growth vs steady state
            let slope = obs_linear_slope(&queue_vals); // requests/sample (~1s), so /min = *60
            let slope_per_min = slope * 60.0;

            let is_critical = max_queue >= 10.0 || (avg_queue >= 5.0 && slope_per_min > 0.5);
            let fire = avg_queue >= 3.0 || max_queue >= 8.0;

            if fire {
                let ratio = ((avg_queue - 3.0) / 7.0).clamp(0.3, 1.0);
                obs.push(LocalObservation {
                    pattern_id:       "vllm_queue_saturation",
                    severity:         if is_critical { "critical" } else { "warning" },
                    title:            "vLLM Queue Saturation".into(),
                    hook:             format!("avg {avg_queue:.1} waiting requests (max {max_queue:.0})"),
                    body:             format!(
                        "{hostname}'s vLLM request queue is backed up with an average of {avg_queue:.1} \
                         waiting requests (max: {max_queue:.0}){}. \
                         The GPU cannot service requests as fast as they arrive — throughput is \
                         degraded and latency will increase.",
                        if slope_per_min > 0.1 {
                            format!(" and growing at +{slope_per_min:.1} req/min")
                        } else { String::new() },
                    ),
                    recommendation:   if is_critical {
                        "Queue is critically saturated. Increase `--max-num-seqs`, reduce max context \
                         length, or scale out to additional nodes. Consider enabling chunked prefill to \
                         improve scheduling fairness.".into()
                    } else {
                        "Queue is accumulating faster than it drains. Review request arrival rate and \
                         consider tuning `--max-num-seqs` or `--max-num-batched-tokens` for this workload.".into()
                    },
                    resolution_steps: vec![
                        "vLLM queue metrics: `curl http://localhost:18010/metrics | grep -E 'num_requests_(running|waiting|swapped)'`".into(),
                        "Increase throughput: raise `--max-num-seqs` in vLLM launch args (watch VRAM)".into(),
                        "Enable chunked prefill: add `--enable-chunked-prefill` to vLLM args".into(),
                        "Scale out: register additional vLLM nodes in Wicklee fleet".into(),
                    ],
                    action_id:        "check_vllm_queue",
                    confidence:       obs_confidence(ratio),
                    confidence_ratio: ratio,
                    first_fired_ms:   now_ms,
                    node_id:          node_id.into(),
                    hostname:         hostname.into(),
                });
            }
        }
    }

    // Profile-driven emission filter: on stricter profiles (sovereign_dev),
    // drop observations that haven't cleared the confidence floor — the last
    // coherent sensitivity lever, applied uniformly across every pattern above.
    if tuning.min_confidence > 0.0 {
        obs.retain(|o| o.confidence_ratio >= tuning.min_confidence);
    }

    obs
}

/// Pattern O — VRAM Overcommit.  Point-in-time check: fires when the loaded
/// model consumes >90% of available GPU memory (NVIDIA VRAM or Apple unified).
/// Community tier, action_id = switch_quantization.
#[cfg(not(target_env = "musl"))]
pub(crate) fn evaluate_vram_overcommit(
    ollama: &OllamaMetrics,
    nvidia: &NvidiaMetrics,
    apple:  &AppleSiliconMetrics,
    node_id:  &str,
    hostname: &str,
) -> Option<LocalObservation> {
    let model_gb = ollama.ollama_model_size_gb?;
    if model_gb <= 0.0 { return None; }

    // Resolve VRAM capacity: NVIDIA total → Apple unified memory budget
    let vram_gb = nvidia.nvidia_vram_total_mb
        .filter(|&v| v >= 1024) // ≥1 GB = real GPU
        .map(|v| v as f64 / 1024.0)
        .or_else(|| apple.gpu_wired_limit_mb
            .filter(|&v| v > 0)
            .map(|v| v as f64 / 1024.0))?;

    let usage_pct = (model_gb as f64 / vram_gb) * 100.0;
    if usage_pct < 90.0 { return None; }

    let headroom_gb = vram_gb - model_gb as f64;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let is_critical = usage_pct >= 98.0;
    let os_name = {
        #[cfg(target_os = "macos")]   { "macOS" }
        #[cfg(target_os = "linux")]   { "Linux" }
        #[cfg(target_os = "windows")] { "Windows" }
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        { "Unknown" }
    };

    let resolution_steps = if nvidia.nvidia_vram_total_mb.filter(|&v| v >= 1024).is_some() {
        vec![
            "Check VRAM: `nvidia-smi --query-gpu=memory.total,memory.used,memory.free --format=csv,noheader`".into(),
            "List loaded models: `ollama ps`".into(),
            "Pull smaller quantization: `ollama pull <model>:q4_K_M`".into(),
            "Unload competing models: `ollama stop <model_name>`".into(),
        ]
    } else {
        vec![
            format!("Check GPU memory budget: `sysctl iogpu.wired_limit_mb` (current: {:.1} GB)", vram_gb),
            "List loaded models: `ollama ps`".into(),
            "Pull smaller quantization: `ollama pull <model>:q4_K_M`".into(),
            "Unload competing models: `ollama stop <model_name>`".into(),
        ]
    };

    Some(LocalObservation {
        pattern_id:       "vram_overcommit",
        severity:         if is_critical { "critical" } else { "warning" },
        title:            "VRAM Overcommit".into(),
        hook:             format!("{usage_pct:.0}% VRAM used ({headroom_gb:.1} GB free)"),
        body:             format!(
            "{hostname}'s loaded model ({model_gb:.1} GB) consumes {usage_pct:.0}% of the \
             {vram_gb:.1} GB {os_name} GPU memory budget, leaving only {headroom_gb:.1} GB headroom. \
             Inference will spill to system RAM, causing severe throughput degradation and swap pressure.",
        ),
        recommendation:   if is_critical {
            "GPU memory is near-exhausted. Immediately switch to a smaller quantization variant \
             (e.g. q4_K_M) or unload competing models to restore headroom.".into()
        } else {
            "Model is close to the VRAM ceiling. Consider pulling a smaller quantization variant \
             to leave headroom for KV cache and batch processing.".into()
        },
        resolution_steps,
        action_id:        "switch_quantization",
        confidence:       "high",
        confidence_ratio: 1.0,
        first_fired_ms:   now_ms,
        node_id:          node_id.into(),
        hostname:         hostname.into(),
    })
}

// ── Pattern: Bandwidth Ceiling Reached ───────────────────────────────────────
// Informational pattern that explains low tok/W as physics rather than
// pathology.  When a node is decoding at ≥65 % of its theoretical
// memory-bandwidth ceiling for the loaded model + quant, "Low efficiency"
// is the expected steady state at batch=1 — fire this so the dashboard
// stops nagging the user to fix something that isn't broken.

/// Memory bandwidth in GB/s for known hardware.
/// System (unified) memory bandwidth for Apple Silicon and DGX Spark;
/// VRAM bandwidth for discrete GPUs.  Returns None on unknown hardware
/// so the pattern never fires with a guessed ceiling.
#[cfg(not(target_env = "musl"))]
pub(crate) fn hardware_bandwidth_gbps(gpu_name: Option<&str>, chip_name: Option<&str>) -> Option<f32> {
    // Chip-identifier match at word boundaries. Plain `contains` mis-binds
    // short Apple tokens inside NVML form-factor codes: "A100-SXM4-80GB"
    // contains "m4" and was resolved as a base Apple M4 (120 GB/s instead
    // of 2039); "V100-SXM2" likewise contains "m2".
    fn word(key: &str, pat: &str) -> bool {
        key.match_indices(pat).any(|(i, _)| {
            let b = key.as_bytes();
            let before_ok = i == 0 || !b[i - 1].is_ascii_alphanumeric();
            let end = i + pat.len();
            let after_ok = end == key.len() || !b[end].is_ascii_alphanumeric();
            before_ok && after_ok
        })
    }
    // Dash-normalize so NVML names like "A100-SXM4-80GB" match keyword checks.
    let key = format!(
        "{} {}",
        gpu_name.unwrap_or(""),
        chip_name.unwrap_or(""),
    ).to_lowercase().replace('-', " ");
    let key = key.trim();
    if key.is_empty() { return None; }
    // Match longest names first to avoid e.g. "m4 max" being shadowed by "m4".
    if word(key, "m3 ultra")  { return Some(819.0); }
    if word(key, "m2 ultra")  { return Some(800.0); }
    if word(key, "m4 max")    { return Some(546.0); }
    if word(key, "m3 max")    { return Some(400.0); }
    if word(key, "m2 max")    { return Some(400.0); }
    if word(key, "m1 max")    { return Some(400.0); }
    if word(key, "m4 pro")    { return Some(273.0); }
    if word(key, "m3 pro")    { return Some(150.0); }
    if word(key, "m2 pro")    { return Some(200.0); }
    if word(key, "m1 pro")    { return Some(200.0); }
    if word(key, "m4")        { return Some(120.0); }   // base M4
    if word(key, "m3")        { return Some(100.0); }   // base M3
    if word(key, "m2")        { return Some(100.0); }   // base M2
    if word(key, "m1")        { return Some(68.0); }    // base M1
    if word(key, "gb10") || word(key, "spark") { return Some(273.0); } // DGX Spark
    if word(key, "h200")      { return Some(4800.0); }
    // H100 variants: NVML reports "H100 PCIe", "H100 NVL", or "H100 80GB HBM3" (SXM).
    if word(key, "h100") {
        if word(key, "pcie") { return Some(2000.0); }
        if word(key, "nvl")  { return Some(3938.0); }
        return Some(3350.0);
    }
    // A100: 80GB parts (SXM4 2039 / PCIe 1935 — close enough); 40GB parts 1555.
    // Capacity check is a plain substring ("80gb" must match "80").
    if word(key, "a100") {
        return Some(if key.contains("80") { 2039.0 } else { 1555.0 });
    }
    if word(key, "v100")           { return Some(900.0); }
    if word(key, "rtx 5090")       { return Some(1792.0); }
    if word(key, "rtx 4090")       { return Some(1008.0); }
    if word(key, "rtx 4080 super") { return Some(736.0); }
    if word(key, "rtx 4080")       { return Some(717.0); }
    if word(key, "rtx 3090 ti")    { return Some(1008.0); }
    if word(key, "rtx 3090")       { return Some(936.0); }
    if word(key, "rtx 3080 ti")    { return Some(912.0); }
    if word(key, "rtx 3080")       { return Some(760.0); }
    if word(key, "l40s")      { return Some(864.0); }
    if word(key, "l40")       { return Some(864.0); }
    if word(key, "l4")        { return Some(300.0); }
    None
}

/// Approximate bytes-per-weight for a given quant string. Strips the "UD-"
/// prefix, then defers to `scoring::bytes_per_param_for_quant` — the single
/// source for GGUF (Q*/IQ*) and F16/BF16/F32 sizes, calibrated against real
/// files and mirrored by src/utils/quantSize.ts. Only tags that table doesn't
/// cover (1-bit GGUF, FP8/INT8, vLLM/HF quant tags) are handled here.
#[cfg(not(target_env = "musl"))]
pub(crate) fn bytes_per_weight(quant: &str) -> f32 {
    let q = quant.to_lowercase();
    let q = q.strip_prefix("ud-").unwrap_or(&q);
    if let Some(bpp) = scoring::bytes_per_param_for_quant(q) { return bpp; }
    if q.starts_with("iq1") || q == "q1_k" || q == "q1" { return 0.25; }
    if q == "fp8" || q == "int8" { return 1.0; }
    if q.starts_with("f16") || q.starts_with("fp16") { return 2.0; }
    if q.starts_with("f32") || q.starts_with("fp32") { return 4.0; }
    // Production vLLM/HF quant tags — mirror src/utils/quantSize.ts.
    // AWQ / GPTQ-int4 / NF4 / FP4: 4-bit weights + group scales ≈ 0.56 B/W.
    // GPTQ-int8 / BNB-8bit: 8-bit weights ≈ 1.0 B/W like FP8.
    // AQLM / HQQ-2bit: 2-bit aggressive quants ≈ 0.34 B/W.
    if q == "awq" || q.starts_with("awq-int4") || q == "awq-4bit"     { return 0.56; }
    if q == "gptq" || q.starts_with("gptq-int4") || q == "gptq-4bit"  { return 0.56; }
    if q == "gptq-int8" || q == "gptq-8bit"                            { return 1.0; }
    if q == "aqlm" || q.starts_with("aqlm-2bit")                       { return 0.34; }
    if q == "hqq" || q.starts_with("hqq-4bit")                         { return 0.56; }
    if q == "hqq-2bit"                                                 { return 0.34; }
    if q == "bnb-4bit" || q == "nf4" || q == "fp4"                     { return 0.56; }
    if q == "bnb-8bit"                                                 { return 1.0; }
    1.0  // conservative default — same as Q8/FP8
}

#[cfg(not(target_env = "musl"))]
pub(crate) fn evaluate_bandwidth_ceiling(
    samples:   &[store::ObsSample],
    ollama:    &OllamaMetrics,
    nvidia:    &NvidiaMetrics,
    apple:     &AppleSiliconMetrics,
    chip_name: Option<&str>,
    node_id:   &str,
    hostname:  &str,
) -> Option<LocalObservation> {
    // Need the model context: parameter count + quant (from Ollama enrichment).
    // vLLM models don't yet carry param_count in payload, so this fires for
    // Ollama runs today.  Phase 2: extend to vLLM via runtime probe.
    let param_count = ollama.ollama_parameter_count? as f32;
    if param_count < 1e9 { return None; }   // tiny models aren't bandwidth-bound on any GPU
    let quant = ollama.ollama_quantization.as_deref().unwrap_or("q4_k_m");
    let bpw = bytes_per_weight(quant);
    let model_size_gb = param_count * bpw / 1e9;
    if model_size_gb < 0.5 { return None; }

    // Hardware bandwidth.
    let gpu_name_owned: Option<String> = nvidia
        .nvidia_gpu_name.clone()
        .or_else(|| apple.gpu_name.clone());
    let bandwidth_gbps = hardware_bandwidth_gbps(
        gpu_name_owned.as_deref(),
        chip_name,
    )?;
    // Raw ceiling = every weight streamed once per token at full rated
    // bandwidth. Real batch=1 GGUF decode tops out at ~30–45% of that
    // (activation traffic, KV reads, framework overhead) — the frontend's
    // INFERENCE_EFFICIENCY constant (chipBandwidth.ts) uses 0.40 for the
    // same physics. The achievable ceiling is what utilization must be
    // measured against: the previous code compared observed tok/s to the
    // RAW ceiling with a 0.65 trigger, a level real hardware can't reach,
    // so this pattern never fired.
    const INFERENCE_EFFICIENCY: f32 = 0.40;
    let theoretical_max_tps = bandwidth_gbps / model_size_gb;
    if theoretical_max_tps <= 0.0 { return None; }
    let achievable_ceiling_tps = theoretical_max_tps * INFERENCE_EFFICIENCY;

    // Need at least 5 minutes of sustained inference samples to fire confidently.
    let now_ms = now_ms() as i64;
    let cutoff = now_ms - 300_000_i64;
    let live_samples: Vec<&store::ObsSample> = samples.iter()
        .filter(|s| s.ts_ms >= cutoff)
        .filter(|s| s.tps.is_some_and(|t| t > 0.5))
        .collect();
    if live_samples.len() < 30 { return None; }   // 30 × 10s ~= 5 min

    let tps_vals:  Vec<f64> = live_samples.iter().filter_map(|s| s.tps).collect();
    let observed_tps_p50 = obs_mean(&tps_vals);
    if observed_tps_p50 <= 0.0 { return None; }

    let utilization = observed_tps_p50 / achievable_ceiling_tps as f64;
    if utilization < 0.65 { return None; }   // not bandwidth-bound — something else limits

    // Confirmation: GPU not pegged at 100% (compute-bound is a different story —
    // the bandwidth_saturation pattern handles compute-stalled-on-memory cases).
    let gpu_vals: Vec<f64> = live_samples.iter().filter_map(|s| s.gpu_util_pct).collect();
    let gpu_p50 = if gpu_vals.is_empty() { 0.0 } else { obs_mean(&gpu_vals) };
    if gpu_p50 > 95.0 { return None; }

    // Build human-readable strings.
    let confidence = if utilization >= 0.75 { "high" } else { "moderate" };
    let confidence_ratio: f64 = utilization.min(1.0);
    let model_name = ollama.ollama_active_model.clone()
        .unwrap_or_else(|| "active model".to_string());
    let hw_label = gpu_name_owned
        .or_else(|| chip_name.map(str::to_string))
        .unwrap_or_else(|| "this hardware".to_string());

    Some(LocalObservation {
        pattern_id:       "bandwidth_ceiling_reached",
        severity:         "info",
        title:            "Memory-Bandwidth Ceiling Reached".into(),
        hook:             format!(
            "{:.1} tok/s · {:.0}% of {:.1} tok/s achievable ceiling",
            observed_tps_p50, utilization * 100.0, achievable_ceiling_tps,
        ),
        body:             format!(
            "{hostname} is decoding {model_name} at {observed_tps_p50:.1} tok/s — \
             {pct:.0}% of the achievable memory-bandwidth ceiling for {hw_label} \
             ({model_size_gb:.1} GB resident weights at {quant}, \
             {bandwidth_gbps:.0} GB/s rated bandwidth, ~40% realizable at batch=1). \
             The 'Low' tok/W reading is \
             expected: at batch=1, fixed GPU baseline power dominates and efficiency \
             cannot improve without changing quant or batch size. The node is healthy.",
            pct = utilization * 100.0,
        ),
        recommendation:   "This is normal for batch=1 decode. To increase tok/s: \
                          drop to a smaller quant (e.g. Q4_K_M). To increase tok/W: \
                          raise concurrent batch size — fixed power baseline \
                          amortises across requests.".into(),
        resolution_steps: vec![
            "If interactive latency matters: switch to a Q4_K_M GGUF (~2× tok/s, modest quality cost)".into(),
            "If serving multiple users: raise batch size with vLLM `--max-num-seqs 8` or higher".into(),
            "If quality is paramount: leave as-is — you are at the physics ceiling for this hardware/quant pair".into(),
        ],
        action_id:        "bandwidth_ceiling_info",
        confidence,
        confidence_ratio,
        first_fired_ms:   now_ms,
        node_id:          node_id.into(),
        hostname:         hostname.into(),
    })
}

/// Newtype wrapper for the node_id Extension so it doesn't collide with other Arc<String>.
#[derive(Clone)]
pub(crate) struct NodeId(pub(crate) Arc<String>);

#[cfg(not(target_env = "musl"))]
pub(crate) async fn handle_observations(
    axum::extract::Extension(obs_cache): axum::extract::Extension<ObservationCache>,
) -> impl IntoResponse {
    // Return observations with per-observation + node-level routing hints.
    let observations = obs_cache.lock().map(|c| c.clone()).unwrap_or_default();
    let enriched: Vec<serde_json::Value> = observations.iter().map(|o| {
        let mut v = serde_json::to_value(o).unwrap_or_default();
        if let Some(obj) = v.as_object_mut() {
            obj.insert("routing_hint".into(), serde_json::json!(o.routing_hint()));
        }
        v
    }).collect();

    // Node-level aggregate: worst routing_hint across all active observations.
    // Priority: steer_away > reduce_batch > monitor > clear
    let (node_hint, node_hint_source) = observations.iter()
        .map(|o| (o.routing_hint(), o.pattern_id))
        .min_by_key(|(hint, _)| match *hint {
            "steer_away" => 0,
            "reduce_batch" => 1,
            "monitor" => 2,
            _ => 3,
        })
        .unwrap_or(("clear", "none"));

    Json(serde_json::json!({
        "observations": enriched,
        "routing_hint": node_hint,
        "routing_hint_source": node_hint_source,
    })).into_response()
}

#[cfg(all(test, not(target_env = "musl")))]
mod bandwidth_tests {
    use super::*;

    #[test]
    fn resolves_dashed_nvml_names_and_variants() {
        // NVML reports dashed names — the A100 80GB entry never matched before
        // dash normalization was added.
        assert_eq!(hardware_bandwidth_gbps(Some("NVIDIA A100-SXM4-80GB"), None), Some(2039.0));
        assert_eq!(hardware_bandwidth_gbps(Some("NVIDIA A100-PCIE-40GB"), None), Some(1555.0));
        assert_eq!(hardware_bandwidth_gbps(Some("NVIDIA H100 PCIe"), None), Some(2000.0));
        assert_eq!(hardware_bandwidth_gbps(Some("NVIDIA H100 80GB HBM3"), None), Some(3350.0));
        assert_eq!(hardware_bandwidth_gbps(Some("NVIDIA GeForce RTX 4080 SUPER"), None), Some(736.0));
        assert_eq!(hardware_bandwidth_gbps(Some("NVIDIA GeForce RTX 3090 Ti"), None), Some(1008.0));
        // Bare L40 must not fall through to the L4 entry (864 vs 300).
        assert_eq!(hardware_bandwidth_gbps(Some("NVIDIA L40"), None), Some(864.0));
        assert_eq!(hardware_bandwidth_gbps(Some("NVIDIA L4"), None), Some(300.0));
        // "V100-SXM2" contains "m2" — must not resolve as a base Apple M2.
        assert_eq!(hardware_bandwidth_gbps(Some("Tesla V100-SXM2-16GB"), None), Some(900.0));
    }

    #[test]
    fn resolves_apple_chips_and_unknowns() {
        assert_eq!(hardware_bandwidth_gbps(None, Some("Apple M3 Ultra")), Some(819.0));
        assert_eq!(hardware_bandwidth_gbps(None, Some("Apple M2 Pro")), Some(200.0));
        assert_eq!(hardware_bandwidth_gbps(Some("AMD Radeon RX 7900 XTX"), None), None);
    }
}

#[cfg(all(test, not(target_env = "musl")))]
mod bytes_per_weight_tests {
    use super::*;

    #[test]
    fn gguf_quants_come_from_scoring_table() {
        for q in ["Q4_K_M", "q4_k_m", "UD-Q4_K_XL", "IQ4_XS", "Q8_0", "Q2_K", "Q6_K", "F16", "BF16", "F32"] {
            let stripped = q.to_lowercase();
            let stripped = stripped.strip_prefix("ud-").unwrap_or(&stripped).to_string();
            assert_eq!(Some(bytes_per_weight(q)), scoring::bytes_per_param_for_quant(&stripped), "{q}");
        }
        // Calibrated values, matching src/utils/quantSize.ts.
        assert_eq!(bytes_per_weight("Q4_K_M"), 0.60);
        assert_eq!(bytes_per_weight("Q8_0"), 1.0);
        assert_eq!(bytes_per_weight("IQ2_XS"), 0.34);
        assert_eq!(bytes_per_weight("Q2_K"), 0.39);
    }

    #[test]
    fn non_gguf_tags_keep_local_fallbacks() {
        assert_eq!(bytes_per_weight("fp8"), 1.0);
        assert_eq!(bytes_per_weight("fp16"), 2.0);
        assert_eq!(bytes_per_weight("awq"), 0.56);
        assert_eq!(bytes_per_weight("IQ1_S"), 0.25);
        assert_eq!(bytes_per_weight("mystery"), 1.0);
    }
}

#[cfg(test)]
mod deployment_profile_tests {
    use super::*;

    #[test]
    fn from_config_defaults_to_dedicated_server() {
        // None, empty, and unrecognized all fall back to the safe standard.
        assert_eq!(DeploymentProfile::from_config(None), DeploymentProfile::DedicatedServer);
        assert_eq!(DeploymentProfile::from_config(Some("bogus")), DeploymentProfile::DedicatedServer);
        assert_eq!(DeploymentProfile::from_config(Some("dedicated_server")), DeploymentProfile::DedicatedServer);
        assert_eq!(DeploymentProfile::from_config(Some("sovereign_dev")), DeploymentProfile::SovereignDev);
        assert_eq!(DeploymentProfile::from_config(Some("production_fleet")), DeploymentProfile::ProductionFleet);
    }

    #[test]
    fn as_str_round_trips_through_from_config() {
        for p in [DeploymentProfile::SovereignDev, DeploymentProfile::DedicatedServer, DeploymentProfile::ProductionFleet] {
            assert_eq!(DeploymentProfile::from_config(Some(p.as_str())), p);
        }
    }

    #[test]
    fn dedicated_server_preserves_the_original_baseline() {
        // The standard profile must not change the pre-profile behavior:
        // 0.70 gate, unscaled density, no confidence floor.
        let t = DeploymentProfile::DedicatedServer.tuning();
        assert_eq!(t.density_scale, 1.0);
        assert_eq!(t.evidence_ratio, 0.70);
        assert_eq!(t.min_confidence, 0.0);
        // Baseline densities are unchanged from the original constants.
        assert_eq!((210.0 * t.density_scale) as usize, 210);
        assert_eq!((420.0 * t.density_scale) as usize, 420);
    }

    #[test]
    fn sensitivity_is_ordered_dev_conservative_production_aggressive() {
        let dev  = DeploymentProfile::SovereignDev.tuning();
        let std  = DeploymentProfile::DedicatedServer.tuning();
        let prod = DeploymentProfile::ProductionFleet.tuning();
        // Dev demands more evidence and more confidence than standard; production less.
        assert!(dev.evidence_ratio > std.evidence_ratio && std.evidence_ratio > prod.evidence_ratio);
        assert!(dev.density_scale  > std.density_scale  && std.density_scale  > prod.density_scale);
        assert!(dev.min_confidence > std.min_confidence);
        // Scaled dev densities stay within their windows (5min=300, 10min=600 samples @1Hz).
        assert!((210.0 * dev.density_scale) as usize <= 300);
        assert!((420.0 * dev.density_scale) as usize <= 600);
    }
}
