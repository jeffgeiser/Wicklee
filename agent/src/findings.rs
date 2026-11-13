//! Evidence labels, and the statements built on them.
//!
//! Step 4 adds `Finding` and the diagnostic rules here. Step 3 needs only the
//! statement machinery, because every readiness answer carries statements.
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

use serde::Serialize;

use crate::residency::Transition;

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
    /// a transition is (node_id, ts_ms, model, kind); step 4 should cite that
    /// when a finding has to survive a restart.
    Transition { id: u64, ts_ms: i64 },
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
}
