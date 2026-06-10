/**
 * Model-to-Hardware Fit Score
 *
 * Answers: "Is this hardware a good match for the model currently loaded?"
 *
 * All inputs come from the live SSE payload — no new data sources required.
 * This is a pure render-time computation with no side effects.
 *
 * Scoring:
 *   Good  — model fits AND headroom > 20% AND thermal Normal or null
 *   Fair  — model fits AND (headroom 10–20% OR thermal Fair)
 *   Poor  — model does not fit OR headroom < 10% OR thermal Serious/Critical
 */

import type { SentinelMetrics } from '../types';
import {
  estimateModelSizeGbFromName,
  parseQuantFromAnyModelName,
  FP16_BYTES_PER_WEIGHT,
  OLLAMA_DEFAULT_BYTES_PER_WEIGHT,
} from './quantSize';

/**
 * Working-set overhead applied on top of model weights when we have to
 * *synthesize* a used-memory figure (vLLM nodes, where measured VRAM is
 * contaminated by eager KV reservation).
 *
 * Matches the agent's `estimate_vram_mb()`: 30% covers KV cache at a
 * typical 8K context for a 7–13B class model (~15%), activation buffers
 * (~5%), and framework alignment + scratch space (~10%), with a 512 MB
 * floor for small models. The previous 10% figure systematically
 * underestimated by 2–3× — see agent/src/main.rs for the full rationale.
 */
const WORKING_SET_OVERHEAD = 0.30;
const WORKING_SET_FLOOR_MB = 512;

export type FitScore = 'good' | 'fair' | 'poor';

export interface FitResult {
  score:        FitScore;
  /** Current free memory as % of total (before model load). e.g. 34.2 */
  headroomPct:  number;
  /** Free GB. e.g. 2.8 */
  headroomGb:   number;
  /** Model size in GB from payload. e.g. 2.0 */
  modelSizeGb:  number;
  /** Total memory capacity in GB (VRAM for NVIDIA, system RAM for Apple Silicon). e.g. 8.0 */
  totalGb:      number;
  /** True when VRAM was used instead of system RAM. */
  isNvidia:     boolean;
  /** Raw thermal_state string, or null if unavailable. */
  thermalState: string | null;
  /** Human-readable explanation of the score. */
  reason:       string;
}

/**
 * Compute the Model-to-Hardware Fit Score for a node.
 *
 * Supports all runtimes: Ollama, vLLM, and llama.cpp.
 *
 * Returns null when:
 *   - No model is loaded on any runtime
 *   - Required memory fields are unavailable (NVIDIA node with null vram_used)
 *   - Total memory is zero or negative (malformed payload)
 */
export function computeModelFitScore(node: SentinelMetrics): FitResult | null {
  // Estimate the model's WEIGHT size — not the runtime's total VRAM allocation.
  //
  // Priority chain (each step strictly more accurate than the last):
  //   1. Ollama /api/show explicit value                — exact
  //   2. Parameter count × bytes-per-weight from name   — ±10–20%
  //   3. nvidia_vram_used_mb proxy                      — wildly overestimates
  //                                                       on vLLM (KV cache
  //                                                       reservation contaminates)
  //   4. 50% of used system RAM                         — last-resort heuristic
  //
  // The vRAM-used proxy was the *only* fallback prior to step 2 being added,
  // which scored Spark "Poor" for a 32GB FP8 model that occupies 25% of its
  // 128GB unified memory (vLLM had eagerly reserved the rest for KV cache).
  let modelSizeGb = node.ollama_model_size_gb ?? null;
  const hasVllmModel      = !!node.vllm_model_name;
  const hasLlamaCppModel  = !!node.llamacpp_model_name;

  // Where the size figure came from — the vram-proxy path needs different
  // downstream handling (see usedMb decision below).
  let sizeFromVramProxy = false;

  if (modelSizeGb == null) {
    // Step 2: param-count × bytes-per-weight via the model name.
    const modelName =
      node.ollama_active_model
      ?? node.vllm_model_name
      ?? node.llamacpp_model_name
      ?? null;
    const quantHint =
      node.ollama_quantization
      ?? parseQuantFromAnyModelName(modelName);
    // Un-tagged Ollama pulls are Q4_K_M by default; assuming FP16 there
    // would overestimate 3.3× and flip well-fitted nodes to "Poor".
    const fallbackBpw = node.ollama_active_model
      ? OLLAMA_DEFAULT_BYTES_PER_WEIGHT
      : FP16_BYTES_PER_WEIGHT;
    const fromName = estimateModelSizeGbFromName(modelName, quantHint, fallbackBpw);
    if (fromName != null) modelSizeGb = fromName;
  }

  if (modelSizeGb == null && (hasVllmModel || hasLlamaCppModel)) {
    // Step 3: VRAM-used proxy. Marked as "best available" but documented above
    // as inflated on vLLM. We keep the path so non-name-parseable models still
    // get *some* fit signal, but the param×bpw step above will short-circuit
    // most real cases.
    const vramUsedMb = node.nvidia_vram_used_mb ?? null;
    if (vramUsedMb != null && vramUsedMb > 0) {
      modelSizeGb = vramUsedMb / 1024;
      sizeFromVramProxy = true;
    } else {
      // Step 4: 50% of used system RAM (CPU-only llama.cpp).
      const usedSystemMb = node.total_memory_mb - node.available_memory_mb;
      if (usedSystemMb > 0) {
        modelSizeGb = (usedSystemMb * 0.5) / 1024;
      }
    }
  }

  if (modelSizeGb == null) return null;

  const totalMemMb   = node.total_memory_mb;
  const availMemMb   = node.available_memory_mb;
  const thermalState = node.thermal_state ?? null;
  const vramTotalMb  = node.nvidia_vram_total_mb ?? null;
  const vramUsedMb   = node.nvidia_vram_used_mb  ?? null;

  const modelSizeMb = modelSizeGb * 1024;

  // NVIDIA nodes use dedicated VRAM; Apple Silicon / CPU nodes use system RAM.
  const isNvidia = vramTotalMb != null && vramTotalMb > 0;

  const totalMb = isNvidia ? vramTotalMb! : totalMemMb;

  // usedMb decision:
  //   - For Ollama: nvidia_vram_used_mb is a clean proxy (Ollama doesn't
  //     pre-allocate KV cache the way vLLM does).
  //   - For llama.cpp: also clean — llama.cpp allocates weights + KV for
  //     the configured context up front, so measured VRAM is real usage
  //     (and it captures other processes sharing the GPU, which a
  //     synthetic figure can't).
  //   - For vLLM: nvidia_vram_used_mb is contaminated by the engine's
  //     eager KV cache reservation (vLLM defaults to reserving ~90% of
  //     VRAM, regardless of actual model size). Using it here is what
  //     scored Spark "Poor" for a 32GB FP8 model on 128GB unified
  //     memory. Substitute the estimated model weight size + working-set
  //     overhead instead — that's what the operator actually wants to
  //     know on the Model Fit card ("does my model fit and have room
  //     for context?", not "how much has the engine pre-allocated?").
  //   - For non-NVIDIA: derived from system memory delta.
  const isVllm = !node.ollama_active_model && hasVllmModel;

  let usedMb: number | null;
  if (isVllm) {
    if (sizeFromVramProxy) {
      // The size estimate IS nvidia_vram_used_mb (steps 1–2 failed). Adding
      // overhead on top of an already KV-inflated figure would compound the
      // exact error this branch exists to avoid — use the measurement as-is.
      usedMb = Math.round(modelSizeMb);
    } else {
      // Model weights + 30% working-set overhead (512 MB floor) — same
      // convention as the agent's `estimate_vram_mb()` for candidate scoring.
      usedMb = Math.round(Math.max(
        modelSizeMb * (1 + WORKING_SET_OVERHEAD),
        modelSizeMb + WORKING_SET_FLOOR_MB,
      ));
    }
  } else if (isNvidia) {
    // Ollama and llama.cpp on NVIDIA: measured VRAM is trustworthy.
    usedMb = vramUsedMb;
  } else {
    usedMb = totalMemMb - availMemMb;
  }

  // Guard: can't score without a used-memory figure, or with degenerate total.
  if (usedMb == null) return null;
  if (totalMb <= 0)   return null;

  const headroomMb  = totalMb - usedMb;
  const headroomPct = (headroomMb / totalMb) * 100;
  const headroomGb  = headroomMb / 1024;
  const totalGb     = totalMb    / 1024;

  // Does the model fit within the hardware's total capacity?
  // We check against totalMb rather than headroomMb because ollama_model_size_gb
  // is only present when a model is *already loaded* — the model has consumed
  // memory, so headroomMb is the space left *after* loading. Comparing model
  // size against remaining headroom would always fail for a model that fills the
  // hardware and is actively running (false "doesn't fit" on large-RAM / unified
  // memory nodes like NVIDIA Grace Blackwell or 122 GB Linux boxes).
  const modelFitsTotal = modelSizeMb < totalMb;

  // Thermal classification
  const thermalLower    = thermalState?.toLowerCase() ?? null;
  const isThermalSevere = thermalLower != null && ['serious', 'critical'].includes(thermalLower);
  const isThermalFair   = thermalLower === 'fair';

  // ── Scoring (evaluated in Poor → Fair → Good priority order) ───────────────

  let score:  FitScore;
  let reason: string;

  if (!modelFitsTotal || headroomPct < 10 || isThermalSevere) {
    // Poor ─────────────────────────────────────────────────────────────────────
    score = 'poor';
    if (isThermalSevere) {
      reason = 'Serious thermal state — inference efficiency significantly degraded';
    } else if (!modelFitsTotal) {
      reason = `Model size (${modelSizeGb.toFixed(1)}GB) exceeds hardware capacity (${totalGb.toFixed(1)}GB total)`;
    } else {
      // headroomPct < 10% — model loaded but almost no room left for context / KV cache
      reason = `Only ${headroomPct.toFixed(0)}% memory free after loading — insufficient headroom for stable inference`;
    }

  } else if (headroomPct <= 20 || isThermalFair) {
    // Fair ─────────────────────────────────────────────────────────────────────
    // Condition: model fits AND (headroom 10–20% OR thermal Fair)
    score = 'fair';
    if (isThermalFair && headroomPct > 20) {
      // Thermal Fair is the sole disqualifier from Good
      reason = `Model fits but thermal state is ${thermalState} — monitor closely`;
    } else {
      // Tight memory (headroom 10–20%), with or without Fair thermal
      reason = `Model fits but memory headroom is tight (${headroomPct.toFixed(0)}%)`;
    }

  } else {
    // Good ─────────────────────────────────────────────────────────────────────
    // Condition: model fits AND headroom > 20% AND thermal Normal or null
    score  = 'good';
    reason = `Model fits with ${headroomPct.toFixed(0)}% memory headroom · ${thermalState ?? 'Normal'} thermal`;
  }

  return { score, headroomPct, headroomGb, modelSizeGb, totalGb, isNvidia, thermalState, reason };
}
