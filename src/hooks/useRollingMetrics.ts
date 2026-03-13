import { useRef } from 'react';

/**
 * Smoothing windows — two tiers:
 *
 *  NODE_ROLLING_WINDOW (8)   — per-node row metrics (tps, watts, gpu%).
 *    Responsive enough to track fast hardware changes while suppressing
 *    single-probe noise.
 *
 *  FLEET_ROLLING_WINDOW (12) — top-of-page fleet InsightTiles (fleet tok/s,
 *    fleet WES, $/1M, W/1k). These are the most visible numbers and the
 *    most volatile (tok/s is only sampled every 30 s), so a longer window
 *    keeps them calm without losing the live feel across ~2 probe cycles.
 *
 *  Steadier fleet metrics (raw watts, power-cost cards) use the node
 *  window (8) since they don't need extra damping.
 */
export const NODE_ROLLING_WINDOW  = 8;
export const FLEET_ROLLING_WINDOW = 12;

/** @deprecated use NODE_ROLLING_WINDOW or FLEET_ROLLING_WINDOW */
const ROLLING_WINDOW = NODE_ROLLING_WINDOW;

/**
 * Generic rolling-average buffer.
 *
 * push(value, tsMs)
 *   • Null/undefined/NaN values are skipped — buffer unchanged, current mean returned.
 *   • tsMs is used for dedup: if the same timestamp is seen again the push is ignored.
 *     Pass 0 to skip dedup.
 *   • Returns the rolling mean, or null if the buffer is empty.
 *
 * reset()  — clears the buffer (call when the node goes offline).
 */
export function useRollingBuffer(window: number = NODE_ROLLING_WINDOW) {
  const state = useRef<{ buf: number[]; lastTs: number }>({ buf: [], lastTs: 0 });

  function push(value: number | null | undefined, tsMs = 0): number | null {
    const s = state.current;
    if (value != null && isFinite(value)) {
      // Dedup: skip if this timestamp has already been pushed
      if (!(tsMs > 0 && tsMs <= s.lastTs)) {
        if (tsMs > 0) s.lastTs = tsMs;
        s.buf =
          s.buf.length < window
            ? [...s.buf, value]
            : [...s.buf.slice(1), value];
      }
    }
    const b = s.buf;
    return b.length > 0 ? b.reduce((a, c) => a + c, 0) / b.length : null;
  }

  function reset() {
    state.current = { buf: [], lastTs: 0 };
  }

  return { push, reset };
}

/**
 * Per-node rolling-average hook that maintains three keyed buffers:
 *   'tps'   — ollama_tokens_per_second
 *   'watts' — total power draw (cpu + gpu)
 *   'gpu'   — GPU utilisation %
 *
 * pushOne(key, value, tsMs) — same semantics as useRollingBuffer.push
 * resetAll()               — clear all three buffers (call on node offline).
 */
export function useNodeRollingMetrics() {
  const stateRef = useRef<{
    tps:   { buf: number[]; lastTs: number };
    watts: { buf: number[]; lastTs: number };
    gpu:   { buf: number[]; lastTs: number };
  }>({
    tps:   { buf: [], lastTs: 0 },
    watts: { buf: [], lastTs: 0 },
    gpu:   { buf: [], lastTs: 0 },
  });

  function pushOne(
    key: 'tps' | 'watts' | 'gpu',
    value: number | null | undefined,
    tsMs = 0,
  ): number | null {
    const s = stateRef.current[key];
    if (value != null && isFinite(value)) {
      if (!(tsMs > 0 && tsMs <= s.lastTs)) {
        if (tsMs > 0) s.lastTs = tsMs;
        s.buf =
          s.buf.length < ROLLING_WINDOW
            ? [...s.buf, value]
            : [...s.buf.slice(1), value];
      }
    }
    const b = s.buf;
    return b.length > 0 ? b.reduce((a, c) => a + c, 0) / b.length : null;
  }

  function resetAll() {
    stateRef.current = {
      tps:   { buf: [], lastTs: 0 },
      watts: { buf: [], lastTs: 0 },
      gpu:   { buf: [], lastTs: 0 },
    };
  }

  return { pushOne, resetAll };
}
