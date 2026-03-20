/**
 * useLocalEvents — single-node event watcher for local (Cockpit) mode.
 *
 * Mirrors the four event dimensions in FleetStreamContext but operates on the
 * single SentinelMetrics stream from the local agent instead of a fleet SSE.
 *
 * Sources:
 *   1. Delta watcher   — thermal changes, model swaps, power anomalies, connectivity.
 *   2. live_activities — system-level events embedded in MetricsPayload by the agent
 *                        (startup, service restart, update installed, etc.).
 *
 * The hook is intentionally stateless w.r.t. persistence — the live feed is
 * in-memory only. DuckDB history is a separate agent-side concern (Observability tab).
 */

import { useRef, useState, useEffect } from 'react';
import type { SentinelMetrics, FleetEvent, LiveActivityEvent } from '../types';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_EVENTS = 50;

/**
 * Minimum duration (ms) a state must be maintained before its event surfaces.
 * Suppresses transient noise — same value as FleetStreamContext.
 */
const SETTLE_MS = 60_000;

/** Power must shift by this fraction to trigger a power_anomaly event. */
const POWER_ANOMALY_THRESHOLD = 0.30;

/** Minimum watts baseline below which power anomaly detection is suppressed. */
const POWER_ANOMALY_MIN_BASELINE_W = 10;

// ── Types ─────────────────────────────────────────────────────────────────────

interface PendingChange {
  type:          FleetEvent['type'];
  pendingAt:     number;
  originalValue: string | null | boolean;
  targetValue:   string | null | boolean;
  detail?:       string;
}

interface LocalPending {
  connectivity?: PendingChange;
  thermal?:      PendingChange;
  model?:        PendingChange;
  power?:        PendingChange;
}

const uid = () => Math.random().toString(36).slice(2);

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * @param sentinel  Latest SentinelMetrics from the local agent, or null when offline.
 * @param connected Whether the local WS/SSE connection is active.
 */
export function useLocalEvents(
  sentinel:  SentinelMetrics | null,
  connected: boolean,
): FleetEvent[] {
  const [events, setEvents] = useState<FleetEvent[]>([]);

  // ── Observation refs — previous frame values ──────────────────────────────
  const prevConnected  = useRef<boolean | undefined>(undefined);
  const prevThermal    = useRef<string | null | undefined>(undefined);
  const prevModel      = useRef<string | null | undefined>(undefined);
  const prevPower      = useRef<number | null | undefined>(undefined);
  const pending        = useRef<LocalPending>({});

  // Deduplicate live_activity events — track seen timestamp+message pairs.
  const seenActivityIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (sentinel == null && !connected) return;

    const now      = Date.now();
    const nodeId   = sentinel?.node_id ?? 'local';
    const hostname = sentinel?.hostname ?? nodeId;
    const newEvents: FleetEvent[] = [];
    const np = pending.current;

    // ── Source 1: live_activities embedded in the payload ─────────────────
    if (sentinel?.live_activities?.length) {
      for (const act of sentinel.live_activities) {
        // Deduplicate by timestamp + message (agent may replay recent events on startup)
        const key = `${act.timestamp_ms}:${act.message}`;
        if (seenActivityIds.current.has(key)) continue;
        seenActivityIds.current.add(key);

        // Cap seen-set size to avoid unbounded growth
        if (seenActivityIds.current.size > 500) {
          const iter = seenActivityIds.current.values();
          seenActivityIds.current.delete(iter.next().value);
        }

        const type: FleetEvent['type'] = act.level === 'error'
          ? 'error'
          : 'node_online'; // reuse node_online as a generic "system info" event for info/warn

        newEvents.push({
          id:       uid(),
          ts:       act.timestamp_ms,
          type,
          nodeId,
          hostname,
          detail:   act.message,
        });
      }
    }

    // ── Source 2: delta watcher ───────────────────────────────────────────
    // Only run when sentinel is live.
    if (sentinel != null) {
      const curThermal = sentinel.thermal_state ?? null;
      // Prefer apple_soc_power_w (true SoC total) over cpu_power_w for anomaly detection.
      const curPower   = (sentinel.apple_soc_power_w ?? sentinel.nvidia_power_draw_w ?? sentinel.cpu_power_w) ?? null;
      const curModel   = sentinel.ollama_active_model ?? null;

      // ── 1. CONNECTIVITY ──────────────────────────────────────────────────
      if (prevConnected.current !== undefined && connected !== prevConnected.current) {
        const type: FleetEvent['type'] = connected ? 'node_online' : 'node_offline';
        if (!np.connectivity) {
          np.connectivity = {
            type,
            pendingAt:     now,
            originalValue: prevConnected.current,
            targetValue:   connected,
          };
        } else if (np.connectivity.targetValue !== connected) {
          if (connected === np.connectivity.originalValue) {
            delete np.connectivity; // reverted — cancel
          } else {
            np.connectivity.type        = type;
            np.connectivity.targetValue = connected;
          }
        }
      }

      if (np.connectivity) {
        const pc = np.connectivity;
        if (connected === pc.targetValue && now - pc.pendingAt >= SETTLE_MS) {
          newEvents.push({ id: uid(), ts: now, type: pc.type, nodeId, hostname });
          delete np.connectivity;
        } else if (connected !== pc.targetValue) {
          delete np.connectivity;
        }
      }

      // ── 2. THERMAL / THROTTLE ────────────────────────────────────────────
      if (prevThermal.current !== undefined && prevThermal.current !== curThermal) {
        const isThrottledNow = curThermal != null && ['serious', 'critical'].includes(curThermal.toLowerCase());
        const wasThrottled   = prevThermal.current != null && ['serious', 'critical'].includes(prevThermal.current.toLowerCase());
        const type: FleetEvent['type'] = isThrottledNow
          ? 'throttle_start'
          : wasThrottled ? 'throttle_resolved'
          : 'thermal_change';
        const detail = prevThermal.current != null
          ? `${prevThermal.current} → ${curThermal ?? 'unknown'}`
          : (curThermal ?? '');

        if (!np.thermal) {
          np.thermal = {
            type,
            pendingAt:     now,
            originalValue: prevThermal.current,
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
          }
        }
      }

      if (np.thermal) {
        const pt = np.thermal;
        if (curThermal === pt.targetValue && now - pt.pendingAt >= SETTLE_MS) {
          newEvents.push({ id: uid(), ts: now, type: pt.type, nodeId, hostname, detail: pt.detail });
          delete np.thermal;
        } else if (curThermal !== pt.targetValue && (!np.thermal || np.thermal.targetValue !== curThermal)) {
          delete np.thermal;
        }
      }

      // ── 3. MODEL SWAP ────────────────────────────────────────────────────
      if (
        prevModel.current !== undefined &&
        prevModel.current !== curModel &&
        curModel != null &&
        prevModel.current != null
      ) {
        const detail = `${prevModel.current} → ${curModel}`;
        if (!np.model) {
          np.model = {
            type:          'model_swap',
            pendingAt:     now,
            originalValue: prevModel.current,
            targetValue:   curModel,
            detail,
          };
        } else if (np.model.targetValue !== curModel) {
          if (curModel === np.model.originalValue) {
            delete np.model;
          } else {
            np.model.targetValue = curModel;
            np.model.detail      = `${np.model.originalValue ?? 'unknown'} → ${curModel}`;
          }
        }
      }

      if (np.model) {
        const pm = np.model;
        if (curModel === pm.targetValue && now - pm.pendingAt >= SETTLE_MS) {
          newEvents.push({ id: uid(), ts: now, type: 'model_swap', nodeId, hostname, detail: pm.detail });
          delete np.model;
        } else if (curModel !== pm.targetValue && (!np.model || np.model.targetValue !== curModel)) {
          delete np.model;
        }
      }

      // ── 4. POWER ANOMALY ─────────────────────────────────────────────────
      const prevP = prevPower.current ?? null;
      if (
        prevP !== undefined &&
        prevP != null &&
        curPower != null &&
        prevP >= POWER_ANOMALY_MIN_BASELINE_W &&
        Math.abs(curPower - prevP) / prevP >= POWER_ANOMALY_THRESHOLD
      ) {
        const direction = curPower > prevP ? '↑' : '↓';
        const detail    = `${prevP.toFixed(0)}W ${direction} ${curPower.toFixed(0)}W`;
        if (!np.power) {
          np.power = {
            type:          'power_anomaly',
            pendingAt:     now,
            originalValue: `${prevP.toFixed(0)}`,
            targetValue:   `${curPower.toFixed(0)}`,
            detail,
          };
        } else {
          np.power.targetValue = `${curPower.toFixed(0)}`;
          np.power.detail      = `${np.power.originalValue}W ${direction} ${curPower.toFixed(0)}W`;
        }
      } else if (np.power && (
        curPower == null || prevP == null || prevP < POWER_ANOMALY_MIN_BASELINE_W ||
        Math.abs((curPower - (prevP ?? 0)) / (prevP || 1)) < POWER_ANOMALY_THRESHOLD
      )) {
        delete np.power;
      }

      if (np.power && now - np.power.pendingAt >= SETTLE_MS) {
        const pp = np.power;
        newEvents.push({ id: uid(), ts: now, type: 'power_anomaly', nodeId, hostname, detail: pp.detail });
        delete np.power;
      }

      // ── Advance observation refs ──────────────────────────────────────────
      prevThermal.current = curThermal;
      prevModel.current   = curModel;
      prevPower.current   = curPower;
    }

    prevConnected.current = connected;

    // ── Commit new events ─────────────────────────────────────────────────
    if (newEvents.length > 0) {
      setEvents(prev =>
        [...newEvents.sort((a, b) => b.ts - a.ts), ...prev].slice(0, MAX_EVENTS)
      );
    }
  // sentinel reference changes every frame (new object each WS/SSE message).
  // connected is a primitive — changes are always caught.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sentinel, connected]);

  return events;
}
