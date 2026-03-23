/**
 * Power fields used by the resolution functions.
 * All fields are optional to support partial metric objects
 * (e.g. metricsToSample in useMetricHistory).
 */
interface PowerFields {
  apple_soc_power_w?:  number | null;
  nvidia_power_draw_w?: number | null;
  cpu_power_w?:        number | null;
  apple_gpu_power_w?:  number | null;
}

/**
 * Resolve the best available total power draw for a node.
 *
 * Priority chain (first non-null wins):
 *   1. apple_soc_power_w  — Combined CPU+GPU+ANE from powermetrics. Authoritative for Apple Silicon.
 *   2. nvidia_power_draw_w — Board-level power from NVML. Authoritative for NVIDIA.
 *   3. cpu_power_w + apple_gpu_power_w — Fallback sum for older agents that don't emit soc_power.
 *
 * Returns null when no power data is available.
 *
 * IMPORTANT: Every power→WES/cost/W1K calculation in the frontend MUST use this function.
 * Do not inline the priority chain — it was the source of the fleet WES divergence bug
 * where ~30 callsites used cpu_power_w alone instead of apple_soc_power_w.
 */
export function getNodePowerW(m: PowerFields): number | null {
  if (m.apple_soc_power_w != null) return m.apple_soc_power_w;
  if (m.nvidia_power_draw_w != null) return m.nvidia_power_draw_w;
  if (m.cpu_power_w != null) return (m.cpu_power_w ?? 0) + (m.apple_gpu_power_w ?? 0);
  return null;
}

/**
 * Check whether any power data is available for a node.
 */
export function hasPowerData(m: PowerFields): boolean {
  return m.apple_soc_power_w != null || m.nvidia_power_draw_w != null || m.cpu_power_w != null;
}
