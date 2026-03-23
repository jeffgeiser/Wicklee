use crate::{AppleSiliconMetrics, NvidiaMetrics, OllamaMetrics, VllmMetrics, LlamacppMetrics};

/// Platform-independent sensor bundle. All fields are Option — absent sensors
/// are skipped. No platform #[cfg] branches in the state machine itself.
pub(crate) struct HardwareSignals {
    // Apple Silicon
    pub(crate) ane_power_w:    Option<f32>,  // ANE power — ML-specific, most accurate signal
    pub(crate) soc_power_w:    Option<f32>,  // Combined CPU+GPU+ANE (fallback if ANE absent)
    /// GPU HW active residency % from IOKit (primary) / powermetrics (fallback).
    /// Distinct from GPU *power*: M2 base GPU reads ~88 mW at 40 % residency.
    /// Used as Tier 3 "Power Blindness" override for M2/M3 base chips.
    pub(crate) apple_gpu_pct:  Option<f32>,
    // NVIDIA
    pub(crate) nvidia_gpu_pct: Option<f32>,
    pub(crate) nvidia_vram_mb: Option<u64>,  // non-zero = Ollama process holds GPU memory
    pub(crate) nvidia_power_w: Option<f32>,
    // Runtime presence — gates Tier 3 to prevent false LIVE from non-AI workloads
    pub(crate) ai_runtime_loaded: bool,      // ollama_running || vllm_running
    // Tier 1 exact
    pub(crate) vllm_requests:     Option<u32>,
    pub(crate) llamacpp_requests: Option<u32>,
    // Tier 2 attribution
    pub(crate) probe_active:         bool,
    pub(crate) last_user_request_ts: Option<std::time::Instant>,
    // IDLE-SPD display
    pub(crate) recent_probe: bool,
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
        vllm_requests:        vllm.vllm_requests_running,
        llamacpp_requests:    llamacpp.llamacpp_slots_processing,
        probe_active:         probe_active.load(std::sync::atomic::Ordering::Acquire),
        last_user_request_ts: ollama.last_user_request_ts,
        recent_probe:         ollama.recent_probe_baseline(),
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
    /// Wire-format string. These values are FROZEN — shared with the cloud
    /// backend and React frontend. Do not rename.
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
    // ── Tier 1: Exact runtime counts (zero heuristic) ────────────────────────
    if s.vllm_requests.map_or(false, |r| r > 0) {
        return InferenceState::Live;
    }
    if s.llamacpp_requests.map_or(false, |r| r > 0) {
        return InferenceState::Live;
    }

    // ── Tier 2: Attribution-confirmed user request ────────────────────────────
    // last_user_request_ts is set by /api/ps harvester only when the expires_at
    // change is NOT from our own probe (snapshot-based filter), so this timestamp
    // is guaranteed to represent a real user request.
    if s.last_user_request_ts.map_or(false, |t| t.elapsed().as_secs() < 15) {
        return InferenceState::Live;
    }

    // ── Tier 3: Physics / sensor fusion (≤500ms latency) ─────────────────────
    // Gated by:
    //   !probe_active — probe itself heats silicon
    //   !recent_probe — GPU residency lingers 10-15s after probe ends; without
    //                   this gate the 20% threshold hallucinates LIVE from probe heat
    //   ai_runtime_loaded — prevents LIVE from video encoding, etc.
    //
    // High-confidence override: the synthetic probe never drives GPU above ~60%.
    // If residency is ≥ 75% during the recent_probe window it can only be real
    // user inference — skip the recent_probe gate.
    let saturated_gpu = s.apple_gpu_pct.map_or(false,  |g| g >= 75.0)
                     || s.nvidia_gpu_pct.map_or(false, |g| g >= 75.0);

    if !s.probe_active && (!s.recent_probe || saturated_gpu) && s.ai_runtime_loaded {
        let ai_specific = s.ane_power_w.map_or(false, |p| p > 0.5);
        let physics =
            // SoC power gate (M1 Pro/Max/Ultra, M2/M3 Pro/Max — larger GPU arrays)
            s.soc_power_w.map_or(false, |p| p > 8.0)
            // "Power Blindness" override: M2/M3 base GPU reports near-zero power
            // (~88 mW) even at 40%+ residency. Use GPU residency directly.
            // 20% sits above system-idle flicker (3–5%) and below inference load (40%+).
            || s.apple_gpu_pct.map_or(false, |g| g > 20.0)
            // NVIDIA checks
            || (s.nvidia_gpu_pct.map_or(false, |g| g > 30.0)
                && s.nvidia_vram_mb.map_or(false, |v| v > 0))
            || s.nvidia_power_w.map_or(false, |p| p > 40.0);

        if ai_specific || physics {
            return InferenceState::Live;
        }
    }

    // ── IDLE-SPD: fresh probe baseline available ──────────────────────────────
    if s.recent_probe {
        return InferenceState::IdleSpd;
    }

    // ── BUSY: hardware loaded, no AI runtime ─────────────────────────────────
    let any_load = s.nvidia_gpu_pct.map_or(false, |g| g > 20.0)
                || s.soc_power_w.map_or(false,    |p| p > 10.0);
    if any_load && !s.ai_runtime_loaded {
        return InferenceState::Busy;
    }

    InferenceState::Idle
}

// ── Unit tests for inference state machine ──────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    /// Baseline: all sensors quiet, no runtime loaded.
    fn idle_signals() -> HardwareSignals {
        HardwareSignals {
            ane_power_w:          None,
            soc_power_w:          None,
            apple_gpu_pct:        None,
            nvidia_gpu_pct:       None,
            nvidia_vram_mb:       None,
            nvidia_power_w:       None,
            ai_runtime_loaded:    false,
            vllm_requests:        None,
            llamacpp_requests:    None,
            probe_active:         false,
            last_user_request_ts: None,
            recent_probe:         false,
        }
    }

    // ── Test 1: Probe running + user inference → NOT LIVE ────────────────────
    // Probe is on silicon; physics would be ambiguous. Must stay non-LIVE.
    #[test]
    fn probe_active_high_gpu_not_live() {
        let s = HardwareSignals {
            apple_gpu_pct:     Some(99.0),
            ai_runtime_loaded: true,
            probe_active:      true,
            ..idle_signals()
        };
        assert_ne!(compute_inference_state(&s), InferenceState::Live);
    }

    // ── Test 2: Probe just ended + high GPU → LIVE (saturated override) ─────
    // GPU ≥ 75% is physically impossible from probe residual → must be user.
    #[test]
    fn recent_probe_saturated_gpu_is_live() {
        let s = HardwareSignals {
            apple_gpu_pct:     Some(99.0),
            ai_runtime_loaded: true,
            recent_probe:      true,
            ..idle_signals()
        };
        assert_eq!(compute_inference_state(&s), InferenceState::Live);
    }

    // ── Test 3: Probe just ended + medium GPU → IDLE-SPD ────────────────────
    // 50% could be probe residency decay (~45-60% range). Must stay IDLE-SPD.
    #[test]
    fn recent_probe_medium_gpu_is_idle_spd() {
        let s = HardwareSignals {
            apple_gpu_pct:     Some(50.0),
            ai_runtime_loaded: true,
            recent_probe:      true,
            ..idle_signals()
        };
        assert_eq!(compute_inference_state(&s), InferenceState::IdleSpd);
    }

    // ── Test 4: No probe history + GPU 99% → LIVE ───────────────────────────
    #[test]
    fn no_probe_high_gpu_is_live() {
        let s = HardwareSignals {
            apple_gpu_pct:     Some(99.0),
            ai_runtime_loaded: true,
            ..idle_signals()
        };
        assert_eq!(compute_inference_state(&s), InferenceState::Live);
    }

    // ── Test 5: No probe history + GPU 15% → IDLE or BUSY ──────────────────
    // 15% is below the 20% physics threshold.
    #[test]
    fn no_probe_low_gpu_with_runtime_is_idle() {
        let s = HardwareSignals {
            apple_gpu_pct:     Some(15.0),
            ai_runtime_loaded: true,
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

    // ── Test 6: Tier 2 fires within 15s → LIVE ─────────────────────────────
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
            // 20s ago — beyond the 15s window
            last_user_request_ts: Some(
                std::time::Instant::now()
                    .checked_sub(std::time::Duration::from_secs(20))
                    .unwrap()
            ),
            ..idle_signals()
        };
        assert_ne!(compute_inference_state(&s), InferenceState::Live);
    }

    // ── Test 7: vLLM requests > 0 → LIVE unconditionally (Tier 1) ──────────
    #[test]
    fn vllm_requests_is_live() {
        let s = HardwareSignals {
            vllm_requests: Some(3),
            ..idle_signals()
        };
        assert_eq!(compute_inference_state(&s), InferenceState::Live);
    }

    // ── Test 8: llama.cpp slots_processing > 0 → LIVE unconditionally (Tier 1)
    #[test]
    fn llamacpp_requests_is_live() {
        let s = HardwareSignals {
            llamacpp_requests: Some(1),
            ..idle_signals()
        };
        assert_eq!(compute_inference_state(&s), InferenceState::Live);
    }

    // ── Test 9: ANE power > 0.5W → LIVE (ai_specific path) ─────────────────
    #[test]
    fn ane_power_is_live() {
        let s = HardwareSignals {
            ane_power_w:       Some(1.2),
            ai_runtime_loaded: true,
            ..idle_signals()
        };
        assert_eq!(compute_inference_state(&s), InferenceState::Live);
    }

    // ── Additional edge cases ───────────────────────────────────────────────

    // Wire-format serialization is correct.
    #[test]
    fn inference_state_as_str() {
        assert_eq!(InferenceState::Live.as_str(),    "live");
        assert_eq!(InferenceState::IdleSpd.as_str(), "idle-spd");
        assert_eq!(InferenceState::Busy.as_str(),    "busy");
        assert_eq!(InferenceState::Idle.as_str(),    "idle");
    }

    // Display impl matches as_str (used by .to_string() at call sites).
    #[test]
    fn inference_state_display() {
        assert_eq!(InferenceState::Live.to_string(), "live");
        assert_eq!(InferenceState::IdleSpd.to_string(), "idle-spd");
    }

    // NVIDIA saturated GPU also triggers the override.
    #[test]
    fn nvidia_saturated_gpu_during_recent_probe_is_live() {
        let s = HardwareSignals {
            nvidia_gpu_pct:    Some(85.0),
            nvidia_vram_mb:    Some(4096),
            ai_runtime_loaded: true,
            recent_probe:      true,
            ..idle_signals()
        };
        assert_eq!(compute_inference_state(&s), InferenceState::Live);
    }

    // Bare idle — no sensors, no runtime → IDLE.
    #[test]
    fn bare_idle() {
        assert_eq!(compute_inference_state(&idle_signals()), InferenceState::Idle);
    }
}
