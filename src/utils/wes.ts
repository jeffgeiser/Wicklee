/**
 * WES — Wicklee Efficiency Score
 *
 * WES = tok/s ÷ (Watts_adjusted × ThermalPenalty)
 *
 * The "MPG for local AI inference": a unitless score that collapses thermal
 * throttling, power draw, and throughput into a single comparable number.
 * Higher is always better. A thermally stressed node's WES drops even when
 * its tok/s looks stable, because the penalty reflects lost headroom.
 *
 * Conceptually aligned with the Stanford / Together AI "Intelligence per Watt"
 * framework (arXiv:2511.07885, Nov 2025).
 *
 * WES is computed at render time from the live SSE payload — no backend changes.
 */

export const THERMAL_PENALTY: Record<string, number> = {
  normal:   1.0,
  fair:     1.25,
  serious:  2.0,
  critical: 2.0,
};

/**
 * Compute the Wicklee Efficiency Score for a node.
 *
 * @param tokensPerSec  Sampled tok/s from Ollama probe — null if not running
 * @param watts         Total board power (cpu_power_w + nvidia_power_draw_w) — null if unavailable
 * @param thermalState  Thermal state string ("Normal", "Fair", "Serious", "Critical") — null = assume Normal
 * @param pue           Power Usage Effectiveness multiplier (default 1.0 = home lab)
 * @returns             WES score, or null if inputs are insufficient
 */
export function computeWES(
  tokensPerSec: number | null | undefined,
  watts: number | null | undefined,
  thermalState: string | null | undefined,
  pue: number = 1.0,
): number | null {
  if (tokensPerSec == null || tokensPerSec <= 0) return null;
  if (watts == null || watts <= 0) return null;
  const penalty = thermalState != null
    ? (THERMAL_PENALTY[thermalState.toLowerCase()] ?? 1.0)
    : 1.0;
  return tokensPerSec / (watts * pue * penalty);
}

/**
 * Format a WES score for display.
 *
 * ≥ 100  → "181"   (0 decimal places)
 * 1–99.9 → "12.4"  (1 decimal place)
 * 0.1–0.99 → "0.53" (2 decimal places)
 * < 0.1  → "0.08"  (2 decimal places)
 * null   → "—"
 */
export function formatWES(score: number | null): string {
  if (score == null) return '—';
  if (score >= 100) return score.toFixed(0);
  if (score >= 1)   return score.toFixed(1);
  return score.toFixed(2);
}

/**
 * Tailwind color class for a WES score value.
 *
 * > 10  → green
 * 1–10  → amber
 * < 1   → red
 * null  → muted gray
 */
export function wesColorClass(score: number | null): string {
  if (score == null) return 'text-gray-400 dark:text-gray-600';
  if (score > 10)    return 'text-green-600 dark:text-green-400';
  if (score >= 1)    return 'text-amber-600 dark:text-amber-500';
  return 'text-red-600 dark:text-red-500';
}
