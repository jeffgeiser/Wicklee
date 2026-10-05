/**
 * Forensics card analysis — each function must return nothing (rather than a
 * made-up number) when history is too thin, and the right answer when it isn't.
 */

import { describe, it, expect } from 'vitest';
import {
  efficiencyRegressions, memoryForecasts, coldStarts, thermalDiversity,
  inferenceDensity, fmtDuration, median,
} from '../forensics';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

describe('median', () => {
  it('handles odd, even and empty input', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('efficiencyRegressions', () => {
  const series = (recent: number, baseline: number) => [
    // 20 baseline buckets, 2–6 days ago
    ...Array.from({ length: 20 }, (_, i) => ({ ts_ms: NOW - 2 * 24 * HOUR - i * 30 * MIN, penalized_wes: baseline })),
    // 8 recent buckets, last 4 h
    ...Array.from({ length: 8 }, (_, i) => ({ ts_ms: NOW - i * 30 * MIN, penalized_wes: recent })),
  ];

  it('reports the recent-vs-baseline change, worst first', () => {
    const out = efficiencyRegressions([
      { node_id: 'a', hostname: 'a', points: series(9, 10) },
      { node_id: 'b', hostname: 'b', points: series(6, 10) },
    ], NOW);
    expect(out.map(r => r.node_id)).toEqual(['b', 'a']);
    expect(out[0].deltaPct).toBeCloseTo(-40);
    expect(out[0].baselineWes).toBe(10);
  });

  it('skips nodes without enough baseline', () => {
    const pts = series(6, 10).slice(15); // only 5 baseline buckets left
    expect(efficiencyRegressions([{ node_id: 'a', hostname: 'a', points: pts }], NOW)).toEqual([]);
  });

  it('ignores null and zero WES (idle buckets)', () => {
    const pts = [...series(6, 10), ...Array.from({ length: 50 }, (_, i) => ({ ts_ms: NOW - i * MIN, penalized_wes: i % 2 ? null : 0 }))];
    expect(efficiencyRegressions([{ node_id: 'a', hostname: 'a', points: pts }], NOW)[0].recentWes).toBe(6);
  });
});

describe('memoryForecasts', () => {
  const rising = Array.from({ length: 24 }, (_, i) => ({ ts_ms: NOW - (23 - i) * 5 * MIN, mem_pct: 50 + i * (10 / 12) })); // +10 pts/h

  it('projects time to the threshold from the 2 h slope', () => {
    const [f] = memoryForecasts([{ node_id: 'a', hostname: 'a', points: rising }], NOW);
    expect(f.slopePctPerHour).toBeCloseTo(10, 0);
    // current ≈ 69.2 → 95 at 10/h ≈ 2.6 h
    expect(f.etaMs! / HOUR).toBeCloseTo((95 - f.currentPct) / f.slopePctPerHour, 3);
  });

  it('gives no ETA for flat memory', () => {
    const flat = rising.map(p => ({ ...p, mem_pct: 60 }));
    expect(memoryForecasts([{ node_id: 'a', hostname: 'a', points: flat }], NOW)[0].etaMs).toBeNull();
  });

  it('needs at least 6 points in the window', () => {
    const old = rising.map(p => ({ ...p, ts_ms: p.ts_ms - 5 * HOUR }));
    expect(memoryForecasts([{ node_id: 'a', hostname: 'a', points: old }], NOW)).toEqual([]);
  });

  it('sorts nodes with an ETA ahead of those without', () => {
    const flat = rising.map(p => ({ ...p, mem_pct: 90 }));
    const out = memoryForecasts([
      { node_id: 'flat', hostname: 'flat', points: flat },
      { node_id: 'rise', hostname: 'rise', points: rising },
    ], NOW);
    expect(out[0].node_id).toBe('rise');
  });
});

describe('coldStarts', () => {
  it('counts buckets at ≥ 3× median and ≥ 1 s', () => {
    const ttft = [200, 210, 190, 205, 2500, 195, 200, 800, 3000];
    const pts = ttft.map((t, i) => ({ ts_ms: NOW - (ttft.length - i) * 5 * MIN, ttft_ms: t }));
    const [c] = coldStarts([{ node_id: 'a', hostname: 'a', points: pts }]);
    expect(c.spikes).toBe(2); // 800 is ≥ 3× median but under the 1 s floor
    expect(c.worstTtftMs).toBe(3000);
    expect(c.lastSpikeMs).toBe(pts[8].ts_ms);
  });

  it('skips nodes with no TTFT data', () => {
    expect(coldStarts([{ node_id: 'a', hostname: 'a', points: [{ ts_ms: NOW, ttft_ms: null }] }])).toEqual([]);
  });
});

describe('thermalDiversity', () => {
  const node = (id: string, states: string[]) => ({
    node_id: id, hostname: id,
    points: states.map((s, i) => ({ ts_ms: i * 30 * MIN, thermal_state: s })),
  });

  it('needs two nodes', () => {
    expect(thermalDiversity([node('a', ['Normal'])])).toBeNull();
  });

  it('is low risk when nodes heat up independently', () => {
    const d = thermalDiversity([
      node('a', ['Serious', 'Normal', 'Normal', 'Normal']),
      node('b', ['Normal', 'Serious', 'Normal', 'Normal']),
    ])!;
    expect(d.risk).toBe('low');
    expect(d.perNode[0].warmPct).toBe(25);
  });

  it('is high risk when nodes are hot together', () => {
    const d = thermalDiversity([
      node('a', ['Serious', 'Critical', 'Normal', 'Normal']),
      node('b', ['Serious', 'Serious', 'Normal', 'Normal']),
    ])!;
    expect(d.correlatedBuckets).toBe(2);
    expect(d.risk).toBe('high');
  });
});

describe('inferenceDensity', () => {
  it('sums nodes per bucket and averages by hour', () => {
    const hourOf = (ms: number) => Math.floor(ms / HOUR) % 24;
    const d = inferenceDensity([
      { node_id: 'a', hostname: 'a', points: [{ ts_ms: 9 * HOUR, tok_s: 30, duty_pct: 50 }, { ts_ms: 33 * HOUR, tok_s: 10 }] },
      { node_id: 'b', hostname: 'b', points: [{ ts_ms: 9 * HOUR, tok_s: 20, duty_pct: 100 }, { ts_ms: 14 * HOUR, tok_s: 5 }] },
    ], hourOf)!;
    expect(d.byHour[9]).toBe(30); // (30+20 + 10) / 2 buckets
    expect(d.byHour[14]).toBe(5);
    expect(d.byHour[0]).toBeNull();
    expect(d.peakHour).toBe(9);
    expect(d.avgDutyPct).toBe(75);
  });

  it('returns null with no throughput', () => {
    expect(inferenceDensity([{ node_id: 'a', hostname: 'a', points: [{ ts_ms: 0, tok_s: 0 }] }])).toBeNull();
    expect(inferenceDensity([])).toBeNull();
  });
});

describe('fmtDuration', () => {
  it('formats minutes, hours and days', () => {
    expect(fmtDuration(45 * MIN)).toBe('45m');
    expect(fmtDuration(135 * MIN)).toBe('2h 15m');
    expect(fmtDuration(76 * HOUR)).toBe('3d 4h');
  });
});
