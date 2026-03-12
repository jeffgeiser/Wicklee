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
 * Total GPU / unified memory in use across the fleet, in MB.
 * Per node: uses nvidia_vram_used_mb when present (dedicated VRAM),
 * otherwise used_memory_mb (Apple Silicon unified memory).
 */
export function calculateTotalVramMb(metrics: SentinelMetrics[]): number {
  return metrics.reduce((acc, m) =>
    acc + (m.nvidia_vram_used_mb ?? m.used_memory_mb ?? 0), 0);
}

/**
 * Total GPU / unified memory capacity across the fleet, in MB.
 * Per node: uses nvidia_vram_total_mb when present, otherwise total_memory_mb.
 */
export function calculateTotalVramCapacityMb(metrics: SentinelMetrics[]): number {
  return metrics.reduce((acc, m) =>
    acc + (m.nvidia_vram_total_mb ?? m.total_memory_mb ?? 0), 0);
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
