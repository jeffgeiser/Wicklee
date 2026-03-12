import { useRef } from 'react';

const ROLLING_WINDOW = 5;

/**
 * Generic 5-sample rolling-average buffer.
 *
 * push(value, tsMs)
 *   • Null/undefined/NaN values are skipped — buffer unchanged, current mean returned.
 *   • tsMs is used for dedup: if the same timestamp is seen again the push is ignored.
 *     Pass 0 to skip dedup.
 *   • Returns the rolling mean, or null if the buffer is empty.
 *
 * reset()  — clears the buffer (call when the node goes offline).
 */
export function useRollingBuffer(window: number = ROLLING_WINDOW) {
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
