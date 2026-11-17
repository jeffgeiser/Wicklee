import { describe, it, expect } from 'vitest';
import { wesColorClass, THERMAL_PENALTY, computeWES } from '../wes';

/**
 * The colour scale is frozen in CLAUDE.md. These cases pin each boundary so a
 * change to the ladder has to be deliberate, and so the band below 1 keeps
 * reading as red rather than as "no data" — an inline copy in Overview.tsx had
 * drifted to grey there, which is what these tests now prevent.
 */
describe('wesColorClass — the frozen scale', () => {
  const band = (s: number | null) => {
    const c = wesColorClass(s);
    if (c.includes('emerald')) return 'excellent';
    if (c.includes('green')) return 'good';
    if (c.includes('yellow')) return 'acceptable';
    if (c.includes('red')) return 'low';
    if (c.includes('gray')) return 'none';
    throw new Error(`unclassifiable: ${c}`);
  };

  it('is emerald strictly above 10', () => {
    expect(band(10.01)).toBe('excellent');
    expect(band(999)).toBe('excellent');
  });

  it('is green from 3 up to and including 10', () => {
    expect(band(10)).toBe('good');
    expect(band(3)).toBe('good');
  });

  it('is yellow from 1 up to but not including 3', () => {
    expect(band(2.99)).toBe('acceptable');
    expect(band(1)).toBe('acceptable');
  });

  it('is red below 1 — never grey', () => {
    expect(band(0.99)).toBe('low');
    expect(band(0)).toBe('low');
    expect(band(-1)).toBe('low');
  });

  it('is grey only for a missing value', () => {
    expect(band(null)).toBe('none');
  });

  it('defines a light and a dark value for every band', () => {
    for (const s of [20, 5, 2, 0.5, null]) {
      expect(wesColorClass(s)).toMatch(/^text-[a-z]+-\d+ dark:text-[a-z]+-\d+$/);
    }
  });
});

describe('thermal penalties — frozen in CLAUDE.md', () => {
  it('matches the documented multipliers', () => {
    expect(THERMAL_PENALTY.normal).toBe(1.0);
    expect(THERMAL_PENALTY.fair).toBe(1.25);
    expect(THERMAL_PENALTY.serious).toBe(1.75);
    expect(THERMAL_PENALTY.critical).toBe(2.0);
  });

  it('accepts the capitalised state strings the agent actually sends', () => {
    // The table is keyed lowercase; computeWES lowercases before lookup, so a
    // payload carrying "Critical" must still be penalised.
    expect(computeWES(20, 10, 'Critical')).toBeCloseTo(1, 5);
    expect(computeWES(20, 10, 'Fair')).toBeCloseTo(1.6, 5);
  });

  it('falls back to no penalty for an unknown state', () => {
    expect(computeWES(20, 10, 'Toasty')).toBeCloseTo(2, 5);
  });
});

describe('computeWES', () => {
  it('is tok/s per watt when thermal is Normal — no x10 multiplier', () => {
    expect(computeWES(20, 10, 'Normal')).toBeCloseTo(2, 5);
  });

  it('divides by the penalty when the node is throttling', () => {
    expect(computeWES(20, 10, 'Critical')).toBeCloseTo(1, 5);
  });

  it('has no answer without power', () => {
    expect(computeWES(20, 0, 'Normal')).toBeNull();
    expect(computeWES(20, null, 'Normal')).toBeNull();
  });
});
