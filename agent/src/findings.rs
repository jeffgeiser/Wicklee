//! Evidence labels, and the statements built on them.
//!
//! Step 3 needed only the statement machinery, because every readiness answer
//! carries statements. Step 4 adds [`Finding`], the four diagnostic rules and
//! [`evaluate`], which is a pure function of the transition log and current
//! state — so every rule is reachable from a test with no runtime at all.
//!
//! The spec's evidence rules are enforced by construction rather than by
//! review: a [`Statement`] can only be made through a constructor, and each
//! constructor rejects a basis that does not meet its label's requirement. The
//! point is that a future rule cannot accidentally assert something it has no
//! grounds for — it gets a compile-time-shaped `Result` instead.
//!
//! Two labels, not three. `Verified` requires exact receipts from a fingerprint
//! or verify run, and nothing can produce one until step 5, so the variant
//! arrives with them. The same goes for the `Sample`, `Receipt` and `VerifyRun`
//! evidence references: a label or reference nothing can construct invites a
//! reader to assume a capability exists.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::residency::{Cause, ModelState, Residency, Transition, TransitionKind};

/// What kind of claim a statement is making.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Evidence {
    /// Wicklee saw it. States the fact, with counts and times, and never a
    /// cause.
    Observed,
    /// A likely cause or effect, built on something observed. Always hedged.
    Inferred,
}

/// A pointer to the evidence behind a statement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum EvidenceRef {
    /// A transition in the residency log.
    ///
    /// The id is unique within one agent process and restarts at 1, so it is a
    /// pointer for a reader rather than a durable key. The durable identity of
    /// a transition is (node_id, ts_ms, model, kind); the findings table cites
    /// the content-derived finding id instead, which does survive a restart.
    Transition { id: u64, ts_ms: i64 },
    /// A hardware pattern that fired over a window of stored samples.
    ///
    /// The pattern engine in `observations.rs` does not expose the samples it
    /// read or how many there were, so this reference carries what it does:
    /// which pattern, when it first fired, and the sustained fraction it
    /// measured. A reader who wants the underlying samples goes to
    /// `/api/observations`.
    ///
    /// The fraction is a whole percent rather than the engine's f64, because
    /// this enum is `Eq` and a float is not.
    ///
    /// Gated with its constructor and the adapter: the pattern engine is
    /// store-backed, so on musl nothing can produce one of these, and a
    /// variant nothing can construct invites a reader to assume a capability
    /// exists — the same reason `Verified` is not here yet.
    #[cfg(not(target_env = "musl"))]
    Pattern {
        pattern: &'static str,
        first_fired_ms: i64,
        confidence_pct: u8,
    },
}

/// Why a statement could not be built.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum EvidenceError {
    /// An observed statement with nothing behind it.
    NoBasis,
    /// An inferred statement with no observed statement under it.
    NoObservedSupport,
    /// An inferred statement that asserts rather than hedges.
    NotHedged,
    /// A statement naming a model that none of its evidence mentions.
    UnnamedModel(String),
}

impl std::fmt::Display for EvidenceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoBasis => write!(f, "an observed statement needs at least one piece of evidence"),
            Self::NoObservedSupport => {
                write!(f, "an inferred statement must build on an observed one")
            }
            Self::NotHedged => {
                write!(f, "an inferred statement must say \"may\" or \"likely\"")
            }
            Self::UnnamedModel(m) => {
                write!(f, "no evidence in the basis names {m}")
            }
        }
    }
}

/// One labelled claim with its evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Statement {
    pub(crate) label: Evidence,
    pub(crate) text: String,
    /// Never empty for an observed statement.
    pub(crate) basis: Vec<EvidenceRef>,
    /// The models this statement's own evidence names. Serialised so a reader
    /// can check a claim against its subjects without resolving the basis.
    pub(crate) subjects: Vec<String>,
}

impl Statement {
    /// Something Wicklee saw.
    ///
    /// Rejected without at least one transition behind it. The subjects are
    /// taken from the evidence, not from the caller, so they cannot drift from
    /// what the basis actually names.
    pub(crate) fn observed(
        text: impl Into<String>,
        basis: &[&Transition],
    ) -> Result<Self, EvidenceError> {
        if basis.is_empty() {
            return Err(EvidenceError::NoBasis);
        }
        let mut subjects: Vec<String> = Vec::new();
        for t in basis {
            for name in std::iter::once(&t.model).chain(t.co_resident.iter()) {
                if !subjects.iter().any(|s| s == name) {
                    subjects.push(name.clone());
                }
            }
        }
        Ok(Self {
            label: Evidence::Observed,
            text: text.into(),
            basis: basis
                .iter()
                .map(|t| EvidenceRef::Transition { id: t.id, ts_ms: t.ts_ms })
                .collect(),
            subjects,
        })
    }

    /// Something Wicklee saw, about specific models.
    ///
    /// The spec's fifth evidence rule: a statement names a model as affected
    /// only when evidence in its basis names that model. This is where that is
    /// enforced, for the statements that name a displacement victim.
    pub(crate) fn observed_naming(
        text: impl Into<String>,
        basis: &[&Transition],
        models: &[String],
    ) -> Result<Self, EvidenceError> {
        let s = Self::observed(text, basis)?;
        for m in models {
            if !s.subjects.iter().any(|known| known == m) {
                return Err(EvidenceError::UnnamedModel(m.clone()));
            }
        }
        Ok(s)
    }

    /// Something the hardware pattern engine measured.
    ///
    /// The second kind of observed evidence. A pattern that fired *is* the
    /// observation, so the requirement is only that it names itself — an empty
    /// pattern id would make the basis unresolvable.
    ///
    /// No subjects: these patterns are about the host, not a model. Some name
    /// a model in their prose, but none carries it in a structured field, and
    /// the fifth evidence rule means a statement may not name a model its
    /// evidence does not.
    ///
    /// Gated with [`EvidenceRef::Pattern`], which it is the only producer of.
    #[cfg(not(target_env = "musl"))]
    pub(crate) fn observed_pattern(
        text: impl Into<String>,
        pattern: &'static str,
        first_fired_ms: i64,
        confidence_ratio: f64,
    ) -> Result<Self, EvidenceError> {
        if pattern.is_empty() {
            return Err(EvidenceError::NoBasis);
        }
        let confidence_pct = (confidence_ratio.clamp(0.0, 1.0) * 100.0).round() as u8;
        Ok(Self {
            label: Evidence::Observed,
            text: text.into(),
            basis: vec![EvidenceRef::Pattern { pattern, first_fired_ms, confidence_pct }],
            subjects: Vec::new(),
        })
    }

    /// A likely cause or effect.
    ///
    /// Rejected unless at least one of `supports` is observed, and unless the
    /// wording hedges. An inferred statement inherits its supports' evidence,
    /// so a reader following the basis of a prediction arrives at the facts it
    /// was built from.
    pub(crate) fn inferred(
        text: impl Into<String>,
        supports: &[&Statement],
    ) -> Result<Self, EvidenceError> {
        if !supports.iter().any(|s| s.label == Evidence::Observed) {
            return Err(EvidenceError::NoObservedSupport);
        }
        let text = text.into();
        if !is_hedged(&text) {
            return Err(EvidenceError::NotHedged);
        }
        let mut basis: Vec<EvidenceRef> = Vec::new();
        let mut subjects: Vec<String> = Vec::new();
        for s in supports {
            for r in &s.basis {
                if !basis.contains(r) {
                    basis.push(*r);
                }
            }
            for m in &s.subjects {
                if !subjects.iter().any(|known| known == m) {
                    subjects.push(m.clone());
                }
            }
        }
        Ok(Self { label: Evidence::Inferred, text, basis, subjects })
    }
}

/// Whether an inferred statement hedges, as the evidence rules require.
///
/// Word-boundary matching, so "likelihood" does not pass for "likely" and a
/// model named `maybe:7b` does not make a sentence hedged by accident.
fn is_hedged(text: &str) -> bool {
    const HEDGES: [&str; 2] = ["may", "likely"];
    let lower = text.to_ascii_lowercase();
    lower
        .split(|c: char| !c.is_ascii_alphabetic())
        .any(|word| HEDGES.contains(&word))
}

/// Push a statement, or report why it could not be made and carry on.
///
/// A constructor rejection is a bug in the rule that called it, not a runtime
/// condition. Losing one sentence from an answer is better than panicking
/// inside a request handler, and the log line names the rule that did it.
pub(crate) fn push_statement(
    into: &mut Vec<Statement>,
    rule: &str,
    made: Result<Statement, EvidenceError>,
) {
    match made {
        Ok(s) => into.push(s),
        Err(e) => eprintln!("[evidence] {rule}: dropped a statement — {e}"),
    }
}

// ── Findings ──────────────────────────────────────────────────────────────────

/// Ollama's default context, which a request that omits `num_ctx` falls back to
/// and reloads the model at (step 0, V3).
pub(crate) const RUNTIME_DEFAULT_CONTEXT: u64 = 4096;

/// How long a split must persist before `cpu_split` fires. The spec says three
/// consecutive polls; the harvester polls every 5 s, and the tracker records
/// the crossing rather than every poll, so this is that interval expressed as
/// elapsed time since the crossing.
const SPLIT_SETTLE_MS: i64 = 15_000;

/// Resets `context_reset` needs before it is a pattern rather than an event.
const CONTEXT_RESET_MIN: usize = 2;

/// An unload this close to another model's load is read as driven by it.
const CHURN_PAIR_WINDOW_MS: i64 = 10_000;
/// How far back `eviction_churn` looks.
const CHURN_WINDOW_MS: i64 = 3_600_000;
/// Distinct models `eviction_churn` needs. One model cycling is not churn.
const CHURN_MIN_MODELS: usize = 2;

/// A reload this soon after an expiry unload counts toward `expiry_reload`.
const RELOAD_WINDOW_MS: i64 = 600_000;
/// Reload pairs `expiry_reload` needs within a day.
const RELOAD_MIN: usize = 3;
const DAY_MS: i64 = 86_400_000;

/// One diagnostic result.
///
/// Built only through [`Finding::new`], which enforces the spec's second
/// evidence rule: a finding with no observed statement is not a finding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Finding {
    pub(crate) id: String,
    pub(crate) rule: &'static str,
    pub(crate) title: String,
    pub(crate) severity: &'static str,
    /// The models this finding is about, from its statements' subjects.
    pub(crate) models: Vec<String>,
    pub(crate) statements: Vec<Statement>,
    pub(crate) first_seen_ms: i64,
    pub(crate) last_seen_ms: i64,
}

impl Finding {
    /// A finding, or `None` when nothing in it was observed.
    ///
    /// The models are taken from the statements rather than the caller, for the
    /// same reason [`Statement::observed`] takes its subjects from the basis:
    /// a finding cannot name a model its own evidence does not.
    pub(crate) fn new(
        rule: &'static str,
        severity: &'static str,
        title: impl Into<String>,
        statements: Vec<Statement>,
        first_seen_ms: i64,
        last_seen_ms: i64,
    ) -> Option<Self> {
        if !statements.iter().any(|s| s.label == Evidence::Observed) {
            return None;
        }
        let mut models: Vec<String> = Vec::new();
        for s in &statements {
            for m in &s.subjects {
                if !models.iter().any(|known| known == m) {
                    models.push(m.clone());
                }
            }
        }
        Some(Self {
            id: finding_id(rule, &models),
            rule,
            severity,
            title: title.into(),
            models,
            statements,
            first_seen_ms,
            last_seen_ms,
        })
    }
}

/// A stable id for a finding, derived from what it is about.
///
/// Content-derived rather than a counter, because `verify` in step 6 compares
/// two runs by id and a sequence number would renumber on every restart. The
/// same condition on the same models keeps its id across restarts and across
/// processes. FNV-1a, which needs no dependency and no collision resistance:
/// this is a readable handle for `wicklee verify F-xxxxxx`, not a digest.
fn finding_id(rule: &str, models: &[String]) -> String {
    let mut sorted: Vec<&str> = models.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for part in std::iter::once(rule).chain(sorted) {
        // The separator keeps ("ab","c") from hashing as ("a","bc").
        for b in part.as_bytes().iter().chain(std::iter::once(&0x1f_u8)) {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    }
    format!("F-{:06x}", h & 0xff_ffff)
}

/// A lookback window like `24h`, `90m` or `7d`, in milliseconds.
///
/// Parsed once, here, rather than in both the route and the CLI: the CLI passes
/// the string through and the route answers 400 on a bad one, so there is no
/// second implementation to disagree with this.
pub(crate) fn parse_lookback_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let (digits, unit) = s.split_at(s.find(|c: char| !c.is_ascii_digit())?);
    let n: i64 = digits.parse().ok()?;
    if n <= 0 {
        return None;
    }
    let mult = match unit {
        "s" => 1_000,
        "m" => 60_000,
        "h" => 3_600_000,
        "d" => 86_400_000,
        _ => return None,
    };
    n.checked_mul(mult)
}

/// A rule that did not run, and why.
///
/// The spec's sixth evidence rule applied to whole rules: when evidence is
/// missing the output says what was not checked rather than reporting a clean
/// bill of health it has not earned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct NotChecked {
    pub(crate) rule: &'static str,
    pub(crate) reason: String,
}

/// Everything `inspect` found, and everything it could not look at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Inspection {
    pub(crate) findings: Vec<Finding>,
    pub(crate) not_checked: Vec<NotChecked>,
}

/// What the rules read. Pure: no store, no clock, no runtime.
pub(crate) struct RuleInputs<'a> {
    /// Current per-model state, loaded or not.
    pub(crate) states: &'a [&'a ModelState],
    /// The transition log, oldest first.
    pub(crate) transitions: &'a [Transition],
    /// Whether this runtime reports `context_length` on `/api/ps`. Without it
    /// `context_reset` cannot run and says so.
    pub(crate) ps_context_length: bool,
    /// Whether this runtime reports `expires_at`. Without it `expiry_reload`
    /// cannot tell an expiry from an eviction.
    pub(crate) ps_expires_at: bool,
    pub(crate) now_ms: i64,
}

/// Run every rule.
///
/// Transitions Wicklee caused itself are excluded here, once, rather than in
/// each rule — the spec requires it of every count, and a rule that forgot
/// would be a silent bug.
///
/// Both of Wicklee's own causes, not just the probe. A fingerprint run loads
/// models, unloads them for a cold test and loads them again to restore what
/// was there; counted as real, one consented run would manufacture an
/// `eviction_churn` finding out of the measurement taken to check for one.
pub(crate) fn evaluate(inputs: &RuleInputs) -> Inspection {
    let real: Vec<&Transition> = inputs
        .transitions
        .iter()
        .filter(|t| !matches!(t.cause, Cause::Probe | Cause::Fingerprint))
        .collect();

    let mut findings = Vec::new();
    let mut not_checked = Vec::new();

    findings.extend(cpu_split(inputs, &real));

    if inputs.ps_context_length {
        findings.extend(context_reset(inputs, &real));
    } else {
        not_checked.push(NotChecked {
            rule: "context_reset",
            reason: "this runtime does not report context_length on /api/ps".into(),
        });
    }

    findings.extend(eviction_churn(inputs, &real));

    if inputs.ps_expires_at {
        findings.extend(expiry_reload(inputs, &real));
    } else {
        not_checked.push(NotChecked {
            rule: "expiry_reload",
            reason: "this runtime does not report expires_at on /api/ps".into(),
        });
    }

    // Step 6 builds verify runs and the baseline they compare against. Until
    // then the rule has no input, and saying so is the honest answer.
    not_checked.push(NotChecked {
        rule: "baseline_regression",
        reason: "no fingerprint baseline yet".into(),
    });

    Inspection { findings, not_checked }
}

/// Part of a loaded model's footprint is outside accelerator memory.
///
/// The hard test: the runtime's own status command shows the split. It does not
/// show when the split began or the context the model was loaded at.
fn cpu_split(inputs: &RuleInputs, real: &[&Transition]) -> Vec<Finding> {
    let mut out = Vec::new();
    for state in inputs.states {
        if state.residency != Residency::Loaded {
            continue;
        }
        let (Some(outside), Some(pct)) =
            (state.outside_accelerator_bytes(), state.outside_accelerator_percent())
        else {
            continue;
        };
        if outside == 0 {
            continue;
        }
        // The crossing into the current split. Without one in the log there is
        // no observed "since when", and an observed statement needs a basis —
        // so the rule stays quiet rather than asserting a start time it never
        // saw.
        let Some(crossing) = real
            .iter()
            .rev()
            .find(|t| {
                t.model == state.model
                    && t.kind == TransitionKind::PlacementChanged
                    && t.after
                        .as_deref()
                        .and_then(ModelState::outside_accelerator_bytes)
                        .is_some_and(|b| b > 0)
            })
            .copied()
        else {
            continue;
        };
        if inputs.now_ms - crossing.ts_ms < SPLIT_SETTLE_MS {
            continue;
        }

        let ctx = state
            .context_length
            .map_or_else(|| "an unreported".to_string(), |c| format!("a {c}-token"));
        let mut statements = Vec::new();
        push_statement(
            &mut statements,
            "cpu_split",
            Statement::observed(
                format!(
                    "{} has had {pct}% of its runtime footprint ({}) outside \
                     accelerator memory for {}, running at {ctx} context.",
                    state.model,
                    bytes_human(outside),
                    duration_human(inputs.now_ms - crossing.ts_ms),
                ),
                &[crossing],
            ),
        );
        // The context it was loaded at, from the log. A growth before the
        // crossing is the KV-cache explanation the spec asks for; without one
        // the rule still reports the split but claims no cause for it.
        let grew = real.iter().rev().find(|t| {
            t.model == state.model
                && t.kind == TransitionKind::ContextChanged
                && t.ts_ms <= crossing.ts_ms
                && match (
                    t.before.as_deref().and_then(|s| s.context_length),
                    t.after.as_deref().and_then(|s| s.context_length),
                ) {
                    (Some(b), Some(a)) => a > b,
                    _ => false,
                }
        });
        if let (Some(growth), Some(observed)) = (grew, statements.first().cloned()) {
            let before = growth.before.as_deref().and_then(|s| s.context_length);
            let after = growth.after.as_deref().and_then(|s| s.context_length);
            if let (Some(b), Some(a)) = (before, after) {
                push_statement(
                    &mut statements,
                    "cpu_split",
                    Statement::inferred(
                        format!(
                            "Its context grew from {b} to {a} tokens {} before the split, \
                             so KV cache rather than weights is the likely cause.",
                            duration_human(crossing.ts_ms - growth.ts_ms),
                        ),
                        &[&observed],
                    ),
                );
            }
        } else if let Some(observed) = statements.first().cloned() {
            push_statement(
                &mut statements,
                "cpu_split",
                Statement::inferred(
                    "KV cache grows with the running context, so it is the likely \
                     part of the footprint that did not fit."
                        .to_string(),
                    &[&observed],
                ),
            );
        }

        out.extend(Finding::new(
            "cpu_split",
            "warning",
            format!("{} is partly outside accelerator memory", state.model),
            statements,
            crossing.ts_ms,
            inputs.now_ms,
        ));
    }
    out
}

/// A resident model keeps being reloaded at the runtime default context.
///
/// The strongest rule in the set: nothing in the runtime reports this. The
/// reload looks like any other load, the context silently differs afterwards,
/// and the cost shows up only as unexplained latency.
///
/// The signature is a context drop to the default together with a reload at the
/// same poll. A reload takes a couple of seconds and `/api/ps` is polled every
/// five, so the tracker often never sees the model absent — it sees the same
/// name with a lower context and a reset keep-alive. Both shapes count: a
/// `Loaded` at that timestamp, or an `ExpiryReset`, which is the reload's
/// fingerprint when the unload fell between polls.
fn context_reset(inputs: &RuleInputs, real: &[&Transition]) -> Vec<Finding> {
    let mut by_model: BTreeMap<&str, Vec<&Transition>> = BTreeMap::new();
    for t in real {
        if t.kind != TransitionKind::ContextChanged {
            continue;
        }
        let (Some(before), Some(after)) = (
            t.before.as_deref().and_then(|s| s.context_length),
            t.after.as_deref().and_then(|s| s.context_length),
        ) else {
            continue;
        };
        if after != RUNTIME_DEFAULT_CONTEXT || before <= after {
            continue;
        }
        let reloaded = real.iter().any(|o| {
            o.ts_ms == t.ts_ms
                && o.model == t.model
                && matches!(o.kind, TransitionKind::Loaded | TransitionKind::ExpiryReset)
        });
        if reloaded {
            by_model.entry(t.model.as_str()).or_default().push(t);
        }
    }

    let mut out = Vec::new();
    for (model, resets) in by_model {
        if resets.len() < CONTEXT_RESET_MIN {
            continue;
        }
        let highest = resets
            .iter()
            .filter_map(|t| t.before.as_deref().and_then(|s| s.context_length))
            .max()
            .unwrap_or(RUNTIME_DEFAULT_CONTEXT);
        let first = resets.first().expect("non-empty").ts_ms;
        let last = resets.last().expect("non-empty").ts_ms;

        let mut statements = Vec::new();
        push_statement(
            &mut statements,
            "context_reset",
            Statement::observed(
                format!(
                    "{model} was reloaded at the default {RUNTIME_DEFAULT_CONTEXT}-token \
                     context {} times in the last {}, dropping from as high as {highest} \
                     tokens. The load cost of each reload is not measured.",
                    resets.len(),
                    duration_human(inputs.now_ms - first),
                ),
                &resets,
            ),
        );
        if let Some(observed) = statements.first().cloned() {
            push_statement(
                &mut statements,
                "context_reset",
                Statement::inferred(
                    format!(
                        "A caller is likely omitting num_ctx, so each such request \
                         silently reloads {model} at the default instead of reusing \
                         the resident copy."
                    ),
                    &[&observed],
                ),
            );
        }
        out.extend(Finding::new(
            "context_reset",
            "warning",
            format!("{model} is being reloaded at the default context"),
            statements,
            first,
            last,
        ));
    }
    out
}

/// Models are being cleared and reloaded under memory contention.
///
/// V4: a load that does not fit clears *every* resident model rather than
/// swapping a pair, so the rule counts unloads driven by another model's load
/// and does not try to pair a victim with a culprit.
fn eviction_churn(inputs: &RuleInputs, real: &[&Transition]) -> Vec<Finding> {
    let cutoff = inputs.now_ms - CHURN_WINDOW_MS;
    let loads: Vec<&&Transition> = real
        .iter()
        .filter(|t| t.kind == TransitionKind::Loaded && t.ts_ms >= cutoff)
        .collect();

    // An unload before its own expiry, close in time to some other model's
    // load. `Cause::ExpiryReached` is excluded because that is the keep-alive
    // doing its job, which is `expiry_reload`'s business, not churn.
    let driven: Vec<&Transition> = real
        .iter()
        .filter(|t| {
            t.kind == TransitionKind::Unloaded
                && t.ts_ms >= cutoff
                && t.cause != Cause::ExpiryReached
                && loads.iter().any(|l| {
                    l.model != t.model && (l.ts_ms - t.ts_ms).abs() <= CHURN_PAIR_WINDOW_MS
                })
        })
        .copied()
        .collect();

    let mut models: Vec<&str> = driven.iter().map(|t| t.model.as_str()).collect();
    models.sort_unstable();
    models.dedup();
    if models.len() < CHURN_MIN_MODELS {
        return Vec::new();
    }

    let first = driven.first().expect("non-empty").ts_ms;
    let last = driven.last().expect("non-empty").ts_ms;
    let mut statements = Vec::new();
    push_statement(
        &mut statements,
        "eviction_churn",
        Statement::observed(
            format!(
                "{} models were cleared {} times in the last {} within {} seconds of \
                 another model loading, each before its own keep-alive expired: {}.",
                models.len(),
                driven.len(),
                duration_human(inputs.now_ms - first),
                CHURN_PAIR_WINDOW_MS / 1_000,
                models.join(", "),
            ),
            &driven,
        ),
    );
    if let Some(observed) = statements.first().cloned() {
        push_statement(
            &mut statements,
            "eviction_churn",
            Statement::inferred(
                "Memory contention may be causing the reloads: a load that does not \
                 fit clears resident models rather than queueing."
                    .to_string(),
                &[&observed],
            ),
        );
    }
    Finding::new(
        "eviction_churn",
        "warning",
        "Models are being cleared to make room".to_string(),
        statements,
        first,
        last,
    )
    .into_iter()
    .collect()
}

/// A model keeps expiring and being loaded again shortly afterwards.
///
/// The keep-alive is shorter than the pause between whatever steps are using
/// the model, so every step pays a cold load.
fn expiry_reload(inputs: &RuleInputs, real: &[&Transition]) -> Vec<Finding> {
    let cutoff = inputs.now_ms - DAY_MS;
    let mut by_model: BTreeMap<&str, Vec<(&Transition, i64)>> = BTreeMap::new();
    for (i, t) in real.iter().enumerate() {
        if t.kind != TransitionKind::Unloaded
            || t.cause != Cause::ExpiryReached
            || t.ts_ms < cutoff
        {
            continue;
        }
        // The next load of the same model, if it came back soon enough.
        let back = real[i + 1..]
            .iter()
            .find(|o| o.model == t.model && o.kind == TransitionKind::Loaded)
            .filter(|o| o.ts_ms - t.ts_ms <= RELOAD_WINDOW_MS);
        if let Some(load) = back {
            by_model
                .entry(t.model.as_str())
                .or_default()
                .push((*t, load.ts_ms - t.ts_ms));
        }
    }

    let mut out = Vec::new();
    for (model, pairs) in by_model {
        if pairs.len() < RELOAD_MIN {
            continue;
        }
        let gaps: Vec<i64> = pairs.iter().map(|(_, g)| *g).collect();
        let shortest = gaps.iter().copied().min().unwrap_or(0);
        let longest = gaps.iter().copied().max().unwrap_or(0);
        let basis: Vec<&Transition> = pairs.iter().map(|(t, _)| *t).collect();
        let first = basis.first().expect("non-empty").ts_ms;
        let last = basis.last().expect("non-empty").ts_ms;
        let mut statements = Vec::new();
        push_statement(
            &mut statements,
            "expiry_reload",
            Statement::observed(
                format!(
                    "{model} expired and was loaded again within {} minutes on {} \
                     occasions in the last day — gaps from {} to {}. Neither the \
                     keep-alive duration nor the cold-load cost is reported by \
                     /api/ps, so neither is claimed here.",
                    RELOAD_WINDOW_MS / 60_000,
                    pairs.len(),
                    duration_human(shortest),
                    duration_human(longest),
                ),
                &basis,
            ),
        );
        if let Some(observed) = statements.first().cloned() {
            push_statement(
                &mut statements,
                "expiry_reload",
                Statement::inferred(
                    "The keep-alive may be shorter than the pause between the steps \
                     using this model, so each step may be paying a cold load."
                        .to_string(),
                    &[&observed],
                ),
            );
        }
        out.extend(Finding::new(
            "expiry_reload",
            "info",
            format!("{model} is reloading after every keep-alive expiry"),
            statements,
            first,
            last,
        ));
    }
    out
}

/// The hardware patterns from `observations.rs`, as findings.
///
/// Phase 1 writes no new hardware rules; the nineteen that exist appear in
/// `inspect` through this adapter so one report covers the whole host.
///
/// **What does not survive the mapping, and why.** Those patterns were written
/// for a card with a `hook`, a `body` and a `recommendation`, not for the
/// evidence rules. Their `hook` is purely measured — "5.2 MB/s swap · 12.3
/// tok/s" — so it becomes the observed statement. Their `body` mixes the
/// measurement with a general mechanism ("swap pressure forces the OS to page
/// model weights to disk"), which is a cause, and the third evidence rule says
/// a cause is never labelled observed. So the body is offered as an inferred
/// statement and kept only if it hedges, which most of this copy does not.
///
/// The alternative was rewording nineteen shipped patterns' prose to separate
/// measurement from mechanism. That is worth doing and it is not step 4: the
/// cloud consumes these same fields. Until then the full card stays available
/// at `/api/observations`, and `inspect` carries the title and the measurement
/// rather than a sentence it cannot label honestly.
#[cfg(not(target_env = "musl"))]
pub(crate) fn from_observations(
    obs: &[crate::observations::LocalObservation],
) -> Vec<Finding> {
    let mut out = Vec::new();
    for o in obs {
        let mut statements = Vec::new();
        push_statement(
            &mut statements,
            o.pattern_id,
            Statement::observed_pattern(
                o.hook.clone(),
                o.pattern_id,
                o.first_fired_ms,
                o.confidence_ratio,
            ),
        );
        // Kept only if it hedges. A dropped one is logged by push_statement,
        // which is how the prose that needs rewording makes itself known.
        if let Some(observed) = statements.first().cloned() {
            push_statement(
                &mut statements,
                o.pattern_id,
                Statement::inferred(o.body.clone(), &[&observed]),
            );
        }
        out.extend(Finding::new(
            o.pattern_id,
            o.severity,
            o.title.clone(),
            statements,
            o.first_fired_ms,
            o.first_fired_ms,
        ));
    }
    out
}

/// An elapsed time, for a sentence a person reads.
///
/// Relative rather than wall-clock: the agent has no date library and the spec
/// forbids new dependencies, and a relative figure cannot be misread across a
/// timezone. The JSON carries `first_seen_ms` for a caller that wants to format
/// a real time.
fn duration_human(ms: i64) -> String {
    let s = ms.max(0) / 1_000;
    match s {
        0..=90 => format!("{s} seconds"),
        91..=5_400 => format!("{} minutes", (s + 30) / 60),
        _ => format!("{:.1} hours", s as f64 / 3_600.0),
    }
}

/// Bytes at the scale a person reads them at.
fn bytes_human(b: u64) -> String {
    const GIB: f64 = (1024 * 1024 * 1024) as f64;
    const MIB: f64 = (1024 * 1024) as f64;
    let f = b as f64;
    if f >= GIB {
        format!("{:.1} GiB", f / GIB)
    } else {
        format!("{:.0} MiB", f / MIB)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::residency::{Cause, TransitionKind};

    fn tr(id: u64, model: &str, co: &[&str]) -> Transition {
        Transition {
            id,
            ts_ms: 1_700_000_000_000 + id as i64,
            model: model.to_string(),
            kind: TransitionKind::Unloaded,
            cause: Cause::ExpiryReached,
            before: None,
            after: None,
            co_resident: co.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn an_observed_statement_needs_evidence() {
        assert_eq!(
            Statement::observed("coder:14b is resident.", &[]),
            Err(EvidenceError::NoBasis),
        );
        let t = tr(1, "coder:14b", &["classifier:3b"]);
        let s = Statement::observed("coder:14b is resident.", &[&t]).unwrap();
        assert_eq!(s.label, Evidence::Observed);
        assert_eq!(s.basis, vec![EvidenceRef::Transition { id: 1, ts_ms: t.ts_ms }]);
        // Subjects come from the evidence, not from the caller.
        assert_eq!(s.subjects, vec!["coder:14b".to_string(), "classifier:3b".to_string()]);
    }

    #[test]
    fn a_statement_cannot_name_a_model_its_evidence_does_not() {
        let t = tr(1, "coder:14b", &[]);
        assert_eq!(
            Statement::observed_naming("x", &[&t], &["reasoner:14b".to_string()]),
            Err(EvidenceError::UnnamedModel("reasoner:14b".into())),
        );
        assert!(
            Statement::observed_naming("x", &[&t], &["coder:14b".to_string()]).is_ok(),
            "the model the transition is about is nameable"
        );
    }

    #[test]
    fn an_inferred_statement_needs_an_observed_one_under_it() {
        let t = tr(1, "coder:14b", &[]);
        let obs = Statement::observed("coder:14b unloaded at its expiry.", &[&t]).unwrap();

        assert_eq!(
            Statement::inferred("The keep-alive may be too short.", &[]),
            Err(EvidenceError::NoObservedSupport),
        );
        // An inferred statement cannot stand on another inference alone.
        let inf = Statement::inferred("The keep-alive may be too short.", &[&obs]).unwrap();
        assert_eq!(
            Statement::inferred("Throughput may suffer.", &[&inf]),
            Err(EvidenceError::NoObservedSupport),
        );
        // It inherits the evidence of what it was built on.
        assert_eq!(inf.basis, obs.basis);
        assert_eq!(inf.subjects, obs.subjects);
    }

    #[test]
    fn an_inferred_statement_must_hedge() {
        let t = tr(1, "coder:14b", &[]);
        let obs = Statement::observed("coder:14b unloaded at its expiry.", &[&t]).unwrap();

        assert_eq!(
            Statement::inferred("The keep-alive is too short.", &[&obs]),
            Err(EvidenceError::NotHedged),
        );
        for hedged in [
            "The keep-alive may be too short.",
            "This likely caused the reload.",
            "Loading it will probably clear both, and may clear more.",
        ] {
            assert!(
                Statement::inferred(hedged, &[&obs]).is_ok(),
                "{hedged:?} hedges and must be accepted"
            );
        }
        // Word boundaries: a near-miss is not a hedge.
        for not_hedged in [
            "The likelihood is high.",
            "Mayhem followed.",
            "Model maybe:7b was cleared.",
        ] {
            assert_eq!(
                Statement::inferred(not_hedged, &[&obs]),
                Err(EvidenceError::NotHedged),
                "{not_hedged:?} does not hedge"
            );
        }
    }

    #[test]
    fn a_dropped_statement_is_reported_and_not_silently_lost() {
        let mut out = Vec::new();
        push_statement(&mut out, "test_rule", Statement::observed("x", &[]));
        assert!(out.is_empty(), "a rejected statement is not pushed");
        let t = tr(1, "a", &[]);
        push_statement(&mut out, "test_rule", Statement::observed("x", &[&t]));
        assert_eq!(out.len(), 1);
    }

    // ── Rule tests ───────────────────────────────────────────────────────────
    //
    // Every rule is a pure function of a synthetic log, so each one gets a case
    // that must fire and a case that must not. The negative cases are the point:
    // a rule that fires on a healthy host is worse than one that misses, because
    // the product's claim is that a finding means something.

    const T0: i64 = 1_700_000_000_000;
    const GIB: u64 = 1024 * 1024 * 1024;

    /// A model state with everything not named left unknown.
    fn state(model: &str, size: Option<u64>, vram: Option<u64>, ctx: Option<u64>) -> ModelState {
        ModelState {
            model: model.to_string(),
            digest: None,
            residency: Residency::Loaded,
            size_bytes: size,
            size_vram_bytes: vram,
            context_length: ctx,
            expires_at_ms: Some(T0 + 300_000),
            last_activity_ms: None,
            installed_size_bytes: None,
            measured: None,
            observed_at_ms: T0,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn trans(
        id: u64,
        ts_ms: i64,
        model: &str,
        kind: TransitionKind,
        cause: Cause,
        before: Option<ModelState>,
        after: Option<ModelState>,
    ) -> Transition {
        Transition {
            id,
            ts_ms,
            model: model.to_string(),
            kind,
            cause,
            before: before.map(Box::new),
            after: after.map(Box::new),
            co_resident: Vec::new(),
        }
    }

    fn inputs<'a>(
        states: &'a [&'a ModelState],
        transitions: &'a [Transition],
        now_ms: i64,
    ) -> RuleInputs<'a> {
        RuleInputs {
            states,
            transitions,
            ps_context_length: true,
            ps_expires_at: true,
            now_ms,
        }
    }

    fn rules_that_fired(i: &Inspection) -> Vec<&str> {
        let mut v: Vec<&str> = i.findings.iter().map(|f| f.rule).collect();
        v.sort_unstable();
        v
    }

    #[test]
    fn a_healthy_log_yields_no_findings() {
        let s = state("coder:14b", Some(8 * GIB), Some(8 * GIB), Some(8192));
        let states = [&s];
        let got = evaluate(&inputs(&states, &[], T0 + 60_000));
        assert!(got.findings.is_empty(), "nothing is wrong, so nothing is reported");
        // But it still says what it could not look at.
        assert!(
            got.not_checked.iter().any(|n| n.rule == "baseline_regression"),
            "a rule with no input is declared, not silently skipped"
        );
    }

    #[test]
    fn cpu_split_fires_on_a_settled_split_and_not_before() {
        let split = state("coder:14b", Some(10 * GIB), Some(6 * GIB), Some(32768));
        let crossing = trans(
            1,
            T0,
            "coder:14b",
            TransitionKind::PlacementChanged,
            Cause::Unknown,
            Some(state("coder:14b", Some(10 * GIB), Some(10 * GIB), Some(8192))),
            Some(split.clone()),
        );
        let states = [&split];
        let log = [crossing];

        // Settled: three polls have passed since the crossing.
        let fired = evaluate(&inputs(&states, &log, T0 + SPLIT_SETTLE_MS + 1));
        assert_eq!(rules_that_fired(&fired), ["cpu_split"]);
        let f = &fired.findings[0];
        assert_eq!(f.models, ["coder:14b"]);
        assert!(f.statements[0].text.contains("40%"), "{}", f.statements[0].text);
        assert!(
            f.statements[0].text.contains("32768-token"),
            "the running context is part of the observation: {}",
            f.statements[0].text
        );

        // Not yet settled: the same split one second after the crossing.
        let early = evaluate(&inputs(&states, &log, T0 + 1_000));
        assert!(early.findings.is_empty(), "a split must persist before it is a finding");
    }

    #[test]
    fn cpu_split_stays_quiet_when_the_footprint_is_entirely_resident() {
        let whole = state("coder:14b", Some(8 * GIB), Some(8 * GIB), Some(8192));
        let crossing = trans(
            1,
            T0,
            "coder:14b",
            TransitionKind::PlacementChanged,
            Cause::Unknown,
            None,
            Some(whole.clone()),
        );
        let states = [&whole];
        let log = [crossing];
        assert!(evaluate(&inputs(&states, &log, T0 + 60_000)).findings.is_empty());
    }

    #[test]
    fn cpu_split_will_not_claim_a_start_time_it_never_saw() {
        // Split now, but no crossing in the log — the agent started after it.
        let split = state("coder:14b", Some(10 * GIB), Some(6 * GIB), Some(32768));
        let states = [&split];
        assert!(
            evaluate(&inputs(&states, &[], T0 + 600_000)).findings.is_empty(),
            "no basis for \"since when\" means no observed statement, so no finding"
        );
    }

    /// A reload at the default context: the context drops to 4096 and the
    /// keep-alive resets in the same poll.
    fn reset_pair(id: u64, ts_ms: i64, model: &str, from: u64, cause: Cause) -> Vec<Transition> {
        let before = state(model, Some(10 * GIB), Some(10 * GIB), Some(from));
        let after = state(model, Some(6 * GIB), Some(6 * GIB), Some(RUNTIME_DEFAULT_CONTEXT));
        vec![
            trans(
                id,
                ts_ms,
                model,
                TransitionKind::ContextChanged,
                cause,
                Some(before.clone()),
                Some(after.clone()),
            ),
            trans(
                id + 1,
                ts_ms,
                model,
                TransitionKind::ExpiryReset,
                cause,
                Some(before),
                Some(after),
            ),
        ]
    }

    #[test]
    fn context_reset_fires_on_a_scripted_context_drop() {
        let mut log = reset_pair(1, T0, "coder:14b", 32768, Cause::User);
        log.extend(reset_pair(3, T0 + 60_000, "coder:14b", 32768, Cause::User));
        let got = evaluate(&inputs(&[], &log, T0 + 120_000));
        assert_eq!(rules_that_fired(&got), ["context_reset"]);
        let f = &got.findings[0];
        assert!(f.statements[0].text.contains("4096"), "{}", f.statements[0].text);
        assert!(f.statements[0].text.contains("32768"), "{}", f.statements[0].text);
        assert!(
            f.statements[0].text.contains("not measured"),
            "the load cost arrives with receipts in step 5 and is not guessed at now: {}",
            f.statements[0].text
        );
        assert_eq!(f.statements[1].label, Evidence::Inferred);
    }

    #[test]
    fn context_reset_ignores_probe_caused_transitions() {
        // The agent's own probe did exactly this before step 1 fixed it. The
        // exclusion stays so a regression in the probe cannot manufacture
        // findings about itself.
        let mut log = reset_pair(1, T0, "coder:14b", 32768, Cause::Probe);
        log.extend(reset_pair(3, T0 + 60_000, "coder:14b", 32768, Cause::Probe));
        assert!(
            evaluate(&inputs(&[], &log, T0 + 120_000)).findings.is_empty(),
            "the probe is not a caller"
        );
    }

    #[test]
    fn context_reset_needs_a_pattern_not_one_event() {
        let log = reset_pair(1, T0, "coder:14b", 32768, Cause::User);
        assert!(evaluate(&inputs(&[], &log, T0 + 60_000)).findings.is_empty());
    }

    #[test]
    fn context_reset_ignores_a_context_change_with_no_reload() {
        // A caller legitimately lowering the context without a reload is not
        // this finding: there is no ExpiryReset or Loaded at that timestamp.
        let before = state("coder:14b", Some(10 * GIB), Some(10 * GIB), Some(32768));
        let after = state("coder:14b", Some(6 * GIB), Some(6 * GIB), Some(RUNTIME_DEFAULT_CONTEXT));
        let log: Vec<Transition> = (0..3)
            .map(|i| {
                trans(
                    i + 1,
                    T0 + i as i64 * 60_000,
                    "coder:14b",
                    TransitionKind::ContextChanged,
                    Cause::User,
                    Some(before.clone()),
                    Some(after.clone()),
                )
            })
            .collect();
        assert!(evaluate(&inputs(&[], &log, T0 + 300_000)).findings.is_empty());
    }

    #[test]
    fn eviction_churn_needs_two_models_cleared_around_a_load() {
        let one = [
            trans(1, T0, "a:7b", TransitionKind::Unloaded, Cause::Unknown, None, None),
            trans(2, T0 + 2_000, "b:7b", TransitionKind::Loaded, Cause::User, None, None),
        ];
        assert!(
            evaluate(&inputs(&[], &one, T0 + 60_000)).findings.is_empty(),
            "one model cycling is not churn"
        );

        let two = [
            trans(1, T0, "a:7b", TransitionKind::Unloaded, Cause::Unknown, None, None),
            trans(2, T0 + 2_000, "b:7b", TransitionKind::Loaded, Cause::User, None, None),
            trans(3, T0 + 30_000, "c:7b", TransitionKind::Unloaded, Cause::Unknown, None, None),
            trans(4, T0 + 32_000, "b:7b", TransitionKind::Loaded, Cause::User, None, None),
        ];
        let got = evaluate(&inputs(&[], &two, T0 + 60_000));
        assert_eq!(rules_that_fired(&got), ["eviction_churn"]);
        let f = &got.findings[0];
        assert!(f.models.contains(&"a:7b".to_string()));
        assert!(f.models.contains(&"c:7b".to_string()));
    }

    #[test]
    fn eviction_churn_does_not_count_a_keep_alive_expiring() {
        // Expiry is the keep-alive doing its job. That is expiry_reload's
        // business, and counting it here would double-report one event.
        let log = [
            trans(1, T0, "a:7b", TransitionKind::Unloaded, Cause::ExpiryReached, None, None),
            trans(2, T0 + 2_000, "b:7b", TransitionKind::Loaded, Cause::User, None, None),
            trans(3, T0 + 30_000, "c:7b", TransitionKind::Unloaded, Cause::ExpiryReached, None, None),
            trans(4, T0 + 32_000, "b:7b", TransitionKind::Loaded, Cause::User, None, None),
        ];
        assert!(evaluate(&inputs(&[], &log, T0 + 60_000)).findings.is_empty());
    }

    #[test]
    fn eviction_churn_ignores_an_unload_far_from_any_load() {
        let log = [
            trans(1, T0, "a:7b", TransitionKind::Unloaded, Cause::Unknown, None, None),
            trans(2, T0 + 600_000, "b:7b", TransitionKind::Loaded, Cause::User, None, None),
            trans(3, T0 + 30_000, "c:7b", TransitionKind::Unloaded, Cause::Unknown, None, None),
        ];
        assert!(
            evaluate(&inputs(&[], &log, T0 + 700_000)).findings.is_empty(),
            "ten minutes apart is not one load displacing another"
        );
    }

    /// An expiry unload followed by a load `gap` later.
    fn expiry_cycle(id: u64, ts_ms: i64, model: &str, gap: i64) -> Vec<Transition> {
        vec![
            trans(id, ts_ms, model, TransitionKind::Unloaded, Cause::ExpiryReached, None, None),
            trans(id + 1, ts_ms + gap, model, TransitionKind::Loaded, Cause::User, None, None),
        ]
    }

    #[test]
    fn expiry_reload_fires_on_three_cycles_in_a_day() {
        let mut log = Vec::new();
        for i in 0..3 {
            log.extend(expiry_cycle(i * 2 + 1, T0 + i as i64 * 3_600_000, "coder:14b", 120_000));
        }
        let got = evaluate(&inputs(&[], &log, T0 + 4 * 3_600_000));
        assert_eq!(rules_that_fired(&got), ["expiry_reload"]);
        assert!(
            got.findings[0].statements[0].text.contains("nor the cold-load cost is reported"),
            "neither the keep-alive nor the load cost is reported, so neither is asserted: {}",
            got.findings[0].statements[0].text
        );
    }

    #[test]
    fn expiry_reload_needs_three_cycles() {
        let mut log = Vec::new();
        for i in 0..2 {
            log.extend(expiry_cycle(i * 2 + 1, T0 + i as i64 * 3_600_000, "coder:14b", 120_000));
        }
        assert!(evaluate(&inputs(&[], &log, T0 + 4 * 3_600_000)).findings.is_empty());
    }

    #[test]
    fn expiry_reload_ignores_a_model_that_came_back_much_later() {
        // Expired and reloaded half an hour later is a model used twice a day,
        // not a keep-alive set too short.
        let mut log = Vec::new();
        for i in 0..3 {
            log.extend(expiry_cycle(
                i * 2 + 1,
                T0 + i as i64 * 3_600_000,
                "coder:14b",
                RELOAD_WINDOW_MS + 60_000,
            ));
        }
        assert!(evaluate(&inputs(&[], &log, T0 + 4 * 3_600_000)).findings.is_empty());
    }

    #[test]
    fn a_rule_with_no_capability_is_declared_not_skipped() {
        let i = RuleInputs {
            states: &[],
            transitions: &[],
            ps_context_length: false,
            ps_expires_at: false,
            now_ms: T0,
        };
        let got = evaluate(&i);
        let mut names: Vec<&str> = got.not_checked.iter().map(|n| n.rule).collect();
        names.sort_unstable();
        assert_eq!(names, ["baseline_regression", "context_reset", "expiry_reload"]);
        for n in &got.not_checked {
            assert!(!n.reason.is_empty(), "{} must say why", n.rule);
        }
    }

    #[test]
    fn a_finding_needs_something_observed() {
        let t = tr(1, "coder:14b", &[]);
        let obs = Statement::observed("coder:14b unloaded.", &[&t]).unwrap();
        let inf = Statement::inferred("It may be contention.", &[&obs]).unwrap();

        assert!(
            Finding::new("r", "info", "t", vec![inf.clone()], T0, T0).is_none(),
            "an inference on its own is not a finding"
        );
        let f = Finding::new("r", "info", "t", vec![obs, inf], T0, T0).unwrap();
        assert_eq!(f.models, ["coder:14b"]);
    }

    #[test]
    fn a_finding_id_is_stable_for_the_same_condition_and_differs_otherwise() {
        let models = vec!["coder:14b".to_string(), "classifier:3b".to_string()];
        let reordered = vec!["classifier:3b".to_string(), "coder:14b".to_string()];
        // Stable across restarts and independent of iteration order, because
        // `verify` in step 6 compares two runs by id.
        assert_eq!(finding_id("cpu_split", &models), finding_id("cpu_split", &reordered));
        assert_ne!(finding_id("cpu_split", &models), finding_id("expiry_reload", &models));
        assert_ne!(finding_id("cpu_split", &models), finding_id("cpu_split", &models[..1]));
        assert!(finding_id("cpu_split", &models).starts_with("F-"));
        // The separator does its job: ("ab","c") and ("a","bc") are different.
        assert_ne!(
            finding_id("r", &["ab".to_string(), "c".to_string()]),
            finding_id("r", &["a".to_string(), "bc".to_string()]),
        );
    }

    #[test]
    fn a_lookback_window_is_read_or_refused_never_guessed() {
        assert_eq!(parse_lookback_ms("45s"), Some(45_000));
        assert_eq!(parse_lookback_ms("90m"), Some(5_400_000));
        assert_eq!(parse_lookback_ms("24h"), Some(86_400_000));
        assert_eq!(parse_lookback_ms(" 7d "), Some(604_800_000));
        // A bare number has no unit, and defaulting one would answer a
        // different question than the caller asked.
        for bad in ["", "24", "h", "24w", "-1h", "0h", "1.5h", "24 h", "abc"] {
            assert_eq!(parse_lookback_ms(bad), None, "{bad:?} must be refused");
        }
        // No silent wrap on an absurd window.
        assert_eq!(parse_lookback_ms("9999999999999999999d"), None);
    }

    #[test]
    fn durations_and_sizes_read_as_a_person_would_write_them() {
        assert_eq!(duration_human(-5), "0 seconds");
        assert_eq!(duration_human(45_000), "45 seconds");
        assert_eq!(duration_human(600_000), "10 minutes");
        assert_eq!(duration_human(7_200_000), "2.0 hours");
        assert_eq!(bytes_human(4 * GIB), "4.0 GiB");
        assert_eq!(bytes_human(512 * 1024 * 1024), "512 MiB");
    }

    // ── The observations adapter ─────────────────────────────────────────────

    #[cfg(not(target_env = "musl"))]
    fn observation(
        pattern_id: &'static str,
        hook: &str,
        body: &str,
    ) -> crate::observations::LocalObservation {
        crate::observations::LocalObservation {
            pattern_id,
            severity: "warning",
            title: "Swap I/O Pressure".into(),
            hook: hook.into(),
            body: body.into(),
            recommendation: "Reduce memory pressure.".into(),
            resolution_steps: vec!["Run: ollama ps".into()],
            action_id: "evict_idle_models",
            confidence: "high",
            confidence_ratio: 0.85,
            first_fired_ms: T0,
            node_id: "WK-TEST".into(),
            hostname: "host".into(),
        }
    }

    #[cfg(not(target_env = "musl"))]
    #[test]
    fn a_pattern_becomes_a_finding_with_its_measurement_observed() {
        let obs = [observation(
            "swap_io_pressure",
            "5.2 MB/s swap · 12.3 tok/s",
            "Sustained swap write rate of 5.2 MB/s over 85% of the last 5 minutes. \
             Swap pressure forces the OS to page model weights to disk.",
        )];
        let got = from_observations(&obs);
        assert_eq!(got.len(), 1);
        let f = &got[0];
        assert_eq!(f.rule, "swap_io_pressure");
        assert_eq!(f.severity, "warning");
        assert_eq!(f.statements[0].label, Evidence::Observed);
        assert_eq!(f.statements[0].text, "5.2 MB/s swap · 12.3 tok/s");
        assert_eq!(
            f.statements[0].basis,
            vec![EvidenceRef::Pattern {
                pattern: "swap_io_pressure",
                first_fired_ms: T0,
                confidence_pct: 85,
            }],
        );
        // Host-level: the statement names no model, because its evidence does
        // not carry one.
        assert!(f.models.is_empty(), "{:?}", f.models);

        // That body states a mechanism without hedging, so it is dropped
        // rather than labelled as something Wicklee saw.
        assert_eq!(f.statements.len(), 1, "{:?}", f.statements);
    }

    #[cfg(not(target_env = "musl"))]
    #[test]
    fn a_hedged_body_is_kept_as_the_inference() {
        let obs = [observation(
            "thermal_drain",
            "Fair thermal · 18 tok/s",
            "Throughput may be suffering: the node has been above Normal for most \
             of the last five minutes.",
        )];
        let got = from_observations(&obs);
        let f = &got[0];
        assert_eq!(f.statements.len(), 2, "{:?}", f.statements);
        assert_eq!(f.statements[1].label, Evidence::Inferred);
        // The inference inherits the pattern reference it was built on.
        assert_eq!(f.statements[1].basis, f.statements[0].basis);
    }

    #[cfg(not(target_env = "musl"))]
    #[test]
    fn an_adapted_finding_keeps_its_id_across_evaluations() {
        let a = from_observations(&[observation("swap_io_pressure", "5.2 MB/s", "x")]);
        // Different measurement, same pattern: the same finding, so the store
        // updates one row instead of accumulating one per reading.
        let b = from_observations(&[observation("swap_io_pressure", "9.9 MB/s", "y")]);
        assert_eq!(a[0].id, b[0].id);
        let c = from_observations(&[observation("thermal_drain", "5.2 MB/s", "x")]);
        assert_ne!(a[0].id, c[0].id);
    }

    #[cfg(not(target_env = "musl"))]
    #[test]
    fn a_pattern_statement_must_name_the_pattern_it_came_from() {
        assert_eq!(
            Statement::observed_pattern("x", "", T0, 0.9),
            Err(EvidenceError::NoBasis),
        );
        // A ratio outside 0..=1 is clamped rather than wrapping a u8.
        let hot = Statement::observed_pattern("x", "p", T0, 4.2).unwrap();
        assert_eq!(
            hot.basis,
            vec![EvidenceRef::Pattern { pattern: "p", first_fired_ms: T0, confidence_pct: 100 }],
        );
        let cold = Statement::observed_pattern("x", "p", T0, -1.0).unwrap();
        assert_eq!(
            cold.basis,
            vec![EvidenceRef::Pattern { pattern: "p", first_fired_ms: T0, confidence_pct: 0 }],
        );
    }
}
