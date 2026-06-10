/**
 * Shared test fixtures for the model-fit utility suites.
 */

import type { SentinelMetrics } from '../../types';

/**
 * Minimal valid SentinelMetrics payload. Defaults model a 16 GB CPU-only
 * node with no runtimes; override per test.
 */
export function makeNode(overrides: Partial<SentinelMetrics> = {}): SentinelMetrics {
  const base = {
    node_id:  'test-node',
    hostname: 'test-node',
    cpu_usage_percent: 10,
    total_memory_mb: 16_384,
    used_memory_mb: 8_192,
    available_memory_mb: 8_192,
    cpu_core_count: 8,
    timestamp_ms: 0,
    cpu_power_w: null,
    ecpu_power_w: null,
    pcpu_power_w: null,
    gpu_utilization_percent: null,
    memory_pressure_percent: null,
    thermal_state: null,
    nvidia_gpu_utilization_percent: null,
    nvidia_vram_used_mb: null,
    nvidia_vram_total_mb: null,
    nvidia_gpu_temp_c: null,
    nvidia_power_draw_w: null,
  } as SentinelMetrics;
  return { ...base, ...overrides };
}
