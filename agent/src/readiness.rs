//! Which installed models can run right now without disturbing another active
//! workload.
//!
//! A pure function of current state, memory headroom and the transition log.
//! Nothing here does I/O, so every branch is reachable from a test without a
//! runtime. It assesses operational suitability only, and never says two
//! models are interchangeable.
//!
//! The three kinds of knowledge the spec keeps apart are visible in the types:
//!
//! - **Observed** — what is loaded and what it occupies, from [`ModelState`].
//! - **Estimated** — whether something else fits, labelled by [`FitBasis`].
//! - **Uncertain** — which models the runtime would unload. [`Victim`] cannot
//!   be built without a [`VictimBasis`], so the code cannot name a model on a
//!   guess.

use serde::Serialize;

use crate::findings::{Statement, push_statement};
use crate::metrics::{AppleSiliconMetrics, NvidiaMetrics};
use crate::residency::{ModelState, Residency, Transition, TransitionKind};

/// A model counts as in use when it had activity this recently.
const IN_USE_WINDOW_MS: i64 = 60_000;

/// Two poll intervals, which is how long an answer is worth acting on.
const VALID_FOR_S: u32 = 10;

/// Headroom kept back when deciding whether something fits.
///
/// Not a measured figure. It matches the 512 MiB working-set floor in
/// `scoring.rs`, which exists because a 10% allowance underestimated real
/// usage by 2-3x and produced "fits" answers for models that then ran out of
/// memory. The margin is stated in every answer so a caller can see it.
const SAFETY_MARGIN_BYTES: u64 = 512 * 1024 * 1024;

/// How many times the all-resident clear-out must have been seen before a
/// prediction is built on it. The spec's `LikelyAll` requires at least twice:
/// once is an event, twice is a pattern.
const CLEAROUT_OCCURRENCES_FOR_LIKELY_ALL: u32 = 2;

const MIB: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Readiness {
    ReadyNow,
    RequiresLoading,
    MayRequireEviction,
    CannotDetermine,
}

/// How certain the displacement is. Never `Verified`, at any level: each one is
/// a prediction about a memory-gated decision made by software Wicklee does not
/// control.
///
/// Revision 1 had a `Confirmed` level built on loads repeatedly evicting the
/// same victim. V4 disproved it — eviction here is memory-gated rather than
/// least-recently-used, the same sequence gave different outcomes minutes
/// apart, and a load that did not fit removed *every* resident model including
/// one touched immediately beforehand to make it most recently used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Displacement {
    /// The log shows a non-fitting load clearing everything resident, twice or
    /// more. Names every resident model.
    LikelyAll,
    /// Exactly one other model is loaded, so it is the only thing that can go.
    Likely,
    /// Several are loaded and the clear-out pattern has not been seen here.
    /// Names nothing.
    UnknownVictim,
}

/// How the footprint was established.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FitBasis {
    /// An observed `size` for this digest at this context length.
    Measured,
    /// Installed file size plus overhead. Excludes KV cache, which V1 measured
    /// at 8.7 GB of an 11.4 GB resident model, so it is not a fit estimate on
    /// its own.
    EstimatedWeightsOnly,
}

/// Why a specific model can be named. A [`Victim`] cannot exist without one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "basis", rename_all = "snake_case")]
pub(crate) enum VictimBasis {
    /// A load that did not fit cleared every resident model, this many times.
    AllResident { occurrences: u32 },
    /// It is the only thing loaded.
    OnlyLoadedModel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Victim {
    pub(crate) model: String,
    /// `None` when no activity signal is available on this runtime.
    pub(crate) in_use: Option<bool>,
    #[serde(flatten)]
    pub(crate) basis: VictimBasis,
}

/// Free accelerator memory, and where the number came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) struct Headroom {
    pub(crate) free_bytes: u64,
    /// Named in the answer, because the two sources are not equally good:
    /// NVML reports real free memory including other processes' use, while the
    /// Apple figure is a budget minus what Ollama itself holds.
    pub(crate) source: &'static str,
}

/// The ratio between a measured resident footprint and an installed file size.
///
/// V7 found `/api/tags` reports the installed *file* size and that it exceeds
/// the resident `size` — qwen3.5:4b is 3.39 GB installed against 3.15 GB
/// resident at context 4096. So an estimate built by adding overhead to the
/// file size starts above the observed footprint and then goes higher, while
/// omitting KV cache pulls the other way. The net direction is not knowable in
/// advance, so the estimate is calibrated against real measurements from this
/// host before it is trusted.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub(crate) struct Calibration {
    pub(crate) ratio: f64,
    pub(crate) samples: u32,
}

/// A resolved footprint and how it was arrived at.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct Footprint {
    pub(crate) bytes: u64,
    pub(crate) basis: FitBasis,
    /// The context this footprint is for. Required on a measured basis, because
    /// a footprint without its context cannot be compared to anything.
    pub(crate) context_length: Option<u64>,
    /// Whether an estimated footprint was corrected against measurements from
    /// this host. An uncalibrated estimate cannot produce a "fits" answer.
    pub(crate) calibrated: bool,
}

/// One model's answer.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct ModelReadiness {
    pub(crate) model: String,
    pub(crate) readiness: Readiness,
    /// This model's own contention, not a victim's.
    pub(crate) in_use: Option<bool>,
    /// When that activity was, so a caller can say "in use 12 s ago" rather
    /// than only "in use". `None` when nothing has been attributed to a real
    /// caller, which is not the same as the model being idle.
    pub(crate) last_activity_ms: Option<i64>,
    /// Only present with `MayRequireEviction`.
    pub(crate) displacement: Option<Displacement>,
    pub(crate) fit_basis: Option<FitBasis>,
    pub(crate) footprint: Option<Footprint>,
    pub(crate) headroom: Option<Headroom>,
    pub(crate) safety_margin_bytes: u64,
    /// Empty unless evidence names a model.
    pub(crate) would_displace: Vec<Victim>,
    pub(crate) statements: Vec<Statement>,
    pub(crate) observed_at_ms: i64,
    pub(crate) valid_for_s: u32,
}

/// Everything a readiness answer is computed from.
pub(crate) struct Inputs<'a> {
    pub(crate) states: Vec<&'a ModelState>,
    /// The recent transition log, ascending. Statements cite it, so an answer
    /// about a model the log does not mention carries fewer statements rather
    /// than invented ones.
    pub(crate) transitions: &'a [Transition],
    pub(crate) headroom: Option<Headroom>,
    /// Whether this runtime gives any activity signal at all. Without one,
    /// `in_use` is unknown rather than false.
    pub(crate) activity_signal: bool,
    pub(crate) now_ms: i64,
}

/// Free accelerator memory from the best available source.
///
/// NVML first: it reports real free memory, including what other processes
/// hold. The Apple figure is the unified-memory budget for the GPU less what
/// the runtime's resident models occupy, which misses every other consumer on
/// the machine and is therefore optimistic — the answer names which was used.
/// `None` when neither is available, which makes every answer
/// `CannotDetermine`.
pub(crate) fn headroom(
    apple: &AppleSiliconMetrics,
    nvidia: &NvidiaMetrics,
    states: &[&ModelState],
) -> Option<Headroom> {
    if let (Some(total), Some(used)) = (nvidia.nvidia_vram_total_mb, nvidia.nvidia_vram_used_mb) {
        return Some(Headroom {
            free_bytes: total.saturating_sub(used).saturating_mul(MIB),
            source: "nvml",
        });
    }
    let budget = apple.gpu_wired_limit_mb?.saturating_mul(MIB);
    let resident: u64 = states
        .iter()
        .filter(|s| s.residency == Residency::Loaded)
        .filter_map(|s| s.size_vram_bytes)
        .sum();
    Some(Headroom {
        free_bytes: budget.saturating_sub(resident),
        source: "apple_wired_limit",
    })
}

/// The installed-size-to-resident-size ratio, averaged over models where both
/// are known on this host.
pub(crate) fn calibrate(states: &[&ModelState]) -> Option<Calibration> {
    let mut sum = 0.0_f64;
    let mut samples = 0_u32;
    for s in states {
        let (Some(m), Some(installed)) = (s.measured.as_ref(), s.installed_size_bytes) else {
            continue;
        };
        if installed == 0 {
            continue;
        }
        sum += m.size_bytes as f64 / installed as f64;
        samples += 1;
    }
    (samples > 0).then(|| Calibration { ratio: sum / f64::from(samples), samples })
}

/// Resolve a model's footprint from the best available source.
///
/// 1. The `size` observed in `/api/ps` for this digest at this context.
/// 2. The installed file size, corrected by [`Calibration`] when one exists,
///    or `scoring.rs`'s overhead estimate when none does.
/// 3. Neither: `None`, which becomes `CannotDetermine`.
pub(crate) fn footprint(state: &ModelState, cal: Option<&Calibration>) -> Option<Footprint> {
    if state.residency == Residency::Loaded
        && let Some(bytes) = state.size_bytes
    {
        return Some(Footprint {
            bytes,
            basis: FitBasis::Measured,
            context_length: state.context_length,
            calibrated: true,
        });
    }
    if let Some(m) = state.measured.as_ref()
        // A model rebuilt under the same tag is a different model, so a
        // measurement taken under another digest does not transfer.
        && (m.digest.is_none() || state.digest.is_none() || m.digest == state.digest)
    {
        return Some(Footprint {
            bytes: m.size_bytes,
            basis: FitBasis::Measured,
            context_length: Some(m.context_length),
            calibrated: true,
        });
    }
    let installed = state.installed_size_bytes?;
    let (bytes, calibrated) = match cal {
        Some(c) => ((installed as f64 * c.ratio).round() as u64, true),
        None => (crate::scoring::estimate_vram_mb(installed) * MIB, false),
    };
    Some(Footprint {
        bytes,
        basis: FitBasis::EstimatedWeightsOnly,
        // Unknown: the file size is not tied to any context, and the runtime
        // will pick one when it loads. V3 measured that default as 4096.
        context_length: None,
        calibrated,
    })
}

/// The loads in the log that cleared every resident model.
///
/// The pattern is a `Loaded` transition sharing a poll with two or more
/// `Unloaded` ones, where the load ends up with nothing else resident. Two
/// rather than one, so "all" is genuinely all: clearing the single resident
/// model is the `Likely` case and is not evidence of a clear-out.
pub(crate) fn clearouts(transitions: &[Transition]) -> Vec<&Transition> {
    transitions
        .iter()
        .filter(|load| {
            load.kind == TransitionKind::Loaded
                && load.co_resident.is_empty()
                && transitions
                    .iter()
                    .filter(|u| {
                        u.kind == TransitionKind::Unloaded
                            && u.ts_ms == load.ts_ms
                            && u.model != load.model
                    })
                    .count()
                    >= 2
        })
        .collect()
}

/// Whether a model had activity inside the window.
///
/// `None` when the runtime gives no activity signal, because "we looked and saw
/// nothing" and "we have no way to look" are different answers.
fn in_use(state: &ModelState, now_ms: i64, activity_signal: bool) -> Option<bool> {
    if !activity_signal {
        return None;
    }
    Some(
        state
            .last_activity_ms
            .is_some_and(|ts| now_ms.saturating_sub(ts) <= IN_USE_WINDOW_MS),
    )
}

/// Assess every model the tracker knows about, by name.
pub(crate) fn assess(inputs: &Inputs) -> Vec<ModelReadiness> {
    let cal = calibrate(&inputs.states);
    let clearouts = clearouts(inputs.transitions);
    inputs
        .states
        .iter()
        .map(|s| assess_state(s, inputs, cal.as_ref(), &clearouts))
        .collect()
}

/// Assess one model, or `None` if the tracker has never heard of it.
pub(crate) fn assess_one(inputs: &Inputs, model: &str) -> Option<ModelReadiness> {
    let state = inputs.states.iter().find(|s| s.model == model)?;
    let cal = calibrate(&inputs.states);
    let clearouts = clearouts(inputs.transitions);
    Some(assess_state(state, inputs, cal.as_ref(), &clearouts))
}

fn assess_state(
    state: &ModelState,
    inputs: &Inputs,
    cal: Option<&Calibration>,
    clearouts: &[&Transition],
) -> ModelReadiness {
    let fit = footprint(state, cal);
    let mine = in_use(state, inputs.now_ms, inputs.activity_signal);
    let mut statements: Vec<Statement> = Vec::new();
    let mut would_displace: Vec<Victim> = Vec::new();
    let mut displacement = None;

    // The most recent transition about this model, for statements to cite.
    let own: Option<&Transition> = inputs
        .transitions
        .iter()
        .rev()
        .find(|t| t.model == state.model);

    let readiness = if state.residency == Residency::Loaded {
        if let Some(t) = own {
            let placement = match state.outside_accelerator_percent() {
                Some(pct) if pct > 0.0 => format!(", {pct}% of its runtime footprint outside accelerator memory"),
                Some(_) => ", fully inside accelerator memory".to_string(),
                None => String::new(),
            };
            let context = match state.context_length {
                Some(c) => format!(", running at context {c}"),
                None => String::new(),
            };
            push_statement(
                &mut statements,
                "readiness.loaded",
                Statement::observed(
                    format!("{} is resident{placement}{context}.", state.model),
                    &[t],
                ),
            );
        }
        Readiness::ReadyNow
    } else {
        match (fit.as_ref(), inputs.headroom) {
            (None, _) | (_, None) => Readiness::CannotDetermine,
            (Some(f), Some(h)) => {
                let fits = f.bytes.saturating_add(SAFETY_MARGIN_BYTES) <= h.free_bytes;
                // An uncalibrated weights-only estimate must not be the sole
                // basis for the optimistic answer: its error is two-sided and
                // its direction is not knowable (V7).
                let trustworthy = f.basis == FitBasis::Measured || f.calibrated;
                if fits && trustworthy {
                    Readiness::RequiresLoading
                } else if fits {
                    // It appears to fit, on a number nothing has calibrated.
                    // The spec forbids the optimistic answer here — but the
                    // conservative one is `MayRequireEviction`, whose every
                    // condition begins "the footprint does not fit", and this
                    // footprint has not been shown not to fit. Claiming
                    // eviction would state something about resident models
                    // that is not true, and on a host with nothing resident
                    // there is nothing to evict at all. So: the footprint
                    // cannot be established to a usable standard, which is
                    // what `CannotDetermine` means.
                    //
                    // No statement is attached. There is no observed
                    // transition under this — the model has never been loaded
                    // here — so the evidence rules forbid an inferred one, and
                    // they are right to: the reason is a property of the
                    // footprint, not a finding about the host. `fit_basis` and
                    // `footprint.calibrated` carry it, and the renderer reads
                    // them.
                    Readiness::CannotDetermine
                } else {
                    let resident: Vec<&&ModelState> = inputs
                        .states
                        .iter()
                        .filter(|s| {
                            s.residency == Residency::Loaded && s.model != state.model
                        })
                        .collect();
                    let (level, victims) = displace(&resident, clearouts, inputs);
                    displacement = level;
                    would_displace = victims;
                    Readiness::MayRequireEviction
                }
            }
        }
    };

    // Evidence for the displacement, in the order the spec's example shows:
    // what is resident, then the history, then the prediction built on both.
    if readiness == Readiness::MayRequireEviction {
        describe_displacement(
            state,
            &fit,
            inputs,
            clearouts,
            &would_displace,
            displacement,
            &mut statements,
        );
    }

    ModelReadiness {
        model: state.model.clone(),
        readiness,
        in_use: mine,
        last_activity_ms: state.last_activity_ms,
        displacement,
        fit_basis: fit.as_ref().map(|f| f.basis),
        footprint: fit,
        headroom: inputs.headroom,
        safety_margin_bytes: SAFETY_MARGIN_BYTES,
        would_displace,
        statements,
        observed_at_ms: inputs.now_ms,
        valid_for_s: VALID_FOR_S,
    }
}

/// Pick the displacement level and the victims it justifies naming.
///
/// `None` when nothing else is resident. The spec says `MayRequireEviction`
/// always carries one of the three levels, but every level's condition names
/// resident models — `LikelyAll` all of them, `Likely` the one, `UnknownVictim`
/// "several models are loaded" — so with nothing resident none of them is
/// true. A model too large for an empty accelerator still does not fit, which
/// is what the state means; there is simply nothing to displace, and saying
/// `UnknownVictim` would imply victims that do not exist.
fn displace(
    resident: &[&&ModelState],
    clearouts: &[&Transition],
    inputs: &Inputs,
) -> (Option<Displacement>, Vec<Victim>) {
    let occurrences = u32::try_from(clearouts.len()).unwrap_or(u32::MAX);
    let victim = |s: &ModelState, basis: VictimBasis| Victim {
        model: s.model.clone(),
        in_use: in_use(s, inputs.now_ms, inputs.activity_signal),
        basis,
    };

    if occurrences >= CLEAROUT_OCCURRENCES_FOR_LIKELY_ALL && !resident.is_empty() {
        let basis = VictimBasis::AllResident { occurrences };
        return (
            Some(Displacement::LikelyAll),
            resident.iter().map(|s| victim(s, basis)).collect(),
        );
    }
    if resident.len() == 1 {
        return (
            Some(Displacement::Likely),
            vec![victim(resident[0], VictimBasis::OnlyLoadedModel)],
        );
    }
    if resident.is_empty() {
        return (None, Vec::new());
    }
    // Several models and no pattern to go on. Nothing is named, and
    // `would_displace` stays empty.
    (Some(Displacement::UnknownVictim), Vec::new())
}

fn describe_displacement(
    state: &ModelState,
    fit: &Option<Footprint>,
    inputs: &Inputs,
    clearouts: &[&Transition],
    victims: &[Victim],
    level: Option<Displacement>,
    statements: &mut Vec<Statement>,
) {
    let rule = "readiness.displacement";

    // What is resident, cited from the transitions that put it there.
    let names: Vec<String> = victims.iter().map(|v| v.model.clone()).collect();
    let basis: Vec<&Transition> = names
        .iter()
        .filter_map(|m| inputs.transitions.iter().rev().find(|t| &t.model == m))
        .collect();
    let mut resident_stmt = None;
    if !names.is_empty() && !basis.is_empty() {
        let activity = victims
            .iter()
            .filter(|v| v.in_use == Some(true))
            .map(|v| v.model.as_str())
            .collect::<Vec<_>>();
        let suffix = match activity.as_slice() {
            [] => String::new(),
            [one] => format!(" {one} had activity in the last minute."),
            many => format!(" {} had activity in the last minute.", many.join(" and ")),
        };
        let made = Statement::observed_naming(
            format!("{} {} resident.{suffix}", names.join(" and "), if names.len() == 1 { "is" } else { "are" }),
            &basis,
            &names,
        );
        if let Ok(s) = made {
            resident_stmt = Some(s.clone());
            statements.push(s);
        } else if let Err(e) = made {
            eprintln!("[evidence] {rule}: dropped a statement — {e}");
        }
    }

    // The history, worded as history and never as a prediction.
    let mut history_stmt = None;
    if level == Some(Displacement::LikelyAll) && !clearouts.is_empty() {
        let n = clearouts.len();
        let made = Statement::observed(
            format!(
                "On {n} of {n} occasions on this host, a load that did not fit cleared all resident models."
            ),
            clearouts,
        );
        if let Ok(s) = made {
            history_stmt = Some(s.clone());
            statements.push(s);
        }
    }

    // The prediction. Hedged, because the runtime is non-deterministic: a
    // non-fitting load may still clear only a subset.
    let supports: Vec<&Statement> = resident_stmt
        .iter()
        .chain(history_stmt.iter())
        .collect();
    if supports.is_empty() {
        return;
    }
    let need = match fit {
        Some(f) => {
            let gb = f.bytes as f64 / 1_073_741_824.0;
            match f.basis {
                FitBasis::Measured => format!("{} needs about {gb:.1} GB, measured", state.model),
                FitBasis::EstimatedWeightsOnly => format!(
                    "{} needs at least {gb:.1} GB of weights, excluding KV cache, which at this context may add several GB more",
                    state.model
                ),
            }
        }
        None => format!("{}'s footprint is unknown", state.model),
    };
    let free = inputs
        .headroom
        .map(|h| format!("{:.1} GB is free", h.free_bytes as f64 / 1_073_741_824.0))
        .unwrap_or_else(|| "free memory is unknown".to_string());
    let outcome = match level {
        Some(Displacement::LikelyAll) => {
            format!("loading it will likely clear all {} resident models", victims.len())
        }
        Some(Displacement::Likely) => format!(
            "loading it will likely clear {}",
            victims.first().map(|v| v.model.as_str()).unwrap_or("the resident model")
        ),
        _ => "loading it may clear one or more resident models".to_string(),
    };
    push_statement(
        statements,
        rule,
        Statement::inferred(format!("{need}, and {free}, so {outcome}."), &supports),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::findings::Evidence;
    use crate::residency::{Cause, MeasuredFootprint};

    const T0: i64 = 1_700_000_000_000;
    const GB: u64 = 1024 * 1024 * 1024;

    fn blank(model: &str) -> ModelState {
        ModelState {
            model: model.to_string(),
            digest: Some(format!("sha256:{model}")),
            residency: Residency::NotLoaded,
            size_bytes: None,
            size_vram_bytes: None,
            context_length: None,
            expires_at_ms: None,
            last_activity_ms: None,
            installed_size_bytes: None,
            measured: None,
            observed_at_ms: T0,
        }
    }

    fn loaded(model: &str, size: u64, vram: u64) -> ModelState {
        ModelState {
            residency: Residency::Loaded,
            size_bytes: Some(size),
            size_vram_bytes: Some(vram),
            context_length: Some(4096),
            expires_at_ms: Some(T0 + 300_000),
            measured: Some(MeasuredFootprint {
                size_bytes: size,
                context_length: 4096,
                digest: Some(format!("sha256:{model}")),
                observed_at_ms: T0,
            }),
            ..blank(model)
        }
    }

    fn apple(budget_mb: u64) -> AppleSiliconMetrics {
        AppleSiliconMetrics { gpu_wired_limit_mb: Some(budget_mb), ..Default::default() }
    }

    fn tr(id: u64, ts: i64, model: &str, kind: TransitionKind, co: &[&str]) -> Transition {
        Transition {
            id,
            ts_ms: ts,
            model: model.to_string(),
            kind,
            cause: Cause::User,
            before: None,
            after: None,
            co_resident: co.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// Two clear-outs: at each timestamp, two models go and one arrives with
    /// nothing else resident.
    fn two_clearouts() -> Vec<Transition> {
        let mut v = Vec::new();
        for (i, ts) in [T0, T0 + 60_000].into_iter().enumerate() {
            let base = i as u64 * 10;
            v.push(tr(base + 1, ts, "coder:14b", TransitionKind::Unloaded, &[]));
            v.push(tr(base + 2, ts, "classifier:3b", TransitionKind::Unloaded, &[]));
            v.push(tr(base + 3, ts, "big:70b", TransitionKind::Loaded, &[]));
        }
        v
    }

    fn inputs<'a>(
        states: &'a [&'a ModelState],
        transitions: &'a [Transition],
        headroom: Option<Headroom>,
    ) -> Inputs<'a> {
        Inputs {
            states: states.to_vec(),
            transitions,
            headroom,
            activity_signal: true,
            now_ms: T0 + 120_000,
        }
    }

    // ── Classification ──────────────────────────────────────────────────────

    #[test]
    fn a_loaded_model_is_ready_now_and_says_how_it_sits() {
        let s = loaded("coder:14b", 10 * GB, 6 * GB);
        let log = vec![tr(1, T0, "coder:14b", TransitionKind::Loaded, &[])];
        let r = assess_one(&inputs(&[&s], &log, Some(Headroom { free_bytes: GB, source: "t" })), "coder:14b")
            .unwrap();

        assert_eq!(r.readiness, Readiness::ReadyNow);
        assert_eq!(r.fit_basis, Some(FitBasis::Measured));
        assert!(r.displacement.is_none(), "nothing is displaced by a model already loaded");
        assert!(r.would_displace.is_empty());
        // Loaded does not mean fast: the placement is in the statement.
        let text = &r.statements[0].text;
        assert!(text.contains("40% of its runtime footprint outside"), "got {text:?}");
        assert!(text.contains("context 4096"), "got {text:?}");
        assert_eq!(r.statements[0].label, Evidence::Observed);
        assert_eq!(r.valid_for_s, 10);
    }

    #[test]
    fn no_footprint_and_no_headroom_both_give_cannot_determine() {
        // Never loaded, no installed size: nothing to measure or estimate.
        let unknown = blank("embed:small");
        let r = assess_one(
            &inputs(&[&unknown], &[], Some(Headroom { free_bytes: 64 * GB, source: "t" })),
            "embed:small",
        )
        .unwrap();
        assert_eq!(r.readiness, Readiness::CannotDetermine);
        assert!(r.fit_basis.is_none());

        // A known footprint, but nothing known about free memory.
        let mut known = blank("extractor:8b");
        known.installed_size_bytes = Some(4 * GB);
        let r = assess_one(&inputs(&[&known], &[], None), "extractor:8b").unwrap();
        assert_eq!(r.readiness, Readiness::CannotDetermine);
        assert!(r.headroom.is_none());
    }

    #[test]
    fn a_measured_footprint_that_fits_requires_only_loading() {
        let mut s = blank("extractor:8b");
        s.measured = Some(MeasuredFootprint {
            size_bytes: 5 * GB,
            context_length: 4096,
            digest: Some("sha256:extractor:8b".into()),
            observed_at_ms: T0,
        });
        let r = assess_one(
            &inputs(&[&s], &[], Some(Headroom { free_bytes: 8 * GB, source: "nvml" })),
            "extractor:8b",
        )
        .unwrap();
        assert_eq!(r.readiness, Readiness::RequiresLoading);
        assert_eq!(r.fit_basis, Some(FitBasis::Measured));
        // The context is part of the measurement, not a label on it.
        assert_eq!(r.footprint.as_ref().unwrap().context_length, Some(4096));
    }

    #[test]
    fn a_stale_measurement_under_another_digest_is_not_reused() {
        let mut s = blank("extractor:8b");
        s.digest = Some("sha256:rebuilt".into());
        s.installed_size_bytes = Some(4 * GB);
        s.measured = Some(MeasuredFootprint {
            size_bytes: 5 * GB,
            context_length: 4096,
            digest: Some("sha256:old".into()),
            observed_at_ms: T0,
        });
        let r = assess_one(
            &inputs(&[&s], &[], Some(Headroom { free_bytes: 64 * GB, source: "nvml" })),
            "extractor:8b",
        )
        .unwrap();
        assert_eq!(
            r.fit_basis,
            Some(FitBasis::EstimatedWeightsOnly),
            "a model rebuilt under the same tag is a different model"
        );
    }

    #[test]
    fn an_uncalibrated_estimate_cannot_produce_a_fits_answer() {
        // It would fit on the estimate alone, with room to spare.
        let mut s = blank("extractor:8b");
        s.installed_size_bytes = Some(3 * GB);
        let headroom = Some(Headroom { free_bytes: 32 * GB, source: "nvml" });

        let r = assess_one(&inputs(&[&s], &[], headroom), "extractor:8b").unwrap();
        assert_eq!(
            r.readiness,
            Readiness::CannotDetermine,
            "the error is two-sided and its direction is not knowable, so the optimistic answer is not available"
        );
        // And not the eviction answer either: every condition for that state
        // begins "the footprint does not fit", and this one has not been shown
        // not to fit. Nothing is resident here, so there would be nothing to
        // evict even if it were true.
        assert_eq!(r.displacement, None, "nothing may be claimed about victims");
        assert!(r.would_displace.is_empty());
        assert_eq!(r.fit_basis, Some(FitBasis::EstimatedWeightsOnly));
        assert!(!r.footprint.as_ref().unwrap().calibrated);

        // One model with both a measurement and a file size calibrates it.
        let mut cal_model = loaded("qwen3.5:4b", 3_151_000_000, 3_151_000_000);
        cal_model.installed_size_bytes = Some(3_389_983_735);
        let r = assess_one(&inputs(&[&s, &cal_model], &[], headroom), "extractor:8b").unwrap();
        assert_eq!(r.readiness, Readiness::RequiresLoading);
        assert!(r.footprint.as_ref().unwrap().calibrated);
    }

    #[test]
    fn calibration_is_the_measured_over_installed_ratio() {
        let mut m = loaded("qwen3.5:4b", 3_151_000_000, 3_151_000_000);
        m.installed_size_bytes = Some(3_389_983_735);
        let no_pair = blank("other");
        let c = calibrate(&[&m, &no_pair]).unwrap();
        assert_eq!(c.samples, 1, "only models with both halves count");
        // V7's measured pair: resident is below installed.
        assert!((c.ratio - 0.929_5).abs() < 0.001, "ratio was {}", c.ratio);
        assert!(calibrate(&[&no_pair]).is_none());
    }

    // ── Displacement ────────────────────────────────────────────────────────

    #[test]
    fn likely_all_names_every_resident_model_and_cites_the_history() {
        let coder = loaded("coder:14b", 10 * GB, 10 * GB);
        let mut classifier = loaded("classifier:3b", 2 * GB, 2 * GB);
        classifier.last_activity_ms = None;
        let mut target = blank("reasoner:14b");
        target.installed_size_bytes = Some(20 * GB);
        let log = two_clearouts();

        let states = [&coder, &classifier, &target];
        let r = assess_one(
            &inputs(&states, &log, Some(Headroom { free_bytes: 3 * GB, source: "nvml" })),
            "reasoner:14b",
        )
        .unwrap();

        assert_eq!(r.readiness, Readiness::MayRequireEviction);
        assert_eq!(r.displacement, Some(Displacement::LikelyAll));
        let named: Vec<&str> = r.would_displace.iter().map(|v| v.model.as_str()).collect();
        assert_eq!(named, vec!["coder:14b", "classifier:3b"]);
        for v in &r.would_displace {
            assert_eq!(v.basis, VictimBasis::AllResident { occurrences: 2 });
        }

        // History is worded as history, and the prediction stays hedged.
        let history = r
            .statements
            .iter()
            .find(|s| s.text.contains("occasions"))
            .expect("the all-resident history must be stated");
        assert_eq!(history.label, Evidence::Observed);
        assert!(history.text.contains("On 2 of 2 occasions"), "got {:?}", history.text);

        let predicted = r
            .statements
            .iter()
            .find(|s| s.label == Evidence::Inferred)
            .expect("a displacement prediction must be made");
        assert!(
            predicted.text.contains("likely") || predicted.text.contains("may"),
            "the runtime is non-deterministic, so the prediction hedges: {:?}",
            predicted.text
        );
        assert!(predicted.text.contains("excluding KV cache"), "got {:?}", predicted.text);
    }

    #[test]
    fn likely_names_the_only_other_loaded_model() {
        let coder = loaded("coder:14b", 10 * GB, 10 * GB);
        let mut target = blank("reasoner:14b");
        target.installed_size_bytes = Some(20 * GB);
        let log = vec![tr(1, T0, "coder:14b", TransitionKind::Loaded, &[])];

        let r = assess_one(
            &inputs(&[&coder, &target], &log, Some(Headroom { free_bytes: GB, source: "nvml" })),
            "reasoner:14b",
        )
        .unwrap();
        assert_eq!(r.displacement, Some(Displacement::Likely));
        assert_eq!(r.would_displace.len(), 1);
        assert_eq!(r.would_displace[0].model, "coder:14b");
        assert_eq!(r.would_displace[0].basis, VictimBasis::OnlyLoadedModel);
    }

    #[test]
    fn unknown_victim_names_nothing() {
        // Several resident, and the clear-out pattern has not been seen here.
        let a = loaded("a", 4 * GB, 4 * GB);
        let b = loaded("b", 4 * GB, 4 * GB);
        let c = loaded("c", 4 * GB, 4 * GB);
        let mut target = blank("reasoner:14b");
        target.installed_size_bytes = Some(40 * GB);
        let r = assess_one(
            &inputs(
                &[&a, &b, &c, &target],
                &[],
                Some(Headroom { free_bytes: GB, source: "nvml" }),
            ),
            "reasoner:14b",
        )
        .unwrap();
        assert_eq!(r.displacement, Some(Displacement::UnknownVictim));
        assert!(r.would_displace.is_empty(), "nothing may be named on a guess");

        // Nothing resident at all. It still does not fit — 40 GB against 1 GB
        // free, far outside anything the estimate's error could close — so the
        // state stands, but there is no displacement level that is true: every
        // one of the three names resident models, and there are none.
        let mut target = blank("reasoner:14b");
        target.installed_size_bytes = Some(40 * GB);
        let r = assess_one(
            &inputs(&[&target], &[], Some(Headroom { free_bytes: GB, source: "nvml" })),
            "reasoner:14b",
        )
        .unwrap();
        assert_eq!(r.readiness, Readiness::MayRequireEviction);
        assert_eq!(
            r.displacement, None,
            "UnknownVictim would imply victims that do not exist"
        );
        assert!(r.would_displace.is_empty());
        // Nothing is asserted about resident models in the statements either.
        let said = serde_json::to_string(&r.statements).unwrap();
        assert!(!said.contains("resident."), "got: {said}");
    }

    /// The whole point of the change: an estimate that clears headroom by a
    /// wide margin is not reported as eviction, and one that misses it by a
    /// wide margin still is. The estimate may support the pessimistic
    /// direction — the spec forbids only the optimistic one.
    #[test]
    fn an_uncalibrated_estimate_may_still_say_it_does_not_fit() {
        let resident = loaded("coder:14b", 10 * GB, 10 * GB);
        let mut target = blank("reasoner:70b");
        target.installed_size_bytes = Some(40 * GB);
        let states = [&resident, &target];
        let r = assess_one(
            &inputs(&states, &[], Some(Headroom { free_bytes: 2 * GB, source: "nvml" })),
            "reasoner:70b",
        )
        .unwrap();
        assert_eq!(r.readiness, Readiness::MayRequireEviction);
        assert_eq!(r.displacement, Some(Displacement::Likely));
        assert_eq!(r.would_displace.len(), 1);
    }

    #[test]
    fn one_clearout_is_an_event_and_not_a_pattern() {
        let mut log = two_clearouts();
        log.truncate(3); // just the first occurrence
        assert_eq!(clearouts(&log).len(), 1);

        let coder = loaded("coder:14b", 10 * GB, 10 * GB);
        let classifier = loaded("classifier:3b", 2 * GB, 2 * GB);
        let mut target = blank("reasoner:14b");
        target.installed_size_bytes = Some(20 * GB);
        let r = assess_one(
            &inputs(
                &[&coder, &classifier, &target],
                &log,
                Some(Headroom { free_bytes: GB, source: "nvml" }),
            ),
            "reasoner:14b",
        )
        .unwrap();
        assert_eq!(r.displacement, Some(Displacement::UnknownVictim));
    }

    #[test]
    fn a_single_unload_beside_a_load_is_not_a_clearout() {
        // One model going as another arrives is an ordinary swap. Reading it as
        // a clear-out would manufacture the all-resident pattern on any host
        // that simply alternates between two models.
        let log = vec![
            tr(1, T0, "a", TransitionKind::Unloaded, &[]),
            tr(2, T0, "b", TransitionKind::Loaded, &[]),
        ];
        assert!(clearouts(&log).is_empty());
    }

    // ── In use, and headroom ────────────────────────────────────────────────

    #[test]
    fn in_use_is_unknown_without_an_activity_signal() {
        let log = vec![tr(1, T0, "coder:14b", TransitionKind::Loaded, &[])];
        let head = Some(Headroom { free_bytes: GB, source: "t" });

        let mut recent = loaded("coder:14b", GB, GB);
        recent.last_activity_ms = Some(T0 + 119_000); // 1 s ago
        let states = [&recent];
        assert_eq!(
            assess_one(&inputs(&states, &log, head), "coder:14b").unwrap().in_use,
            Some(true)
        );

        // No signal on this runtime: unknown, not false. "We looked and saw
        // nothing" and "we have no way to look" are different answers.
        let mut blind = inputs(&states, &log, head);
        blind.activity_signal = false;
        assert_eq!(assess_one(&blind, "coder:14b").unwrap().in_use, None);

        let mut stale = loaded("coder:14b", GB, GB);
        stale.last_activity_ms = Some(T0); // 120 s ago, outside the window
        let stale_states = [&stale];
        assert_eq!(
            assess_one(&inputs(&stale_states, &log, head), "coder:14b").unwrap().in_use,
            Some(false)
        );
    }

    #[test]
    fn headroom_prefers_the_directly_measured_source() {
        let nv = NvidiaMetrics {
            nvidia_vram_total_mb: Some(24_576),
            nvidia_vram_used_mb: Some(4_096),
            ..Default::default()
        };
        let resident = loaded("a", 8 * GB, 8 * GB);

        // NVML wins: it reports real free memory, other processes included.
        let h = headroom(&apple(65_536), &nv, &[&resident]).unwrap();
        assert_eq!(h.source, "nvml");
        assert_eq!(h.free_bytes, 20_480 * 1024 * 1024);

        // Apple: the unified-memory budget less what the runtime holds.
        let h = headroom(&apple(16_384), &NvidiaMetrics::default(), &[&resident]).unwrap();
        assert_eq!(h.source, "apple_wired_limit");
        assert_eq!(h.free_bytes, 16_384 * 1024 * 1024 - 8 * GB);

        // Neither: every answer becomes CannotDetermine.
        assert!(
            headroom(
                &AppleSiliconMetrics::default(),
                &NvidiaMetrics::default(),
                &[&resident]
            )
            .is_none()
        );
    }

    #[test]
    fn assess_covers_every_model_the_tracker_knows() {
        let coder = loaded("coder:14b", 4 * GB, 4 * GB);
        let unknown = blank("embed:small");
        let log = vec![tr(1, T0, "coder:14b", TransitionKind::Loaded, &[])];
        let all = assess(&inputs(
            &[&coder, &unknown],
            &log,
            Some(Headroom { free_bytes: 8 * GB, source: "nvml" }),
        ));
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].readiness, Readiness::ReadyNow);
        assert_eq!(all[1].readiness, Readiness::CannotDetermine);
        assert!(assess_one(&inputs(&[&coder], &log, None), "never-heard-of").is_none());
    }
}
