/**
 * useLocalMetricsStream — one shared connection to the local agent's metrics
 * broadcast, ref-counted across every component that needs it.
 *
 * Overview, NodesList, AIInsights and ModelsPage each opened their own
 * `/api/metrics` EventSource (Overview a WebSocket too), each with its own
 * retry loop. A tab switch tore one down and dialled another, and any overlap
 * doubled the agent-side subscribers for identical frames.
 *
 * Transport is Overview's original policy, moved here unchanged: WebSocket
 * `/ws` first, SSE `/api/metrics` as the fallback while WS is down, 3 s
 * retries for both. Both endpoints forward the same agent broadcast channel
 * (same JSON payload, same cadence), so consumers that used SSE receive
 * byte-identical frames — only the socket is shared.
 *
 * The connection opens on the first subscriber and closes CLOSE_GRACE_MS
 * after the last one leaves, so switching between tabs that use it keeps the
 * socket instead of reconnecting. A subscriber that joins while the stream is
 * live is handed the latest frame immediately.
 *
 * Local mode only: the hook is inert unless `enabled` (default IS_LOCAL_HOST).
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { SentinelMetrics } from '../types';
import { IS_LOCAL_HOST } from '../utils/buildTarget';

export type LocalTransport = 'ws' | 'sse';

export interface LocalStreamStatus {
  /** True from the first frame until the active transport drops. */
  connected: boolean;
  /** Transport currently delivering frames (null before the first connect). */
  transport: LocalTransport | null;
}

type FrameListener = (data: SentinelMetrics) => void;

const RETRY_MS = 3_000;
const CLOSE_GRACE_MS = 5_000;

// ── Module-level shared state ────────────────────────────────────────────────

const frameListeners = new Set<FrameListener>();
const statusListeners = new Set<() => void>();
let status: LocalStreamStatus = { connected: false, transport: null };
let latest: SentinelMetrics | null = null;
let refCount = 0;

let ws: WebSocket | null = null;
let es: EventSource | null = null;
let retryWs: ReturnType<typeof setTimeout> | undefined;
let retrySse: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let wsFailed = false;
/** False while no connection should exist; guards async onclose/onerror
 *  callbacks that land after teardown from scheduling a reconnect. */
let running = false;

function setStatus(next: Partial<LocalStreamStatus>) {
  const merged = { ...status, ...next };
  if (merged.connected === status.connected && merged.transport === status.transport) return;
  status = merged;
  statusListeners.forEach(l => l());
}

function emit(raw: string, transport: LocalTransport) {
  let data: SentinelMetrics;
  try { data = JSON.parse(raw) as SentinelMetrics; }
  catch { return; /* malformed frame */ }
  latest = data;
  setStatus({ connected: true, transport });
  frameListeners.forEach(l => l(data));
}

function connectSSE() {
  if (!running || es) return;
  if (ws?.readyState === WebSocket.OPEN) return;
  const source = new EventSource('/api/metrics');
  es = source;
  source.onopen = () => setStatus({ transport: 'sse' });
  source.onmessage = (ev) => emit(ev.data as string, 'sse');
  source.onerror = () => {
    source.close();
    if (es === source) es = null;
    if (!running) return;
    setStatus({ connected: false });
    retrySse = setTimeout(connectSSE, RETRY_MS);
  };
}

function connectWS() {
  if (!running) return;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${proto}//${window.location.host}/ws`);
  ws = socket;
  socket.onmessage = (ev) => {
    emit(ev.data as string, 'ws');
    // WS is delivering — drop the SSE fallback.
    if (es) { es.onopen = es.onmessage = es.onerror = null; es.close(); es = null; }
    clearTimeout(retrySse);
  };
  socket.onerror = () => { wsFailed = true; };
  socket.onclose = () => {
    if (ws === socket) ws = null;
    if (!running) return;
    setStatus({ connected: false });
    if (wsFailed) { connectSSE(); }
    else {
      if (!es) connectSSE();
      retryWs = setTimeout(() => { wsFailed = false; connectWS(); }, RETRY_MS);
    }
  };
}

function start() {
  running = true;
  wsFailed = false;
  connectWS();
}

function stop() {
  running = false;
  clearTimeout(retryWs);
  clearTimeout(retrySse);
  if (ws) { ws.onmessage = ws.onerror = ws.onclose = null; ws.close(); ws = null; }
  if (es) { es.onopen = es.onmessage = es.onerror = null; es.close(); es = null; }
  latest = null;
  setStatus({ connected: false, transport: null });
}

function acquire() {
  clearTimeout(closeTimer);
  closeTimer = undefined;
  refCount += 1;
  if (!running) start();
}

function release() {
  refCount = Math.max(0, refCount - 1);
  if (refCount > 0) return;
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => { if (refCount === 0) stop(); }, CLOSE_GRACE_MS);
}

function subscribeStatus(cb: () => void) {
  statusListeners.add(cb);
  return () => { statusListeners.delete(cb); };
}
const getStatus = () => status;
const INACTIVE: LocalStreamStatus = { connected: false, transport: null };
const getInactive = () => INACTIVE;

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Subscribe to local-agent metrics frames. `onFrame` is called for every frame
 * (latest identity is always used — no need to memoise it). Returns the shared
 * connection status.
 */
export function useLocalMetricsStream(
  onFrame?: FrameListener,
  enabled: boolean = IS_LOCAL_HOST,
): LocalStreamStatus {
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  useEffect(() => {
    if (!enabled) return;
    const listener: FrameListener = (d) => onFrameRef.current?.(d);
    frameListeners.add(listener);
    acquire();
    // Joining a live stream: hand over the current frame instead of waiting
    // for the next one, so a tab switch paints immediately.
    if (latest && status.connected) listener(latest);
    return () => {
      frameListeners.delete(listener);
      release();
    };
  }, [enabled]);

  return useSyncExternalStore(
    subscribeStatus,
    enabled ? getStatus : getInactive,
    getInactive,
  );
}
