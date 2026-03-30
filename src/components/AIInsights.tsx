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
  TrendingDown, Database, Cpu, Globe, Shield,
  Activity, Layers, CheckCircle, ChevronDown, History, Clock,
  Copy, Check, Server, Radio, FileText,
} from 'lucide-react';

import { NodeAgent, SentinelMetrics, InsightsTier, FleetEvent, SubscriptionTier, ObservabilityNavParams } from '../types';
import { useFleetObservations } from '../hooks/useFleetObservations';
import type { FleetObservation } from '../hooks/useFleetObservations';
import { useFleetStream } from '../contexts/FleetStreamContext';
import EventFeed from './EventFeed';
import { computeWES, computeRawWES, thermalCostPct } from '../utils/wes';
import { INFERENCE_VRAM_THRESHOLD_MB } from '../utils/efficiency';
import { getNodePowerW } from '../utils/power';
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
import SiliconFitAudit from './insights/tier2/SiliconFitAudit';

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
import AccordionObservationCard from './insights/AccordionObservationCard';
import CompactMonitoringStrip from './insights/CompactMonitoringStrip';
import ModelFitMiniTile from './insights/ModelFitMiniTile';
import FleetHeaderBar from './insights/FleetHeaderBar';
import InsightsBriefingCard from './insights/InsightsBriefingCard';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip } from 'recharts';
import { useMetricHistory, metricsToSample } from '../hooks/useMetricHistory';
import { useLocalObservations } from '../hooks/useLocalObservations';
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
  const watts = getNodePowerW(m);
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

// ── InlineCopyAction — used by Top Finding action buttons ─────────────────────

const InlineCopyAction: React.FC<{ text: string; label: string }> = ({ text, label }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [text]);
  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700
                 border border-gray-700 hover:border-gray-600 transition-colors group"
    >
      <code className="text-[10px] font-mono text-gray-300 group-hover:text-white truncate max-w-[180px]">
        {label}
      </code>
      {copied
        ? <Check className="w-3 h-3 text-green-400 shrink-0" />
        : <Copy  className="w-3 h-3 text-gray-500 group-hover:text-gray-300 shrink-0" />
      }
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
  /** Timestamp (ms) of the last time this condition fired. Shows "Last warning: Xm ago" */
  lastFiredMs?: number | null;
  /** Detail string for the last-fired line (e.g. model name, node hostname) */
  lastFiredDetail?: string | null;
}> = ({ icon, label, status, lastFiredMs, lastFiredDetail }) => {
  const ago = lastFiredMs != null ? Math.max(0, Math.round((Date.now() - lastFiredMs) / 60000)) : null;
  const agoText = ago != null
    ? ago < 1 ? 'just now' : ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`
    : null;
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl px-4 py-3 flex items-center gap-3">
      <span className="text-gray-600 shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">{label}</p>
        <p className="text-xs text-gray-700 mt-0.5">{status}</p>
        {agoText && (
          <p className="text-[10px] text-gray-600 mt-0.5 italic">
            Last warning: {agoText}{lastFiredDetail ? ` · ${lastFiredDetail}` : ''}
          </p>
        )}
      </div>
      <div className="w-1.5 h-1.5 rounded-full bg-green-500/40 animate-pulse shrink-0" />
    </div>
  );
};

// ── WES Leaderboard (lite) ────────────────────────────────────────────────────

const WesLeaderboardLite: React.FC<{ nodes: SentinelMetrics[] }> = ({ nodes }) => {
  const ranked = nodes
    .map(m => {
      const tps   = m.ollama_tokens_per_second ?? m.vllm_tokens_per_sec ?? null;
      const watts = getNodePowerW(m);
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
  onNavigateToObservability?: (params?: ObservabilityNavParams) => void;
}

// ── LocalPerformanceHistory — DuckDB-backed multi-metric chart (localhost) ─────
//
// Fetches the last 1 hour of raw samples from GET /api/history and renders a
// selectable multi-metric area chart (tok/s, power, GPU%, memory%).

type PerfMetric = 'tps' | 'power' | 'gpu' | 'mem';
const PERF_METRICS: { key: PerfMetric; label: string; unit: string; color: string }[] = [
  { key: 'tps',   label: 'Tok/s',   unit: ' tok/s', color: '#22d3ee' },
  { key: 'power', label: 'Power',   unit: 'W',      color: '#a78bfa' },
  { key: 'gpu',   label: 'GPU %',   unit: '%',      color: '#34d399' },
  { key: 'mem',   label: 'Memory %',unit: '%',      color: '#f472b6' },
];

const LocalPerformanceHistory: React.FC<{ nodeId: string }> = ({ nodeId }) => {
  const [metric, setMetric] = React.useState<PerfMetric>('tps');
  const [samples, setSamples] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!nodeId) return;
    setLoading(true);
    try {
      const to   = Date.now();
      const from = to - 3_600_000; // 1 hour
      const r = await fetch(`/api/history?node_id=${encodeURIComponent(nodeId)}&from=${from}&to=${to}`);
      if (r.ok) {
        const data = await r.json();
        setSamples(data.samples ?? []);
      }
    } catch { /* agent unavailable */ }
    setLoading(false);
  }, [nodeId]);

  React.useEffect(() => { load(); }, [load]);
  // Auto-refresh every 60s
  React.useEffect(() => {
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const cfg = PERF_METRICS.find(m => m.key === metric)!;
  const getValue = (s: any): number | undefined => {
    switch (metric) {
      case 'tps':   return s.tps ?? s.tps_avg ?? undefined;
      case 'power': return s.gpu_power_w ?? s.cpu_power_w ?? undefined;
      case 'gpu':   return s.gpu_util_pct ?? undefined;
      case 'mem':   return s.mem_pressure_pct ?? (s.mem_total_mb > 0 ? (s.mem_used_mb / s.mem_total_mb) * 100 : undefined);
    }
  };

  const chartData = samples
    .map(s => ({ ts: s.ts_ms, v: getValue(s) }))
    .filter(d => d.v !== undefined);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <BarChart2 className="w-3.5 h-3.5 text-gray-500 shrink-0" />
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">Performance History</span>
          <span className="text-[9px] text-gray-700 font-mono">1h</span>
        </div>
        <div className="flex items-center gap-1 bg-gray-950 border border-gray-800 rounded-lg p-0.5">
          {PERF_METRICS.map(m => (
            <button
              key={m.key}
              onClick={() => setMetric(m.key)}
              className={`px-2 py-1 rounded text-[9px] font-semibold transition-colors ${
                metric === m.key
                  ? 'bg-gray-800 text-white'
                  : 'text-gray-600 hover:text-gray-400'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {chartData.length > 1 ? (
        <div style={{ width: '100%', height: 160 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="perf-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={cfg.color} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={cfg.color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="ts"
                tick={{ fontSize: 9, fill: '#6b7280' }}
                tickFormatter={(ts: number) => {
                  const d = new Date(ts);
                  return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
                }}
                minTickGap={40}
              />
              <YAxis hide domain={['auto', 'auto']} />
              <Tooltip
                contentStyle={{ background: '#111', border: '1px solid #374151', borderRadius: 8, fontSize: 10 }}
                formatter={(v: number) => [`${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}${cfg.unit}`, cfg.label]}
                labelFormatter={(ts: number) => {
                  const d = new Date(ts);
                  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                }}
              />
              <Area
                type="monotone"
                dataKey="v"
                stroke={cfg.color}
                strokeWidth={1.5}
                fill="url(#perf-grad)"
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="h-40 flex flex-col items-center justify-center text-center">
          <Database className="w-5 h-5 text-gray-700 mb-2" />
          <p className="text-xs text-gray-600">{loading ? 'Loading…' : 'No samples in this window.'}</p>
          <p className="text-[10px] text-gray-700 mt-1">Run some inference — history collects at 1 Hz.</p>
        </div>
      )}
      <p className="text-[9px] text-gray-700">{chartData.length} samples</p>
    </div>
  );
};

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
  /** Shared node selection for WES + Metrics history charts */
  const [perfNodeId, setPerfNodeId] = useState<string | null>(null);

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
  const [showResolved, setShowResolved] = useState(false);

  // ── Server-side fleet observations (Phase 4B — cloud only) ─────────────────
  const { observations: serverObservations, acknowledge: acknowledgeObs } = useFleetObservations({
    getToken,
    state: 'all',
    skip: isLocalHost,
  });

  // ── Local agent observations (Patterns A/B/J/L — localhost only) ───────────
  const { observations: localAgentObs } = useLocalObservations(!isLocalHost);

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
  // Persist onset timestamps in localStorage so suppression survives tab switches
  // and page refreshes. Without this, switching tabs remounts the component and
  // resets the Map, causing every pattern to re-fire as "new."
  const patternOnsetMapRef = useRef<Map<string, number>>((() => {
    try {
      const stored = localStorage.getItem('wicklee:patternOnsetMap');
      if (stored) {
        const entries: [string, number][] = JSON.parse(stored);
        // Prune entries older than ONSET_SUPPRESSION_MS (15 min)
        const cutoff = Date.now() - ONSET_SUPPRESSION_MS;
        return new Map(entries.filter(([, ts]) => ts > cutoff));
      }
    } catch {}
    return new Map<string, number>();
  })());

  // Thermal Cost % rolling history — 30-frame window per node for rate-of-change detection.
  // At typical SSE cadence (~1 frame/s), 30 frames ≈ 30 seconds; adjust window as needed.
  const tcPctHistoryRef = useRef<Record<string, number[]>>({});

  // Transition tracking for FleetEvent emissions
  const prevThermalFiringRef  = useRef(false);
  const prevEvictionActiveRef  = useRef(false);
  const lastEvictionFiredRef   = useRef<number | null>(null);
  const lastEvictionDetailRef  = useRef<string | null>(null);
  const prevIdleActiveRef      = useRef(false);
  const lastIdleFiredRef       = useRef<number | null>(null);
  const lastIdleDetailRef      = useRef<string | null>(null);
  const prevFitModelRef       = useRef<string | null>(null);

  // ── Per-node activity tracking for Mission Control (fleet) ────────────────
  // Mirrors the Cockpit's lastActiveTsMs / firstMessageTs / hadAnyActivity
  // refs, but keyed by node_id so they work across an entire fleet.
  const nodeLastActiveMsRef = useRef<Record<string, number>>({});
  const nodeSessionStartRef = useRef<Record<string, number>>({});
  const nodeHadActivityRef  = useRef<Record<string, boolean>>({});

  // Fleet data from SSE context
  const { allNodeMetrics, lastSeenMsMap, addFleetEvent, fleetEvents } = useFleetStream();

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

          const watts = getNodePowerW(data);
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
        os:           m.os ?? null,
        subscriptionTier: subscriptionTier as 'community' | 'pro' | 'team' | 'enterprise',
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

      // Preserve resolvedMs if the pattern was already in hold (flickering condition).
      // Only clear resolvedMs for genuinely new patterns. This prevents noisy conditions
      // from resetting the OBS_HOLD_MS countdown on every re-fire cycle.
      cache.set(key, {
        insight:      result,
        firstFiredMs: existing?.firstFiredMs ?? nowMs2,
        resolvedMs:   isNew ? null : (existing?.resolvedMs ?? null),
      });

      // ── Onset event (Live Activity Feed + localStorage buffer) ────────────
      // Only fires when:
      //   1. This is a genuinely new pattern (not a re-eval of an already-active one).
      //   2. Confidence is moderate or high — 'building' patterns are silent.
      //   3. Per-node suppression: ONSET_SUPPRESSION_MS has elapsed for this patternId+nodeId.
      //   4. Fleet-wide suppression: same patternId hasn't fired on ANY node in the
      //      last 60s — prevents 3 nodes from spamming the same pattern simultaneously.
      if (isNew && result.confidence !== 'building') {
        const lastOnsetMs = patternOnsetMapRef.current.get(key) ?? 0;
        // Fleet-wide: check if this patternId fired on ANY node in the last 60s
        const FLEET_COALESCE_MS = 60_000;
        const fleetKey = `fleet:${result.patternId}`;
        const lastFleetOnsetMs = patternOnsetMapRef.current.get(fleetKey) ?? 0;
        const perNodeOk = nowMs2 - lastOnsetMs >= ONSET_SUPPRESSION_MS;
        const fleetOk  = nowMs2 - lastFleetOnsetMs >= FLEET_COALESCE_MS;

        if (perNodeOk && fleetOk) {
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
          patternOnsetMapRef.current.set(fleetKey, nowMs2);
          // Persist to localStorage so suppression survives tab switches.
          try {
            localStorage.setItem('wicklee:patternOnsetMap',
              JSON.stringify([...patternOnsetMapRef.current.entries()]));
          } catch {}
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
    const w   = getNodePowerW(m);
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
        const watts      = getNodePowerW(n);
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
    const watts  = getNodePowerW(node);
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
      const w = getNodePowerW(n);
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
      lastEvictionFiredRef.current  = now;
      lastEvictionDetailRef.current = `${m.ollama_active_model ?? 'model'} on ${m.hostname ?? m.node_id}`;
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

  useEffect(() => {
    if (!isLocalHost) return;
    const now = Date.now();
    if (tier2IdleActive && !prevIdleActiveRef.current && m) {
      lastIdleFiredRef.current  = now;
      lastIdleDetailRef.current = m.hostname ?? m.node_id;
      emitFleetEvent({
        id:       `${now}-idle-cost`,
        ts:       now,
        type:     'idle_resource_warning',
        nodeId:   m.node_id,
        hostname: m.hostname ?? m.node_id,
        detail:   `Idle for ${Math.round((now - lastActiveTsMs) / 60000)}m`,
      });
    }
    prevIdleActiveRef.current = tier2IdleActive;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier2IdleActive, isLocalHost]);

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
              {/* ── Fleet Header HUD — pulse stats + health pips ──────────── */}
              {(() => {
                // Top WES node
                let topWesNode: SentinelMetrics | null = null;
                let topWesVal: number | null = null;
                for (const n of effectiveNodes) {
                  const w = computeNodeWes(n);
                  if (w != null && (topWesVal == null || w > topWesVal)) {
                    topWesVal = w;
                    topWesNode = n;
                  }
                }
                // Fleet wattage
                const fleetWatts = effectiveNodes.reduce<number | null>((sum, n) => {
                  const w = getNodePowerW(n);
                  return w != null ? (sum ?? 0) + w : sum;
                }, null);
                const nodesTotal = Math.max(nodes.length, effectiveNodes.length);
                // Health pips — only dormant (non-latched) dimensions
                const healthPips = [
                  ...(!thermalLatch.showing ? [{ key: 'thermal', icon: <Thermometer className="w-3 h-3" />, label: 'Thermal',      reading: thermalReading }] : []),
                  ...(!powerLatch.showing   ? [{ key: 'power',   icon: <Zap          className="w-3 h-3" />, label: 'Power',        reading: powerReading   }] : []),
                  ...(!memLatch.showing     ? [{ key: 'mem',     icon: <HardDrive    className="w-3 h-3" />, label: 'Memory',       reading: memReading     }] : []),
                  ...(!tcLatch.showing      ? [{ key: 'tc',      icon: <Thermometer  className="w-3 h-3" />, label: 'TC',           reading: tcReading      }] : []),
                ];
                return (
                  <FleetHeaderBar
                    onlineCount={effectiveNodes.length}
                    totalCount={nodesTotal}
                    fleetTokS={fleetTokS}
                    topWes={topWesVal}
                    topWesHost={topWesNode ? (topWesNode.hostname ?? topWesNode.node_id) : null}
                    fleetWatts={fleetWatts}
                    healthPips={healthPips}
                  />
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
              </div>

              {/* ── Server-side Fleet Observations (Phase 4B — cloud only) ───
                  Essential Four alert observations from the cloud evaluator task.
                  Rendered as red (critical) / amber (warning) severity cards
                  with context, acknowledge button, and cross-nav to Observability. */}
              {!isLocalHost && serverObservations.length > 0 && (
                <div className="space-y-2">
                  <SectionHeader>Fleet Alerts</SectionHeader>
                  {serverObservations
                    .filter(o => showResolved || o.state === 'open')
                    .map(obs => {
                      const isCritical = obs.severity === 'critical';
                      const isOpen     = obs.state === 'open';
                      const isAcked    = obs.state === 'acknowledged';
                      const nodeHost   = effectiveNodes.find(n => n.node_id === obs.node_id)?.hostname ?? obs.node_id;
                      let ctx: Record<string, unknown> = {};
                      try { if (obs.context_json) ctx = JSON.parse(obs.context_json); } catch {}

                      return (
                        <div
                          key={obs.id}
                          className={`rounded-2xl border p-4 transition-all ${
                            !isOpen
                              ? 'border-gray-800/40 bg-gray-900/30 opacity-60'
                              : isCritical
                              ? 'border-red-500/30 bg-red-500/5'
                              : 'border-amber-500/30 bg-amber-500/5'
                          }`}
                        >
                          {/* Header */}
                          <div className="flex items-center gap-2 mb-2">
                            <span className={`w-2 h-2 rounded-full shrink-0 ${
                              !isOpen ? 'bg-gray-600' : isCritical ? 'bg-red-500 animate-pulse' : 'bg-amber-500'
                            }`} />
                            <span className={`text-[9px] font-bold uppercase tracking-widest ${
                              !isOpen ? 'text-gray-500' : isCritical ? 'text-red-400/80' : 'text-amber-400/80'
                            }`}>
                              {obs.severity}
                            </span>
                            <span className="ml-auto text-[9px] text-gray-600 font-mono">
                              {nodeHost}
                            </span>
                            {!isOpen && (
                              <span className="text-[9px] text-green-500/70 flex items-center gap-1">
                                <CheckCircle className="w-3 h-3" />
                                {isAcked ? 'Acknowledged' : 'Resolved'}
                              </span>
                            )}
                          </div>

                          {/* Title + Detail */}
                          <p className={`text-sm font-semibold ${isOpen ? 'text-gray-200' : 'text-gray-500'}`}>
                            {obs.title}
                          </p>
                          <p className={`text-xs mt-1 leading-relaxed ${isOpen ? 'text-gray-400' : 'text-gray-600'}`}>
                            {obs.detail}
                          </p>

                          {/* Context chips */}
                          {Object.keys(ctx).length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mt-2">
                              {Object.entries(ctx).filter(([, v]) => v != null).slice(0, 4).map(([k, v]) => (
                                <span key={k} className="text-[9px] px-1.5 py-0.5 rounded bg-gray-800/80 text-gray-500 font-mono">
                                  {k.replace(/_/g, ' ')}: {String(v)}
                                </span>
                              ))}
                            </div>
                          )}

                          {/* Action row */}
                          <div className="flex items-center gap-3 mt-3">
                            {isOpen && (
                              <button
                                onClick={() => acknowledgeObs(obs.id)}
                                className="text-[10px] text-gray-400 hover:text-gray-200 transition-colors flex items-center gap-1"
                              >
                                <CheckCircle className="w-3 h-3" />
                                Acknowledge
                              </button>
                            )}
                            {onNavigateToObservability && (
                              <button
                                onClick={() => onNavigateToObservability({ nodeId: obs.node_id, centerMs: obs.fired_at_ms })}
                                className="text-[10px] text-indigo-400/60 hover:text-indigo-400 transition-colors flex items-center gap-1"
                              >
                                <Activity className="w-3 h-3" />
                                View in Timeline →
                              </button>
                            )}
                            <span className="ml-auto text-[9px] text-gray-700 font-mono">
                              {new Date(obs.fired_at_ms).toLocaleTimeString()}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}

              {/* ── Hardware Observations (localhost only — agent-side Patterns A/B/J/L) ──
                  Server-evaluated against the DuckDB 1-hour buffer. Displayed as
                  accordion cards identical to the pattern-engine observations below. */}
              {isLocalHost && localAgentObs.length > 0 && (
                <div className="space-y-2">
                  <SectionHeader>Hardware Observations</SectionHeader>
                  {localAgentObs.map(insight => (
                    <AccordionObservationCard
                      key={`${insight.patternId}-${insight.nodeId}`}
                      insight={insight}
                      showNodeHeader={false}
                    />
                  ))}
                </div>
              )}

              {/* ── Cloud-Only placeholders (localhost only) ─────────────────
                  Show what patterns require fleet context so the user knows what
                  they're missing without a cloud connection. */}
              {isLocalHost && (
                <div className="space-y-2 mt-2">
                  {[
                    {
                      id: 'wes_velocity_drop',
                      label: 'WES Velocity Drop',
                      desc: 'Detects rapid WES score decline across 10-minute fleet-wide trending windows.',
                    },
                    {
                      id: 'fleet_load_imbalance',
                      label: 'Fleet Load Imbalance',
                      desc: 'Identifies nodes under thermal stress while healthier peers have spare capacity.',
                    },
                    {
                      id: 'efficiency_penalty_drag',
                      label: 'Efficiency Penalty Drag',
                      desc: 'Catches hidden WES penalties from context window, batch fragmentation, and KV cache overhead.',
                    },
                  ].map(p => (
                    <div
                      key={p.id}
                      className="rounded-2xl border border-gray-800/40 bg-gray-900/30 p-4 flex items-center gap-3 opacity-50"
                    >
                      <Globe className="w-4 h-4 text-gray-600 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">
                          {p.label}
                          <span className="ml-2 text-[9px] font-normal tracking-normal text-gray-700">Cloud-Only</span>
                        </p>
                        <p className="text-xs text-gray-700 mt-0.5 truncate">{p.desc}</p>
                      </div>
                      <a
                        href="https://wicklee.dev"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] text-indigo-400/50 hover:text-indigo-400 transition-colors whitespace-nowrap"
                      >
                        Pair with wicklee.dev →
                      </a>
                    </div>
                  ))}
                </div>
              )}

              {/* ── Observations — pattern engine briefing feed ─────────────
                  Active observations are shown first; resolved (hold-period) entries
                  appear dimmed below with a "✓ Resolved" chip.
                  "Clear All Resolved" removes just the held entries so engineers
                  can acknowledge them like an inbox. */}
              {obsEntries.length > 0 && (() => {
                // ── Dedup bidirectional patterns ──────────────────────────
                const deduped: Array<ObsEntry & { groupedNodes?: Array<{ nodeId: string; hostname: string }> }> = [];
                const byPattern = new Map<string, ObsEntry[]>();
                for (const e of obsEntries) {
                  const key = e.insight.patternId;
                  const arr = byPattern.get(key) ?? [];
                  arr.push(e);
                  byPattern.set(key, arr);
                }
                for (const [pid, group] of byPattern) {
                  if (pid === 'fleet_load_imbalance' && group.length >= 2) {
                    const primary = group.sort((a, b) => b.firstFiredMs - a.firstFiredMs)[0];
                    deduped.push({
                      ...primary,
                      groupedNodes: group.map(e => ({
                        nodeId:   e.insight.nodeId,
                        hostname: e.insight.hostname,
                      })),
                    });
                  } else {
                    deduped.push(...group);
                  }
                }

                // Filter: hide resolved by default
                const hasResolved = deduped.some(e => e.resolvedMs !== null);
                const visibleObs = showResolved ? deduped : deduped.filter(e => e.resolvedMs === null);

                return (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <SectionHeader>Observations</SectionHeader>
                      <div className="flex items-center gap-3 -mt-4 mb-4">
                        {hasResolved && (
                          <button
                            onClick={() => setShowResolved(v => !v)}
                            className={`flex items-center gap-1.5 text-[10px] transition-colors ${
                              showResolved ? 'text-indigo-400 hover:text-indigo-300' : 'text-gray-500 hover:text-gray-300'
                            }`}
                          >
                            <CheckCircle className="w-3 h-3" />
                            {showResolved ? 'Hide resolved' : 'Show resolved'}
                          </button>
                        )}
                        {showResolved && hasResolved && (
                          <button
                            onClick={() => {
                              for (const [key, entry] of obsCacheRef.current.entries()) {
                                if (entry.resolvedMs !== null) obsCacheRef.current.delete(key);
                              }
                              setObsEntries(prev => prev.filter(e => e.resolvedMs === null));
                              setShowResolved(false);
                            }}
                            className="flex items-center gap-1.5 text-[10px] text-gray-600 hover:text-gray-400 transition-colors"
                          >
                            Clear all
                          </button>
                        )}
                      </div>
                    </div>
                    {visibleObs.map(entry => (
                      <AccordionObservationCard
                        key={`${entry.insight.patternId}-${entry.insight.nodeId}`}
                        insight={{ ...entry.insight, firstFiredMs: entry.firstFiredMs }}
                        showNodeHeader={effectiveNodes.length > 1}
                        resolvedMs={entry.resolvedMs}
                        groupedNodes={entry.groupedNodes}
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
                );
              })()}

              {/* Model Fit — responsive mini tiles (1–4 cols depending on count) */}
              <div>
                {fitNodes.length > 0
                  ? (
                      <div className={`grid gap-3 ${
                        fitNodes.length === 1 ? 'grid-cols-1' :
                        fitNodes.length === 2 ? 'grid-cols-2' :
                        fitNodes.length === 3 ? 'grid-cols-3' :
                        'grid-cols-2 sm:grid-cols-4'
                      }`}>
                        {fitNodes.map(n => {
                          const fit = computeModelFitScore(n);
                          return fit ? (
                            <ModelFitMiniTile key={n.node_id} result={fit} node={n} showNodeHeader={fitNodes.length > 1} />
                          ) : null;
                        })}
                      </div>
                    )
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

              {/* Model Eviction + Idle Resource Cost */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {isLocalHost ? (
                  tier2EvictionActive && m ? (
                    <div id="insight-model-eviction">
                      <ModelEvictionCard node={m} lastActiveTsMs={lastActiveTsMs} canKeepWarm
                        onKeepWarm={() => emitFleetEvent({ id: `${Date.now()}-keepwarm`, ts: Date.now(), type: 'keep_warm_taken', nodeId: m.node_id, hostname: m.hostname ?? m.node_id, detail: m.ollama_active_model ?? 'active model' })} />
                    </div>
                  ) : (
                    <Section2NominalRow icon={<Cpu className="w-4 h-4" />} label="Model Eviction"
                      status={m?.ollama_active_model ? `${m.ollama_active_model} active — no eviction predicted` : 'No model loaded'}
                      lastFiredMs={lastEvictionFiredRef.current} lastFiredDetail={lastEvictionDetailRef.current} />
                  )
                ) : fleetEvictionNodes.length > 0 ? (
                  <div className="space-y-3">
                    {fleetEvictionNodes.map(n => (
                      <div key={n.node_id} id={`insight-model-eviction-${n.node_id}`}>
                        <ModelEvictionCard node={n} lastActiveTsMs={nodeLastActiveMsRef.current[n.node_id] ?? now} showNodeHeader={fleetEvictionNodes.length > 1} canKeepWarm
                          onKeepWarm={() => emitFleetEvent({ id: `${Date.now()}-keepwarm`, ts: Date.now(), type: 'keep_warm_taken', nodeId: n.node_id, hostname: n.hostname ?? n.node_id, detail: n.ollama_active_model ?? 'active model' })} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <Section2NominalRow icon={<Cpu className="w-4 h-4" />} label="Model Eviction"
                    status={effectiveNodes.some(n => n.ollama_active_model) ? 'Models active — no eviction predicted' : 'No models loaded'}
                    lastFiredMs={lastEvictionFiredRef.current} lastFiredDetail={lastEvictionDetailRef.current} />
                )}

                {canViewInsight(6) ? (
                  isLocalHost ? (
                    tier2IdleActive && m ? (
                      <div id="insight-idle-resource">
                        <IdleResourceCard node={m} lastActiveTsMs={lastActiveTsMs} kwhRate={localSettings.kwhRate} pue={localSettings.pue} />
                      </div>
                    ) : (
                      <Section2NominalRow icon={<Zap className="w-4 h-4" />} label="Idle Resource Cost" status="No idle overhead detected"
                        lastFiredMs={lastIdleFiredRef.current} lastFiredDetail={lastIdleDetailRef.current} />
                    )
                  ) : fleetIdleNodes.length > 0 ? (
                    <div className="space-y-3">
                      {fleetIdleNodes.map(n => {
                        const ns = getNodeSettings(n.node_id);
                        return (
                          <div key={n.node_id} id={`insight-idle-resource-${n.node_id}`}>
                            <IdleResourceCard node={n} lastActiveTsMs={nodeLastActiveMsRef.current[n.node_id] ?? now} kwhRate={ns.kwhRate} pue={ns.pue} showNodeHeader={fleetIdleNodes.length > 1} />
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <Section2NominalRow icon={<Zap className="w-4 h-4" />} label="Idle Resource Cost" status="No idle overhead detected"
                      lastFiredMs={lastIdleFiredRef.current} lastFiredDetail={lastIdleDetailRef.current} />
                  )
                ) : (
                  <Section2NominalRow icon={<Zap className="w-4 h-4" />} label="Idle Resource Cost"
                    status={(() => {
                      const w = effectiveNodes.reduce<number | null>((sum, n) => { const nw = getNodePowerW(n); return nw != null ? (sum ?? 0) + nw : sum; }, null);
                      return w != null ? `${w.toFixed(0)}W fleet draw · monitoring` : 'Monitoring idle overhead';
                    })()} />
                )}
              </div>

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
              {/* Row 1: WES Leaderboard (cloud) / Model Efficiency (local) + Benchmarks */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

                {/* Localhost: Model Efficiency summary (replaces WES Leaderboard) */}
                {isLocalHost ? (
                  <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                      <Activity className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                      <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">Model Efficiency</span>
                    </div>
                    {(() => {
                      const n = effectiveNodes[0];
                      if (!n) return <p className="text-xs text-gray-700">Waiting for telemetry…</p>;
                      const tps   = n.ollama_tokens_per_second ?? n.vllm_tokens_per_sec ?? null;
                      const watts = getNodePowerW(n);
                      const idleW = getNodeSettings(n.node_id).systemIdleW;
                      const adjW  = watts != null && idleW > 0 ? Math.max(watts - idleW, 0.1) : watts;
                      const wes   = tps != null && adjW != null && tps > 0 && adjW > 0
                        ? computeWES(tps, adjW, n.thermal_state) : null;
                      const w1k   = tps != null && adjW != null && tps > 0 ? (adjW / tps) * 1_000 : null;
                      const model = n.ollama_active_model ?? n.vllm_model_name ?? null;
                      return (
                        <div className="space-y-3">
                          {model && <p className="text-xs font-telin text-gray-300 truncate">{model}</p>}
                          <div className="grid grid-cols-3 gap-2">
                            <div>
                              <p className="text-[9px] text-gray-600 uppercase tracking-widest">tok/s</p>
                              <p className="text-sm font-bold font-telin text-cyan-400">{tps != null ? tps.toFixed(1) : '—'}</p>
                            </div>
                            <div>
                              <p className="text-[9px] text-gray-600 uppercase tracking-widest">WES</p>
                              <p className={`text-sm font-bold font-telin ${wes != null && wes > 10 ? 'text-emerald-400' : wes != null && wes >= 3 ? 'text-green-300' : wes != null && wes >= 1 ? 'text-yellow-400' : wes != null ? 'text-red-400' : 'text-gray-600'}`}>
                                {wes != null ? (wes >= 100 ? wes.toFixed(0) : wes.toFixed(1)) : '—'}
                              </p>
                            </div>
                            <div>
                              <p className="text-[9px] text-gray-600 uppercase tracking-widest">W/1K</p>
                              <p className="text-sm font-bold font-telin text-gray-300">{w1k != null ? w1k.toFixed(1) : '—'}</p>
                            </div>
                          </div>
                          {idleW > 0 && (
                            <p className="text-[9px] text-gray-600">
                              Idle offset applied: {idleW}W subtracted from {watts?.toFixed(1)}W accelerator power
                            </p>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                ) : canViewInsight(7) ? (
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

                {/* Fleet Benchmarks — live HexHive + benchmark trigger */}
                <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <Layers className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 flex-1">
                      {isLocalHost ? 'Node Benchmark' : 'Fleet Benchmarks'}
                    </span>
                  </div>
                  <HexHive rows={hiveRows} onNodeClick={(node) => setBenchmarkReport(buildReportFromLive(node))} />
                </div>

              </div>

              {/* Silicon Fit Audit — live model/silicon efficiency analysis */}
              {canViewInsight(10) && effectiveNodes.length > 0 ? (
                <SiliconFitAudit
                  node={effectiveNodes[0]}
                  nodes={effectiveNodes}
                  onNavigateToPerformance={() => setActiveTab('performance')}
                  systemIdleW={getNodeSettings(effectiveNodes[0].node_id).systemIdleW}
                />
              ) : canViewInsight(10) ? (
                <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex items-center gap-3">
                  <Cpu className="w-3.5 h-3.5 text-gray-600 shrink-0" />
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">Silicon Fit Audit</p>
                    <p className="text-xs text-gray-700 mt-0.5">No model loaded — load a model to see silicon fit analysis.</p>
                  </div>
                </div>
              ) : (
                <InsightsTeaseCard
                  title="Silicon Fit Audit"
                  icon={<Cpu className="w-3.5 h-3.5" />}
                  tierRequired="team"
                  upgradeCopy="View detailed benchmarks on Team →"
                  liveContent={
                    <p className="text-xs text-gray-600">
                      Live efficiency metrics available — load a model to see silicon fit analysis.
                    </p>
                  }
                />
              )}

              {/* Localhost: Performance History from DuckDB (1h window) */}
              {isLocalHost && <LocalPerformanceHistory nodeId={effectiveNodes[0]?.node_id ?? ''} />}

              {/* WES Trend Chart (cloud only) */}
              {!isLocalHost && getToken && (
                <WESHistoryChart
                  getToken={getToken}
                  historyDays={historyDays}
                  subscriptionTier={subscriptionTier}
                  selectedNodeId={perfNodeId}
                  onNodeSelect={setPerfNodeId}
                />
              )}

              {/* Performance History — Tok/s · Power · GPU% · Mem% (cloud only) */}
              {!isLocalHost && getToken && (
                <MetricsHistoryChart
                  getToken={getToken}
                  historyDays={historyDays}
                  subscriptionTier={subscriptionTier}
                  selectedNodeId={perfNodeId}
                  onNodeSelect={setPerfNodeId}
                />
              )}

              {/* Benchmark Report removed — accessible via Fleet Benchmarks hexagon click */}
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
                            fleetWes > 10 ? 'text-emerald-400' : fleetWes >= 3 ? 'text-green-300' : fleetWes >= 1 ? 'text-yellow-400' : 'text-red-400'
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
