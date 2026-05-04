/**
 * KV Cache estimation for transformer models.
 *
 * Answers: "How much memory does the KV cache consume at a given context length?"
 * Used to project a model's Context Runway — how far it can think before VRAM
 * headroom runs out and swapping begins.
 *
 * ── Formula ──────────────────────────────────────────────────────────────────
 *
 *   KV cache bytes = 2 × layers × kv_heads × head_dim × ctx_tokens × bytes_per_element
 *
 *   Where:
 *     2            = one K tensor + one V tensor per layer
 *     layers       = llama.block_count (transformer depth)
 *     kv_heads     = llama.attention.head_count_kv
 *                    For GQA models (Llama 3, Mistral, Phi): kv_heads << num_heads
 *                    For MHA models (GPT-2 era): kv_heads == num_heads
 *     head_dim     = llama.embedding_length / llama.attention.head_count
 *                    (derived; typically 64, 128, or 256)
 *     ctx_tokens   = context window length in tokens
 *     bytes_per_el = 2 (FP16) — Ollama uses FP16 for KV cache by default
 *
 * ── GQA accuracy note ────────────────────────────────────────────────────────
 *
 *   Using kv_heads instead of num_heads is critical for GQA models:
 *   - Llama 3.2 3B:  32 total heads, 8 KV heads → 4× smaller KV cache than MHA
 *   - Llama 3.1 70B: 64 total heads, 8 KV heads → 8× smaller KV cache than MHA
 *   Mis-using num_heads here would predict the KV cache as 4–8× too large.
 *
 * ── Fallback estimation ───────────────────────────────────────────────────────
 *
 *   When architecture fields are absent (vLLM, llama.cpp, or pre-v0.8 Ollama),
 *   we estimate from parameter count using common architecture patterns.
 *   These estimates carry ±30% uncertainty — they should trigger a "~" prefix.
 *
 * References:
 *   - Llama architecture: https://github.com/facebookresearch/llama
 *   - GGUF spec: https://github.com/ggerganov/llama.cpp/blob/master/docs/development/gguf.md
 *   - GQA paper: Ainslie et al. 2023 https://arxiv.org/abs/2305.13245
 */

import type { SentinelMetrics } from '../types';

// Context milestones shown in the Context Runway UI.
// These cover the practical range of local inference use cases.
export const CTX_MILESTONES = [4_096, 16_384, 32_768, 65_536, 131_072] as const;
export type CtxMilestone = typeof CTX_MILESTONES[number];

export interface KVArchitecture {
  layers:     number;
  kvHeads:    number;
  headDim:    number;
  maxCtx:     number;
  /** True when derived from /api/show exact fields; false = parameter-count estimate. */
  isExact:    boolean;
}

export interface CtxRunwayPoint {
  tokens:    number;
  kvBytes:   number;
  kvGb:      number;
  /** Ratio of KV cache size to available headroom (0–∞; >1 means won't fit). */
  headroomRatio: number;
  fits:      boolean;
}

export interface ContextRunway {
  arch:         KVArchitecture;
  headroomGb:   number;
  /** KV cache size at each CTX_MILESTONES value. */
  points:       CtxRunwayPoint[];
  /** Largest milestone that fits within headroom, or null if even 4k is too tight. */
  maxFitsCtx:   number | null;
  /** Plain-English summary line. */
  summary:      string;
}

// ── Architecture extraction ───────────────────────────────────────────────────

/**
 * Derive KV cache architecture from /api/show fields when available.
 * Returns null when the required fields are absent.
 *
 * head_dim = embedding_dim / num_heads (not embedding_dim / kv_heads).
 * The attention head dimension is fixed by the total head count, not KV heads.
 */
function archFromPayload(node: SentinelMetrics): KVArchitecture | null {
  const layers    = node.ollama_num_layers    ?? null;
  const kvHeads   = node.ollama_kv_heads      ?? null;
  const numHeads  = node.ollama_num_heads     ?? null;
  const embedDim  = node.ollama_embedding_dim ?? null;
  const maxCtx    = node.ollama_context_length ?? null;

  if (layers == null || kvHeads == null || numHeads == null || embedDim == null) return null;
  if (numHeads === 0) return null;

  const headDim = Math.round(embedDim / numHeads);
  if (headDim === 0) return null;

  return {
    layers,
    kvHeads,
    headDim,
    maxCtx: maxCtx ?? 8_192, // conservative fallback; most models at least 8k
    isExact: true,
  };
}

/**
 * Parse a parameter-count hint out of a model name string.
 *
 * Handles common patterns:
 *   "qwen2.5-32b"               → 32_000_000_000
 *   "Llama-3.1-8B-Instruct"     → 8_000_000_000
 *   "phi-3-mini"                → null  (no numeric tag)
 *   "Mixtral-8x7B-Instruct"     → 56_000_000_000  (8×7 expert MoE — total params)
 *   "deepseek-coder-6.7b"       → 6_700_000_000
 *
 * Used as a fallback path for vLLM and llama.cpp models where the agent does
 * not run the Ollama /api/show enrichment that populates parameter_count.
 * Returns null when no plausible size token is found.
 */
export function parseParamCountFromModelName(name: string | null | undefined): number | null {
  if (!name) return null;
  const lower = name.toLowerCase();

  // Mixtral-style "8x7b" / "16x17b" — sum of expert params.
  const moe = lower.match(/(\d+)x(\d+(?:\.\d+)?)b\b/);
  if (moe) {
    const experts = parseInt(moe[1], 10);
    const perExpert = parseFloat(moe[2]);
    if (experts > 0 && perExpert > 0) return Math.round(experts * perExpert * 1e9);
  }

  // Standard "<num>b" or "<num>B" tag — e.g. 8b, 70B, 6.7b, 32b.
  const std = lower.match(/(?:^|[^a-z0-9])(\d+(?:\.\d+)?)\s*b\b/);
  if (std) {
    const b = parseFloat(std[1]);
    if (b > 0 && b < 10_000) return Math.round(b * 1e9);
  }
  return null;
}

/**
 * Estimate architecture from parameter count when /api/show fields are absent.
 *
 * Patterns use common open-weight architectures (Llama 3, Mistral, Phi).
 * GQA ratios are representative — actual values vary by model family.
 * Estimates carry ±30% uncertainty.
 *
 * When ollama_parameter_count is null (vLLM, llama.cpp), falls back to
 * parsing the active model name for a "<n>b" tag.
 */
function archFromParamCount(node: SentinelMetrics): KVArchitecture | null {
  let params = node.ollama_parameter_count ?? null;
  // Prefer the real value: Ollama /api/show → vLLM /v1/models → 8 192 floor.
  const maxCtx = node.ollama_context_length
              ?? node.vllm_max_model_len
              ?? 8_192;

  // Fallback: parse the model name. Works for vLLM ("qwen2.5-32b") and
  // llama.cpp where parameter_count is not populated.
  if (params == null) {
    const name =
      node.ollama_active_model
      ?? node.vllm_model_name
      ?? node.llamacpp_model_name
      ?? null;
    params = parseParamCountFromModelName(name);
  }
  if (params == null) return null;

  const b = params / 1e9; // parameter count in billions

  // Pattern table: [minB, maxB, layers, kvHeads, headDim]
  // GQA values from Llama 3 architecture variants.
  const patterns: [number, number, number, number, number][] = [
    [0,    2,   22, 8,  64],  // ~1B  (Llama 3.2 1B: 16 layers, 8 KV, h=64)
    [2,    4.5, 28, 8, 128],  // ~3B  (Llama 3.2 3B: 28 layers, 8 KV, h=128)
    [4.5,  9,   32, 8, 128],  // ~7B  (Llama 3.1 8B: 32 layers, 8 KV, h=128)
    [9,   18,   40, 8, 128],  // ~13B (Llama 3 13B-ish)
    [18,  40,   48, 8, 128],  // ~30B
    [40,  80,   80, 8, 128],  // ~70B (Llama 3.1 70B: 80 layers, 8 KV, h=128)
    [80, Infinity, 96, 8, 128], // 100B+
  ];

  for (const [min, max, layers, kvHeads, headDim] of patterns) {
    if (b >= min && b < max) {
      return { layers, kvHeads, headDim, maxCtx, isExact: false };
    }
  }
  return null;
}

// ── Core calculation ──────────────────────────────────────────────────────────

/**
 * KV cache size in bytes for a given architecture at a given context length.
 *
 * Assumes FP16 KV cache (2 bytes/element) — the Ollama default.
 * The factor of 2 accounts for one K tensor + one V tensor per layer.
 */
function kvCacheBytes(arch: KVArchitecture, ctxTokens: number): number {
  return 2 * arch.layers * arch.kvHeads * arch.headDim * ctxTokens * 2;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute the Context Runway for a node's current model.
 *
 * Returns null when:
 *   - No model is loaded (no Ollama model)
 *   - Architecture cannot be determined (no /api/show data AND no param count)
 *   - headroomGb is zero or negative (can't project meaningfully)
 */
export function computeContextRunway(
  node: SentinelMetrics,
  headroomGb: number,
): ContextRunway | null {
  if (!node.ollama_active_model) return null;
  if (headroomGb <= 0) return null;

  const arch = archFromPayload(node) ?? archFromParamCount(node);
  if (!arch) return null;

  const headroomBytes = headroomGb * 1024 * 1024 * 1024;

  // Compute KV cache at each milestone AND at the model's max context.
  const milestones = [
    ...CTX_MILESTONES.filter(m => m <= arch.maxCtx),
    // Include the model's actual max context if it's not already a milestone.
    ...(CTX_MILESTONES.includes(arch.maxCtx as CtxMilestone) ? [] : [arch.maxCtx]),
  ].sort((a, b) => a - b);

  const points: CtxRunwayPoint[] = milestones.map(tokens => {
    const kvBytes = kvCacheBytes(arch, tokens);
    const kvGb    = kvBytes / (1024 ** 3);
    const headroomRatio = kvBytes / headroomBytes;
    return { tokens, kvBytes, kvGb, headroomRatio, fits: headroomRatio <= 1.0 };
  });

  const fittingPoints = points.filter(p => p.fits);
  const maxFitsCtx    = fittingPoints.length > 0
    ? fittingPoints[fittingPoints.length - 1].tokens
    : null;

  const summary = buildSummary(arch, points, maxFitsCtx, headroomGb);

  return { arch, headroomGb, points, maxFitsCtx, summary };
}

function buildSummary(
  arch: KVArchitecture,
  points: CtxRunwayPoint[],
  maxFitsCtx: number | null,
  headroomGb: number,
): string {
  const approx = arch.isExact ? '' : '~';

  if (maxFitsCtx === null) {
    const smallest = points[0];
    return `Even at ${fmtCtx(smallest.tokens)}, the KV cache (${approx}${fmtKvSize(smallest.kvGb)}) exceeds the ${fmtKvSize(headroomGb)} available. Swapping likely under any extended context.`;
  }

  const maxPoint = points.find(p => p.tokens === maxFitsCtx)!;

  if (maxFitsCtx >= arch.maxCtx) {
    return `Full ${fmtCtx(arch.maxCtx)} context fits in ${approx}${fmtKvSize(maxPoint.kvGb)} of KV cache. No context pressure expected.`;
  }

  const nextPoint = points.find(p => p.tokens > maxFitsCtx);
  const pressure  = nextPoint
    ? ` Beyond ${fmtCtx(maxFitsCtx)}, KV cache reaches ${approx}${fmtKvSize(nextPoint.kvGb)} — exceeding ${fmtKvSize(headroomGb)} headroom.`
    : '';

  return `Comfortable up to ${fmtCtx(maxFitsCtx)} context (${approx}${fmtKvSize(maxPoint.kvGb)} KV cache).${pressure}`;
}

/** Format token count as "4k", "32k", "128k". */
export function fmtCtx(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
  if (tokens >= 1_000)     return `${(tokens / 1_000).toFixed(0)}k`;
  return `${tokens}`;
}

/**
 * Format a KV cache size.
 * Uses MB for values under 0.1 GB so "0.0 GB" never appears.
 */
export function fmtKvSize(gb: number): string {
  if (gb < 0.1) return `${Math.round(gb * 1024)} MB`;
  return `${gb.toFixed(1)} GB`;
}
