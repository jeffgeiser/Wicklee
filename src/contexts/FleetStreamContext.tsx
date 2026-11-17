import React, { createContext, useContext, useState, useEffect, useRef, useMemo } from 'react';
import type { SentinelMetrics, FleetEvent, FleetNode, FleetStreamState, ConnectionState } from '../types';
import { getNodePowerW } from '../utils/power';
import { CLOUD_URL } from '../utils/cloudUrl';

const isLocalHost =
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

const STALE_THRESHOLD_MS = 30_000;
const RETRY_MS           = 5_000;
const MAX_EVENTS         = 50;
/** Minimum duration a state must be maintained before its event is surfaced to the UI. */
const SETTLE_MS          = 60_000;
/** Power must change by this fraction (e.g. 0.3 = 30%) to trigger a power_anomaly. */
const POWER_ANOMALY_THRESHOLD = 0.30;
/** Minimum watts baseline below which power anomaly detection is suppressed (cold-start noise). */
const POWER_ANOMALY_MIN_BASELINE_W = 10;

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
  originalValue:  string | null | boolean;
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

const FleetStreamContext = createContext<FleetStreamState | null>(null);

interface FleetStreamProviderProps {
  children:          React.ReactNode;
  isSignedIn:        boolean;
  getToken:          () => Promise<string | null>;
  /** Clerk organization ID — included in stream token request for shared fleet access. */
  orgId?:            string | null;
  /** Called on every SSE frame — App.tsx uses this to patch node hostnames. */
  onNodesSnapshot?:  (nodes: FleetNode[]) => void;
}

export const FleetStreamProvider: React.FC<FleetStreamProviderProps> = ({
  children,
  isSignedIn,
  getToken,
  orgId,
  onNodesSnapshot,
}) => {
  const [allNodeMetrics, setAllNodeMetrics] = useState<Record<string, SentinelMetrics>>({});
  const [lastSeenMsMap, setLastSeenMsMap]   = useState<Record<string, number>>({});
  const [fleetEvents, setFleetEvents]       = useState<FleetEvent[]>([]);
  const [connected, setConnected]           = useState(false);
  const [transport, setTransport]           = useState<'sse' | null>(null);
  const [lastTelemetryMs, setLastTelemetryMs] = useState<number | null>(null);
  const [restrictedNodeIds, setRestrictedNodeIds] = useState<ReadonlySet<string>>(new Set());

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

  /** Guards the one-shot DuckDB history seed (reset on fleet scope change). */
  const seededRef      = useRef(false);
  /** Bumped on every fleet scope change so in-flight async work from the
   *  previous org/session can tell it is stale and drop its result. */
  const scopeGenRef    = useRef(0);

  const onNodesSnapshotRef = useRef(onNodesSnapshot);
  onNodesSnapshotRef.current = onNodesSnapshot;

  const scopeKey = `${isSignedIn ? 1 : 0}:${orgId ?? ''}`;
  const prevScopeKeyRef = useRef(scopeKey);
  useEffect(() => {
    if (prevScopeKeyRef.current === scopeKey) return;
    prevScopeKeyRef.current = scopeKey;
    scopeGenRef.current += 1;

    setAllNodeMetrics({});
    setLastSeenMsMap({});
    setFleetEvents([]);
    setConnected(false);
    setTransport(null);
    setLastTelemetryMs(null);
    setRestrictedNodeIds(new Set());

    prevLiveRef.current         = {};
    prevThermalRef.current      = {};
    prevModelRef.current        = {};
    prevPowerRef.current        = {};
    pendingRef.current          = {};
    peakTpsRef.current          = {};
    peakModelRef.current        = {};
    eventSuppressionRef.current = {};
    seededRef.current           = false;
  }, [scopeKey]);

  useEffect(() => {
    if (isLocalHost || !isSignedIn) return;

    let retryTimer: ReturnType<typeof setTimeout>;
    let cancelled = false;

    const connect = async () => {
      if (cancelled) return;

      let streamToken: string;
      try {
        const jwt = await getToken();
        if (!jwt || cancelled) { retryTimer = setTimeout(connect, RETRY_MS); return; }
        const hdrs: Record<string, string> = { Authorization: `Bearer ${jwt}` };
        if (orgId) hdrs['X-Org-Id'] = orgId;
        const res = await fetch(`${CLOUD_URL}/api/auth/stream-token`, { headers: hdrs });
        if (!res.ok || cancelled) { retryTimer = setTimeout(connect, RETRY_MS); return; }
        streamToken = (await res.json()).stream_token;
      } catch {
        if (!cancelled) retryTimer = setTimeout(connect, RETRY_MS);
        return;
      }

      if (cancelled) return;

      const es: EventSource = new EventSource(
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
            const hostname = n.display_name ?? n.metrics?.hostname ?? nodeId;

            updatedLastSeen[nodeId] = n.last_seen_ms;

            const isNowLive = n.metrics != null && (now - n.last_seen_ms) < STALE_THRESHOLD_MS;
            const wasLive   = prevLiveRef.current[nodeId];

            if (isNowLive && n.metrics) {
              const patched = { ...n.metrics, hostname: hostname, tags: n.tags ?? null };
              updatedMetrics[nodeId] = patched;
            }

            const np: NodePending = pendingRef.current[nodeId] ?? {};

            if (wasLive !== undefined && isNowLive !== wasLive) {
              const type: FleetEvent['type'] = isNowLive ? 'node_online' : 'node_offline';
              if (!np.connectivity) {
                np.connectivity = {
                  type,
                  pendingAt:     now,
                  hostname,
                  originalValue: wasLive,
                  targetValue:   isNowLive,
                };
              } else if (np.connectivity.targetValue !== isNowLive) {
                if (isNowLive === np.connectivity.originalValue) {
                  delete np.connectivity;
                } else {
                  np.connectivity.type        = type;
                  np.connectivity.targetValue = isNowLive;
                  np.connectivity.hostname    = hostname;
                }
              }
            }

            if (np.connectivity) {
              const pc = np.connectivity;
              if (isNowLive === pc.targetValue) {
                if (now - pc.pendingAt >= SETTLE_MS) {
                  if (!shouldSuppress(nodeId, pc.type)) {
                    newEvents.push({ id: uid(), ts: now, type: pc.type, nodeId, hostname: pc.hostname });
                  }
                  delete np.connectivity;
                }
              } else {
                delete np.connectivity;
              }
            }

            if (isNowLive && n.metrics) {
              const curThermal = n.metrics.thermal_state ?? null;
              const curModel   = n.metrics.ollama_active_model ?? null;
              const curPower   = getNodePowerW(n.metrics);

              const prevThermal = prevThermalRef.current[nodeId];
              const prevModel   = prevModelRef.current[nodeId];
              const prevPower   = prevPowerRef.current[nodeId];

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
                    delete np.thermal;
                  } else {
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
                  if (!np.thermal || np.thermal.targetValue !== curThermal) delete np.thermal;
                }
              }

              if (
                prevModel !== undefined &&
                prevModel !== curModel &&
                curModel != null &&
                prevModel != null
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

              const powerBaseline = np.power ? Number(np.power.originalValue) : prevPower;
              if (
                powerBaseline != null &&
                curPower      != null &&
                powerBaseline >= POWER_ANOMALY_MIN_BASELINE_W &&
                Math.abs(curPower - powerBaseline) / powerBaseline >= POWER_ANOMALY_THRESHOLD
              ) {
                const direction = curPower > powerBaseline ? '↑' : '↓';
                if (!np.power) {
                  np.power = {
                    type:          'power_anomaly',
                    pendingAt:     now,
                    hostname,
                    originalValue: `${powerBaseline.toFixed(0)}`,
                    targetValue:   `${curPower.toFixed(0)}`,
                    detail:        `${powerBaseline.toFixed(0)}W ${direction} ${curPower.toFixed(0)}W`,
                  };
                } else {
                  np.power.targetValue = `${curPower.toFixed(0)}`;
                  np.power.detail      = `${np.power.originalValue}W ${direction} ${curPower.toFixed(0)}W`;
                  np.power.hostname    = hostname;
                }
              } else if (np.power) {
                delete np.power;
              }

              if (np.power && now - np.power.pendingAt >= SETTLE_MS) {
                const pp = np.power;
                if (!shouldSuppress(nodeId, 'power_anomaly')) {
                  newEvents.push({ id: uid(), ts: now, type: 'power_anomaly', nodeId, hostname: pp.hostname, detail: pp.detail });
                }
                delete np.power;
              }

              const rawTpsForPeak   = (n.metrics.ollama_tokens_per_second ?? n.metrics.vllm_tokens_per_sec) ?? null;
              const curModelForPeak = n.metrics.ollama_active_model ?? n.metrics.vllm_model_name ?? null;

              if (peakModelRef.current[nodeId] !== undefined &&
                  peakModelRef.current[nodeId] !== curModelForPeak) {
                delete peakTpsRef.current[nodeId];
              }
              peakModelRef.current[nodeId] = curModelForPeak;

              if (rawTpsForPeak != null && rawTpsForPeak > 0 &&
                  rawTpsForPeak > (peakTpsRef.current[nodeId] ?? 0)) {
                peakTpsRef.current[nodeId] = rawTpsForPeak;
              }

              prevThermalRef.current[nodeId] = curThermal;
              prevModelRef.current[nodeId]   = curModel;
              prevPowerRef.current[nodeId]   = curPower;
            }

            if (Object.keys(np).length > 0) {
              pendingRef.current[nodeId] = np;
            } else {
              delete pendingRef.current[nodeId];
            }

            prevLiveRef.current[nodeId] = isNowLive;
          }

          const present = new Set(fleet.nodes.map(n => n.node_id));
          for (const ref of [prevLiveRef, prevThermalRef, prevModelRef, prevPowerRef, pendingRef, peakTpsRef, peakModelRef]) {
            for (const id of Object.keys(ref.current)) {
              if (!present.has(id)) delete ref.current[id];
            }
          }
          for (const key of Object.keys(suppression)) {
            if (!present.has(key.slice(0, key.lastIndexOf(':')))) delete suppression[key];
          }
          const prunePrev = <T,>(prev: Record<string, T>): Record<string, T> => {
            if (Object.keys(prev).every(id => present.has(id))) return prev;
            const out: Record<string, T> = {};
            for (const [id, v] of Object.entries(prev)) if (present.has(id)) out[id] = v;
            return out;
          };

          setLastSeenMsMap(updatedLastSeen);

          setAllNodeMetrics(prev => {
            const kept = prunePrev(prev);
            if (kept === prev && Object.keys(updatedMetrics).length === 0) return prev;
            return { ...kept, ...updatedMetrics };
          });
          if (Object.keys(updatedMetrics).length > 0) setLastTelemetryMs(now);

          if (newEvents.length > 0) {
            setFleetEvents(prev => [...newEvents, ...prev].slice(0, MAX_EVENTS));
          }

          const newRestrictedIds = new Set(
            fleet.nodes.filter(n => n.restricted).map(n => n.node_id)
          );
          setRestrictedNodeIds(prev =>
            prev.size === newRestrictedIds.size && [...newRestrictedIds].every(id => prev.has(id))
              ? prev
              : newRestrictedIds
          );

          onNodesSnapshotRef.current?.(fleet.nodes);
        } catch { }
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
  }, [isSignedIn, getToken, orgId]);

  useEffect(() => {
    if (isLocalHost || !connected || seededRef.current) return;
    seededRef.current = true;
    const gen = scopeGenRef.current;

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
        if (!data.events?.length || gen !== scopeGenRef.current) return;

        const EVENT_TYPE_MAP: Record<string, FleetEvent['type']> = {
          node_online:    'node_online',
          node_offline:   'node_offline',
          model_swap:     'model_swap',
          thermal_change: 'thermal_change',
          power_anomaly:  'power_anomaly',
          zombied_engine:          'zombied_engine',
          thermal_redline:         'thermal_redline',
          oom_warning:             'oom_warning',
          wes_cliff:               'wes_cliff',
          agent_version_mismatch:  'agent_version_mismatch',
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
      } catch { }
    })();
  }, [connected, getToken]);

  const [, setTick] = useState(0);
  useEffect(() => {
    if (isLocalHost) return;
    const id = setInterval(() => setTick(t => t + 1), 5_000);
    return () => clearInterval(id);
  }, []);

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

  const addFleetEvent = React.useCallback((event: FleetEvent) => {
    setFleetEvents(prev => [event, ...prev].slice(0, MAX_EVENTS));
  }, []);

  const value = useMemo<FleetStreamState>(() => ({
    allNodeMetrics,
    lastSeenMsMap,
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

export function useFleetStream(): FleetStreamState {
  const ctx = useContext(FleetStreamContext);
  if (!ctx) throw new Error('useFleetStream must be used within FleetStreamProvider');
  return ctx;
}
