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
import { estimateModelSizeGbFromName, resolveModelSizeHints } from './quantSize';

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
  let modelSizeGb = node.ollama_model_size_gb ?? null;
  const hasVllmModel      = !!node.vllm_model_name;
  const hasLlamaCppModel  = !!node.llamacpp_model_name;

  let sizeFromVramProxy = false;

  if (modelSizeGb == null) {
    const { modelName, quantHint, fallbackBpw } = resolveModelSizeHints(node);
    const fromName = estimateModelSizeGbFromName(modelName, quantHint, fallbackBpw);
    if (fromName != null) modelSizeGb = fromName;
  }

  if (modelSizeGb == null && (hasVllmModel || hasLlamaCppModel)) {
    const vramUsedMb = node.nvidia_vram_used_mb ?? null;
    if (vramUsedMb != null && vramUsedMb > 0) {
      modelSizeGb = vramUsedMb / 1024;
      sizeFromVramProxy = true;
    } else {
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

  const isNvidia = vramTotalMb != null && vramTotalMb > 0;

  const totalMb = isNvidia ? vramTotalMb! : totalMemMb;

  const isVllm = !node.ollama_active_model && hasVllmModel;

  let usedMb: number | null;
  if (isVllm) {
    if (sizeFromVramProxy) {
      usedMb = Math.round(modelSizeMb);
    } else {
      usedMb = Math.round(Math.max(
        modelSizeMb * (1 + WORKING_SET_OVERHEAD),
        modelSizeMb + WORKING_SET_FLOOR_MB,
      ));
    }
  } else if (isNvidia) {
    usedMb = vramUsedMb;
  } else {
    usedMb = totalMemMb - availMemMb;
  }

  if (usedMb == null) return null;
  if (totalMb <= 0)   return null;

  const headroomMb  = totalMb - usedMb;
  const headroomPct = (headroomMb / totalMb) * 100;
  const headroomGb  = headroomMb / 1024;
  const totalGb     = totalMb    / 1024;

  const modelFitsTotal = modelSizeMb < totalMb;

  const thermalLower    = thermalState?.toLowerCase() ?? null;
  const isThermalSevere = thermalLower != null && ['serious', 'critical'].includes(thermalLower);
  const isThermalFair   = thermalLower === 'fair';

  let score:  FitScore;
  let reason: string;

  if (!modelFitsTotal || headroomPct < 10 || isThermalSevere) {
    score = 'poor';
    if (isThermalSevere) {
      reason = 'Serious thermal state — inference efficiency significantly degraded';
    } else if (!modelFitsTotal) {
      reason = `Model size (${modelSizeGb.toFixed(1)}GB) exceeds hardware capacity (${totalGb.toFixed(1)}GB total)`;
    } else {
      reason = `Only ${headroomPct.toFixed(0)}% memory free after loading — insufficient headroom for stable inference`;
    }

  } else if (headroomPct <= 20 || isThermalFair) {
    score = 'fair';
    if (isThermalFair && headroomPct > 20) {
      reason = `Model fits but thermal state is ${thermalState} — monitor closely`;
    } else {
      reason = `Model fits but memory headroom is tight (${headroomPct.toFixed(0)}%)`;
    }

  } else {
    score  = 'good';
    reason = `Model fits with ${headroomPct.toFixed(0)}% memory headroom · ${thermalState ?? 'Normal'} thermal`;
  }

  return { score, headroomPct, headroomGb, modelSizeGb, totalGb, isNvidia, thermalState, reason };
}
