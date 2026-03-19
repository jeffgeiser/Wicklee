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

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Thermometer, Zap, HardDrive, Target, BarChart2,
  TrendingDown, Database, Scale, Cpu, Globe, Shield,
  Activity, Layers, CheckCircle, ChevronDown, History, Clock,
  Copy, Check, Server, Radio,
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
import InsightsBriefingCard from './insights/InsightsBriefingCard';
import { useMetricHistory, metricsToSample } from '../hooks/useMetricHistory';
import { evaluatePatterns } from '../lib/patternEngine';
import type { DetectedInsight, FleetNodeSummary } from '../lib/patternEngine';
import { appendRecentEvent, ONSET_SUPPRESSION_MS } from '../lib/insightLifecycle';

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

// ── InlineCopyButton — used by Top Finding curl snippet ───────────────────────

const InlineCopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }).catch(() => {});
    } else {
      try {
        const el = document.createElement('textarea');
        el.value = text;
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {}
    }
  }, [text]);
  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-[10px] font-medium text-gray-400 hover:text-gray-200 transition-colors shrink-0"
    >
      {copied
        ? <><Check className="w-3 h-3 text-green-400" />Copied</>
        : <><Copy  className="w-3 h-3" />Copy</>}
    </button>
  );
};

// ── Alert statefulness — types & constants ────────────────────────────────────

/** Time the raw condition must be continuously true before the card surfaces. */
const ALERT_ONSET_MS  = 15_000;         // 15 s
/** Minimum time a tier-1 alert card stays visible after condition clears. */
const ALERT_HOLD_MS   = 5 * 60_000;    // 5 min
/** Minimum time a pattern observation stays visible after condition stops firing. */
const OBS_HOLD_MS     = 10 * 60_000;   // 10 min
/** Maximum entries stored in the Recent Activity log. */
const MAX_LOG_ENTRIES = 50;

/** Cached pattern-engine observation with lifecycle timestamps. */
interface ObsEntry {
  insight:      DetectedInsight;
  firstFiredMs: number;   // preserved across re-evaluations
  resolvedMs:   number | null; // null = still actively firing
}

/** An entry in the session-scoped Recent Activity log. */
export interface AlertLogEntry {
  id:         string;
  title:      string;
  nodeLabel:  string;
  severity:   'red' | 'amber' | 'observation';
  firedAt:    number;
  resolvedAt: number;
}

function fmtLogDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60)  return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60)  return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtLogAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60)  return 'just now';
  const m = Math.round(s / 60);
  if (m < 60)  return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

// ── useAlertLatch — debounce + hold hook for tier-1 alert cards ───────────────
//
// Onset gate: condition must be continuously true for ALERT_ONSET_MS before
// the card renders. Prevents single-frame thermal spikes from flashing on screen.
//
// Hold period: once shown, the card stays visible for ALERT_HOLD_MS after the
// condition clears. During this time a green "✓ Resolved" badge overlays the
// card so engineers can see what just fired without it vanishing immediately.
//
// On expiry: the card disappears and `onClear` fires — used to append to the
// session alert log.

interface AlertLatchState {
  showing:  boolean;
  resolved: boolean;
  firedAt:  number | null;  // when the latch first fired (after onset gate)
}

function useAlertLatch(
  condition: boolean,
  {
    onsetMs = ALERT_ONSET_MS,
    holdMs  = ALERT_HOLD_MS,
    onClear,
  }: {
    onsetMs?: number;
    holdMs?:  number;
    onClear?: (info: { firedAt: number; resolvedAt: number }) => void;
  } = {},
): AlertLatchState {
  const [showing,  setShowing]  = useState(false);
  const [resolved, setResolved] = useState(false);
  const firedAtRef   = useRef<number | null>(null);
  const onsetTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onClearRef   = useRef(onClear);
  onClearRef.current = onClear;

  useEffect(() => {
    if (condition) {
      // Re-activated: cancel any pending hold, clear resolved badge
      if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
      setResolved(false);
      // Start onset timer only if not already showing / timing
      if (!onsetTimer.current && firedAtRef.current === null) {
        onsetTimer.current = setTimeout(() => {
          onsetTimer.current = null;
          firedAtRef.current = Date.now();
          setShowing(true);
        }, onsetMs);
      }
    } else {
      // Condition gone: cancel onset if it hasn't fired yet
      if (onsetTimer.current) { clearTimeout(onsetTimer.current); onsetTimer.current = null; }
      // If we were showing, start the hold countdown
      if (firedAtRef.current !== null && !holdTimer.current) {
        const resolvedAt = Date.now();
        setResolved(true);
        holdTimer.current = setTimeout(() => {
          holdTimer.current = null;
          const firedAt = firedAtRef.current!;
          firedAtRef.current = null;
          setShowing(false);
          setResolved(false);
          onClearRef.current?.({ firedAt, resolvedAt });
        }, holdMs);
      }
    }
  }, [condition, onsetMs, holdMs]);

  // Cleanup timers on unmount
  useEffect(() => () => {
    if (onsetTimer.current) clearTimeout(onsetTimer.current);
    if (holdTimer.current)  clearTimeout(holdTimer.current);
  }, []);

  return { showing, resolved, firedAt: firedAtRef.current };
}

// ── ResolvedBanner — overlays a resolved tier-1 card with a green badge ──────

const ResolvedBanner: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="relative opacity-70">
    {children}
    <div className="absolute inset-0 rounded-2xl pointer-events-none flex items-start justify-end p-3">
      <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-green-500/10 border border-green-500/20 backdrop-blur-sm">
        <CheckCircle className="w-3 h-3 text-green-400" />
        <span className="text-[10px] font-semibold text-green-400 font-telin tracking-wide uppercase">Resolved</span>
      </span>
    </div>
  </div>
);

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
  insightsTier: InsightsTier;
  canViewInsight: (id: number) => boolean;
  onFleetEvent?: (event: FleetEvent) => void;
  /** Cloud session token getter — used for WES history fetch (cloud/Mission Control only). */
  getToken?: () => Promise<string | null>;
  /** Days of retained history the user's tier unlocks. */
  historyDays?: number;
  /** Subscription tier for history range gating. */
  subscriptionTier?: SubscriptionTier;
  /**
   * Called when the operator clicks a "View source →" link in the Triage tab.
   * Should navigate to the Observability tab's Metric History panel.
   * Only meaningful in Cockpit (localhost) mode where /api/history is available.
   */
  onNavigateToObservability?: () => void;
}

// ── Main component ─────────────────────────────────────────────────────────────

const AIInsights: React.FC<AIInsightsProps> = ({
  nodes,
  insightsTier,
  canViewInsight,
  getToken,
  historyDays = 1,
  subscriptionTier = 'community',
  onFleetEvent,
  onNavigateToObservability,
}) => {

  // ── Hooks — all unconditional ──────────────────────────────────────────────

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

  // ── Alert log (session-scoped, Recent Activity panel) ─────────────────────
  const [alertLog, setAlertLog] = useState<AlertLogEntry[]>(() => {
    try {
      const raw = sessionStorage.getItem('wicklee-alert-log');
      return raw ? (JSON.parse(raw) as AlertLogEntry[]) : [];
    } catch { return []; }
  });
  const [logExpanded, setLogExpanded] = useState(false);

  const appendToLog = useCallback((entry: AlertLogEntry) => {
    setAlertLog(prev => {
      const updated = [entry, ...prev].slice(0, MAX_LOG_ENTRIES);
      try { sessionStorage.setItem('wicklee-alert-log', JSON.stringify(updated)); } catch {}
      return updated;
    });
  }, []);

  // ── Observation cache — sticky firstFiredMs + hold-after-clear ─────────────
  const obsCacheRef  = useRef(new Map<string, ObsEntry>());
  const [obsEntries, setObsEntries] = useState<ObsEntry[]>([]);

  /**
   * Onset suppression map — tracks the last timestamp a pattern_onset event was
   * emitted for each `${patternId}:${nodeId}` key.
   *
   * A new onset is suppressed if: Date.now() - lastEmittedMs < ONSET_SUPPRESSION_MS (15m).
   * This is intentionally longer than OBS_HOLD_MS (10m) to create a 5-minute quiet
   * gap after resolution — see insightLifecycle.ts for the full rationale.
   */
  const patternOnsetMapRef = useRef(new Map<string, number>());

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

    // Build fleet peer context for cross-node recommendations.
    // Each entry is a lightweight snapshot of a live fleet node.
    // The 90s online gate matches the SSE "last_seen" stale threshold.
    const ONLINE_GATE_MS = 90_000;
    const nowForGate     = Date.now();
    const fleetSummaries: FleetNodeSummary[] = metricsToProcess.map(m => {
      const wesScore  = computeNodeWes(m);
      const isNvGpu   = (m.nvidia_vram_total_mb ?? 0) >= 1024;
      const vramTotal = isNvGpu ? (m.nvidia_vram_total_mb ?? 0) : 0;
      const vramUsed  = isNvGpu ? (m.nvidia_vram_used_mb  ?? 0) : 0;
      const vramHeadroomPct = vramTotal > 0
        ? ((vramTotal - vramUsed) / vramTotal) * 100
        : null;

      // last_seen_ms is not in SentinelMetrics — use timestamp_ms as proxy;
      // if the frame is fresh (< 90s old) the node is considered online.
      const lastSeen    = m.timestamp_ms ?? 0;
      const isOnline    = nowForGate - lastSeen < ONLINE_GATE_MS;

      return {
        nodeId:              m.node_id,
        hostname:            m.hostname ?? m.node_id,
        isOnline,
        currentThermalState: m.thermal_state ?? null,
        currentWes:          wesScore,
        currentTokS:         m.ollama_tokens_per_second ?? m.vllm_tokens_per_sec ?? null,
        vramHeadroomPct,
        wesTier:             m.wes_tier ?? null,
      } satisfies FleetNodeSummary;
    });

    const allObservations: DetectedInsight[] = [];
    // Only evaluate patterns for non-restricted nodes
    for (const m of metricsToProcess.filter(m => !restrictedIdSet.has(m.node_id))) {
      const ns      = getNodeSettings(m.node_id);
      const history = metricHistory.getHistory(m.node_id);
      // Fleet context excludes this node — cross-node patterns filter it internally,
      // but excluding here keeps the list clean for single-node Cockpit mode.
      const peerContext = fleetSummaries.filter(s => s.nodeId !== m.node_id);
      const results = evaluatePatterns({
        nodeId:       m.node_id,
        hostname:     m.hostname ?? m.node_id,
        history,
        fleetContext: peerContext,
        kwhRate:      ns.kwhRate,
        wesTier:      m.wes_tier ?? null,
      });
      allObservations.push(...results);
    }

    // ── Observation cache: sticky firstFiredMs + hold-after-clear ─────────
    const cache  = obsCacheRef.current;
    const nowMs2 = Date.now();

    // Merge newly-active observations — preserve firstFiredMs across re-evals
    for (const result of allObservations) {
      const key      = `${result.patternId}:${result.nodeId}`;
      const existing = cache.get(key);
      const isNew    = !existing;

      cache.set(key, {
        insight:      result,
        firstFiredMs: existing?.firstFiredMs ?? nowMs2,
        resolvedMs:   null,   // still firing — clear any prior resolved timestamp
      });

      // ── Onset event (Live Activity Feed + localStorage buffer) ────────────
      // Only fires when:
      //   1. This is a genuinely new pattern (not a re-eval of an already-active one).
      //   2. Confidence is moderate or high — 'building' patterns are silent.
      //   3. The onset suppression window (15m) has elapsed since the last onset
      //      for this patternId+nodeId pair (prevents churn on borderline conditions).
      if (isNew && result.confidence !== 'building') {
        const lastOnsetMs = patternOnsetMapRef.current.get(key) ?? 0;
        if (nowMs2 - lastOnsetMs >= ONSET_SUPPRESSION_MS) {
          const nodeWes = fleetSummaries.find(s => s.nodeId === result.nodeId)?.currentWes ?? null;

          emitFleetEvent({
            id:          crypto.randomUUID(),
            ts:          nowMs2,
            type:        'pattern_onset',
            nodeId:      result.nodeId,
            hostname:    result.hostname,
            patternId:   result.patternId,
            action_id:   result.action_id,
            hook:        result.hook,
            wes_at_onset: nodeWes,
            detail:      `${result.title} · ${result.hook} on ${result.hostname}`,
          });

          appendRecentEvent({
            id:                 crypto.randomUUID(),
            ts:                 nowMs2,
            eventType:          'onset',
            nodeId:             result.nodeId,
            hostname:           result.hostname,
            patternId:          result.patternId,
            title:              result.title,
            action_id:          result.action_id,
            hook:               result.hook,
            recommendation:     result.recommendation,
            confidence:         result.confidence,
            wes_at_onset:       nodeWes,
            best_node_id:       result.best_node_id,
            best_node_hostname: result.best_node_hostname,
          });

          patternOnsetMapRef.current.set(key, nowMs2);
        }
      }
    }

    // Mark entries that are no longer firing as resolved; evict after OBS_HOLD_MS
    const pendingLog: AlertLogEntry[] = [];
    for (const [key, entry] of cache.entries()) {
      const stillActive = allObservations.some(r => `${r.patternId}:${r.nodeId}` === key);
      if (!stillActive) {
        if (entry.resolvedMs === null) {
          // First eval cycle where pattern is absent — start the hold countdown.
          cache.set(key, { ...entry, resolvedMs: nowMs2 });
        } else if (nowMs2 - entry.resolvedMs > OBS_HOLD_MS) {
          // OBS_HOLD_MS has elapsed — pattern is confirmed resolved.
          // durationMs = time the hardware was actually stressed, excluding the hold wait.
          // entry.resolvedMs is the timestamp the pattern FIRST stopped firing (lastSeenFiringMs).
          const durationMs = entry.resolvedMs - entry.firstFiredMs;

          pendingLog.push({
            id:        key,
            title:     entry.insight.title,
            nodeLabel: entry.insight.hostname,
            severity:  'observation',
            firedAt:   entry.firstFiredMs,
            resolvedAt: entry.resolvedMs,
          });

          // ── Resolved event (Live Activity Feed + localStorage buffer) ─────
          emitFleetEvent({
            id:        crypto.randomUUID(),
            ts:        nowMs2,
            type:      'pattern_resolved',
            nodeId:    entry.insight.nodeId,
            hostname:  entry.insight.hostname,
            patternId: entry.insight.patternId,
            action_id: entry.insight.action_id,
            hook:      entry.insight.hook,
            detail:    `${entry.insight.title} resolved on ${entry.insight.hostname}` +
                       (durationMs > 0 ? ` (${Math.round(durationMs / 60_000)}m active)` : ''),
          });

          appendRecentEvent({
            id:             crypto.randomUUID(),
            ts:             nowMs2,
            eventType:      'resolved',
            nodeId:         entry.insight.nodeId,
            hostname:       entry.insight.hostname,
            patternId:      entry.insight.patternId,
            title:          entry.insight.title,
            action_id:      entry.insight.action_id,
            hook:           entry.insight.hook,
            recommendation: entry.insight.recommendation,
            durationMs,
          });

          cache.delete(key);
        }
      }
    }

    // Flush evicted entries into the session log
    if (pendingLog.length > 0) {
      setAlertLog(prev => {
        const updated = [...pendingLog, ...prev].slice(0, MAX_LOG_ENTRIES);
        try { sessionStorage.setItem('wicklee-alert-log', JSON.stringify(updated)); } catch {}
        return updated;
      });
    }

    // Build sorted display list: active first, then resolved; newest first within each group
    const sorted: ObsEntry[] = [...cache.values()].sort((a, b) => {
      if ((a.resolvedMs === null) !== (b.resolvedMs === null)) {
        return a.resolvedMs === null ? -1 : 1;
      }
      return b.firstFiredMs - a.firstFiredMs;
    });
    setObsEntries(sorted);

    // Keep legacy observations state in sync (used by some downstream consumers)
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

  // Capture node labels while conditions are active (used by onClear log entries)
  const thermalNodeLabelRef = useRef('');
  const powerNodeLabelRef   = useRef('');
  const memNodeLabelRef     = useRef('');
  if (thermalFiring && thermalNodes.length > 0)
    thermalNodeLabelRef.current = thermalNodes.map(n => n.hostname ?? n.node_id ?? '').join(', ');
  if (powerFiring && powerNodes.length > 0)
    powerNodeLabelRef.current = powerNodes.map(n => n.hostname ?? n.node_id ?? '').join(', ');
  if (memFiring && memNodes.length > 0)
    memNodeLabelRef.current = memNodes.map(n => n.hostname ?? n.node_id ?? '').join(', ');

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

  const tcNodeLabelRef = useRef('');
  if (tcFiring && tcAlertNodes.length > 0)
    tcNodeLabelRef.current = tcAlertNodes.map(n => n.hostname ?? n.node_id ?? '').join(', ');

  // ── Tier-1 alert latches — debounce (15 s onset) + hold (5 min after clear) ─
  // useAlertLatch is a stable custom hook; always called in the same order.

  const thermalLatch = useAlertLatch(thermalFiring, {
    onClear: ({ firedAt, resolvedAt }) => appendToLog({
      id: `thermal-${firedAt}`, title: 'Thermal Degradation',
      nodeLabel: thermalNodeLabelRef.current, severity: 'red', firedAt, resolvedAt,
    }),
  });
  const powerLatch = useAlertLatch(powerFiring, {
    onClear: ({ firedAt, resolvedAt }) => appendToLog({
      id: `power-${firedAt}`, title: 'Power Anomaly',
      nodeLabel: powerNodeLabelRef.current, severity: 'amber', firedAt, resolvedAt,
    }),
  });
  const memLatch = useAlertLatch(memFiring, {
    onClear: ({ firedAt, resolvedAt }) => appendToLog({
      id: `memory-${firedAt}`, title: 'Memory Exhaustion',
      nodeLabel: memNodeLabelRef.current, severity: 'amber', firedAt, resolvedAt,
    }),
  });
  const tcLatch = useAlertLatch(tcFiring, {
    onClear: ({ firedAt, resolvedAt }) => appendToLog({
      id: `tc-${firedAt}`, title: 'Thermal Cost',
      nodeLabel: tcNodeLabelRef.current, severity: 'amber', firedAt, resolvedAt,
    }),
  });

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

  // ── Firing alerts array — fed from latch state (not raw condition) ─────────
  // Only latched (confirmed + onset-gated) alerts reach the Status Rail.
  // Resolved alerts (in hold period) still show on the Status Rail so engineers
  // can track exactly when conditions cleared.

  const firingAlerts: FiringAlert[] = [
    ...(thermalLatch.showing ? thermalNodes.map(n => ({
      id:        `thermal-${n.node_id}`,
      name:      thermalLatch.resolved ? 'Thermal Degradation ✓' : 'Thermal Degradation',
      nodeId:    n.hostname ?? n.node_id ?? '—',
      elapsedMs: thermalLatch.firedAt ? now - thermalLatch.firedAt : 0,
      severity:  'red' as const,
    })) : []),
    ...(powerLatch.showing ? powerNodes.map(n => ({
      id:        `power-${n.node_id}`,
      name:      powerLatch.resolved ? 'Power Anomaly ✓' : 'Power Anomaly',
      nodeId:    n.hostname ?? n.node_id ?? '—',
      elapsedMs: powerLatch.firedAt ? now - powerLatch.firedAt : 0,
      severity:  'amber' as const,
    })) : []),
    ...(memLatch.showing ? memNodes.map(n => ({
      id:        `memory-${n.node_id}`,
      name:      memLatch.resolved ? 'Memory Exhaustion ✓' : 'Memory Exhaustion',
      nodeId:    n.hostname ?? n.node_id ?? '—',
      elapsedMs: memLatch.firedAt ? now - memLatch.firedAt : 0,
      severity:  'amber' as const,
    })) : []),
    ...(tcLatch.showing ? tcAlertNodes.map(n => ({
      id:        `tc-cost-${n.node_id}`,
      name:      tcLatch.resolved ? 'Thermal Cost ✓' : 'Thermal Cost',
      nodeId:    n.hostname ?? n.node_id ?? '—',
      elapsedMs: tcLatch.firedAt ? now - tcLatch.firedAt : 0,
      severity:  ((tcPctByNode[n.node_id] ?? 0) >= 40 ? 'red' : 'amber') as 'red' | 'amber',
    })) : []),
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
              {/* ── 24h Morning Briefing ────────────────────────────────────────
                  Reads the localStorage recent-events buffer. Shows "what fired,
                  what resolved, what was dismissed" since the operator last looked.
                  Empty state collapses to a single compact dormant row.           */}
              <InsightsBriefingCard />

              {/* ── Fleet Pulse — live snapshot ───────────────────────────────
                  Four stat cells: nodes online, fleet tok/s, top WES node,
                  and fleet power draw. Pure useFleetStream()/SSE data —
                  no DuckDB required.                                           */}
              {effectiveNodes.length > 0 && (() => {
                // Top WES node — highest WES across the live fleet
                let topWesNode: SentinelMetrics | null = null;
                let topWesVal: number | null = null;
                for (const n of effectiveNodes) {
                  const w = computeNodeWes(n);
                  if (w != null && (topWesVal == null || w > topWesVal)) {
                    topWesVal = w;
                    topWesNode = n;
                  }
                }
                // Fleet wattage — sum of all reported draw values
                const fleetWatts = effectiveNodes.reduce<number | null>((sum, n) => {
                  const w = n.cpu_power_w ?? n.nvidia_power_draw_w ?? null;
                  return w != null ? (sum ?? 0) + w : sum;
                }, null);
                // Total node count: prefer fleet registry length; fall back to live count
                const nodesTotal = Math.max(nodes.length, effectiveNodes.length);
                return (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <Radio className="w-3 h-3 text-indigo-400/60 shrink-0" />
                      <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">
                        Fleet Pulse
                      </p>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">

                      {/* Nodes online */}
                      <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 flex flex-col gap-1">
                        <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-500">Online</p>
                        <div className="flex items-baseline gap-1.5">
                          <span className={`font-mono text-xl font-bold ${
                            effectiveNodes.length > 0 ? 'text-white' : 'text-gray-600'
                          }`}>{effectiveNodes.length}</span>
                          {nodesTotal > 0 && (
                            <span className="text-xs text-gray-600">/ {nodesTotal}</span>
                          )}
                        </div>
                        <p className="text-[9px] text-gray-600">node{effectiveNodes.length !== 1 ? 's' : ''}</p>
                      </div>

                      {/* Fleet throughput */}
                      <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 flex flex-col gap-1">
                        <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-500">Throughput</p>
                        <span className={`font-mono text-xl font-bold ${
                          fleetTokS != null && fleetTokS > 0 ? 'text-green-400' : 'text-gray-600'
                        }`}>
                          {fleetTokS != null ? fleetTokS.toFixed(1) : '—'}
                        </span>
                        <p className="text-[9px] text-gray-600">tok / sec</p>
                      </div>

                      {/* Top WES node */}
                      <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 flex flex-col gap-1">
                        <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-500">Top WES</p>
                        {topWesVal != null && topWesNode ? (
                          <>
                            <span className={`font-mono text-xl font-bold ${
                              topWesVal >= 3 ? 'text-green-400' : topWesVal >= 1.5 ? 'text-amber-400' : 'text-red-400'
                            }`}>
                              {topWesVal.toFixed(1)}
                            </span>
                            <p className="text-[9px] text-gray-600 truncate">
                              {topWesNode.hostname ?? topWesNode.node_id}
                            </p>
                          </>
                        ) : (
                          <>
                            <span className="font-mono text-xl font-bold text-gray-700">—</span>
                            <p className="text-[9px] text-gray-600">no active inference</p>
                          </>
                        )}
                      </div>

                      {/* Fleet power draw */}
                      <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 flex flex-col gap-1">
                        <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-500">Power Draw</p>
                        <span className={`font-mono text-xl font-bold ${
                          fleetWatts == null     ? 'text-gray-700'
                          : fleetWatts > 200     ? 'text-amber-400'
                          : fleetWatts > 50      ? 'text-gray-300'
                          :                        'text-green-400'
                        }`}>
                          {fleetWatts != null ? `${fleetWatts.toFixed(0)}W` : '—'}
                        </span>
                        <p className="text-[9px] text-gray-600">fleet total</p>
                      </div>

                    </div>
                  </div>
                );
              })()}

              {/* Alert Quartet — surfaced only after 15 s sustained onset gate.
                  Resolved cards stay visible for 5 min with a green "✓ Resolved" overlay. */}
              <div className="space-y-3">
                {thermalLatch.showing && thermalNodes.map(n => (
                  <div key={n.node_id} id={`insight-thermal-${n.node_id}`}>
                    {thermalLatch.resolved
                      ? <ResolvedBanner><ThermalDegradationCard node={n} showNodeHeader={effectiveNodes.length > 1} /></ResolvedBanner>
                      : <ThermalDegradationCard node={n} showNodeHeader={effectiveNodes.length > 1} />}
                  </div>
                ))}
                {powerLatch.showing && powerNodes.map(n => (
                  <div key={n.node_id} id={`insight-power-${n.node_id}`}>
                    {powerLatch.resolved
                      ? <ResolvedBanner><PowerAnomalyCard node={n} baselineWatts={isLocalHost ? sessionBaselineWatts : null} showNodeHeader={effectiveNodes.length > 1} /></ResolvedBanner>
                      : <PowerAnomalyCard node={n} baselineWatts={isLocalHost ? sessionBaselineWatts : null} showNodeHeader={effectiveNodes.length > 1} />}
                  </div>
                ))}
                {memLatch.showing && memNodes.map(n => (
                  <div key={n.node_id} id={`insight-memory-${n.node_id}`}>
                    {memLatch.resolved
                      ? <ResolvedBanner><MemoryExhaustionCard node={n} showNodeHeader={effectiveNodes.length > 1} /></ResolvedBanner>
                      : <MemoryExhaustionCard node={n} showNodeHeader={effectiveNodes.length > 1} />}
                  </div>
                ))}
                {tcLatch.showing && tcAlertNodes.map(n => (
                  <div key={n.node_id} id={`insight-thermal-cost-${n.node_id}`}>
                    {tcLatch.resolved
                      ? <ResolvedBanner>
                          <ThermalCostAlertCard node={n} tcPct={tcPctByNode[n.node_id] ?? 0} rateOfChangePct={tcRateByNode[n.node_id] ?? 0} showNodeHeader={effectiveNodes.length > 1} />
                        </ResolvedBanner>
                      : <ThermalCostAlertCard node={n} tcPct={tcPctByNode[n.node_id] ?? 0} rateOfChangePct={tcRateByNode[n.node_id] ?? 0} showNodeHeader={effectiveNodes.length > 1} />}
                  </div>
                ))}

                {/* Dormant monitoring rows — shown for conditions that are NOT latched.
                    Resolved (hold-period) conditions skip the dormant row since the
                    card above is still visible. */}
                {(() => {
                  const dormant = [
                    ...(!thermalLatch.showing ? [{ key: 'thermal', icon: <Thermometer className="w-3.5 h-3.5" />, label: 'Thermal Degradation', reading: thermalReading }] : []),
                    ...(!powerLatch.showing   ? [{ key: 'power',   icon: <Zap          className="w-3.5 h-3.5" />, label: 'Power Anomaly',       reading: powerReading   }] : []),
                    ...(!memLatch.showing     ? [{ key: 'mem',     icon: <HardDrive    className="w-3.5 h-3.5" />, label: 'Memory Exhaustion',   reading: memReading     }] : []),
                    ...(!tcLatch.showing      ? [{ key: 'tc',      icon: <Thermometer  className="w-3.5 h-3.5" />, label: 'Thermal Cost',         reading: tcReading      }] : []),
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

              {/* ── Top Finding — highest-confidence active observation ──────
                  Surfaces the single most important currently active pattern as
                  a summary card, with its action_id mapped to a curl command
                  targeting /api/v1/insights/latest.
                  Intentionally shown before the full Observations list so that
                  a returning operator knows the top priority before diving in.
                  Hidden when all observations are resolved (none active).       */}
              {(() => {
                const topObs = obsEntries.find(e => e.resolvedMs === null);
                if (!topObs) return null;
                const ins = topObs.insight;
                const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)
                  ?? 'https://api.wicklee.dev';
                const curlText = `curl -s -H "X-API-Key: <key>" ${apiBase}/api/v1/insights/latest`;
                return (
                  <div className="bg-indigo-600/8 border border-indigo-600/20 rounded-2xl p-4 space-y-3">

                    {/* Header row */}
                    <div className="flex items-center gap-2">
                      <Server className="w-3 h-3 text-indigo-400/60 shrink-0" />
                      <p className="text-[9px] font-semibold uppercase tracking-widest text-indigo-400/70 flex-1">
                        Top Finding
                      </p>
                      <span className={`text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full border ${
                        ins.confidence === 'high'
                          ? 'text-red-400/90 border-red-500/30 bg-red-500/10'
                          : ins.confidence === 'moderate'
                          ? 'text-amber-400/90 border-amber-500/30 bg-amber-500/10'
                          : 'text-gray-400 border-gray-700 bg-gray-800/80'
                      }`}>
                        {ins.confidence ?? 'low'}
                      </span>
                    </div>

                    {/* Finding body */}
                    <div>
                      <p className="text-sm font-semibold text-gray-200">{ins.title}</p>
                      <p className="text-[10px] text-gray-500 mt-0.5 truncate">
                        {ins.hostname} · {ins.hook}
                      </p>
                      <p className="text-xs text-gray-400 mt-2 leading-relaxed">
                        {ins.recommendation}
                      </p>
                    </div>

                    {/* action_id → curl snippet */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">
                          API action_id
                        </p>
                        <span className="font-mono text-[9px] text-indigo-400/70 border border-indigo-600/20 bg-indigo-600/5 px-1.5 py-0.5 rounded">
                          {ins.action_id}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <pre className="flex-1 font-mono text-[10px] text-gray-400 bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 overflow-x-auto whitespace-pre min-w-0">
                          {curlText}
                        </pre>
                        <InlineCopyButton text={curlText} />
                      </div>
                    </div>

                    {/* View source → link (Cockpit only — Metric History panel) */}
                    {isLocalHost && onNavigateToObservability && (
                      <button
                        onClick={onNavigateToObservability}
                        className="flex items-center gap-1.5 text-[10px] text-indigo-400/60 hover:text-indigo-400 transition-colors pt-1"
                      >
                        <Activity className="w-3 h-3" />
                        View raw metric history →
                      </button>
                    )}

                  </div>
                );
              })()}

              {/* ── Observations — pattern engine briefing feed ─────────────
                  Active observations are shown first; resolved (hold-period) entries
                  appear dimmed below with a "✓ Resolved" chip.
                  "Clear All Resolved" removes just the held entries so engineers
                  can acknowledge them like an inbox. */}
              {obsEntries.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <SectionHeader>Observations</SectionHeader>
                    {obsEntries.some(e => e.resolvedMs !== null) && (
                      <button
                        onClick={() => {
                          // Evict all resolved entries from cache and state
                          for (const [key, entry] of obsCacheRef.current.entries()) {
                            if (entry.resolvedMs !== null) obsCacheRef.current.delete(key);
                          }
                          setObsEntries(prev => prev.filter(e => e.resolvedMs === null));
                        }}
                        className="flex items-center gap-1.5 text-[10px] text-gray-500 hover:text-gray-300 transition-colors -mt-4 mb-4"
                      >
                        <CheckCircle className="w-3 h-3" />
                        Clear resolved
                      </button>
                    )}
                  </div>
                  {obsEntries.map(entry => (
                    <ObservationCard
                      key={`${entry.insight.patternId}-${entry.insight.nodeId}`}
                      insight={{ ...entry.insight, firstFiredMs: entry.firstFiredMs }}
                      showNodeHeader={effectiveNodes.length > 1}
                      resolvedMs={entry.resolvedMs}
                      onDismiss={() => emitFleetEvent({
                        id:        crypto.randomUUID(),
                        ts:        Date.now(),
                        type:      'pattern_dismissed',
                        nodeId:    entry.insight.nodeId,
                        hostname:  entry.insight.hostname,
                        patternId: entry.insight.patternId,
                        action_id: entry.insight.action_id,
                        hook:      entry.insight.hook,
                        detail:    `${entry.insight.title} dismissed (1h) on ${entry.insight.hostname}`,
                      })}
                    />
                  ))}
                </div>
              )}

              {/* ── Recent Activity — session-scoped alert history ──────────── */}
              {alertLog.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <button
                      onClick={() => setLogExpanded(v => !v)}
                      className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-gray-500 hover:text-gray-400 transition-colors"
                    >
                      <History className="w-3.5 h-3.5" />
                      Recent Activity ({alertLog.length})
                      <ChevronDown className={`w-3 h-3 transition-transform duration-150 ${logExpanded ? 'rotate-180' : ''}`} />
                    </button>
                    <button
                      onClick={() => {
                        setAlertLog([]);
                        try { sessionStorage.removeItem('wicklee-alert-log'); } catch {}
                      }}
                      className="text-[10px] text-gray-600 hover:text-gray-400 transition-colors"
                    >
                      Clear all
                    </button>
                  </div>

                  {logExpanded && (
                    <div className="rounded-2xl border border-gray-800 overflow-hidden">
                      {alertLog.map((entry, i) => (
                        <div
                          key={entry.id}
                          className={`flex items-center gap-3 px-4 py-2.5 ${
                            i < alertLog.length - 1 ? 'border-b border-gray-800/60' : ''
                          } bg-gray-900`}
                        >
                          <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                            entry.severity === 'red'
                              ? 'bg-red-500/50'
                              : entry.severity === 'amber'
                              ? 'bg-amber-500/50'
                              : 'bg-indigo-500/50'
                          }`} />
                          <div className="flex-1 min-w-0">
                            <span className="text-xs text-gray-400">{entry.title}</span>
                            {entry.nodeLabel && (
                              <span className="text-[10px] text-gray-600 ml-2 font-telin">{entry.nodeLabel}</span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            <span className="font-telin text-[10px] text-gray-600 flex items-center gap-1">
                              <Clock className="w-2.5 h-2.5" />
                              {fmtLogDuration(entry.resolvedAt - entry.firedAt)}
                            </span>
                            <span className="font-telin text-[10px] text-gray-700">
                              {fmtLogAge(now - entry.resolvedAt)}
                            </span>
                          </div>
                        </div>
                      ))}
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
