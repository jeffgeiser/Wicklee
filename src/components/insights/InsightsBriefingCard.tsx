/**
 * InsightsBriefingCard — Morning Briefing Card for the Triage tab.
 *
 * Sprint 4 — Layer 2 of the three-tier insight lifecycle.
 *
 * Reads the 24h localStorage recent-events buffer (insightLifecycle.ts) and
 * surfaces a "what happened since you last checked" summary at the top of the
 * Triage tab. Designed to answer the "Morning Briefing" use case: an operator
 * returns after hours away and needs a quick orientation before diving into
 * active observations.
 *
 * Node-availability gating
 * ─────────────────────────────────────────────────────────────────────────────
 * When an onset event recommends routing to a specific fleet peer
 * (best_node_id is set), this card verifies the peer's current online status
 * via useFleetStream() at render time — NOT at event capture time. The peer
 * may have gone offline in the hours since the briefing was written.
 *
 * If the recommended peer is offline or degraded:
 *   - The recommendation text is shown with an amber "Node offline" pill.
 *   - The routing copy action is replaced with "use /api/v1/route/best instead".
 *   - The operator is never shown a stale hostname as a valid routing target.
 *
 * Layout:
 *  ┌─────────────────────────────────────────────────────────────────┐
 *  │  24h Briefing            [2 onset · 1 resolved · 1 dismissed]   │
 *  ├─────────────────────────────────────────────────────────────────┤
 *  │  [Onset rows — most recent onset per pattern, deduped]          │
 *  │  [Resolved rows — with durationMs]                              │
 *  │  [Dismissed count badge if > 0]                                 │
 *  └─────────────────────────────────────────────────────────────────┘
 *
 * Empty state: a compact dormant row consistent with the Alert Quartet style.
 * Collapsible: header row toggles body visibility so the card can be tucked
 * away after review.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  History, ChevronDown, Thermometer, Zap, TrendingDown, Cpu,
  BarChart2, MemoryStick, Server, CheckCircle, X, Clock,
  AlertTriangle, WifiOff,
} from 'lucide-react';
import {
  readRecentEvents,
  deduplicateOnsets,
  fmtDuration,
  fmtEventAge,
} from '../../lib/insightLifecycle';
import type { InsightRecentEvent } from '../../lib/insightLifecycle';
import { useFleetStream } from '../../contexts/FleetStreamContext';

// ── Node-availability gate constant ───────────────────────────────────────────
// Mirrors the ONLINE_GATE_MS used in AIInsights to build FleetNodeSummary.
// A node whose last telemetry frame is older than this is considered offline.
const ONLINE_GATE_MS = 90_000;   // 90 seconds

// ── Pattern icon mapping — mirrors ObservationCard ────────────────────────────

function patternIcon(patternId: string, cls = 'w-3.5 h-3.5') {
  switch (patternId) {
    case 'thermal_drain':        return <Thermometer  className={`${cls} text-amber-400`}  />;
    case 'phantom_load':         return <Zap          className={`${cls} text-violet-400`} />;
    case 'wes_velocity_drop':    return <TrendingDown className={`${cls} text-indigo-400`} />;
    case 'power_gpu_decoupling': return <Cpu          className={`${cls} text-cyan-400`}   />;
    case 'fleet_load_imbalance': return <BarChart2    className={`${cls} text-blue-400`}   />;
    case 'memory_trajectory':    return <MemoryStick  className={`${cls} text-cyan-400`}   />;
    default:                     return <Server       className={`${cls} text-gray-400`}   />;
  }
}

function patternColor(patternId: string): string {
  switch (patternId) {
    case 'thermal_drain':        return 'text-amber-400';
    case 'phantom_load':         return 'text-violet-400';
    case 'wes_velocity_drop':    return 'text-indigo-400';
    case 'power_gpu_decoupling': return 'text-cyan-400';
    case 'fleet_load_imbalance': return 'text-blue-400';
    case 'memory_trajectory':    return 'text-cyan-400';
    default:                     return 'text-indigo-400';
  }
}

// ── Stale-node warning banner ─────────────────────────────────────────────────

const StaleNodeWarning: React.FC<{ hostname: string }> = ({ hostname }) => (
  <div className="flex items-start gap-2 mt-2 px-2.5 py-2 rounded-lg bg-amber-500/8 border border-amber-500/20">
    <WifiOff className="w-3 h-3 text-amber-400/80 shrink-0 mt-px" />
    <div className="min-w-0">
      <p className="text-[10px] font-semibold text-amber-400/90">
        {hostname} is offline
      </p>
      <p className="text-[10px] text-amber-400/60 mt-0.5">
        This node went offline after the briefing was recorded.
        Query <code className="font-mono">/api/v1/route/best</code> for a current routing target.
      </p>
    </div>
  </div>
);

// ── DegradedNodeWarning ───────────────────────────────────────────────────────

const DegradedNodeWarning: React.FC<{ hostname: string; thermalState: string }> = ({
  hostname, thermalState,
}) => (
  <div className="flex items-start gap-2 mt-2 px-2.5 py-2 rounded-lg bg-amber-500/8 border border-amber-500/20">
    <AlertTriangle className="w-3 h-3 text-amber-400/80 shrink-0 mt-px" />
    <div className="min-w-0">
      <p className="text-[10px] font-semibold text-amber-400/90">
        {hostname} is now {thermalState}
      </p>
      <p className="text-[10px] text-amber-400/60 mt-0.5">
        Thermal state changed since this briefing was recorded.
        Query <code className="font-mono">/api/v1/route/best</code> for the current best node.
      </p>
    </div>
  </div>
);

// ── OnsetRow ─────────────────────────────────────────────────────────────────

interface OnsetRowProps {
  event:          InsightRecentEvent;
  count:          number;
  /** Current online status of best_node_id, resolved at render time. */
  nodeStatus:     'online' | 'offline' | 'degraded' | 'unknown';
  nodeThermal:    string | null;
}

const OnsetRow: React.FC<OnsetRowProps> = ({ event, count, nodeStatus, nodeThermal }) => {
  const hasBestNode      = !!event.best_node_id;
  const peerIsProblematic = hasBestNode && nodeStatus !== 'online' && nodeStatus !== 'unknown';

  return (
    <div className="py-2.5 border-b border-gray-800/50 last:border-0">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">{patternIcon(event.patternId)}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className={`text-xs font-semibold ${patternColor(event.patternId)} truncate`}>
              {event.title}
            </p>
            {count > 1 && (
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-gray-800 text-gray-400 border border-gray-700 shrink-0">
                ×{count} in 24h
              </span>
            )}
            {event.wes_at_onset != null && (
              <span className="text-[9px] font-mono text-gray-500 shrink-0">
                WES {event.wes_at_onset.toFixed(0)} at onset
              </span>
            )}
          </div>
          <p className="text-[10px] text-gray-500 mt-0.5 truncate">
            {event.hostname} · {event.hook}
          </p>

          {/* Recommendation text */}
          <p className="text-[10px] text-gray-400 mt-1.5 leading-relaxed">
            {event.recommendation}
          </p>

          {/* Node-availability gate — shown only when a specific peer was named
              and that peer is no longer in a healthy state at render time.      */}
          {hasBestNode && event.best_node_hostname && (
            nodeStatus === 'offline'
              ? <StaleNodeWarning hostname={event.best_node_hostname} />
              : nodeStatus === 'degraded' && nodeThermal
                ? <DegradedNodeWarning hostname={event.best_node_hostname} thermalState={nodeThermal} />
                : null
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[10px] text-gray-600">{fmtEventAge(event.ts)}</p>
          {event.confidence && (
            <p className={`text-[9px] font-semibold uppercase tracking-wide mt-0.5 ${
              event.confidence === 'high'     ? 'text-red-400/80'    :
              event.confidence === 'moderate' ? 'text-amber-400/80'  :
                                                'text-gray-500'
            }`}>
              {event.confidence}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

// ── ResolvedRow ───────────────────────────────────────────────────────────────

const ResolvedRow: React.FC<{ event: InsightRecentEvent }> = ({ event }) => (
  <div className="flex items-start gap-3 py-2.5 border-b border-gray-800/50 last:border-0 opacity-70">
    <CheckCircle className="w-3.5 h-3.5 text-green-400/70 mt-0.5 shrink-0" />
    <div className="flex-1 min-w-0">
      <p className="text-xs text-gray-400 truncate">{event.title}</p>
      <p className="text-[10px] text-gray-600 mt-0.5 truncate">
        {event.hostname}
        {event.durationMs != null && ` · ${fmtDuration(event.durationMs)} active`}
      </p>
    </div>
    <p className="text-[10px] text-gray-600 shrink-0">{fmtEventAge(event.ts)}</p>
  </div>
);

// ── InsightsBriefingCard ──────────────────────────────────────────────────────

interface InsightsBriefingCardProps {
  /**
   * If true, the card starts collapsed. Useful after the operator has already
   * reviewed the briefing in this session. Defaults to false (expanded).
   */
  defaultCollapsed?: boolean;
}

const InsightsBriefingCard: React.FC<InsightsBriefingCardProps> = ({
  defaultCollapsed = false,
}) => {
  const [events,    setEvents]    = useState<InsightRecentEvent[]>([]);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  // Live fleet state — used for per-render node-availability gating.
  const { allNodeMetrics, lastSeenMsMap } = useFleetStream();

  // Refresh the buffer from localStorage on mount and every 60s. Background
  // eval cycles may write new entries while this tab is not in focus.
  useEffect(() => {
    const refresh = () => setEvents(readRecentEvents());
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, []);

  const toggle = useCallback(() => setCollapsed(v => !v), []);

  /**
   * Resolve the current online status of a fleet peer at render time.
   *
   * 'online'   — last telemetry frame < ONLINE_GATE_MS ago, Normal thermal.
   * 'degraded' — online but thermal state is not Normal (hot / stressed).
   * 'offline'  — no telemetry frame within ONLINE_GATE_MS.
   * 'unknown'  — node ID not in allNodeMetrics (single-node Cockpit, or peer
   *              never seen in this session). Show recommendation without gating.
   */
  const resolveNodeStatus = useCallback(
    (nodeId: string | null | undefined): {
      status:  'online' | 'offline' | 'degraded' | 'unknown';
      thermal: string | null;
    } => {
      if (!nodeId) return { status: 'unknown', thermal: null };

      const lastSeen = lastSeenMsMap[nodeId] ?? allNodeMetrics[nodeId]?.timestamp_ms;
      if (!lastSeen) return { status: 'unknown', thermal: null };

      const isOnline = Date.now() - lastSeen < ONLINE_GATE_MS;
      if (!isOnline) return { status: 'offline', thermal: null };

      const thermal = allNodeMetrics[nodeId]?.thermal_state ?? null;
      const isDegraded = thermal != null &&
        !['normal', 'nominal'].includes(thermal.toLowerCase());

      return {
        status:  isDegraded ? 'degraded' : 'online',
        thermal: isDegraded ? thermal : null,
      };
    },
    [allNodeMetrics, lastSeenMsMap],
  );

  // Derived counts
  const onsets    = deduplicateOnsets(events);
  const resolved  = events.filter(e => e.eventType === 'resolved');
  const dismissed = events.filter(e => e.eventType === 'dismissed');
  const total     = onsets.length + resolved.length + dismissed.length;

  // ── Empty state ───────────────────────────────────────────────────────────

  if (total === 0) {
    return (
      <div className="flex items-center gap-3 px-4 h-10 bg-gray-900 border border-gray-800 rounded-2xl">
        <History className="w-3.5 h-3.5 text-gray-600 shrink-0" />
        <span className="text-xs text-gray-600 flex-1">24h Briefing</span>
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-green-500/50 animate-pulse" />
          <span className="font-mono text-[10px] text-gray-600 uppercase tracking-widest">
            No observations
          </span>
        </div>
      </div>
    );
  }

  // ── Summary chips ─────────────────────────────────────────────────────────

  const chips = [
    onsets.length > 0    && `${onsets.length} onset${onsets.length > 1 ? 's' : ''}`,
    resolved.length > 0  && `${resolved.length} resolved`,
    dismissed.length > 0 && `${dismissed.length} dismissed`,
  ].filter(Boolean) as string[];

  return (
    <div className="bg-gray-900/60 border border-gray-800 rounded-2xl overflow-hidden">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <button
        onClick={toggle}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-800/30 transition-colors"
      >
        <History className="w-3.5 h-3.5 text-indigo-400/70 shrink-0" />
        <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 flex-1 text-left">
          24h Briefing
        </span>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {chips.map(chip => (
            <span
              key={chip}
              className="text-[9px] font-semibold px-2 py-0.5 rounded-full bg-gray-800 text-gray-400 border border-gray-700"
            >
              {chip}
            </span>
          ))}
        </div>
        <ChevronDown
          className={`w-3 h-3 text-gray-600 shrink-0 transition-transform duration-150 ${
            collapsed ? '' : 'rotate-180'
          }`}
        />
      </button>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      {!collapsed && (
        <div className="px-4 pb-3 pt-1 border-t border-gray-800/60 space-y-0">

          {/* Onset events — deduped, most recent per pattern.
              Each row resolves its named peer's live status for routing gating. */}
          {onsets.length > 0 && (
            <div>
              <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-600 mt-2 mb-1">
                Observations Fired
              </p>
              {onsets.map(({ event, count }) => {
                const { status, thermal } = resolveNodeStatus(event.best_node_id);
                return (
                  <OnsetRow
                    key={`${event.patternId}:${event.nodeId}`}
                    event={event}
                    count={count}
                    nodeStatus={status}
                    nodeThermal={thermal}
                  />
                );
              })}
            </div>
          )}

          {/* Resolved events */}
          {resolved.length > 0 && (
            <div>
              <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-600 mt-3 mb-1">
                Resolved
              </p>
              {resolved.map(e => (
                <ResolvedRow key={e.id} event={e} />
              ))}
            </div>
          )}

          {/* Dismissed summary — count only, no individual rows */}
          {dismissed.length > 0 && (
            <div className="flex items-center gap-2 mt-3 pt-2.5 border-t border-gray-800/40">
              <X className="w-3 h-3 text-gray-600 shrink-0" />
              <p className="text-[10px] text-gray-600">
                {dismissed.length} observation{dismissed.length > 1 ? 's' : ''} dismissed
                {` (resurfaces in ≤1h if condition persists)`}
              </p>
            </div>
          )}

          {/* Footer: oldest event age gives the time span covered */}
          {events.length > 0 && (() => {
            const oldest = events[events.length - 1];
            return (
              <div className="flex items-center gap-1.5 mt-3 pt-2 border-t border-gray-800/40">
                <Clock className="w-3 h-3 text-gray-700 shrink-0" />
                <p className="text-[9px] text-gray-700">
                  Earliest event {fmtEventAge(oldest.ts)} · showing last 24h
                </p>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
};

export default InsightsBriefingCard;
