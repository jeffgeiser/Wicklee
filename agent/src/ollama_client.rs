//! Typed requests and responses for the Ollama endpoints Phase 1 uses.
//!
//! Replaces the raw `serde_json::Value` indexing the harvester did
//! (`entry["details"]["quantization_level"]`, and so on). Two reasons, both
//! found by step 0 verification rather than style:
//!
//! 1. **`/api/ps` reports a running `context_length` that nothing read.** The
//!    harvester parsed `size`, `size_vram`, `details` and `expires_at` and
//!    skipped it, so `ollama_context_length` carried the model's *maximum*
//!    from `/api/show` instead. On the maintainer's host that is 131072
//!    against a running 4096 — a 32x error in a displayed field.
//! 2. **`model_info` keys are namespaced by model family, not `llama`.** The
//!    harvester hardcoded `llama.block_count`, `llama.attention.head_count_kv`
//!    and friends. Those keys are absent for `qwen3.5`, which silently nulled
//!    every context and KV-cache field for two of the three models installed
//!    on that host. See [`ModelInfo`].
//!
//! Every field is `Option` or defaulted. Ollama's documentation shows the
//! sub-fields of `details` and the keys of `model_info` only in examples, so
//! nothing here may be required: a missing field must deserialize to `None`,
//! not fail the whole response. Unknown fields are ignored, so a newer Ollama
//! adding fields cannot break parsing.

use serde::Deserialize;
use std::collections::BTreeMap;

// ── /api/ps ───────────────────────────────────────────────────────────────────

// The structs below mirror the wire format. Some fields have no consumer in
// step 1 — `residency.rs` in step 2 and the rules in step 4 read the rest — but
// they are declared here rather than added piecemeal, because step 0 showed the
// published API documentation is an unreliable guide to what a real install
// returns: these shapes were captured from live responses, and re-deriving them
// later from the docs would reintroduce exactly the bug this module fixes.

/// Deserialize an optional `u64` without ever failing the enclosing response.
///
/// `Option<u64>` rejects a value of the wrong JSON type, and serde propagates
/// that as an error for the *whole* body — so a single field whose
/// representation changed would cost the harvester every model in that poll.
/// Step 0's lesson is that real responses differ from the documentation, so the
/// safe failure mode is to lose one field, not all of them.
///
/// A JSON number is taken; anything else becomes `None`. There is deliberately
/// no coercion from strings: Ollama does not stringify these fields, and
/// inventing a conversion for a shape nobody has observed is the kind of guess
/// step 0 ruled out. A `None` here also leaves the matching capability flag
/// unproven, so a rule that needs the field will not run.
fn lenient_u64<'de, D>(d: D) -> Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<serde_json::Value>::deserialize(d)?
        .as_ref()
        .and_then(serde_json::Value::as_u64))
}

/// `GET /api/ps` — the models currently loaded.
#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct PsResponse {
    #[serde(default)]
    pub(crate) models: Vec<PsModel>,
}

impl PsResponse {
    /// The entry for `model`, matched on either `name` or `model`. Ollama
    /// populates both, but which one a caller holds depends on where it came
    /// from, so both are accepted.
    pub(crate) fn find(&self, model: &str) -> Option<&PsModel> {
        self.models
            .iter()
            .find(|m| m.name.as_deref() == Some(model) || m.model.as_deref() == Some(model))
    }
}

/// One loaded model, as `/api/ps` reports it.
#[allow(dead_code)] // wire format; see the note above
#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct PsModel {
    pub(crate) name:  Option<String>,
    pub(crate) model: Option<String>,
    /// Total runtime footprint in bytes — **weights plus KV cache**, so it
    /// grows with the running context. Step 0 V1 measured the same model at
    /// 3.15 GB with a 4096 context and 4.32 GB at 32768.
        #[serde(default, deserialize_with = "lenient_u64")]
    pub(crate) size: Option<u64>,
    /// Bytes of `size` resident in accelerator memory. `size - size_vram` is
    /// the CPU-side remainder; V1 matched it against the runner's own buffer
    /// accounting to within 0.03 MiB.
        #[serde(default, deserialize_with = "lenient_u64")]
    pub(crate) size_vram: Option<u64>,
    pub(crate) digest:     Option<String>,
    pub(crate) expires_at: Option<String>,
    /// The context the model is **currently running at**, not its maximum.
    /// Present on Ollama 0.40.16 (step 0 V2). This is the value any request to
    /// this model must pass as `num_ctx` to avoid forcing a reload (V3).
        #[serde(default, deserialize_with = "lenient_u64")]
    pub(crate) context_length: Option<u64>,
    /// Undocumented, observed as `"llamacpp"`. Informational only.
    pub(crate) runner: Option<String>,
    #[serde(default)]
    pub(crate) details: ModelDetails,
}

// ── details, shared by /api/ps, /api/tags and /api/show ───────────────────────

/// The `details` object. Documented only by example, so all optional.
#[allow(dead_code)] // wire format; see the note above
#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct ModelDetails {
    pub(crate) parent_model: Option<String>,
    pub(crate) format:       Option<String>,
    /// Model family, e.g. `"llama"` or `"qwen35"`. This is the prefix that
    /// namespaces the `model_info` keys — see [`ModelInfo::architecture`].
    pub(crate) family:   Option<String>,
    #[serde(default)]
    pub(crate) families: Vec<String>,
    pub(crate) parameter_size:     Option<String>,
    pub(crate) quantization_level: Option<String>,
    /// Undocumented, and present on `/api/tags`: the model's **maximum**
    /// context. Cheaper than `/api/show` for a model that is not loaded.
        #[serde(default, deserialize_with = "lenient_u64")]
    pub(crate) context_length:   Option<u64>,
        #[serde(default, deserialize_with = "lenient_u64")]
    pub(crate) embedding_length: Option<u64>,
    pub(crate) runner:           Option<String>,
}

// ── /api/tags ─────────────────────────────────────────────────────────────────

/// `GET /api/tags` — every installed model, loaded or not.
#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct TagsResponse {
    #[serde(default)]
    pub(crate) models: Vec<TagModel>,
}

/// One installed model.
#[allow(dead_code)] // wire format; see the note above
#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct TagModel {
    pub(crate) name:        Option<String>,
    pub(crate) model:       Option<String>,
    pub(crate) modified_at: Option<String>,
    /// Installed **file** size. Step 0 V7 found this is *larger* than the
    /// `size` `/api/ps` reports for the same model loaded (3.39 GB installed
    /// against 3.15 GB resident), so adding an overhead estimate on top of it
    /// overestimates the real footprint.
        #[serde(default, deserialize_with = "lenient_u64")]
    pub(crate) size: Option<u64>,
    /// Manifest digest — **not** the weights blob digest. Step 0 V9: resolving
    /// it against `blobs/sha256-<digest>` does not find a file.
    pub(crate) digest: Option<String>,
    /// Undocumented, observed, e.g. `["completion","vision","tools","thinking"]`.
    #[serde(default)]
    pub(crate) capabilities: Vec<String>,
    #[serde(default)]
    pub(crate) details: ModelDetails,
}

// ── /api/show ─────────────────────────────────────────────────────────────────

/// `POST /api/show` — configured parameters and architecture metadata.
#[allow(dead_code)] // wire format; see the note above
#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct ShowResponse {
    /// Free-text `key value` lines, one per configured parameter.
    pub(crate) parameters: Option<String>,
    pub(crate) template:   Option<String>,
    #[serde(default)]
    pub(crate) capabilities: Vec<String>,
    #[serde(default)]
    pub(crate) details: ModelDetails,
    #[serde(default)]
    pub(crate) model_info: ModelInfo,
}

/// The `model_info` map, with family-aware lookups.
///
/// Ollama namespaces architecture keys by the model's own architecture:
/// `llama3.1:8b` exposes `llama.block_count` while `qwen3.5:4b` exposes
/// `qwen35.block_count`. Neither exposes `general.context_length`. Reading a
/// hardcoded `llama.` prefix therefore returns nothing for any non-llama
/// model, which is the bug this type exists to prevent.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(transparent)]
pub(crate) struct ModelInfo(pub(crate) BTreeMap<String, serde_json::Value>);

impl ModelInfo {
    /// Raw lookup of a fully-qualified key.
    pub(crate) fn get(&self, key: &str) -> Option<&serde_json::Value> {
        self.0.get(key)
    }

    /// The architecture prefix for this model's namespaced keys.
    ///
    /// `details.family` is the caller-supplied hint and is checked first,
    /// because it is available on `/api/ps` and `/api/tags` too. Falls back to
    /// `general.architecture` from the map itself, then to any key that looks
    /// namespaced — so a family Ollama spells differently from its own
    /// `model_info` prefix still resolves.
    pub(crate) fn architecture(&self, family_hint: Option<&str>) -> Option<String> {
        // 1. The family, if its keys are actually present.
        if let Some(f) = family_hint.map(str::trim).filter(|f| !f.is_empty())
            && self.has_prefix(f)
        {
            return Some(f.to_string());
        }
        // 2. general.architecture, the map's own answer.
        if let Some(arch) = self.get("general.architecture").and_then(|v| v.as_str())
            && self.has_prefix(arch)
        {
            return Some(arch.to_string());
        }
        // 3. The family or general.architecture even without matching keys —
        //    better than nothing for callers that only want the label.
        if let Some(f) = family_hint.map(str::trim).filter(|f| !f.is_empty()) {
            return Some(f.to_string());
        }
        self.get("general.architecture")
            .and_then(|v| v.as_str())
            .map(str::to_string)
    }

    /// True when at least one namespaced key uses this prefix.
    fn has_prefix(&self, prefix: &str) -> bool {
        let needle = format!("{prefix}.");
        self.0.keys().any(|k| k.starts_with(&needle))
    }

    /// Read `<arch>.<suffix>` as a single number, with `general.<suffix>` as a
    /// fallback.
    ///
    /// Accepts both a scalar and an array. `qwen35.attention.head_count_kv` is
    /// an array of per-layer KV head counts — `[0,0,0,4,0,0,0,4, …]` for a
    /// hybrid-attention model, where the zeros are layers that keep no KV
    /// cache. A scalar read (`as_u64`) returns `None` on those, which is how
    /// the old code lost the field entirely.
    ///
    /// For an array the summary returned is the **mean over all layers,
    /// rounded up**. Every consumer of these fields multiplies by the layer
    /// count, and the mean is the only summary that preserves the total: 8
    /// layers of 4 heads across 32 layers gives a mean of 1, and 32 × 1
    /// recovers the real 32 head-layers, where the maximum (4) would
    /// overestimate by 4x. Rounding up keeps the estimate conservative for a
    /// headroom question.
    ///
    /// A single scalar cannot describe a hybrid model honestly, so a consumer
    /// that needs the real per-layer shape should read the raw value through
    /// [`Self::get`] rather than trusting this summary.
    pub(crate) fn arch_u64(&self, arch: Option<&str>, suffix: &str) -> Option<u64> {
        let candidates = arch
            .map(|a| format!("{a}.{suffix}"))
            .into_iter()
            .chain(std::iter::once(format!("general.{suffix}")));
        for key in candidates {
            if let Some(v) = self.0.get(&key)
                && let Some(n) = value_as_u64(v)
            {
                return Some(n);
            }
        }
        None
    }

}

/// Coerce one `model_info` value to a number.
///
/// Scalars pass through. Arrays collapse to the ceiling of their mean, for the
/// reason given on [`ModelInfo::arch_u64`]. An empty array, a string, or a
/// nested structure yields `None` rather than a guess.
fn value_as_u64(v: &serde_json::Value) -> Option<u64> {
    if let Some(n) = v.as_u64() {
        return Some(n);
    }
    let arr = v.as_array()?;
    if arr.is_empty() {
        return None;
    }
    // Every element must be a number; a mixed array is not something to average.
    let mut sum: u64 = 0;
    for item in arr {
        sum = sum.checked_add(item.as_u64()?)?;
    }
    let len = arr.len() as u64;
    // Ceiling division, so a fractional mean rounds up.
    Some(sum.div_ceil(len))
}

// ── /api/generate (final, non-streaming response) ─────────────────────────────

/// The final packet of `POST /api/generate`. Durations are nanoseconds.
#[allow(dead_code)] // wire format; see the note near /api/ps
#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct GenerateResponse {
    pub(crate) model:       Option<String>,
    pub(crate) done:        Option<bool>,
    pub(crate) done_reason: Option<String>,
        #[serde(default, deserialize_with = "lenient_u64")]
    pub(crate) total_duration:           Option<u64>,
    /// Nanoseconds spent loading the model. Near zero when it was already
    /// resident; a multi-second value on a warm model means the request forced
    /// a reload (step 0 V3).
        #[serde(default, deserialize_with = "lenient_u64")]
    pub(crate) load_duration:            Option<u64>,
        #[serde(default, deserialize_with = "lenient_u64")]
    pub(crate) prompt_eval_count:        Option<u64>,
        #[serde(default, deserialize_with = "lenient_u64")]
    pub(crate) prompt_eval_cached_count: Option<u64>,
        #[serde(default, deserialize_with = "lenient_u64")]
    pub(crate) prompt_eval_duration:     Option<u64>,
        #[serde(default, deserialize_with = "lenient_u64")]
    pub(crate) eval_count:               Option<u64>,
        #[serde(default, deserialize_with = "lenient_u64")]
    pub(crate) eval_duration:            Option<u64>,
}

impl GenerateResponse {
    /// Generation rate in tokens per second.
    pub(crate) fn eval_tps(&self) -> Option<f32> {
        rate(self.eval_count?, self.eval_duration?)
    }

    /// Prompt-processing (prefill) rate in tokens per second.
    pub(crate) fn prompt_eval_tps(&self) -> Option<f32> {
        rate(self.prompt_eval_count?, self.prompt_eval_duration?)
    }

    /// Prompt-processing time in milliseconds, the probe's TTFT stand-in.
    pub(crate) fn prompt_eval_ms(&self) -> Option<f32> {
        let ns = self.prompt_eval_duration?;
        if ns == 0 { return None; }
        Some((ns as f64 / 1_000_000.0) as f32)
    }

    /// Model load time in milliseconds.
    pub(crate) fn load_ms(&self) -> Option<f32> {
        Some((self.load_duration? as f64 / 1_000_000.0) as f32)
    }
}

/// `count / duration_ns` as tokens per second, rejecting non-positive results.
fn rate(count: u64, duration_ns: u64) -> Option<f32> {
    if count == 0 || duration_ns == 0 {
        return None;
    }
    let tps = count as f64 / (duration_ns as f64 / 1_000_000_000.0);
    if tps > 0.0 { Some(tps as f32) } else { None }
}

// ── /api/version ──────────────────────────────────────────────────────────────

/// `GET /api/version`. Informational only — capabilities are detected from
/// real responses, never inferred from this string.
#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct VersionResponse {
    pub(crate) version: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from Ollama 0.40.16 during step 0. Trimmed to the fields under
    // test, but field names and shapes are verbatim.
    const PS_QWEN: &str = r#"{
      "models": [{
        "name": "qwen3.5:4b",
        "model": "qwen3.5:4b",
        "size": 3150257846,
        "digest": "2a654d98e6fb",
        "details": {
          "parent_model": "", "format": "gguf", "family": "qwen35",
          "families": ["qwen35"], "parameter_size": "4.7B",
          "quantization_level": "Q4_K_M"
        },
        "expires_at": "2026-11-13T09:26:44.305831-05:00",
        "size_vram": 3150257846,
        "context_length": 4096,
        "runner": "llamacpp"
      }]
    }"#;

    #[test]
    fn ps_parses_every_documented_field_plus_the_observed_ones() {
        let ps: PsResponse = serde_json::from_str(PS_QWEN).unwrap();
        let m = ps.find("qwen3.5:4b").expect("found by name");
        assert_eq!(m.size, Some(3_150_257_846));
        assert_eq!(m.size_vram, Some(3_150_257_846));
        assert_eq!(m.context_length, Some(4096), "running context must be read");
        assert_eq!(m.digest.as_deref(), Some("2a654d98e6fb"));
        assert!(m.expires_at.is_some());
        assert_eq!(m.runner.as_deref(), Some("llamacpp"), "undocumented but present");
        assert_eq!(m.details.family.as_deref(), Some("qwen35"));
        assert_eq!(m.details.quantization_level.as_deref(), Some("Q4_K_M"));
        assert_eq!(m.size, m.size_vram, "fully resident: nothing outside the GPU");
    }

    #[test]
    fn ps_tolerates_every_field_being_absent() {
        // The whole point of the type: a sparse response must parse, not fail.
        let ps: PsResponse = serde_json::from_str(r#"{"models":[{}]}"#).unwrap();
        let m = &ps.models[0];
        assert!(m.name.is_none() && m.size.is_none() && m.context_length.is_none());
        assert!(m.details.family.is_none());

        // An empty body and an absent models array both yield no models.
        assert!(serde_json::from_str::<PsResponse>("{}").unwrap().models.is_empty());
    }

    #[test]
    fn a_wrong_typed_number_costs_one_field_not_the_whole_response() {
        // The failure mode this guards: `Option<u64>` rejects a non-number and
        // serde fails the entire body, so one odd field would have cost the
        // harvester every model in that poll.
        let ps: PsResponse = serde_json::from_str(
            r#"{"models":[{"name":"m","size":"not-a-number","size_vram":123,"context_length":[]}]}"#,
        )
        .expect("the response must still parse");
        let m = &ps.models[0];
        assert_eq!(m.name.as_deref(), Some("m"), "other fields survive");
        assert_eq!(m.size_vram, Some(123));
        assert_eq!(m.size, None, "the bad field is dropped, not fatal");
        assert_eq!(m.context_length, None);

        // Same for a generate response.
        let g: GenerateResponse =
            serde_json::from_str(r#"{"eval_count":{},"eval_duration":349588000}"#).unwrap();
        assert_eq!(g.eval_count, None);
        assert_eq!(g.eval_duration, Some(349_588_000));

        // And negatives, which are not valid u64.
        let neg: PsResponse = serde_json::from_str(r#"{"models":[{"size":-1}]}"#).unwrap();
        assert_eq!(neg.models[0].size, None);
    }

    #[test]
    fn ps_ignores_unknown_fields() {
        // A newer Ollama adding fields must not break parsing.
        let ps: PsResponse =
            serde_json::from_str(r#"{"models":[{"name":"m","brand_new_field":42}],"also_new":1}"#)
                .unwrap();
        assert_eq!(ps.models[0].name.as_deref(), Some("m"));
    }

    #[test]
    fn ps_matches_on_the_model_field_when_name_is_absent() {
        let ps: PsResponse = serde_json::from_str(r#"{"models":[{"model":"m:1b"}]}"#).unwrap();
        assert!(ps.find("m:1b").is_some());
        assert!(ps.find("other").is_none());
    }

    // ── model_info family resolution: the bug this module fixes ──────────────

    fn show_with(info: serde_json::Value, family: &str) -> ShowResponse {
        serde_json::from_value(serde_json::json!({
            "details": { "family": family },
            "model_info": info,
        }))
        .unwrap()
    }

    #[test]
    fn model_info_resolves_llama_keys() {
        let show = show_with(
            serde_json::json!({
                "general.architecture": "llama",
                "general.parameter_count": 8_030_261_312u64,
                "llama.context_length": 131072,
                "llama.block_count": 32,
                "llama.attention.head_count": 32,
                "llama.attention.head_count_kv": 8,
                "llama.embedding_length": 4096,
            }),
            "llama",
        );
        let arch = show.model_info.architecture(show.details.family.as_deref());
        assert_eq!(arch.as_deref(), Some("llama"));
        let a = arch.as_deref();
        assert_eq!(show.model_info.arch_u64(a, "context_length"), Some(131072));
        assert_eq!(show.model_info.arch_u64(a, "block_count"), Some(32));
        assert_eq!(show.model_info.arch_u64(a, "attention.head_count"), Some(32));
        assert_eq!(show.model_info.arch_u64(a, "attention.head_count_kv"), Some(8));
        assert_eq!(show.model_info.arch_u64(a, "embedding_length"), Some(4096));
        // general.* fallback still works for keys that live there.
        assert_eq!(show.model_info.arch_u64(a, "parameter_count"), Some(8_030_261_312));
    }

    #[test]
    fn model_info_resolves_qwen35_keys_that_the_old_code_lost() {
        // Verbatim shapes from the maintainer's host. Under the old hardcoded
        // `llama.` prefix every one of these read as None.
        let show = show_with(
            serde_json::json!({
                "general.architecture": "qwen35",
                "general.parameter_count": 4_659_865_088u64,
                "qwen35.context_length": 262144,
                "qwen35.block_count": 32,
                "qwen35.embedding_length": 2560,
                "qwen35.attention.head_count": 16,
                "qwen35.attention.head_count_kv":
                    [0,0,0,4,0,0,0,4,0,0,0,4,0,0,0,4,0,0,0,4,0,0,0,4,0,0,0,4,0,0,0,4],
            }),
            "qwen35",
        );
        let arch = show.model_info.architecture(show.details.family.as_deref());
        assert_eq!(arch.as_deref(), Some("qwen35"));
        let a = arch.as_deref();
        assert_eq!(show.model_info.arch_u64(a, "context_length"), Some(262144));
        assert_eq!(show.model_info.arch_u64(a, "block_count"), Some(32));
        assert_eq!(show.model_info.arch_u64(a, "embedding_length"), Some(2560));
        assert_eq!(show.model_info.arch_u64(a, "attention.head_count"), Some(16));

        // The array case. 8 layers of 4 heads over 32 layers: mean = 1, and
        // 32 layers x 1 head recovers the real 32 head-layers.
        assert_eq!(
            show.model_info.arch_u64(a, "attention.head_count_kv"),
            Some(1),
            "array must collapse to the layer-preserving mean, not None",
        );
        // The raw value stays reachable for a consumer that needs per-layer data.
        let raw = show.model_info.get("qwen35.attention.head_count_kv").unwrap();
        let per_layer: Vec<u64> = raw.as_array().unwrap().iter().filter_map(|v| v.as_u64()).collect();
        assert_eq!(per_layer.len(), 32);
        assert_eq!(per_layer.iter().sum::<u64>(), 32);
    }

    #[test]
    fn hardcoded_llama_prefix_would_have_returned_nothing() {
        // Pins the regression: reading qwen35 data under a `llama.` prefix.
        let show = show_with(
            serde_json::json!({ "qwen35.block_count": 32, "qwen35.context_length": 262144 }),
            "qwen35",
        );
        assert_eq!(show.model_info.arch_u64(Some("llama"), "block_count"), None);
        assert_eq!(show.model_info.arch_u64(Some("llama"), "context_length"), None);
        // And `general.context_length` is absent on real models, so the old
        // `.or_else()` chain had nothing left to fall back to.
        assert_eq!(show.model_info.get("general.context_length"), None);
    }

    #[test]
    fn architecture_falls_back_when_the_family_does_not_match_the_prefix() {
        // Family says one thing, the keys say another: trust the keys.
        let show = show_with(
            serde_json::json!({ "general.architecture": "qwen35", "qwen35.block_count": 32 }),
            "some-other-name",
        );
        let arch = show.model_info.architecture(show.details.family.as_deref());
        assert_eq!(arch.as_deref(), Some("qwen35"));
        assert_eq!(show.model_info.arch_u64(arch.as_deref(), "block_count"), Some(32));
    }

    #[test]
    fn architecture_handles_no_hint_and_no_map() {
        let empty = ModelInfo::default();
        assert_eq!(empty.architecture(None), None);
        assert_eq!(empty.architecture(Some("llama")).as_deref(), Some("llama"));
        assert_eq!(empty.arch_u64(Some("llama"), "block_count"), None);
        assert_eq!(empty.arch_u64(None, "block_count"), None);
        // A blank family is not a prefix.
        assert_eq!(empty.architecture(Some("   ")), None);
    }

    #[test]
    fn value_coercion_rejects_what_it_cannot_average() {
        assert_eq!(value_as_u64(&serde_json::json!(7)), Some(7));
        assert_eq!(value_as_u64(&serde_json::json!([2, 4])), Some(3));
        // Ceiling: mean of 1.5 rounds up to 2, keeping headroom conservative.
        assert_eq!(value_as_u64(&serde_json::json!([1, 2])), Some(2));
        assert_eq!(value_as_u64(&serde_json::json!([])), None);
        assert_eq!(value_as_u64(&serde_json::json!("4096")), None);
        assert_eq!(value_as_u64(&serde_json::json!([1, "x"])), None);
        assert_eq!(value_as_u64(&serde_json::json!(-1)), None);
        assert_eq!(value_as_u64(&serde_json::json!(null)), None);
    }

    // ── /api/tags ────────────────────────────────────────────────────────────

    #[test]
    fn tags_parses_the_observed_shape() {
        let tags: TagsResponse = serde_json::from_str(r#"{
          "models": [{
            "name": "llama3.1:8b", "model": "llama3.1:8b",
            "modified_at": "2026-03-20T10:00:00Z",
            "size": 4920753328,
            "digest": "46e0c10c039e",
            "capabilities": ["completion","tools"],
            "details": {
              "family": "llama", "quantization_level": "Q4_K_M",
              "context_length": 131072, "embedding_length": 4096, "runner": "ggml"
            }
          }]
        }"#).unwrap();
        let m = &tags.models[0];
        assert_eq!(m.size, Some(4_920_753_328));
        assert_eq!(m.capabilities, vec!["completion", "tools"]);
        // The cheap max-context source for a model that is not loaded.
        assert_eq!(m.details.context_length, Some(131072));
        assert_eq!(m.details.runner.as_deref(), Some("ggml"));
    }

    #[test]
    fn tags_tolerates_missing_capabilities_and_details() {
        let tags: TagsResponse =
            serde_json::from_str(r#"{"models":[{"name":"m"}]}"#).unwrap();
        assert!(tags.models[0].capabilities.is_empty());
        assert!(tags.models[0].details.context_length.is_none());
    }

    // ── /api/generate ────────────────────────────────────────────────────────

    #[test]
    fn generate_parses_and_derives_rates() {
        // Captured from a real probe response.
        let g: GenerateResponse = serde_json::from_str(r#"{
          "model": "qwen3.5:4b", "done": true, "done_reason": "length",
          "total_duration": 3585902375, "load_duration": 3110125417,
          "prompt_eval_count": 11, "prompt_eval_cached_count": 0,
          "prompt_eval_duration": 122646000,
          "eval_count": 8, "eval_duration": 349588000,
          "thinking": null, "context": [1,2,3]
        }"#).unwrap();
        assert_eq!(g.done_reason.as_deref(), Some("length"));
        assert_eq!(g.prompt_eval_cached_count, Some(0));
        // 8 tokens in 0.349588 s
        let tps = g.eval_tps().unwrap();
        assert!((tps - 22.88).abs() < 0.05, "eval_tps was {tps}");
        let pe = g.prompt_eval_tps().unwrap();
        assert!((pe - 89.69).abs() < 0.05, "prompt_eval_tps was {pe}");
        assert!((g.prompt_eval_ms().unwrap() - 122.646).abs() < 0.01);
        assert!((g.load_ms().unwrap() - 3110.125).abs() < 0.01);
    }

    #[test]
    fn generate_rates_are_none_rather_than_zero_or_infinite() {
        let g: GenerateResponse = serde_json::from_str(
            r#"{"eval_count":0,"eval_duration":0,"prompt_eval_count":5,"prompt_eval_duration":0}"#,
        )
        .unwrap();
        assert_eq!(g.eval_tps(), None, "no divide by zero");
        assert_eq!(g.prompt_eval_tps(), None);
        assert_eq!(g.prompt_eval_ms(), None);
        assert_eq!(GenerateResponse::default().load_ms(), None);
    }

    #[test]
    fn version_parses_and_tolerates_absence() {
        let v: VersionResponse = serde_json::from_str(r#"{"version":"0.40.16"}"#).unwrap();
        assert_eq!(v.version.as_deref(), Some("0.40.16"));
        assert_eq!(serde_json::from_str::<VersionResponse>("{}").unwrap().version, None);
    }
}
