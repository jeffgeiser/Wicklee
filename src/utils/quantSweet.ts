/**
 * Quant Sweet Spot — bandwidth-aware quantization recommendation.
 *
 * Answers: "Given my hardware and the model currently loaded, am I running
 * the right quantization level?"
 *
 * ── Core principle ────────────────────────────────────────────────────────────
 *
 * Local LLM inference (single request, small batch) is memory-bandwidth bound.
 * Throughput scales approximately as:
 *
 *   tok/s ∝ bandwidth / model_size_in_memory
 *
 * So going from Q4_K_M → Q6_K (~+37% model size) costs roughly 25–30% tok/s.
 * The bandwidth lookup provides context ("your chip does X GB/s") but the
 * speed estimate is anchored to observed tok/s, not theoretical bandwidth,
 * for accuracy:
 *
 *   estimated_tps_new = observed_tps × (current_model_gb / new_model_gb)
 *
 * ── What we never recommend ───────────────────────────────────────────────────
 *
 * - "Your chip has high bandwidth, run Q8" — Q8 is ~67% larger than Q4_K_M,
 *   meaning ~40% slower tok/s. That's rarely worth it vs Q6_K.
 * - Upgrades that don't fit in available headroom.
 * - Upgrades when the user is already at Q5/Q6 (already near-lossless).
 *
 * ── Quality delta reference (perplexity, LLaMA-family consensus benchmarks) ──
 *
 *   Q2 vs F16:  ~15–25% perplexity increase — severe degradation
 *   Q3 vs F16:  ~5–10% perplexity increase  — noticeable degradation
 *   Q4 vs F16:  ~1–3%  perplexity increase  — acceptable for most tasks
 *   Q5 vs F16:  ~0.5–1% — near-lossless
 *   Q6 vs F16:  ~0.1–0.5% — near-lossless
 *   Q8 vs F16:  ~0.01–0.1% — effectively lossless
 *
 * Sources:
 *   - llama.cpp perplexity benchmarks: https://github.com/ggerganov/llama.cpp/discussions/406
 *   - Hugging Face GGUF wiki: https://huggingface.co/docs/hub/gguf
 */

import type { SentinelMetrics } from '../types';
import { lookupPerplexity, QUALITY_BAND_LABEL } from './perplexity';
import { quantCompressionRatio } from './quantSize';
import { chipBandwidthGBs } from './chipBandwidth';

// ── Chip bandwidth lookup ──────────────────────────────────────────────────────

/**
 * Memory bandwidth in GB/s for the node's chip.
 * Used for display context only ("your M4 Max — 546 GB/s").
 * The speed estimate uses observed tok/s, not this value, for accuracy.
 *
 * Delegates to the canonical table in chipBandwidth.ts — this file used to
 * carry its own copy, which drifted (M3 Max 300 vs 400, RTX 4080 736 vs
 * 717, missing 50-series) so the Sweet Spot card and the discovery
 * estimator quoted different bandwidths for the same node.
 */
export function chipBandwidthGbs(node: SentinelMetrics): number | null {
  return chipBandwidthGBs(node.chip_name ?? node.gpu_name ?? null);
}

// ── Quant compression ratios ──────────────────────────────────────────────────

/**
 * VRAM footprint relative to FP16 baseline, derived from the canonical
 * `bytesPerWeight()` table in quantSize.ts (ratio = bpw / 2.0) so the fit
 * card, the sweet-spot card, and the agent all agree on size math.
 * Unknown families fall back to 0.5 (mid-range).
 */
function compressionRatio(family: string): number {
  return quantCompressionRatio(family) ?? 0.5;
}

/**
 * Conservative perplexity delta vs FP16 (heuristic fallback).
 *
 * Used only when the empirical Perplexity Tax baseline data is unavailable
 * (e.g. JSON failed to load, or the model + quant pair has no entry).
 * Successful lookups via `lookupPerplexity()` produce sharper per-family
 * strings; this fallback is a floor.
 */
const QUALITY_DELTA: Record<string, string> = {
  Q2: '15–25% perplexity increase vs FP16 — severe degradation',
  Q3: '5–10% perplexity increase vs FP16 — noticeable degradation',
  Q4: '~1–3% perplexity increase vs FP16 — acceptable for most tasks',
  Q5: '~0.5–1% vs FP16 — near-lossless',
  Q6: '~0.1–0.5% vs FP16 — near-lossless',
  Q8: '<0.1% vs FP16 — effectively lossless',
  F16: 'Full FP16 precision — maximum quality',
};

/**
 * Empirical quality-delta string — overrides the QUALITY_DELTA heuristic
 * when a perplexity baseline entry exists for this (model, quant) pair.
 *
 * Falls back to QUALITY_DELTA when no entry is available. Returns the
 * empirical value with the band label, e.g.
 *   "+0.4% perplexity vs FP16 (KLD 0.0034) — Imperceptible"
 *
 * The (model, quant) pair is the *target* we want to describe — not always
 * the currently-loaded one. e.g. when recommending Q6 from Q4, we want to
 * describe Q6 quality in this family.
 */
function qualityDeltaFor(modelName: string | null, quant: string | null, family: string): string {
  if (modelName && quant) {
    const cost = lookupPerplexity(modelName, quant);
    if (cost) {
      const band = QUALITY_BAND_LABEL[cost.band];
      const ppl  = cost.pplDeltaPct === 0
        ? 'lossless'
        : cost.pplDeltaPct < 0.1
        ? `<0.1% perplexity vs FP16`
        : `+${cost.pplDeltaPct.toFixed(cost.pplDeltaPct < 1 ? 2 : 1)}% perplexity vs FP16`;
      const familyTag = cost.isExactFamily ? '' : ' (generic baseline)';
      return `${ppl} (KLD ${cost.kld.toExponential(1)}) — ${band}${familyTag}`;
    }
  }
  return QUALITY_DELTA[family] ?? '';
}

/**
 * Map a quant *family* (Q4) to its most common quant *variant* (Q4_K_M).
 * Used to look up empirical perplexity data when only the family is known.
 */
function representativeQuantForFamily(family: string): string {
  switch (family) {
    case 'Q2': return 'Q2_K';
    case 'Q3': return 'Q3_K_M';
    case 'Q4': return 'Q4_K_M';
    case 'Q5': return 'Q5_K_M';
    case 'Q6': return 'Q6_K';
    case 'Q8': return 'Q8_0';
    case 'F16': return 'F16';
    case 'F32': return 'F32';
    default: return family;
  }
}

/** Active model name extractor — used for the empirical perplexity lookup. */
function activeModelName(node: SentinelMetrics): string | null {
  return node.ollama_active_model
      ?? node.vllm_model_name
      ?? node.llamacpp_model_name
      ?? null;
}

// ── Recommendation output ─────────────────────────────────────────────────────

export type RecommendationKind =
  | 'upgrade'      // strong: Q2/Q3 → Q4
  | 'consider'     // optional: Q4 → Q6_K if headroom allows
  | 'sweet-spot'   // already optimal: Q5/Q6
  | 'downgrade'    // headroom is tight: consider dropping one level
  | 'lossless'     // Q8/F16 — good quality, check context tradeoff
  | 'none';        // not enough data to recommend

export interface QuantRecommendation {
  kind:            RecommendationKind;
  currentFamily:   string;
  targetFamily:    string | null;
  /** Estimated model size at target quant (GB). Null when target is null. */
  targetSizeGb:    number | null;
  /** How much VRAM the upgrade/downgrade adds or frees (+/−). Null when N/A. */
  vramDeltaGb:     number | null;
  /** Whether the target quant fits in available headroom. */
  targetFits:      boolean | null;
  /** Estimated tok/s at target quant, scaled from observed. Null when no observed tok/s. */
  estimatedTps:    number | null;
  /** Observed tok/s at current quant (for comparison). */
  currentTps:      number | null;
  /** Chip bandwidth for display context. Null when chip is unknown. */
  bandwidthGbs:    number | null;
  /** Quality delta string for the target quant. */
  targetQuality:   string | null;
  /** Current quant quality string. */
  currentQuality:  string;
  /** One-sentence headline. */
  headline:        string;
  /** Supporting detail (1–2 sentences). */
  detail:          string;
}

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Compute quantization sweet spot recommendation for a node's current model.
 *
 * @param currentFamily  Quant family string: 'Q4', 'Q6', 'F16', etc.
 * @param modelSizeGb    Observed model size in GB (from Ollama /api/ps).
 * @param headroomGb     Available memory headroom after model load.
 * @param observedTps    Current tok/s from probe (null if idle).
 * @param node           SentinelMetrics for chip name lookup.
 * @param totalGb        Total memory capacity (VRAM or unified) in GB. When
 *                       provided, upgrade recommendations reserve 10% of it
 *                       so a "fits" verdict can't land the node in the
 *                       Poor band (<10% headroom) of computeModelFitScore.
 */
export function computeQuantRecommendation(
  currentFamily: string,
  modelSizeGb:   number,
  headroomGb:    number,
  observedTps:   number | null,
  node:          SentinelMetrics,
  totalGb:       number | null = null,
): QuantRecommendation {
  const bw             = chipBandwidthGbs(node);
  const currentRatio   = compressionRatio(currentFamily);
  const modelName      = activeModelName(node);
  const currentQuality = qualityDeltaFor(modelName, representativeQuantForFamily(currentFamily), currentFamily);
  const qFor = (family: string) => qualityDeltaFor(modelName, representativeQuantForFamily(family), family);

  // Estimate FP16 baseline size from observed model size + current quant ratio.
  // This anchors all subsequent size estimates to the actual loaded model.
  const fp16Gb = modelSizeGb / currentRatio;

  function sizeAt(family: string): number {
    return fp16Gb * compressionRatio(family);
  }

  function estTps(targetSizeGb: number): number | null {
    if (observedTps == null || observedTps <= 0 || modelSizeGb <= 0) return null;
    // Scale observed throughput by inverse size ratio (bandwidth-bound assumption).
    return observedTps * (modelSizeGb / targetSizeGb);
  }

  function fits(targetSizeGb: number): boolean {
    // Target fits if the additional VRAM it needs is within headroom, minus
    // a reserve of 10% of total capacity — recommending an upgrade that
    // consumes all headroom would push the node straight into the Poor
    // band of computeModelFitScore (<10% free).
    const delta   = targetSizeGb - modelSizeGb;
    const reserve = totalGb != null ? totalGb * 0.10 : 0;
    return delta <= headroomGb - reserve;
  }

  const base: Pick<QuantRecommendation, 'currentFamily' | 'currentTps' | 'bandwidthGbs' | 'currentQuality'> = {
    currentFamily,
    currentTps:   observedTps,
    bandwidthGbs: bw,
    currentQuality,
  };

  // ── Q2 / Q3: strong upgrade recommendation ───────────────────────────────
  if (currentFamily === 'Q2' || currentFamily === 'Q3') {
    const targetFamily = 'Q4';
    const targetSizeGb = sizeAt(targetFamily);
    const targetFits   = fits(targetSizeGb);
    const vramDelta    = targetSizeGb - modelSizeGb;
    const eTps         = estTps(targetSizeGb);

    return {
      ...base,
      kind:          'upgrade',
      targetFamily,
      targetSizeGb,
      vramDeltaGb:   vramDelta,
      targetFits,
      estimatedTps:  eTps,
      targetQuality: qFor(targetFamily),
      headline:      `Quality is significantly degraded at ${currentFamily}.`,
      detail: targetFits
        ? `Upgrading to Q4_K_M (~${targetSizeGb.toFixed(1)} GB, +${vramDelta.toFixed(1)} GB) fits within headroom${eTps != null ? ` at ~${eTps.toFixed(0)} tok/s` : ''}. Strongly recommended.`
        : `Q4_K_M would need ~${targetSizeGb.toFixed(1)} GB (+${vramDelta.toFixed(1)} GB), exceeding available headroom. Free memory or use a smaller model variant.`,
    };
  }

  // ── Q4: consider Q6 upgrade if headroom allows ───────────────────────────
  if (currentFamily === 'Q4') {
    const targetFamily = 'Q6';
    const targetSizeGb = sizeAt(targetFamily);
    const targetFits   = fits(targetSizeGb);
    const vramDelta    = targetSizeGb - modelSizeGb;
    const eTps         = estTps(targetSizeGb);

    if (targetFits) {
      const tpsNote = eTps != null && observedTps != null
        ? ` Speed estimate: ~${eTps.toFixed(0)} tok/s (from ${observedTps.toFixed(0)} tok/s at ${currentFamily}).`
        : '';
      const bwNote = bw != null ? ` ${node.chip_name ?? node.gpu_name ?? 'This chip'} (${bw.toLocaleString()} GB/s).` : '';
      return {
        ...base,
        kind:          'consider',
        targetFamily,
        targetSizeGb,
        vramDeltaGb:   vramDelta,
        targetFits,
        estimatedTps:  eTps,
        targetQuality: qFor(targetFamily),
        headline:      `Q6_K fits in headroom (+${vramDelta.toFixed(1)} GB) with near-lossless quality.`,
        detail:        `${qFor(targetFamily)}.${tpsNote}${bwNote} Worth considering if output quality matters more than maximum throughput.`,
      };
    }

    // Doesn't fit — Q4 is the right choice for this headroom
    return {
      ...base,
      kind:          'sweet-spot',
      targetFamily:  null,
      targetSizeGb:  null,
      vramDeltaGb:   null,
      targetFits:    false,
      estimatedTps:  null,
      targetQuality: null,
      headline:      `Q4_K_M is the right choice for this headroom.`,
      detail:        `Q6_K would need ~${targetSizeGb.toFixed(1)} GB (+${vramDelta.toFixed(1)} GB beyond the ${headroomGb.toFixed(1)} GB available). ${qFor('Q4')}.`,
    };
  }

  // ── Q5 / Q6: already near-lossless ──────────────────────────────────────
  if (currentFamily === 'Q5' || currentFamily === 'Q6') {
    // Suggest downgrade to Q4 only if headroom is very tight (<10% of total).
    // Tight headroom check: if more than 80% of available headroom is used by
    // the model, context runway will suffer.
    const q4SizeGb   = sizeAt('Q4');
    const vramFreed  = modelSizeGb - q4SizeGb;
    const headroomTight = headroomGb < 2.0;

    if (headroomTight && vramFreed > 0.5) {
      return {
        ...base,
        kind:          'downgrade',
        targetFamily:  'Q4',
        targetSizeGb:  q4SizeGb,
        vramDeltaGb:   -vramFreed,
        targetFits:    true,
        estimatedTps:  estTps(q4SizeGb),
        targetQuality: qFor('Q4'),
        headline:      `Headroom is tight. Q4_K_M frees ~${vramFreed.toFixed(1)} GB for longer contexts.`,
        detail:        `${currentFamily} quality (${qFor(currentFamily)}). Dropping to Q4_K_M trades ~2% perplexity for ${vramFreed.toFixed(1)} GB more KV cache room.`,
      };
    }

    return {
      ...base,
      kind:          'sweet-spot',
      targetFamily:  null,
      targetSizeGb:  null,
      vramDeltaGb:   null,
      targetFits:    null,
      estimatedTps:  null,
      targetQuality: null,
      headline:      `${currentFamily} is the sweet spot for quality on this hardware.`,
      detail:        `${qFor(currentFamily)}. No upgrade needed — you're in the near-lossless range.`,
    };
  }

  // ── Q8 / F16: lossless — check if context headroom trade is worth it ─────
  if (currentFamily === 'Q8' || currentFamily === 'F16') {
    const targetFamily = currentFamily === 'F16' ? 'Q8' : 'Q6';
    const targetSizeGb = sizeAt(targetFamily);
    const vramFreed    = modelSizeGb - targetSizeGb;
    const headroomTight = headroomGb < 3.0;

    if (headroomTight && vramFreed > 1.0) {
      const eTps = estTps(targetSizeGb); // will be faster, so ratio > 1
      return {
        ...base,
        kind:          'downgrade',
        targetFamily,
        targetSizeGb,
        vramDeltaGb:   -vramFreed,
        targetFits:    true,
        estimatedTps:  eTps,
        targetQuality: qFor(targetFamily),
        headline:      `${targetFamily} frees ~${vramFreed.toFixed(1)} GB${eTps != null && observedTps != null ? ` and gains ~${((eTps / observedTps - 1) * 100).toFixed(0)}% tok/s` : ''} with minimal quality loss.`,
        detail:        `${qFor(targetFamily)}. Current ${currentFamily} maximizes quality but limits context runway. ${targetFamily} is near-lossless and frees headroom.`,
      };
    }

    return {
      ...base,
      kind:          'lossless',
      targetFamily:  null,
      targetSizeGb:  null,
      vramDeltaGb:   null,
      targetFits:    null,
      estimatedTps:  null,
      targetQuality: null,
      headline:      `${currentFamily} — maximum quality, no action needed.`,
      detail:        `${qFor(currentFamily)}. Headroom is healthy — no reason to drop quant.`,
    };
  }

  // ── Unknown quant family ─────────────────────────────────────────────────
  return {
    ...base,
    kind:          'none',
    targetFamily:  null,
    targetSizeGb:  null,
    vramDeltaGb:   null,
    targetFits:    null,
    estimatedTps:  null,
    targetQuality: null,
    headline:      'Quantization level unknown.',
    detail:        'Cannot determine quant from model name or metadata.',
  };
}
