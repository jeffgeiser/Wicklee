/**
 * Synthetic fleet generator for the demo build (VITE_BUILD_TARGET=demo).
 *
 * Six nodes with personality, deterministic seeded noise, and scripted
 * events so a three-minute look tells the whole product story:
 *   - studio-m4max     · Apple M4 Max, healthy prod inference
 *   - rig-4090-a/b     · RTX 4090 pair tagged env:prod, one runs hot
 *   - dgx-h100         · H100 box, big model, high throughput
 *   - mini-m2          · thermally struggling Mac mini (throttle story)
 *   - edge-4060        · flaky edge node that drops offline periodically
 *
 * Everything derives from wall-clock time through a seeded PRNG, so the
 * demo is smooth, repeatable, and needs no stored state.
 */

import type { FleetNode, SentinelMetrics } from '../types';

// Mulberry32 — tiny deterministic PRNG; seeded per (node, tick) so frames
// are reproducible and independent of render timing.
function rand(seed: number): number {
  let t = (seed + 0x6D2B79F5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Smooth periodic wobble in [-1, 1] from a couple of incommensurate sines. */
function wobble(tSec: number, phase: number, period = 90): number {
  return 0.6 * Math.sin((tSec / period) * 2 * Math.PI + phase)
       + 0.4 * Math.sin((tSec / (period * 0.37)) * 2 * Math.PI + phase * 2.7);
}

interface DemoNodeDef {
  node_id:      string;
  hostname:     string;
  display_name: string;
  tags:         string;
  gpu:          'apple' | 'nvidia';
  gpu_name:     string;
  baseTok:      number;   // tok/s center
  baseWatts:    number;
  vramTotalMb:  number | null;
  model:        string;
  altModel:     string;   // swapped in periodically
  modelSizeGb:  number;
  quant:        string;
  profile:      string;
  memTotalMb:   number;
  phase:        number;   // noise phase offset
  story?:       'thermal' | 'flaky';
}

export const DEMO_NODES: DemoNodeDef[] = [
  { node_id: 'WK-a1b2c3d4e5f60718', hostname: 'studio-m4max', display_name: 'Studio · M4 Max',
    tags: 'env:prod, apple', gpu: 'apple', gpu_name: 'Apple M4 Max', baseTok: 42, baseWatts: 38,
    vramTotalMb: null, model: 'llama3.1:8b', altModel: 'qwen2.5:14b', modelSizeGb: 4.9, quant: 'Q4_K_M',
    profile: 'production_fleet', memTotalMb: 65536, phase: 0.3 },
  { node_id: 'WK-b2c3d4e5f6071829', hostname: 'rig-4090-a', display_name: 'Rig A · 4090',
    tags: 'env:prod, gpu, rack-1', gpu: 'nvidia', gpu_name: 'NVIDIA GeForce RTX 4090', baseTok: 96, baseWatts: 310,
    vramTotalMb: 24564, model: 'qwen2.5:32b', altModel: 'llama3.1:8b', modelSizeGb: 19.8, quant: 'Q4_K_M',
    profile: 'production_fleet', memTotalMb: 131072, phase: 1.1 },
  { node_id: 'WK-c3d4e5f607182930', hostname: 'rig-4090-b', display_name: 'Rig B · 4090',
    tags: 'env:prod, gpu, rack-1', gpu: 'nvidia', gpu_name: 'NVIDIA GeForce RTX 4090', baseTok: 88, baseWatts: 335,
    vramTotalMb: 24564, model: 'qwen2.5:32b', altModel: 'mistral:7b', modelSizeGb: 19.8, quant: 'Q4_K_M',
    profile: 'production_fleet', memTotalMb: 131072, phase: 2.2 },
  { node_id: 'WK-d4e5f60718293041', hostname: 'dgx-h100', display_name: 'DGX · H100',
    tags: 'env:prod, datacenter', gpu: 'nvidia', gpu_name: 'NVIDIA H100 80GB HBM3', baseTok: 210, baseWatts: 540,
    vramTotalMb: 81559, model: 'llama3.1:70b', altModel: 'llama3.1:70b', modelSizeGb: 42.5, quant: 'Q4_K_M',
    profile: 'production_fleet', memTotalMb: 1048576, phase: 3.6 },
  { node_id: 'WK-e5f6071829304152', hostname: 'mini-m2', display_name: 'Mini · M2 (hot)',
    tags: 'env:staging, apple', gpu: 'apple', gpu_name: 'Apple M2', baseTok: 14, baseWatts: 22,
    vramTotalMb: null, model: 'phi3:mini', altModel: 'gemma2:9b', modelSizeGb: 2.2, quant: 'Q4_K_M',
    profile: 'dedicated_server', memTotalMb: 16384, phase: 4.9, story: 'thermal' },
  { node_id: 'WK-f607182930415263', hostname: 'edge-4060', display_name: 'Edge · 4060',
    tags: 'env:staging, edge', gpu: 'nvidia', gpu_name: 'NVIDIA GeForce RTX 4060 Ti', baseTok: 34, baseWatts: 130,
    vramTotalMb: 16380, model: 'mistral:7b', altModel: 'mistral:7b', modelSizeGb: 4.4, quant: 'Q4_K_M',
    profile: 'sovereign_dev', memTotalMb: 32768, phase: 5.7, story: 'flaky' },
];

/** The flaky node is offline for 40s out of every 5 minutes. */
function edgeOffline(tSec: number): boolean {
  return tSec % 300 >= 220 && tSec % 300 < 260;
}

/** The hot node throttles for ~90s out of every 4 minutes. */
function miniThrottling(tSec: number): boolean {
  return tSec % 240 >= 100 && tSec % 240 < 190;
}

/** Model swap window: every 150s the alt model runs for 60s on rig-b. */
function altModelActive(tSec: number): boolean {
  return tSec % 150 >= 80 && tSec % 150 < 140;
}

function metricsFor(def: DemoNodeDef, nowMs: number): SentinelMetrics {
  const tSec = Math.floor(nowMs / 1000);
  const seed = tSec * 31 + def.phase * 1000;
  const w = wobble(tSec, def.phase);
  const n = () => (rand(seed + Math.floor(rand(seed) * 97)) - 0.5) * 2; // [-1,1]

  const throttling = def.story === 'thermal' && miniThrottling(tSec);
  const swap = def.hostname === 'rig-4090-b' && altModelActive(tSec);
  const model = swap ? def.altModel : def.model;

  const tokBase = throttling ? def.baseTok * 0.55 : def.baseTok;
  const tok = Math.max(0.5, tokBase * (1 + 0.12 * w + 0.04 * n()));
  const watts = Math.max(4, def.baseWatts * (1 + 0.10 * w + 0.03 * n()) * (throttling ? 1.12 : 1));
  const gpuPct = Math.min(99, Math.max(5, 62 + 25 * w + 6 * n() + (throttling ? 18 : 0)));
  const memPct = Math.min(96, Math.max(20, 55 + 12 * w + 4 * n()));
  const thermal = throttling ? (tSec % 240 >= 150 ? 'Serious' : 'Fair') : 'Normal';
  const usedMem = Math.round(def.memTotalMb * (0.45 + 0.1 * w));

  const m: SentinelMetrics = {
    node_id: def.node_id,
    hostname: def.hostname,
    tags: def.tags,
    deployment_profile: def.profile,
    gpu_name: def.gpu_name,
    chip_name: null,
    cpu_usage_percent: Math.max(2, 18 + 10 * w + 3 * n()),
    total_memory_mb: def.memTotalMb,
    used_memory_mb: usedMem,
    available_memory_mb: def.memTotalMb - usedMem,
    cpu_core_count: def.gpu === 'apple' ? 14 : 24,
    timestamp_ms: nowMs,
    cpu_power_w: def.gpu === 'apple' ? watts * 0.3 : 45,
    ecpu_power_w: def.gpu === 'apple' ? watts * 0.08 : null,
    pcpu_power_w: def.gpu === 'apple' ? watts * 0.22 : null,
    apple_gpu_power_w: def.gpu === 'apple' ? watts * 0.65 : null,
    apple_soc_power_w: def.gpu === 'apple' ? watts : null,
    gpu_utilization_percent: def.gpu === 'apple' ? gpuPct : null,
    memory_pressure_percent: memPct,
    thermal_state: thermal,
    gpu_wired_limit_mb: def.gpu === 'apple' ? Math.round(def.memTotalMb * 0.75) : null,
    nvidia_gpu_utilization_percent: def.gpu === 'nvidia' ? gpuPct : null,
    nvidia_vram_used_mb: def.gpu === 'nvidia' && def.vramTotalMb
      ? Math.min(Math.round(def.vramTotalMb * 0.92),
                 Math.round(def.modelSizeGb * 1024 * 1.15 + 700 + 300 * w)) : null,
    nvidia_vram_total_mb: def.vramTotalMb,
    nvidia_gpu_temp_c: def.gpu === 'nvidia' ? Math.round(58 + 14 * w + (throttling ? 15 : 0)) : null,
    nvidia_power_draw_w: def.gpu === 'nvidia' ? watts : null,
    ollama_running: true,
    ollama_active_model: model,
    ollama_model_size_gb: def.modelSizeGb,
    ollama_quantization: def.quant,
    ollama_context_length: 8192,
    ollama_parameter_count: Math.round(def.modelSizeGb / 0.6) * 1_000_000_000,
    ollama_tokens_per_second: tok,
    ollama_inference_active: tok > 1,
    ollama_proxy_active: true,
    ollama_proxy_avg_ttft_ms: Math.round(150 + 40 * w + (throttling ? 170 : 0)),
    ollama_proxy_avg_latency_ms: Math.round(1900 + 400 * w + (throttling ? 1100 : 0)),
    agent_version: '0.11.0',
  } as SentinelMetrics;

  // Fields many panels read via the SSOT inference/thermal path.
  const extra = m as unknown as Record<string, unknown>;
  extra.inference_state = tok > 1 ? 'live' : 'idle';
  extra.thermal_penalty = thermal === 'Serious' ? 1.75 : thermal === 'Fair' ? 1.25 : 1.0;
  extra.penalty_avg = extra.thermal_penalty;

  return m;
}

/** One SSE-equivalent frame: the whole fleet at `nowMs`. */
export function demoFrame(nowMs: number): { nodes: FleetNode[] } {
  const tSec = Math.floor(nowMs / 1000);
  const nodes: FleetNode[] = DEMO_NODES.map(def => {
    const offline = def.story === 'flaky' && edgeOffline(tSec);
    return {
      node_id: def.node_id,
      // Offline node: stale last_seen, no metrics — the dashboard's own
      // staleness logic does the rest.
      last_seen_ms: offline ? nowMs - 120_000 : nowMs,
      metrics: offline ? null : metricsFor(def, nowMs),
      restricted: false,
      display_name: def.display_name,
      tags: def.tags,
    };
  });
  return { nodes };
}

/** Deterministic history series for the REST fixtures (charts). */
export function demoSeries(
  def: DemoNodeDef,
  hours: number,
  stepMin: number,
  nowMs: number,
): Array<{ ts_ms: number; tok: number; watts: number; gpu: number; mem: number; thermal: string }> {
  const out = [];
  const steps = Math.floor((hours * 60) / stepMin);
  for (let i = steps; i >= 0; i--) {
    const ts = nowMs - i * stepMin * 60_000;
    const tSec = Math.floor(ts / 1000);
    const w = wobble(tSec, def.phase, 3600 * 3);
    const throttling = def.story === 'thermal' && (tSec % 14400) > 10000;
    const tok = Math.max(0.5, def.baseTok * (1 + 0.15 * w) * (throttling ? 0.6 : 1));
    out.push({
      ts_ms: ts,
      tok,
      watts: Math.max(4, def.baseWatts * (1 + 0.12 * w)),
      gpu: Math.min(99, Math.max(5, 60 + 28 * w)),
      mem: Math.min(96, Math.max(20, 52 + 14 * w)),
      thermal: throttling ? 'Fair' : 'Normal',
    });
  }
  return out;
}
