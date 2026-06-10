import { describe, it, expect } from 'vitest';
import { computeQuantRecommendation } from '../quantSweet';
import { makeNode } from './fixtures';

// Llama 3.1 8B at Q4_K_M: 4.9 GB observed.
const Q4_SIZE = 4.9;
const node = () => makeNode({ ollama_active_model: 'llama3.1:8b' });

describe('computeQuantRecommendation', () => {
  it('anchors the FP16 baseline to real file-size ratios', () => {
    const rec = computeQuantRecommendation('Q4', Q4_SIZE, 20, 40, node(), 32);
    // fp16 baseline ≈ 4.9 / 0.30 = 16.3 GB — matches the published 16.07 GB
    // F16 GGUF within 5%. The old ratio table (0.45) said 10.9 GB.
    expect(rec.kind).toBe('consider');
    expect(rec.targetFamily).toBe('Q6');
    // Q6_K of an 8B ≈ 6.6 GB published; estimate ≈ 16.33 × 0.41 = 6.7 GB.
    expect(rec.targetSizeGb).toBeCloseTo(6.7, 0);
  });

  it('strongly recommends upgrading from Q2/Q3', () => {
    const rec = computeQuantRecommendation('Q2', 2.8, 20, 40, node(), 32);
    expect(rec.kind).toBe('upgrade');
    expect(rec.targetFamily).toBe('Q4');
  });

  it('reserves 10% of total capacity so an upgrade cannot land the node in Poor', () => {
    // Q6 upgrade needs ~+1.8 GB. Headroom 4 GB on a 32 GB node → reserve 3.2 GB
    // leaves only 0.8 GB usable → upgrade must NOT be recommended.
    const tight = computeQuantRecommendation('Q4', Q4_SIZE, 4, 40, node(), 32);
    expect(tight.kind).toBe('sweet-spot');

    // Same headroom with no capacity info keeps the old permissive behavior.
    const legacy = computeQuantRecommendation('Q4', Q4_SIZE, 4, 40, node());
    expect(legacy.kind).toBe('consider');
  });

  it('estimates target tok/s by inverse size ratio', () => {
    const rec = computeQuantRecommendation('Q4', Q4_SIZE, 20, 40, node(), 32);
    // Q4 → Q6 is ~37% larger → ~27% slower.
    expect(rec.estimatedTps).toBeCloseTo(40 * (Q4_SIZE / rec.targetSizeGb!), 1);
    expect(rec.estimatedTps!).toBeLessThan(40);
    expect(rec.estimatedTps!).toBeGreaterThan(25);
  });

  it('calls Q5/Q6 the sweet spot when headroom is healthy', () => {
    const rec = computeQuantRecommendation('Q6', 6.6, 10, 30, node(), 32);
    expect(rec.kind).toBe('sweet-spot');
    expect(rec.targetFamily).toBeNull();
  });

  it('suggests freeing headroom from Q6 when memory is tight', () => {
    const rec = computeQuantRecommendation('Q6', 6.6, 1.5, 30, node(), 16);
    expect(rec.kind).toBe('downgrade');
    expect(rec.targetFamily).toBe('Q4');
    expect(rec.vramDeltaGb!).toBeLessThan(0);
  });

  it('suggests Q8 → Q6 when lossless quant is squeezing context room', () => {
    const rec = computeQuantRecommendation('Q8', 8.5, 2, 25, node(), 12);
    expect(rec.kind).toBe('downgrade');
    expect(rec.targetFamily).toBe('Q6');
    // Derived ratios: Q8 0.5 → Q6 0.41 frees 8.5 × (1 − 0.82) ≈ 1.5 GB.
    expect(-rec.vramDeltaGb!).toBeCloseTo(8.5 * (1 - 0.41 / 0.5), 1);
  });

  it('returns none for unknown quant families', () => {
    const rec = computeQuantRecommendation('Unknown', 5, 10, 30, node(), 32);
    expect(rec.kind).toBe('none');
  });
});
