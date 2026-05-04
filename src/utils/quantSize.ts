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
  if (q.startsWith('iq2') || q.startsWith('q2'))         return 0.34;
  if (q.startsWith('iq3') || q.startsWith('q3'))         return 0.45;
  if (q.startsWith('iq4') || q.startsWith('q4'))         return 0.56;
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
 * "Qwen/Qwen2.5-32B-Instruct" with no -fp8 / -bf16 / -q4 tag), defaults
 * to **2.0 bytes/weight** — FP16/BF16, vLLM's default dtype and the
 * modal answer for modern transformer LLMs.  Slightly over-estimates
 * size for genuinely quantized models, which is exactly what we want
 * for fit scoring: better to occasionally tell a 4-bit user "you have
 * 50% headroom" than to fall through to the inflated `nvidia_vram_used_mb`
 * proxy and report "Poor" for a model that's actually well-fitted.
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
): number | null {
  if (!modelName) return null;
  const params = parseParamCountFromModelName(modelName);
  if (params == null) return null;
  const quant = quantHint ?? parseQuantFromAnyModelName(modelName);
  // Fall back to FP16/BF16 (2 bytes/weight) when quant unknown — this is
  // vLLM's default and matches what most users running un-tagged models
  // are actually doing.  Strict callers should use `bytesPerWeight()`
  // directly and check for null.
  const bpw = bytesPerWeight(quant) ?? 2.0;
  return (params * bpw) / 1e9;
}

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

  return estimateModelSizeGbFromName(modelName, quantHint);
}
