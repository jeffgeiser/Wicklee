//! Shared model-fit scoring math — SINGLE SOURCE OF TRUTH.
//!
//! ── DO NOT EDIT agent/src/scoring.rs or cloud/src/scoring.rs DIRECTLY ──
//!
//! Canonical file: shared/scoring.rs. Both binaries carry byte-identical
//! mirrors maintained by `node scripts/sync-scoring.mjs` (CI enforces with
//! `--check`). The mirror-and-sync approach exists because a cargo path
//! dependency can't work here: the cloud's Railway Docker build context is
//! `cloud/` only, so `../shared` would be invisible to its deploys. Same
//! pattern as perplexity_baseline.json.
//!
//! History: these functions were hand-duplicated between the binaries and
//! drifted twice — the working-set overhead (10% vs 30%) and the won't-fit
//! hard gate existed in one binary but not the other, so the same model
//! graded differently on the cloud fleet view vs the localhost dashboard.

#![allow(dead_code)] // not every binary uses every item

/// VRAM overhead estimate for a candidate model that hasn't been loaded yet.
///
/// Real VRAM usage = weights + KV cache + activation buffers + framework
/// overhead. 30% covers a realistic working set: KV cache at typical 8K
/// context for a 7–13B class model (~15% of weights), activation buffers
/// (~5%), framework alignment + scratch space (~10%). 512 MB floor for
/// small models. A 10% figure used previously underestimated 2–3×, causing
/// "Excellent" labels on models that OOM'd in production.
///
/// Mirrors the frontend's WORKING_SET_OVERHEAD / WORKING_SET_FLOOR_MB in
/// src/utils/modelFit.ts.
pub(crate) fn estimate_vram_mb(file_size_bytes: u64) -> u64 {
    let base_mb = file_size_bytes / (1024 * 1024);
    base_mb + (base_mb * 30 / 100).max(512)
}

/// Extract a parameter count (in billions) from a HuggingFace model_id.
/// Matches patterns like "Llama-3.2-3B-Instruct", "Qwen3-27B-Heretic",
/// "Mixtral-8x7B" (returns 8×7=56), "DeepSeek-67B".
pub(crate) fn extract_params_b(model_id: &str) -> Option<f32> {
    let lower = model_id.to_lowercase();
    // First try "NxMB" (MoE expert count × per-expert params) — e.g. "8x7b" → 56.
    // NOTE: this is the naive expert product; real MoE totals run ~17% lower
    // (Mixtral 8x7B is 46.7B) because attention/embedding weights are shared.
    // Acceptable here: the only consumer is the ±(30%–200%) plausibility band.
    // Scan EVERY 'x' position — `find('x')` stopped at the 'x' in
    // "miXtral", so "Mixtral-8x7B" fell through to the plain scan and parsed
    // as 7B; its ~26 GB Q4 files then exceeded the 200% plausibility bound
    // and were rejected as mislabeled.
    for (idx, _) in lower.match_indices('x') {
        if idx == 0 || idx + 1 >= lower.len() { continue; }
        let before: String = lower[..idx].chars().rev()
            .take_while(|c| c.is_ascii_digit()).collect::<String>()
            .chars().rev().collect();
        let after_substr = &lower[idx + 1..];
        let after_num: String = after_substr.chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.').collect();
        let suffix_ok = after_substr[after_num.len()..].starts_with('b');
        if !before.is_empty() && !after_num.is_empty() && suffix_ok {
            if let (Ok(e), Ok(p)) = (before.parse::<f32>(), after_num.parse::<f32>()) {
                return Some(e * p);
            }
        }
    }
    // Fallback: plain "NB" or "N.MB", word-boundaried so "1b" in "1binary"
    // doesn't match.
    let bytes = lower.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') { i += 1; }
            if i < bytes.len() && bytes[i] == b'b' {
                let is_boundary = i + 1 >= bytes.len() || !bytes[i + 1].is_ascii_alphanumeric();
                if is_boundary {
                    if let Ok(p) = lower[start..i].parse::<f32>() {
                        if p > 0.0 && p < 10000.0 { return Some(p); }
                    }
                }
            }
        }
        i += 1;
    }
    None
}

/// Approximate bytes-per-parameter for a quant string. Used to compute the
/// expected file size of a model variant — anything ≤30% of expected is
/// almost certainly an auxiliary file mislabeled by the filename parser.
///
/// Values are bits-per-weight ÷ 8 (F16 = 16 bits = 2.0 bytes). An earlier
/// revision stored the bit counts directly while the caller multiplied them
/// as bytes — every correctly-sized GGUF came out at ~12% of "expected" and
/// was rejected by the 30% floor, silently emptying model discovery.
pub(crate) fn bytes_per_param_for_quant(quant: &str) -> Option<f32> {
    let q = quant.to_ascii_uppercase();
    if q.starts_with("Q2") || q.starts_with("IQ2") { return Some(0.375); }  // ~3 bits
    if q.starts_with("Q3") || q.starts_with("IQ3") { return Some(0.4375); } // ~3.5 bits
    if q.starts_with("Q4") || q.starts_with("IQ4") { return Some(0.5625); } // ~4.5 bits
    if q.starts_with("Q5") { return Some(0.6875); }                          // ~5.5 bits
    if q.starts_with("Q6") { return Some(0.8125); }                          // ~6.5 bits
    if q.starts_with("Q8") { return Some(1.125); }                           // ~9 bits
    if q == "F16" || q == "BF16" { return Some(2.0); }
    if q == "F32" { return Some(4.0); }
    None
}

/// True when the file size is plausible for a model of the given parameter
/// count + quant. Anything under 30% of expected is dropped as likely
/// auxiliary; anything over 200% as a double-counted shard sum.
///
/// Conservative: returns true when the quant or param count can't be parsed
/// — only drops when both signals are available and disagree.
pub(crate) fn is_plausible_size_for_quant(
    params_b: Option<f32>,
    quant: &str,
    file_size_bytes: u64,
) -> bool {
    let Some(p) = params_b else { return true; };
    let Some(bpp) = bytes_per_param_for_quant(quant) else { return true; };
    if file_size_bytes == 0 { return false; }
    let expected = (p * 1e9 * bpp) as u64;
    if expected == 0 { return true; }
    let lower = expected.saturating_mul(30) / 100;
    let upper = expected.saturating_mul(200) / 100;
    file_size_bytes >= lower && file_size_bytes <= upper
}

/// Component breakdown of the 0–100 model-to-hardware fit score.
pub(crate) struct FitComponents {
    pub(crate) vram_required_mb: u64,
    pub(crate) headroom_pct:     f32,
    pub(crate) vram_score:       u8,
    pub(crate) thermal_score:    u8,
    pub(crate) wes_score:        u8,
    pub(crate) power_score:      u8,
    /// 0–100 total. Hard-gated to 0 when the model doesn't fit — summing the
    /// other components for a non-fitting model produced 30–40 point scores
    /// that survived `score > 0` filters.
    pub(crate) total:            u8,
    pub(crate) label:            &'static str,
}

/// Score a candidate model file against a hardware profile.
///
/// Weighting: VRAM headroom 40 + thermal 20 + historical WES 20 (neutral 10
/// when unknown) + capacity utilization 20. NOTE: capacity utilization
/// revisits the same VRAM dimension as the headroom score (memory is
/// effectively 60 of the 100 points) — a deliberate weighting choice, not a
/// power measurement; replace with a watts-based signal when one exists per
/// candidate model.
pub(crate) fn fit_components(
    file_size_bytes: u64,
    vram_mb: u64,
    thermal_state: &str,
    historical_wes: Option<f32>,
) -> FitComponents {
    let vram_required = estimate_vram_mb(file_size_bytes);
    let headroom_pct = if vram_mb > 0 {
        ((vram_mb as f32 - vram_required as f32) / vram_mb as f32 * 100.0).max(-100.0)
    } else { -100.0 };

    // ── VRAM headroom (40 points) — top score reserved for 75%+ ───────────
    let vram_score: u8 = if headroom_pct >= 75.0 { 40 }
        else if headroom_pct >= 60.0 { 36 }
        else if headroom_pct >= 45.0 { 32 }
        else if headroom_pct >= 30.0 { 26 }
        else if headroom_pct >= 15.0 { 20 }
        else if headroom_pct >= 5.0  { 12 }
        else if headroom_pct >= 0.0  { 6 }
        else { 0 };

    // ── Thermal margin (20 points) ────────────────────────────────────────
    let thermal_score: u8 = match thermal_state {
        "Normal"  => 20,
        "Fair"    => 10,
        "Serious" => 5,
        _ => 0,
    };

    // ── Historical WES (20 points; 10 = neutral, no data) ─────────────────
    let wes_score: u8 = match historical_wes {
        Some(w) if w > 10.0 => 20,
        Some(w) if w > 3.0  => 15,
        Some(w) if w > 1.0  => 10,
        Some(_)             => 5,
        None                => 10,
    };

    // ── Capacity utilization (20 points) ──────────────────────────────────
    let vram_fraction = vram_required as f32 / vram_mb.max(1) as f32;
    let power_score: u8 = if vram_fraction < 0.2 { 20 }
        else if vram_fraction < 0.35 { 16 }
        else if vram_fraction < 0.5  { 12 }
        else if vram_fraction < 0.7  { 8 }
        else if vram_fraction < 0.9  { 5 }
        else { 2 };

    // Hard gate: a model the node literally cannot load scores 0 no matter
    // how healthy the thermals are.
    let (total, label) = if vram_required > vram_mb {
        (0, "Won't Fit")
    } else {
        let t = vram_score + thermal_score + wes_score + power_score;
        let l = if t >= 80 { "Excellent" }
            else if t >= 60 { "Good" }
            else if t >= 40 { "Tight" }
            else { "Marginal" };
        (t, l)
    };

    FitComponents {
        vram_required_mb: vram_required,
        headroom_pct,
        vram_score,
        thermal_score,
        wes_score,
        power_score,
        total,
        label,
    }
}

#[cfg(test)]
mod shared_scoring_tests {
    use super::*;

    const PARAMS_8B: Option<f32> = Some(8.03);

    #[test]
    fn plausibility_accepts_real_gguf_sizes() {
        // Published Llama 3.1 8B file sizes must pass — regression test for
        // the bits-vs-bytes error that rejected every well-formed variant.
        assert!(is_plausible_size_for_quant(PARAMS_8B, "Q2_K",   3_180_000_000));
        assert!(is_plausible_size_for_quant(PARAMS_8B, "Q4_K_M", 4_920_000_000));
        assert!(is_plausible_size_for_quant(PARAMS_8B, "Q6_K",   6_600_000_000));
        assert!(is_plausible_size_for_quant(PARAMS_8B, "Q8_0",   8_540_000_000));
        assert!(is_plausible_size_for_quant(PARAMS_8B, "F16",   16_070_000_000));
        assert!(is_plausible_size_for_quant(Some(70.6), "Q4_K_M", 42_500_000_000));
    }

    #[test]
    fn plausibility_rejects_auxiliary_and_mislabeled_files() {
        // The classic: "F32 · 1.7 GB" on a 27B model (real F32 ≈ 108 GB).
        assert!(!is_plausible_size_for_quant(Some(27.0), "F32", 1_700_000_000));
        assert!(!is_plausible_size_for_quant(PARAMS_8B, "Q4_K_M", 100_000_000));
        // Double-counted shards: > 200% of expected.
        assert!(!is_plausible_size_for_quant(PARAMS_8B, "Q4_K_M", 12_000_000_000));
    }

    #[test]
    fn plausibility_is_conservative_when_signals_missing() {
        assert!(is_plausible_size_for_quant(None, "Q4_K_M", 123));
        assert!(is_plausible_size_for_quant(PARAMS_8B, "unknown", 123));
    }

    #[test]
    fn bytes_per_param_is_bits_over_eight() {
        assert_eq!(bytes_per_param_for_quant("F16"), Some(2.0));
        assert_eq!(bytes_per_param_for_quant("F32"), Some(4.0));
        assert_eq!(bytes_per_param_for_quant("Q4_K_M"), Some(0.5625));
        assert_eq!(bytes_per_param_for_quant("Q8_0"), Some(1.125));
    }

    #[test]
    fn estimate_vram_adds_30pct_with_512mb_floor() {
        assert_eq!(estimate_vram_mb(7 * 1024 * 1024 * 1024), 7168 + 2150);
        assert_eq!(estimate_vram_mb(100 * 1024 * 1024), 100 + 512);
    }

    #[test]
    fn extract_params_handles_standard_and_moe_names() {
        assert_eq!(extract_params_b("Llama-3.2-3B-Instruct"), Some(3.0));
        assert_eq!(extract_params_b("Mixtral-8x7B-Instruct"), Some(56.0));
        assert_eq!(extract_params_b("deepseek-coder-6.7b"), Some(6.7));
        assert_eq!(extract_params_b("phi-3-mini"), None);
    }

    #[test]
    fn fit_components_canonical_values() {
        // Llama 3.1 8B Q4_K_M (4.92 GB) on a 24 GB GPU, Normal thermal, no
        // history: base 4692 MB → required 6099 MB → headroom 75.2% →
        // 40 + 20 + 10 + 16 = 86 "Excellent".
        let f = fit_components(4_920_000_000, 24_576, "Normal", None);
        assert_eq!(f.total, 86);
        assert_eq!(f.label, "Excellent");
    }

    #[test]
    fn wont_fit_hard_gates_to_zero() {
        // 16 GB F16 on an 8 GB GPU: previously the agent summed the other
        // components (thermal 20 + wes 10 + power 2 = 32) for a model the
        // node cannot load.
        let f = fit_components(16_070_000_000, 8_192, "Normal", None);
        assert_eq!(f.total, 0);
        assert_eq!(f.label, "Won't Fit");
    }
}
