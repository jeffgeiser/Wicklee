/**
 * WES — Wicklee Efficiency Score
 *
 *   WES = tok/s ÷ (Watts × PUE × ThermalPenalty)
 *
 * Where:
 *   Watts = `getNodePowerW(node)` — RAW node power, NOT idle-subtracted.
 *           The frozen color scale (>10 emerald, 3–10 green, 1–3 yellow,
 *           <1 red) was calibrated against raw watts; subtracting
 *           systemIdleW from `getNodeSettings(id)` would shift every node's
 *           score and break the cross-tab comparison invariant. systemIdleW
 *           is for active-inference cost displays, not for WES.
 *   PUE   = `getNodeSettings(id).pue ?? 1.0` — facility multiplier.
 *           Datacenter operators set PUE > 1.0 to factor in cooling overhead.
 *   ThermalPenalty = 1.0 (Normal) | 1.25 (Fair) | 1.75 (Serious) | 2.0 (Critical)
 *
 * Every WES surface in the app must use this formula. Currently aligned:
 *   - Overview tile (Intelligence)         → src/components/Overview.tsx
 *   - Model Fit Analysis card (Insights)   → src/components/insights/tier2/ModelFitAnalysis.tsx
 *   - WES Trend / Leaderboard charts       → src/components/insights/*.tsx
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
  serious:  1.75,
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
 * Compute the raw (un-penalized) WES for a node.
 * Used alongside computeWES to derive the Thermal Cost %.
 *
 * @param tokensPerSec  Sampled tok/s — null if not running
 * @param watts         Total board power — null if unavailable
 * @param pue           Power Usage Effectiveness multiplier (default 1.0)
 * @returns             Raw WES (no thermal penalty), or null if inputs insufficient
 */
export function computeRawWES(
  tokensPerSec: number | null | undefined,
  watts: number | null | undefined,
  pue: number = 1.0,
): number | null {
  if (tokensPerSec == null || tokensPerSec <= 0) return null;
  if (watts == null || watts <= 0) return null;
  return tokensPerSec / (watts * pue);
}

/**
 * Compute Thermal Cost % — the percentage of potential efficiency lost to thermal throttling.
 *
 * Formula: (RawWES - PenalizedWES) / RawWES × 100
 *
 * Returns 0 when there is no thermal gap (Normal state or null inputs).
 */
export function thermalCostPct(rawWes: number | null, penalizedWes: number | null): number {
  if (rawWes == null || penalizedWes == null || rawWes <= 0) return 0;
  return Math.round(((rawWes - penalizedWes) / rawWes) * 100);
}

/**
 * Human-readable label for the thermal data source field from agent WES v2.
 */
export function thermalSourceLabel(source: string | null | undefined): string {
  if (source == null) return 'unknown';
  const map: Record<string, string> = {
    nvml:        'NVML',
    iokit:       'IOKit',
    coretemp:    'coretemp',
    clock_ratio: 'clock ratio',
    sysfs:       'sysfs',
    wmi:         'WMI',
    unavailable: 'unavailable',
  };
  return map[source.toLowerCase()] ?? source;
}

/**
 * Tailwind color class for a WES or tok/W score value.
 *
 * > 10  → emerald (Excellent)
 * 3–10  → light green (Good)
 * 1–3   → yellow (Acceptable)
 * < 1   → red (Low)
 * null  → muted gray
 */
export function wesColorClass(score: number | null): string {
  if (score == null) return 'text-gray-400 dark:text-gray-600';
  if (score > 10)    return 'text-emerald-500 dark:text-emerald-400';  // Excellent — bright emerald
  if (score >= 3)    return 'text-green-400 dark:text-green-300';      // Good — lighter green
  if (score >= 1)    return 'text-yellow-500 dark:text-yellow-400';    // Acceptable — yellow
  return 'text-red-500 dark:text-red-400';                              // Low — red
}
