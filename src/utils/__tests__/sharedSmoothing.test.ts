/**
 * sharedSmoothing — timestamp dedup and rolling-mean behavior.
 *
 * The dedup matters because multiple surfaces (FleetStatusRow,
 * ModelFitSummaryStrip, ModelFitAnalysis) push the same node's sample
 * during the same render pass, and StrictMode double-renders in dev:
 * without per-frame dedup the 4-sample window fills with copies of one
 * frame and the output is effectively unsmoothed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { pushAndGetSmoothed, getSmoothed, _resetAll } from '../sharedSmoothing';

describe('sharedSmoothing', () => {
  beforeEach(() => _resetAll());

  it('computes a rolling mean over distinct frames', () => {
    expect(pushAndGetSmoothed('n1', 'tps', 10, 1000)).toBe(10);
    expect(pushAndGetSmoothed('n1', 'tps', 20, 2000)).toBe(15);
    expect(pushAndGetSmoothed('n1', 'tps', 30, 3000)).toBe(20);
  });

  it('ignores duplicate pushes of the same frame (same timestamp)', () => {
    pushAndGetSmoothed('n1', 'tps', 10, 1000);
    // Second surface pushes the same frame in the same render pass —
    // must not enter the window again.
    expect(pushAndGetSmoothed('n1', 'tps', 10, 1000)).toBe(10);
    expect(pushAndGetSmoothed('n1', 'tps', 10, 1000)).toBe(10);
    // A genuinely new frame still moves the mean.
    expect(pushAndGetSmoothed('n1', 'tps', 30, 2000)).toBe(20);
  });

  it('keeps the window at 4 samples', () => {
    for (const [v, ts] of [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]] as const) {
      pushAndGetSmoothed('n1', 'watts', v, ts * 1000);
    }
    // Window holds [2, 3, 4, 5] → mean 3.5.
    expect(getSmoothed('n1', 'watts')).toBe(3.5);
  });

  it('returns the current mean without appending on null/non-finite values', () => {
    pushAndGetSmoothed('n1', 'gpu', 50, 1000);
    expect(pushAndGetSmoothed('n1', 'gpu', null, 2000)).toBe(50);
    expect(pushAndGetSmoothed('n1', 'gpu', Number.NaN, 3000)).toBe(50);
  });

  it('still accepts untimestamped pushes (legacy callers, ts = 0)', () => {
    expect(pushAndGetSmoothed('n1', 'tps', 10)).toBe(10);
    expect(pushAndGetSmoothed('n1', 'tps', 20)).toBe(15);
  });
});
