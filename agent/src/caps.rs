//! Which response fields this Ollama install really returns.
//!
//! Step 0 established the rule this module enforces: *documented does not mean
//! present*. Every capability here is set from a real response and never
//! inferred from a version string, because a version number does not tell you
//! what a given build, platform or configuration actually emits.
//!
//! Flags are **monotonic**: they go from false to true when a field is
//! observed and never back. A false flag means "not seen yet", not "absent" —
//! an empty `/api/ps` on an idle host proves nothing about `size_vram`. That
//! asymmetry is what makes the record safe to gate rules on: a rule that needs
//! a field it has never seen does not run, and `inspect` can say why.
//!
//! The counterpart lesson from step 0 is that a capability record is necessary
//! but not sufficient. On the maintainer's host every documented field Phase 1
//! depends on was present; the problems found were fields that *mean*
//! something other than a rule assumed (V1, V3, V4, V6, V7). Capability flags
//! do not protect against that — the evidence labels do.

use crate::ollama_client::{GenerateResponse, PsResponse, TagsResponse};

/// Set from real responses, never from a version string.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub(crate) struct RuntimeCaps {
    /// Informational only. Never gates a rule.
    pub(crate) version: Option<String>,

    // ── /api/ps ──────────────────────────────────────────────────────────────
    pub(crate) ps_size_vram:      bool,
    pub(crate) ps_context_length: bool,
    pub(crate) ps_expires_at:     bool,
    pub(crate) ps_digest:         bool,

    // ── /api/generate ────────────────────────────────────────────────────────
    pub(crate) gen_load_duration:            bool,
    pub(crate) gen_prompt_eval_count:        bool,
    pub(crate) gen_prompt_eval_cached_count: bool,

    // ── /api/tags ────────────────────────────────────────────────────────────
    pub(crate) tags_available: bool,
    /// `details.context_length` on `/api/tags`. Split out from
    /// `tags_available` on the step 0 recommendation: when present it gives a
    /// never-loaded model's maximum context without an `/api/show` call, which
    /// is a different capability from the endpoint merely answering.
    pub(crate) tags_details_context_length: bool,
}

impl RuntimeCaps {
    /// Record what a `/api/ps` response proves.
    ///
    /// `/api/ps` lists loaded models only, so a response with no models
    /// observes nothing — it must not clear flags set by an earlier poll.
    pub(crate) fn observe_ps(&mut self, ps: &PsResponse) {
        for m in &ps.models {
            self.ps_size_vram      |= m.size_vram.is_some();
            self.ps_context_length |= m.context_length.is_some();
            self.ps_expires_at     |= m.expires_at.is_some();
            self.ps_digest         |= m.digest.is_some();
        }
    }

    /// Record what a final `/api/generate` packet proves.
    ///
    /// `prompt_eval_cached_count` is observed as present even when zero: zero
    /// cached tokens is a real answer, and `Option::is_some` is the test for
    /// whether the field exists at all.
    pub(crate) fn observe_generate(&mut self, g: &GenerateResponse) {
        self.gen_load_duration            |= g.load_duration.is_some();
        self.gen_prompt_eval_count        |= g.prompt_eval_count.is_some();
        self.gen_prompt_eval_cached_count |= g.prompt_eval_cached_count.is_some();
    }

    /// Record what a `/api/tags` response proves. A successful call with zero
    /// installed models still proves the endpoint exists.
    pub(crate) fn observe_tags(&mut self, tags: &TagsResponse) {
        self.tags_available = true;
        for m in &tags.models {
            self.tags_details_context_length |= m.details.context_length.is_some();
        }
    }

    /// Record the runtime version. Informational.
    pub(crate) fn observe_version(&mut self, version: Option<&str>) {
        if let Some(v) = version.map(str::trim).filter(|v| !v.is_empty()) {
            self.version = Some(v.to_string());
        }
    }

    /// Capabilities that are still unproven, by the name a rule would cite.
    ///
    /// Feeds the "not checked" list `inspect` prints in step 4, so an operator
    /// sees which rules could not run and why rather than a silent gap.
    pub(crate) fn missing(&self) -> Vec<&'static str> {
        let mut out = Vec::new();
        for (present, name) in [
            (self.ps_size_vram,                 "ps_size_vram"),
            (self.ps_context_length,            "ps_context_length"),
            (self.ps_expires_at,                "ps_expires_at"),
            (self.ps_digest,                    "ps_digest"),
            (self.gen_load_duration,            "gen_load_duration"),
            (self.gen_prompt_eval_count,        "gen_prompt_eval_count"),
            (self.gen_prompt_eval_cached_count, "gen_prompt_eval_cached_count"),
            (self.tags_available,               "tags_available"),
            (self.tags_details_context_length,  "tags_details_context_length"),
        ] {
            if !present {
                out.push(name);
            }
        }
        out
    }
}

/// Shared handle, written by the harvester and read by the rules layer.
impl RuntimeCaps {
    /// The record as the HTTP surface reports it.
    ///
    /// One builder, so `/api/health` and `/v1/state` cannot describe the same
    /// runtime differently. `unverified` is the list of fields this runtime has
    /// not been seen to return, which is what `inspect` cites when it says what
    /// it could not check.
    pub(crate) fn report(&self) -> serde_json::Value {
        serde_json::json!({
            "runtime_version": self.version,
            "verified": {
                "ps_size_vram":                 self.ps_size_vram,
                "ps_context_length":            self.ps_context_length,
                "ps_expires_at":                self.ps_expires_at,
                "ps_digest":                    self.ps_digest,
                "gen_load_duration":            self.gen_load_duration,
                "gen_prompt_eval_count":        self.gen_prompt_eval_count,
                "gen_prompt_eval_cached_count": self.gen_prompt_eval_cached_count,
                "tags_available":               self.tags_available,
                "tags_details_context_length":  self.tags_details_context_length,
            },
            "unverified": self.missing(),
        })
    }
}

pub(crate) type SharedCaps = std::sync::Arc<std::sync::Mutex<RuntimeCaps>>;

#[cfg(test)]
mod tests {
    use super::*;

    /// A full `/api/ps` body, as Ollama 0.40.16 returns it. Named fields are
    /// removed one at a time by the tests below to stand in for a runtime that
    /// does not emit them.
    fn ps_full() -> serde_json::Value {
        serde_json::json!({
            "models": [{
                "name": "llama3.1:8b", "model": "llama3.1:8b",
                "size": 5280104447u64, "size_vram": 5280104447u64,
                "digest": "46e0c10c039e",
                "expires_at": "2026-11-13T09:26:44.305831-05:00",
                "context_length": 4096,
                "details": { "family": "llama" }
            }]
        })
    }

    fn ps_without(fields: &[&str]) -> PsResponse {
        let mut v = ps_full();
        for f in fields {
            v["models"][0].as_object_mut().unwrap().remove(*f);
        }
        serde_json::from_value(v).unwrap()
    }

    fn caps_from_ps(ps: &PsResponse) -> RuntimeCaps {
        let mut c = RuntimeCaps::default();
        c.observe_ps(ps);
        c
    }

    #[test]
    fn a_full_response_proves_every_ps_capability() {
        let c = caps_from_ps(&ps_without(&[]));
        assert!(c.ps_size_vram && c.ps_context_length && c.ps_expires_at && c.ps_digest);
    }

    #[test]
    fn each_removed_field_switches_exactly_its_own_capability_off() {
        // The spec's step 1 bar: "capability record is correct against the mock
        // with fields removed". Removing one field must not disturb the others.
        for (field, check) in [
            ("size_vram",      "ps_size_vram"),
            ("context_length", "ps_context_length"),
            ("expires_at",     "ps_expires_at"),
            ("digest",         "ps_digest"),
        ] {
            let c = caps_from_ps(&ps_without(&[field]));
            let flags = [
                ("ps_size_vram",      c.ps_size_vram),
                ("ps_context_length", c.ps_context_length),
                ("ps_expires_at",     c.ps_expires_at),
                ("ps_digest",         c.ps_digest),
            ];
            for (name, present) in flags {
                if name == check {
                    assert!(!present, "removing {field} should clear {name}");
                } else {
                    assert!(present, "removing {field} must not clear {name}");
                }
            }
            assert_eq!(c.missing(), {
                let mut want = vec![check];
                want.extend([
                    "gen_load_duration",
                    "gen_prompt_eval_count",
                    "gen_prompt_eval_cached_count",
                    "tags_available",
                    "tags_details_context_length",
                ]);
                want
            });
        }
    }

    #[test]
    fn all_ps_fields_removed_proves_nothing() {
        let c = caps_from_ps(&ps_without(&["size_vram", "context_length", "expires_at", "digest"]));
        assert!(!c.ps_size_vram && !c.ps_context_length && !c.ps_expires_at && !c.ps_digest);
    }

    #[test]
    fn an_empty_ps_cannot_clear_what_an_earlier_poll_proved() {
        // The asymmetry that makes the record safe: an idle host with nothing
        // loaded says nothing about the runtime's fields.
        let mut c = caps_from_ps(&ps_without(&[]));
        assert!(c.ps_context_length);
        c.observe_ps(&serde_json::from_str(r#"{"models":[]}"#).unwrap());
        assert!(c.ps_context_length, "an empty poll must not downgrade a capability");
        c.observe_ps(&serde_json::from_str("{}").unwrap());
        assert!(c.ps_context_length);
    }

    #[test]
    fn one_model_carrying_a_field_is_enough() {
        // Mixed fleet of loaded models: the capability belongs to the runtime.
        let ps: PsResponse = serde_json::from_value(serde_json::json!({
            "models": [
                { "name": "a" },
                { "name": "b", "context_length": 8192 }
            ]
        }))
        .unwrap();
        assert!(caps_from_ps(&ps).ps_context_length);
    }

    #[test]
    fn generate_capabilities_track_their_fields() {
        let mut c = RuntimeCaps::default();
        c.observe_generate(&serde_json::from_str(r#"{"eval_count":8}"#).unwrap());
        assert!(!c.gen_load_duration && !c.gen_prompt_eval_count);

        c.observe_generate(
            &serde_json::from_str(
                r#"{"load_duration":3110125417,"prompt_eval_count":11,"prompt_eval_cached_count":0}"#,
            )
            .unwrap(),
        );
        assert!(c.gen_load_duration && c.gen_prompt_eval_count);
        assert!(
            c.gen_prompt_eval_cached_count,
            "a cached count of zero still proves the field exists",
        );
    }

    #[test]
    fn tags_capability_is_about_the_endpoint_answering() {
        let mut c = RuntimeCaps::default();
        assert!(!c.tags_available);
        // Zero installed models, but the endpoint answered.
        c.observe_tags(&serde_json::from_str(r#"{"models":[]}"#).unwrap());
        assert!(c.tags_available);
        assert!(!c.tags_details_context_length);

        c.observe_tags(
            &serde_json::from_str(r#"{"models":[{"name":"m","details":{"context_length":131072}}]}"#)
                .unwrap(),
        );
        assert!(c.tags_details_context_length);
    }

    #[test]
    fn version_is_recorded_but_never_a_capability() {
        let mut c = RuntimeCaps::default();
        c.observe_version(Some("0.40.16"));
        assert_eq!(c.version.as_deref(), Some("0.40.16"));
        // A version string must not imply any field is present.
        assert_eq!(c.missing().len(), 9, "version must prove no capability");

        // Blank or absent versions are not recorded over a known one.
        c.observe_version(Some("  "));
        c.observe_version(None);
        assert_eq!(c.version.as_deref(), Some("0.40.16"));
    }

    #[test]
    fn missing_lists_everything_on_a_fresh_record() {
        let c = RuntimeCaps::default();
        assert_eq!(
            c.missing(),
            vec![
                "ps_size_vram",
                "ps_context_length",
                "ps_expires_at",
                "ps_digest",
                "gen_load_duration",
                "gen_prompt_eval_count",
                "gen_prompt_eval_cached_count",
                "tags_available",
                "tags_details_context_length",
            ]
        );
    }

    #[test]
    fn the_maintainers_host_proves_every_capability() {
        // Step 0 recorded that every documented field Phase 1 needs is present
        // on Ollama 0.40.16. This pins that result as a regression check.
        let mut c = RuntimeCaps::default();
        c.observe_version(Some("0.40.16"));
        c.observe_ps(&ps_without(&[]));
        c.observe_generate(
            &serde_json::from_str(
                r#"{"total_duration":3585902375,"load_duration":3110125417,
                    "prompt_eval_count":11,"prompt_eval_cached_count":0,
                    "prompt_eval_duration":122646000,"eval_count":8,
                    "eval_duration":349588000}"#,
            )
            .unwrap(),
        );
        c.observe_tags(
            &serde_json::from_str(
                r#"{"models":[{"name":"llama3.1:8b","size":4920753328,
                    "details":{"context_length":131072}}]}"#,
            )
            .unwrap(),
        );
        assert!(c.missing().is_empty(), "unexpectedly missing: {:?}", c.missing());
    }
}
