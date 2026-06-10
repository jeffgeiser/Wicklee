import { describe, it, expect } from 'vitest';
import { chipBandwidthGBs, theoreticalTpsForChip, INFERENCE_EFFICIENCY } from '../chipBandwidth';
import { chipBandwidthGbs } from '../quantSweet';
import { makeNode } from './fixtures';

describe('chipBandwidthGBs', () => {
  it('resolves Apple Silicon names, longest key first', () => {
    expect(chipBandwidthGBs('Apple M2 Pro 10-core')).toBe(200);
    expect(chipBandwidthGBs('Apple M2')).toBe(100);
    expect(chipBandwidthGBs('Apple M3 Ultra')).toBe(819);
    expect(chipBandwidthGBs('Apple M3 Max')).toBe(400);
    expect(chipBandwidthGBs('Apple M4 Max')).toBe(546);
  });

  it('resolves real NVML name strings including dashed variants', () => {
    expect(chipBandwidthGBs('NVIDIA A100-SXM4-80GB')).toBe(2039);
    expect(chipBandwidthGBs('NVIDIA A100-PCIE-40GB')).toBe(1555);
    expect(chipBandwidthGBs('NVIDIA H100 PCIe')).toBe(2000);
    expect(chipBandwidthGBs('NVIDIA H100 80GB HBM3')).toBe(3350);
    expect(chipBandwidthGBs('NVIDIA H100 NVL')).toBe(3938);
  });

  it('does not mis-bind Apple keys inside SXM form-factor codes', () => {
    // "V100-SXM2" contains the substring "M2" — must resolve as V100 (900),
    // not as a base Apple M2 (100). Same for "SXM4" vs Apple M4.
    expect(chipBandwidthGBs('Tesla V100-SXM2-16GB')).toBe(900);
    expect(chipBandwidthGBs('NVIDIA A100-SXM4-40GB')).toBe(1555);
  });

  it('distinguishes Ti / Super variants from base cards', () => {
    expect(chipBandwidthGBs('NVIDIA GeForce RTX 4080 SUPER')).toBe(736);
    expect(chipBandwidthGBs('NVIDIA GeForce RTX 4080')).toBe(717);
    expect(chipBandwidthGBs('NVIDIA GeForce RTX 3090 Ti')).toBe(1008);
    expect(chipBandwidthGBs('NVIDIA GeForce RTX 3090')).toBe(936);
    expect(chipBandwidthGBs('NVIDIA GeForce RTX 3080 Ti')).toBe(912);
    expect(chipBandwidthGBs('NVIDIA GeForce RTX 4070 Ti SUPER')).toBe(672);
  });

  it('does not let L4 shadow L40/L40S or A40 shadow RTX A4000', () => {
    expect(chipBandwidthGBs('NVIDIA L40S')).toBe(864);
    expect(chipBandwidthGBs('NVIDIA L40')).toBe(864);
    expect(chipBandwidthGBs('NVIDIA L4')).toBe(300);
    expect(chipBandwidthGBs('NVIDIA RTX A4000')).toBe(448);
    expect(chipBandwidthGBs('NVIDIA A10')).toBe(600);
  });

  it('returns null for unknown hardware (no guessed ceilings)', () => {
    expect(chipBandwidthGBs('AMD Radeon RX 7900 XTX')).toBeNull();
    expect(chipBandwidthGBs(null)).toBeNull();
  });
});

describe('quantSweet delegation', () => {
  it('quotes the same bandwidth as the canonical table (no more drift)', () => {
    // M3 Max previously read 300 from quantSweet's private copy while
    // chipBandwidth.ts said 400 — same node, two numbers on screen.
    const node = makeNode({ chip_name: 'Apple M3 Max' });
    expect(chipBandwidthGbs(node)).toBe(chipBandwidthGBs('Apple M3 Max'));
    expect(chipBandwidthGbs(node)).toBe(400);
  });

  it('falls back to gpu_name when chip_name is absent', () => {
    expect(chipBandwidthGbs(makeNode({ gpu_name: 'NVIDIA GeForce RTX 4090' }))).toBe(1008);
  });
});

describe('theoreticalTpsForChip', () => {
  it('applies the 0.40 inference-efficiency factor to the raw ceiling', () => {
    // M4 Max (546 GB/s), 5 GB model → 546 × 0.40 / 5 = 43.7 tok/s
    expect(theoreticalTpsForChip('Apple M4 Max', 5)).toBeCloseTo(
      (546 * INFERENCE_EFFICIENCY) / 5, 5,
    );
  });
});
