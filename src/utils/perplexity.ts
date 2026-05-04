/**
 * Perplexity Tax — empirical quality cost lookup.
 *
 * Replaces the hand-tuned `QUALITY_DELTA` strings in quantSweet.ts and the
 * coarse `quant_quality_factor` multiplier in cloud/main.rs with measured
 * KL-divergence and perplexity data sourced from Unsloth's Dynamic GGUF
 * benchmark publications and the llama.cpp perplexity discussions.
 *
 * Data lives in /perplexity_baseline.json (curated, versioned, ships as a
 * static asset). This module loads it once on first call, caches in memory,
 * and exposes a single `lookupPerplexity(model, quant)` function.
 *
 * The same JSON file is embedded into the cloud Rust binary via
 * `include_str!` so quant_quality_factor() can use the same data — single
 * source of truth across language boundaries.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface PerplexityEntry {
  /** KL divergence vs FP16 baseline (Wikitext-2). 0 = lossless. */
  kld:            number;
  /** Perplexity increase vs FP16, expressed as a percentage. */
  ppl_delta_pct:  number;
}

export interface PerplexityFamily {
  size_class: 'tiny' | 'small' | 'medium' | 'large';
  quants:     Record<string, PerplexityEntry>;
}

export interface PerplexityBaseline {
  version: string;
  source:  string;
  notes:   string;
  size_class_thresholds_b: Record<string, number>;
  families: Record<string, PerplexityFamily>;
}

/** Plain-English label keyed off KLD bands. */
export type QualityBand = 'imperceptible' | 'mild' | 'noticeable' | 'severe' | 'unusable';

export interface QualityCost {
  /** Empirical KL divergence vs FP16. */
  kld:           number;
  /** Empirical perplexity delta as a percentage. */
  pplDeltaPct:   number;
  /** Plain-English band label. */
  band:          QualityBand;
  /** True when the lookup hit an exact family match (not a fallback). */
  isExactFamily: boolean;
  /** Family that matched (e.g. "llama-3.1-8b" or "default"). */
  matchedFamily: string;
}

// ── Quality bands ──────────────────────────────────────────────────────────

/**
 * Map KL divergence to a human-readable quality band.
 *
 * Bands derived from llama.cpp community consensus on subjective quality
 * thresholds. KLD < 0.001 is the threshold below which output is empirically
 * indistinguishable from FP16 in blind A/B tests.
 */
export function qualityBandForKld(kld: number): QualityBand {
  if (kld < 0.001) return 'imperceptible';
  if (kld < 0.01)  return 'mild';
  if (kld < 0.05)  return 'noticeable';
  if (kld < 0.15)  return 'severe';
  return 'unusable';
}

export const QUALITY_BAND_LABEL: Record<QualityBand, string> = {
  imperceptible: 'Imperceptible',
  mild:          'Mild',
  noticeable:    'Noticeable',
  severe:        'Severe',
  unusable:      'Unusable',
};

export const QUALITY_BAND_TONE: Record<QualityBand, string> = {
  imperceptible: 'text-emerald-400',
  mild:          'text-green-300',
  noticeable:    'text-amber-400',
  severe:        'text-orange-400',
  unusable:      'text-red-400',
};

// ── Model-family normalisation ─────────────────────────────────────────────

/**
 * Map a free-form model name to a canonical family key.
 *
 * Examples:
 *   "Llama-3.1-8B-Instruct-Q4_K_M.gguf" → "llama-3.1-8b"
 *   "qwen2.5-32b-instruct"              → "qwen2.5-32b"
 *   "unsloth/Llama-3.2-3B-Instruct"     → "llama-3.2-3b"
 *   "Mixtral-8x7B-Instruct-v0.1"        → "mixtral-8x7b"
 *   "phi3:mini"                         → "phi-3-mini"
 *   "deepseek-r1-distill-llama-8b"      → "deepseek-r1-distill-llama-8b"
 *
 * Returns null when no family token can be extracted (caller should fall
 * back to the "default" family in the baseline data).
 */
export function normalizeModelFamily(name: string | null | undefined): string | null {
  if (!name) return null;
  // Strip any HF org prefix and any GGUF extension.
  const stripped = name.split('/').pop()!.replace(/\.gguf$/i, '');
  const lower = stripped.toLowerCase();

  // Special-case Phi (uses both "phi3:mini" and "phi-3-mini" forms).
  if (/phi[-_]?3[-_]?mini/i.test(lower) || /^phi3:mini/.test(lower))   return 'phi-3-mini';
  if (/phi[-_]?3[-_]?medium/i.test(lower))                              return 'phi-3-medium';
  if (/phi[-_]?3[-_]?small/i.test(lower))                               return 'phi-3-small';

  // DeepSeek-R1 distills carry the underlying model size.
  const dsr1 = lower.match(/deepseek-r1-distill-(llama|qwen)-(\d+(?:\.\d+)?)b/);
  if (dsr1) return `deepseek-r1-distill-${dsr1[1]}-${dsr1[2]}b`;

  // Mixtral MoE — preserve "8x7b" form.
  const mixtral = lower.match(/mixtral-(\d+x\d+(?:\.\d+)?)b/);
  if (mixtral) return `mixtral-${mixtral[1]}b`;

  // Generic "<family>-<version>-<size>b" pattern.
  const generic = lower.match(/(llama|qwen|mistral|gemma|deepseek|yi|cohere|phi)[-_]?(\d+(?:\.\d+)?)[-_]?(\d+(?:\.\d+)?)b/);
  if (generic) {
    const family  = generic[1];
    const version = generic[2];
    const size    = generic[3];
    return `${family}-${version}-${size}b`;
  }

  // Family + size only (e.g. "mistral-7b").
  const familySize = lower.match(/(llama|qwen|mistral|gemma|deepseek|yi|cohere|phi)[-_]?(\d+(?:\.\d+)?)b/);
  if (familySize) return `${familySize[1]}-${familySize[2]}b`;

  return null;
}

/**
 * Normalize a quant level string to the keys used in perplexity_baseline.json.
 *
 *   "Q4_K_M.gguf" → "Q4_K_M"
 *   "ud-iq2_m"    → "IQ2_M"   (Unsloth Ultra-Dense prefix stripped)
 *   "q4_k_m"      → "Q4_K_M"
 *   "fp16"        → "F16"
 *   "bf16"        → "BF16"
 */
export function normalizeQuant(quant: string | null | undefined): string | null {
  if (!quant) return null;
  let q = quant.toUpperCase().replace(/\.GGUF$/, '');
  if (q.startsWith('UD-')) q = q.slice(3);
  // FP16 and F16 are the same; canonicalise.
  if (q === 'FP16') q = 'F16';
  if (q === 'FP32') q = 'F32';
  return q;
}

// ── Data loader ────────────────────────────────────────────────────────────

let _cache: PerplexityBaseline | null = null;
let _loadingPromise: Promise<PerplexityBaseline | null> | null = null;

/**
 * Fetch the bundled perplexity baseline.
 *
 * Served as a static asset from the agent (RustEmbed) on localhost or from
 * Cloudflare Pages on wicklee.dev. Cached in module memory after first load.
 * Returns null if the fetch fails — callers should treat absent data as a
 * "no perplexity info available" signal and fall back to the existing
 * heuristic copy.
 */
export async function loadPerplexityBaseline(): Promise<PerplexityBaseline | null> {
  if (_cache) return _cache;
  if (_loadingPromise) return _loadingPromise;
  _loadingPromise = (async () => {
    try {
      const r = await fetch('/perplexity_baseline.json');
      if (!r.ok) return null;
      const data = await r.json() as PerplexityBaseline;
      _cache = data;
      return data;
    } catch {
      return null;
    } finally {
      _loadingPromise = null;
    }
  })();
  return _loadingPromise;
}

/** Synchronous accessor — returns null until loadPerplexityBaseline() resolves. */
export function getCachedPerplexityBaseline(): PerplexityBaseline | null {
  return _cache;
}

// ── Lookup ─────────────────────────────────────────────────────────────────

/**
 * Resolve quality cost for a given model + quant pair.
 *
 * Lookup order:
 *   1. Exact family match (e.g. "qwen2.5-32b")
 *   2. Default family (size-class fallback would require knowing param count;
 *      since we may not, "default" is curated for a small-model baseline that
 *      is conservative for larger models — i.e. it overstates the cost
 *      slightly rather than understating it).
 *
 * Returns null when neither the data is loaded yet nor the quant key is
 * present in the matched family.
 */
export function lookupPerplexity(
  modelName: string | null | undefined,
  quant:     string | null | undefined,
): QualityCost | null {
  const baseline = _cache;
  if (!baseline) return null;
  const family = normalizeModelFamily(modelName);
  const q      = normalizeQuant(quant);
  if (!q) return null;

  // Try exact family match.
  if (family && baseline.families[family]) {
    const entry = baseline.families[family].quants[q];
    if (entry) {
      return {
        kld:           entry.kld,
        pplDeltaPct:   entry.ppl_delta_pct,
        band:          qualityBandForKld(entry.kld),
        isExactFamily: true,
        matchedFamily: family,
      };
    }
  }

  // Fall back to default family.
  const def = baseline.families['default'];
  if (def) {
    const entry = def.quants[q];
    if (entry) {
      return {
        kld:           entry.kld,
        pplDeltaPct:   entry.ppl_delta_pct,
        band:          qualityBandForKld(entry.kld),
        isExactFamily: false,
        matchedFamily: 'default',
      };
    }
  }

  return null;
}

/**
 * Quality multiplier for use in fit-score calculations.  Replaces
 * `quant_quality_factor()` cloud-side and any equivalent client logic.
 *
 * Maps KLD → [0, 1]:
 *   KLD = 0     → 1.0   (no penalty)
 *   KLD = 0.15  → 0.0   (unusable)
 *   linear in between, clamped.
 *
 * Returns 1.0 when no perplexity data is available — never penalises a
 * model just because we lack benchmarks.
 */
export function qualityMultiplier(modelName: string | null, quant: string | null): number {
  const cost = lookupPerplexity(modelName, quant);
  if (!cost) return 1.0;
  return Math.max(0.0, Math.min(1.0, 1.0 - cost.kld / 0.15));
}
