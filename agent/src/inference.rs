use crate::{AppleSiliconMetrics, NvidiaMetrics, OllamaMetrics, VllmMetrics, LlamacppMetrics};

/// Platform-independent sensor bundle. All fields are Option — absent sensors
/// are skipped. No platform #[cfg] branches in the state machine itself.
pub(crate) struct HardwareSignals {
    pub(crate) ane_power_w:    Option<f32>,
    pub(crate) soc_power_w:    Option<f32>,
    /// GPU HW active residency % from IOKit (primary) / powermetrics (fallback).
    /// Distinct from GPU *power*: M2 base GPU reads ~88 mW at 40 % residency.
    /// Used as Tier 3 "Power Blindness" override for M2/M3 base chips.
    pub(crate) apple_gpu_pct:  Option<f32>,
    pub(crate) nvidia_gpu_pct: Option<f32>,
    pub(crate) nvidia_vram_mb: Option<u64>,
    pub(crate) nvidia_power_w: Option<f32>,
    pub(crate) ai_runtime_loaded: bool,
    pub(crate) ai_model_loaded:   bool,
    pub(crate) vllm_requests:     Option<u32>,
    pub(crate) llamacpp_requests: Option<u32>,
    pub(crate) probe_active:         bool,
    pub(crate) last_user_request_ts: Option<std::time::Instant>,
    pub(crate) recent_probe: bool,
    /// A probe baseline exists and is inside its scheduled refresh window.
    /// IDLE-SPD only — unlike `recent_probe` it never gates Tier 3, so probes
    /// spaced minutes apart don't blind the physics detector.
    pub(crate) fresh_baseline: bool,
}

/// Build a HardwareSignals snapshot from the current sensor state.
///
/// Extracted from the broadcast tick loop to make signal construction testable
/// and keep the 400-line broadcast loop focused on serialization + send.
pub(crate) fn read_hardware_signals(
    apple:        &AppleSiliconMetrics,
    nvidia:       &NvidiaMetrics,
    ollama:       &OllamaMetrics,
    vllm:         &VllmMetrics,
    llamacpp:     &LlamacppMetrics,
    probe_active: &std::sync::atomic::AtomicBool,
) -> HardwareSignals {
    HardwareSignals {
        ane_power_w:          apple.ane_power_w,
        soc_power_w:          apple.soc_power_w,
        apple_gpu_pct:        apple.gpu_utilization_percent,
        nvidia_gpu_pct:       nvidia.nvidia_gpu_utilization_percent,
        nvidia_vram_mb:       nvidia.nvidia_vram_used_mb,
        nvidia_power_w:       nvidia.nvidia_power_draw_w,
        ai_runtime_loaded:    ollama.ollama_running || vllm.vllm_running || llamacpp.llamacpp_running,
        ai_model_loaded:      ollama.ollama_active_model.is_some()
                              || vllm.vllm_model_name.is_some()
                              || llamacpp.llamacpp_model_name.is_some(),
        vllm_requests:        vllm.vllm_requests_running,
        llamacpp_requests:    llamacpp.llamacpp_slots_processing,
        probe_active:         probe_active.load(std::sync::atomic::Ordering::Acquire),
        last_user_request_ts: ollama.last_user_request_ts,
        recent_probe:         ollama.recent_probe_baseline()
                              || vllm.recent_probe_baseline()
                              || llamacpp.recent_probe_baseline(),
        fresh_baseline:       ollama.fresh_probe_baseline()
                              || vllm.fresh_probe_baseline()
                              || llamacpp.fresh_probe_baseline(),
    }
}

/// Canonical four-state inference classification.
///
/// Internal enum — serialized to wire-format strings at the single MetricsPayload
/// serialization point. Enables exhaustive pattern matching in tests and future
/// transition logic without coupling the state machine to JSON field values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InferenceState {
    /// User or client inference confirmed (any tier).
    Live,
    /// Probe recently completed — fresh baseline visible, hardware idle.
    IdleSpd,
    /// Hardware loaded but no AI runtime active (rogue workload).
    Busy,
    /// Silicon at rest.
    Idle,
}

impl InferenceState {
    /// Wire-format string. These values are FROZEN — shared with the React
    /// frontend and the CLI output. Do not rename.
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            InferenceState::Live    => "live",
            InferenceState::IdleSpd => "idle-spd",
            InferenceState::Busy    => "busy",
            InferenceState::Idle    => "idle",
        }
    }
}

impl std::fmt::Display for InferenceState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Canonical four-state inference classifier.
///
/// Pure function: no side effects, no async, no stored state. Re-derives
/// from sensors every tick so it self-corrects on agent restart and sensor dropout.
///
/// Hierarchy (first match wins):
///   Live      Tier 1: vLLM/llama.cpp exact count, or Tier 2: attributed user request, or Tier 3: physics
///   IdleSpd   Probe recently completed — fresh baseline visible
///   Busy      Hardware loaded, no AI runtime
///   Idle      Silicon at rest
pub(crate) fn compute_inference_state(s: &HardwareSignals) -> InferenceState {
    let probe_inflight = u32::from(s.probe_active);
    if s.vllm_requests.is_some_and(|r| r > probe_inflight) {
        return InferenceState::Live;
    }
    if s.llamacpp_requests.is_some_and(|r| r > probe_inflight) {
        return InferenceState::Live;
    }

    if s.last_user_request_ts.is_some_and(|t| t.elapsed().as_secs() < 15) {
        return InferenceState::Live;
    }

    let saturated_gpu = s.apple_gpu_pct.is_some_and(|g| g >= 75.0)
                     || s.nvidia_gpu_pct.is_some_and(|g| g >= 75.0);

    if !s.probe_active && (!s.recent_probe || saturated_gpu) && s.ai_model_loaded {
        let ai_specific = s.ane_power_w.is_some_and(|p| p > 0.5);
        let physics =
            s.soc_power_w.is_some_and(|p| p > 8.0)
            || s.apple_gpu_pct.is_some_and(|g| g > 20.0)
            || (s.nvidia_gpu_pct.is_some_and(|g| g > 30.0)
                && s.nvidia_vram_mb.is_some_and(|v| v > 0))
            || s.nvidia_power_w.is_some_and(|p| p > 40.0);

        if ai_specific || physics {
            return InferenceState::Live;
        }
    }

    if (s.recent_probe || s.fresh_baseline) && s.ai_model_loaded {
        return InferenceState::IdleSpd;
    }

    let any_load = s.nvidia_gpu_pct.is_some_and(|g| g > 20.0)
                || s.soc_power_w.is_some_and(|p| p > 10.0);
    if any_load && !s.ai_runtime_loaded {
        return InferenceState::Busy;
    }

    InferenceState::Idle
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Baseline: all sensors quiet, no runtime loaded, no model loaded.
    fn idle_signals() -> HardwareSignals {
        HardwareSignals {
            ane_power_w:          None,
            soc_power_w:          None,
            apple_gpu_pct:        None,
            nvidia_gpu_pct:       None,
            nvidia_vram_mb:       None,
            nvidia_power_w:       None,
            ai_runtime_loaded:    false,
            ai_model_loaded:      false,
            vllm_requests:        None,
            llamacpp_requests:    None,
            probe_active:         false,
            last_user_request_ts: None,
            recent_probe:         false,
            fresh_baseline:       false,
        }
    }

    #[test]
    fn probe_active_high_gpu_not_live() {
        let s = HardwareSignals {
            apple_gpu_pct:     Some(99.0),
            ai_runtime_loaded: true,
            ai_model_loaded:   true,
            probe_active:      true,
            ..idle_signals()
        };
        assert_ne!(compute_inference_state(&s), InferenceState::Live);
    }

    #[test]
    fn vllm_probe_own_request_not_live() {
        let s = HardwareSignals {
            ai_runtime_loaded: true,
            ai_model_loaded:   true,
            vllm_requests:     Some(1),
            probe_active:      true,
            ..idle_signals()
        };
        assert_ne!(compute_inference_state(&s), InferenceState::Live);
    }

    #[test]
    fn vllm_user_request_during_probe_still_live() {
        let s = HardwareSignals {
            ai_runtime_loaded: true,
            ai_model_loaded:   true,
            vllm_requests:     Some(2),
            probe_active:      true,
            ..idle_signals()
        };
        assert_eq!(compute_inference_state(&s), InferenceState::Live);
    }

    #[test]
    fn llamacpp_probe_own_request_not_live() {
        let s = HardwareSignals {
            ai_runtime_loaded: true,
            ai_model_loaded:   true,
            llamacpp_requests: Some(1),
            probe_active:      true,
            ..idle_signals()
        };
        assert_ne!(compute_inference_state(&s), InferenceState::Live);
    }

    #[test]
    fn recent_probe_saturated_gpu_is_live() {
        let s = HardwareSignals {
            apple_gpu_pct:     Some(99.0),
            ai_runtime_loaded: true,
            ai_model_loaded:   true,
            recent_probe:      true,
            ..idle_signals()
        };
        assert_eq!(compute_inference_state(&s), InferenceState::Live);
    }

    #[test]
    fn recent_probe_medium_gpu_is_idle_spd() {
        let s = HardwareSignals {
            apple_gpu_pct:     Some(50.0),
            ai_runtime_loaded: true,
            ai_model_loaded:   true,
            recent_probe:      true,
            ..idle_signals()
        };
        assert_eq!(compute_inference_state(&s), InferenceState::IdleSpd);
    }

    #[test]
    fn no_probe_high_gpu_is_live() {
        let s = HardwareSignals {
            apple_gpu_pct:     Some(99.0),
            ai_runtime_loaded: true,
            ai_model_loaded:   true,
            ..idle_signals()
        };
        assert_eq!(compute_inference_state(&s), InferenceState::Live);
    }

    #[test]
    fn no_probe_low_gpu_with_runtime_is_idle() {
        let s = HardwareSignals {
            apple_gpu_pct:     Some(15.0),
            ai_runtime_loaded: true,
            ai_model_loaded:   true,
            ..idle_signals()
        };
        assert_eq!(compute_inference_state(&s), InferenceState::Idle);
    }

    #[test]
    fn no_probe_low_gpu_no_runtime_high_soc_is_busy() {
        let s = HardwareSignals {
            soc_power_w:       Some(12.0),
            ai_runtime_loaded: false,
            ..idle_signals()
        };
        assert_eq!(compute_inference_state(&s), InferenceState::Busy);
    }

    #[test]
    fn tier2_recent_user_request_is_live() {
        let s = HardwareSignals {
            last_user_request_ts: Some(std::time::Instant::now()),
            ..idle_signals()
        };
        assert_eq!(compute_inference_state(&s), InferenceState::Live);
    }

    #[test]
    fn tier2_expired_user_request_is_not_live() {
        let s = HardwareSignals {
            last_user_request_ts: Some(
                std::time::Instant::now()
                    .checked_sub(std::time::Duration::from_secs(20))
                    .unwrap()
            ),
            ..idle_signals()
        };
        assert_ne!(compute_inference_state(&s), InferenceState::Live);
    }

    #[test]
    fn vllm_requests_is_live() {
        let s = HardwareSignals {
            vllm_requests: Some(3),
            ..idle_signals()
        };
        assert_eq!(compute_inference_state(&s), InferenceState::Live);
    }

    #[test]
    fn llamacpp_requests_is_live() {
        let s = HardwareSignals {
            llamacpp_requests: Some(1),
            ..idle_signals()
        };
        assert_eq!(compute_inference_state(&s), InferenceState::Live);
    }

    #[test]
    fn ane_power_is_live() {
        let s = HardwareSignals {
            ane_power_w:       Some(1.2),
            ai_runtime_loaded: true,
            ai_model_loaded:   true,
            ..idle_signals()
        };
        assert_eq!(compute_inference_state(&s), InferenceState::Live);
    }

    #[test]
    fn inference_state_as_str() {
        assert_eq!(InferenceState::Live.as_str(),    "live");
        assert_eq!(InferenceState::IdleSpd.as_str(), "idle-spd");
        assert_eq!(InferenceState::Busy.as_str(),    "busy");
        assert_eq!(InferenceState::Idle.as_str(),    "idle");
    }

    #[test]
    fn inference_state_display() {
        assert_eq!(InferenceState::Live.to_string(), "live");
        assert_eq!(InferenceState::IdleSpd.to_string(), "idle-spd");
    }

    #[test]
    fn nvidia_saturated_gpu_during_recent_probe_is_live() {
        let s = HardwareSignals {
            nvidia_gpu_pct:    Some(85.0),
            nvidia_vram_mb:    Some(4096),
            ai_runtime_loaded: true,
            ai_model_loaded:   true,
            recent_probe:      true,
            ..idle_signals()
        };
        assert_eq!(compute_inference_state(&s), InferenceState::Live);
    }

    #[test]
    fn runtime_running_no_model_high_gpu_is_not_live() {
        let s = HardwareSignals {
            apple_gpu_pct:     Some(25.0),
            ai_runtime_loaded: true,
            ai_model_loaded:   false,
            ..idle_signals()
        };
        assert_eq!(compute_inference_state(&s), InferenceState::Idle);
    }

    #[test]
    fn runtime_no_model_recent_probe_is_idle() {
        let s = HardwareSignals {
            ai_runtime_loaded: true,
            ai_model_loaded:   false,
            recent_probe:      true,
            ..idle_signals()
        };
        assert_eq!(compute_inference_state(&s), InferenceState::Idle);
    }

    #[test]
    fn fresh_baseline_quiet_gpu_is_idle_spd() {
        let s = HardwareSignals {
            apple_gpu_pct:     Some(3.0),
            ai_runtime_loaded: true,
            ai_model_loaded:   true,
            fresh_baseline:    true,
            ..idle_signals()
        };
        assert_eq!(compute_inference_state(&s), InferenceState::IdleSpd);
    }

    #[test]
    fn fresh_baseline_does_not_blind_physics() {
        let s = HardwareSignals {
            apple_gpu_pct:     Some(50.0),
            ai_runtime_loaded: true,
            ai_model_loaded:   true,
            fresh_baseline:    true,
            ..idle_signals()
        };
        assert_eq!(compute_inference_state(&s), InferenceState::Live);
    }

    #[test]
    fn fresh_baseline_no_model_is_idle() {
        let s = HardwareSignals {
            ai_runtime_loaded: true,
            fresh_baseline:    true,
            ..idle_signals()
        };
        assert_eq!(compute_inference_state(&s), InferenceState::Idle);
    }

    #[test]
    fn bare_idle() {
        assert_eq!(compute_inference_state(&idle_signals()), InferenceState::Idle);
    }
}
