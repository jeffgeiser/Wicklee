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
  'M3 Ultra':  819,   // 819.2 spec — matches agent hardware_bandwidth_gbps
  'M3 Max':    400,   // 16-core GPU variant; 14-core is 300 (we approximate up)
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
  // Datacenter HBM — A100/H100 split by variant in chipBandwidthGBs() since
  // NVML names ("NVIDIA A100-SXM4-80GB", "NVIDIA H100 PCIe") need keyword
  // logic, not plain substring keys.
  'H200':       4800,
  'V100':        900,
  'L40S':        864,
  'L40':         864,
  'L4':          300,
  'A40':         696,
  'A10':         600,
  // Grace Blackwell unified memory (DGX Spark)
  'GB10':        273,
  // RTX 50 series (Blackwell)
  'RTX 5090':   1792,
  'RTX 5080':    960,
  'RTX 5070 Ti': 896,
  'RTX 5070':    672,
  // RTX 40 series (Ada Lovelace)
  'RTX 4090':   1008,
  'RTX 4080 Super': 736,
  'RTX 4080':    717,
  'RTX 4070 Ti Super': 672,
  'RTX 4070 Ti': 504,
  'RTX 4070':    504,
  'RTX 4060 Ti': 288,
  'RTX 4060':    272,
  // RTX 30 series (Ampere)
  'RTX 3090 Ti': 1008,
  'RTX 3090':    936,
  'RTX 3080 Ti': 912,
  'RTX 3080':    760,
  'RTX 3070 Ti': 608,
  'RTX 3070':    448,
  'RTX 3060 Ti': 448,
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
 * Matching is case-insensitive, dash/underscore-insensitive (NVML reports
 * "NVIDIA A100-SXM4-80GB"), and requires word boundaries — plain substring
 * matching mis-bound short Apple keys inside NVML form-factor codes
 * ("V100-SXM2" contains "M2" and resolved as a base Apple M2). Longest key
 * wins, so "Apple M2 Pro 10-core" matches "M2 Pro" (200) rather than
 * "M2" (100).
 */
export function chipBandwidthGBs(chipName: string | null | undefined): number | null {
  if (!chipName) return null;
  const name = chipName.trim().toUpperCase().replace(/[-_]+/g, ' ');
  if (!name) return null;

  const word = (pat: string): boolean => {
    const esc = pat.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^A-Z0-9])${esc}(?:$|[^A-Z0-9])`).test(name);
  };

  // A100/H100 ship in variants whose NVML names interleave the capacity and
  // form factor ("A100-SXM4-80GB", "H100 PCIe", "H100 80GB HBM3"), so plain
  // table keys can't distinguish them. Mirrors agent hardware_bandwidth_gbps().
  if (word('A100')) return name.includes('80') ? 2039 : 1555;
  if (word('H100')) {
    if (word('PCIE')) return 2000;
    if (word('NVL'))  return 3938;
    return 3350; // SXM ("H100 80GB HBM3")
  }

  // Merge both tables and try longest keys first so "M2 Pro" wins over "M2".
  const all = { ...APPLE_BANDWIDTH_GB_S, ...NVIDIA_BANDWIDTH_GB_S };
  const keys = Object.keys(all).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (word(k)) return all[k];
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
