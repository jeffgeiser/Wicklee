import React, { createContext, useContext, useState, useEffect, useRef, useMemo } from 'react';
import type { SentinelMetrics, FleetEvent, FleetNode, FleetStreamState, ConnectionState } from '../types';
import { getNodePowerW } from '../utils/power';

// ── Constants ────────────────────────────────────────────────────────────────

const isLocalHost =
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

const CLOUD_URL = (() => {
  const v = (import.meta.env.VITE_CLOUD_URL ?? '') as string;
  if (!v) return 'https://vibrant-fulfillment-production-62c0.up.railway.app';
  if (v === '/') return '';   // same-origin proxy mode — nginx routes /api/*
  return v.startsWith('http') ? v : `https://${v}`;
})();

const STALE_THRESHOLD_MS = 30_000;
const RETRY_MS           = 5_000;
const MAX_EVENTS         = 50;
/** Minimum duration a state must be maintained before its event is surfaced to the UI. */
const SETTLE_MS          = 60_000;
/** Power must change by this fraction (e.g. 0.3 = 30%) to trigger a power_anomaly. */
const POWER_ANOMALY_THRESHOLD = 0.30;
/** Minimum watts baseline below which power anomaly detection is suppressed (cold-start noise). */
const POWER_ANOMALY_MIN_BASELINE_W = 10;

// ── Pending-change buffer types ───────────────────────────────────────────────

/**
 * Tracks a single in-flight state transition waiting to settle.
 *
 * originalValue: value at the START of the settlement window.
 * targetValue:   most-recently observed value (updated on each frame if still drifting).
 * pendingAt:     timestamp when the original transition was first detected.
 *                NOT reset when target updates — the window started at originalValue.
 * detail:        human-readable description of the final transition (kept current).
 */
interface PendingChange {
  type:           FleetEvent['type'];
  pendingAt:      number;
  hostname:       string;
  originalValue:  string | null | boolean; // boolean for connectivity
  targetValue:    string | null | boolean;
  detail?:        string;
}

interface NodePending {
  connectivity?: PendingChange;
  thermal?:      PendingChange;
  model?:        PendingChange;
  power?:        PendingChange;
}

const uid = () => Math.random().toString(36).slice(2);

// ── Context ──────────────────────────────────────────────────────────────────

const FleetStreamContext = createContext<FleetStreamState | null>(null);

// ── Provider ─────────────────────────────────────────────────────────────────

interface FleetStreamProviderProps {
  children:          React.ReactNode;
  isSignedIn:        boolean;
  getToken:          () => Promise<string | null>;
  /** Called on every SSE frame — App.tsx uses this to patch node hostnames. */
  onNodesSnapshot?:  (nodes: FleetNode[]) => void;
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
  const [restrictedNodeIds, setRestrictedNodeIds] = useState<ReadonlySet<string>>(new Set());

  // ── Observation refs (persist across SSE frames without triggering re-render) ─
  const prevLiveRef    = useRef<Record<string, boolean>>({});
  const prevThermalRef = useRef<Record<string, string | null>>({});
  const prevModelRef   = useRef<Record<string, string | null>>({});
  const prevPowerRef   = useRef<Record<string, number | null>>({});
  /** Per-node settlement buffers. Each dimension is tracked independently. */
  const pendingRef     = useRef<Record<string, NodePending>>({});
  const esRef          = useRef<EventSource | null>(null);
  /** Per-node tok/s high-water mark (session-scoped, resets on model swap). */
  const peakTpsRef     = useRef<Record<string, number>>({});
  /** Tracks the active model per node to detect swaps that should reset the peak. */
  const peakModelRef   = useRef<Record<string, string | null>>({});
  /** Per-(nodeId, eventType) suppression: prevents the same event from firing
   *  more than once per 15 minutes for the same node. Key = "nodeId:eventType". */
  const eventSuppressionRef = useRef<Record<string, number>>({});

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
          const now   = Date.now();

          const updatedMetrics:  Record<string, SentinelMetrics> = {};
          const updatedLastSeen: Record<string, number>          = {};
          const newEvents:       FleetEvent[]                    = [];

          // Per-(nodeId, eventType) suppression — 15 min cooldown per node per event type.
          const EVENT_SUPPRESS_MS = 15 * 60_000;
          const suppression = eventSuppressionRef.current;
          const shouldSuppress = (nodeId: string, eventType: string): boolean => {
            const key = `${nodeId}:${eventType}`;
            const lastFired = suppression[key];
            if (lastFired && (now - lastFired) < EVENT_SUPPRESS_MS) return true;
            suppression[key] = now;
            return false;
          };

          for (const n of fleet.nodes) {
            const nodeId   = n.node_id;
            const hostname = n.metrics?.hostname ?? nodeId;

            updatedLastSeen[nodeId] = n.last_seen_ms;

            const isNowLive = n.metrics != null && (now - n.last_seen_ms) < STALE_THRESHOLD_MS;
            const wasLive   = prevLiveRef.current[nodeId];

            if (isNowLive && n.metrics) {
              updatedMetrics[nodeId] = n.metrics;
            }

            // ── Get or create this node's pending-change slot ─────────────
            const np: NodePending = pendingRef.current[nodeId] ?? {};

            // ── 1. CONNECTIVITY ───────────────────────────────────────────
            if (wasLive !== undefined && isNowLive !== wasLive) {
              // Observed a live-state transition on this frame.
              const type: FleetEvent['type'] = isNowLive ? 'node_online' : 'node_offline';
              if (!np.connectivity) {
                // Fresh transition — open a new settlement window.
                np.connectivity = {
                  type,
                  pendingAt:     now,
                  hostname,
                  originalValue: wasLive,
                  targetValue:   isNowLive,
                };
              } else if (np.connectivity.targetValue !== isNowLive) {
                // State flipped back (or to a third state).
                // Per spec: if node ends the window in the ORIGINAL state → cancel.
                if (isNowLive === np.connectivity.originalValue) {
                  delete np.connectivity;
                } else {
                  // Different from both original and previous target — update target, keep window.
                  np.connectivity.type        = type;
                  np.connectivity.targetValue = isNowLive;
                  np.connectivity.hostname    = hostname;
                }
              }
              // If targetValue === isNowLive: same direction as existing pending — no action.
            }

            // Check if connectivity has settled.
            if (np.connectivity) {
              const pc = np.connectivity;
              if (isNowLive === pc.targetValue) {
                if (now - pc.pendingAt >= SETTLE_MS) {
                  if (!shouldSuppress(nodeId, pc.type)) {
                    newEvents.push({ id: uid(), ts: now, type: pc.type, nodeId, hostname: pc.hostname });
                  }
                  delete np.connectivity;
                }
                // else: still in settlement window — wait.
              } else {
                // Current state no longer matches pending target; already handled update above.
                delete np.connectivity;
              }
            }

            // Remaining dimensions only apply when the node is live.
            if (isNowLive && n.metrics) {
              const curThermal = n.metrics.thermal_state ?? null;
              const curModel   = n.metrics.ollama_active_model ?? null;
              const curPower   = getNodePowerW(n.metrics);

              const prevThermal = prevThermalRef.current[nodeId];
              const prevModel   = prevModelRef.current[nodeId];
              const prevPower   = prevPowerRef.current[nodeId];

              // ── 2. THERMAL / THROTTLE ───────────────────────────────────
              if (prevThermal !== undefined && prevThermal !== curThermal) {
                const isThrottledNow = curThermal != null && ['serious', 'critical'].includes(curThermal.toLowerCase());
                const wasThrottled   = prevThermal != null && ['serious', 'critical'].includes(prevThermal.toLowerCase());
                const type: FleetEvent['type'] = isThrottledNow
                  ? 'throttle_start'
                  : wasThrottled ? 'throttle_resolved'
                  : 'thermal_change';
                const detail = prevThermal != null
                  ? `${prevThermal} → ${curThermal ?? 'unknown'}`
                  : (curThermal ?? '');

                if (!np.thermal) {
                  np.thermal = {
                    type,
                    pendingAt:     now,
                    hostname,
                    originalValue: prevThermal,
                    targetValue:   curThermal,
                    detail,
                  };
                } else if (np.thermal.targetValue !== curThermal) {
                  if (curThermal === np.thermal.originalValue) {
                    // Reverted to original — cancel.
                    delete np.thermal;
                  } else {
                    // Further change — update target + detail, keep original window.
                    np.thermal.type        = type;
                    np.thermal.targetValue = curThermal;
                    np.thermal.detail      = `${np.thermal.originalValue ?? 'unknown'} → ${curThermal ?? 'unknown'}`;
                    np.thermal.hostname    = hostname;
                  }
                }
              }

              if (np.thermal) {
                const pt = np.thermal;
                if (curThermal === pt.targetValue && now - pt.pendingAt >= SETTLE_MS) {
                  if (!shouldSuppress(nodeId, pt.type)) {
                    newEvents.push({ id: uid(), ts: now, type: pt.type, nodeId, hostname: pt.hostname, detail: pt.detail });
                  }
                  delete np.thermal;
                } else if (curThermal !== pt.targetValue) {
                  // Already updated above; if target still differs, the new pending was set.
                  // Only cancel here if we didn't set a new pending (i.e. reverted to original).
                  if (!np.thermal || np.thermal.targetValue !== curThermal) delete np.thermal;
                }
              }

              // ── 3. MODEL SWAP ─────────────────────────────────────────────
              if (
                prevModel !== undefined &&
                prevModel !== curModel &&
                curModel != null &&          // only log when a model is actually loaded
                prevModel != null            // only log swaps, not initial model load
              ) {
                const detail = `${prevModel} → ${curModel}`;
                if (!np.model) {
                  np.model = {
                    type:          'model_swap',
                    pendingAt:     now,
                    hostname,
                    originalValue: prevModel,
                    targetValue:   curModel,
                    detail,
                  };
                } else if (np.model.targetValue !== curModel) {
                  if (curModel === np.model.originalValue) {
                    delete np.model;
                  } else {
                    np.model.targetValue = curModel;
                    np.model.detail      = `${np.model.originalValue ?? 'unknown'} → ${curModel}`;
                    np.model.hostname    = hostname;
                  }
                }
              }

              if (np.model) {
                const pm = np.model;
                if (curModel === pm.targetValue && now - pm.pendingAt >= SETTLE_MS) {
                  if (!shouldSuppress(nodeId, 'model_swap')) {
                    newEvents.push({ id: uid(), ts: now, type: 'model_swap', nodeId, hostname: pm.hostname, detail: pm.detail });
                  }
                  delete np.model;
                } else if (curModel !== pm.targetValue && (!np.model || np.model.targetValue !== curModel)) {
                  delete np.model;
                }
              }

              // ── 4. POWER ANOMALY ──────────────────────────────────────────
              if (
                prevPower !== undefined &&
                prevPower != null &&
                curPower  != null &&
                prevPower >= POWER_ANOMALY_MIN_BASELINE_W &&
                Math.abs(curPower - prevPower) / prevPower >= POWER_ANOMALY_THRESHOLD
              ) {
                const direction = curPower > prevPower ? '↑' : '↓';
                const detail    = `${prevPower.toFixed(0)}W ${direction} ${curPower.toFixed(0)}W`;
                if (!np.power) {
                  np.power = {
                    type:          'power_anomaly',
                    pendingAt:     now,
                    hostname,
                    originalValue: `${prevPower.toFixed(0)}`,
                    targetValue:   `${curPower.toFixed(0)}`,
                    detail,
                  };
                } else {
                  // Update to latest reading.
                  np.power.targetValue = `${curPower.toFixed(0)}`;
                  np.power.detail      = `${np.power.originalValue}W ${direction} ${curPower.toFixed(0)}W`;
                  np.power.hostname    = hostname;
                }
              } else if (np.power) {
                // Power has normalised — cancel pending anomaly.
                if (
                  curPower == null ||
                  prevPower == null ||
                  prevPower < POWER_ANOMALY_MIN_BASELINE_W ||
                  Math.abs(curPower - prevPower) / (prevPower || 1) < POWER_ANOMALY_THRESHOLD
                ) {
                  delete np.power;
                }
              }

              if (np.power && now - np.power.pendingAt >= SETTLE_MS) {
                const pp = np.power;
                if (!shouldSuppress(nodeId, 'power_anomaly')) {
                  newEvents.push({ id: uid(), ts: now, type: 'power_anomaly', nodeId, hostname: pp.hostname, detail: pp.detail });
                }
                delete np.power;
              }

              // ── 5. PEAK TPS ───────────────────────────────────────────────
              // Track per-node tok/s high-water mark for throughput estimation.
              // Covers both Ollama and vLLM; reset on model swap so the baseline
              // stays relevant to the currently loaded model.
              const rawTpsForPeak   = (n.metrics.ollama_tokens_per_second ?? n.metrics.vllm_tokens_per_sec) ?? null;
              const curModelForPeak = n.metrics.ollama_active_model ?? n.metrics.vllm_model_name ?? null;

              if (peakModelRef.current[nodeId] !== undefined &&
                  peakModelRef.current[nodeId] !== curModelForPeak) {
                // Model changed — old peak is irrelevant to the new model.
                delete peakTpsRef.current[nodeId];
              }
              peakModelRef.current[nodeId] = curModelForPeak;

              if (rawTpsForPeak != null && rawTpsForPeak > 0 &&
                  rawTpsForPeak > (peakTpsRef.current[nodeId] ?? 0)) {
                peakTpsRef.current[nodeId] = rawTpsForPeak;
              }

              // ── Advance observation refs ──────────────────────────────────
              prevThermalRef.current[nodeId] = curThermal;
              prevModelRef.current[nodeId]   = curModel;
              prevPowerRef.current[nodeId]   = curPower;
            }

            // Save updated pending slot (or remove if empty).
            if (Object.keys(np).length > 0) {
              pendingRef.current[nodeId] = np;
            } else {
              delete pendingRef.current[nodeId];
            }

            prevLiveRef.current[nodeId] = isNowLive;
          }

          // ── Batch state updates ─────────────────────────────────────────
          setLastSeenMsMap(prev => ({ ...prev, ...updatedLastSeen }));

          if (Object.keys(updatedMetrics).length > 0) {
            setAllNodeMetrics(prev => ({ ...prev, ...updatedMetrics }));
            setLastTelemetryMs(now);
          }

          if (newEvents.length > 0) {
            setFleetEvents(prev => [...newEvents, ...prev].slice(0, MAX_EVENTS));
          }

          // Derive restricted node set from the latest snapshot.
          const newRestrictedIds = new Set(
            fleet.nodes.filter(n => n.restricted).map(n => n.node_id)
          );
          setRestrictedNodeIds(newRestrictedIds);

          // Notify App.tsx so it can patch node hostnames.
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

  // ── Seed fleet events from DuckDB history on initial connect ──────────────
  const seededRef = useRef(false);

  useEffect(() => {
    if (isLocalHost || !connected || seededRef.current) return;
    seededRef.current = true;

    (async () => {
      try {
        const jwt = await getToken();
        if (!jwt) return;
        const res = await fetch(`${CLOUD_URL}/api/fleet/events/history?limit=50`, {
          headers: { Authorization: `Bearer ${jwt}` },
        });
        if (!res.ok) return;
        const data = await res.json() as {
          events: Array<{
            ts_ms:      number;
            node_id:    string;
            level:      string;
            event_type: string | null;
            message:    string;
          }>;
        };
        if (!data.events?.length) return;

        // Map DB event_type → FleetEvent type. Only seed events we have
        // explicit display support for — unrecognized types (startup, update,
        // etc.) are skipped to avoid flooding Live Activity with generic entries.
        const EVENT_TYPE_MAP: Record<string, FleetEvent['type']> = {
          node_online:    'node_online',
          node_offline:   'node_offline',
          model_swap:     'model_swap',
          thermal_change: 'thermal_change',
          power_anomaly:  'power_anomaly',
          // Observation onset
          zombied_engine:          'zombied_engine',
          thermal_redline:         'thermal_redline',
          oom_warning:             'oom_warning',
          wes_cliff:               'wes_cliff',
          agent_version_mismatch:  'agent_version_mismatch',
          // Observation resolved
          zombied_engine_resolved:         'zombied_engine_resolved',
          thermal_redline_resolved:        'thermal_redline_resolved',
          oom_warning_resolved:            'oom_warning_resolved',
          wes_cliff_resolved:              'wes_cliff_resolved',
          agent_version_mismatch_resolved: 'agent_version_mismatch_resolved',
        };
        const seeded: FleetEvent[] = data.events
          .filter(row => {
            if (row.level === 'error') return true;
            return row.event_type != null && row.event_type in EVENT_TYPE_MAP;
          })
          .map(row => ({
            id:       `seed-${row.ts_ms}-${row.node_id}`,
            ts:       row.ts_ms,
            type:     row.level === 'error' ? 'error' as const : EVENT_TYPE_MAP[row.event_type!],
            nodeId:   row.node_id,
            detail:   row.message,
          }));

        setFleetEvents(prev => {
          const existingIds = new Set(prev.map(e => e.id));
          const fresh = seeded.filter(e => !existingIds.has(e.id));
          return [...prev, ...fresh].sort((a, b) => b.ts - a.ts).slice(0, MAX_EVENTS);
        });
      } catch { /* historical events are best-effort */ }
    })();
  }, [connected, getToken]);

  // ── 5-second tick for stale detection ──────────────────────────────────────
  const [, setTick] = useState(0);
  useEffect(() => {
    if (isLocalHost) return;
    const id = setInterval(() => setTick(t => t + 1), 5_000);
    return () => clearInterval(id);
  }, []);

  // ── Derive connectionState ─────────────────────────────────────────────────
  const nowMs    = Date.now();
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
  const addFleetEvent = React.useCallback((event: FleetEvent) => {
    setFleetEvents(prev => [event, ...prev].slice(0, MAX_EVENTS));
  }, []);

  const value = useMemo<FleetStreamState>(() => ({
    allNodeMetrics,
    lastSeenMsMap,
    // Snapshot the peak ref on every render — since allNodeMetrics changes every
    // SSE frame, the memo always re-runs and peaks stay current without extra state.
    peakTpsMap: { ...peakTpsRef.current },
    fleetEvents,
    addFleetEvent,
    connected,
    transport,
    lastTelemetryMs,
    connectionState,
    restrictedNodeIds,
  }), [allNodeMetrics, lastSeenMsMap, fleetEvents, addFleetEvent, connected, transport, lastTelemetryMs, connectionState, restrictedNodeIds]);

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
