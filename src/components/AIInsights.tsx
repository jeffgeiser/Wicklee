/**
 * AIInsights — Insights Hub tab
 *
 * Layout spec: docs/INSIGHTS.md § UI Tab Organization
 *
 * Structure:
 *   InsightsGlobalStatusRail  — always-visible fleet health bar (nominal/firing)
 *   Section 1 — Operational Signals  (Community)
 *     Alert Trio  — stacked dormant monitoring panel → expands per-card on fire
 *     Health Indicators (3-col) — Model Fit · WES Leaderboard · Inference Density
 *   Section 2 — Automation & Cost  (Pro)
 *     Model Eviction · Idle Resource Cost  (locked shells for Community)
 *   Section 3 — Analytics & Forensics  (Team / Enterprise)
 *     Locked shells for all pending cards
 *
 * Works in both modes:
 *   Cockpit  (isLocalHost) — local SSE at /api/metrics, single-node
 *   Mission Control        — FleetStreamContext allNodeMetrics, multi-node
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  BrainCircuit, Loader2, Sparkles, AlertCircle,
  Thermometer, Zap, HardDrive, Target, BarChart2,
  TrendingDown, Database, Scale, Cpu, Globe, Shield,
  Activity, Layers,
} from 'lucide-react';

import { NodeAgent, SentinelMetrics, InsightsTier } from '../types';
import { useFleetStream } from '../contexts/FleetStreamContext';
import { computeModelFitScore } from '../utils/modelFit';
import { useSettings } from '../hooks/useSettings';

// Tier 1 cards
import ThermalDegradationCard from './insights/tier1/ThermalDegradationCard';
import MemoryExhaustionCard   from './insights/tier1/MemoryExhaustionCard';
import PowerAnomalyCard       from './insights/tier1/PowerAnomalyCard';

// Tier 2 cards
import ModelFitInsightCard from './insights/tier2/ModelFitInsightCard';
import ModelEvictionCard   from './insights/tier2/ModelEvictionCard';
import IdleResourceCard    from './insights/tier2/IdleResourceCard';

// Gate & layout components
import InsightsGlobalStatusRail, { FiringAlert } from './insights/InsightsGlobalStatusRail';
import InsightsLockedCard from './insights/InsightsLockedCard';
import InsightsLiteCard   from './insights/InsightsLiteCard';
import HexHive from './shared/HexHive';
import type { HexHiveRow } from './shared/HexHive';

// ── Constants ─────────────────────────────────────────────────────────────────

const isLocalHost =
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Simple WES from live telemetry (no history — same formula as Overview). */
function computeNodeWes(m: SentinelMetrics): number | null {
  const tps   = m.ollama_tokens_per_second ?? m.vllm_tokens_per_sec ?? null;
  const watts = m.cpu_power_w ?? m.nvidia_power_draw_w ?? null;
  if (tps == null || watts == null || tps <= 0 || watts <= 0) return null;
  const th = m.thermal_state?.toLowerCase() ?? 'normal';
  const penalty = th === 'critical' ? 2.0 : th === 'serious' ? 2.0 : th === 'fair' ? 1.25 : 1.0;
  return tps / (watts * penalty);
}

/** Format watts compactly. */
function fmtWatts(w: number | null): string | null {
  return w != null ? `${w.toFixed(0)}W` : null;
}

/** Format VRAM percentage. */
function fmtVram(m: SentinelMetrics): string | null {
  const isNv = (m.nvidia_vram_total_mb ?? 0) > 0;
  const total = isNv ? (m.nvidia_vram_total_mb ?? 0) : m.total_memory_mb;
  const used  = isNv
    ? (m.nvidia_vram_used_mb ?? null)
    : m.total_memory_mb - m.available_memory_mb;
  if (used == null || total <= 0) return null;
  return `${((used / total) * 100).toFixed(0)}%`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

const SectionHeader: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-4">
    {children}
  </p>
);

/** Single dormant monitoring row shown when an alert condition is NOT firing. */
const AlertDormantRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  reading: string | null;
  isFirst?: boolean;
  isLast?: boolean;
}> = ({ icon, label, reading, isFirst, isLast }) => (
  <div
    className={`
      flex items-center gap-3 px-4 h-10 bg-gray-900 border-x border-gray-800
      ${isFirst ? 'border-t rounded-t-2xl' : ''}
      ${isLast  ? 'border-b rounded-b-2xl' : 'border-b border-gray-800/60'}
    `}
  >
    <span className="text-gray-600 shrink-0">{icon}</span>
    <span className="text-xs text-gray-600 flex-1">{label}</span>
    <div className="flex items-center gap-2">
      <div className="w-1.5 h-1.5 rounded-full bg-green-500/50 animate-pulse" />
      <span className="font-telin text-[10px] text-gray-600 uppercase tracking-widest">Monitoring</span>
      {reading && (
        <span className="font-telin text-xs text-gray-500 ml-1">· {reading}</span>
      )}
    </div>
  </div>
);

/** Compact nominal bar for Section 2 Pro cards when condition is not active. */
const Section2NominalRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  status: string;
}> = ({ icon, label, status }) => (
  <div className="bg-gray-900 border border-gray-800 rounded-2xl px-4 h-14 flex items-center gap-3">
    <span className="text-gray-600 shrink-0">{icon}</span>
    <div className="flex-1 min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">{label}</p>
      <p className="text-xs text-gray-700 mt-0.5">{status}</p>
    </div>
    <div className="w-1.5 h-1.5 rounded-full bg-green-500/40 animate-pulse shrink-0" />
  </div>
);

// ── WES Leaderboard (lite) ────────────────────────────────────────────────────

const WesLeaderboardLite: React.FC<{ nodes: SentinelMetrics[] }> = ({ nodes }) => {
  const ranked = nodes
    .map(m => ({
      nodeId:   m.hostname ?? m.node_id ?? 'unknown',
      wes:      computeNodeWes(m),
    }))
    .filter(x => x.wes != null)
    .sort((a, b) => (b.wes ?? 0) - (a.wes ?? 0))
    .slice(0, 3);

  if (ranked.length === 0) {
    return (
      <p className="text-xs text-gray-600">No active inference — WES unavailable.</p>
    );
  }

  return (
    <div className="space-y-1.5">
      {ranked.map((n, i) => (
        <div key={n.nodeId} className="flex items-center gap-2">
          <span className="font-telin text-[10px] text-gray-600 w-4 shrink-0">#{i + 1}</span>
          <span className="text-xs text-gray-400 flex-1 truncate">{n.nodeId}</span>
          <span className="font-telin text-xs text-cyan-400">{n.wes!.toFixed(1)}</span>
        </div>
      ))}
    </div>
  );
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface AIInsightsProps {
  nodes: NodeAgent[];
  userApiKey?: string;
  onNavigateToSecurity?: () => void;
  insightsTier: InsightsTier;
  canViewInsight: (id: number) => boolean;
}

// ── Main component ─────────────────────────────────────────────────────────────

const AIInsights: React.FC<AIInsightsProps> = ({
  nodes,
  userApiKey,
  onNavigateToSecurity,
  insightsTier,
  canViewInsight,
}) => {

  // ── Hooks — all unconditional ──────────────────────────────────────────────

  const [loading, setLoading]             = useState(false);
  const [insight, setInsight]             = useState<string | null>(null);
  const [localSentinel, setLocalSentinel] = useState<SentinelMetrics | null>(null);
  const [now, setNow]                     = useState(() => Date.now());

  // Power baseline (Cockpit only)
  const wattReadingsRef        = useRef<number[]>([]);
  const [sessionBaselineWatts, setSessionBaselineWatts] = useState<number | null>(null);

  // Eviction tracking (Cockpit only)
  const [lastActiveTsMs, setLastActiveTsMs] = useState<number>(() => Date.now());

  // Idle tracking (Cockpit only)
  const firstMessageTsRef = useRef<number | null>(null);
  const hadActivityRef    = useRef<boolean>(false);
  const [hadAnyActivity, setHadAnyActivity] = useState(false);

  // Alert firing timestamps — track when each condition first fired
  const thermalFiredAtRef = useRef<number | null>(null);
  const powerFiredAtRef   = useRef<number | null>(null);
  const memFiredAtRef     = useRef<number | null>(null);

  // ── Per-node activity tracking for Mission Control (fleet) ────────────────
  // Mirrors the Cockpit's lastActiveTsMs / firstMessageTs / hadAnyActivity
  // refs, but keyed by node_id so they work across an entire fleet.
  const nodeLastActiveMsRef = useRef<Record<string, number>>({});
  const nodeSessionStartRef = useRef<Record<string, number>>({});
  const nodeHadActivityRef  = useRef<Record<string, boolean>>({});

  // Fleet data from SSE context
  const { allNodeMetrics, lastSeenMsMap } = useFleetStream();

  const { getNodeSettings } = useSettings();

  // Tick every 10s to keep elapsed times fresh in the status rail
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  // Local SSE (Cockpit only)
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!isLocalHost) return;

    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      const es = new EventSource('/api/metrics');
      esRef.current = es;

      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as SentinelMetrics;
          setLocalSentinel(data);

          if (firstMessageTsRef.current === null) {
            firstMessageTsRef.current = Date.now();
          }

          const watts = data.cpu_power_w ?? data.nvidia_power_draw_w;
          if (watts != null && wattReadingsRef.current.length < 10) {
            wattReadingsRef.current = [...wattReadingsRef.current, watts];
            if (wattReadingsRef.current.length === 10) {
              const avg = wattReadingsRef.current.reduce((a, b) => a + b, 0) / 10;
              setSessionBaselineWatts(avg);
            }
          }

          const toks = data.ollama_tokens_per_second ?? 0;
          if (toks > 0) {
            setLastActiveTsMs(Date.now());
            if (!hadActivityRef.current) {
              hadActivityRef.current = true;
              setHadAnyActivity(true);
            }
          }
        } catch { /* malformed frame */ }
      };

      es.onerror = () => {
        es.close();
        esRef.current = null;
        retry = setTimeout(connect, 3_000);
      };
    };

    connect();
    return () => {
      clearTimeout(retry);
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  // ── Fleet activity tracking (Mission Control only) ────────────────────────
  // On every SSE frame, update per-node session-start / last-active / had-activity
  // refs so Section 2 cards can fire for fleet nodes, not just Cockpit.
  useEffect(() => {
    if (isLocalHost) return; // Cockpit tracks via the local SSE effect above
    const nowMs = Date.now();
    for (const [nodeId, nm] of Object.entries(allNodeMetrics)) {
      // Initialize session start & last-active on first sight of a node
      if (nodeSessionStartRef.current[nodeId] === undefined) {
        nodeSessionStartRef.current[nodeId] = nowMs;
        nodeLastActiveMsRef.current[nodeId] = nowMs;
      }
      const toks = (nm.ollama_tokens_per_second ?? 0) + (nm.vllm_tokens_per_sec ?? 0);
      if (toks > 0) {
        nodeLastActiveMsRef.current[nodeId] = nowMs;
        nodeHadActivityRef.current[nodeId]  = true;
      }
    }
  }, [allNodeMetrics]);

  // ── Effective node list ────────────────────────────────────────────────────

  const effectiveNodes: SentinelMetrics[] = isLocalHost && localSentinel
    ? [localSentinel]
    : Object.values(allNodeMetrics);

  // ── HexHive rows ──────────────────────────────────────────────────────────

  const hiveRows: HexHiveRow[] = isLocalHost && localSentinel
    ? [{ nodeId: localSentinel.node_id, hostname: localSentinel.hostname ?? localSentinel.node_id, metrics: localSentinel }]
    : Object.entries(allNodeMetrics).map(([nodeId, metrics]) => ({
        nodeId,
        hostname: metrics.hostname ?? nodeId,
        metrics,
        lastSeenMs: lastSeenMsMap[nodeId],
      }));

  // ── Tier 1 conditions (fleet-wide) ────────────────────────────────────────

  const thermalNodes = effectiveNodes.filter(m => {
    const s = m.thermal_state?.toLowerCase() ?? '';
    return s === 'serious' || s === 'critical';
  });

  const memNodes = effectiveNodes.filter(m => {
    if (!m.ollama_model_size_gb) return false;
    const isNv    = (m.nvidia_vram_total_mb ?? 0) > 0;
    const totalMb = isNv ? (m.nvidia_vram_total_mb ?? 0) : m.total_memory_mb;
    const usedMb  = isNv
      ? (m.nvidia_vram_used_mb ?? null)
      : m.total_memory_mb - m.available_memory_mb;
    if (usedMb == null || totalMb <= 0) return false;
    return ((totalMb - usedMb) / totalMb) * 100 < 10;
  });

  const powerNodes = effectiveNodes.filter(m => {
    const w   = m.cpu_power_w ?? m.nvidia_power_draw_w ?? null;
    const gpu = m.gpu_utilization_percent ?? m.nvidia_gpu_utilization_percent ?? null;
    const baseline = isLocalHost ? sessionBaselineWatts : null;
    return w != null && (
      (baseline != null && w > baseline * 2) ||
      (w > 50 && gpu != null && gpu < 20)
    );
  });

  const thermalFiring = thermalNodes.length > 0;
  const memFiring     = memNodes.length > 0;
  const powerFiring   = powerNodes.length > 0;

  // Track firing onset timestamps
  if (thermalFiring && thermalFiredAtRef.current === null) thermalFiredAtRef.current = now;
  if (!thermalFiring) thermalFiredAtRef.current = null;
  if (memFiring && memFiredAtRef.current === null) memFiredAtRef.current = now;
  if (!memFiring) memFiredAtRef.current = null;
  if (powerFiring && powerFiredAtRef.current === null) powerFiredAtRef.current = now;
  if (!powerFiring) powerFiredAtRef.current = null;

  // ── Tier 2 conditions ─────────────────────────────────────────────────────

  const m = localSentinel; // convenience alias (Cockpit)

  // Cockpit: single-node conditions from local SSE tracking
  const tier2EvictionActive = isLocalHost &&
    m?.ollama_running === true &&
    m?.ollama_active_model != null &&
    (now - lastActiveTsMs) >= (3 * 60 * 1_000); // warn at 3 min (card shows 2 min remaining)

  const sessionMs        = firstMessageTsRef.current ? now - firstMessageTsRef.current : 0;
  const tier2IdleActive  = isLocalHost && !hadAnyActivity && sessionMs >= 60 * 60 * 1_000 && m != null;

  // Mission Control: per-node conditions from fleet tracking refs.
  // ModelEviction proxy: no tok/s for ≥ 3 min with a model loaded.
  // IdleResource: node online ≥ 1 hr with zero inference this session.
  const fleetEvictionNodes: SentinelMetrics[] = !isLocalHost
    ? effectiveNodes.filter(n =>
        n.ollama_running === true &&
        n.ollama_active_model != null &&
        nodeLastActiveMsRef.current[n.node_id] !== undefined &&
        (now - nodeLastActiveMsRef.current[n.node_id]) >= 3 * 60 * 1_000
      )
    : [];

  const fleetIdleNodes: SentinelMetrics[] = !isLocalHost
    ? effectiveNodes.filter(n => {
        const watts        = n.cpu_power_w ?? n.nvidia_power_draw_w ?? null;
        if (watts == null) return false;
        const sessionStart = nodeSessionStartRef.current[n.node_id];
        if (!sessionStart) return false;
        const hadActivity  = nodeHadActivityRef.current[n.node_id] ?? false;
        return !hadActivity && (now - sessionStart) >= 60 * 60 * 1_000;
      })
    : [];

  // ── Fleet stats for Status Rail ───────────────────────────────────────────

  const wesValues = effectiveNodes.map(computeNodeWes).filter((v): v is number => v != null);
  const fleetWes  = wesValues.length > 0
    ? wesValues.reduce((a, b) => a + b, 0) / wesValues.length
    : null;

  const fleetTokS = effectiveNodes.reduce<number | null>((sum, n) => {
    const t = n.ollama_tokens_per_second ?? n.vllm_tokens_per_sec ?? null;
    if (t == null) return sum;
    return (sum ?? 0) + t;
  }, null);

  // ── Firing alerts array ───────────────────────────────────────────────────

  const firingAlerts: FiringAlert[] = [
    ...thermalNodes.map(n => ({
      id:        `thermal-${n.node_id}`,
      name:      'Thermal Degradation',
      nodeId:    n.hostname ?? n.node_id ?? '—',
      elapsedMs: thermalFiredAtRef.current ? now - thermalFiredAtRef.current : 0,
      severity:  'red' as const,
    })),
    ...powerNodes.map(n => ({
      id:        `power-${n.node_id}`,
      name:      'Power Anomaly',
      nodeId:    n.hostname ?? n.node_id ?? '—',
      elapsedMs: powerFiredAtRef.current ? now - powerFiredAtRef.current : 0,
      severity:  'amber' as const,
    })),
    ...memNodes.map(n => ({
      id:        `memory-${n.node_id}`,
      name:      'Memory Exhaustion',
      nodeId:    n.hostname ?? n.node_id ?? '—',
      elapsedMs: memFiredAtRef.current ? now - memFiredAtRef.current : 0,
      severity:  'amber' as const,
    })),
  ];

  // ── Per-node readings for dormant monitoring rows ─────────────────────────

  // Thermal: peak thermal state label + GPU temp
  const peakThermalNode = effectiveNodes.reduce<SentinelMetrics | null>((best, n) => {
    const order = ['critical', 'serious', 'fair', 'normal'];
    const rank  = (s: SentinelMetrics) => order.indexOf(s.thermal_state?.toLowerCase() ?? 'normal');
    return best == null || rank(n) < rank(best) ? n : best;
  }, null);
  const thermalReading = peakThermalNode
    ? (peakThermalNode.thermal_state ?? null)
    : null;

  const powerReading = fmtWatts(
    effectiveNodes.reduce<number | null>((sum, n) => {
      const w = n.cpu_power_w ?? n.nvidia_power_draw_w ?? null;
      if (w == null) return sum;
      return (sum ?? 0) + w;
    }, null),
  );

  const peakVramNode = effectiveNodes.reduce<SentinelMetrics | null>((worst, n) => {
    const isNv  = (n.nvidia_vram_total_mb ?? 0) > 0;
    const total = isNv ? (n.nvidia_vram_total_mb ?? 0) : n.total_memory_mb;
    const used  = isNv ? (n.nvidia_vram_used_mb ?? 0) : n.total_memory_mb - n.available_memory_mb;
    const pct   = total > 0 ? used / total : 0;
    if (worst == null) return n;
    const wIsNv  = (worst.nvidia_vram_total_mb ?? 0) > 0;
    const wTotal = wIsNv ? (worst.nvidia_vram_total_mb ?? 0) : worst.total_memory_mb;
    const wUsed  = wIsNv ? (worst.nvidia_vram_used_mb ?? 0) : worst.total_memory_mb - worst.available_memory_mb;
    const wPct   = wTotal > 0 ? wUsed / wTotal : 0;
    return pct > wPct ? n : worst;
  }, null);
  const memReading = peakVramNode ? fmtVram(peakVramNode) : null;

  // ── Model Fit (Section 1 Health Indicators) ───────────────────────────────

  const fitNodes = effectiveNodes.filter(n => computeModelFitScore(n) != null);

  // ── Local AI analysis (Cockpit only) ──────────────────────────────────────

  const analyzeFleet = async () => {
    setLoading(true);
    try {
      if (!userApiKey) throw new Error('Local Ollama not configured.');
      const response = await fetch(`${userApiKey}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'phi3:mini',
          prompt: `Analyze this AI fleet data and provide a concise strategic optimization report.
Fleet Snapshot:
${JSON.stringify(nodes, null, 2)}

Requirements:
1. Identify critical nodes based on Thermal (>75°C) or VRAM (>90% usage).
2. Suggest if load balancing should be shifted.
3. Recommend specific efficiency improvements.

Format as Markdown with a "Strategic Optimization" header.`,
          stream: false,
        }),
      });
      if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
      const data = await response.json();
      setInsight(data.response || 'Failed to generate insights.');
    } catch (error) {
      console.error(error);
      setInsight('Error communicating with local model. Ensure Ollama is running.');
    } finally {
      setLoading(false);
    }
  };

  // ── Cockpit settings ──────────────────────────────────────────────────────

  const localNodeId   = m?.node_id ?? 'local';
  const localSettings = getNodeSettings(localNodeId);

  // ── RENDER ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col min-h-0">

      {/* ── Global Status Rail — always first ───────────────────────────────── */}
      <InsightsGlobalStatusRail
        firingAlerts={firingAlerts}
        fleetWes={fleetWes}
        reachableNodes={effectiveNodes.length}
        fleetTokS={fleetTokS}
      />

      <div className="space-y-10 p-6">

        {/* ═══════════════════════════════════════════════════════════════════
            SECTION 1 — Operational Signals  [Community]
        ═══════════════════════════════════════════════════════════════════ */}
        <section>
          <SectionHeader>Operational Signals</SectionHeader>

          {/* Alert Trio — firing cards above dormant monitoring panel */}
          <div className="space-y-3 mb-6">
            {thermalFiring && thermalNodes.map(n => (
              <div key={n.node_id} id={`insight-thermal-${n.node_id}`}>
                <ThermalDegradationCard node={n} showNodeHeader={effectiveNodes.length > 1} />
              </div>
            ))}
            {powerFiring && powerNodes.map(n => (
              <div key={n.node_id} id={`insight-power-${n.node_id}`}>
                <PowerAnomalyCard node={n} baselineWatts={isLocalHost ? sessionBaselineWatts : null} showNodeHeader={effectiveNodes.length > 1} />
              </div>
            ))}
            {memFiring && memNodes.map(n => (
              <div key={n.node_id} id={`insight-memory-${n.node_id}`}>
                <MemoryExhaustionCard node={n} showNodeHeader={effectiveNodes.length > 1} />
              </div>
            ))}

            {/* Dormant monitoring rows for non-firing conditions */}
            {(!thermalFiring || !powerFiring || !memFiring) && (
              <div>
                {!thermalFiring && (
                  <AlertDormantRow
                    icon={<Thermometer className="w-3.5 h-3.5" />}
                    label="Thermal Degradation"
                    reading={thermalReading}
                    isFirst
                    isLast={powerFiring && memFiring}
                  />
                )}
                {!powerFiring && (
                  <AlertDormantRow
                    icon={<Zap className="w-3.5 h-3.5" />}
                    label="Power Anomaly"
                    reading={powerReading}
                    isFirst={thermalFiring}
                    isLast={memFiring}
                  />
                )}
                {!memFiring && (
                  <AlertDormantRow
                    icon={<HardDrive className="w-3.5 h-3.5" />}
                    label="Memory Exhaustion"
                    reading={memReading}
                    isFirst={thermalFiring && powerFiring}
                    isLast
                  />
                )}
              </div>
            )}
          </div>

          {/* Health Indicators — 3-col grid */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">

            {/* Model Fit Score */}
            {canViewInsight(4) ? (
              <div>
                {fitNodes.length > 0
                  ? fitNodes.map(n => (
                      <ModelFitInsightCard key={n.node_id} node={n} showNodeHeader={fitNodes.length > 1} />
                    ))
                  : (
                      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex items-center gap-3">
                        <Target className="w-4 h-4 text-gray-600 shrink-0" />
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">Model Fit Score</p>
                          <p className="text-xs text-gray-700 mt-0.5">No model loaded.</p>
                        </div>
                      </div>
                    )
                }
              </div>
            ) : (
              <InsightsLiteCard
                title="Model Fit Score"
                icon={<Target className="w-3.5 h-3.5" />}
                tierRequired="pro"
                upgradeCopy="Unlock history & recommendations on Pro →"
              >
                {fitNodes.length > 0 ? (
                  <div className="space-y-1">
                    {fitNodes.slice(0, 2).map(n => {
                      const r = computeModelFitScore(n);
                      return r ? (
                        <div key={n.node_id} className="flex items-center gap-2">
                          <span className={`font-telin text-sm font-bold capitalize ${
                            r.score === 'poor' ? 'text-red-400' : r.score === 'fair' ? 'text-amber-400' : 'text-green-400'
                          }`}>{r.score}</span>
                          {fitNodes.length > 1 && (
                            <span className="text-[10px] text-gray-600 truncate">{n.hostname ?? n.node_id}</span>
                          )}
                        </div>
                      ) : null;
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-gray-600">No model loaded.</p>
                )}
              </InsightsLiteCard>
            )}

            {/* WES Leaderboard */}
            {canViewInsight(7) ? (
              // Full card — pending build; show lite view for now (same data, no upgrade CTA)
              <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <BarChart2 className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">WES Leaderboard</span>
                </div>
                <WesLeaderboardLite nodes={effectiveNodes} />
              </div>
            ) : (
              <InsightsLiteCard
                title="WES Leaderboard"
                icon={<BarChart2 className="w-3.5 h-3.5" />}
                tierRequired="pro"
                upgradeCopy="Unlock sparklines & peer comparison on Pro →"
              >
                <WesLeaderboardLite nodes={effectiveNodes} />
              </InsightsLiteCard>
            )}

            {/* Inference Density — live HexHive */}
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Layers className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
                  Inference Density
                </span>
              </div>
              <HexHive rows={hiveRows} />
            </div>

          </div>
        </section>

        {/* ═══════════════════════════════════════════════════════════════════
            SECTION 2 — Automation & Cost  [Pro]
        ═══════════════════════════════════════════════════════════════════ */}
        <section>
          <SectionHeader>Automation &amp; Cost</SectionHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

            {/* Model Eviction */}
            {canViewInsight(5) ? (
              isLocalHost ? (
                // Cockpit: single-node, local SSE tracking
                tier2EvictionActive && m ? (
                  <div id="insight-model-eviction">
                    <ModelEvictionCard node={m} lastActiveTsMs={lastActiveTsMs} />
                  </div>
                ) : (
                  <Section2NominalRow
                    icon={<Cpu className="w-4 h-4" />}
                    label="Model Eviction"
                    status={m?.ollama_active_model
                      ? `${m.ollama_active_model} active — no eviction predicted`
                      : 'No model loaded'}
                  />
                )
              ) : fleetEvictionNodes.length > 0 ? (
                // Mission Control: one card per eviction-predicted node
                <div className="space-y-3">
                  {fleetEvictionNodes.map(n => (
                    <div key={n.node_id} id={`insight-model-eviction-${n.node_id}`}>
                      <ModelEvictionCard
                        node={n}
                        lastActiveTsMs={nodeLastActiveMsRef.current[n.node_id] ?? now}
                        showNodeHeader={fleetEvictionNodes.length > 1}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <Section2NominalRow
                  icon={<Cpu className="w-4 h-4" />}
                  label="Model Eviction"
                  status={effectiveNodes.some(n => n.ollama_active_model)
                    ? 'Models active — no eviction predicted'
                    : 'No models loaded'}
                />
              )
            ) : (
              <InsightsLockedCard
                title="Model Eviction"
                icon={<Cpu className="w-3.5 h-3.5" />}
                description="Countdown timer fires 2 minutes before Ollama unloads your model. Pro users get a Keep Warm toggle to reset the keep_alive timer silently."
                tierRequired="pro"
              />
            )}

            {/* Idle Resource Cost */}
            {canViewInsight(6) ? (
              isLocalHost ? (
                // Cockpit: single-node, local SSE tracking
                tier2IdleActive && m ? (
                  <div id="insight-idle-resource">
                    <IdleResourceCard
                      node={m}
                      sessionStartMs={firstMessageTsRef.current!}
                      hadAnyActivity={hadAnyActivity}
                      kwhRate={localSettings.kwhRate}
                      pue={localSettings.pue}
                    />
                  </div>
                ) : (
                  <Section2NominalRow
                    icon={<Zap className="w-4 h-4" />}
                    label="Idle Resource Cost"
                    status="No idle overhead detected"
                  />
                )
              ) : fleetIdleNodes.length > 0 ? (
                // Mission Control: one card per idle node
                <div className="space-y-3">
                  {fleetIdleNodes.map(n => {
                    const ns = getNodeSettings(n.node_id);
                    return (
                      <div key={n.node_id} id={`insight-idle-resource-${n.node_id}`}>
                        <IdleResourceCard
                          node={n}
                          sessionStartMs={nodeSessionStartRef.current[n.node_id] ?? now}
                          hadAnyActivity={nodeHadActivityRef.current[n.node_id] ?? false}
                          kwhRate={ns.kwhRate}
                          pue={ns.pue}
                          showNodeHeader={fleetIdleNodes.length > 1}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <Section2NominalRow
                  icon={<Zap className="w-4 h-4" />}
                  label="Idle Resource Cost"
                  status="No idle overhead detected"
                />
              )
            ) : (
              <InsightsLockedCard
                title="Idle Resource Cost"
                icon={<Zap className="w-3.5 h-3.5" />}
                description="Dollar ticker showing live idle electricity cost with PUE multiplier. Upgrade to Pro to track your facility overhead and surface hidden waste."
                tierRequired="pro"
              />
            )}

          </div>
        </section>

        {/* ═══════════════════════════════════════════════════════════════════
            SECTION 3 — Analytics & Forensics  [Team / Enterprise]
        ═══════════════════════════════════════════════════════════════════ */}
        <section>
          <SectionHeader>Analytics &amp; Forensics</SectionHeader>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">

            <InsightsLockedCard
              title="Efficiency Regression"
              icon={<TrendingDown className="w-3.5 h-3.5" />}
              description="Detects when a node's WES drops >20% from its 7-day baseline. The 'check engine' light for your fleet."
              tierRequired="team"
            />

            <InsightsLockedCard
              title="Memory Forecast"
              icon={<Database className="w-3.5 h-3.5" />}
              description="Rate-of-change on memory pressure predicts critical threshold ETA. Alerts at 15-minute and 5-minute windows."
              tierRequired="team"
            />

            <InsightsLockedCard
              title="Quantization ROI"
              icon={<Scale className="w-3.5 h-3.5" />}
              description="Compares Q4 vs Q8 tok/s and W/1K TKN on your actual hardware at your thermal state — not synthetic benchmarks."
              tierRequired="team"
            />

            <InsightsLockedCard
              title="Hardware Cold Start"
              icon={<Activity className="w-3.5 h-3.5" />}
              description="Detects model load transitions from GPU spike + VRAM jump patterns. No proxy required — pure hardware signal."
              tierRequired="team"
            />

            <InsightsLockedCard
              title="Fleet Thermal Diversity"
              icon={<Globe className="w-3.5 h-3.5" />}
              description="Distribution of thermal states across the fleet. Flags when the fleet is one spike away from a cascade failure."
              tierRequired="team"
            />

            <InsightsLockedCard
              title="Inference Density (Historical)"
              icon={<Layers className="w-3.5 h-3.5" />}
              description="Historical playback of the inference density hive plot. Unlock peak-hour analysis and utilisation trends."
              tierRequired="team"
            />

            <InsightsLockedCard
              title="Sovereignty Audit"
              icon={<Shield className="w-3.5 h-3.5" />}
              description="Cryptographically signed compliance PDF. Audit trail of every telemetry destination, pairing event, and outbound connection."
              tierRequired="enterprise"
            />

          </div>
        </section>

        {/* ═══════════════════════════════════════════════════════════════════
            Local AI Analysis (Cockpit only)
        ═══════════════════════════════════════════════════════════════════ */}
        {isLocalHost && (
          <section>
            <SectionHeader>Local AI Analysis</SectionHeader>
            <div className="space-y-4">

              {!userApiKey && (
                <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <AlertCircle className="w-5 h-5 text-amber-500 shrink-0" />
                    <p className="text-sm text-amber-600 dark:text-amber-200">
                      Connect a local Ollama instance to enable fleet intelligence.
                      Recommended: phi3:mini or qwen2.5:1.5b
                    </p>
                  </div>
                  <button
                    onClick={onNavigateToSecurity}
                    className="text-xs font-bold text-amber-600 dark:text-amber-200 hover:underline shrink-0 ml-4"
                  >
                    Configure →
                  </button>
                </div>
              )}

              <div className="bg-gradient-to-br from-blue-600/20 to-cyan-400/20 border border-blue-500/20 rounded-2xl p-8 flex flex-col items-center text-center">
                <div className="w-16 h-16 rounded-2xl bg-blue-600 flex items-center justify-center shadow-xl shadow-blue-500/40 mb-6">
                  <BrainCircuit className="w-8 h-8 text-white" />
                </div>
                <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
                  Fleet Analysis
                </h2>
                <p className="text-gray-600 dark:text-gray-400 max-w-lg mb-8">
                  Powered by your local Ollama model — fleet data never leaves your network.
                </p>
                <button
                  onClick={analyzeFleet}
                  disabled={loading}
                  className="px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-800 disabled:text-gray-500 text-white font-semibold rounded-xl transition-all shadow-lg shadow-blue-500/20 flex items-center gap-2"
                >
                  {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Sparkles className="w-5 h-5" />}
                  {loading ? 'Analyzing…' : 'Analyze My Fleet'}
                </button>
              </div>

              {insight && (
                <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 prose prose-invert max-w-none">
                  <div className="flex items-center gap-2 mb-4 text-cyan-400 text-sm font-bold uppercase tracking-widest">
                    <Sparkles className="w-4 h-4" />
                    Local Model Output
                  </div>
                  <div className="whitespace-pre-wrap leading-relaxed text-gray-300">{insight}</div>
                </div>
              )}

            </div>
          </section>
        )}

      </div>
    </div>
  );
};

export default AIInsights;
