import React, { createContext, useContext, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { SentinelMetrics, FleetEvent, FleetNode, FleetStreamState, ConnectionState } from '../types';

// ── Constants ────────────────────────────────────────────────────────────────

const isLocalHost =
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

const CLOUD_URL = (() => {
  const v = (import.meta.env.VITE_CLOUD_URL ?? '') as string;
  return !v
    ? 'https://vibrant-fulfillment-production-62c0.up.railway.app'
    : v.startsWith('http') ? v : `https://${v}`;
})();

const STALE_THRESHOLD_MS = 30_000;
const RETRY_MS = 5_000;
const MAX_EVENTS = 50;

// ── Context ──────────────────────────────────────────────────────────────────

const FleetStreamContext = createContext<FleetStreamState | null>(null);

// ── Provider ─────────────────────────────────────────────────────────────────

interface FleetStreamProviderProps {
  children: React.ReactNode;
  isSignedIn: boolean;
  getToken: () => Promise<string | null>;
  /** Called on every SSE frame — App.tsx uses this to patch node hostnames. */
  onNodesSnapshot?: (nodes: FleetNode[]) => void;
}

export const FleetStreamProvider: React.FC<FleetStreamProviderProps> = ({
  children,
  isSignedIn,
  getToken,
  onNodesSnapshot,
}) => {
  // ── State ──────────────────────────────────────────────────────────────────
  const [allNodeMetrics, setAllNodeMetrics] = useState<Record<string, SentinelMetrics>>({});
  const [lastSeenMsMap, setLastSeenMsMap]   = useState<Record<string, number>>({});
  const [fleetEvents, setFleetEvents]       = useState<FleetEvent[]>([]);
  const [connected, setConnected]           = useState(false);
  const [transport, setTransport]           = useState<'sse' | null>(null);
  const [lastTelemetryMs, setLastTelemetryMs] = useState<number | null>(null);

  // ── Refs for event detection (moved from Overview.tsx) ─────────────────────
  const prevLiveRef    = useRef<Record<string, boolean>>({});
  const prevThermalRef = useRef<Record<string, string | null>>({});
  const esRef          = useRef<EventSource | null>(null);

  // Stable ref for the snapshot callback so the SSE effect doesn't re-run.
  const onNodesSnapshotRef = useRef(onNodesSnapshot);
  onNodesSnapshotRef.current = onNodesSnapshot;

  // ── SSE Effect ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (isLocalHost || !isSignedIn) return;

    let retryTimer: ReturnType<typeof setTimeout>;
    let cancelled = false;

    const connect = async () => {
      if (cancelled) return;

      // 1. Fetch stream token
      let streamToken: string;
      try {
        const jwt = await getToken();
        if (!jwt || cancelled) { retryTimer = setTimeout(connect, RETRY_MS); return; }
        const res = await fetch(`${CLOUD_URL}/api/auth/stream-token`, {
          headers: { Authorization: `Bearer ${jwt}` },
        });
        if (!res.ok || cancelled) { retryTimer = setTimeout(connect, RETRY_MS); return; }
        streamToken = (await res.json()).stream_token;
      } catch {
        if (!cancelled) retryTimer = setTimeout(connect, RETRY_MS);
        return;
      }

      if (cancelled) return;

      // 2. Open EventSource
      const es = new EventSource(
        `${CLOUD_URL}/api/fleet/stream?token=${encodeURIComponent(streamToken)}`,
      );
      esRef.current = es;

      es.onopen = () => {
        setConnected(true);
        setTransport('sse');
      };

      es.onmessage = (ev) => {
        try {
          const fleet = JSON.parse(ev.data) as { nodes: FleetNode[] };
          const now = Date.now();

          const updatedMetrics: Record<string, SentinelMetrics> = {};
          const updatedLastSeen: Record<string, number> = {};
          const newEvents: FleetEvent[] = [];

          for (const n of fleet.nodes) {
            updatedLastSeen[n.node_id] = n.last_seen_ms;

            const isNowLive = n.metrics != null && (now - n.last_seen_ms) < STALE_THRESHOLD_MS;
            const wasLive = prevLiveRef.current[n.node_id];

            if (isNowLive && n.metrics) {
              updatedMetrics[n.node_id] = n.metrics;

              if (wasLive === false) {
                // Node came back online
                newEvents.push({
                  id: Math.random().toString(36).slice(2),
                  ts: now,
                  type: 'node_online',
                  nodeId: n.node_id,
                  hostname: n.metrics.hostname ?? n.node_id,
                });
              } else if (wasLive === true) {
                // Check thermal change
                const prevThermal = prevThermalRef.current[n.node_id];
                const curThermal = n.metrics.thermal_state;
                if (prevThermal !== undefined && prevThermal !== curThermal && curThermal != null) {
                  newEvents.push({
                    id: Math.random().toString(36).slice(2),
                    ts: now,
                    type: 'thermal_change',
                    nodeId: n.node_id,
                    hostname: n.metrics.hostname ?? n.node_id,
                    detail: prevThermal != null ? `${prevThermal} → ${curThermal}` : curThermal ?? '',
                  });
                }
              }
              prevThermalRef.current[n.node_id] = n.metrics.thermal_state;
            } else if (!isNowLive && wasLive === true) {
              // Node went offline
              newEvents.push({
                id: Math.random().toString(36).slice(2),
                ts: now,
                type: 'node_offline',
                nodeId: n.node_id,
                hostname: n.metrics?.hostname ?? n.node_id,
              });
            }
            prevLiveRef.current[n.node_id] = isNowLive;
          }

          // Batch state updates
          setLastSeenMsMap(prev => ({ ...prev, ...updatedLastSeen }));

          if (Object.keys(updatedMetrics).length > 0) {
            setAllNodeMetrics(prev => ({ ...prev, ...updatedMetrics }));
            setLastTelemetryMs(now);
          }

          if (newEvents.length > 0) {
            setFleetEvents(prev => [...newEvents, ...prev].slice(0, MAX_EVENTS));
          }

          // Notify App.tsx so it can patch node hostnames
          onNodesSnapshotRef.current?.(fleet.nodes);
        } catch { /* malformed frame */ }
      };

      es.onerror = () => {
        es.close();
        esRef.current = null;
        setConnected(false);
        if (!cancelled) retryTimer = setTimeout(connect, RETRY_MS);
      };
    };

    connect();

    return () => {
      cancelled = true;
      esRef.current?.close();
      esRef.current = null;
      clearTimeout(retryTimer);
    };
  }, [isSignedIn, getToken]);

  // ── 5-second tick for stale detection ──────────────────────────────────────
  const [, setTick] = useState(0);
  useEffect(() => {
    if (isLocalHost) return;
    const id = setInterval(() => setTick(t => t + 1), 5_000);
    return () => clearInterval(id);
  }, []);

  // ── Derive connectionState ─────────────────────────────────────────────────
  const nowMs = Date.now();
  const hasNodes = Object.keys(allNodeMetrics).length > 0;
  const allStale = Object.keys(lastSeenMsMap).length > 0 &&
    Object.values(lastSeenMsMap).every((t: number) => nowMs - t > STALE_THRESHOLD_MS);

  const connectionState: ConnectionState = !connected
    ? 'disconnected'
    : !hasNodes
    ? 'idle'
    : allStale
    ? 'degraded'
    : 'connected';

  // ── Memoised context value ─────────────────────────────────────────────────
  const value = useMemo<FleetStreamState>(() => ({
    allNodeMetrics,
    lastSeenMsMap,
    fleetEvents,
    connected,
    transport,
    lastTelemetryMs,
    connectionState,
  }), [allNodeMetrics, lastSeenMsMap, fleetEvents, connected, transport, lastTelemetryMs, connectionState]);

  return (
    <FleetStreamContext.Provider value={value}>
      {children}
    </FleetStreamContext.Provider>
  );
};

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useFleetStream(): FleetStreamState {
  const ctx = useContext(FleetStreamContext);
  if (!ctx) throw new Error('useFleetStream must be used within FleetStreamProvider');
  return ctx;
}
