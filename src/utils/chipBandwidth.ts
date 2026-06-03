/**
 * Memory bandwidth lookup for inference tok/s estimation.
 *
 * LLM inference at batch=1 is memory-bandwidth-bound: the engine must stream
 * every weight from VRAM through the GPU once per token. The theoretical
 * ceiling is:
 *
 *   max_tps = memory_bandwidth_GB_s / model_size_GB
 *
 * Real-world tok/s tops out at roughly 35-45% of theoretical because of
 * activation memory traffic, KV cache reads, framework overhead, and
 * sub-optimal kernel scheduling for batch=1 GGUF inference. The constant
 * INFERENCE_EFFICIENCY captures that ceiling so callers compute:
 *
 *   estimated_tps = bandwidth × INFERENCE_EFFICIENCY / model_size_GB
 *
 * This is the same physics runthisllm.com uses to estimate "~13 t/s" on
 * model cards without any user telemetry. It's a ceiling, not a forecast —
 * the real number lands lower under thermal throttling, longer context
 * (KV-bound, not weight-bound), or multi-model contention. Once Wicklee
 * has any actual telemetry, the bandwidth-from-history projection in
 * modelHistory.ts supersedes this estimate.
 *
 * Bandwidth values from manufacturer specs:
 *   Apple Silicon — https://en.wikipedia.org/wiki/Apple_silicon
 *   NVIDIA        — https://www.nvidia.com/en-us/data-center/* spec sheets
 */

/**
 * Realistic fraction of theoretical bandwidth actually achieved during
 * single-stream GGUF inference. Conservative — most measurements I've
 * collected land in 0.30–0.45 range across Apple Silicon and consumer
 * NVIDIA cards. 0.40 is the middle of that band.
 */
export const INFERENCE_EFFICIENCY = 0.40;

/**
 * Apple Silicon memory bandwidth in GB/s. Keys are normalized chip names
 * — the lookup uses substring matching so "Apple M2 Pro" matches "M2 Pro".
 */
const APPLE_BANDWIDTH_GB_S: Record<string, number> = {
  // M1 family
  'M1 Ultra':  800,
  'M1 Max':    400,
  'M1 Pro':    200,
  'M1':         68,
  // M2 family
  'M2 Ultra':  800,
  'M2 Max':    400,
  'M2 Pro':    200,
  'M2':        100,
  // M3 family — bandwidth was DOWNGRADED on M3 Pro/Max relative to M2 equivalents
  'M3 Ultra':  800,
  'M3 Max':    400,   // 16-core GPU variant; 12-core is 300 (we approximate up)
  'M3 Pro':    150,
  'M3':        100,
  // M4 family
  'M4 Max':    546,
  'M4 Pro':    273,
  'M4':        120,
};

/**
 * NVIDIA bandwidth in GB/s. Keys match substrings of common chip names
 * as reported by NVML (e.g. "GeForce RTX 4090", "NVIDIA H100 PCIe").
 * Conservative — datacenter cards use HBM, consumer cards use GDDR.
 */
const NVIDIA_BANDWIDTH_GB_S: Record<string, number> = {
  // Datacenter HBM
  'H200':       4800,
  'H100':       3350,
  'A100':       2039,    // 80GB SXM variant; 40GB PCIe is 1555
  'L40S':        864,
  'L40':         864,
  'L4':          300,
  'A40':         696,
  'A10':         600,
  // RTX 50 series (Blackwell)
  'RTX 5090':   1792,
  'RTX 5080':    960,
  'RTX 5070 Ti': 896,
  'RTX 5070':    672,
  // RTX 40 series (Ada Lovelace)
  'RTX 4090':   1008,
  'RTX 4080':    717,
  'RTX 4070 Ti': 504,
  'RTX 4070':    504,
  'RTX 4060 Ti': 288,
  'RTX 4060':    272,
  // RTX 30 series (Ampere)
  'RTX 3090':    936,
  'RTX 3080':    760,
  'RTX 3070':    448,
  'RTX 3060':    360,
  // Workstation
  'RTX 6000 Ada':  960,
  'RTX A6000':     768,
  'RTX A5000':     768,
  'RTX A4000':     448,
};

/**
 * Look up memory bandwidth from a chip name. Returns null if no match.
 *
 * Matching is substring-based against the longest key first, so
 * "Apple M2 Pro 10-core" matches "M2 Pro" (200) rather than "M2" (100).
 */
export function chipBandwidthGBs(chipName: string | null | undefined): number | null {
  if (!chipName) return null;
  const name = chipName.trim();
  if (!name) return null;

  // Merge both tables and try longest keys first so "M2 Pro" wins over "M2".
  const all = { ...APPLE_BANDWIDTH_GB_S, ...NVIDIA_BANDWIDTH_GB_S };
  const keys = Object.keys(all).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (name.includes(k)) return all[k];
  }
  return null;
}

/**
 * Theoretical tok/s for a model of given size on the given chip.
 *
 * Returns null when the chip isn't in the lookup table — caller should
 * either omit the estimate or fall through to a different signal.
 */
export function theoreticalTpsForChip(
  chipName: string | null | undefined,
  modelSizeGB: number,
): number | null {
  if (modelSizeGB <= 0) return null;
  const bw = chipBandwidthGBs(chipName);
  if (bw == null) return null;
  return (bw * INFERENCE_EFFICIENCY) / modelSizeGB;
}
