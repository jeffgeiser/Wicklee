/**
 * Quant quality reference table — community-derived rules of thumb for
 * GGUF quantization quality relative to F16. Used in the Model Discovery
 * UI to give users a hover hint on every variant's quant label.
 *
 * Values are intentionally conservative; perplexity varies by model
 * family, so these are "what most people see" approximations. See
 * `quantSweet.ts` for the empirical perplexity-based path used when
 * a model is actively running.
 */

export const QUANT_QUALITY: Record<string, string> = {
  'F16':    'Full precision. Original model quality. Largest file.',
  'F32':    'Full 32-bit precision. Reference quality. Usually overkill.',
  'BF16':   'Brain Float 16. Same quality as F16, slightly different range.',
  'Q8_0':   '~99% quality vs F16. Minimal degradation. Recommended when file size allows.',
  'Q6_K':   '~99% quality vs F16. Smaller than Q8 with negligible quality loss.',
  'Q5_K_M': '~98% quality. Good speed/quality balance.',
  'Q5_K_S': '~97% quality. Faster than Q5_K_M.',
  'Q5_0':   '~97% quality. Older quant scheme; Q5_K_M usually preferred.',
  'Q5_1':   '~97% quality. Older quant scheme; Q5_K_M usually preferred.',
  'Q4_K_M': '~97% quality. Standard sweet spot for most models.',
  'Q4_K_S': '~96% quality. Slightly faster than Q4_K_M.',
  'Q4_0':   '~95% quality. Older quant; Q4_K_M usually preferred.',
  'Q4_1':   '~95% quality. Older quant; Q4_K_M usually preferred.',
  'IQ4_NL': '~96% quality. iMatrix variant, better than Q4_0 at same size.',
  'IQ4_XS': '~96% quality. Smaller than Q4_K_M with similar quality.',
  'Q3_K_L': '~93% quality. Noticeable degradation under reasoning tasks.',
  'Q3_K_M': '~92% quality. Aggressive quantization; use for large models that won\'t fit otherwise.',
  'Q3_K_S': '~91% quality. Smallest of the K-quants; quality drops noticeably.',
  'IQ3_M':  '~92% quality. iMatrix Q3; better than plain Q3.',
  'IQ3_S':  '~91% quality. Smallest IQ3 variant.',
  'IQ3_XS': '~90% quality. Aggressive iMatrix Q3.',
  'IQ3_XXS':'~88% quality. Very aggressive; last resort.',
  'Q2_K':   '~85% quality. Significant degradation. Use only when nothing else fits.',
  'IQ2_M':  '~84% quality. iMatrix Q2.',
  'IQ2_S':  '~82% quality. iMatrix Q2, smaller variant.',
  'IQ2_XS': '~80% quality. Aggressive iMatrix Q2.',
  'IQ2_XXS':'~78% quality. Last-resort tiny quant.',
  'IQ1_M':  '~70% quality. Experimental ultra-low. Quality degradation is severe.',
  'IQ1_S':  '~65% quality. Experimental ultra-low. Often unusable.',
};

export function quantQualityHint(quant: string): string {
  return QUANT_QUALITY[quant.toUpperCase()] ?? `Quantization: ${quant}`;
}

/**
 * Sweet-spot quant per model size class. Returns the quant string
 * (e.g. "Q4_K_M") that's the typical recommendation for this size bucket.
 *
 * Caller should compare against each variant's `quant` field; if none
 * match, no Recommended badge should render (no fallback "next best").
 *
 * @param maxFileSizeMb  The largest variant file size for the model — a
 *                       proxy for the F16/unquantized size, giving model class.
 */
export function recommendedQuant(maxFileSizeMb: number): string {
  if (maxFileSizeMb < 2000)  return 'Q8_0';    // < 2 GB: tiny models, use high quality
  if (maxFileSizeMb < 5000)  return 'Q5_K_M';  // 2-5 GB: small-medium
  if (maxFileSizeMb < 15000) return 'Q4_K_M';  // 5-15 GB: standard sweet spot
  if (maxFileSizeMb < 50000) return 'Q4_K_M';  // 15-50 GB: still Q4_K_M
  return 'Q3_K_M';                              // 50+ GB: aggressive needed
}

// ── Quant family classification (for tok/s history matching) ─────────────────

/**
 * Map a quant string to a coarse "family" used when matching historical
 * models to a candidate variant. The grouping mirrors what users
 * intuitively treat as comparable speed buckets:
 *
 *   - "q4"  — Q4_*, IQ4_*, Q3_* (aggressive bucket, similar bandwidth)
 *   - "q5"  — Q5_*, Q6_*       (mid quality)
 *   - "q8"  — Q8_*, F16, BF16, F32 (high quality / lossless)
 *   - "low" — Q2_*, IQ2_*, IQ1_* (very aggressive)
 *   - null  — unknown / not classified
 */
export function quantFamily(quant: string): 'q4' | 'q5' | 'q8' | 'low' | null {
  const q = quant.toUpperCase();
  if (q.startsWith('Q8') || q === 'F16' || q === 'BF16' || q === 'F32' || q.startsWith('Q6')) return 'q8';
  if (q.startsWith('Q5')) return 'q5';
  if (q.startsWith('Q4') || q.startsWith('IQ4') || q.startsWith('Q3') || q.startsWith('IQ3')) return 'q4';
  if (q.startsWith('Q2') || q.startsWith('IQ2') || q.startsWith('IQ1')) return 'low';
  return null;
}

/**
 * Estimate the on-disk file size of a historical model from its name +
 * implied quant. Parses parameter count from common Ollama tags
 * (e.g. "llama3.2:3b", "qwen2.5-coder:7b-instruct", "phi3:14b").
 *
 * Returns size in MB. Returns null if no parameter count is detectable.
 *
 * Heuristic: file_size_mb ≈ params_billions × 1024 × quant_ratio
 * where quant_ratio is family-dependent. Without an explicit quant in
 * the name (most ollama models don't carry it), assumes Q4_K_M (0.45).
 */
export function estimateModelFileSizeMb(modelName: string): number | null {
  if (!modelName) return null;
  // Match "Nb" or "N.Mb" patterns case-insensitively, with optional dash/colon prefix.
  const m = modelName.toLowerCase().match(/(\d+(?:\.\d+)?)\s*b\b/);
  if (!m) return null;
  const params = parseFloat(m[1]);
  if (!isFinite(params) || params <= 0 || params > 1000) return null;

  // Detect explicit quant in the model name (rare on Ollama; common on HF).
  const qm = modelName.toUpperCase().match(/Q\d(?:_K_[MS]|_[01])?|F16|F32|BF16/);
  let ratio = 0.45; // Q4_K_M default
  if (qm) {
    const fam = quantFamily(qm[0]);
    if (fam === 'q8') ratio = 0.80;
    else if (fam === 'q5') ratio = 0.55;
    else if (fam === 'low') ratio = 0.30;
  }
  // FP16 baseline ≈ 2 bytes/param → params(B) × 2 GB. Then × ratio for quant.
  return params * 2 * 1024 * ratio;
}

/**
 * Parse the parameter count (in billions) from a model name / filename.
 * Matches the same "Nb" / "N.Mb" pattern as `estimateModelFileSizeMb` but
 * exposes only the param count so callers (e.g. KV cache estimation) can
 * key on model class.
 *
 * Returns null when no plausible billions tag is present.
 */
export function parseParameterCountB(name: string): number | null {
  if (!name) return null;
  const m = name.toLowerCase().match(/(\d+(?:\.\d+)?)\s*b\b/);
  if (!m) return null;
  const params = parseFloat(m[1]);
  if (!isFinite(params) || params <= 0 || params > 1000) return null;
  return params;
}

/**
 * Estimates additional KV cache memory (above model weights) for a given
 * parameter class and context length, in MB. Based on standard GQA-family
 * architectures (Llama 3, Qwen 2.5, Mistral, etc.). For non-GQA models
 * (older Llama 2 13B, Falcon-family, MPT) KV cache is ~5x larger but we
 * accept the underestimate — most modern GGUF models use GQA.
 *
 * Reference: KV cache MB ≈ 2 × layers × ctx × kv_heads × head_dim × bytes / 1MB
 */
export function estimateKvCacheMb(parameterCountB: number, contextLength: number): number {
  // KV per 1K context, derived from per-class architecture defaults.
  // Conservative bias: round up for borderline cases.
  let kvPer1KMb: number;
  if (parameterCountB < 2) kvPer1KMb = 8;     // 1-1.5B class
  else if (parameterCountB < 4) kvPer1KMb = 14;  // 2-3B class
  else if (parameterCountB < 10) kvPer1KMb = 16; // 7-8B class
  else if (parameterCountB < 20) kvPer1KMb = 24; // 13-14B class
  else if (parameterCountB < 40) kvPer1KMb = 32; // 30-34B class
  else if (parameterCountB < 80) kvPer1KMb = 42; // 70-72B class
  else kvPer1KMb = 56;                            // 100B+ class

  return Math.round((contextLength / 1024) * kvPer1KMb);
}

/**
 * Returns a model's recomputed VRAM requirement at a specific context length.
 * Adds activation/framework overhead (~15% of file size) plus a
 * context-specific KV cache estimate to the on-disk model size.
 *
 * Returns the recomputed total vram_required_mb.
 */
export function vramAtContext(
  fileSizeMb: number,
  parameterCountB: number,
  contextLength: number,
): number {
  const weightsAndOverhead = Math.round(fileSizeMb * 1.15);
  const kvCache = estimateKvCacheMb(parameterCountB, contextLength);
  return weightsAndOverhead + kvCache;
}

/**
 * Frontend-recomputed fit label for a candidate variant at a chosen context
 * length. Mirrors (loosely) the backend's `score_fit` headroom buckets so
 * the picker can show a fresh label without round-tripping the agent.
 */
export function fitLabelAtContext(
  vramRequiredMb: number,
  vramBudgetMb: number,
): { label: string; headroomPct: number; score: number } {
  if (vramBudgetMb <= 0) {
    return { label: "Unknown", headroomPct: 0, score: 0 };
  }
  const headroomPct = ((vramBudgetMb - vramRequiredMb) / vramBudgetMb) * 100;
  if (headroomPct < 0)  return { label: "Won't Fit", headroomPct, score: 0 };
  if (headroomPct < 15) return { label: 'Marginal',  headroomPct, score: 30 };
  if (headroomPct < 45) return { label: 'Tight',     headroomPct, score: 55 };
  if (headroomPct < 75) return { label: 'Good',      headroomPct, score: 70 };
  return { label: 'Excellent', headroomPct, score: 90 };
}

/** Context length options for the discovery picker (tokens). */
export const CONTEXT_LENGTH_OPTIONS = [2048, 4096, 8192, 16384, 32768, 131072] as const;
export const DEFAULT_CONTEXT_LENGTH = 8192;

/** Compact label for a context length (e.g. 8192 -> "8K", 131072 -> "128K"). */
export function contextLengthLabel(ctx: number): string {
  if (ctx >= 1024) {
    const k = ctx / 1024;
    return Number.isInteger(k) ? `${k}K` : `${k.toFixed(1)}K`;
  }
  return `${ctx}`;
}
