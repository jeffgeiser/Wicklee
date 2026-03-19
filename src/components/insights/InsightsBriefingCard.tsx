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
  AlertTriangle, WifiOff, Copy, Check, Activity, Gauge,
} from 'lucide-react';
import {
  readRecentEvents,
  deduplicateOnsets,
  fmtDuration,
  fmtEventAge,
} from '../../lib/insightLifecycle';
import type { InsightRecentEvent } from '../../lib/insightLifecycle';
import { useFleetStream } from '../../contexts/FleetStreamContext';
import type { SentinelMetrics } from '../../types';
import { computeWES } from '../../utils/wes';

// ── Cloud URL (mirrors App.tsx / APIKeysView.tsx) ─────────────────────────────
const CLOUD_URL = (() => {
  const v = import.meta.env.VITE_CLOUD_URL ?? '';
  if (!v) return 'https://vibrant-fulfillment-production-62c0.up.railway.app';
  return v.startsWith('http') ? v : `https://${v}`;
})();

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
    case 'memory_trajectory':    return <MemoryStick  className={`${cls} text-cyan-400`}    />;
    case 'bandwidth_saturation': return <Gauge        className={`${cls} text-emerald-400`} />;
    default:                     return <Server       className={`${cls} text-gray-400`}    />;
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
    case 'bandwidth_saturation': return 'text-emerald-400';
    default:                     return 'text-indigo-400';
  }
}

// ── Fleet Pulse computation ────────────────────────────────────────────────────
// Live fleet snapshot derived from useFleetStream() data.

function computeNodeWes(m: SentinelMetrics): number | null {
  const tps   = m.ollama_tokens_per_second ?? m.vllm_tokens_per_sec ?? null;
  const watts = m.cpu_power_w ?? m.nvidia_power_draw_w ?? null;
  if (tps == null || watts == null || tps <= 0 || watts <= 0) return null;
  return computeWES(tps, watts, m.thermal_state);
}

interface FleetPulse {
  onlineCount:     number;
  totalCount:      number;
  fleetTokS:       number;
  topNode:         { nodeId: string; hostname: string; wes: number } | null;
  bottomNode:      { nodeId: string; hostname: string; wes: number } | null;
  /** WES ratio top/bottom — only set when ≥ 2 nodes online and ratio ≥ 1.5. */
  efficiencyRatio: number | null;
}

function computeFleetPulse(
  allNodeMetrics: Record<string, SentinelMetrics>,
  lastSeenMsMap:  Record<string, number>,
): FleetPulse {
  const now     = Date.now();
  const allIds  = Object.keys(allNodeMetrics);
  const total   = allIds.length;

  const onlineIds = allIds.filter(id => {
    const lastSeen = lastSeenMsMap[id] ?? allNodeMetrics[id]?.timestamp_ms;
    return lastSeen != null && now - lastSeen < ONLINE_GATE_MS;
  });

  const fleetTokS = onlineIds.reduce(
    (sum, id) => sum + (allNodeMetrics[id].ollama_tokens_per_second ?? allNodeMetrics[id].vllm_tokens_per_sec ?? 0),
    0,
  );

  const wesNodes = onlineIds
    .map(id => ({
      nodeId:   id,
      hostname: allNodeMetrics[id].hostname ?? id,
      wes:      computeNodeWes(allNodeMetrics[id]) ?? 0,
    }))
    .filter(n => n.wes > 0)
    .sort((a, b) => b.wes - a.wes);

  const topNode    = wesNodes[0]    ?? null;
  const bottomNode = wesNodes.length >= 2 ? wesNodes[wesNodes.length - 1] : null;
  const ratio      = topNode && bottomNode && bottomNode.wes > 0
    ? topNode.wes / bottomNode.wes
    : null;

  return {
    onlineCount:     onlineIds.length,
    totalCount:      total,
    fleetTokS,
    topNode,
    bottomNode,
    efficiencyRatio: ratio != null && ratio >= 1.5 ? ratio : null,
  };
}

// ── InlineCopyButton ──────────────────────────────────────────────────────────

const InlineCopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [done, setDone] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setDone(true);
    setTimeout(() => setDone(false), 2000);
  };
  return (
    <button
      onClick={copy}
      className="shrink-0 p-1 text-gray-600 hover:text-gray-400 transition-colors"
      title="Copy"
    >
      {done
        ? <Check className="w-3 h-3 text-green-400" />
        : <Copy className="w-3 h-3" />}
    </button>
  );
};

// ── FleetPulseStrip ───────────────────────────────────────────────────────────
// Compact always-visible row showing live fleet health at a glance.

const FleetPulseStrip: React.FC<{ pulse: FleetPulse }> = ({ pulse }) => {
  const {
    onlineCount, totalCount, fleetTokS, topNode,
  } = pulse;

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-gray-950/40 border-t border-gray-800/60 flex-wrap text-[10px]">
      {/* Online count */}
      <div className="flex items-center gap-1.5">
        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          onlineCount > 0 ? 'bg-green-400 animate-pulse' : 'bg-gray-600'
        }`} />
        <span className="font-semibold text-gray-400">
          {onlineCount}<span className="text-gray-600">/{totalCount}</span>
        </span>
        <span className="text-gray-600">online</span>
      </div>

      <span className="text-gray-700">·</span>

      {/* Fleet tok/s */}
      <div className="flex items-center gap-1">
        <Zap className="w-3 h-3 text-indigo-400/70 shrink-0" />
        <span className="font-mono font-semibold text-gray-400">
          {fleetTokS > 0 ? fleetTokS.toFixed(1) : '—'}
        </span>
        <span className="text-gray-600">tok/s fleet</span>
      </div>

      {/* Top WES node */}
      {topNode && (
        <>
          <span className="text-gray-700">·</span>
          <div className="flex items-center gap-1">
            <Activity className="w-3 h-3 text-green-400/70 shrink-0" />
            <span className="text-gray-600">top:</span>
            <span className="font-mono font-semibold text-gray-300">{topNode.hostname}</span>
            <span className="font-mono text-indigo-400/80">{topNode.wes.toFixed(0)}</span>
            <span className="text-gray-600">WES</span>
          </div>
        </>
      )}
    </div>
  );
};

// ── HeadToHeadRow ─────────────────────────────────────────────────────────────
// Shown when ≥ 2 online nodes have a meaningful WES gap (≥ 1.5×).

const HeadToHeadRow: React.FC<{ pulse: FleetPulse }> = ({ pulse }) => {
  const { topNode, bottomNode, efficiencyRatio } = pulse;
  if (!topNode || !bottomNode || efficiencyRatio == null) return null;

  return (
    <div className="flex items-start gap-2 py-2.5 border-b border-gray-800/50">
      <BarChart2 className="w-3.5 h-3.5 text-blue-400/70 shrink-0 mt-0.5" />
      <p className="text-[10px] text-gray-500 leading-relaxed">
        <span className="font-semibold text-gray-300">{topNode.hostname}</span>
        {' '}is{' '}
        <span className="font-semibold text-indigo-400">{efficiencyRatio.toFixed(1)}×</span>
        {' '}more efficient than{' '}
        <span className="font-semibold text-gray-300">{bottomNode.hostname}</span>
        {' '}— prefer it for throughput-sensitive workloads.
      </p>
    </div>
  );
};

// ── TopFindingSection ─────────────────────────────────────────────────────────
// The highest-confidence active onset from the 24h buffer — shown in the
// collapsible body above the full events list. Operators get the most
// actionable finding immediately without scrolling.
//
// The curl snippet shows the /api/v1/insights/latest query pattern — even
// before the endpoint ships (Sprint 5) it teaches external consumers the
// API contract.

const ACTION_ID_COLORS: Record<string, string> = {
  rebalance_workload:   'text-blue-400    bg-blue-500/10    border-blue-500/20',
  evict_idle_models:    'text-violet-400  bg-violet-500/10  border-violet-500/20',
  reduce_batch_size:    'text-cyan-400    bg-cyan-500/10    border-cyan-500/20',
  check_thermal_zone:   'text-amber-400   bg-amber-500/10   border-amber-500/20',
  investigate_phantom:  'text-violet-400  bg-violet-500/10  border-violet-500/20',
  schedule_offpeak:     'text-green-400   bg-green-500/10   border-green-500/20',
  switch_quantization:  'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
};

const TopFindingSection: React.FC<{ event: InsightRecentEvent }> = ({ event }) => {
  const curlText = `curl ${CLOUD_URL}/api/v1/insights/latest \\\n  -H "X-API-Key: wk_live_YOUR_KEY_HERE"`;
  const actionColor = ACTION_ID_COLORS[event.action_id] ?? 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20';

  return (
    <div className="py-3 border-b border-gray-800/60 space-y-2">
      <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-600 mb-1">
        Top Finding
      </p>

      {/* Pattern + hook */}
      <div className="flex items-start gap-2">
        <div className="mt-0.5 shrink-0">{patternIcon(event.patternId)}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className={`text-xs font-semibold ${patternColor(event.patternId)}`}>
              {event.title}
            </p>
            <span className="font-mono text-[10px] text-gray-500">{event.hook}</span>
            <span className="text-[9px] text-gray-600">{event.hostname}</span>
          </div>
        </div>
        {event.confidence && (
          <span className={`text-[9px] font-bold uppercase tracking-wide shrink-0 ${
            event.confidence === 'high'     ? 'text-red-400/80'   :
            event.confidence === 'moderate' ? 'text-amber-400/80' :
                                              'text-gray-500'
          }`}>
            {event.confidence}
          </span>
        )}
      </div>

      {/* Recommendation */}
      {event.recommendation && (
        <p className="text-[10px] text-gray-400 leading-relaxed ml-5">
          {event.recommendation}
        </p>
      )}

      {/* action_id + curl */}
      <div className="ml-5 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border ${actionColor}`}>
            {event.action_id}
          </span>
          <span className="text-[9px] text-gray-600">machine directive</span>
        </div>
        <div className="flex items-center gap-1.5">
          <pre className="flex-1 font-mono text-[9px] text-gray-500 bg-gray-950 border border-gray-800 rounded-lg px-2.5 py-1.5 overflow-x-auto whitespace-pre min-w-0">
            {curlText}
          </pre>
          <InlineCopyButton text={curlText} />
        </div>
      </div>
    </div>
  );
};

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

  // Live fleet state — used for Fleet Pulse and per-render node-availability gating.
  const { allNodeMetrics, lastSeenMsMap } = useFleetStream();

  // Fleet Pulse — recomputed on every render (live data).
  const pulse = computeFleetPulse(allNodeMetrics, lastSeenMsMap);

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

  // Top Finding — highest-confidence onset from the 24h buffer.
  // Priority: high > moderate > low. Shown pinned at the top of the body.
  const CONF_RANK = { high: 2, moderate: 1, low: 0 } as const;
  const topFinding: InsightRecentEvent | null = onsets.length > 0
    ? onsets
        .map(({ event }) => event)
        .sort((a, b) =>
          (CONF_RANK[b.confidence ?? 'low'] ?? 0) - (CONF_RANK[a.confidence ?? 'low'] ?? 0),
        )[0]
    : null;

  // ── Empty state — no 24h events ──────────────────────────────────────────
  // Still show Fleet Pulse if nodes are online.

  if (total === 0) {
    return (
      <div className="bg-gray-900/60 border border-gray-800 rounded-2xl overflow-hidden">
        <div className="flex items-center gap-3 px-4 h-10">
          <History className="w-3.5 h-3.5 text-gray-600 shrink-0" />
          <span className="text-xs text-gray-600 flex-1">24h Briefing</span>
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500/50 animate-pulse" />
            <span className="font-mono text-[10px] text-gray-600 uppercase tracking-widest">
              No observations
            </span>
          </div>
        </div>
        {pulse.onlineCount > 0 && <FleetPulseStrip pulse={pulse} />}
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

      {/* ── Fleet Pulse — always visible ────────────────────────────────────── */}
      {pulse.onlineCount > 0 && <FleetPulseStrip pulse={pulse} />}

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      {!collapsed && (
        <div className="px-4 pb-3 pt-1 border-t border-gray-800/60 space-y-0">

          {/* Top Finding — highest-confidence active pattern */}
          {topFinding && <TopFindingSection event={topFinding} />}

          {/* Head-to-head — only when ≥2 online nodes have a WES gap ≥ 1.5× */}
          <HeadToHeadRow pulse={pulse} />

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
