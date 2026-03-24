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
  // Ollama provides explicit model size; vLLM/llama.cpp don't — estimate from VRAM used.
  let modelSizeGb = node.ollama_model_size_gb ?? null;
  const hasVllmModel      = !!node.vllm_model_name;
  const hasLlamaCppModel  = !!node.llamacpp_model_name;

  // If Ollama has no model but vLLM or llama.cpp is active, estimate model size from VRAM.
  // On NVIDIA GPUs, the loaded model dominates VRAM — used VRAM is a reasonable proxy.
  if (modelSizeGb == null && (hasVllmModel || hasLlamaCppModel)) {
    const vramUsedMb = node.nvidia_vram_used_mb ?? null;
    if (vramUsedMb != null && vramUsedMb > 0) {
      modelSizeGb = vramUsedMb / 1024;
    } else {
      // Non-NVIDIA runtime (llama.cpp on CPU) — use 50% of used system RAM as estimate
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

  // usedMb: for NVIDIA, requires vramUsedMb from NVML; for others, derived from available.
  const usedMb: number | null = isNvidia
    ? vramUsedMb                        // null when NVML didn't report VRAM in use
    : totalMemMb - availMemMb;          // always computable on non-NVIDIA nodes

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
