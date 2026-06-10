/**
 * Quantization → bytes-per-weight + model-size estimation.
 *
 * Used as a fallback when the runtime doesn't report explicit model size.
 * Particularly needed for vLLM: it eagerly reserves ~90% of VRAM for KV
 * cache headroom, so `nvidia_vram_used_mb` overstates actual model size by
 * 3-4×.  Without this estimator, the Model Fit card scores Spark as "Poor"
 * for a 32GB FP8 model that's only consuming ~25% of its 128GB unified
 * memory — the rest is vLLM's KV cache reservation.
 *
 * Mirrors the agent-side `bytes_per_weight()` in agent/src/main.rs so
 * client and server agree on size estimates.
 */

import type { SentinelMetrics } from '../types';
import { parseParamCountFromModelName } from './kvCache';

/**
 * Average bytes-per-weight for a given GGUF / HF quant tag.
 * Strips Unsloth's "UD-" prefix.  Returns null when the tag is unrecognized.
 *
 * Sources:
 *   - GGUF spec: https://github.com/ggerganov/llama.cpp/blob/master/docs/development/gguf.md
 *   - K-quant mixed-precision averages from llama.cpp benchmark thread.
 */
export function bytesPerWeight(quant: string | null | undefined): number | null {
  if (!quant) return null;
  let q = quant.toLowerCase().replace(/\.gguf$/, '');
  if (q.startsWith('ud-')) q = q.slice(3);

  if (q.startsWith('iq1') || q === 'q1_k' || q === 'q1') return 0.25;
  // IQ2 variants are genuinely 2–2.7 bit; Q2_K is mixed-precision and lands
  // at ~3.2 bits in practice (Llama 3.1 8B Q2_K = 3.18 GB / 8.03B = 0.40 B/W).
  if (q.startsWith('iq2'))                                return 0.34;
  if (q.startsWith('q2'))                                 return 0.39;
  if (q.startsWith('iq3') || q.startsWith('q3'))         return 0.45;
  // IQ4_XS/IQ4_NL sit at ~4.25–4.5 bits; the modal GGUF quant Q4_K_M is
  // ~4.85 bits (Llama 3.1 8B Q4_K_M = 4.92 GB / 8.03B params = 0.61 B/W),
  // so plain Q4 gets the higher figure.
  if (q.startsWith('iq4'))                                return 0.56;
  if (q.startsWith('q4'))                                 return 0.60;
  if (q.startsWith('q5'))                                 return 0.69;
  if (q.startsWith('q6'))                                 return 0.82;
  if (q.startsWith('q8') || q === 'fp8' || q === 'int8')  return 1.0;
  if (q.startsWith('f16') || q === 'bf16' || q.startsWith('fp16')) return 2.0;
  if (q.startsWith('f32') || q.startsWith('fp32'))        return 4.0;
  // ── Production vLLM/HF quant formats ─────────────────────────────────────
  // AWQ:  4-bit weight, 16-bit activations — ~Q4 effective on weights.
  //       Marlin / GEMM kernels keep activations in FP16, so weight bytes
  //       dominate model size.
  // GPTQ: 4-bit (most common) or 8-bit. We default the bare "gptq" tag to
  //       4-bit since that's the modal usage; explicit "gptq-int8" goes
  //       through the int8 branch above.
  // AQLM, HQQ: 2-bit aggressive quants (Aphrodite / HQQ libraries) —
  //       between IQ2 and IQ3 quality-wise.
  if (q === 'awq'     || q.startsWith('awq-int4') || q === 'awq-4bit')  return 0.56;
  if (q === 'gptq'    || q.startsWith('gptq-int4') || q === 'gptq-4bit') return 0.56;
  if (q === 'gptq-int8' || q === 'gptq-8bit')      return 1.0;
  if (q === 'aqlm'    || q.startsWith('aqlm-2bit'))  return 0.34;
  if (q === 'hqq'     || q.startsWith('hqq-4bit'))   return 0.56;
  if (q === 'hqq-2bit')                              return 0.34;
  // BitsAndBytes 4-bit (HF "load_in_4bit") and 8-bit ("load_in_8bit").
  if (q === 'bnb-4bit' || q === 'nf4' || q === 'fp4') return 0.56;
  if (q === 'bnb-8bit')                               return 1.0;
  return null;
}

/** FP16/BF16 — vLLM's default dtype and the baseline all compression ratios reference. */
export const FP16_BYTES_PER_WEIGHT = 2.0;

/**
 * Memory footprint relative to the FP16 baseline, derived from
 * `bytesPerWeight()` so there is exactly one source of truth.
 *
 *   ratio = bytes_per_weight / 2.0
 *
 * e.g. Q4 → 0.60 / 2.0 = 0.30, matching real GGUF files
 * (Llama 3.1 8B: Q4_K_M 4.92 GB / F16 16.07 GB = 0.31).
 *
 * Accepts either a concrete quant tag ("Q4_K_M", "FP8") or a bare family
 * label ("Q4", "F16") — both resolve through the same prefix matching.
 * Returns null when the tag is unrecognized.
 */
export function quantCompressionRatio(quantOrFamily: string | null | undefined): number | null {
  const bpw = bytesPerWeight(quantOrFamily);
  return bpw != null ? bpw / FP16_BYTES_PER_WEIGHT : null;
}

/**
 * Collapse a quant tag into its GGUF family bucket ("Q4", "Q8", "F16", …).
 *
 * IQ-quants fold into the matching Q bucket (IQ2_XS → Q2); FP8/INT8 fold
 * into Q8 and BF16 into F16 since their byte footprints match. AWQ / GPTQ /
 * HQQ / AQLM / BNB deliberately return "Unknown": they're vLLM/HF formats,
 * and mapping them onto a GGUF family would make the Quant Sweet Spot card
 * recommend GGUF quants (Q6_K etc.) to users who can't run them. Size math
 * for those formats should use `quantCompressionRatio()` on the raw tag
 * instead of going through the family.
 */
export function quantFamily(label: string | null | undefined): string {
  if (!label) return 'Unknown';
  let q = label.toLowerCase().replace(/\.gguf$/, '');
  if (q.startsWith('ud-')) q = q.slice(3);
  const m = q.match(/^i?q(\d)/);
  if (m) return `Q${m[1]}`;
  if (q === 'fp8' || q === 'int8')                              return 'Q8';
  if (q.startsWith('f16') || q.startsWith('fp16') || q === 'bf16') return 'F16';
  if (q.startsWith('f32') || q.startsWith('fp32'))              return 'F32';
  return 'Unknown';
}

/**
 * Extract a quant tag from a model name string.
 *
 * Handles:
 *   "Llama-3.1-8B-Q4_K_M.gguf"            → "Q4_K_M"
 *   "qwen2.5-32b-instruct-fp8"            → "FP8"
 *   "Mixtral-8x7B-bf16"                   → "BF16"
 *   "phi-3-mini-Q8_0"                     → "Q8_0"
 *   "Qwen2.5-32B-Instruct-AWQ"            → "AWQ"
 *   "Llama-3.1-70B-Instruct-GPTQ-Int4"    → "GPTQ-INT4"
 *   "Mistral-7B-Instruct-v0.3-AQLM-2bit"  → "AQLM-2BIT"
 *
 * Returns null when no quant tag is found.
 */
export function parseQuantFromAnyModelName(name: string | null | undefined): string | null {
  if (!name) return null;
  const stripped = name.split('/').pop()!.replace(/\.gguf$/i, '');

  // GGUF quant tags: Q<digit>_<...>, IQ<digit>_<...>, IQ<digit>_M
  const gguf = stripped.match(/[._-](u?d-?)?(i?q\d[\w]*)/i);
  if (gguf) return gguf[2].toUpperCase();

  // Full-precision + production HF/vLLM quant formats.
  // Must include AWQ/GPTQ/AQLM/HQQ/NF4 etc. — without these, vLLM users
  // running 4-bit AWQ models would have their quant default to FP16 and
  // their estimated VRAM size inflated 4× (e.g. 64GB instead of 16GB
  // for a 32B AWQ-int4 model). Order matters: longer tokens first to
  // avoid bare "gptq" matching before "gptq-int4".
  const fp = stripped.match(/[._-](gptq-int8|gptq-int4|gptq-4bit|gptq-8bit|gptq|awq-int4|awq-4bit|awq|aqlm-2bit|aqlm|hqq-4bit|hqq-2bit|hqq|bnb-4bit|bnb-8bit|nf4|fp4|fp8|int8|fp16|bf16|f16|f32|fp32)\b/i);
  if (fp) return fp[1].toUpperCase();

  return null;
}

/**
 * Estimate model weight size in GB from the active model name.
 *
 *   size_gb = parameter_count × bytes_per_weight / 1e9
 *
 * When the quant cannot be parsed (e.g. vLLM model names like
 * "Qwen/Qwen2.5-32B-Instruct" with no -fp8 / -bf16 / -q4 tag), falls back
 * to `fallbackBpw` — default **2.0 bytes/weight** (FP16/BF16, vLLM's
 * default dtype).  Slightly over-estimates size for genuinely quantized
 * models, which is exactly what we want for fit scoring: better to
 * occasionally tell a 4-bit user "you have 50% headroom" than to fall
 * through to the inflated `nvidia_vram_used_mb` proxy and report "Poor"
 * for a model that's actually well-fitted.
 *
 * Callers sizing an *Ollama* model name should pass
 * OLLAMA_DEFAULT_BYTES_PER_WEIGHT instead: an un-tagged Ollama pull
 * ("llama3.1:8b") is Q4_K_M by default, and the FP16 assumption would
 * overestimate it 3.3× — enough to flip a well-fitted node to "Poor".
 *
 * Returns null only when parameter count itself cannot be inferred from
 * the name (e.g. "phi-3-mini" with no <n>b tag).
 *
 * Carries ±10–30% uncertainty (exact GGUF file sizes vary by
 * architecture — embedding tables, output layer, K/V dim variations).
 */
export function estimateModelSizeGbFromName(
  modelName: string | null | undefined,
  quantHint?: string | null,
  fallbackBpw: number = FP16_BYTES_PER_WEIGHT,
): number | null {
  if (!modelName) return null;
  const params = parseParamCountFromModelName(modelName);
  if (params == null) return null;
  const quant = quantHint ?? parseQuantFromAnyModelName(modelName);
  const bpw = bytesPerWeight(quant) ?? fallbackBpw;
  return (params * bpw) / 1e9;
}

/**
 * Ollama pulls without an explicit tag default to Q4_K_M — use the Q4
 * bytes-per-weight when sizing an un-tagged Ollama model name.
 */
export const OLLAMA_DEFAULT_BYTES_PER_WEIGHT = 0.60;

/**
 * Best-effort model size in GB across all runtime hints on a SentinelMetrics
 * payload, in priority order:
 *
 *   1. ollama_model_size_gb — exact, from `/api/show`
 *   2. param-count × bytes-per-weight from the active model name + quant hint
 *      (works for vLLM and llama.cpp once we know quant — see vllm_dtype hook
 *      below when present)
 *   3. null  — caller should fall back to NVIDIA `nvidia_vram_used_mb` only as
 *      a last resort, knowing it's contaminated by KV cache reservation on
 *      vLLM nodes.
 */
export function estimateModelSizeGb(node: SentinelMetrics): number | null {
  if (node.ollama_model_size_gb != null) return node.ollama_model_size_gb;

  const modelName =
    node.ollama_active_model
    ?? node.vllm_model_name
    ?? node.llamacpp_model_name
    ?? null;
  if (!modelName) return null;

  // Quant hint: prefer explicit field, fall back to name parse.
  const quantHint =
    node.ollama_quantization
    ?? parseQuantFromAnyModelName(modelName);

  // Un-tagged Ollama names default to Q4_K_M, not FP16 — see
  // OLLAMA_DEFAULT_BYTES_PER_WEIGHT.
  const fallbackBpw = node.ollama_active_model
    ? OLLAMA_DEFAULT_BYTES_PER_WEIGHT
    : FP16_BYTES_PER_WEIGHT;

  return estimateModelSizeGbFromName(modelName, quantHint, fallbackBpw);
}
