/**
 * fmtAgo is the single elapsed-time formatter (it replaced four local copies
 * that disagreed on sub-minute output). Pin both sub-minute modes and the
 * unit boundaries.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fmtAgo } from '../time';

const NOW = 1_800_000_000_000;

describe('fmtAgo', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it('says "just now" under a minute by default', () => {
    expect(fmtAgo(NOW)).toBe('just now');
    expect(fmtAgo(NOW - 59_000)).toBe('just now');
  });

  it('shows seconds under a minute when asked', () => {
    expect(fmtAgo(NOW - 42_000, { seconds: true })).toBe('42s ago');
    expect(fmtAgo(NOW - 90_000, { seconds: true })).toBe('1m ago');
  });

  it('treats a future timestamp (clock skew) as zero elapsed', () => {
    expect(fmtAgo(NOW + 5_000, { seconds: true })).toBe('0s ago');
  });

  it('steps through minutes, hours and days', () => {
    expect(fmtAgo(NOW - 60_000)).toBe('1m ago');
    expect(fmtAgo(NOW - 3_599_000)).toBe('59m ago');
    expect(fmtAgo(NOW - 3_600_000)).toBe('1h ago');
    expect(fmtAgo(NOW - 86_399_000)).toBe('23h ago');
    expect(fmtAgo(NOW - 2 * 86_400_000)).toBe('2d ago');
  });
});
