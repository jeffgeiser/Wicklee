/**
 * sharedSmoothing — module-level rolling buffers shared across components.
 *
 * Why this exists:
 * Each component that smooths telemetry (Fleet Status row, ModelFit
 * Analysis, Model Fit Summary Strip) used to keep its own rolling buffer
 * via `useRef`. That meant identical inputs could yield different
 * smoothed outputs depending on when each component mounted — the
 * Fleet Status row had a full 4-sample history while a freshly-mounted
 * MFA card was averaging just 1–2 samples. Users saw the same node's
 * watts/tok/s/WES disagree across tabs.
 *
 * This module is the single source of truth for smoothed per-node
 * telemetry. The SSE feed pushes raw samples in; consumers read the
 * latest smoothed value out. Buffers persist across tab switches and
 * component remounts, so values are stable and consistent everywhere.
 *
 * Window matches `FLEET_ROW_ROLLING_WINDOW` (4 samples) — the existing
 * cross-tab convention.
 */

import { FLEET_ROW_ROLLING_WINDOW } from '../hooks/useRollingMetrics';

type Key = 'watts' | 'tps' | 'gpu';

interface BufState {
  buf:    number[];
  /** Timestamp (ms) of the last accepted sample — dedup key. */
  lastTs: number;
}

/**
 * Per-node ring-buffer state.  Indexed by node_id at the top level,
 * then by metric key.  All callers share this single Map.
 */
const buffers: Map<string, Record<Key, BufState>> = new Map();

function ensureBuf(nodeId: string): Record<Key, BufState> {
  let b = buffers.get(nodeId);
  if (!b) {
    b = {
      watts: { buf: [], lastTs: 0 },
      tps:   { buf: [], lastTs: 0 },
      gpu:   { buf: [], lastTs: 0 },
    };
    buffers.set(nodeId, b);
  }
  return b;
}

/**
 * Push a new sample for `nodeId.key` and return the rolling-window mean.
 * Null/non-finite values are not appended but the current mean is still
 * returned — handy for transient gaps in SSE data.
 *
 * Pass the sample's `timestamp_ms` so the SAME frame pushed by multiple
 * surfaces (FleetStatusRow + ModelFitSummaryStrip render in the same
 * pass), by non-SSE re-renders, or by StrictMode double-renders is only
 * counted once — the same dedup `useRollingBuffer.push()` does. Without
 * it the 4-sample window filled with duplicates of one frame and the
 * output was effectively unsmoothed.
 *
 * Window: FLEET_ROW_ROLLING_WINDOW (4 samples). At 1 Hz SSE cadence the
 * effective averaging period is ~4 seconds.
 */
export function pushAndGetSmoothed(
  nodeId: string,
  key:    Key,
  value:  number | null | undefined,
  tsMs:   number = 0,
): number | null {
  const b = ensureBuf(nodeId);
  const s = b[key];
  const isDuplicateFrame = tsMs > 0 && tsMs <= s.lastTs;
  if (value != null && isFinite(value) && !isDuplicateFrame) {
    s.buf.push(value);
    if (s.buf.length > FLEET_ROW_ROLLING_WINDOW) s.buf.shift();
    if (tsMs > 0) s.lastTs = tsMs;
  }
  return s.buf.length > 0 ? s.buf.reduce((a, c) => a + c, 0) / s.buf.length : null;
}

/**
 * Read the current smoothed value WITHOUT pushing a new sample.  Used
 * by consumers that want the latest agreed value (e.g. the strip's
 * Sweet Spot tile) without contributing duplicate writes when another
 * surface (e.g. MFA) is already feeding the buffer this tick.
 */
export function getSmoothed(nodeId: string, key: Key): number | null {
  const b = buffers.get(nodeId);
  if (!b) return null;
  const { buf } = b[key];
  return buf.length > 0 ? buf.reduce((a, c) => a + c, 0) / buf.length : null;
}

/**
 * Drop buffers for nodes no longer in the fleet roster.  Called from
 * App-level once per render with the live node id set.  Without this,
 * the Map grows unbounded as nodes churn over long sessions.
 */
export function pruneBuffers(liveNodeIds: Iterable<string>): void {
  const live = new Set(liveNodeIds);
  for (const k of buffers.keys()) {
    if (!live.has(k)) buffers.delete(k);
  }
}

/** Test helper — wipe all buffers. Not used in production code. */
export function _resetAll(): void {
  buffers.clear();
}
