import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Thermometer, Database, Zap, Activity, Cloud, CloudLightning, Download, Terminal, Plus, ChevronDown, BrainCircuit, Check, DollarSign, Server, Star, AlertTriangle, Info, ExternalLink, Cpu } from 'lucide-react';
import { computeWES, computeRawWES, thermalCostPct, thermalSourceLabel, formatWES, wesColorClass } from '../utils/wes';
import { computeModelFitScore } from '../utils/modelFit';
import { calculateFleetHealthPct, calculateTotalVramMb, calculateTotalVramCapacityMb, calculateCostPer1kTokens, calculateTokensPerWatt, WES_TOOLTIP } from '../utils/efficiency';
import { NODE_REACHABLE_MS, fmtAgo as fmtNodeAgo } from '../utils/time';
import { NodeAgent, PairingInfo, SentinelMetrics } from '../types';
import { useFleetStream } from '../contexts/FleetStreamContext';
import { useNodeRollingMetrics, useRollingBuffer, FLEET_ROLLING_WINDOW, NODE_ROLLING_WINDOW } from '../hooks/useRollingMetrics';
import { useFleetCounts } from '../hooks/useFleetCounts';
import { thermalColour, derivedNvidiaThermal } from './NodeHardwarePanel';
import EventFeed from './EventFeed';
import MetricTooltip from './MetricTooltip';
import HexHive from './shared/HexHive';
import type { HexHiveRow } from './shared/HexHive';

const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

/**
 * GPU utilisation thresholds for the three-state TOK/S display:
 *
 * IDLE-SPD  gpu% < GPU_IDLE_THRESHOLD  — macOS compositing only, probe ran clean
 * BUSY      gpu% ≥ GPU_BUSY_THRESHOLD  + inference_active=false — non-Ollama GPU load
 * (between thresholds: show probe value, lighter styling, no label)
 */
const GPU_IDLE_THRESHOLD = 15;
const GPU_BUSY_THRESHOLD = 50;

/**
 * Estimated total hardware tok/s, accounting for background inference.
 *
 * Uses ollama_inference_active (from /api/ps expires_at resets) as the primary
 * signal for whether background inference is competing with the probe:
 *
 *   inferenceActive=false → probe ran uncontested; rawTps IS the complete answer
 *   inferenceActive=true  → user job competing; add peak×gpuUtil% for background load
 *   inferenceActive=null  → no /api/ps data yet; fall back to gpu% >= 40% heuristic
 *
 * @param rawTps           Measured probe value (already smoothed); null = lockup
 * @param peak             Session high-water mark for this node+model (from peakTpsMap)
 * @param gpuUtil          0–100 GPU utilisation — nvidia_gpu_utilization_percent or gpu_utilization_percent
 * @param inferenceActive  From ollama_inference_active in SentinelMetrics
 */
function estimateTps(
  rawTps:          number | null,
  peak:            number | null,
  gpuUtil:         number | null,
  inferenceActive: boolean | null | undefined,
): number | null {
  if (peak == null) return rawTps;                             // no history yet — use raw as-is
  const frac = (gpuUtil ?? 0) / 100;
  // Prefer /api/ps signal; fall back to GPU% heuristic when not yet available
  const underLoad = inferenceActive != null ? inferenceActive : (gpuUtil ?? 0) >= 40;
  if (rawTps == null) return underLoad && frac > 0 ? peak * frac : null;
  return underLoad ? rawTps + (peak * frac) : rawTps;
}

// Build-time flag: true when compiled for the local agent binary (VITE_BUILD_TARGET=agent).
// Controls Cockpit vs Mission Control rendering mode. Never derived from runtime auth state.
const isLocalMode = (import.meta.env.VITE_BUILD_TARGET as string) === 'agent';

interface OverviewProps {
  nodes: NodeAgent[];
  /** True while the initial /api/fleet fetch is in-flight. Suppresses EmptyFleetState flash on refresh. */
  nodesLoading?: boolean;
  isPro?: boolean;
  pairingInfo?: PairingInfo | null;
  onOpenPairing?: () => void;
  onAddNode?: () => void;
  getNodeSettings?: (nodeId: string) => { pue: number; kwhRate: number; currency: string };
  fleetKwhRate?: number;
}

const MOCK_HISTORY = Array.from({ length: 20 }).map((_, i) => ({
  time: `${i}:00`,
  requests: Math.floor(Math.random() * 50) + 10,
  latency: Math.floor(Math.random() * 100) + 200,
}));

// Minimum tok/s required before a cost sample enters any rolling buffer.
// During Ollama startup the probe may read ~0.001 tok/s while GPU power is
// already at full draw — producing $/1M spikes in the thousands that take
// minutes to flush from the rolling window. 0.1 tok/s blocks ramp-up noise
// while still allowing genuinely slow/quantized models.
const MIN_COST_TPS = 0.1;

// ── Insight Engine tile — uniform across all 8 fleet-header cells ────────────
interface InsightTileProps {
  label: React.ReactNode;
  value: string;
  valueCls?: string;
  valueTitle?: string;
  sub?: string;
  /** Optional second sub-line — rendered more muted than sub, used for contextual conversions. */
  sub2?: string;
  icon: React.ElementType;
  iconCls?: string;
}
const InsightTile: React.FC<InsightTileProps> = ({ label, value, valueCls, valueTitle, sub, sub2, icon: Icon, iconCls }) => (
  <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 flex flex-col justify-between h-[116px]">
    <div className="flex items-start justify-between gap-2">
      <div className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500 leading-tight">{label}</div>
      <Icon size={13} className={iconCls ?? 'text-gray-400 dark:text-gray-600'} />
    </div>
    <div>
      <p
        className={`text-2xl font-bold font-telin leading-none ${valueCls ?? 'text-gray-900 dark:text-white'}`}
        title={valueTitle}
      >
        {value}
      </p>
      {sub && <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-1.5 leading-tight">{sub}</p>}
      {sub2 && <p className="text-[10px] text-gray-400 dark:text-gray-600 mt-0.5 leading-tight">{sub2}</p>}
    </div>
  </div>
);

const fmtAgo = (ms: number): string => {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

// ── Fleet Status grid ────────────────────────────────────────────────────────
// Full column set (md+): NODE · MEMORY · VRAM · MODEL · WES · TOK/S · TOK/W · WATTS · GPU% · THERMAL · SPACER
// Responsive priority — always visible: NODE, MODEL, WES, TOK/S
//   sm+  adds: THERMAL
//   md+  adds: MEMORY, VRAM, TOK/W, WATTS, GPU%
// SPACER (1fr) absorbs excess space on wide screens.
const FLEET_GRID_CLS = [
  'grid gap-x-3 items-center',
  // mobile: NODE · MODEL · WES · TOK/S · SPACER
  '[grid-template-columns:140px_200px_80px_80px_1fr]',
  // sm: + THERMAL
  'sm:[grid-template-columns:140px_200px_80px_80px_100px_1fr]',
  // md: full set
  'md:[grid-template-columns:140px_120px_80px_200px_80px_80px_80px_80px_80px_100px_1fr]',
].join(' ');

const FS_HDR = 'text-[9px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-600 leading-none whitespace-nowrap';

// ── Column header row ─────────────────────────────────────────────────────────
const FleetStatusHeader: React.FC = () => (
  <div className={`${FLEET_GRID_CLS} px-4 py-2 border-b border-gray-100 dark:border-gray-800/60`}>
    <p className={`${FS_HDR} sticky left-4 bg-white dark:bg-gray-900`}>NODE</p>
    <p className={`${FS_HDR} hidden md:block`}>MEMORY</p>
    <p className={`${FS_HDR} hidden md:block`}>VRAM</p>
    <p className={FS_HDR}>MODEL</p>
    <MetricTooltip
      metricId="wes"
      name="WES — Wicklee Efficiency Score"
      oneLiner="Thermally-honest inference efficiency. tok/watt penalised by heat."
      ranges={[
        { threshold: '> 10', color: 'green',  label: 'Excellent · efficient inference hardware' },
        { threshold: '1–10', color: 'amber',  label: 'Good · typical GPU at load' },
        { threshold: '< 1',  color: 'red',    label: 'Fair / Poor · throttling or CPU inference' },
      ]}
    >
      <p className={FS_HDR}>WES</p>
    </MetricTooltip>
    <MetricTooltip
      metricId="tok-s"
      name="TOK/S — Tokens Per Second"
      oneLiner="Raw inference throughput sampled every 30 s."
      ranges={[
        { threshold: '> 50',  color: 'green', label: 'Fast · responsive for interactive use' },
        { threshold: '10–50', color: 'amber', label: 'Moderate · usable, not snappy' },
        { threshold: '< 10',  color: 'red',   label: 'Slow · model may be too large' },
      ]}
    >
      <p className={FS_HDR}>TOK/S</p>
    </MetricTooltip>
    <MetricTooltip
      metricId="tok-w"
      name="TOK/W — Tokens Per Watt"
      oneLiner="Energy efficiency without thermal penalty. Higher = better."
      wrapperClassName="hidden md:block"
    >
      <p className={FS_HDR}>TOK/W</p>
    </MetricTooltip>
    <MetricTooltip
      metricId="watts"
      name="WATTS — Board Power"
      oneLiner="Total power draw of inference hardware in watts."
      ranges={[
        { threshold: '< 15W',   color: 'green', label: 'Low draw · Apple Silicon or idle' },
        { threshold: '15–150W', color: 'amber', label: 'Moderate · GPU under load' },
        { threshold: '> 150W',  color: 'red',   label: 'High draw · monitor for cost' },
      ]}
      wrapperClassName="hidden md:block"
    >
      <p className={FS_HDR}>WATTS</p>
    </MetricTooltip>
    <MetricTooltip
      metricId="gpu-pct"
      name="GPU% — GPU Utilization"
      oneLiner="Percentage of GPU compute capacity currently in use."
      ranges={[
        { threshold: '60–95%', color: 'green', label: 'Healthy inference load' },
        { threshold: '95–100%', color: 'amber', label: 'Saturated · may queue requests' },
        { threshold: '< 30%',  color: 'amber', label: 'Underutilized · check runtime config' },
      ]}
      wrapperClassName="hidden md:block"
    >
      <p className={FS_HDR}>GPU%</p>
    </MetricTooltip>
    <MetricTooltip
      metricId="thermal"
      name="THERMAL STATE"
      oneLiner="OS thermal condition. Drives the WES penalty multiplier."
      ranges={[
        { threshold: 'Normal',  color: 'green', label: '1.0× penalty — within design limits' },
        { threshold: 'Fair',    color: 'amber', label: '1.25× penalty — mild throttling' },
        { threshold: 'Serious', color: 'red',   label: '2.0× penalty — active throttling' },
      ]}
      wrapperClassName="hidden sm:block"
    >
      <p className={FS_HDR}>THERMAL</p>
    </MetricTooltip>
    <div />
  </div>
);

// ── Single-row node entry — all detail visible at a glance ────────────────────
interface NodeRowProps {
  nodeId: string;
  hostname: string;
  metrics: SentinelMetrics | null;
  lastSeenMs?: number;
  pue?: number;
  /** Session peak tok/s for this node — from peakTpsMap in FleetStreamContext. */
  peakTps?: number;
}

const FleetStatusRow: React.FC<NodeRowProps> = ({ nodeId, hostname, metrics: m, lastSeenMs, pue = 1.0, peakTps }) => {
  const isOnline = m !== null;

  // Rolling-average smoothing (5-sample window, display-layer only).
  // Buffers are reset synchronously when the node transitions offline.
  const { pushOne, resetAll } = useNodeRollingMetrics();
  const wasOnlineRef = useRef(true);
  if (!isOnline && wasOnlineRef.current) resetAll();
  wasOnlineRef.current = isOnline;
  const tsMs = m?.timestamp_ms ?? 0;

  // 3-state reachability dot
  const dotState: 'online' | 'offline' | 'pending' =
    lastSeenMs != null
      ? (Date.now() - lastSeenMs <= NODE_REACHABLE_MS ? 'online' : 'offline')
      : m != null ? 'online'   // localhost: sentinel present, no lastSeenMs
      : 'pending';
  const dotTooltip =
    dotState === 'online'  ? 'Online · last seen just now' :
    dotState === 'offline' ? `Unreachable · last seen ${fmtNodeAgo(lastSeenMs!)}` :
    'Pending · waiting for first report';

  // Combine Ollama and vLLM tok/s — both runtimes can run simultaneously.
  const rawOllamaTps = m?.ollama_tokens_per_second ?? null;
  const rawVllmTps   = m?.vllm_tokens_per_sec ?? null;
  const rawTps       = rawOllamaTps != null && rawVllmTps != null ? rawOllamaTps + rawVllmTps
                     : (rawOllamaTps ?? rawVllmTps);
  // GPU utilisation used for throughput estimation (covers both NVIDIA and Apple Silicon)
  const gpuPctForEst = m?.nvidia_gpu_utilization_percent ?? m?.gpu_utilization_percent ?? null;
  // Smoothed probe reading, then apply throughput estimation. When the probe
  // is depressed (background inference) or null (lockup), estimateTps fills
  // the gap using the session peak × GPU utilisation.
  const smoothedTps  = pushOne('tps', rawTps, tsMs);
  const inferenceActive = m?.ollama_inference_active ?? null;
  const tps          = estimateTps(smoothedTps, peakTps ?? null, gpuPctForEst, inferenceActive);
  const isActive     = isOnline && tps != null && tps > 0;

  // Three-state TOK/S display derived from inference_active + GPU%
  // LIVE:     inference was detected recently (Ollama) OR vLLM is actively serving
  // BUSY:     GPU ≥ threshold but Ollama not inferring (something else loading GPU)
  // IDLE-SPD: GPU < threshold, probe ran clean — shows hardware capability baseline
  const isInferring = isOnline && (
    inferenceActive === true ||
    (m?.vllm_running === true && (m?.vllm_tokens_per_sec ?? 0) > 0)
  );
  const isBusy      = isOnline && inferenceActive === false && (gpuPctForEst ?? 0) >= GPU_BUSY_THRESHOLD;
  const isIdleSpeed = isOnline && !isInferring && !isBusy && smoothedTps != null;

  // Thermal — not smoothed (state machine, not a continuous signal)
  const nvThermal  = m && m.thermal_state == null ? derivedNvidiaThermal(m.nvidia_gpu_temp_c ?? null) : null;
  const thermalStr = m?.thermal_state ?? nvThermal?.label ?? null;
  const thermalCls = m?.thermal_state != null ? thermalColour(m.thermal_state) : (nvThermal?.colour ?? 'text-gray-400');
  const thermalWarn = thermalStr != null && !['normal', 'nominal'].includes(thermalStr.toLowerCase());

  // Power — hasPower is an availability flag (raw); totalPowerW is smoothed for display
  const hasPower    = m ? (m.cpu_power_w != null || m.nvidia_power_draw_w != null) : false;
  const rawTotalW   = m ? (m.cpu_power_w ?? 0) + (m.nvidia_power_draw_w ?? 0) : null;
  const totalPowerW = pushOne('watts', hasPower ? rawTotalW : null, tsMs) ?? 0;

  // WES — only when actively inferencing
  const wes    = isActive ? computeWES(tps, hasPower ? totalPowerW : null, m?.thermal_state ?? null, pue) : null;
  const rawWes = isActive ? computeRawWES(tps, hasPower ? totalPowerW : null, pue) : null;
  const tcPct  = thermalCostPct(rawWes, wes);

  // Memory / VRAM
  const hasNvidia = m?.nvidia_vram_total_mb != null && m.nvidia_vram_total_mb > 0;
  const memLabel  = hasNvidia ? 'VRAM' : 'Memory';
  // memory_pressure_percent is Apple Silicon only; fall back to used/total for Linux nodes.
  const memPctRaw = hasNvidia
    ? ((m!.nvidia_vram_used_mb ?? 0) / m!.nvidia_vram_total_mb!) * 100
    : m?.memory_pressure_percent ??
      (m != null && m.total_memory_mb > 0 ? (m.used_memory_mb / m.total_memory_mb) * 100 : null);
  const memPct = memPctRaw != null ? Math.round(memPctRaw * 10) / 10 : null;
  const memColorCls = memPct == null ? 'text-gray-500 dark:text-gray-600'
    : memPct >= 90 ? 'text-red-400'
    : memPct >= 70 ? 'text-amber-400'
    : 'text-green-400';
  const memBarCls = memPct == null ? 'bg-gray-500'
    : memPct >= 90 ? 'bg-red-400'
    : memPct >= 70 ? 'bg-amber-400'
    : 'bg-green-400';

  // Runtime detection — both can run simultaneously; prefer first available for model label
  const hasOllama = isOnline && m?.ollama_running === true;
  const hasVllm   = isOnline && m?.vllm_running   === true;
  const modelStr  = !isOnline ? '—'
    : hasOllama ? (m!.ollama_active_model ?? 'Ollama')
    : hasVllm   ? (m!.vllm_model_name    ?? 'vLLM')
    : 'No runtime';

  // Model Fit Score — computed at render time from live SSE payload, no new data required.
  // Only computed when Ollama is running and metrics are present.
  const fitResult = (hasOllama && m) ? computeModelFitScore(m) : null;

  // VRAM % — NVIDIA only; Apple Silicon unified memory is architecturally distinct
  // memory_pressure_percent is strictly Apple Silicon (IOKit/powermetrics) — reliable platform detector
  const isAppleSilicon = m?.memory_pressure_percent != null;
  const vramPctRaw = hasNvidia
    ? ((m!.nvidia_vram_used_mb ?? 0) / m!.nvidia_vram_total_mb!) * 100
    : null;
  const vramPct = vramPctRaw != null ? Math.round(vramPctRaw * 10) / 10 : null;

  // Apple Silicon GPU budget — iogpu.wired_limit_mb (exact, from agent sysctl)
  // falls back to 75% of total RAM for older agents that don't emit the field.
  // available_memory_mb (free + inactive pages) is how much the OS can still wire
  // for a model load; capped at wired_limit_mb to avoid overstating headroom.
  const wiredLimitMb = m?.gpu_wired_limit_mb
    ?? (isAppleSilicon && m != null ? Math.round(m.total_memory_mb * 0.75) : null);
  const gpuAvailMb  = (wiredLimitMb != null && m != null)
    ? Math.max(0, Math.min(wiredLimitMb, m.available_memory_mb))
    : null;
  const gpuUsedPct  = (wiredLimitMb != null && gpuAvailMb != null)
    ? Math.round(((wiredLimitMb - gpuAvailMb) / wiredLimitMb) * 100)
    : null;
  const gpuAvailGb  = gpuAvailMb  != null ? (gpuAvailMb  / 1024).toFixed(1) : null;
  const gpuLimitGb  = wiredLimitMb != null ? Math.round(wiredLimitMb / 1024) : null;
  const gpuLimitSrc = m?.gpu_wired_limit_mb != null ? 'iogpu.wired_limit_mb' : 'est.';

  const unifiedColorCls = gpuUsedPct == null ? 'text-gray-400'
    : gpuUsedPct >= 85 ? 'text-red-400'
    : gpuUsedPct >= 65 ? 'text-amber-400'
    : 'text-green-400';
  const unifiedBarCls = gpuUsedPct == null ? 'bg-gray-600'
    : gpuUsedPct >= 85 ? 'bg-red-400'
    : gpuUsedPct >= 65 ? 'bg-amber-400'
    : 'bg-green-400';

  // Tooltip explains why — differs by platform/install method
  const vramTooltip = hasNvidia
    ? `NVIDIA dedicated VRAM utilisation — ${vramPct}%`
    : isAppleSilicon
    ? `GPU budget (${gpuLimitSrc}): ${gpuLimitGb} GB  ·  Available for models: ${gpuAvailGb} GB. Apple Silicon wires unified memory for the GPU — loading a model larger than this will trigger swap.`
    : 'No NVIDIA GPU on this node. If an NVIDIA GPU is present, re-run the installer — it auto-detects and downloads the GPU-enabled build.';
  const vramColorCls = vramPct == null ? 'text-gray-500 dark:text-gray-600'
    : vramPct >= 90 ? 'text-red-400'
    : vramPct >= 70 ? 'text-amber-400'
    : 'text-green-400';
  const vramBarCls = vramPct == null ? 'bg-gray-500'
    : vramPct >= 90 ? 'bg-red-400'
    : vramPct >= 70 ? 'bg-amber-400'
    : 'bg-green-400';

  // TOK/W — tokens per watt: tps ÷ totalPowerW. Both inputs are already smoothed.
  const nodeTokPerWatt = (isActive && hasPower && totalPowerW > 0)
    ? tps! / totalPowerW
    : null;
  // GPU% — Apple Silicon via IOKit/AGX, NVIDIA via NVML
  const gpuPct = isOnline
    ? (m!.nvidia_gpu_utilization_percent ?? m!.gpu_utilization_percent ?? null)
    : null;
  const gpuPctDisplay = gpuPct != null ? Math.round(gpuPct) : null;

  const V = `text-xs font-telin ${!isOnline ? 'text-gray-400 dark:text-gray-600' : ''}`;

  // Condensed tooltip on NODE cell — surfaces columns hidden at narrow viewports
  const nodeTooltip = [
    modelStr !== '—' && modelStr !== 'No runtime' ? modelStr : null,
    hasPower && isOnline ? `${totalPowerW.toFixed(1)}W` : null,
    memPct != null ? `${memPct}% ${memLabel}` : null,
  ].filter(Boolean).join('  ·  ');

  return (
    <div
      className={`group ${FLEET_GRID_CLS} px-4 py-3 min-h-[44px] hover:bg-gray-50/50 dark:hover:bg-gray-800/30 transition-colors${dotState === 'offline' ? ' opacity-50' : ''}`}
    >
      {/* 1. NODE — status dot + ID + hostname (sticky) */}
      <div className="flex items-center gap-2 overflow-hidden sticky left-4 bg-white dark:bg-gray-900 group-hover:bg-gray-50/50 dark:group-hover:bg-gray-800/30" title={nodeTooltip || undefined}>
        <span className="relative flex h-2 w-2 shrink-0" title={dotTooltip}>
          {dotState === 'online' ? (
            <>
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
            </>
          ) : dotState === 'offline' ? (
            <span className="relative inline-flex rounded-full h-2 w-2 border border-gray-500 dark:border-gray-600" />
          ) : (
            <span className="relative inline-flex rounded-full h-2 w-2 bg-gray-500" />
          )}
        </span>
        <div className="min-w-0">
          <p className="text-xs font-telin font-bold text-gray-900 dark:text-white truncate leading-none">{nodeId}</p>
          {hostname !== nodeId && (
            <p className="text-[10px] text-gray-500 truncate leading-none mt-0.5">{hostname}</p>
          )}
          {dotState === 'offline' && (
            <p className="text-[9px] text-gray-400 dark:text-gray-600 leading-none mt-0.5">unreachable</p>
          )}
        </div>
      </div>

      {/* 2. MEMORY / VRAM
          Memory column = live utilization only (memory_used, memory_pressure_%).
          Memory Pressure Forecasting (rate-of-change → ETA to critical) is a Phase 4A Insights tab feature.
          Do not add predictive/forecast logic to this column. */}
      <div
        className="hidden md:block min-w-0 overflow-hidden"
        title={hasNvidia
          ? 'GPU memory in use as % of total. Exhaustion causes inference to spill to system RAM.'
          : 'Kernel memory pressure — the OS\'s assessment of memory stress, not just raw usage.'}
      >
        {memPct != null ? (
          <div className="flex items-center gap-1.5">
            <span className={`text-xs font-telin tabular-nums ${memColorCls}`}>{memPct}%</span>
            <div className="w-10 h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden shrink-0">
              <div className={`h-full ${memBarCls} rounded-full`} style={{ width: `${Math.min(memPct, 100)}%` }} />
            </div>
          </div>
        ) : (
          <span className="text-xs font-telin text-gray-500 dark:text-gray-600">—</span>
        )}
      </div>

      {/* 2b. VRAM — NVIDIA: percentage bar; Apple Silicon: "Unified" badge; CPU-only: — */}
      <div
        className="hidden md:block min-w-0 overflow-hidden"
        title={vramTooltip}
      >
        {vramPct != null ? (
          // NVIDIA: dedicated VRAM percentage + mini bar
          <div className="flex items-center gap-1.5">
            <span className={`text-xs font-telin tabular-nums ${vramColorCls}`}>{vramPct}%</span>
            <div className="w-10 h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden shrink-0">
              <div className={`h-full ${vramBarCls} rounded-full`} style={{ width: `${Math.min(vramPct, 100)}%` }} />
            </div>
          </div>
        ) : isAppleSilicon && gpuAvailGb != null && gpuLimitGb != null ? (
          // Apple Silicon: available / wired-limit GB with headroom bar
          <div className="flex items-center gap-1.5">
            <span className={`text-xs font-telin tabular-nums ${unifiedColorCls}`}>
              {gpuAvailGb}<span className="text-gray-500 text-[10px]">/{gpuLimitGb}</span>
            </span>
            <div className="w-10 h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden shrink-0">
              <div className={`h-full ${unifiedBarCls} rounded-full`} style={{ width: `${Math.min(gpuUsedPct ?? 0, 100)}%` }} />
            </div>
          </div>
        ) : (
          // CPU-only or no data
          <span className="text-xs font-telin text-gray-500 dark:text-gray-600">—</span>
        )}
      </div>

      {/* 3. MODEL — model name + fit score dot + vLLM cache usage when available */}
      <div className="min-w-0 overflow-hidden flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <p className={`${V} truncate ${!isOnline || (!hasOllama && !hasVllm) ? 'text-gray-500' : 'text-gray-700 dark:text-gray-300'}`}>
            {modelStr}
          </p>
          {/* Fit score dot — colored indicator with full reason in tooltip */}
          {fitResult && (
            <span
              className={`shrink-0 inline-block w-1.5 h-1.5 rounded-full ${
                fitResult.score === 'good' ? 'bg-green-400' :
                fitResult.score === 'fair' ? 'bg-amber-400' :
                'bg-red-400'
              }`}
              title={fitResult.reason}
            />
          )}
        </div>
        {hasVllm && m?.vllm_cache_usage_perc != null && (
          <p className="text-[9px] text-cyan-400 font-telin truncate leading-none">
            Cache: {m.vllm_cache_usage_perc.toFixed(0)}%
          </p>
        )}
      </div>

      {/* 4. WES */}
      <div className="flex flex-col gap-0.5 overflow-hidden">
        <div className="flex items-center gap-1">
          {thermalWarn && isOnline && (
            <AlertTriangle size={9} className="text-amber-400 shrink-0" title="Thermal throttling active" />
          )}
          <span
            className={`${V} font-semibold ${wes != null ? wesColorClass(wes) : 'text-gray-500 dark:text-gray-600'}`}
            title={wes != null
              ? wesBreakdownTitle(tps, hasPower ? totalPowerW : null, m?.thermal_state ?? null, m?.chip_name ?? m?.gpu_name ?? null, rawWes, wes, m?.thermal_source ?? null)
              : WES_TOOLTIP}
          >
            {wes != null ? formatWES(wes) : '—'}
          </span>
        </div>
        {tcPct > 0 && isOnline && (
          <span className="text-[9px] font-telin text-amber-400/80 leading-none" title={`${tcPct}% of potential efficiency lost to thermal throttling`}>
            -{tcPct}% thermal
          </span>
        )}
      </div>

      {/* 5. TOK/S */}
      {/* 5. TOK/S — three-state: LIVE (green ~), IDLE-SPD (gray baseline), BUSY (amber last-probe) */}
      <div className="min-w-0 overflow-hidden">
        {isInferring ? (
          <>
            <span className={`${V} text-green-400`}
              title="Live estimate — inference in progress. ~ indicates estimated throughput.">
              ~{tps!.toFixed(1)}
            </span>
            <p className="text-[9px] uppercase tracking-widest text-green-500 mt-0.5 font-semibold leading-none">live</p>
          </>
        ) : isBusy ? (
          <>
            <span className={`${V} text-amber-500`}
              title="GPU loaded by non-Ollama workload — showing last known baseline.">
              {tps != null ? tps.toFixed(1) : '—'}
            </span>
            <p className="text-[9px] uppercase tracking-widest text-amber-500 mt-0.5 font-semibold leading-none">busy</p>
          </>
        ) : isIdleSpeed ? (
          <>
            <span className={`${V} text-gray-400 dark:text-gray-500`}
              title="Idle-speed baseline — hardware unloaded. Probe result from last 30s window.">
              {tps!.toFixed(1)}
            </span>
            <p className="text-[9px] uppercase tracking-widest text-gray-500 dark:text-gray-600 mt-0.5 leading-none">idle-spd</p>
          </>
        ) : (
          <span className={`${V} text-gray-500 dark:text-gray-600`}>—</span>
        )}
      </div>

      {/* 6. TOK/W — tokens per watt: tps ÷ watts. Higher is better. Null when watts or tok/s unavailable. */}
      <div className="hidden md:block min-w-0 overflow-hidden" title="Tokens per watt — inference efficiency per unit of power. Higher is better.">
        {nodeTokPerWatt != null ? (
          <span className={`${V} text-gray-700 dark:text-gray-300`}>
            {nodeTokPerWatt.toFixed(1)}
          </span>
        ) : (
          <span className="text-xs font-telin text-gray-500 dark:text-gray-600">—</span>
        )}
      </div>

      {/* 7. WATTS */}
      <div className="hidden md:block min-w-0 overflow-hidden">
        <span
          className={`${V} ${hasPower && isOnline ? 'text-gray-700 dark:text-gray-300' : 'text-gray-500 dark:text-gray-600'}`}
          title="Current power draw of this node."
        >
          {hasPower && isOnline ? `${totalPowerW.toFixed(1)}W` : '—'}
        </span>
      </div>

      {/* 8. GPU% — Apple Silicon (IOKit/AGX) or NVIDIA (NVML); no progress bar */}
      <div className="hidden md:block min-w-0 overflow-hidden" title="GPU core utilisation. Source: NVML (NVIDIA) or IOKit AGX (Apple Silicon).">
        {gpuPctDisplay != null ? (
          <span className={`${V} text-gray-700 dark:text-gray-300`}>
            {gpuPctDisplay}<span className="text-gray-400 dark:text-gray-600">%</span>
          </span>
        ) : (
          <span className="text-xs font-telin text-gray-500 dark:text-gray-600">—</span>
        )}
      </div>

      {/* 9. THERMAL — pill badge */}
      <div className="hidden sm:block min-w-0 overflow-hidden">
        {isOnline && thermalStr ? (
          <span
            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 dark:bg-gray-800 ${thermalCls} whitespace-nowrap`}
            title="Hardware thermal state. Serious or Critical means active clock throttling is underway."
          >
            {thermalStr}
          </span>
        ) : (
          <span className="text-xs font-telin text-gray-500 dark:text-gray-600">—</span>
        )}
      </div>

      {/* SPACER */}
      <div />
    </div>
  );
};

// ── WES breakdown tooltip (browser title attr) ───────────────────────────────
function wesBreakdownTitle(
  tps: number | null,
  watts: number | null,
  thermal: string | null,
  chipName: string | null | undefined,
  rawWes?: number | null,
  penalizedWes?: number | null,
  thermalSource?: string | null,
): string {
  const isHot  = thermal != null && !['normal', 'nominal'].includes(thermal.toLowerCase());
  const lowTps = tps == null || tps < 5;
  const hiWatt = watts != null && watts > 100;
  let diagnosis: string;
  if (isHot && lowTps && hiWatt)   diagnosis = 'Thermal throttling compounding power cost';
  else if (isHot && lowTps)        diagnosis = 'Thermal throttling — action recommended';
  else if (lowTps)                 diagnosis = 'Runtime or configuration issue';
  else if (hiWatt)                 diagnosis = chipName ? `Expected for ${chipName} inference` : 'Expected for this hardware at inference load';
  else                             diagnosis = 'Check runtime and thermal state';

  const tc = thermalCostPct(rawWes ?? null, penalizedWes ?? null);
  const tcStr = tc > 0 ? `  ·  Thermal cost: ${tc}%` : '';
  const lines = [
    `tok/s: ${tps != null ? tps.toFixed(1) : '—'}  ·  Watts: ${watts != null ? `${watts.toFixed(1)}W` : '—'}  ·  Thermal: ${thermal ?? '—'}${tcStr}`,
  ];
  if (thermalSource != null) {
    lines.push(`Thermal source: ${thermalSourceLabel(thermalSource)}`);
  }
  lines.push(diagnosis);
  return lines.join('\n');
}

// HexHive imported from src/components/shared/HexHive.tsx

// ── Fleet Intelligence card wrapper ───────────────────────────────────────────
const FleetCard: React.FC<{
  label: React.ReactNode;
  children: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
}> = ({ label, children, sub, className = '' }) => (
  <div className={`bg-gray-800/50 border border-gray-700/40 rounded-xl p-4 flex flex-col gap-2 ${className}`}>
    <div className="text-[9px] font-semibold uppercase tracking-widest text-gray-500 leading-none">{label}</div>
    <div className="flex-1">{children}</div>
    {sub && <div className="mt-auto">{sub}</div>}
  </div>
);

// ── Empty state for hosted with no paired nodes ───────────────────────────────
const EmptyFleetState: React.FC<{ onAddNode?: () => void }> = ({ onAddNode }) => (
  <div className="flex flex-col items-center justify-center py-24 text-center space-y-10 animate-in fade-in duration-500">
    <div className="p-5 bg-indigo-600/10 border border-indigo-500/20 rounded-3xl">
      <CloudLightning className="w-12 h-12 text-indigo-400" />
    </div>
    <div className="space-y-3 max-w-sm">
      <h2 className="text-2xl font-bold text-white">Add your first node</h2>
      <p className="text-sm text-gray-500">Install the Wicklee agent on any machine, generate a pairing code, then enter it below.</p>
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full max-w-2xl text-left">
      {[
        {
          step: '1', icon: Download, title: 'Install the agent',
          body: (
            <code className="block mt-2 text-[11px] font-mono bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-indigo-300 whitespace-pre-wrap break-all">
              curl -fsSL https://wicklee.dev/install.sh | bash
            </code>
          ),
        },
        {
          step: '2', icon: Terminal, title: 'Open the dashboard',
          body: <p className="mt-2 text-xs text-gray-500">Click "Pair a Node" in the header to get your 6-digit pairing code.</p>,
        },
        {
          step: '3', icon: Plus, title: 'Enter the code here',
          body: <p className="mt-2 text-xs text-gray-500">Click "Add Node" below and enter the 6-digit code from your local dashboard.</p>,
        },
      ].map(({ step, icon: Icon, title, body }) => (
        <div key={step} className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-1">
          <div className="flex items-center gap-2 mb-2">
            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-600/20 border border-indigo-500/30 text-[11px] font-bold text-indigo-400">{step}</span>
            <Icon className="w-4 h-4 text-gray-500" />
          </div>
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          {body}
        </div>
      ))}
    </div>
    <button
      onClick={onAddNode}
      className="flex items-center gap-2 px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl transition-all shadow-lg shadow-indigo-500/20"
    >
      <Plus className="w-4 h-4" />
      Add Node
    </button>
  </div>
);

// ── High-Frequency Diagnostic Rail — agent build only, replaces Fleet Status ──
// Renders 4 live rows (CPU · GPU · Mem Pressure · Board Power) fed by the 10Hz
// WebSocket stream. Replaces the fleet table when isLocalMode is true.
interface RailRowProps {
  label:     string;
  value:     string;
  pct?:      number | null;
  textCls:   string;
  barCls:    string;
  badge?:    string;
  badgeCls?: string;
}
const RailRow: React.FC<RailRowProps> = ({ label, value, pct, textCls, barCls, badge, badgeCls }) => (
  <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-100 dark:border-gray-800 last:border-0">
    <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 w-28 shrink-0">{label}</p>
    <div className="flex items-center gap-1.5 w-20 shrink-0">
      <p className={`text-sm font-telin font-bold ${textCls}`}>{value}</p>
      {badge && (
        <span className={`text-[8px] font-semibold uppercase tracking-widest leading-none ${badgeCls}`}>
          {badge}
        </span>
      )}
    </div>
    {pct != null && (
      <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-800 rounded-full overflow-hidden">
        <div
          className={`h-full ${barCls} rounded-full transition-all duration-100`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    )}
  </div>
);

const DiagnosticRail: React.FC<{
  sentinel: SentinelMetrics | null;
  transport: 'ws' | 'sse' | null;
  peakTps?: number;
}> = ({ sentinel: s, transport, peakTps }) => {
  // Rolling-average buffers — must be declared before any early returns (Rules of Hooks)
  const cpuBuf   = useRollingBuffer();
  const gpuBuf   = useRollingBuffer();
  const memBuf   = useRollingBuffer();
  const powerBuf = useRollingBuffer();
  const tpsBuf   = useRollingBuffer();

  if (!s) {
    return (
      <div className="py-10 text-center text-sm text-gray-500">
        {transport === null ? 'Connecting to local agent…' : 'Awaiting first telemetry frame…'}
      </div>
    );
  }

  const tsMs = s.timestamp_ms;

  const cpuRaw  = s.cpu_usage_percent;
  const cpuPct  = cpuBuf.push(cpuRaw, tsMs) ?? cpuRaw;

  const gpuRaw  = s.nvidia_gpu_utilization_percent ?? s.gpu_utilization_percent ?? null;
  const gpuPct  = gpuBuf.push(gpuRaw, tsMs) ?? gpuRaw;

  const memRaw  = s.memory_pressure_percent
    ?? (s.total_memory_mb > 0 ? (s.used_memory_mb / s.total_memory_mb) * 100 : null);
  const memPct  = memBuf.push(memRaw, tsMs) ?? memRaw;

  const powerRaw = (s.cpu_power_w ?? 0) + (s.nvidia_power_draw_w ?? 0);
  const powerW   = powerBuf.push(powerRaw, tsMs) ?? powerRaw;
  const hasPow   = s.cpu_power_w != null || s.nvidia_power_draw_w != null;

  // TOK/S — same three-state logic as FleetStatusRow
  const rawOllamaTps    = s.ollama_tokens_per_second ?? null;
  const rawVllmTps      = s.vllm_tokens_per_sec ?? null;
  const rawTps          = rawOllamaTps != null && rawVllmTps != null ? rawOllamaTps + rawVllmTps
                        : (rawOllamaTps ?? rawVllmTps);
  const inferenceActive = s.ollama_inference_active ?? null;
  const smoothedTps     = tpsBuf.push(rawTps, tsMs) ?? rawTps;
  const tps             = estimateTps(smoothedTps, peakTps ?? null, gpuPct, inferenceActive);

  const isInferring  = tps != null && (
    inferenceActive === true ||
    (s.vllm_running === true && (s.vllm_tokens_per_sec ?? 0) > 0)
  );
  const isBusy       = !isInferring && inferenceActive === false && (gpuPct ?? 0) >= GPU_BUSY_THRESHOLD;
  const isIdleSpeed  = !isInferring && !isBusy && smoothedTps != null;
  const hasTps       = s.ollama_running || s.vllm_running;

  const utilCls = (pct: number) =>
    pct > 90 ? { text: 'text-red-400', bar: 'bg-red-400' } :
    pct > 70 ? { text: 'text-amber-400', bar: 'bg-amber-400' } :
               { text: 'text-green-400', bar: 'bg-green-400' };

  const cpu = utilCls(cpuPct);

  return (
    <div>
      <RailRow label="CPU Usage" value={`${cpuPct.toFixed(1)}%`} pct={cpuPct} textCls={cpu.text} barCls={cpu.bar} />
      {gpuPct != null && (() => {
        const g = utilCls(gpuPct);
        return <RailRow label="GPU Utilization" value={`${gpuPct.toFixed(1)}%`} pct={gpuPct} textCls={g.text} barCls={g.bar} />;
      })()}
      {memPct != null && (() => {
        const m = utilCls(memPct);
        return <RailRow label="Memory Pressure" value={`${memPct.toFixed(1)}%`} pct={memPct} textCls={m.text} barCls={m.bar} />;
      })()}
      {hasPow && (
        <RailRow label="Board Power" value={`${powerW.toFixed(1)} W`} textCls="text-amber-400" barCls="bg-amber-400" />
      )}
      {/* TOK/S — three-state: LIVE (green ~), IDLE-SPD (muted baseline), BUSY (amber last-probe) */}
      {hasTps && (
        isInferring ? (
          <RailRow
            label="Tok/s"
            value={`~${tps!.toFixed(1)}`}
            textCls="text-green-400"
            barCls="bg-green-400"
            badge="live"
            badgeCls="text-green-500"
          />
        ) : isBusy ? (
          <RailRow
            label="Tok/s"
            value={tps != null ? tps.toFixed(1) : '—'}
            textCls="text-amber-500"
            barCls="bg-amber-500"
            badge="busy"
            badgeCls="text-amber-500"
          />
        ) : isIdleSpeed ? (
          <RailRow
            label="Tok/s"
            value={tps!.toFixed(1)}
            textCls="text-gray-400 dark:text-gray-500"
            barCls="bg-gray-500"
            badge="idle-spd"
            badgeCls="text-gray-600"
          />
        ) : (
          <RailRow label="Tok/s" value="—" textCls="text-gray-600" barCls="bg-gray-800" />
        )
      )}
    </div>
  );
};

// ── Main component ─────────────────────────────────────────────────────────────
const Overview: React.FC<OverviewProps> = ({ nodes, nodesLoading = false, isPro, pairingInfo, onOpenPairing, onAddNode, getNodeSettings, fleetKwhRate = 0.12 }) => {
  const {
    allNodeMetrics: cloudMetrics,
    lastSeenMsMap: cloudLastSeen,
    peakTpsMap,
    fleetEvents,
    connected: cloudConnected,
    transport: cloudTransport,
    connectionState,
  } = useFleetStream();

  // Local-only state (used when isLocalHost for WS/SSE to the local agent)
  const [sentinel, setSentinel] = useState<SentinelMetrics | null>(null);
  const [localConnected, setLocalConnected] = useState(false);
  const [localTransport, setLocalTransport] = useState<'ws' | 'sse' | null>(null);

  type MetricKey = 'gpu' | 'cpu' | 'mem' | 'power';
  interface HistoryPoint { time: string; gpu: number | null; cpu: number; mem: number | null; power: number | null; }
  const [history, setHistory]           = useState<HistoryPoint[]>([]);
  const [selectedMetric, setSelectedMetric] = useState<MetricKey>('gpu');
  const MAX_HISTORY = 60;

  const [metricOpen, setMetricOpen] = useState(false);
  const metricDropdownRef = useRef<HTMLDivElement>(null);
  const [showActiveOnly, setShowActiveOnly] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const esRef = useRef<EventSource | null>(null);

  // Fleet-level rolling-average buffers (5-sample window, display-layer only).
  // Placed here (before the early returns below) so hooks are always called
  // unconditionally per the Rules of Hooks.
  // Volatile metrics (tok/s-derived): longer window (12) damps 30-s probe noise
  // while still updating visibly across ~2 probe cycles (~60 s).
  // Steadier metrics (raw watts, power cost): default node window (8) is fine.
  const fleetTpsBuf     = useRollingBuffer(FLEET_ROLLING_WINDOW); // Tile 1: fleet throughput
  const wattPer1kBuf    = useRollingBuffer(FLEET_ROLLING_WINDOW); // Tile 6: W / 1k tokens — tok/s-derived
  const costPer1kBuf    = useRollingBuffer(FLEET_ROLLING_WINDOW); // Tile 7: $ / 1M — tok/s-derived
  const fleetWesBuf     = useRollingBuffer(FLEET_ROLLING_WINDOW); // Tile 5 + Fleet Intelligence WES card
  const costPer1kNewBuf = useRollingBuffer(FLEET_ROLLING_WINDOW); // Fleet Intelligence cost card
  const fleetWattsBuf   = useRollingBuffer();                     // Fleet Intelligence Tokens Per Watt (watts-only, steadier)

  // Per-node cost rolling average — keyed by nodeId, managed via Map ref so
  // hook count doesn't grow with fleet size (hooks must be called unconditionally).
  const nodeCostBufsRef = useRef<Map<string, { buf: number[]; lastTs: number }>>(new Map());

  // Unified connected / transport for rendering (local uses own state, cloud uses context)
  const connected = isLocalHost ? localConnected : cloudConnected;
  const transport = isLocalHost ? localTransport : cloudTransport;

  const pushHistoryPoint = useCallback((data: SentinelMetrics) => {
    setHistory(prev => {
      const ts  = new Date(data.timestamp_ms);
      const lbl = `${ts.getMinutes().toString().padStart(2, '0')}:${ts.getSeconds().toString().padStart(2, '0')}`;
      const pt: HistoryPoint = {
        time:  lbl,
        gpu:   data.nvidia_gpu_utilization_percent ?? data.gpu_utilization_percent ?? null,
        cpu:   data.cpu_usage_percent,
        // memory_pressure_percent is Apple Silicon only; fall back to used/total for Linux.
        mem:   data.memory_pressure_percent ??
               (data.total_memory_mb > 0 ? (data.used_memory_mb / data.total_memory_mb) * 100 : null),
        power: data.cpu_power_w ?? data.nvidia_power_draw_w ?? null,
      };
      const next = [...prev, pt];
      return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
    });
  }, []);

  const handleMetrics = useCallback((data: SentinelMetrics) => {
    setSentinel(data);
    setLocalConnected(true);
    pushHistoryPoint(data);
  }, [pushHistoryPoint]);

  // Local WS/SSE connection — only active on localhost.
  useEffect(() => {
    if (!isLocalHost) return;

    let retryWs:  ReturnType<typeof setTimeout>;
    let retrySse: ReturnType<typeof setTimeout>;
    let wsFailed = false;

    const connectSSE = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) return;
      const es = new EventSource('/api/metrics');
      esRef.current = es;
      es.onopen    = () => setLocalTransport('sse');
      es.onmessage = (ev) => {
        try { handleMetrics(JSON.parse(ev.data) as SentinelMetrics); setLocalTransport('sse'); }
        catch { /* malformed frame */ }
      };
      es.onerror = () => {
        setLocalConnected(false);
        es.close();
        esRef.current = null;
        retrySse = setTimeout(connectSSE, 3000);
      };
    };

    const connectWS = () => {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      wsRef.current = ws;
      ws.onmessage = (ev) => {
        try {
          handleMetrics(JSON.parse(ev.data as string) as SentinelMetrics);
          setLocalTransport('ws');
          if (esRef.current) { esRef.current.close(); esRef.current = null; }
        } catch { /* malformed frame */ }
      };
      ws.onerror = () => { wsFailed = true; };
      ws.onclose = () => {
        wsRef.current = null;
        setLocalConnected(false);
        if (wsFailed) { connectSSE(); }
        else {
          if (!esRef.current) connectSSE();
          retryWs = setTimeout(() => { wsFailed = false; connectWS(); }, 3000);
        }
      };
    };

    connectWS();

    return () => {
      clearTimeout(retryWs);
      clearTimeout(retrySse);
      wsRef.current?.close();
      esRef.current?.close();
    };
  }, [handleMetrics]);

  // Feed cloud metrics into the history buffer for the System Performance chart.
  // Fleet-wide aggregation: average CPU/GPU/mem across all reporting nodes, sum power.
  // GPU check uses both field names so Apple Silicon (gpu_utilization_percent) and
  // NVIDIA (nvidia_gpu_utilization_percent) nodes both contribute — nodes with neither
  // field are excluded from the GPU average but do not drop the series.
  const prevCloudMetricsRef = useRef<Record<string, SentinelMetrics>>({});
  useEffect(() => {
    if (isLocalHost) return;
    const hasNew = Object.entries(cloudMetrics).some(
      ([id, m]) => m.timestamp_ms !== prevCloudMetricsRef.current[id]?.timestamp_ms,
    );
    prevCloudMetricsRef.current = cloudMetrics;
    if (!hasNew) return;

    const all = Object.values(cloudMetrics);
    if (all.length === 0) return;

    const latestTs = Math.max(...all.map(m => m.timestamp_ms));
    const d = new Date(latestTs);
    const lbl = `${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;

    // GPU — check both Apple Silicon and NVIDIA field names; exclude nodes where both are null
    const gpuVals = all
      .map(m => m.nvidia_gpu_utilization_percent ?? m.gpu_utilization_percent ?? null)
      .filter((v): v is number => v != null);
    const gpu = gpuVals.length > 0 ? gpuVals.reduce((a, b) => a + b, 0) / gpuVals.length : null;

    // CPU — average across all nodes
    const cpu = all.reduce((a, m) => a + m.cpu_usage_percent, 0) / all.length;

    // Memory — average across nodes that report pressure or used/total
    const memVals = all
      .map(m => m.memory_pressure_percent ??
        (m.total_memory_mb > 0 ? (m.used_memory_mb / m.total_memory_mb) * 100 : null))
      .filter((v): v is number => v != null);
    const mem = memVals.length > 0 ? memVals.reduce((a, b) => a + b, 0) / memVals.length : null;

    // Power — total draw across all nodes that report any power metric
    const powerVals = all
      .map(m => (m.cpu_power_w != null || m.nvidia_power_draw_w != null)
        ? (m.cpu_power_w ?? 0) + (m.nvidia_power_draw_w ?? 0)
        : null)
      .filter((v): v is number => v != null);
    const power = powerVals.length > 0 ? powerVals.reduce((a, b) => a + b, 0) : null;

    setHistory(prev => {
      const pt: HistoryPoint = { time: lbl, gpu, cpu, mem, power };
      const next = [...prev, pt];
      return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
    });
  }, [cloudMetrics]);

  // Close metric dropdown on outside click
  useEffect(() => {
    if (!metricOpen) return;
    const handler = (e: MouseEvent) => {
      if (!metricDropdownRef.current?.contains(e.target as Node)) setMetricOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [metricOpen]);

  // allNodeMetrics / lastSeenMsMap: unified references for local vs cloud
  const allNodeMetrics = isLocalHost
    ? (sentinel ? { [sentinel.node_id ?? 'local']: sentinel } : {})
    : cloudMetrics;
  const lastSeenMsMap = cloudLastSeen;

  // Single source of truth for all registered-node counts.
  // Must be called before any early returns (Rules of Hooks).
  const counts = useFleetCounts(nodes);

  // While the initial fleet fetch is in-flight (nodesLoading), show a blank
  // loading screen rather than EmptyFleetState — avoids the "Add your first node"
  // flash on every page refresh for users who already have nodes paired.
  if (!isLocalHost && nodesLoading) {
    return (
      <div className="flex items-center justify-center py-32 animate-in fade-in duration-300">
        <div className="flex items-center gap-3 text-gray-500">
          <div className="w-4 h-4 rounded-full border-2 border-gray-600 border-t-indigo-400 animate-spin" />
          <span className="text-sm font-medium">Loading fleet…</span>
        </div>
      </div>
    );
  }

  if (!isLocalHost && nodes.length === 0) {
    return <EmptyFleetState onAddNode={onAddNode} />;
  }

  // ── Fleet-wide metric computations (all 8 Insight Engine tiles) ─────────────
  const liveMetrics: SentinelMetrics[] = Object.values(allNodeMetrics);
  // effectiveMetrics: handles localhost sentinel mode + hosted fleet mode uniformly
  const effectiveMetrics: SentinelMetrics[] = isLocalHost ? (sentinel ? [sentinel] : []) : liveMetrics;

  // Tile 1 — THROUGHPUT: ∑ estimated tok/s across inference-active nodes (Ollama + vLLM).
  // Both runtimes are not mutually exclusive — a node can run both simultaneously.
  // tpsNodes includes nodes with a live raw reading OR a peak+GPU estimate (covers lockup case).
  const hasAnyOllama = effectiveMetrics.some(m => m.ollama_running);
  const hasAnyVllm   = effectiveMetrics.some(m => m.vllm_running);
  const tpsNodes     = effectiveMetrics.filter(m => {
    const hasRaw = (m.ollama_running && m.ollama_tokens_per_second != null) ||
                   (m.vllm_running   && m.vllm_tokens_per_sec      != null);
    if (hasRaw) return true;
    // Include nodes where peak + GPU utilisation gives a meaningful estimate.
    const peak = peakTpsMap[m.node_id] ?? null;
    const gpu  = m.nvidia_gpu_utilization_percent ?? m.gpu_utilization_percent ?? null;
    return peak != null && (gpu ?? 0) > 0;
  });
  const fleetTps     = tpsNodes.length > 0
    ? tpsNodes.reduce((acc, m) => {
        const rawCombined = (m.ollama_tokens_per_second ?? 0) + (m.vllm_tokens_per_sec ?? 0) || null;
        const gpu         = m.nvidia_gpu_utilization_percent ?? m.gpu_utilization_percent ?? null;
        return acc + (estimateTps(rawCombined, peakTpsMap[m.node_id] ?? null, gpu, m.ollama_inference_active ?? null) ?? 0);
      }, 0)
    : null;

  // Whether any node is currently inferring (controls Throughput tile sub-label)
  const anyInferring = tpsNodes.some(m =>
    m.ollama_inference_active === true ||
    (m.vllm_running === true && (m.vllm_tokens_per_sec ?? 0) > 0)
  );
  // Whether any inferring node has the Wicklee proxy active (exact tok/s, not estimated)
  const anyProxyActive = tpsNodes.some(m => m.ollama_proxy_active === true);

  // Tile 2 — FLEET HEALTH: % nodes in Normal/Fair thermal state
  const fleetHealthPct = calculateFleetHealthPct(effectiveMetrics);
  const fleetHealthCls = fleetHealthPct == null        ? 'text-gray-400 dark:text-gray-600'
    : fleetHealthPct === 100                           ? 'text-green-600 dark:text-green-400'
    : fleetHealthPct >= 75                             ? 'text-amber-600 dark:text-amber-500'
    :                                                    'text-red-600 dark:text-red-500';

  // Tile 3 — TOTAL FLEET VRAM: utilization % + used / capacity
  const totalVramMb         = calculateTotalVramMb(effectiveMetrics);
  const totalVramCapacityMb = calculateTotalVramCapacityMb(effectiveMetrics);
  const vramUtilPct         = totalVramCapacityMb > 0
    ? Math.round((totalVramMb / totalVramCapacityMb) * 100) : null;
  const vramUsedGB     = (totalVramMb / 1024).toFixed(1);
  const vramCapacityGB = (totalVramCapacityMb / 1024).toFixed(1);

  // Tile 4 — FLEET NODES: online / total
  // fleetTotalCount — all registered nodes (single source via useFleetCounts)
  // fleetLiveCount  — set below, after reachableNodeIds is computed
  const fleetTotalCount = isLocalHost ? (sentinel != null ? 1 : 0) : counts.total;

  // Tiles 5-7 — WES leaderboard + fleet average
  interface WESEntry { nodeId: string; hostname: string; wes: number | null; rawWes: number | null; tcPct: number; tps: number | null; watts: number | null; thermalState: string | null; thermalSource: string | null; nullReason: string; costPer1mRaw: number | null; kwhRate: number; }
  const wesEntries: WESEntry[] = effectiveMetrics.map(m => {
    const _ollamaTps = m.ollama_tokens_per_second ?? null;
    const _vllmTps   = m.vllm_tokens_per_sec ?? null;
    const rawCombined = _ollamaTps != null && _vllmTps != null ? _ollamaTps + _vllmTps
                      : (_ollamaTps ?? _vllmTps);
    const gpuUtil = m.nvidia_gpu_utilization_percent ?? m.gpu_utilization_percent ?? null;
    const tps     = estimateTps(rawCombined, peakTpsMap[m.node_id] ?? null, gpuUtil, m.ollama_inference_active ?? null);
    const totalW   = (m.cpu_power_w ?? 0) + (m.nvidia_power_draw_w ?? 0);
    const hasWatts = m.cpu_power_w != null || m.nvidia_power_draw_w != null;
    const watts    = hasWatts ? totalW : null;
    const ns       = getNodeSettings?.(m.node_id);
    const pue      = ns?.pue ?? 1.0;
    const kwhRate  = ns?.kwhRate ?? fleetKwhRate;
    const wes      = computeWES(tps, watts, m.thermal_state, pue);
    const rawWes   = computeRawWES(tps, watts, pue);
    const tcPct    = thermalCostPct(rawWes, wes);
    const nullReason = tps == null || tps <= 0 ? 'no inference' : !hasWatts ? 'no power data' : '';
    // Raw $/1M tokens: ($/hr facility cost) / (M tokens/hr throughput)
    //   $/hr         = watts × pue × kwhRate / 1000   (W → kW → $/hr)
    //   M tokens/hr  = tps × 3600 / 1,000,000 = tps × 0.0036
    //   $/1M         = (watts × pue × kwhRate / 1000) / (tps × 0.0036)
    //                = (watts × pue × kwhRate) / (tps × 3.6)
    const costPer1mRaw = (tps != null && tps > 0 && watts != null)
      ? ((watts * pue * kwhRate) / (tps * 3.6))
      : null;
    return { nodeId: m.node_id, hostname: m.hostname ?? m.node_id, wes, rawWes, tcPct, tps, watts, thermalState: m.thermal_state, thermalSource: m.thermal_source ?? null, nullReason, costPer1mRaw, kwhRate };
  });
  const pueValues = effectiveMetrics.map(m => getNodeSettings?.(m.node_id)?.pue ?? 1.0);
  const hasPerNodePueDiversity = new Set(pueValues).size > 1;
  const sortedWES  = [...wesEntries].sort((a, b) => {
    if (a.wes != null && b.wes != null) return b.wes - a.wes;
    if (a.wes != null) return -1;
    if (b.wes != null) return 1;
    return 0;
  });
  const rankedWES    = sortedWES.filter(e => e.wes != null);
  const fleetAvgWES  = rankedWES.length > 0
    ? rankedWES.reduce((acc, e) => acc + e.wes!, 0) / rankedWES.length : null;
  const efficiencyRatio = rankedWES.length >= 2
    ? rankedWES[0].wes! / rankedWES[rankedWES.length - 1].wes! : null;

  // ── Per-node cost rolling average ───────────────────────────────────────────
  // Smooth each node's raw $/1M over NODE_ROLLING_WINDOW samples using the
  // Map-based ref so no hook count grows with fleet size.
  const costEntries = wesEntries.map(e => {
    const m   = effectiveMetrics.find(x => x.node_id === e.nodeId);
    const ts  = m?.timestamp_ms ?? 0;
    if (!nodeCostBufsRef.current.has(e.nodeId)) {
      nodeCostBufsRef.current.set(e.nodeId, { buf: [], lastTs: 0 });
    }
    const state = nodeCostBufsRef.current.get(e.nodeId)!;
    const raw   = e.costPer1mRaw;
    if (raw != null && isFinite(raw) && e.tps != null && e.tps >= MIN_COST_TPS) {
      if (!(ts > 0 && ts <= state.lastTs)) {
        if (ts > 0) state.lastTs = ts;
        state.buf = state.buf.length < NODE_ROLLING_WINDOW
          ? [...state.buf, raw]
          : [...state.buf.slice(1), raw];
      }
    }
    const costPer1m = state.buf.length > 0
      ? state.buf.reduce((a, c) => a + c, 0) / state.buf.length
      : null;
    return { ...e, costPer1m };
  });

  // ── Thermal diversity ───────────────────────────────────────────────────────
  const thermalCounts: Record<string, number> = {};
  effectiveMetrics.forEach(m => {
    const state = m.thermal_state ?? derivedNvidiaThermal(m.nvidia_gpu_temp_c ?? null)?.label ?? null;
    if (state) thermalCounts[state] = (thermalCounts[state] ?? 0) + 1;
  });
  const allNormal      = effectiveMetrics.length > 0 && Object.keys(thermalCounts).every(s => ['normal', 'nominal'].includes(s.toLowerCase()));
  const hasThrottling  = Object.keys(thermalCounts).some(s => ['serious', 'critical'].includes(s.toLowerCase()));

  // ── Best Route Now ──────────────────────────────────────────────────────────
  const activeEntries    = wesEntries.filter(e => e.tps != null && e.tps > 0);
  const sortedByTps      = [...activeEntries].sort((a, b) => (b.tps ?? 0) - (a.tps ?? 0));
  const sortedByWes      = [...activeEntries].filter(e => e.wes != null).sort((a, b) => (b.wes ?? 0) - (a.wes ?? 0));
  const bestLatNode      = sortedByTps[0] ?? null;
  const bestEffNode      = sortedByWes[0] ?? null;
  // Cost signal — cheapest $/1M among active nodes with power data
  const activeCostEntries = costEntries.filter(e => e.tps != null && e.tps > 0 && e.costPer1m != null);
  const sortedByCost      = [...activeCostEntries].sort((a, b) => (a.costPer1m ?? Infinity) - (b.costPer1m ?? Infinity));
  const bestCostNode      = sortedByCost[0] ?? null;
  const sameNode          = bestLatNode != null && bestEffNode != null && bestLatNode.nodeId === bestEffNode.nodeId;
  const tpsDelta          = !sameNode && bestLatNode && bestEffNode && (bestEffNode.tps ?? 0) > 0
    ? (bestLatNode.tps ?? 0) / bestEffNode.tps! : null;
  const wesDelta          = !sameNode && bestEffNode?.wes != null && (bestLatNode?.wes ?? 0) > 0
    ? bestEffNode.wes / bestLatNode!.wes! : null;

  // Tile 6 — WATTAGE / 1K TKN: total power ÷ fleet throughput × 1000
  // wattPowerNodes exposed so the tile subtitle can show the contributing node count.
  const wattPowerNodes = (fleetTps != null && fleetTps >= MIN_COST_TPS)
    ? tpsNodes.filter(m => m.cpu_power_w != null || m.nvidia_power_draw_w != null)
    : [];
  const wattPer1k = (() => {
    if (fleetTps == null || fleetTps < MIN_COST_TPS) return null;
    if (wattPowerNodes.length === 0) return null;
    const totalPowerW = wattPowerNodes.reduce((acc, m) =>
      acc + (m.cpu_power_w ?? 0) + (m.nvidia_power_draw_w ?? 0), 0);
    return (totalPowerW / fleetTps) * 1000;
  })();

  // Tile 7 — COST / 1M TOKENS derived from energy per 1k tokens.
  // wattPer1k is in J/k·tok (Joules per 1k tokens). To convert to $/k·tok:
  //   J/k·tok × (1 kWh / 3,600,000 J) × ($/kWh) = $/k·tok
  // The display then multiplies by 1000 to show $/1M tokens.
  // NOTE: the old formula used /1000 instead of /3,600,000 — a ×3600 unit error.
  const costPer1k = wattPer1k != null ? (wattPer1k * fleetKwhRate) / 3_600_000 : null;

  // Tile 8 — FLEET POWER COST / DAY: ∑ watts_i × pue_i × 24h × rate_i
  // Covers all nodes that report power data (cpu_power_w or nvidia_power_draw_w).
  // We intentionally do NOT filter by inference activity here: ollama_tokens_per_second
  // is a 30-second probe value that persists after inference stops, making any
  // "is actively inferring" check unreliable — it would exclude the entire fleet.
  // This tile represents the always-on infrastructure electricity cost.
  // Power: nvidia_power_draw_w preferred (NVIDIA via NVML); falls back to cpu_power_w
  // (Apple Silicon powermetrics or Linux RAPL).
  const idleFleetCostPerDay = (() => {
    const withPower = effectiveMetrics.filter(m =>
      m.nvidia_power_draw_w != null || m.cpu_power_w != null
    );
    if (withPower.length === 0) return null;
    return withPower.reduce((acc, m) => {
      const ns = getNodeSettings?.(m.node_id);
      const pue = ns?.pue ?? 1.0;
      const rate = ns?.kwhRate ?? fleetKwhRate;
      // Prefer NVIDIA board power (dedicated GPU); fall back to Apple Silicon / RAPL CPU power.
      const watts = m.nvidia_power_draw_w ?? m.cpu_power_w ?? 0;
      return acc + watts * pue * 24 * (rate / 1000);
    }, 0);
  })();
  const idlePowerNodes = effectiveMetrics.filter(m =>
    m.nvidia_power_draw_w != null || m.cpu_power_w != null
  );
  const avgPue = effectiveMetrics.length > 0
    ? effectiveMetrics.reduce((acc, m) => acc + (getNodeSettings?.(m.node_id)?.pue ?? 1.0), 0) / effectiveMetrics.length
    : 1.0;

  // Fleet Intelligence — Cost Efficiency + Tokens Per Watt
  // Only over inference-active nodes (tpsNodes) so PUE + rate apply to actual workload.
  const fleetHourlyCostUsd = (() => {
    const powerNodes = tpsNodes.filter(m => m.cpu_power_w != null || m.nvidia_power_draw_w != null);
    if (powerNodes.length === 0) return null;
    return powerNodes.reduce((acc, m) => {
      const ns   = getNodeSettings?.(m.node_id);
      const pue  = ns?.pue ?? 1.0;
      const rate = ns?.kwhRate ?? fleetKwhRate;
      const watts = (m.cpu_power_w ?? 0) + (m.nvidia_power_draw_w ?? 0);
      return acc + watts * pue * rate / 1000;
    }, 0);
  })();
  // Gate on MIN_COST_TPS: near-zero tok/s during Ollama ramp-up produces
  // enormous $/1M values that contaminate the rolling buffer for minutes.
  const costPer1kTokensNew = (fleetTps != null && fleetTps >= MIN_COST_TPS)
    ? calculateCostPer1kTokens(fleetTps, fleetHourlyCostUsd)
    : null;

  const totalPowerOfTpsNodes = (() => {
    const powerNodes = tpsNodes.filter(m => m.cpu_power_w != null || m.nvidia_power_draw_w != null);
    if (powerNodes.length === 0) return null;
    return powerNodes.reduce((acc, m) =>
      acc + (m.cpu_power_w ?? 0) + (m.nvidia_power_draw_w ?? 0), 0);
  })();
  const tokensPerWattVal = calculateTokensPerWatt(fleetTps, totalPowerOfTpsNodes);

  // ── Rolling-average display values ──────────────────────────────────────────
  // Use the highest timestamp_ms across all reporting nodes as the dedup key so
  // that each SSE frame is pushed exactly once even across React strict-mode
  // double-renders.
  const fleetTs = effectiveMetrics.length > 0
    ? Math.max(...effectiveMetrics.map(m => m.timestamp_ms))
    : 0;
  const displayFleetTps     = fleetTpsBuf.push(fleetTps,              fleetTs);
  const displayWattPer1k    = wattPer1kBuf.push(wattPer1k,            fleetTs);
  const displayCostPer1k    = costPer1kBuf.push(costPer1k,            fleetTs);
  const displayFleetAvgWES  = fleetWesBuf.push(fleetAvgWES,           fleetTs);
  const displayCostPer1kNew = costPer1kNewBuf.push(costPer1kTokensNew, fleetTs);
  // Smoothed fleet total watts — same node set as fleetTps (tpsNodes with power data).
  const displayFleetWatts   = fleetWattsBuf.push(totalPowerOfTpsNodes, fleetTs);
  // Fleet Tokens Per Watt — tok/s ÷ (kW) — consistent formula with Fleet Status table column.
  const displayTokPerKW = (displayFleetTps != null && displayFleetWatts != null && displayFleetWatts > 0)
    ? displayFleetTps / displayFleetWatts
    : null;
  // ── SSE connection indicator (3-state) ──────────────────────────────────────
  const sseNow = Date.now();

  const unreachableNodeIds = isLocalHost
    ? []
    : Object.keys(lastSeenMsMap).filter(id => sseNow - (lastSeenMsMap[id] ?? 0) > NODE_REACHABLE_MS);
  const reachableNodeIds = isLocalHost
    ? []
    : Object.keys(lastSeenMsMap).filter(id => sseNow - (lastSeenMsMap[id] ?? 0) <= NODE_REACHABLE_MS);
  const localNodeStale = isLocalHost && sentinel != null && sseNow - (sentinel.timestamp_ms ?? 0) > NODE_REACHABLE_MS;

  // fleetLiveCount — uses lastSeenMsMap reachability (same logic as SSE indicator) so the
  // FLEET NODES tile stays consistent with the amber "unreachable" indicators in the UI.
  // counts.online is NOT used here because the backend sets status='online' at pair time and
  // never reverts it, so it would always equal counts.total regardless of actual liveness.
  const fleetLiveCount = isLocalHost ? effectiveMetrics.length : reachableNodeIds.length;
  const localNodeId = sentinel?.hostname ?? 'local node';

  const sseState: 'green' | 'amber' | 'red' = !connected
    ? 'red'
    : (isLocalHost ? localNodeStale : unreachableNodeIds.length > 0)
    ? 'amber'
    : 'green';

  const sseLabel = sseState === 'red'
    ? 'Disconnected'
    : sseState === 'amber'
    ? isLocalHost
      ? 'Live · 1 node unreachable'
      : `Live · ${unreachableNodeIds.length} node${unreachableNodeIds.length !== 1 ? 's' : ''} unreachable`
    : 'Live · All nodes reporting';

  const sseTooltip = sseState === 'red'
    ? 'SSE stream disconnected · attempting to reconnect'
    : sseState === 'amber'
    ? isLocalHost
      ? `SSE connected · ${localNodeId} last seen ${fmtAgo(sentinel?.timestamp_ms ?? 0)}`
      : `SSE connected · ${unreachableNodeIds.map(id => `${id} last seen ${fmtAgo(lastSeenMsMap[id])}`).join(' · ')}`
    : isLocalHost
    ? `SSE connected · ${localNodeId} live`
    : `SSE connected · ${reachableNodeIds.join(' ')} all live`;

  // Build Fleet Status row data — include peakTps so each row can estimate throughput.
  const nodeRows: NodeRowProps[] = isLocalHost
    ? (sentinel ? [{
        nodeId: sentinel.node_id,
        hostname: sentinel.hostname ?? sentinel.node_id,
        metrics: sentinel,
        pue: getNodeSettings?.(sentinel.node_id)?.pue ?? 1.0,
        peakTps: peakTpsMap[sentinel.node_id],
      }] : [])
    : nodes.map(n => ({
        nodeId: n.id,
        hostname: n.hostname,
        metrics: allNodeMetrics[n.id] ?? null,
        lastSeenMs: lastSeenMsMap[n.id],
        pue: getNodeSettings?.(n.id)?.pue ?? 1.0,
        peakTps: peakTpsMap[n.id],
      }));

  // "Show Active Only" filter — hides nodes not currently inferring
  const visibleRows = showActiveOnly
    ? nodeRows.filter(r => {
        const m = r.metrics;
        return m?.ollama_inference_active === true ||
               (m?.vllm_running === true && (m?.vllm_tokens_per_sec ?? 0) > 0);
      })
    : nodeRows;

  return (
    <div className="space-y-6">
      {/* ── 8-tile Insight Engine: 2 rows × 4 cols ───────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">

        {/* ── Row 1: Performance & Health ─────────────────────────────────── */}

        {/* 1. THROUGHPUT */}
        <InsightTile
          label="Throughput"
          value={displayFleetTps != null ? `${displayFleetTps.toFixed(1)} tok/s` : '—'}
          valueCls={displayFleetTps == null ? 'text-gray-400 dark:text-gray-600' : undefined}
          sub={fleetTps != null
            ? isLocalMode
              ? (anyInferring ? (anyProxyActive ? 'live' : 'live estimate') : 'idle-spd baseline')
              : `${tpsNodes.length} node${tpsNodes.length !== 1 ? 's' : ''} · ${anyInferring ? (anyProxyActive ? 'live' : 'live estimate') : 'idle-spd baseline'}`
            : (hasAnyOllama || hasAnyVllm) ? 'sampling every 30s' : 'no inference runtime'}
          icon={Activity}
          iconCls="text-indigo-400"
        />

        {/* 2. FLEET / NODE HEALTH */}
        <InsightTile
          label={isLocalMode ? 'Node Health' : 'Fleet Health'}
          value={fleetHealthPct != null ? `${fleetHealthPct}%` : '—'}
          valueCls={fleetHealthCls}
          sub={fleetHealthPct != null ? 'Normal / Fair thermal' : 'no thermal data'}
          icon={Thermometer}
          iconCls="text-amber-400"
        />

        {/* 3. TOTAL FLEET / NODE VRAM */}
        <InsightTile
          label={isLocalMode ? 'Node VRAM' : 'Total Fleet VRAM'}
          value={vramUtilPct != null ? `${vramUtilPct}%` : effectiveMetrics.length > 0 ? `${vramUsedGB} GB` : '—'}
          valueCls={vramUtilPct == null && effectiveMetrics.length === 0 ? 'text-gray-400 dark:text-gray-600' : undefined}
          sub={vramUtilPct != null ? `${vramUsedGB} / ${vramCapacityGB} GB` : vramUtilPct == null && effectiveMetrics.length > 0 ? `${vramUsedGB} GB used` : undefined}
          icon={Database}
          iconCls="text-blue-400"
        />

        {/* 4. FLEET NODES (cloud) / RUNTIME STATUS (local) */}
        {isLocalMode ? (
          <InsightTile
            label="Runtime"
            value={
              sentinel?.vllm_running  ? (sentinel.vllm_model_name ?? 'vLLM') :
              sentinel?.ollama_running ? (sentinel.ollama_active_model ?? 'Ollama') :
              sentinel ? 'No runtime' : '—'
            }
            valueCls={
              (sentinel?.ollama_running || sentinel?.vllm_running)
                ? 'text-green-400'
                : 'text-gray-400 dark:text-gray-600'
            }
            sub={
              sentinel?.vllm_running  ? 'vLLM · active' :
              sentinel?.ollama_running ? 'Ollama · active' :
              sentinel ? 'Ollama + vLLM not detected' : undefined
            }
            icon={Cpu}
            iconCls="text-green-400"
          />
        ) : (
          <InsightTile
            label="Fleet Nodes"
            value={fleetTotalCount > 0 ? `${fleetLiveCount} / ${fleetTotalCount}` : '—'}
            sub={fleetLiveCount > 0
              ? `${fleetLiveCount} online`
              : fleetTotalCount > 0 ? 'no nodes live' : undefined}
            icon={Server}
            iconCls="text-green-400"
          />
        )}

        {/* ── Row 2: Efficiency & ROI ──────────────────────────────────────── */}

        {/* 5. AVG WES / NODE WES */}
        <InsightTile
          label={
            <MetricTooltip
              metricId="wes"
              name="WES — Wicklee Efficiency Score"
              oneLiner="Thermally-honest inference efficiency. tok/watt penalised by heat."
              ranges={[
                { threshold: '> 10', color: 'green', label: 'Excellent · efficient inference hardware' },
                { threshold: '1–10', color: 'amber', label: 'Good · typical GPU at load' },
                { threshold: '< 1',  color: 'red',   label: 'Fair / Poor · throttling' },
              ]}
            >
              {isLocalMode ? 'Node WES' : 'Avg WES'}
            </MetricTooltip>
          }
          value={formatWES(displayFleetAvgWES)}
          valueCls={wesColorClass(displayFleetAvgWES)}
          valueTitle={WES_TOOLTIP}
          sub={fleetAvgWES != null
            ? isLocalMode
              ? 'inference efficiency · this node'
              : `${rankedWES.length} node${rankedWES.length !== 1 ? 's' : ''} · inference MPG`
            : wesEntries.length > 0 ? 'no active inference' : 'connect runtime'}
          icon={Zap}
          iconCls="text-amber-400"
        />

        {/* 6. WATTAGE / 1K TKN — Power draw normalised to 1,000 tokens/s of capacity.
            Formula: (totalPowerW / fleetTps) × 1000 → W per (k·tok/s).
            Equivalent to J/k·tok (same ratio, power framing preferred by convention).
            Cost/1M derives from this via × kWhRate ÷ 3,600,000 (J→kWh conversion). */}
        <InsightTile
          label={
            <MetricTooltip
              metricId="w-1k"
              name="W/1K TKN — Wattage Per 1K Tokens"
              oneLiner="Watts of sustained power draw per 1,000 tok/s of fleet throughput. Lower = more efficient."
            >
              Wattage / 1k Tkn
            </MetricTooltip>
          }
          value={displayWattPer1k != null ? `${displayWattPer1k.toFixed(1)} W` : '—'}
          valueCls={displayWattPer1k == null ? 'text-gray-400 dark:text-gray-600' : undefined}
          sub={wattPowerNodes.length > 0
            ? `${wattPowerNodes.length} node${wattPowerNodes.length !== 1 ? 's' : ''} · per 1k tokens`
            : 'per 1k tokens'}
          icon={Zap}
          iconCls="text-emerald-400"
        />

        {/* 7. COST / 1M TOKENS — shown per-million so operators can compare directly
            against cloud API pricing (e.g. GPT-4o at ~$5/1M) without mental arithmetic. */}
        <InsightTile
          label={
            <MetricTooltip
              metricId="cost-1k"
              name="COST / 1M TOKENS"
              oneLiner="Dollar cost of 1 million tokens based on your configured kWh rate."
            >
              Cost / 1M Tokens
            </MetricTooltip>
          }
          value={displayCostPer1k != null ? `$${(displayCostPer1k * 1000).toFixed(2)}` : '—'}
          valueCls={displayCostPer1k == null ? 'text-gray-400 dark:text-gray-600' : undefined}
          sub={`at $${fleetKwhRate}/kWh`}
          icon={DollarSign}
          iconCls="text-cyan-400"
        />

        {/* 8. FLEET / NODE POWER COST */}
        <InsightTile
          label={isLocalMode ? 'Node Power Cost' : 'Fleet Power Cost'}
          value={idleFleetCostPerDay != null ? `$${idleFleetCostPerDay.toFixed(2)}/day` : '—'}
          valueCls={idleFleetCostPerDay == null ? 'text-gray-400 dark:text-gray-600' : undefined}
          sub={idleFleetCostPerDay != null
            ? isLocalMode
              ? `PUE ${avgPue.toFixed(1)} · 24h estimate`
              : `${idlePowerNodes.length} node${idlePowerNodes.length !== 1 ? 's' : ''} reporting · PUE ${avgPue.toFixed(1)}`
            : 'no power data'}
          icon={DollarSign}
          iconCls="text-gray-400 dark:text-gray-500"
        />

      </div>

      {/* ── Fleet Status (cloud) / Diagnostic Rail (agent) ───────────────────── */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl shadow-sm dark:shadow-none overflow-hidden">
        {/* Section header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-gray-400" />
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              {isLocalMode ? 'Live Hardware' : 'Fleet Status'}
            </h3>
            {isLocalMode ? (
              <span className="text-[10px] text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded-full font-semibold">
                {transport === 'ws' ? '10 Hz' : '1 Hz'}
              </span>
            ) : (
              <span className="text-[10px] text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full">
                {isLocalHost ? (sentinel ? '1' : '0') : counts.total} node{(isLocalHost ? (sentinel ? 1 : 0) : counts.total) !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2" title={sseTooltip}>
            {sseState === 'green' && (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" style={{ animationDuration: '2s' }} />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
              </span>
            )}
            {sseState === 'amber' && (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" style={{ animationDuration: '2s' }} />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
              </span>
            )}
            {sseState === 'red' && (
              <span className="relative flex h-2 w-2">
                <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
              </span>
            )}
            <span className={`text-[10px] font-medium ${
              sseState === 'green' ? 'text-green-600 dark:text-green-400' :
              sseState === 'amber' ? 'text-amber-500 dark:text-amber-400' :
              'text-red-600 dark:text-red-400'
            }`}>
              {sseLabel}
            </span>
          </div>
        </div>

        {isLocalMode ? (
          // ── Diagnostic Rail: live hardware metrics at 10 Hz ──────────────────
          <DiagnosticRail
            sentinel={sentinel}
            transport={transport}
            peakTps={sentinel ? peakTpsMap[sentinel.node_id] : undefined}
          />
        ) : (
          // ── Fleet Status table ───────────────────────────────────────────────
          nodeRows.length > 0 ? (
            <div className="overflow-x-auto">
              {/* Active Only toggle */}
              <div className="flex items-center justify-end px-4 py-1.5 border-b border-gray-100 dark:border-gray-800/60">
                <button
                  onClick={() => setShowActiveOnly(v => !v)}
                  className={`flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest
                    rounded-full px-2.5 py-1 transition-colors
                    ${showActiveOnly
                      ? 'bg-green-500/10 text-green-400'
                      : 'text-gray-500 dark:text-gray-600 hover:text-gray-400'}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${showActiveOnly ? 'bg-green-400' : 'bg-gray-600'}`} />
                  Active Only
                </button>
              </div>
              <FleetStatusHeader />
              <div className="divide-y divide-gray-100 dark:divide-gray-800">
                {visibleRows.map(row => (
                  <FleetStatusRow key={row.nodeId} {...row} />
                ))}
              </div>
            </div>
          ) : (
            <div className="py-10 text-center text-sm text-gray-500">
              {isLocalHost ? 'Connecting to local agent…' : 'No nodes paired yet.'}
            </div>
          )
        )}
      </div>

      {/* ── Fleet Connect card — localhost only ───────────────────────────────── */}
      {isLocalHost && (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          {(!pairingInfo || pairingInfo.status === 'unpaired') && (
            <div className="sm:grid sm:grid-cols-2 gap-6 flex flex-col">
              <div className="flex flex-col justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Cloud className="w-5 h-5 text-gray-400" />
                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-wider font-bold">Sentinel Identity</p>
                    <p className="text-sm font-bold text-white">{pairingInfo?.node_id ?? '—'}</p>
                  </div>
                </div>
                <p className="text-xs text-gray-500">
                  Enter your pairing code at wicklee.dev to connect this node to your fleet.
                </p>
                <button
                  onClick={onOpenPairing}
                  className="self-start px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold rounded-xl transition-all shadow-lg shadow-indigo-500/20"
                >
                  Pair a Node →
                </button>
              </div>
              <div className="h-28 bg-gray-800 border border-gray-700 rounded-xl flex flex-col items-center justify-center gap-1">
                <div className="w-10 h-10 bg-gray-700 rounded-lg" />
                <span className="text-[10px] text-gray-600">QR — Coming Soon</span>
              </div>
            </div>
          )}

          {pairingInfo?.status === 'pending' && (
            <div className="sm:grid sm:grid-cols-2 gap-6 flex flex-col">
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <span className="animate-ping absolute inline-flex h-5 w-5 rounded-full bg-amber-400 opacity-30" />
                    <Cloud className="w-5 h-5 text-amber-400 relative" />
                  </div>
                  <p className="text-sm font-bold text-white">Pairing in Progress</p>
                </div>
                <p className="text-3xl font-bold text-white tracking-[0.3em] tabular-nums">
                  {pairingInfo.code ? `${pairingInfo.code.slice(0, 3)} ${pairingInfo.code.slice(3)}` : '——'}
                </p>
                {pairingInfo.expires_at && (
                  <p className="text-[11px] text-amber-400 tabular-nums">
                    Expires in {Math.max(0, Math.floor((pairingInfo.expires_at - Date.now()) / 1000))}s
                  </p>
                )}
              </div>
              <div className="h-28 bg-gray-800 border border-gray-700 rounded-xl flex flex-col items-center justify-center gap-1">
                <div className="w-10 h-10 bg-gray-700 rounded-lg" />
                <span className="text-[10px] text-gray-600">QR — Coming Soon</span>
              </div>
            </div>
          )}

          {pairingInfo?.status === 'connected' && (
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-4">
                <div className="relative shrink-0">
                  <span className="animate-ping absolute inline-flex h-5 w-5 rounded-full bg-green-400 opacity-20" />
                  <CloudLightning className="w-5 h-5 text-green-400 relative" />
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-0.5">
                    <p className="text-sm font-bold text-white">Connected to Fleet</p>
                    <span className="text-[10px] bg-green-500/10 text-green-400 border border-green-500/20 rounded px-1.5 py-0.5">{pairingInfo.node_id}</span>
                  </div>
                  <p className="text-[11px] text-gray-500">wicklee.dev</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href="https://wicklee.dev"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/30 text-indigo-300 hover:text-indigo-200 text-xs font-medium rounded-xl transition-all"
                >
                  View Fleet Dashboard →
                </a>
                <button
                  onClick={onOpenPairing}
                  className="px-3 py-1.5 border border-red-500/30 hover:border-red-500/60 text-red-400 hover:text-red-300 text-xs font-medium rounded-xl transition-all"
                >
                  Disconnect
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Charts + event feed ──────────────────────────────────────────────── */}
      {(() => {
        // Per-metric display config
        const METRICS: Record<string, { label: string; color: string; gradId: string; unit: string; isPercent: boolean }> = {
          gpu:   { label: 'GPU Utilization', color: '#6366f1', gradId: 'gradGpu',   unit: '%', isPercent: true  },
          cpu:   { label: 'CPU Usage',       color: '#10b981', gradId: 'gradCpu',   unit: '%', isPercent: true  },
          mem:   { label: 'Mem Pressure',    color: '#22d3ee', gradId: 'gradMem',   unit: '%', isPercent: true  },
          power: { label: 'Board Power',     color: '#f59e0b', gradId: 'gradPower', unit: 'W', isPercent: false },
        };

        // Detect which metrics have real data (after a few points)
        const settled = history.length >= 3;
        const hasGpu   = history.some(p => p.gpu   != null);
        const hasMem   = history.some(p => p.mem   != null);
        const hasPower = history.some(p => p.power != null);

        // Auto-fallback: if GPU selected but no GPU data, show CPU instead
        const effectiveKey = selectedMetric === 'gpu' && settled && !hasGpu ? 'cpu' : selectedMetric;
        const cfg = METRICS[effectiveKey];
        const isLive = history.length > 0;

        return (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-6 shadow-sm dark:shadow-none">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-6">
                <div>
                  <h3 className="font-semibold text-gray-800 dark:text-gray-200">
                    {cfg.label}
                    {isLive && (
                      <span className="ml-2 text-[10px] text-indigo-400 font-normal tabular-nums">
                        LIVE · {transport === 'ws' ? '10 Hz' : '1 Hz'} · Current Session
                      </span>
                    )}
                  </h3>
                </div>
                {/* Custom metric selector */}
                <div ref={metricDropdownRef} className="relative">
                  <button
                    onClick={() => setMetricOpen(o => !o)}
                    className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-xs text-gray-600 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600 transition-colors select-none"
                  >
                    <span className="font-medium">
                      {{ gpu: 'GPU Util', cpu: 'CPU', mem: 'Mem Pressure', power: 'Board Power' }[selectedMetric]}
                    </span>
                    <ChevronDown className={`w-3 h-3 text-gray-400 transition-transform duration-150 ${metricOpen ? 'rotate-180' : ''}`} />
                  </button>

                  {metricOpen && (
                    <div className="absolute right-0 top-full mt-1.5 z-30 min-w-[172px] bg-gray-900 border border-gray-700/80 rounded-xl shadow-2xl shadow-black/50 py-1 animate-in fade-in slide-in-from-top-1 duration-150">
                      {(
                        [
                          { key: 'gpu'   as MetricKey, label: 'GPU Util',     na: settled && !hasGpu,   naLabel: ''          },
                          { key: 'cpu'   as MetricKey, label: 'CPU',          na: false,                 naLabel: ''          },
                          { key: 'mem'   as MetricKey, label: 'Mem Pressure', na: settled && !hasMem,   naLabel: 'macOS only' },
                          { key: 'power' as MetricKey, label: 'Board Power',  na: settled && !hasPower, naLabel: ''          },
                        ]
                      ).map(({ key, label, na, naLabel }) => (
                        <button
                          key={key}
                          disabled={na}
                          title={na && naLabel ? naLabel : undefined}
                          onClick={() => { setSelectedMetric(key); setMetricOpen(false); }}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-colors ${
                            na
                              ? 'text-gray-600 cursor-default'
                              : selectedMetric === key
                              ? 'bg-indigo-600/20 text-indigo-300 hover:bg-indigo-600/25'
                              : 'text-gray-300 hover:bg-gray-800'
                          }`}
                        >
                          <span className="w-3.5 shrink-0">
                            {selectedMetric === key && <Check className="w-3.5 h-3.5 text-indigo-400" />}
                          </span>
                          <span className="flex-1">{label}</span>
                          {na && (
                            <span className="text-[10px] text-gray-600" title={naLabel || undefined}>(N/A)</span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="h-64 w-full relative">
                {!isLive && (
                  <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
                    <span className="text-xs text-gray-400 dark:text-gray-600">Collecting data…</span>
                  </div>
                )}
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={isLive ? history : MOCK_HISTORY}>
                    <defs>
                      <linearGradient id={cfg.gradId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor={cfg.color} stopOpacity={isLive ? 0.35 : 0.08}/>
                        <stop offset="95%" stopColor={cfg.color} stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-gray-200 dark:text-gray-800" vertical={false} />
                    <XAxis dataKey="time" stroke="#9ca3af" fontSize={10} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                    <YAxis
                      stroke="#9ca3af" fontSize={10} axisLine={false} tickLine={false}
                      domain={cfg.isPercent ? [0, 100] : [0, 'auto']}
                      tickFormatter={(v: number) => `${v}${cfg.unit}`}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: 'var(--tooltip-bg, #1f2937)', border: '1px solid #374151', borderRadius: '8px', fontSize: '12px' }}
                      formatter={(value: number) => [`${typeof value === 'number' ? value.toFixed(1) : '—'}${cfg.unit}`, cfg.label]}
                    />
                    <Area
                      type="monotone"
                      dataKey={isLive ? effectiveKey : 'requests'}
                      stroke={isLive ? cfg.color : '#374151'}
                      fillOpacity={1}
                      fill={`url(#${cfg.gradId})`}
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                      connectNulls
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <p className="text-[10px] text-gray-600 dark:text-gray-700 mt-2 text-right">
                Live window only — historical data coming in Team Edition
              </p>
            </div>

            <div className="lg:col-span-1 h-full min-h-[400px]">
              <EventFeed events={fleetEvents} />
            </div>
          </div>
        );
      })()}

      {/* ── Fleet Intelligence (cloud) / Fleet Preview CTA (agent) ──────────── */}
      {isLocalMode ? (
        // ── Fleet Preview CTA — only show when not yet paired with Fleet View
        pairingInfo?.status !== 'connected' && (
          <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-5 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-gray-200">
                Monitor from anywhere
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                Pair this node with Fleet View to monitor it remotely and see all your machines in one dashboard.
              </p>
            </div>
            <a
              href="https://wicklee.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 flex items-center gap-2 px-4 py-2 border border-indigo-500/40 hover:border-indigo-500/70 text-indigo-400 hover:text-indigo-300 text-sm font-semibold rounded-xl transition-all"
            >
              Open Fleet Dashboard
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        )
      ) : (
      // ── Fleet Intelligence — full analytics section (cloud / Mission Control only)
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
        <div className="flex items-center gap-2 mb-5">
          <BrainCircuit className="w-4 h-4 text-indigo-400" />
          <h3 className="text-sm font-semibold text-gray-200">Fleet Intelligence</h3>
          {hasPerNodePueDiversity && (
            <span
              className="flex items-center gap-1 text-[10px] text-gray-500 cursor-default"
              title="WES scores reflect per-node PUE settings. Nodes in different locations may have different facility overhead applied."
            >
              <Info size={11} className="text-gray-600 shrink-0" />
              per-node PUE
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-4">

          {/* ── Left: Inference Density Map ─────────────────────────────────── */}
          <div className="bg-gray-800/50 border border-gray-700/40 rounded-xl flex flex-col">
            <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-500 leading-none px-4 pt-4">
              Inference Density
            </p>
            <HexHive rows={nodeRows} />
            <p className="text-[9px] text-gray-600 px-4 pb-3 leading-tight">
              Amber pulse = active · gray = idle · red = throttling
            </p>
          </div>

          {/* ── Right: 5 metric cards ────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3">

            {/* 1. Cost Efficiency — shown per million tokens so sovereign fleet costs are legible
                (sovereign inference is typically sub-cent / 1k, making 1k the wrong display unit).
                displayCostPer1kNew is already smoothed; ×1000 gives per-1M without a second buffer. */}
            {(() => {
              const displayCostPer1M = displayCostPer1kNew != null ? displayCostPer1kNew * 1000 : null;
              // Never show $0.000 — if rounds to zero at 3 dp, show < $0.001
              const costStr = displayCostPer1M == null
                ? '—'
                : displayCostPer1M < 0.001
                ? '< $0.001'
                : `$${displayCostPer1M.toFixed(3)}`;
              return (
                <FleetCard
                  label={
                    <MetricTooltip
                      metricId="cost-efficiency"
                      name="COST EFFICIENCY — $/1M Tokens"
                      oneLiner="Fleet-level cost per million tokens at current draw and throughput."
                    >
                      Cost Efficiency
                    </MetricTooltip>
                  }
                  sub={
                    <p className="text-[10px] text-gray-600 leading-tight">
                      {displayCostPer1M != null
                        ? `est. from current draw · ${tpsNodes.length} node${tpsNodes.length !== 1 ? 's' : ''}`
                        : 'no active inference'}
                    </p>
                  }
                >
                  <p className={`text-xl font-bold font-telin leading-none ${displayCostPer1M != null ? 'text-cyan-400' : 'text-gray-600'}`}>
                    {costStr}
                  </p>
                  {displayCostPer1M != null && <p className="text-[10px] text-gray-500 mt-0.5">/1M tokens</p>}
                </FleetCard>
              );
            })()}

            {/* 2. Fleet Avg WES
                Fleet Avg WES stays here permanently as a live aggregate (Intelligence = "Now").
                Phase 4A: ranked leaderboard with trend lines and regression detection moves to Insights tab.
                Do not migrate the live aggregate — only the historical/interpretive layer goes to Insights. */}
            <FleetCard
              label={
                <MetricTooltip
                  metricId="fleet-avg-wes"
                  name="FLEET AVG WES"
                  oneLiner="Average WES score across all online nodes."
                  ranges={[
                    { threshold: '> 10', color: 'green', label: 'Excellent fleet efficiency' },
                    { threshold: '1–10', color: 'amber', label: 'Good · typical GPU fleet' },
                    { threshold: '< 1',  color: 'red',   label: 'Poor · thermal or CPU inference' },
                  ]}
                >
                  Fleet Avg WES
                </MetricTooltip>
              }
              sub={
                <p className="text-[10px] text-gray-600">
                  {displayFleetAvgWES != null ? `avg across ${rankedWES.length} node${rankedWES.length !== 1 ? 's' : ''}` : 'no active inference'}
                </p>
              }
            >
              <p
                className={`text-xl font-bold font-telin leading-none ${wesColorClass(displayFleetAvgWES)}`}
                title={displayFleetAvgWES != null && displayFleetAvgWES < 10
                  ? (() => {
                      const firstRanked = rankedWES[0];
                      const m = effectiveMetrics.find(x => x.node_id === firstRanked?.nodeId);
                      const w = firstRanked?.watts;
                      return wesBreakdownTitle(firstRanked?.tps ?? null, w ?? null, firstRanked?.thermalState ?? null, m?.chip_name ?? m?.gpu_name ?? null, firstRanked?.rawWes ?? null, firstRanked?.wes ?? null, firstRanked?.thermalSource ?? null);
                    })()
                  : WES_TOOLTIP}
              >
                {formatWES(displayFleetAvgWES)}
              </p>
            </FleetCard>

            {/* 3. Tokens Per Watt — uses same formula as Fleet Status TOK/W column:
                tps ÷ watts. Inputs are smoothed fleet-total values so this
                matches what the per-node column rows would sum to on a single-node setup. */}
            <FleetCard
              label={
                <MetricTooltip
                  metricId="tokens-per-watt"
                  name="TOKENS PER WATT (Fleet)"
                  oneLiner="Fleet-wide energy efficiency — tok/s per watt across all nodes."
                >
                  Tokens Per Watt
                </MetricTooltip>
              }
              sub={
                <p className="text-[10px] text-gray-600 leading-tight">
                  {displayTokPerKW != null
                    ? `${tpsNodes.length} node${tpsNodes.length !== 1 ? 's' : ''} · fleet inference efficiency`
                    : 'no active inference'}
                </p>
              }
            >
              <p className={`text-xl font-bold font-telin leading-none ${displayTokPerKW != null ? 'text-emerald-400' : 'text-gray-600'}`}>
                {displayTokPerKW != null ? displayTokPerKW.toFixed(1) : '—'}
              </p>
              {displayTokPerKW != null && <p className="text-[10px] text-gray-500 mt-0.5">tok/W</p>}
            </FleetCard>

            {/* 4. Thermal Diversity */}
            <FleetCard label="Thermal Diversity">
              {effectiveMetrics.length === 0 ? (
                <p className="text-sm font-telin text-gray-600">—</p>
              ) : allNormal ? (
                <div className="flex items-center gap-1.5">
                  <Check size={12} className="text-green-400 shrink-0" />
                  <p className="text-sm font-telin text-green-400">All Normal</p>
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {Object.entries(thermalCounts).map(([state, count]) => {
                    const isBad = ['serious', 'critical'].includes(state.toLowerCase());
                    const cls   = isBad ? 'text-red-400' : ['fair', 'elevated'].includes(state.toLowerCase()) ? 'text-amber-400' : 'text-green-400';
                    return (
                      <div key={state} className="flex items-center gap-1.5">
                        {isBad && <AlertTriangle size={9} className="text-red-400 shrink-0" />}
                        <p className={`text-xs font-telin font-semibold ${cls}`}>
                          {count} {state}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </FleetCard>

            {/* 4b. Idle Fleet Cost */}
            {(() => {
              const idleNodes = effectiveMetrics.filter(n => {
                const tps   = n.ollama_tokens_per_second ?? n.vllm_tokens_per_sec ?? null;
                const watts = n.cpu_power_w ?? n.nvidia_power_draw_w ?? null;
                return watts != null && (tps == null || tps <= 0);
              });

              if (idleNodes.length === 0) return null;

              const idleCosts = idleNodes.map(n => {
                const ns    = getNodeSettings?.(n.node_id) ?? { pue: 1.0, kwhRate: fleetKwhRate };
                const watts = n.cpu_power_w ?? n.nvidia_power_draw_w ?? 0;
                return {
                  hostname:  n.hostname ?? n.node_id,
                  dailyCost: watts * ns.pue * 24 * (ns.kwhRate / 1000),
                };
              });

              const fleetDailyTotal = idleCosts.reduce((sum, n) => sum + n.dailyCost, 0);

              return (
                <FleetCard
                  label="Idle Fleet Cost"
                  sub={
                    <p className="text-[10px] text-gray-600 leading-tight">
                      {idleNodes.length} idle node{idleNodes.length !== 1 ? 's' : ''} · est. electricity
                    </p>
                  }
                >
                  <div className="space-y-1 w-full">
                    {idleCosts.map((n, i) => (
                      <div key={i} className="flex items-center justify-between gap-2 min-w-0">
                        <span className="text-xs text-gray-500 truncate flex-1 min-w-0">{n.hostname}</span>
                        <span className="font-telin text-xs text-amber-400 shrink-0">
                          ${n.dailyCost.toFixed(2)}/day
                        </span>
                      </div>
                    ))}
                    {idleCosts.length > 1 && (
                      <div className="flex items-center justify-between gap-2 pt-1 border-t border-gray-700/50">
                        <span className="text-[10px] text-gray-600 uppercase tracking-widest">Total</span>
                        <span className="font-telin text-xs text-amber-400">${fleetDailyTotal.toFixed(2)}/day</span>
                      </div>
                    )}
                  </div>
                </FleetCard>
              );
            })()}

            {/* 5. Node Cost / 1M — half-width, pairs with Best Route Now below */}
            {costEntries.some(e => e.costPer1mRaw != null || e.tps == null || e.tps <= 0) && (
              <FleetCard label="Node Cost / 1M Tokens">
                {(() => {
                  const active = costEntries
                    .filter(e => e.tps != null && e.tps > 0)
                    .sort((a, b) => {
                      // Nodes with cost data first (cheapest → most expensive), then no-power-data nodes
                      if (a.costPer1m != null && b.costPer1m != null) return a.costPer1m - b.costPer1m;
                      if (a.costPer1m != null) return -1;
                      if (b.costPer1m != null) return 1;
                      return 0;
                    });
                  const idle = costEntries.filter(e => e.tps == null || e.tps <= 0);

                  if (active.length === 0 && idle.length === 0) {
                    return <p className="text-sm font-telin text-gray-600">— no nodes online</p>;
                  }

                  return (
                    <div className="space-y-1.5 w-full">
                      {active.map((e, i) => {
                        const isChampion = i === 0 && e.costPer1m != null;
                        const costStr    = e.costPer1m == null
                          ? '— no power data'
                          : e.costPer1m < 0.01
                          ? '< $0.01'
                          : `$${e.costPer1m.toFixed(2)}`;
                        const costCls    = e.costPer1m == null
                          ? 'text-gray-600'
                          : isChampion
                          ? 'text-green-400'
                          : 'text-cyan-400';
                        return (
                          <div key={e.nodeId} className="flex items-center gap-2 min-w-0">
                            <span className="text-[9px] uppercase tracking-widest text-gray-500 w-4 shrink-0 text-right">
                              {e.costPer1m != null ? `${i + 1}.` : '—'}
                            </span>
                            <span className="text-xs font-bold font-telin text-gray-200 truncate flex-1 min-w-0">
                              {e.hostname !== e.nodeId ? e.hostname : e.nodeId}
                            </span>
                            <span className={`text-xs font-telin font-semibold shrink-0 ${costCls}`}>
                              {costStr}
                            </span>
                            {e.costPer1m != null && (
                              <span className="text-[10px] text-gray-600 shrink-0">/1M</span>
                            )}
                            {e.tps != null && (
                              <span className="text-[10px] font-telin text-gray-500 shrink-0 w-16 text-right">
                                {e.tps.toFixed(1)} tok/s
                              </span>
                            )}
                          </div>
                        );
                      })}
                      {idle.length > 0 && (
                        <div className={`${active.length > 0 ? 'border-t border-gray-800 pt-1.5 mt-1' : ''} space-y-1`}>
                          {idle.map(e => (
                            <div key={e.nodeId} className="flex items-center gap-2 min-w-0">
                              <span className="text-[9px] uppercase tracking-widest text-gray-700 w-4 shrink-0">—</span>
                              <span className="text-xs font-telin text-gray-600 truncate flex-1 min-w-0">
                                {e.hostname !== e.nodeId ? e.hostname : e.nodeId}
                              </span>
                              <span className="text-[10px] font-telin text-gray-700 shrink-0">idle</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </FleetCard>
            )}

            {/* 6. Best Route Now — half-width, pairs with Node Cost / 1M */}
            <FleetCard label="Best Route Now">
              {activeEntries.length === 0 ? (
                <p className="text-sm font-telin text-gray-600">— no active inference</p>
              ) : activeEntries.length === 1 ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">→</span>
                  <span className="text-sm font-bold font-telin text-gray-200">{activeEntries[0].nodeId}</span>
                  <span className="text-xs text-gray-500">(only active node)</span>
                </div>
              ) : sameNode && bestCostNode == null ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">→</span>
                  <span className="text-sm font-bold font-telin text-gray-200">{bestLatNode!.nodeId}</span>
                  <span className="text-[10px] text-green-400">Best for latency and efficiency</span>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {/* Latency route */}
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] uppercase tracking-widest text-gray-500 w-16 shrink-0">Latency</span>
                    <span className="text-xs text-gray-400">→</span>
                    <span className="text-sm font-bold font-telin text-gray-200">{bestLatNode!.nodeId}</span>
                    <span className="text-xs font-telin text-green-400 ml-auto">{bestLatNode!.tps!.toFixed(1)} tok/s</span>
                  </div>
                  {/* Efficiency route */}
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] uppercase tracking-widest text-gray-500 w-16 shrink-0">Efficiency</span>
                    <span className="text-xs text-gray-400">→</span>
                    <span className="text-sm font-bold font-telin text-gray-200">{bestEffNode!.nodeId}</span>
                    <div className="ml-auto flex flex-col items-end gap-0">
                      <span className={`text-xs font-telin ${wesColorClass(bestEffNode!.wes)}`}>WES {formatWES(bestEffNode!.wes)}</span>
                      {bestEffNode!.tcPct > 0 && (
                        <span className="text-[9px] font-telin text-amber-400/70" title={`${bestEffNode!.tcPct}% of potential efficiency lost to thermal throttling`}>
                          -{bestEffNode!.tcPct}% thermal
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Cost route — always shown when ≥2 active nodes have power data */}
                  {bestCostNode != null && activeCostEntries.length >= 2 && (
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] uppercase tracking-widest text-gray-500 w-16 shrink-0">Cost</span>
                      <span className="text-xs text-gray-400">→</span>
                      <span className="text-sm font-bold font-telin text-gray-200">{bestCostNode.nodeId}</span>
                      <span className="text-xs font-telin text-cyan-400 ml-auto">
                        {bestCostNode.costPer1m! < 0.01 ? '< $0.01' : `$${bestCostNode.costPer1m!.toFixed(2)}`}/1M
                      </span>
                    </div>
                  )}
                  {/* Delta line */}
                  {(tpsDelta != null || wesDelta != null) && (
                    <p className="text-[10px] text-gray-600 pt-0.5">
                      {tpsDelta != null && `tok/s delta: ${tpsDelta.toFixed(1)}×`}
                      {tpsDelta != null && wesDelta != null && '  ·  '}
                      {wesDelta != null && `WES delta: ${wesDelta.toFixed(1)}×`}
                    </p>
                  )}
                </div>
              )}
            </FleetCard>

          </div>
        </div>
      </div>
      )} {/* end isLocalMode ternary — Fleet Intelligence / Fleet Preview CTA */}
    </div>
  );
};

export default Overview;
