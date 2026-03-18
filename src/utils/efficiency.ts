/**
 * efficiency.ts — Fleet-level metric calculations for the Insight Engine header.
 *
 * Core WES computation lives in wes.ts; this module adds fleet-aggregate
 * functions for the 8-tile grid: thermal health, total VRAM, idle cost.
 */

import { computeWES, formatWES, wesColorClass, THERMAL_PENALTY } from './wes';
import type { SentinelMetrics } from '../types';

export { computeWES, formatWES, wesColorClass, THERMAL_PENALTY };

/** Canonical hover tooltip shown on every WES value across the UI. */
export const WES_TOOLTIP =
  'Wicklee Efficiency Score (WES): Intelligence per Watt normalized for thermal throttling and facility PUE. Higher is better.';

/**
 * Compute WES from pre-adjusted watts (raw power × PUE already applied by caller).
 * Use this form when the caller pre-multiplies power by PUE before calling.
 * Equivalent to computeWES(toks, rawWatts, thermalState, pue).
 */
export function calculateWES(
  toks: number | null | undefined,
  adjustedWatts: number | null | undefined,
  thermalState: string | null | undefined,
): number | null {
  return computeWES(toks, adjustedWatts, thermalState, 1.0);
}

export const ELECTRICITY_RATE_USD_PER_KWH = 0.13;

/**
 * Fleet Thermal Health Score.
 * Returns 0–100 (% of nodes whose thermal_state is Normal or Fair).
 * Returns null when no node has thermal data yet.
 */
export function calculateFleetHealthPct(metrics: SentinelMetrics[]): number | null {
  const withThermal = metrics.filter(m => m.thermal_state != null);
  if (withThermal.length === 0) return null;
  const healthy = withThermal.filter(m =>
    ['normal', 'fair'].includes((m.thermal_state ?? '').toLowerCase())
  );
  return Math.round((healthy.length / withThermal.length) * 100);
}

/**
 * Minimum NVIDIA VRAM (MB) required to treat a device as a real inference GPU.
 * Filters out BMC/IPMI onboard graphics (ASPEED AST, tiny AMD framebuffers)
 * that report <1 GB and are invisible to Ollama/vLLM workloads.
 * Applied consistently in the tile aggregators AND the row hasNvidia check
 * so the row and top tile always agree on what counts as usable VRAM.
 */
export const INFERENCE_VRAM_THRESHOLD_MB = 1024;

/**
 * Apple Silicon GPU memory budget in MB for a single node.
 * Uses iogpu.wired_limit_mb if available (emitted by agent ≥ v0.4.4);
 * falls back to 75% of total RAM for older agents.
 * Returns null for NVIDIA nodes and CPU-only Linux/Windows nodes.
 */
function appleGpuBudgetMb(m: SentinelMetrics): number | null {
  // memory_pressure_percent is strictly Apple Silicon (IOKit) — reliable platform detector
  if (m.memory_pressure_percent == null) return null;
  // gpu_wired_limit_mb === 0 means the agent's sysctl probe failed on this macOS version —
  // treat 0 the same as null and use the 75% estimate (matches FleetStatusRow line logic).
  // ?? would silently return 0 here since 0 is not null/undefined.
  return (m.gpu_wired_limit_mb != null && m.gpu_wired_limit_mb > 0)
    ? m.gpu_wired_limit_mb
    : Math.round(m.total_memory_mb * 0.75);
}

/**
 * Total GPU memory in use across the fleet, in MB.
 * - NVIDIA nodes ≥ 1 GB:  nvidia_vram_used_mb
 * - Apple Silicon nodes:   wired_limit − min(wired_limit, available_memory_mb)
 * - BMC/onboard graphics:  excluded (< INFERENCE_VRAM_THRESHOLD_MB)
 * - CPU-only nodes:        0 (excluded)
 */
export function calculateTotalVramMb(metrics: SentinelMetrics[]): number {
  return metrics.reduce((acc, m) => {
    if (m.nvidia_vram_total_mb != null && m.nvidia_vram_total_mb >= INFERENCE_VRAM_THRESHOLD_MB) {
      return acc + (m.nvidia_vram_used_mb ?? 0);
    }
    const budget = appleGpuBudgetMb(m);
    if (budget != null) {
      const avail = Math.max(0, Math.min(budget, m.available_memory_mb));
      return acc + Math.max(0, budget - avail);
    }
    return acc;
  }, 0);
}

/**
 * Total GPU memory capacity across the fleet, in MB.
 * - NVIDIA nodes ≥ 1 GB:  nvidia_vram_total_mb
 * - Apple Silicon nodes:   iogpu.wired_limit_mb (or 75% of RAM for older agents)
 * - BMC/onboard graphics:  excluded (< INFERENCE_VRAM_THRESHOLD_MB)
 * - CPU-only nodes:        0 (excluded)
 */
export function calculateTotalVramCapacityMb(metrics: SentinelMetrics[]): number {
  return metrics.reduce((acc, m) => {
    if (m.nvidia_vram_total_mb != null && m.nvidia_vram_total_mb >= INFERENCE_VRAM_THRESHOLD_MB) {
      return acc + m.nvidia_vram_total_mb;
    }
    const budget = appleGpuBudgetMb(m);
    return budget != null ? acc + budget : acc;
  }, 0);
}

/**
 * Human-readable VRAM pool summary for fleet-level tiles.
 *
 * showCounts = false  → "Apple + NVIDIA" | "wired budget" | "NVIDIA VRAM"
 *   — terse, used by the Insight Engine header (Overview.tsx).
 *
 * showCounts = true   → "2 NVIDIA · 1 Apple Silicon · combined"
 *   — detailed, used by the management Node Registry header (NodesList.tsx).
 *
 * Returns null when no GPU nodes are present.
 * Both branches use the same INFERENCE_VRAM_THRESHOLD_MB filter so counts
 * and totals are always consistent.
 */
export function fleetVramSubtitle(
  metrics: SentinelMetrics[],
  opts: { showCounts?: boolean } = {},
): string | null {
  const { showCounts = false } = opts;
  const nvidiaCount = metrics.filter(
    m => (m.nvidia_vram_total_mb ?? 0) >= INFERENCE_VRAM_THRESHOLD_MB,
  ).length;
  const appleCount = metrics.filter(m => m.memory_pressure_percent != null).length;

  if (nvidiaCount === 0 && appleCount === 0) return null;

  if (showCounts) {
    const parts: string[] = [];
    if (nvidiaCount > 0) parts.push(`${nvidiaCount} NVIDIA`);
    if (appleCount  > 0) parts.push(`${appleCount} Apple Silicon`);
    return parts.join(' · ') + (parts.length > 1 ? ' · combined' : '');
  }

  if (nvidiaCount > 0 && appleCount > 0) return 'Apple + NVIDIA';
  if (appleCount  > 0) return 'wired budget';
  return 'NVIDIA VRAM';
}

/**
 * Daily fleet power cost in USD.
 * Covers all nodes that report power data (nvidia_power_draw_w or cpu_power_w).
 * We intentionally do NOT filter by inference activity: ollama_tokens_per_second is a
 * 30-second sampled probe value that persists from the last measurement, making any
 * "is actively inferring" check unreliable — it would exclude the entire fleet.
 * This represents the always-on infrastructure electricity cost.
 * Power: nvidia_power_draw_w preferred (NVIDIA via NVML); falls back to cpu_power_w
 * (Apple Silicon powermetrics or Linux RAPL).
 * Formula: ∑ (watts_i × pue_i) × 24h × (rate_$/kWh ÷ 1000)
 * Returns null when no node reports power data.
 */
export function calculateIdleFleetCostPerDay(
  metrics: SentinelMetrics[],
  pueByNodeId: Record<string, number>,
  rateUsdPerKwh = ELECTRICITY_RATE_USD_PER_KWH,
): number | null {
  const withPower = metrics.filter(m =>
    m.nvidia_power_draw_w != null || m.cpu_power_w != null
  );
  if (withPower.length === 0) return null;
  return withPower.reduce((acc, m) => {
    const watts = m.nvidia_power_draw_w ?? m.cpu_power_w ?? 0;
    const pue   = pueByNodeId[m.node_id] ?? 1.0;
    return acc + watts * pue * 24 * (rateUsdPerKwh / 1000);
  }, 0);
}

/**
 * Cost per 1,000 tokens in USD.
 *
 * Formula: (fleetHourlyCostUsd / (fleetTps × 3600)) × 1000
 * where fleetHourlyCostUsd = ∑ watts_i × pue_i × rate_i / 1000 (in $/hr).
 *
 * @param fleetTps           Fleet tok/s (∑ across inference-active nodes)
 * @param fleetHourlyCostUsd Fleet electricity cost per hour in USD, PUE already applied
 * @returns null when fleetTps is zero/null or no cost data is available
 *
 * TODO: vLLM backend — ollama_tokens_per_second is the only tok/s source today.
 *       Wire in vLLM inference stats once the vLLM adapter ships.
 */
export function calculateCostPer1kTokens(
  fleetTps: number | null,
  fleetHourlyCostUsd: number | null,
): number | null {
  if (fleetTps == null || fleetTps <= 0) return null;
  if (fleetHourlyCostUsd == null) return null;
  // Tokens per hour = fleetTps × 3600; cost per 1k = hourly_cost / (tok_per_hr / 1000)
  return (fleetHourlyCostUsd / (fleetTps * 3.6));
}

/**
 * Tokens per watt — fleet inference throughput efficiency.
 *
 * Formula: fleetTps / totalFleetWatts
 * Measures how many tok/s the fleet delivers per watt of draw.
 *
 * @param fleetTps        Fleet tok/s across inference-active nodes
 * @param totalFleetWatts Total power draw of those same nodes in watts
 * @returns null when fleetTps or power data is unavailable
 *
 * TODO: vLLM backend — extend to include vLLM node power once the adapter ships.
 */
export function calculateTokensPerWatt(
  fleetTps: number | null,
  totalFleetWatts: number | null,
): number | null {
  if (fleetTps == null || fleetTps <= 0) return null;
  if (totalFleetWatts == null || totalFleetWatts <= 0) return null;
  return fleetTps / totalFleetWatts;
}
