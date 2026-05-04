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
  return null;
}

/**
 * Extract a quant tag from a model name string.
 *
 * Handles:
 *   "Llama-3.1-8B-Q4_K_M.gguf"        → "Q4_K_M"
 *   "qwen2.5-32b-instruct-fp8"        → "FP8"
 *   "Mixtral-8x7B-bf16"               → "BF16"
 *   "phi-3-mini-Q8_0"                 → "Q8_0"
 *
 * Returns null when no quant tag is found.
 */
export function parseQuantFromAnyModelName(name: string | null | undefined): string | null {
  if (!name) return null;
  const stripped = name.split('/').pop()!.replace(/\.gguf$/i, '');

  // GGUF quant tags: Q<digit>_<...>, IQ<digit>_<...>, IQ<digit>_M
  const gguf = stripped.match(/[._-](u?d-?)?(i?q\d[\w]*)/i);
  if (gguf) return gguf[2].toUpperCase();

  // Full-precision tags: FP8, INT8, FP16, BF16, F16, F32, FP32
  const fp = stripped.match(/[._-](fp8|int8|fp16|bf16|f16|f32|fp32)\b/i);
  if (fp) return fp[1].toUpperCase();

  return null;
}

/**
 * Estimate model weight size in GB from the active model name.
 *
 *   size_gb = parameter_count × bytes_per_weight / 1e9
 *
 * Returns null when either parameter count or quant cannot be parsed.
 * Carries ±10-20% uncertainty (exact GGUF file sizes vary by architecture
 * — embedding tables, output layer, K/V dim variations).
 *
 * This is the right answer for vLLM where `nvidia_vram_used_mb` includes
 * KV cache reservation that has nothing to do with model weight size.
 */
export function estimateModelSizeGbFromName(
  modelName: string | null | undefined,
  quantHint?: string | null,
): number | null {
  if (!modelName) return null;
  const params = parseParamCountFromModelName(modelName);
  if (params == null) return null;
  const quant = quantHint ?? parseQuantFromAnyModelName(modelName);
  const bpw = bytesPerWeight(quant);
  if (bpw == null) return null;
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
