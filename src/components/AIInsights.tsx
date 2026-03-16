/**
 * AIInsights — Insights Hub tab
 *
 * Layout spec: docs/INSIGHTS.md § UI Tab Organization
 *
 * Structure:
 *   InsightsGlobalStatusRail  — always-visible fleet health bar (nominal/firing)
 *   Tab: Triage
 *     Alert Trio  — stacked dormant monitoring panel → expands per-card on fire
 *     Model Eviction · Idle Resource Cost
 *     Model Fit Score
 *     Local AI Analysis (Cockpit only)
 *   Tab: Performance
 *     WES Leaderboard · Inference Density Map (2-col)
 *     WES Trend Chart (cloud only)
 *     Quantization ROI
 *   Tab: Forensics
 *     6-card grid: Efficiency Regression, Memory Forecast, Hardware Cold Start,
 *                  Fleet Thermal Diversity, Inference Density Historical, Sovereignty Audit
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

import { NodeAgent, SentinelMetrics, InsightsTier, FleetEvent, SubscriptionTier } from '../types';
import { useFleetStream } from '../contexts/FleetStreamContext';
import { computeWES, computeRawWES, thermalCostPct } from '../utils/wes';
import { INFERENCE_VRAM_THRESHOLD_MB } from '../utils/efficiency';
import { buildReportFromLive } from '../utils/benchmarkReport';
import type { BenchmarkReport } from '../utils/benchmarkReport';
import BenchmarkReportModal from './BenchmarkReportModal';
import { computeModelFitScore } from '../utils/modelFit';
import { useSettings } from '../hooks/useSettings';

// Tier 1 cards
import ThermalDegradationCard  from './insights/tier1/ThermalDegradationCard';
import ThermalCostAlertCard    from './insights/tier1/ThermalCostAlertCard';
import MemoryExhaustionCard    from './insights/tier1/MemoryExhaustionCard';
import PowerAnomalyCard        from './insights/tier1/PowerAnomalyCard';

// Tier 2 cards
import ModelFitInsightCard from './insights/tier2/ModelFitInsightCard';
import ModelEvictionCard   from './insights/tier2/ModelEvictionCard';
import IdleResourceCard    from './insights/tier2/IdleResourceCard';

// Tier 2 cards (cont.)
import QuantizationROICard from './insights/tier2/QuantizationROICard';

// Gate & layout components
import InsightsGlobalStatusRail, { FiringAlert } from './insights/InsightsGlobalStatusRail';
import InsightsLockedCard from './insights/InsightsLockedCard';
import InsightsLiteCard   from './insights/InsightsLiteCard';
import InsightsTeaseCard  from './insights/InsightsTeaseCard';
import HexHive from './shared/HexHive';
import type { HexHiveRow } from './shared/HexHive';
import WESHistoryChart from './WESHistoryChart';
import MetricsHistoryChart from './MetricsHistoryChart';
import ObservationCard from './insights/ObservationCard';
import { useMetricHistory, metricsToSample } from '../hooks/useMetricHistory';
import { evaluatePatterns } from '../lib/patternEngine';
import type { DetectedInsight } from '../lib/patternEngine';

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
  return computeWES(tps, watts, m.thermal_state);
}

/** Format watts compactly. */
function fmtWatts(w: number | null): string | null {
  return w != null ? `${w.toFixed(0)}W` : null;
}

/** Format VRAM percentage. */
function fmtVram(m: SentinelMetrics): string | null {
  const isNv = (m.nvidia_vram_total_mb ?? 0) >= INFERENCE_VRAM_THRESHOLD_MB;
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
    .map(m => {
      const tps   = m.ollama_tokens_per_second ?? m.vllm_tokens_per_sec ?? null;
      const watts = m.cpu_power_w ?? m.nvidia_power_draw_w ?? null;
      const wes   = computeNodeWes(m);
      const rawWes = (tps != null && tps > 0 && watts != null && watts > 0)
        ? tps / (watts)
        : null;
      const tcPct = (rawWes != null && wes != null && rawWes > 0)
        ? Math.round(((rawWes - wes) / rawWes) * 100)
        : 0;
      const thermalState = m.thermal_state?.toLowerCase() ?? null;
      const isHot = thermalState != null && !['normal', 'nominal'].includes(thermalState);
      return {
        nodeId:      m.hostname ?? m.node_id ?? 'unknown',
        wes,
        tcPct,
        isHot,
        thermalState: m.thermal_state,
      };
    })
    .filter(x => x.wes != null)
    .sort((a, b) => (b.wes ?? 0) - (a.wes ?? 0))
    .slice(0, 4);

  if (ranked.length === 0) {
    return (
      <p className="text-xs text-gray-600">No active inference — WES unavailable.</p>
    );
  }

  return (
    <div className="space-y-1.5">
      {ranked.map((n, i) => (
        <div key={n.nodeId} className="flex items-center gap-2 min-w-0">
          <span className="font-telin text-[10px] text-gray-600 w-4 shrink-0 text-right">#{i + 1}</span>
          <span className="text-xs text-gray-400 flex-1 truncate min-w-0">{n.nodeId}</span>
          {n.isHot && (
            <span className="text-[9px] font-bold uppercase px-1 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20 shrink-0">
              {n.thermalState}
            </span>
          )}
          {n.tcPct > 0 && (
            <span className="text-[9px] font-telin text-amber-400/80 shrink-0" title={`${n.tcPct}% potential efficiency lost to thermal`}>
              -{n.tcPct}%
            </span>
          )}
          <span className="font-telin text-xs text-cyan-400 shrink-0">{n.wes!.toFixed(1)}</span>
        </div>
      ))}
    </div>
  );
};

// ── Tab Types & Tab Bar ───────────────────────────────────────────────────────

type InsightsTab = 'triage' | 'performance' | 'forensics';

const InsightsTabBar: React.FC<{
  active: InsightsTab;
  onChange: (t: InsightsTab) => void;
  hasForensicsUnlocked: boolean;
}> = ({ active, onChange, hasForensicsUnlocked }) => {
  const tabs: { id: InsightsTab; label: string; locked?: boolean }[] = [
    { id: 'triage',      label: 'Triage' },
    { id: 'performance', label: 'Performance' },
    { id: 'forensics',   label: 'Forensics', locked: !hasForensicsUnlocked },
  ];
  return (
    <div className="flex items-center gap-1 px-6 pt-4 pb-0 border-b border-gray-800/60">
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`
            relative flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold transition-colors
            ${active === t.id
              ? 'text-white border-b-2 border-indigo-500 -mb-px'
              : 'text-gray-500 hover:text-gray-300'}
          `}
        >
          {t.label}
          {t.locked && (
            <span className="text-[9px] font-bold text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded px-1 py-0.5 leading-none">
              Team
            </span>
          )}
        </button>
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
  onFleetEvent?: (event: FleetEvent) => void;
  /** Cloud session token getter — used for WES history fetch (cloud/Mission Control only). */
  getToken?: () => Promise<string | null>;
  /** Days of retained history the user's tier unlocks. */
  historyDays?: number;
  /** Subscription tier for history range gating. */
  subscriptionTier?: SubscriptionTier;
}

// ── Main component ─────────────────────────────────────────────────────────────

const AIInsights: React.FC<AIInsightsProps> = ({
  nodes,
  userApiKey,
  onNavigateToSecurity,
  insightsTier,
  canViewInsight,
  getToken,
  historyDays = 1,
  subscriptionTier = 'community',
  onFleetEvent,
}) => {

  // ── Hooks — all unconditional ──────────────────────────────────────────────

  const [loading, setLoading]             = useState(false);
  const [insight, setInsight]             = useState<string | null>(null);
  const [localSentinel, setLocalSentinel] = useState<SentinelMetrics | null>(null);
  const [now, setNow]                     = useState(() => Date.now());
  const [activeTab, setActiveTab]         = useState<InsightsTab>('triage');
  const [benchmarkReport, setBenchmarkReport] = useState<BenchmarkReport | null>(null);

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
  const tcFiredAtRef      = useRef<number | null>(null);

  // Thermal Cost % rolling history — 30-frame window per node for rate-of-change detection.
  // At typical SSE cadence (~1 frame/s), 30 frames ≈ 30 seconds; adjust window as needed.
  const tcPctHistoryRef = useRef<Record<string, number[]>>({});

  // Transition tracking for FleetEvent emissions
  const prevThermalFiringRef  = useRef(false);
  const prevEvictionActiveRef = useRef(false);
  const prevFitModelRef       = useRef<string | null>(null);

  // ── Per-node activity tracking for Mission Control (fleet) ────────────────
  // Mirrors the Cockpit's lastActiveTsMs / firstMessageTs / hadAnyActivity
  // refs, but keyed by node_id so they work across an entire fleet.
  const nodeLastActiveMsRef = useRef<Record<string, number>>({});
  const nodeSessionStartRef = useRef<Record<string, number>>({});
  const nodeHadActivityRef  = useRef<Record<string, boolean>>({});

  // Fleet data from SSE context
  const { allNodeMetrics, lastSeenMsMap, addFleetEvent } = useFleetStream();

  // Merged event emitter — prop takes precedence, falls back to context
  const emitFleetEvent = onFleetEvent ?? addFleetEvent;

  const { getNodeSettings } = useSettings();

  // ── Pattern engine — time-windowed deterministic observations ─────────────
  const metricHistory                               = useMetricHistory();
  const [observations, setObservations]             = useState<DetectedInsight[]>([]);
  const lastObsEvalRef                              = useRef<number>(0);

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

  // ── Pattern engine: push samples + evaluate ───────────────────────────────
  // Runs on every telemetry update (allNodeMetrics or localSentinel).
  // Downsampling is handled inside useMetricHistory.push() — rapid SSE frames
  // are deduplicated to one sample per 30-second bucket automatically.
  useEffect(() => {
    // Build set of restricted node IDs — these nodes still get history pushed
    // (so we don't lose telemetry data) but are excluded from pattern evaluation.
    const restrictedIdSet = new Set(nodes.filter(n => n.restricted).map(n => n.id));

    const metricsToProcess: SentinelMetrics[] = isLocalHost && localSentinel
      ? [localSentinel]
      : Object.values(allNodeMetrics);

    for (const m of metricsToProcess) {
      const wesScore = computeNodeWes(m);
      const sample   = metricsToSample(m, wesScore);
      metricHistory.push(m.node_id, sample);
    }

    // Throttle evaluation to at most once per 30s to match sample interval
    const nowMs = Date.now();
    if (nowMs - lastObsEvalRef.current < 30_000) return;
    lastObsEvalRef.current = nowMs;

    // Prune stale history once per eval cycle
    metricHistory.prune();

    const allObservations: DetectedInsight[] = [];
    // Only evaluate patterns for non-restricted nodes
    for (const m of metricsToProcess.filter(m => !restrictedIdSet.has(m.node_id))) {
      const ns      = getNodeSettings(m.node_id);
      const history = metricHistory.getHistory(m.node_id);
      const results = evaluatePatterns({
        nodeId:   m.node_id,
        hostname: m.hostname ?? m.node_id,
        history,
        kwhRate:  ns.kwhRate,
      });
      allObservations.push(...results);
    }
    setObservations(allObservations);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allNodeMetrics, localSentinel]);

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
    const isNv    = (m.nvidia_vram_total_mb ?? 0) >= INFERENCE_VRAM_THRESHOLD_MB;
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

  // Idle: no tok/s for ≥ 60 continuous minutes.
  // lastActiveTsMs resets on each tok/s > 0 — fires even after earlier activity.
  const tier2IdleActive  = isLocalHost && m != null && (now - lastActiveTsMs) >= 60 * 60 * 1_000;

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
        const watts      = n.cpu_power_w ?? n.nvidia_power_draw_w ?? null;
        if (watts == null) return false;
        const lastActive = nodeLastActiveMsRef.current[n.node_id];
        if (!lastActive) return false;
        return (now - lastActive) >= 60 * 60 * 1_000;
      })
    : [];

  // ── Thermal Cost % alerts ─────────────────────────────────────────────────
  // Fires for nodes in "Fair" thermal state where TC% > 10%.
  // Nodes already in Serious/Critical are covered by ThermalDegradationCard — excluded here.

  const tcPctByNode: Record<string, number>     = {};
  const tcRateByNode: Record<string, number>    = {};

  for (const node of effectiveNodes) {
    const tps    = node.ollama_tokens_per_second ?? node.vllm_tokens_per_sec ?? null;
    const watts  = node.cpu_power_w ?? node.nvidia_power_draw_w ?? null;
    const rawWes = computeRawWES(tps, watts);
    const penWes = computeWES(tps, watts, node.thermal_state);
    const tc     = thermalCostPct(rawWes, penWes);
    tcPctByNode[node.node_id] = tc;

    // Update rolling window (cap at 30 frames)
    const prev    = tcPctHistoryRef.current[node.node_id] ?? [];
    const updated = [...prev.slice(-29), tc];
    tcPctHistoryRef.current[node.node_id] = updated;

    // Rate-of-change: how much TC% rose from the start of the window to now
    if (updated.length >= 2) {
      tcRateByNode[node.node_id] = Math.max(0, tc - updated[0]);
    }
  }

  const tcAlertNodes = effectiveNodes.filter(n => {
    const tc           = tcPctByNode[n.node_id] ?? 0;
    const alreadyAlert = ['serious', 'critical'].includes(n.thermal_state?.toLowerCase() ?? '');
    return tc > 10 && !alreadyAlert;
  });

  const tcFiring = tcAlertNodes.length > 0;

  // Track firing onset timestamp for the status rail
  if (tcFiring && tcFiredAtRef.current === null) tcFiredAtRef.current = now;
  if (!tcFiring) tcFiredAtRef.current = null;

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
    ...tcAlertNodes.map(n => ({
      id:        `tc-cost-${n.node_id}`,
      name:      'Thermal Cost',
      nodeId:    n.hostname ?? n.node_id ?? '—',
      elapsedMs: tcFiredAtRef.current ? now - tcFiredAtRef.current : 0,
      severity:  ((tcPctByNode[n.node_id] ?? 0) >= 40 ? 'red' : 'amber') as 'red' | 'amber',
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
    const isNv  = (n.nvidia_vram_total_mb ?? 0) >= INFERENCE_VRAM_THRESHOLD_MB;
    const total = isNv ? (n.nvidia_vram_total_mb ?? 0) : n.total_memory_mb;
    const used  = isNv ? (n.nvidia_vram_used_mb ?? 0) : n.total_memory_mb - n.available_memory_mb;
    const pct   = total > 0 ? used / total : 0;
    if (worst == null) return n;
    const wIsNv  = (worst.nvidia_vram_total_mb ?? 0) >= INFERENCE_VRAM_THRESHOLD_MB;
    const wTotal = wIsNv ? (worst.nvidia_vram_total_mb ?? 0) : worst.total_memory_mb;
    const wUsed  = wIsNv ? (worst.nvidia_vram_used_mb ?? 0) : worst.total_memory_mb - worst.available_memory_mb;
    const wPct   = wTotal > 0 ? wUsed / wTotal : 0;
    return pct > wPct ? n : worst;
  }, null);
  const memReading = peakVramNode ? fmtVram(peakVramNode) : null;

  // Thermal Cost % dormant reading: peak TC% across non-alerting nodes
  const peakTcPct = effectiveNodes.reduce((max, n) => {
    const tc = tcPctByNode[n.node_id] ?? 0;
    return tc > max ? tc : max;
  }, 0);
  const tcReading = peakTcPct > 0 ? `${peakTcPct}%` : 'Normal';

  // ── Model Fit (Triage tab) ─────────────────────────────────────────────────

  const fitNodes = effectiveNodes.filter(n => computeModelFitScore(n) != null);

  // ── Forensics unlock gate ─────────────────────────────────────────────────

  const isTeamOrAbove = insightsTier === 'trend' || insightsTier === 'predictive';

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
${JSON.stringify(effectiveNodes, null, 2)}

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

  // ── FleetEvent emission — transition-based ────────────────────────────────

  useEffect(() => {
    const now = Date.now();
    const nodeId   = thermalNodes[0]?.node_id ?? 'unknown';
    const hostname = thermalNodes[0]?.hostname ?? thermalNodes[0]?.node_id ?? 'unknown';
    if (thermalFiring && !prevThermalFiringRef.current) {
      emitFleetEvent({
        id:       `${now}-thermal-confirmed`,
        ts:       now,
        type:     'thermal_degradation_confirmed',
        nodeId,
        hostname,
        detail:   `${thermalNodes[0]?.thermal_state ?? 'critical'} — throttling confirmed`,
      });
    }
    prevThermalFiringRef.current = thermalFiring;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thermalFiring]);

  useEffect(() => {
    if (!isLocalHost) return;
    const now = Date.now();
    if (tier2EvictionActive && !prevEvictionActiveRef.current && m) {
      emitFleetEvent({
        id:       `${now}-eviction`,
        ts:       now,
        type:     'model_eviction_predicted',
        nodeId:   m.node_id,
        hostname: m.hostname ?? m.node_id,
        detail:   m.ollama_active_model ?? 'active model',
      });
    }
    prevEvictionActiveRef.current = tier2EvictionActive;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier2EvictionActive, isLocalHost]);

  const fitModelKey = effectiveNodes.map(n => n.ollama_active_model ?? '').join(',');
  useEffect(() => {
    const currentModel = effectiveNodes[0]?.ollama_active_model ?? null;
    if (currentModel !== prevFitModelRef.current) {
      const prev = prevFitModelRef.current;
      prevFitModelRef.current = currentModel;
      if (prev !== null || currentModel !== null) {
        const nodeId   = effectiveNodes[0]?.node_id ?? 'local';
        const hostname = effectiveNodes[0]?.hostname ?? nodeId;
        const detail   = currentModel
          ? `loaded: ${currentModel}`
          : `unloaded: ${prev}`;
        emitFleetEvent({
          id:       `${Date.now()}-fit`,
          ts:       Date.now(),
          type:     'fit_score_changed',
          nodeId,
          hostname,
          detail,
        });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitModelKey]);

  // ── RENDER ────────────────────────────────────────────────────────────────

  // ── Benchmark report export ───────────────────────────────────────────────

  const handleExportBenchmark = () => {
    // Pick the node with the best (highest) penalized WES from live data, or localSentinel
    const source = isLocalHost
      ? localSentinel
      : effectiveNodes.reduce<SentinelMetrics | null>((best, n) => {
          const wes = computeNodeWes(n);
          if (wes == null) return best;
          if (best == null) return n;
          return wes > (computeNodeWes(best) ?? 0) ? n : best;
        }, null);
    if (!source) return;
    setBenchmarkReport(buildReportFromLive(source));
  };

  return (
    <>
    {benchmarkReport && (
      <BenchmarkReportModal report={benchmarkReport} onClose={() => setBenchmarkReport(null)} />
    )}
    <div className="flex flex-col min-h-0">

      {/* ── Global Status Rail — always first ───────────────────────────────── */}
      <InsightsGlobalStatusRail
        firingAlerts={firingAlerts}
        fleetWes={fleetWes}
        reachableNodes={effectiveNodes.length}
        fleetTokS={fleetTokS}
      />

      {/* ── Tab Bar ─────────────────────────────────────────────────────────── */}
      <InsightsTabBar
        active={activeTab}
        onChange={setActiveTab}
        hasForensicsUnlocked={isTeamOrAbove}
      />

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="space-y-6 p-6">

          {/* ═══════════════════════════════════════════════════════════════════
              TAB: Triage
          ═══════════════════════════════════════════════════════════════════ */}
          {activeTab === 'triage' && (
            <>
              {/* Alert Quartet — firing cards above dormant monitoring panel */}
              <div className="space-y-3">
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
                {tcFiring && tcAlertNodes.map(n => (
                  <div key={n.node_id} id={`insight-thermal-cost-${n.node_id}`}>
                    <ThermalCostAlertCard
                      node={n}
                      tcPct={tcPctByNode[n.node_id] ?? 0}
                      rateOfChangePct={tcRateByNode[n.node_id] ?? 0}
                      showNodeHeader={effectiveNodes.length > 1}
                    />
                  </div>
                ))}

                {/* Dormant monitoring rows for non-firing conditions.
                    Build an ordered array so isFirst/isLast track correctly
                    regardless of how many are currently dormant. */}
                {(() => {
                  const dormant = [
                    ...(!thermalFiring ? [{ key: 'thermal', icon: <Thermometer className="w-3.5 h-3.5" />, label: 'Thermal Degradation', reading: thermalReading }] : []),
                    ...(!powerFiring   ? [{ key: 'power',   icon: <Zap          className="w-3.5 h-3.5" />, label: 'Power Anomaly',       reading: powerReading   }] : []),
                    ...(!memFiring     ? [{ key: 'mem',     icon: <HardDrive    className="w-3.5 h-3.5" />, label: 'Memory Exhaustion',   reading: memReading     }] : []),
                    ...(!tcFiring      ? [{ key: 'tc',      icon: <Thermometer  className="w-3.5 h-3.5" />, label: 'Thermal Cost',         reading: tcReading      }] : []),
                  ];
                  if (dormant.length === 0) return null;
                  return (
                    <div>
                      {dormant.map((item, i) => (
                        <AlertDormantRow
                          key={item.key}
                          icon={item.icon}
                          label={item.label}
                          reading={item.reading}
                          isFirst={i === 0}
                          isLast={i === dormant.length - 1}
                        />
                      ))}
                    </div>
                  );
                })()}
              </div>

              {/* Model Eviction + Idle Resource Cost */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

                {/* Model Eviction — Community+ (live_session gate) */}
                {isLocalHost ? (
                  // Cockpit: single-node, local SSE tracking
                  tier2EvictionActive && m ? (
                    <div id="insight-model-eviction">
                      <ModelEvictionCard
                      node={m}
                      lastActiveTsMs={lastActiveTsMs}
                      canKeepWarm
                      onKeepWarm={() => emitFleetEvent({
                        id:       `${Date.now()}-keepwarm`,
                        ts:       Date.now(),
                        type:     'keep_warm_taken',
                        nodeId:   m.node_id,
                        hostname: m.hostname ?? m.node_id,
                        detail:   m.ollama_active_model ?? 'active model',
                      })}
                    />
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
                          canKeepWarm
                          onKeepWarm={() => emitFleetEvent({
                            id:       `${Date.now()}-keepwarm`,
                            ts:       Date.now(),
                            type:     'keep_warm_taken',
                            nodeId:   n.node_id,
                            hostname: n.hostname ?? n.node_id,
                            detail:   n.ollama_active_model ?? 'active model',
                          })}
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
                )}

                {/* Idle Resource Cost */}
                {canViewInsight(6) ? (
                  isLocalHost ? (
                    // Cockpit: single-node, local SSE tracking
                    tier2IdleActive && m ? (
                      <div id="insight-idle-resource">
                        <IdleResourceCard
                          node={m}
                          lastActiveTsMs={lastActiveTsMs}
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
                              lastActiveTsMs={nodeLastActiveMsRef.current[n.node_id] ?? now}
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
                  // Community: live monitoring row with current fleet wattage.
                  // Full idle cost analysis (1-hr threshold + $/hr ticker) requires Pro.
                  <Section2NominalRow
                    icon={<Zap className="w-4 h-4" />}
                    label="Idle Resource Cost"
                    status={(() => {
                      const w = effectiveNodes.reduce<number | null>((sum, n) => {
                        const nw = n.cpu_power_w ?? n.nvidia_power_draw_w ?? null;
                        return nw != null ? (sum ?? 0) + nw : sum;
                      }, null);
                      return w != null ? `${w.toFixed(0)}W fleet draw · monitoring` : 'Monitoring idle overhead';
                    })()}
                  />
                )}

              </div>

              {/* Model Fit Score */}
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

              {/* ── Observations — pattern engine briefing feed ── */}
              {observations.length > 0 && (
                <div className="space-y-3">
                  <SectionHeader>Observations</SectionHeader>
                  {observations.map(obs => (
                    <ObservationCard
                      key={`${obs.patternId}-${obs.nodeId}`}
                      insight={obs}
                      showNodeHeader={effectiveNodes.length > 1}
                    />
                  ))}
                </div>
              )}

              {/* Local AI Analysis (Cockpit only) */}
              {isLocalHost && (
                <div className="space-y-4">
                  <SectionHeader>Local AI Analysis</SectionHeader>

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
              )}
            </>
          )}

          {/* ═══════════════════════════════════════════════════════════════════
              TAB: Performance
          ═══════════════════════════════════════════════════════════════════ */}
          {activeTab === 'performance' && (
            <>
              {/* WES Leaderboard + Inference Density Map — 2-col */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

                {/* WES Leaderboard */}
                {canViewInsight(7) ? (
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

              {/* WES Trend Chart (cloud only) */}
              {!isLocalHost && getToken && (
                <WESHistoryChart
                  getToken={getToken}
                  historyDays={historyDays}
                  subscriptionTier={subscriptionTier}
                />
              )}

              {/* Performance History — Tok/s · Power · GPU% · Mem% (cloud only) */}
              {!isLocalHost && getToken && (
                <MetricsHistoryChart
                  getToken={getToken}
                  historyDays={historyDays}
                  subscriptionTier={subscriptionTier}
                />
              )}

              {/* Quantization ROI */}
              {canViewInsight(10) && effectiveNodes.length > 0 ? (
                <QuantizationROICard
                  node={effectiveNodes[0]}
                  nodes={effectiveNodes}
                />
              ) : canViewInsight(10) ? (
                // No nodes connected yet
                <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex items-center gap-3">
                  <Scale className="w-3.5 h-3.5 text-gray-600 shrink-0" />
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">Quantization ROI</p>
                    <p className="text-xs text-gray-700 mt-0.5">No nodes connected.</p>
                  </div>
                </div>
              ) : (
                <InsightsTeaseCard
                  title="Quantization ROI"
                  icon={<Scale className="w-3.5 h-3.5" />}
                  tierRequired="team"
                  upgradeCopy="Compare quantizations over time on Team →"
                  liveContent={
                    <p className="text-xs text-gray-600">
                      Live efficiency metrics available — load a model to see tok/s and W/1K TKN.
                    </p>
                  }
                />
              )}

              {/* Export Benchmark Report — live snapshot */}
              {effectiveNodes.length > 0 && wesValues.length > 0 && (
                <div className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-2xl px-5 py-3.5">
                  <div className="min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
                      Benchmark Report
                    </p>
                    <p className="text-xs text-gray-600 mt-0.5 truncate">
                      Reproducible, citable WES snapshot — Raw · Penalized · Thermal Cost · Source
                    </p>
                  </div>
                  <button
                    onClick={handleExportBenchmark}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white transition-colors shrink-0 ml-4"
                  >
                    Export snapshot
                  </button>
                </div>
              )}
            </>
          )}

          {/* ═══════════════════════════════════════════════════════════════════
              TAB: Forensics
          ═══════════════════════════════════════════════════════════════════ */}
          {activeTab === 'forensics' && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">

              {/* Efficiency Regression — Team tease: shows live WES */}
              {canViewInsight(8) ? (
                // Full team card — pending build; placeholder until implemented
                <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex items-center gap-3">
                  <TrendingDown className="w-3.5 h-3.5 text-gray-600 shrink-0" />
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">Efficiency Regression</p>
                    <p className="text-xs text-gray-700 mt-0.5">Collecting history…</p>
                  </div>
                </div>
              ) : (
                <InsightsTeaseCard
                  title="Efficiency Regression"
                  icon={<TrendingDown className="w-3.5 h-3.5" />}
                  tierRequired="team"
                  upgradeCopy="Unlock 7-day WES baseline comparison on Team →"
                  liveContent={
                    <div className="space-y-1.5">
                      <p className="text-[10px] text-gray-600 uppercase tracking-widest">Current WES</p>
                      {fleetWes != null ? (
                        <div className="flex items-baseline gap-2">
                          <span className={`font-telin text-xl font-bold ${
                            fleetWes >= 3 ? 'text-green-400' : fleetWes >= 1.5 ? 'text-amber-400' : 'text-red-400'
                          }`}>
                            {fleetWes.toFixed(1)}
                          </span>
                          <span className="text-[10px] text-gray-600">vs. baseline: requires Team history</span>
                        </div>
                      ) : (
                        <p className="text-xs text-gray-600">No active inference — WES unavailable.</p>
                      )}
                    </div>
                  }
                />
              )}

              {/* Memory Forecast — Team tease: shows live memory pressure */}
              {canViewInsight(9) ? (
                // Full team card — pending build
                <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex items-center gap-3">
                  <Database className="w-3.5 h-3.5 text-gray-600 shrink-0" />
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">Memory Forecast</p>
                    <p className="text-xs text-gray-700 mt-0.5">Collecting history…</p>
                  </div>
                </div>
              ) : (
                <InsightsTeaseCard
                  title="Memory Forecast"
                  icon={<Database className="w-3.5 h-3.5" />}
                  tierRequired="team"
                  upgradeCopy="Unlock ETA forecasting & 15-min alerts on Team →"
                  liveContent={(() => {
                    const pressureNode = effectiveNodes.find(n => n.memory_pressure_percent != null);
                    const pressure = pressureNode?.memory_pressure_percent ?? null;
                    const vramNode = effectiveNodes.find(n => (n.nvidia_vram_total_mb ?? 0) >= INFERENCE_VRAM_THRESHOLD_MB);
                    const vramPct = vramNode
                      ? (((vramNode.nvidia_vram_used_mb ?? 0) / (vramNode.nvidia_vram_total_mb ?? 1)) * 100)
                      : null;
                    const displayPct = pressure ?? vramPct;
                    return (
                      <div className="space-y-1.5">
                        <p className="text-[10px] text-gray-600 uppercase tracking-widest">Memory Pressure</p>
                        {displayPct != null ? (
                          <div className="flex items-baseline gap-2">
                            <span className={`font-telin text-xl font-bold ${
                              displayPct >= 80 ? 'text-red-400' : displayPct >= 60 ? 'text-amber-400' : 'text-green-400'
                            }`}>
                              {displayPct.toFixed(0)}%
                            </span>
                            <span className="text-[10px] text-gray-600">
                              {displayPct >= 80 ? 'Critical — forecast requires Team' : displayPct >= 60 ? 'Elevated' : 'Normal'}
                            </span>
                          </div>
                        ) : (
                          <p className="text-xs text-gray-600">No memory pressure data.</p>
                        )}
                      </div>
                    );
                  })()}
                />
              )}

              {/* Hardware Cold Start — Team tease: shows last known model state */}
              {canViewInsight(11) ? (
                // Full team card — pending build
                <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex items-center gap-3">
                  <Activity className="w-3.5 h-3.5 text-gray-600 shrink-0" />
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">Hardware Cold Start</p>
                    <p className="text-xs text-gray-700 mt-0.5">Collecting history…</p>
                  </div>
                </div>
              ) : (
                <InsightsTeaseCard
                  title="Hardware Cold Start"
                  icon={<Activity className="w-3.5 h-3.5" />}
                  tierRequired="team"
                  upgradeCopy="Unlock load-time detection & cold start alerts on Team →"
                  liveContent={(() => {
                    const loadedNode = effectiveNodes.find(n => n.ollama_active_model);
                    return (
                      <div className="space-y-1.5">
                        <p className="text-[10px] text-gray-600 uppercase tracking-widest">Model State</p>
                        {loadedNode ? (
                          <div className="flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-green-500/70 shrink-0" />
                            <span className="font-mono text-xs text-gray-300 truncate">{loadedNode.ollama_active_model}</span>
                            <span className="text-[10px] text-gray-600">loaded</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-gray-600 shrink-0" />
                            <span className="text-xs text-gray-600">No model loaded — cold start on next request</span>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                />
              )}

              {/* Fleet Thermal Diversity — Team tease: shows live state counts */}
              {canViewInsight(12) ? (
                // Full team card — pending build
                <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex items-center gap-3">
                  <Globe className="w-3.5 h-3.5 text-gray-600 shrink-0" />
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">Fleet Thermal Diversity</p>
                    <p className="text-xs text-gray-700 mt-0.5">Collecting history…</p>
                  </div>
                </div>
              ) : (
                <InsightsTeaseCard
                  title="Fleet Thermal Diversity"
                  icon={<Globe className="w-3.5 h-3.5" />}
                  tierRequired="team"
                  upgradeCopy="Unlock cascade risk analysis on Team →"
                  liveContent={(() => {
                    const counts = effectiveNodes.reduce<Record<string, number>>(
                      (acc, n) => {
                        const s = n.thermal_state?.toLowerCase() ?? 'normal';
                        acc[s] = (acc[s] ?? 0) + 1;
                        return acc;
                      }, {}
                    );
                    const states: Array<{ label: string; key: string; color: string }> = [
                      { label: 'Normal',   key: 'normal',   color: 'text-green-400' },
                      { label: 'Fair',     key: 'fair',     color: 'text-yellow-400' },
                      { label: 'Serious',  key: 'serious',  color: 'text-amber-400' },
                      { label: 'Critical', key: 'critical', color: 'text-red-400' },
                    ];
                    const active = states.filter(s => (counts[s.key] ?? 0) > 0);
                    return effectiveNodes.length === 0 ? (
                      <p className="text-xs text-gray-600">No nodes connected.</p>
                    ) : (
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {active.length > 0 ? active.map(s => (
                          <span key={s.key} className="text-xs">
                            <span className={`font-telin font-bold ${s.color}`}>{counts[s.key]}</span>
                            <span className="text-gray-600 ml-1">{s.label}</span>
                          </span>
                        )) : states.map(s => (
                          <span key={s.key} className="text-xs">
                            <span className="font-telin font-bold text-green-400">0</span>
                            <span className="text-gray-600 ml-1">{s.label}</span>
                          </span>
                        ))}
                      </div>
                    );
                  })()}
                />
              )}

              {/* Inference Density (Historical) — Team locked */}
              <InsightsLockedCard
                title="Inference Density (Historical)"
                icon={<Layers className="w-3.5 h-3.5" />}
                description="Historical playback of the inference density hive plot. Unlock peak-hour analysis and utilisation trends."
                tierRequired="team"
              />

              {/* Sovereignty Audit — Enterprise locked */}
              <InsightsLockedCard
                title="Sovereignty Audit"
                icon={<Shield className="w-3.5 h-3.5" />}
                description="Cryptographically signed compliance PDF. Audit trail of every telemetry destination, pairing event, and outbound connection."
                tierRequired="enterprise"
              />

            </div>
          )}

        </div>
      </div>
    </div>
    </>
  );
};

export default AIInsights;
