import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Thermometer, Database, Zap, Activity, Download, Terminal, Plus, ChevronDown, Check, DollarSign, AlertTriangle, ExternalLink, Cpu, Lock, Fingerprint, Clock} from 'lucide-react';
import { computeWES, computeRawWES, thermalCostPct, thermalSourceLabel, formatWES, wesColorClass } from '../utils/wes';
import { computeModelFitScore } from '../utils/modelFit';
import { calculateFleetHealthPct, calculateTotalVramMb, calculateTotalVramCapacityMb, fleetVramSubtitle, calculateCostPer1kTokens, WES_TOOLTIP, INFERENCE_VRAM_THRESHOLD_MB, ELECTRICITY_RATE_USD_PER_KWH } from '../utils/efficiency';
import { getNodePowerW, hasPowerData } from '../utils/power';
import { pushAndGetSmoothed, pruneBuffers } from '../utils/sharedSmoothing';

import { NODE_REACHABLE_MS, fmtAgo } from '../utils/time';
import { NodeAgent, PairingInfo, SentinelMetrics, ObservabilityNavParams } from '../types';
import ModelFitSummaryStrip from './insights/ModelFitSummaryStrip';
import { useFleetStream } from '../contexts/FleetStreamContext';
import { useNodeRollingMetrics, useRollingBuffer, FLEET_ROLLING_WINDOW, FLEET_ROW_ROLLING_WINDOW, NODE_ROLLING_WINDOW } from '../hooks/useRollingMetrics';
import { useFleetCounts } from '../hooks/useFleetCounts';
import { useLocalEvents } from '../hooks/useLocalEvents';
import { useLocalMetricsStream } from '../hooks/useLocalMetricsStream';
import { thermalColour, derivedNvidiaThermal } from '../utils/thermal';
import EventFeed from './EventFeed';
import MetricTooltip from './MetricTooltip';
import RuntimeConfigModal from './RuntimeConfigModal';

import { IS_LOCAL_HOST as isLocalHost, IS_AGENT as isLocalMode } from '../utils/buildTarget';

/**
 * GPU utilisation thresholds for the four-state TOK/S display:
 *
 * LIVE      inference_state === "live"     — active user session
 * BUSY      inference_state === "busy"     — GPU >20% but no confirmed inference
 * IDLE-SPD  inference_state === "idle-spd" — probe window; cached baseline visible
 * IDLE      inference_state === "idle"     — quiet; gray dash, no badge
 *
 * inference_state is the authoritative field from v0.4.37+ agents.
 * For pre-v0.4.37 agents (field absent), the frontend falls back to computed logic.
 * GPU_BUSY_THRESHOLD is used only by the fallback path.
 */
const GPU_BUSY_THRESHOLD = 20;

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
  if (peak == null) return rawTps;
  const frac = (gpuUtil ?? 0) / 100;
  const underLoad = inferenceActive != null ? inferenceActive : (gpuUtil ?? 0) >= 40;
  if (rawTps == null) return underLoad && frac > 0 ? peak * frac : null;
  return rawTps;
}

interface OverviewProps {
  nodes: NodeAgent[];
  /** True while the initial /api/fleet fetch is in-flight. Suppresses EmptyFleetState flash on refresh. */
  nodesLoading?: boolean;
  pairingInfo?: PairingInfo | null;
  onOpenPairing?: () => void;
  onAddNode?: () => void;
  onUpgrade?: () => void;
  getNodeSettings?: (nodeId: string) => { pue: number; kwhRate: number; currency: string };
  fleetKwhRate?: number;
  /** Cross-nav to Observability tab with optional node pre-filter. */
  onNavigateToObservability?: (params?: ObservabilityNavParams) => void;
  /**
   * Cross-tab navigation into the AI Insights view.  When a user clicks
   * the Model Fit summary strip the strip fires this with
   * ('performance', 'model-fit-analysis') so they land on Insights →
   * Performance and the page scrolls to the full ModelFitAnalysis card.
   */
  onNavigateToInsights?: (tab: 'triage' | 'performance' | 'forensics', scrollTo?: string) => void;
}


const MIN_COST_TPS = 0.1;

interface InsightTileProps {
  label: React.ReactNode;
  value: string;
  valueCls?: string;
  valueTitle?: string;
  sub?: string;
  /** Optional second sub-line — rendered more muted than sub, used for contextual conversions. */
  sub2?: string;
  icon?: React.ElementType;
  iconCls?: string;
}
const InsightTile: React.FC<InsightTileProps> = ({ label, value, valueCls, valueTitle, sub, sub2 }) => (
  <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl p-5 flex flex-col justify-between h-[116px]">
    <div className="flex items-start justify-between gap-2">
      <div className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500 leading-tight">{label}</div>
    </div>
    <div>
      <p
        className={`text-2xl font-bold font-telin leading-none truncate ${valueCls ?? 'text-gray-900 dark:text-white'}`}
        title={valueTitle ?? (typeof value === 'string' ? value : undefined)}
      >
        {value}
      </p>
      {sub && <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-1.5 leading-tight">{sub}</p>}
      {sub2 && <p className="text-[10px] text-gray-400 dark:text-gray-600 mt-0.5 leading-tight">{sub2}</p>}
    </div>
  </div>
);

const FLEET_GRID_CLS = [
  'grid gap-x-3 items-center',
  '[grid-template-columns:140px_200px_80px_80px_1fr]',
  'sm:[grid-template-columns:140px_200px_80px_80px_100px_1fr]',
  'md:[grid-template-columns:140px_120px_100px_200px_80px_65px_80px_80px_80px_60px_80px_100px_1fr]',
].join(' ');

const FS_HDR = 'text-[9px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-600 leading-none whitespace-nowrap';

const FleetStatusHeader: React.FC = () => (
  <div className={`${FLEET_GRID_CLS} px-4 py-2 border-b border-gray-100 dark:border-gray-700/60`}>
    <p className={`${FS_HDR} sticky left-4 bg-white dark:bg-gray-800`}>NODE</p>
    <p className={`${FS_HDR} hidden md:block`}>MEMORY</p>
    <p className={`${FS_HDR} hidden md:block`}>VRAM</p>
    <p className={FS_HDR}>MODEL</p>
    <MetricTooltip
      metricId="wes"
      name="WES — Wicklee Efficiency Score"
      oneLiner="Thermally-honest inference efficiency. tok/watt penalised by heat."
      ranges={[
        { threshold: '> 10', color: 'emerald', label: 'Excellent · highly efficient inference' },
        { threshold: '3–10', color: 'green',  label: 'Good · efficient for the power envelope' },
        { threshold: '1–3',  color: 'yellow', label: 'Acceptable · typical high-power hardware' },
        { threshold: '< 1',  color: 'red',    label: 'Low · check thermal state or model sizing' },
      ]}
    >
      <p className={FS_HDR}>WES</p>
    </MetricTooltip>
    <MetricTooltip
      metricId="tok-w"
      name="tok/W — Tokens Per Watt"
      oneLiner="Raw inference efficiency: tok/s ÷ watts. Same as WES when thermal is Normal."
      wrapperClassName="hidden md:block"
      ranges={[
        { threshold: '> 10', color: 'emerald', label: 'Excellent · highly efficient inference' },
        { threshold: '3–10', color: 'green',  label: 'Good · efficient for the power envelope' },
        { threshold: '1–3',  color: 'yellow', label: 'Acceptable · typical high-power hardware' },
        { threshold: '< 1',  color: 'red',    label: 'Low · check thermal state or model sizing' },
      ]}
    >
      <p className={FS_HDR}>TOK/W</p>
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
      metricId="w-1k"
      name="W/1K — Watts Per 1K Tokens"
      oneLiner="Power draw per 1,000 tokens — lower is more efficient. Matches the fleet summary tile above."
      wrapperClassName="hidden md:block"
    >
      <p className={FS_HDR}>W/1K</p>
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
      metricId="ttft"
      name="TTFT — Time To First Token"
      oneLiner="Latency from request to first generated token. Lower is more responsive."
      ranges={[
        { threshold: '< 100ms', color: 'green', label: 'Fast · interactive quality' },
        { threshold: '100–500ms', color: 'amber', label: 'Moderate · noticeable delay' },
        { threshold: '> 500ms', color: 'red', label: 'Slow · check model size or queue depth' },
      ]}
      wrapperClassName="hidden md:block"
    >
      <p className={FS_HDR}>TTFT</p>
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
        { threshold: 'Serious', color: 'orange', label: '1.75× penalty — significant throttling' },
        { threshold: 'Critical', color: 'red',  label: '2.0× penalty — critical throttling' },
      ]}
      wrapperClassName="hidden sm:block"
    >
      <p className={FS_HDR}>THERMAL</p>
    </MetricTooltip>
    <div />
  </div>
);

const RestrictedNodeBanner: React.FC<{ hostname: string; onUpgrade: () => void }> = ({ hostname, onUpgrade }) => (
  <div className="flex items-center gap-3 px-4 py-3 bg-amber-500/5 border border-amber-500/20 rounded-xl">
    <Lock className="w-4 h-4 text-amber-400 shrink-0" />
    <div className="flex-1 min-w-0">
      <p className="text-xs text-amber-300/90 font-medium truncate">
        <span className="font-mono">{hostname}</span> is active but restricted
      </p>
      <p className="text-[10px] text-gray-500 mt-0.5">
        Upgrade to Team to unlock Accelerator-tier patterns and history
      </p>
    </div>
    <button
      onClick={onUpgrade}
      className="shrink-0 px-3 py-1.5 text-[10px] font-semibold bg-amber-500/10 hover:bg-amber-500/20
                 text-amber-400 border border-amber-500/30 rounded-lg transition-colors"
    >
      Upgrade
    </button>
  </div>
);

const LockedMetricTile: React.FC<{ label: string }> = ({ label }) => (
  <div className="relative overflow-hidden">
    <div className="blur-sm select-none pointer-events-none">
      <p className="text-xs font-telin text-gray-600">—</p>
      <p className="text-[9px] text-gray-600 uppercase tracking-widest">{label}</p>
    </div>
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5">
      <Lock className="w-3 h-3 text-gray-500" />
      <span className="text-[8px] text-gray-500 font-semibold uppercase tracking-widest">Team</span>
    </div>
  </div>
);

interface NodeRowProps {
  nodeId: string;
  hostname: string;
  metrics: SentinelMetrics | null;
  lastSeenMs?: number;
  pue?: number;
  /** Session peak tok/s for this node — from peakTpsMap in FleetStreamContext. */
  peakTps?: number;
  restricted?: boolean;
  onOpenConfig?: (modelName: string) => void;
}

const FleetStatusRow: React.FC<NodeRowProps> = ({ nodeId, hostname, metrics: m, lastSeenMs, pue = 1.0, peakTps, restricted = false, onOpenConfig }) => {
  const [expanded, setExpanded] = useState(false);
  const isOnline = m !== null;

  const { pushOne, resetAll } = useNodeRollingMetrics(isLocalHost ? NODE_ROLLING_WINDOW : FLEET_ROW_ROLLING_WINDOW);
  const wasOnlineRef = useRef(true);
  if (!isOnline && wasOnlineRef.current) resetAll();
  wasOnlineRef.current = isOnline;
  const tsMs = m?.timestamp_ms ?? 0;

  const dotState: 'online' | 'offline' | 'pending' =
    lastSeenMs != null
      ? (Date.now() - lastSeenMs <= NODE_REACHABLE_MS ? 'online' : 'offline')
      : m != null ? 'online'
      : 'pending';
  const dotTooltip =
    dotState === 'online'  ? 'Online · last seen just now' :
    dotState === 'offline' ? `Unreachable · last seen ${fmtAgo(lastSeenMs!)}` :
    'Pending · waiting for first report';

  const rawOllamaTps = m?.ollama_tokens_per_second ?? null;
  const rawVllmTps   = m?.vllm_tokens_per_sec ?? null;
  const rawTps       = rawOllamaTps != null && rawVllmTps != null ? rawOllamaTps + rawVllmTps
                     : (rawOllamaTps ?? rawVllmTps);
  const gpuPctForEst = m?.nvidia_gpu_utilization_percent ?? m?.gpu_utilization_percent ?? null;
  const smoothedTpsShared = pushAndGetSmoothed(nodeId, 'tps', rawTps, tsMs);
  const smoothedTps       = smoothedTpsShared ?? pushOne('tps', rawTps, tsMs);
  const inferenceActive = m?.ollama_inference_active ?? null;
  const inferenceActiveForEst = (m?.inference_state === 'live' || m?.inference_state === 'idle-spd')
    ? true
    : inferenceActive;
  const tps          = estimateTps(smoothedTps, peakTps ?? null, gpuPctForEst, inferenceActiveForEst);
  const isActive     = isOnline && tps != null && tps > 0;

  const isProbing   = m?.ollama_is_probing === true;
  const hasState    = m?.inference_state != null;
  const isInferring = hasState
    ? m!.inference_state === 'live'
    : isOnline && !isProbing && (
        inferenceActive === true ||
        (m?.vllm_running === true && (m?.vllm_requests_running ?? 0) > 0)
      );
  const isEstimated = smoothedTps == null && tps != null;
  const isBusy      = hasState
    ? m!.inference_state === 'busy'
    : isOnline && !isProbing && inferenceActive === false && (gpuPctForEst ?? 0) >= GPU_BUSY_THRESHOLD;
  const isIdleSpeed = hasState
    ? m!.inference_state === 'idle-spd'
    : isOnline && !isInferring && !isBusy && smoothedTps != null;

  const nvThermal  = m && m.thermal_state == null ? derivedNvidiaThermal(m.nvidia_gpu_temp_c ?? null) : null;
  const thermalStr = m?.thermal_state ?? nvThermal?.label ?? null;
  const thermalCls = m?.thermal_state != null ? thermalColour(m.thermal_state) : (nvThermal?.colour ?? 'text-gray-400');
  const thermalWarn = thermalStr != null && !['normal', 'nominal'].includes(thermalStr.toLowerCase());

  const hasPower    = m ? hasPowerData(m) : false;
  const rawTotalW   = m ? getNodePowerW(m) : null;
  const sharedWatts = pushAndGetSmoothed(nodeId, 'watts', hasPower ? rawTotalW : null, tsMs);
  const totalPowerW = sharedWatts ?? pushOne('watts', hasPower ? rawTotalW : null, tsMs) ?? 0;

  const wes    = isActive ? computeWES(tps, hasPower ? totalPowerW : null, m?.thermal_state ?? null, pue) : null;
  const rawWes = isActive ? computeRawWES(tps, hasPower ? totalPowerW : null, pue) : null;
  const tcPct  = thermalCostPct(rawWes, wes);

  const hasNvidia = m?.nvidia_vram_total_mb != null && m.nvidia_vram_total_mb >= INFERENCE_VRAM_THRESHOLD_MB;
  const memLabel  = hasNvidia ? 'VRAM' : 'Memory';
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

  const hasOllama = isOnline && m?.ollama_running === true;
  const hasVllm   = isOnline && m?.vllm_running   === true;
  const modelStr  = !isOnline ? '—'
    : hasOllama ? (m!.ollama_active_model ?? 'Ollama')
    : hasVllm   ? (m!.vllm_model_name    ?? 'vLLM')
    : 'No runtime';

  const fitResult = (hasOllama && m) ? computeModelFitScore(m) : null;

  const isAppleSilicon = m?.memory_pressure_percent != null;
  const vramPctRaw = hasNvidia
    ? ((m!.nvidia_vram_used_mb ?? 0) / m!.nvidia_vram_total_mb!) * 100
    : null;
  const vramPct     = vramPctRaw != null ? Math.round(vramPctRaw * 10) / 10 : null;
  const vramUsedGb  = m?.nvidia_vram_used_mb  != null ? (m.nvidia_vram_used_mb  / 1024).toFixed(1) : null;
  const vramTotalGb = m?.nvidia_vram_total_mb != null ? Math.round(m.nvidia_vram_total_mb / 1024)  : null;

  const wiredLimitMb = (m?.gpu_wired_limit_mb != null && m.gpu_wired_limit_mb > 0)
    ? m.gpu_wired_limit_mb
    : (isAppleSilicon && m != null ? Math.round(m.total_memory_mb * 0.75) : null);
  const gpuAvailMb  = (wiredLimitMb != null && m != null)
    ? Math.max(0, Math.min(wiredLimitMb, m.available_memory_mb))
    : null;
  const gpuUsedPct  = (wiredLimitMb != null && gpuAvailMb != null)
    ? Math.round(((wiredLimitMb - gpuAvailMb) / wiredLimitMb) * 100)
    : null;
  const gpuAvailGb  = gpuAvailMb  != null ? (gpuAvailMb  / 1024).toFixed(1) : null;
  const gpuLimitGb  = wiredLimitMb != null ? Math.round(wiredLimitMb / 1024) : null;
  const gpuUsedGb   = (wiredLimitMb != null && gpuAvailMb != null)
    ? ((wiredLimitMb - gpuAvailMb) / 1024).toFixed(1)
    : null;
  const gpuLimitSrc = m?.gpu_wired_limit_mb != null ? 'iogpu.wired_limit_mb' : 'est.';

  const unifiedColorCls = gpuUsedPct == null ? 'text-gray-400'
    : gpuUsedPct >= 85 ? 'text-red-400'
    : gpuUsedPct >= 65 ? 'text-amber-400'
    : 'text-green-400';
  const unifiedBarCls = gpuUsedPct == null ? 'bg-gray-600'
    : gpuUsedPct >= 85 ? 'bg-red-400'
    : gpuUsedPct >= 65 ? 'bg-amber-400'
    : 'bg-green-400';

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

  const nodeWattsPerKTok = (isActive && hasPower && totalPowerW > 0)
    ? (totalPowerW / tps!) * 1000
    : null;
  const gpuRaw = isOnline
    ? (m!.nvidia_gpu_utilization_percent ?? m!.gpu_utilization_percent ?? null)
    : null;
  const gpuPct = pushOne('gpu', gpuRaw, tsMs) ?? gpuRaw;
  const gpuPctDisplay = gpuPct != null ? Math.round(gpuPct) : null;

  const V = `text-xs font-telin ${!isOnline ? 'text-gray-400 dark:text-gray-600' : ''}`;

  const nodeTooltip = [
    modelStr !== '—' && modelStr !== 'No runtime' ? modelStr : null,
    hasPower && isOnline ? `${totalPowerW.toFixed(1)}W` : null,
    memPct != null ? `${memPct}% ${memLabel}` : null,
  ].filter(Boolean).join('  ·  ');

  return (
    <>
    <div
      onClick={() => setExpanded(e => !e)}
      className={`group ${FLEET_GRID_CLS} px-4 py-3 min-h-[44px] hover:bg-gray-50/50 dark:hover:bg-gray-700/30 transition-colors cursor-pointer${dotState === 'offline' ? ' opacity-50' : ''}`}
    >
      <div className="flex items-center gap-2 overflow-hidden sticky left-4 bg-white dark:bg-gray-800 group-hover:bg-gray-50/50 dark:group-hover:bg-gray-700/30" title={nodeTooltip || undefined}>
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
          {hostname !== nodeId ? (
            <>
              <p className="text-xs font-bold text-gray-900 dark:text-white truncate leading-none">
                {hostname}
                {m?.ollama_proxy_active && <span className="ml-1.5 text-[8px] text-purple-400 bg-purple-500/10 px-1.5 py-0.5 rounded-full font-semibold uppercase">proxy</span>}
              </p>
              <p className="text-[10px] font-telin text-gray-500 truncate leading-none mt-0.5">{nodeId}</p>
            </>
          ) : (
            <p className="text-xs font-telin font-bold text-gray-900 dark:text-white truncate leading-none">
              {nodeId}
              {m?.ollama_proxy_active && <span className="ml-1.5 text-[8px] text-purple-400 bg-purple-500/10 px-1.5 py-0.5 rounded-full font-semibold uppercase">proxy</span>}
            </p>
          )}
          {dotState === 'offline' && (
            <p className="text-[9px] text-gray-400 dark:text-gray-600 leading-none mt-0.5">unreachable</p>
          )}
        </div>
      </div>

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

      <div
        className="hidden md:block min-w-0 overflow-hidden"
        title={vramTooltip}
      >
        {vramPct != null ? (
          <div className="flex items-center gap-1.5">
            <span className={`text-xs font-telin tabular-nums ${vramColorCls}`}>
              {vramUsedGb != null && vramTotalGb != null
                ? <>{vramUsedGb}<span className="text-gray-500 text-[10px]">/{vramTotalGb}</span></>
                : `${vramPct}%`}
            </span>
            <div className="w-10 h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden shrink-0">
              <div className={`h-full ${vramBarCls} rounded-full`} style={{ width: `${Math.min(vramPct, 100)}%` }} />
            </div>
          </div>
        ) : isAppleSilicon && gpuUsedGb != null && gpuLimitGb != null ? (
          <div className="flex items-center gap-1.5">
            <span className={`text-xs font-telin tabular-nums ${unifiedColorCls}`}>
              {gpuUsedGb}<span className="text-gray-500 text-[10px]">/{gpuLimitGb}</span>
            </span>
            <div className="w-10 h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden shrink-0">
              <div className={`h-full ${unifiedBarCls} rounded-full`} style={{ width: `${Math.min(gpuUsedPct ?? 0, 100)}%` }} />
            </div>
          </div>
        ) : (
          <span className="text-xs font-telin text-gray-500 dark:text-gray-600">—</span>
        )}
      </div>

      <div className="min-w-0 overflow-hidden flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <p className={`${V} truncate ${!isOnline || (!hasOllama && !hasVllm) ? 'text-gray-500' : 'text-gray-700 dark:text-gray-300'}`}>
            {modelStr}
          </p>
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
        {hasVllm && m?.vllm_cache_usage_perc != null && m.vllm_cache_usage_perc > 0 && (
          <p className="text-[9px] text-cyan-400 font-telin truncate leading-none">
            Cache: {m.vllm_cache_usage_perc.toFixed(0)}%
          </p>
        )}
      </div>

      {restricted ? (
        <LockedMetricTile label="WES" />
      ) : (
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
      )}

      <div className="hidden md:block overflow-hidden">
        <span
          className={`${V} font-semibold ${rawWes != null ? wesColorClass(rawWes) : 'text-gray-500 dark:text-gray-600'}`}
          title={rawWes != null
            ? `tok/W = tok/s ÷ watts = ${tps?.toFixed(1) ?? '?'} ÷ ${(hasPower ? totalPowerW : 0).toFixed(1)} = ${rawWes.toFixed(2)} tok/W\nNo thermal penalty applied — raw hardware efficiency.`
            : 'tok/W — tokens per watt (raw, no thermal penalty)'}
        >
          {rawWes != null ? formatWES(rawWes) : '—'}
        </span>
      </div>

      {restricted ? (
        <LockedMetricTile label="TOK/S" />
      ) : (
        <div className="min-w-0 overflow-hidden">
          {isInferring ? (
            <>
              <span className={`${V} text-green-400`}
                title={isEstimated ? "Live estimate — inference in progress. ~ indicates GPU%-estimated throughput." : "Live — inference in progress."}>
                {tps != null ? (isEstimated ? `~${tps.toFixed(1)}` : tps.toFixed(1)) : '—'}
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
                {tps?.toFixed(1) ?? '—'}
              </span>
              <p className="text-[9px] uppercase tracking-widest text-gray-500 dark:text-gray-600 mt-0.5 leading-none">idle-spd</p>
            </>
          ) : (
            <>
              <span className={`${V} text-gray-500 dark:text-gray-600`}>—</span>
              <p className="text-[9px] uppercase tracking-widest mt-0.5 leading-none invisible" aria-hidden="true">&nbsp;</p>
            </>
          )}
        </div>
      )}

      <div className="hidden md:block min-w-0 overflow-hidden" title="Watts per 1,000 tokens — power cost per unit of throughput. Lower is more efficient.">
        {nodeWattsPerKTok != null ? (
          <span className={`${V} text-gray-700 dark:text-gray-300`}>
            {nodeWattsPerKTok.toFixed(1)}
          </span>
        ) : (
          <span className="text-xs font-telin text-gray-500 dark:text-gray-600">—</span>
        )}
      </div>

      <div className="hidden md:block min-w-0 overflow-hidden">
        <span
          className={`${V} ${hasPower && isOnline ? 'text-gray-700 dark:text-gray-300' : 'text-gray-500 dark:text-gray-600'}`}
          title="Current power draw of this node."
        >
          {hasPower && isOnline ? `${totalPowerW.toFixed(1)}W` : '—'}
        </span>
      </div>

      <div className="hidden md:block min-w-0 overflow-hidden" title="Time to first token — latency from request to first generated token.">
        {(() => {
          const ttft = m?.vllm_avg_ttft_ms ?? m?.ollama_proxy_avg_ttft_ms ?? m?.ollama_ttft_ms ?? null;
          if (ttft == null || !isOnline) return <span className="text-xs font-telin text-gray-500 dark:text-gray-600">—</span>;
          const cls = ttft < 100 ? 'text-emerald-400' : ttft < 500 ? 'text-yellow-400' : 'text-red-400';
          return <span className={`${V} ${cls}`}>{ttft < 1000 ? `${Math.round(ttft)}ms` : `${(ttft / 1000).toFixed(1)}s`}</span>;
        })()}
      </div>

      <div className="hidden md:block min-w-0 overflow-hidden" title="GPU core utilisation. Source: NVML (NVIDIA) or IOKit AGX (Apple Silicon).">
        {gpuPctDisplay != null ? (
          <span className={`${V} text-gray-700 dark:text-gray-300`}>
            {gpuPctDisplay}<span className="text-gray-400 dark:text-gray-600">%</span>
          </span>
        ) : (
          <span className="text-xs font-telin text-gray-500 dark:text-gray-600">—</span>
        )}
      </div>

      <div className="hidden sm:block min-w-0 overflow-hidden">
        {isOnline && thermalStr ? (
          <span
            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 dark:bg-gray-700 ${thermalCls} whitespace-nowrap`}
            title="Hardware thermal state. Serious or Critical means active clock throttling is underway."
          >
            {thermalStr}
          </span>
        ) : (
          <span className="text-xs font-telin text-gray-500 dark:text-gray-600">—</span>
        )}
      </div>

      <div className="flex justify-end">
        <ChevronDown className={`w-3 h-3 text-gray-600 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </div>
    </div>

    {expanded && isOnline && m && (() => {
      const isVllm  = m.vllm_running === true;
      const isOllama = m.ollama_running === true;
      const hasProxy = m.ollama_proxy_active === true;
      const ttftSource = m.vllm_avg_ttft_ms != null ? 'vllm' : m.ollama_proxy_avg_ttft_ms != null ? 'proxy' : m.ollama_ttft_ms != null ? 'probe' : null;

      const runtimeLabel = isOllama && isVllm ? 'Ollama + vLLM'
        : isOllama ? 'Ollama'
        : isVllm   ? 'vLLM'
        : m.inference_state != null ? 'llama.cpp'
        : 'None detected';

      return (
        <div className="px-6 py-3 bg-gray-900/40 border-b border-gray-700/60">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-x-6 gap-y-2 text-xs">
            <DetailCell label="Runtime" value={runtimeLabel}
              tooltip="Inference runtime detected on this node. Wicklee supports Ollama, vLLM, and llama.cpp — a node can run more than one simultaneously." />
            <DetailCell label="Agent" value={m.agent_version ?? null}
              tooltip="Wicklee agent version running on this node. If behind fleet majority, the Agent Version Mismatch observation will fire." />

            {m.runtime_config_available === true
              && (!m.active_models || m.active_models.length <= 1)
              && (m.ollama_active_model || m.vllm_model_name)
              && (
              <div className="flex flex-col">
                <span className="text-[10px] uppercase tracking-widest text-gray-500 mb-0.5">Config</span>
                <button
                  onClick={() => onOpenConfig?.(m.ollama_active_model ?? m.vllm_model_name ?? '')}
                  className="self-start px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 transition-colors"
                >
                  View →
                </button>
              </div>
            )}

            <DetailCell label="TTFT" value={m.vllm_avg_ttft_ms ?? m.ollama_proxy_avg_ttft_ms ?? m.ollama_ttft_ms} unit="ms" source={ttftSource}
              tooltip="Time To First Token — latency from request arrival to first generated token. Source: vLLM histogram (production), proxy rolling avg (production), or Ollama probe (synthetic 20-token baseline every ~30s). Lower is more responsive." />
            <DetailCell label="Thermal Source" value={m.thermal_source}
              tooltip="How Wicklee detects thermal state on this node. nvml = NVIDIA hardware bitmask, iokit = macOS pmset, coretemp = Intel hwmon, clock_ratio = CPU frequency scaling, sysfs = Linux thermal zone, wmi = Windows WMI." />
            <DetailCell label="Swap Write" value={m.swap_write_mb_s} unit="MB/s"
              tooltip="Swap write rate — data being written to disk swap. > 2 MB/s sustained means model layers are spilling from RAM to disk, degrading inference throughput. 0 is ideal." />

            {isOllama && <DetailCell label="Load Duration" value={m.ollama_load_duration_ms} unit="ms"
              tooltip="Time Ollama spent loading the model into memory on the last probe request. High values (> 1000ms) indicate cold starts or model swaps. Once loaded, subsequent requests show near-zero." />}
            {isOllama && <DetailCell label="Prefill Speed" value={m.ollama_prompt_eval_tps} unit="tok/s"
              tooltip="Prompt processing speed — how fast Ollama evaluates the input prompt before generating output. Measured from the 20-token probe's prompt_eval_duration. Higher is better; depends on prompt length and model size." />}

            {isVllm && <DetailCell label="E2E Latency" value={m.vllm_avg_e2e_latency_ms} unit="ms"
              tooltip="Average end-to-end request latency from vLLM's Prometheus histogram. Includes queue wait + prefill + generation. Real production data from actual requests, not synthetic." />}
            {isVllm && <DetailCell label="Queue Time" value={m.vllm_avg_queue_time_ms} unit="ms"
              tooltip="Average time requests spend waiting in vLLM's scheduler queue before processing begins. High values indicate the engine is saturated — consider reducing max_num_seqs or scaling horizontally." />}
            {isVllm && <DetailCell label="Queue Depth" value={m.vllm_requests_waiting} unit="req"
              tooltip="Number of requests currently waiting in vLLM's scheduler queue. 0 = no backlog. > 5 sustained = engine can't keep up with incoming traffic. Pattern R fires at this threshold." />}
            {isVllm && <DetailCell label="Running" value={m.vllm_requests_running} unit="req"
              tooltip="Number of requests currently being processed by vLLM. This is active inference — each running request consumes KV cache and GPU compute." />}
            {isVllm && <DetailCell label="KV Cache" value={m.vllm_cache_usage_perc} unit="%"
              tooltip="vLLM KV cache utilization — the percentage of GPU memory reserved for attention key-value pairs that is currently in use. > 90% means the scheduler can't admit new sequences. Pattern M fires at this threshold." />}

            {hasProxy && <DetailCell label="E2E Latency" value={m.ollama_proxy_avg_latency_ms} unit="ms"
              tooltip="Average end-to-end latency from Wicklee proxy done packets. Measures total_duration from actual user requests flowing through the proxy. Real production data." />}
            {hasProxy && <DetailCell label="Proxy Requests" value={m.ollama_proxy_request_count} unit="total"
              tooltip="Total number of inference requests that have flowed through the Wicklee transparent proxy since agent startup. Resets on agent restart." />}
            {hasProxy && m.proxy_listen_port && m.proxy_target_port && (
              <DetailCell label="Proxy Ports" value={`:${m.proxy_listen_port} → :${m.proxy_target_port}`}
                tooltip={`Proxy listens on :${m.proxy_listen_port} (Ollama default) and forwards to :${m.proxy_target_port} (real Ollama). Clients connect to :${m.proxy_listen_port} with no config changes.`} />
            )}

            {m.clock_throttle_pct != null && <DetailCell label="Clock Throttle" value={m.clock_throttle_pct} unit="%"
              tooltip="Percentage of clock speed reduction from maximum. 0% = running at full speed. > 15% during active inference with Normal thermal state suggests a power cap or driver limit, not heat (Pattern K)." />}
          </div>

          {m.active_models && m.active_models.length > 1 && (() => {
            const totalVramBudget = m.nvidia_vram_total_mb ?? m.gpu_wired_limit_mb ?? 0;
            const usedVram = m.active_models!.reduce((s, am) => s + (am.vram_mb ?? 0), 0);
            const VRAM_COLORS = ['bg-cyan-500', 'bg-indigo-500', 'bg-amber-500', 'bg-emerald-500', 'bg-rose-500', 'bg-violet-500'];
            return (
            <div className="mt-3 pt-3 border-t border-gray-700/40">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1.5">
                Active Models ({m.active_models!.length})
              </p>
              <div className="space-y-1">
                {m.active_models!.map(am => (
                  <div key={am.model} className="flex items-center gap-3 text-xs">
                    <span className="text-gray-300 font-mono truncate min-w-0 flex-1">{am.model}</span>
                    {am.tok_s != null && <span className="text-emerald-400 font-mono tabular-nums whitespace-nowrap">{am.tok_s.toFixed(1)} tok/s</span>}
                    {am.wes != null && <span className={`font-mono tabular-nums whitespace-nowrap ${wesColorClass(am.wes)}`}>{am.wes.toFixed(1)} WES</span>}
                    {am.vram_mb != null && <span className="text-gray-500 font-mono tabular-nums whitespace-nowrap">{(am.vram_mb / 1024).toFixed(1)}G</span>}
                    {am.request_count > 0 && <span className="text-gray-600 tabular-nums whitespace-nowrap">{am.request_count} req</span>}
                    {m.runtime_config_available === true && (
                      <button
                        onClick={() => onOpenConfig?.(am.model)}
                        className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 transition-colors whitespace-nowrap"
                      >
                        Config
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {totalVramBudget > 0 && (
                <div className="mt-3">
                  <div className="flex items-center justify-between text-[10px] text-gray-500 mb-1">
                    <span>VRAM Budget</span>
                    <span className="font-mono tabular-nums">{(usedVram / 1024).toFixed(1)}G / {(totalVramBudget / 1024).toFixed(0)}G ({totalVramBudget > 0 ? Math.round(usedVram / totalVramBudget * 100) : 0}%)</span>
                  </div>
                  <div className="h-2.5 bg-gray-700 rounded-full overflow-hidden flex">
                    {m.active_models!.map((am, i) => {
                      const pct = am.vram_mb ? (am.vram_mb / totalVramBudget * 100) : 0;
                      return pct > 0 ? (
                        <div key={am.model} className={`${VRAM_COLORS[i % VRAM_COLORS.length]} opacity-80`} style={{ width: `${pct}%` }}
                          title={`${am.model}: ${(am.vram_mb! / 1024).toFixed(1)}G (${Math.round(pct)}%)`} />
                      ) : null;
                    })}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5">
                    {m.active_models!.map((am, i) => (
                      <div key={am.model} className="flex items-center gap-1.5 text-[10px] text-gray-500">
                        <div className={`w-2 h-2 rounded-sm ${VRAM_COLORS[i % VRAM_COLORS.length]} opacity-80`} />
                        <span className="font-mono truncate">{am.model.split(':')[0]}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            );
          })()}
        </div>
      );
    })()}
    </>
  );
};

/** Compact metric cell for the expanded detail panel. */
const DetailCell: React.FC<{
  label: string;
  value: number | string | null | undefined;
  unit?: string;
  source?: string;
  tooltip?: string;
}> = ({ label, value, unit, source, tooltip }) => {
  const [showTip, setShowTip] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleEnter = () => { if (tooltip && window.matchMedia('(hover: hover)').matches) timerRef.current = setTimeout(() => setShowTip(true), 400); };
  const handleLeave = () => { if (timerRef.current) clearTimeout(timerRef.current); setShowTip(false); };
  return (
  <div className="flex flex-col relative" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
    <span className="text-[9px] text-gray-600 uppercase tracking-wider">{label}</span>
    {showTip && tooltip && (
      <div className="absolute bottom-full left-0 mb-1.5 z-50 w-56 bg-gray-800 border border-gray-700/50 rounded-xl shadow-2xl shadow-black/50 p-3 pointer-events-none">
        <p className="text-xs font-semibold text-gray-100 leading-snug mb-1">{label}</p>
        <p className="text-[11px] text-gray-400 leading-snug">{tooltip}</p>
      </div>
    )}
    <div className="flex items-baseline gap-1">
      {value != null ? (
        <>
          <span className="text-xs font-telin text-gray-300">
            {typeof value === 'number' ? (value < 1 && value > 0 ? value.toFixed(2) : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : Number.isInteger(value) ? value : value.toFixed(1)) : value}
          </span>
          {unit && <span className="text-[9px] text-gray-600">{unit}</span>}
          {source && <span className="text-[8px] text-gray-700 font-mono">{source}</span>}
        </>
      ) : (
        <span className="text-[10px] text-gray-700">—</span>
      )}
    </div>
  </div>
  );
};

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

const FleetCard: React.FC<{
  label: React.ReactNode;
  children: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
}> = ({ label, children, sub, className = '' }) => (
  <div className={`bg-gray-700/50 border border-gray-700/40 rounded-xl p-4 flex flex-col gap-2 ${className}`}>
    <div className="text-[9px] font-semibold uppercase tracking-widest text-gray-500 leading-none">{label}</div>
    <div className="flex-1">{children}</div>
    {sub && <div className="mt-auto">{sub}</div>}
  </div>
);

const EmptyFleetState: React.FC<{ onAddNode?: () => void }> = ({ onAddNode }) => (
  <div className="flex flex-col items-center justify-center py-24 text-center space-y-10 animate-in fade-in duration-500">
    <div className="space-y-3 max-w-sm">
      <h2 className="text-2xl font-bold text-white">Add your first node</h2>
      <p className="text-sm text-gray-500">Install the Wicklee agent on any machine, generate a pairing code, then enter it below.</p>
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full max-w-2xl text-left">
      {[
        {
          step: '1', icon: Download, title: 'Install the agent',
          body: (
            <code className="block mt-2 text-[11px] font-mono bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-blue-300 whitespace-pre-wrap break-all">
              curl -fsSL https://wicklee.dev/install.sh | bash
            </code>
          ),
        },
        {
          step: '2', icon: Terminal, title: 'Open your local dashboard',
          body: <p className="mt-2 text-xs text-gray-500">Visit <span className="text-gray-300 font-mono">localhost:7700</span> on the machine where you installed the agent. Click <span className="text-gray-300">"Connect to Cloud"</span> to generate a 6-digit code.</p>,
        },
        {
          step: '3', icon: Plus, title: 'Enter the code here',
          body: <p className="mt-2 text-xs text-gray-500">Click <span className="text-gray-300">"+ Add Node"</span> below and enter the 6-digit code.</p>,
        },
      ].map(({ step, icon: Icon, title, body }) => (
        <div key={step} className="bg-gray-800 border border-gray-700 rounded-2xl p-5 space-y-1">
          <div className="flex items-center gap-2 mb-2">
            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-600/20 border border-blue-500/30 text-[11px] font-bold text-blue-400">{step}</span>
            <Icon className="w-4 h-4 text-gray-500" />
          </div>
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          {body}
        </div>
      ))}
    </div>
    <button
      onClick={onAddNode}
      className="flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl transition-all shadow-lg shadow-blue-500/20"
    >
      <Plus className="w-4 h-4" />
      Add Node
    </button>
  </div>
);

interface RailRowProps {
  label:     string;
  value:     string;
  pct?:      number | null;
  textCls:   string;
  barCls:    string;
  badge?:    string;
  badgeCls?: string;
  tooltip?:  string;
}
const RailRow: React.FC<RailRowProps> = ({ label, value, pct, textCls, barCls, badge, badgeCls, tooltip }) => {
  const [showTip, setShowTip] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleEnter = () => { if (tooltip && window.matchMedia('(hover: hover)').matches) timerRef.current = setTimeout(() => setShowTip(true), 400); };
  const handleLeave = () => { if (timerRef.current) clearTimeout(timerRef.current); setShowTip(false); };
  return (
  <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-100 dark:border-gray-700 last:border-0 relative" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
    {showTip && tooltip && (
      <div className="absolute bottom-full left-5 mb-1.5 z-50 w-60 bg-gray-800 border border-gray-700/50 rounded-xl shadow-2xl shadow-black/50 p-3 pointer-events-none">
        <p className="text-xs font-semibold text-gray-100 leading-snug mb-1">{label}</p>
        <p className="text-[11px] text-gray-400 leading-snug">{tooltip}</p>
      </div>
    )}
    <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 w-28 shrink-0">{label}</p>
    <div className="flex items-center gap-1.5 w-20 shrink-0">
      <p className={`text-sm font-telin font-bold whitespace-nowrap ${textCls}`}>{value}</p>
      {badge && (
        <span className={`text-[8px] font-semibold uppercase tracking-widest leading-none ${badgeCls}`}>
          {badge}
        </span>
      )}
    </div>
    {pct != null && (
      <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div
          className={`h-full ${barCls} rounded-full transition-all duration-100`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    )}
  </div>
  );
};

const DiagnosticRail: React.FC<{
  sentinel: SentinelMetrics | null;
  transport: 'ws' | 'sse' | null;
  peakTps?: number;
}> = ({ sentinel: s, transport, peakTps }) => {
  const cpuBuf   = useRollingBuffer();
  const gpuBuf   = useRollingBuffer();
  const memBuf   = useRollingBuffer();
  const powerBuf = useRollingBuffer();
  const swapBuf  = useRollingBuffer();
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

  const powerRaw = getNodePowerW(s) ?? 0;
  const powerW   = powerBuf.push(powerRaw, tsMs) ?? powerRaw;
  const hasPow   = hasPowerData(s);

  const rawOllamaTps    = s.ollama_tokens_per_second ?? null;
  const rawVllmTps      = s.vllm_tokens_per_sec ?? null;
  const rawTps          = rawOllamaTps != null && rawVllmTps != null ? rawOllamaTps + rawVllmTps
                        : (rawOllamaTps ?? rawVllmTps);
  const inferenceActive = s.ollama_inference_active ?? null;
  const smoothedTps     = tpsBuf.push(rawTps, tsMs) ?? rawTps;
  const inferenceActiveForEst = (s.inference_state === 'live' || s.inference_state === 'idle-spd')
    ? true
    : inferenceActive;
  const tps             = estimateTps(smoothedTps, peakTps ?? null, gpuPct, inferenceActiveForEst);

  const isProbing    = s.ollama_is_probing === true;
  const hasState     = s.inference_state != null;
  const isInferring  = hasState
    ? s.inference_state === 'live'
    : tps != null && !isProbing && (
        inferenceActive === true ||
        (s.vllm_running === true && (s.vllm_requests_running ?? 0) > 0)
      );
  const isEstimated  = smoothedTps == null && tps != null;
  const isBusy       = hasState
    ? s.inference_state === 'busy'
    : !isProbing && !isInferring && inferenceActive === false && (gpuPct ?? 0) >= GPU_BUSY_THRESHOLD;
  const isIdleSpeed  = hasState
    ? s.inference_state === 'idle-spd'
    : !isInferring && !isBusy && smoothedTps != null;
  const hasTps       = s.ollama_running || s.vllm_running;

  const utilCls = (pct: number) =>
    pct > 90 ? { text: 'text-red-400', bar: 'bg-red-400' } :
    pct > 70 ? { text: 'text-amber-400', bar: 'bg-amber-400' } :
               { text: 'text-green-400', bar: 'bg-green-400' };

  const cpu = utilCls(cpuPct);

  const items: React.ReactNode[] = [];

  items.push(<RailRow key="cpu" label="CPU Usage" value={`${cpuPct.toFixed(1)}%`} pct={cpuPct} textCls={cpu.text} barCls={cpu.bar} />);

  if (gpuPct != null) {
    const g = utilCls(gpuPct);
    items.push(<RailRow key="gpu" label="GPU Utilization" value={`${gpuPct.toFixed(1)}%`} pct={gpuPct} textCls={g.text} barCls={g.bar} />);
  }

  if (hasTps) {
    if (isInferring) {
      items.push(<RailRow key="tps" label="Tok/s" value={tps != null ? (isEstimated ? `~${tps.toFixed(1)}` : tps.toFixed(1)) : '—'} textCls="text-green-400" barCls="bg-green-400" badge="live" badgeCls="text-green-500" />);
    } else if (isBusy) {
      items.push(<RailRow key="tps" label="Tok/s" value={tps != null ? tps.toFixed(1) : '—'} textCls="text-amber-500" barCls="bg-amber-500" badge="busy" badgeCls="text-amber-500" />);
    } else if (isIdleSpeed) {
      items.push(<RailRow key="tps" label="Tok/s" value={tps?.toFixed(1) ?? '—'} textCls="text-gray-400 dark:text-gray-500" barCls="bg-gray-500" badge="idle-spd" badgeCls="text-gray-600" />);
    } else {
      items.push(<RailRow key="tps" label="Tok/s" value="—" textCls="text-gray-600" barCls="bg-gray-700" />);
    }
  }

  if (memPct != null) {
    const m = utilCls(memPct);
    items.push(<RailRow key="mem" label="Memory Pressure" value={`${memPct.toFixed(1)}%`} pct={memPct} textCls={m.text} barCls={m.bar} />);
  }

  if (hasPow) {
    items.push(<RailRow key="pow" label="Board Power" value={`${powerW.toFixed(1)} W`} textCls="text-amber-400" barCls="bg-amber-400" />);
  }

  {
    const ttft = s.vllm_avg_ttft_ms ?? s.ollama_proxy_avg_ttft_ms ?? s.ollama_ttft_ms ?? null;
    if (ttft != null) {
      const cls = ttft < 100 ? 'text-emerald-400' : ttft < 500 ? 'text-yellow-400' : 'text-red-400';
      const src = s.vllm_avg_ttft_ms != null ? 'vllm' : s.ollama_proxy_avg_ttft_ms != null ? 'proxy' : 'probe';
      items.push(<RailRow key="ttft" label="TTFT" value={ttft < 1000 ? `${Math.round(ttft)}ms` : `${(ttft / 1000).toFixed(1)}s`} textCls={cls} barCls="bg-transparent" badge={src} badgeCls="text-gray-600" tooltip="Time To First Token — latency from request to first generated token." />);
    }
  }

  if (s.thermal_state != null) {
    const state = s.thermal_state;
    const cls = state === 'Critical' ? 'text-red-400' : state === 'Serious' ? 'text-red-400' : state === 'Fair' ? 'text-amber-400' : 'text-green-400';
    const penalty = s.penalty_avg != null && s.penalty_avg > 1.0 ? `${s.penalty_avg.toFixed(2)}×` : undefined;
    items.push(<RailRow key="therm" label="Thermal" value={state} textCls={cls} barCls="bg-transparent" badge={penalty} badgeCls={state === 'Normal' ? 'text-gray-600' : cls} />);
  }

  {
    const lat = s.vllm_avg_e2e_latency_ms ?? s.ollama_proxy_avg_latency_ms ?? null;
    if (lat != null) {
      const cls = lat < 500 ? 'text-emerald-400' : lat < 2000 ? 'text-yellow-400' : 'text-red-400';
      items.push(<RailRow key="lat" label="E2E Latency" value={lat < 1000 ? `${Math.round(lat)}ms` : `${(lat / 1000).toFixed(1)}s`} textCls={cls} barCls="bg-transparent" tooltip="Average end-to-end request latency." />);
    }
  }

  if (s.swap_write_mb_s != null) {
    const raw = swapBuf.push(s.swap_write_mb_s, tsMs) ?? s.swap_write_mb_s;
    const pct = Math.min((raw / 500) * 100, 100);
    const cls = raw > 10 ? { text: 'text-amber-400', bar: 'bg-amber-400' } : { text: 'text-green-400', bar: 'bg-green-400' };
    items.push(<RailRow key="swap" label="Swap Write" value={`${raw.toFixed(1)} MB/s`} pct={pct > 0 ? pct : undefined} textCls={cls.text} barCls={cls.bar} />);
  }

  if (s.ollama_load_duration_ms != null) {
    items.push(<RailRow key="load" label="Load Duration" value={s.ollama_load_duration_ms < 1000 ? `${Math.round(s.ollama_load_duration_ms)}ms` : `${(s.ollama_load_duration_ms / 1000).toFixed(1)}s`} textCls={s.ollama_load_duration_ms < 500 ? 'text-emerald-400' : s.ollama_load_duration_ms < 2000 ? 'text-yellow-400' : 'text-red-400'} barCls="bg-transparent" tooltip="Time Ollama spent loading the model into memory." />);
  }

  if (s.ollama_prompt_eval_tps != null) {
    items.push(<RailRow key="prefill" label="Prefill Speed" value={`${s.ollama_prompt_eval_tps.toFixed(1)} tok/s`} textCls="text-blue-400" barCls="bg-transparent" tooltip="Prompt processing speed." />);
  }

  if (s.clock_throttle_pct != null) {
    const pct = Math.min(s.clock_throttle_pct, 100);
    const cls = pct > 50 ? { text: 'text-red-400', bar: 'bg-red-400' } : pct > 20 ? { text: 'text-amber-400', bar: 'bg-amber-400' } : { text: 'text-gray-400', bar: 'bg-gray-500' };
    items.push(<RailRow key="clk" label="Clk Throttle" value={`${pct.toFixed(0)}%`} pct={pct} textCls={cls.text} barCls={cls.bar} />);
  }

  if (s.vllm_running && s.vllm_requests_waiting != null && s.vllm_requests_waiting > 0) {
    items.push(<RailRow key="queue" label="Queue Depth" value={`${s.vllm_requests_waiting}`} textCls={s.vllm_requests_waiting > 10 ? 'text-red-400' : s.vllm_requests_waiting > 3 ? 'text-amber-400' : 'text-green-400'} barCls="bg-transparent" badge="waiting" badgeCls="text-gray-600" />);
  }

  if (s.vllm_running && s.vllm_cache_usage_perc != null) {
    items.push(<RailRow key="kv" label="KV Cache" value={`${s.vllm_cache_usage_perc.toFixed(1)}%`} pct={s.vllm_cache_usage_perc} textCls={s.vllm_cache_usage_perc > 90 ? 'text-red-400' : s.vllm_cache_usage_perc > 70 ? 'text-amber-400' : 'text-green-400'} barCls={s.vllm_cache_usage_perc > 90 ? 'bg-red-400' : s.vllm_cache_usage_perc > 70 ? 'bg-amber-400' : 'bg-green-400'} />);
  }

  if (s.vllm_running && s.vllm_requests_running != null && s.vllm_requests_running > 0) {
    items.push(<RailRow key="running" label="Running" value={`${s.vllm_requests_running} req`} textCls="text-green-400" barCls="bg-transparent" />);
  }

  const mid = Math.ceil(items.length / 2);
  const col1 = items.slice(0, mid);
  const col2 = items.slice(mid);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
      <div>{col1}</div>
      <div>{col2}</div>
    </div>
  );
};

const Overview: React.FC<OverviewProps> = ({ nodes, nodesLoading = false, pairingInfo, onOpenPairing, onAddNode, onUpgrade, getNodeSettings, fleetKwhRate = ELECTRICITY_RATE_USD_PER_KWH, onNavigateToObservability, onNavigateToInsights }) => {
  const {
    allNodeMetrics: cloudMetrics,
    lastSeenMsMap: cloudLastSeen,
    peakTpsMap,
    fleetEvents,
    connected: cloudConnected,
    transport: cloudTransport,
  } = useFleetStream();

  const [sentinel, setSentinel] = useState<SentinelMetrics | null>(null);
  const [runtimeConfigModel, setRuntimeConfigModel] = useState<string | null>(null);
  const { connected: localConnected, transport: localTransport } =
    useLocalMetricsStream(data => handleMetrics(data));

  type MetricKey = 'gpu' | 'cpu' | 'mem' | 'power' | 'tps';
  interface HistoryPoint { time: string; gpu: number | null; cpu: number; mem: number | null; power: number | null; tps: number | null; }
  const [history, setHistory]           = useState<HistoryPoint[]>([]);
  const [selectedMetric, setSelectedMetric] = useState<MetricKey>('gpu');
  const MAX_HISTORY = 3600;

  const [metricOpen, setMetricOpen] = useState(false);
  const metricDropdownRef = useRef<HTMLDivElement>(null);
  const [showActiveOnly, setShowActiveOnly] = useState(false);

  interface CostByModelEntry { model: string | null; hours_active: number | null; avg_watts: number | null; cost_usd: number | null; tok_s_avg: number | null; sample_count: number }
  const [costByModel, setCostByModel] = useState<CostByModelEntry[]>([]);
  const [costByModelTotal, setCostByModelTotal] = useState(0);
  const [costByModelOpen, setCostByModelOpen] = useState(false);
  useEffect(() => {
    if (!isLocalMode) return;
    const fetchCost = async () => {
      try {
        const res = await fetch('/api/cost-by-model?hours=24');
        if (!res.ok) return;
        const data = await res.json();
        setCostByModel(data.models ?? []);
        setCostByModelTotal(data.total_cost_usd ?? 0);
      } catch { }
    };
    fetchCost();
    const id = setInterval(fetchCost, 60_000);
    return () => clearInterval(id);
  }, []);

  const localPeakTpsRef   = useRef<number | null>(null);
  const localPeakModelRef = useRef<string | null>(null);

  const fleetTpsBuf     = useRollingBuffer(FLEET_ROLLING_WINDOW);
  const wattPer1kBuf    = useRollingBuffer(4);
  const fleetWesBuf     = useRollingBuffer(FLEET_ROLLING_WINDOW);
  const fleetTokWBuf    = useRollingBuffer(FLEET_ROLLING_WINDOW);
  const costPer1kNewBuf = useRollingBuffer(FLEET_ROLLING_WINDOW);

  const nodeCostBufsRef = useRef<Map<string, { buf: number[]; lastTs: number }>>(new Map());

  const connected = isLocalHost ? localConnected : cloudConnected;
  const transport = isLocalHost ? localTransport : cloudTransport;

  const localEvents = useLocalEvents(
    isLocalHost ? sentinel : null,
    isLocalHost ? localConnected : false,
  );

  const activeEvents = isLocalHost
    ? [...localEvents, ...fleetEvents].slice(0, 50)
    : fleetEvents;

  const pushHistoryPoint = useCallback((data: SentinelMetrics) => {
    setHistory(prev => {
      const ts  = new Date(data.timestamp_ms);
      const lbl = `${ts.getHours().toString().padStart(2, '0')}:${ts.getMinutes().toString().padStart(2, '0')}:${ts.getSeconds().toString().padStart(2, '0')}`;
      const pt: HistoryPoint = {
        time:  lbl,
        gpu:   data.nvidia_gpu_utilization_percent ?? data.gpu_utilization_percent ?? null,
        cpu:   data.cpu_usage_percent,
        mem:   data.memory_pressure_percent ??
               (data.total_memory_mb > 0 ? (data.used_memory_mb / data.total_memory_mb) * 100 : null),
        power: getNodePowerW(data),
        tps:   data.ollama_tokens_per_second ?? data.vllm_tokens_per_sec ?? data.llamacpp_tokens_per_sec ?? null,
      };
      const next = [...prev, pt];
      return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
    });
  }, []);

  const handleMetrics = useCallback((data: SentinelMetrics) => {
    setSentinel(data);
    pushHistoryPoint(data);

    const rawTps   = data.ollama_tokens_per_second ?? data.vllm_tokens_per_sec ?? null;
    const curModel = data.ollama_active_model ?? data.vllm_model_name ?? null;
    if (localPeakModelRef.current !== curModel) {
      localPeakTpsRef.current = null;
    }
    localPeakModelRef.current = curModel;
    if (rawTps != null && rawTps > 0 && rawTps > (localPeakTpsRef.current ?? 0)) {
      localPeakTpsRef.current = rawTps;
    }
  }, [pushHistoryPoint]);


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

    const gpuVals = all
      .map(m => m.nvidia_gpu_utilization_percent ?? m.gpu_utilization_percent ?? null)
      .filter((v): v is number => v != null);
    const gpu = gpuVals.length > 0 ? gpuVals.reduce((a, b) => a + b, 0) / gpuVals.length : null;

    const cpu = all.reduce((a, m) => a + m.cpu_usage_percent, 0) / all.length;

    const memVals = all
      .map(m => m.memory_pressure_percent ??
        (m.total_memory_mb > 0 ? (m.used_memory_mb / m.total_memory_mb) * 100 : null))
      .filter((v): v is number => v != null);
    const mem = memVals.length > 0 ? memVals.reduce((a, b) => a + b, 0) / memVals.length : null;

    const powerVals = all
      .map(m => getNodePowerW(m))
      .filter((v): v is number => v != null);
    const power = powerVals.length > 0 ? powerVals.reduce((a, b) => a + b, 0) : null;

    const tpsVals = all
      .map(m => m.ollama_tokens_per_second ?? m.vllm_tokens_per_sec ?? m.llamacpp_tokens_per_sec ?? null)
      .filter((v): v is number => v != null);
    const tps = tpsVals.length > 0 ? tpsVals.reduce((a, b) => a + b, 0) : null;

    setHistory(prev => {
      const pt: HistoryPoint = { time: lbl, gpu, cpu, mem, power, tps };
      const next = [...prev, pt];
      return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
    });
  }, [cloudMetrics]);

  useEffect(() => {
    if (!metricOpen) return;
    const handler = (e: MouseEvent) => {
      if (!metricDropdownRef.current?.contains(e.target as Node)) setMetricOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [metricOpen]);

  const allNodeMetrics = isLocalHost
    ? (sentinel ? { [sentinel.node_id ?? 'local']: sentinel } : {})
    : cloudMetrics;
  const lastSeenMsMap = cloudLastSeen;

  const counts = useFleetCounts(nodes);


  const liveNodeIdsKey = Object.keys(allNodeMetrics).sort().join(',');
  useEffect(() => {
    pruneBuffers(Object.keys(allNodeMetrics));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveNodeIdsKey]);

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

  const liveMetrics: SentinelMetrics[] = Object.values(allNodeMetrics);
  const restrictedIds = new Set(nodes.filter(n => n.restricted).map(n => n.id));
  const effectiveMetrics: SentinelMetrics[] = isLocalHost
    ? (sentinel ? [sentinel] : [])
    : liveMetrics.filter(m => !restrictedIds.has(m.node_id));

  const hasAnyOllama = effectiveMetrics.some(m => m.ollama_running);
  const hasAnyVllm   = effectiveMetrics.some(m => m.vllm_running);
  const tpsNodes     = effectiveMetrics.filter(m => {
    const hasRaw = (m.ollama_running && m.ollama_tokens_per_second != null) ||
                   (m.vllm_running   && m.vllm_tokens_per_sec      != null);
    if (hasRaw) return true;
    const peak = peakTpsMap[m.node_id] ?? null;
    const gpu  = m.nvidia_gpu_utilization_percent ?? m.gpu_utilization_percent ?? null;
    return peak != null && (gpu ?? 0) > 0;
  });
  const fleetTps     = tpsNodes.length > 0
    ? tpsNodes.reduce((acc, m) => {
        const rawCombined    = (m.ollama_tokens_per_second ?? 0) + (m.vllm_tokens_per_sec ?? 0) || null;
        const gpu            = m.nvidia_gpu_utilization_percent ?? m.gpu_utilization_percent ?? null;
        const infActiveForEst = (m.inference_state === 'live' || m.inference_state === 'idle-spd')
          ? true
          : (m.ollama_inference_active ?? null);
        return acc + (estimateTps(rawCombined, peakTpsMap[m.node_id] ?? null, gpu, infActiveForEst) ?? 0);
      }, 0)
    : null;

  const anyInferring = tpsNodes.some(m =>
    m.inference_state != null
      ? m.inference_state === 'live'
      : (m.ollama_inference_active === true && m.ollama_is_probing !== true) ||
        (m.vllm_running === true && (m.vllm_requests_running ?? 0) > 0)
  );

  const localGpuPct = sentinel
    ? (sentinel.nvidia_gpu_utilization_percent ?? sentinel.gpu_utilization_percent ?? null)
    : null;
  const localInferenceActive = sentinel?.ollama_inference_active ?? null;
  const localIsProbing    = sentinel?.ollama_is_probing === true;
  const localHasState     = sentinel?.inference_state != null;
  const localIsInferring  = localHasState
    ? sentinel!.inference_state === 'live'
    : sentinel != null && !localIsProbing && (
        localInferenceActive === true ||
        (sentinel.vllm_running === true && (sentinel.vllm_requests_running ?? 0) > 0)
      );
  const localIsBusy       = localHasState
    ? sentinel!.inference_state === 'busy'
    : sentinel != null && !localIsProbing && !localIsInferring &&
      localInferenceActive === false && (localGpuPct ?? 0) >= GPU_BUSY_THRESHOLD;
  const localIsIdleSpeed  = localHasState
    ? sentinel!.inference_state === 'idle-spd'
    : sentinel != null && !localIsInferring && !localIsBusy && (tpsNodes.length > 0);
  const localIsIdle       = localHasState
    ? sentinel!.inference_state === 'idle'
    : sentinel != null && !localIsInferring && !localIsBusy && !localIsIdleSpeed;

  const totalRegisteredNodes = isLocalHost
    ? (sentinel ? 1 : 0)
    : nodes.filter(n => !n.restricted).length;
  const fleetHealthPct = calculateFleetHealthPct(effectiveMetrics, totalRegisteredNodes);
  const fleetHealthCls = fleetHealthPct == null        ? 'text-gray-400 dark:text-gray-600'
    : fleetHealthPct === 100                           ? 'text-green-600 dark:text-green-400'
    : fleetHealthPct >= 75                             ? 'text-amber-600 dark:text-amber-500'
    :                                                    'text-red-600 dark:text-red-500';

  const totalVramMb         = calculateTotalVramMb(effectiveMetrics);
  const totalVramCapacityMb = calculateTotalVramCapacityMb(effectiveMetrics);
  const vramUtilPct         = totalVramCapacityMb > 0
    ? Math.round((totalVramMb / totalVramCapacityMb) * 100) : null;
  const vramUsedGB     = (totalVramMb / 1024).toFixed(1);
  const vramCapacityGB = (totalVramCapacityMb / 1024).toFixed(1);
  const vramSubHint = fleetVramSubtitle(effectiveMetrics);

  const localIsAppleSilicon = sentinel?.memory_pressure_percent != null;
  const localWiredLimitMb = (sentinel?.gpu_wired_limit_mb != null && sentinel.gpu_wired_limit_mb > 0)
    ? sentinel.gpu_wired_limit_mb
    : (localIsAppleSilicon && sentinel != null ? Math.round(sentinel.total_memory_mb * 0.75) : null);
  const localGpuAvailMb = (localWiredLimitMb != null && sentinel != null)
    ? Math.max(0, Math.min(localWiredLimitMb, sentinel.available_memory_mb))
    : null;
  const localGpuUsedGb = (localWiredLimitMb != null && localGpuAvailMb != null)
    ? ((localWiredLimitMb - localGpuAvailMb) / 1024).toFixed(1)
    : null;
  const localWiredLimitGb = localWiredLimitMb != null
    ? (localWiredLimitMb / 1024).toFixed(1)
    : null;

  const fleetMemPressure = (() => {
    let totalUsedMb = 0;
    let totalCapMb  = 0;
    for (const m of effectiveMetrics) {
      if (m.nvidia_vram_total_mb != null && m.nvidia_vram_total_mb > 0 && m.nvidia_vram_used_mb != null) {
        totalUsedMb += m.nvidia_vram_used_mb;
        totalCapMb  += m.nvidia_vram_total_mb;
      } else {
        totalUsedMb += m.total_memory_mb - m.available_memory_mb;
        totalCapMb  += m.total_memory_mb;
      }
    }
    return totalCapMb > 0 ? Math.round((totalUsedMb / totalCapMb) * 100) : null;
  })();

  const displayMemPressure = (isLocalMode && sentinel?.memory_pressure_percent != null)
    ? Math.round(sentinel.memory_pressure_percent)
    : fleetMemPressure;

  interface WESEntry { nodeId: string; hostname: string; activeModel: string | null; wes: number | null; rawWes: number | null; tcPct: number; tps: number | null; watts: number | null; thermalState: string | null; thermalSource: string | null; nullReason: string; costPer1mRaw: number | null; kwhRate: number; }
  const wesEntries: WESEntry[] = effectiveMetrics.map(m => {
    const _ollamaTps = m.ollama_tokens_per_second ?? null;
    const _vllmTps   = m.vllm_tokens_per_sec ?? null;
    const rawCombined = _ollamaTps != null && _vllmTps != null ? _ollamaTps + _vllmTps
                      : (_ollamaTps ?? _vllmTps);
    const gpuUtil = m.nvidia_gpu_utilization_percent ?? m.gpu_utilization_percent ?? null;
    const tps     = estimateTps(rawCombined, peakTpsMap[m.node_id] ?? null, gpuUtil, m.ollama_inference_active ?? null);
    const hasWatts = hasPowerData(m);
    const watts    = getNodePowerW(m);
    const ns       = getNodeSettings?.(m.node_id);
    const pue      = ns?.pue ?? 1.0;
    const kwhRate  = ns?.kwhRate ?? fleetKwhRate;
    const wes      = computeWES(tps, watts, m.thermal_state, pue);
    const rawWes   = computeRawWES(tps, watts, pue);
    const tcPct    = thermalCostPct(rawWes, wes);
    const nullReason = tps == null || tps <= 0 ? 'no inference' : !hasWatts ? 'no power data' : '';
    const costPer1mRaw = (tps != null && tps > 0 && watts != null)
      ? ((watts * pue * kwhRate) / (tps * 3.6))
      : null;
    const displayName   = ns?.locationLabel || m.hostname || m.node_id;
    const rawModel      = m.ollama_active_model ?? m.vllm_model_name ?? null;
    const activeModel   = rawModel ? (rawModel.split('/').pop() ?? rawModel) : null;
    return { nodeId: m.node_id, hostname: displayName, activeModel, wes, rawWes, tcPct, tps, watts, thermalState: m.thermal_state, thermalSource: m.thermal_source ?? null, nullReason, costPer1mRaw, kwhRate };
  });
  const sortedWES  = [...wesEntries].sort((a, b) => {
    if (a.wes != null && b.wes != null) return b.wes - a.wes;
    if (a.wes != null) return -1;
    if (b.wes != null) return 1;
    return 0;
  });
  const rankedWES    = sortedWES.filter(e => e.wes != null);
  const fleetAvgWES  = rankedWES.length > 0
    ? rankedWES.reduce((acc, e) => acc + e.wes!, 0) / rankedWES.length : null;
  const rankedTokW     = sortedWES.filter(e => e.rawWes != null);
  const fleetAvgTokW   = rankedTokW.length > 0
    ? rankedTokW.reduce((acc, e) => acc + e.rawWes!, 0) / rankedTokW.length : null;

  const wesNullSub = wesEntries.some(e => e.nullReason === 'no power data')
    ? 'no power data — run the agent as a service'
    : wesEntries.length > 0 ? 'no active inference' : 'connect runtime';

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

  const thermalCounts: Record<string, number> = {};
  effectiveMetrics.forEach(m => {
    const state = m.thermal_state ?? derivedNvidiaThermal(m.nvidia_gpu_temp_c ?? null)?.label ?? null;
    if (state) thermalCounts[state] = (thermalCounts[state] ?? 0) + 1;
  });
  const allNormal      = effectiveMetrics.length > 0 && Object.keys(thermalCounts).every(s => ['normal', 'nominal'].includes(s.toLowerCase()));

  const activeEntries    = wesEntries.filter(e => e.tps != null && e.tps > 0);
  const sortedByTps      = [...activeEntries].sort((a, b) => (b.tps ?? 0) - (a.tps ?? 0));
  const sortedByWes      = [...activeEntries].filter(e => e.wes != null).sort((a, b) => (b.wes ?? 0) - (a.wes ?? 0));
  const bestLatNode      = sortedByTps[0] ?? null;
  const bestEffNode      = sortedByWes[0] ?? null;
  const activeCostEntries = costEntries.filter(e => e.tps != null && e.tps > 0 && e.costPer1m != null);
  const sortedByCost      = [...activeCostEntries].sort((a, b) => (a.costPer1m ?? Infinity) - (b.costPer1m ?? Infinity));
  const bestCostNode      = sortedByCost[0] ?? null;
  const sameNode          = bestLatNode != null && bestEffNode != null && bestLatNode.nodeId === bestEffNode.nodeId;
  const tpsDelta          = !sameNode && bestLatNode && bestEffNode && (bestEffNode.tps ?? 0) > 0
    ? (bestLatNode.tps ?? 0) / bestEffNode.tps! : null;
  const wesDelta          = !sameNode && bestEffNode?.wes != null && (bestLatNode?.wes ?? 0) > 0
    ? bestEffNode.wes / bestLatNode!.wes! : null;

  const _nowForReachability = Date.now();
  const reachableIdSet = new Set<string>(
    isLocalHost
      ? (sentinel != null ? [sentinel.node_id] : [])
      : Object.keys(lastSeenMsMap).filter(
          id => _nowForReachability - (lastSeenMsMap[id] ?? 0) <= NODE_REACHABLE_MS,
        ),
  );
  const wattPowerNodes = (fleetTps != null && fleetTps >= MIN_COST_TPS)
    ? tpsNodes.filter(m =>
        reachableIdSet.has(m.node_id) &&
        hasPowerData(m)
      )
    : [];
  const wattPer1k = (() => {
    if (fleetTps == null || fleetTps < MIN_COST_TPS) return null;
    if (wattPowerNodes.length === 0) return null;
    const totalPowerW = wattPowerNodes.reduce((acc, m) => {
      const ns = getNodeSettings?.(m.node_id);
      return acc + (getNodePowerW(m) ?? 0) + (ns?.systemIdleW ?? 0);
    }, 0);
    return (totalPowerW / fleetTps) * 1000;
  })();

  const fleetHourlyCostUsd = (() => {
    const powerNodes = tpsNodes.filter(m => hasPowerData(m));
    if (powerNodes.length === 0) return null;
    return powerNodes.reduce((acc, m) => {
      const ns   = getNodeSettings?.(m.node_id);
      const pue  = ns?.pue ?? 1.0;
      const rate = ns?.kwhRate ?? fleetKwhRate;
      const watts = (getNodePowerW(m) ?? 0) + (ns?.systemIdleW ?? 0);
      return acc + watts * pue * rate / 1000;
    }, 0);
  })();
  const costPer1kTokensNew = (fleetTps != null && fleetTps >= MIN_COST_TPS)
    ? calculateCostPer1kTokens(fleetTps, fleetHourlyCostUsd)
    : null;

  const fleetTs = effectiveMetrics.length > 0
    ? Math.max(...effectiveMetrics.map(m => m.timestamp_ms))
    : 0;
  const displayFleetTps     = fleetTpsBuf.push(fleetTps,              fleetTs);
  const displayWattPer1k    = wattPer1kBuf.push(wattPer1k,            fleetTs);
  const displayFleetAvgWES  = fleetWesBuf.push(fleetAvgWES,           fleetTs);
  const displayFleetAvgTokW = fleetTokWBuf.push(fleetAvgTokW,         fleetTs);
  const displayCostPer1kNew = costPer1kNewBuf.push(costPer1kTokensNew, fleetTs);
  const sseNow = Date.now();

  const unreachableNodeIds = isLocalHost
    ? []
    : Object.keys(lastSeenMsMap).filter(id => sseNow - (lastSeenMsMap[id] ?? 0) > NODE_REACHABLE_MS);
  const reachableNodeIds = isLocalHost
    ? []
    : Object.keys(lastSeenMsMap).filter(id => sseNow - (lastSeenMsMap[id] ?? 0) <= NODE_REACHABLE_MS);
  const localNodeStale = isLocalHost && sentinel != null && sseNow - (sentinel.timestamp_ms ?? 0) > NODE_REACHABLE_MS;

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
    : isLocalHost
      ? `Live · ${localNodeId}`
      : 'Live · All nodes reporting';

  const sseTooltip = sseState === 'red'
    ? 'SSE stream disconnected · attempting to reconnect'
    : sseState === 'amber'
    ? isLocalHost
      ? `SSE connected · ${localNodeId} last seen ${fmtAgo(sentinel?.timestamp_ms ?? 0, { seconds: true })}`
      : `SSE connected · ${unreachableNodeIds.map(id => `${id} last seen ${fmtAgo(lastSeenMsMap[id], { seconds: true })}`).join(' · ')}`
    : isLocalHost
    ? `SSE connected · ${localNodeId} live`
    : `SSE connected · ${reachableNodeIds.join(' ')} all live`;

  const nodeRows: NodeRowProps[] = isLocalHost
    ? (sentinel ? [(() => {
        const ns = getNodeSettings?.(sentinel.node_id);
        return {
          nodeId: sentinel.node_id,
          hostname: ns?.locationLabel || sentinel.hostname || sentinel.node_id,
          metrics: sentinel,
          pue: ns?.pue ?? 1.0,
          peakTps: peakTpsMap[sentinel.node_id],
        };
      })()] : [])
    : nodes.map(n => {
        const ns = getNodeSettings?.(n.id);
        return {
          nodeId: n.id,
          hostname: ns?.locationLabel || n.hostname,
          metrics: allNodeMetrics[n.id] ?? null,
          lastSeenMs: lastSeenMsMap[n.id],
          pue: ns?.pue ?? 1.0,
          peakTps: peakTpsMap[n.id],
          restricted: n.restricted ?? false,
        };
      });

  const visibleRows = showActiveOnly
    ? nodeRows.filter(r => {
        const m = r.metrics;
        return m?.ollama_inference_active === true ||
               (m?.vllm_running === true && (m?.vllm_tokens_per_sec ?? 0) > 0);
      })
    : nodeRows;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">

        <InsightTile
          label={isLocalMode
            ? (localIsInferring || localIsBusy ? 'Throughput' : 'Capacity')
            : (anyInferring ? 'Throughput' : 'Capacity')}
          value={displayFleetTps != null ? `${displayFleetTps.toFixed(1)} tok/s` : '—'}
          valueCls={
            displayFleetTps == null
              ? 'text-gray-400 dark:text-gray-600'
              : isLocalMode
                ? localIsInferring
                  ? 'text-green-400'
                  : localIsBusy
                  ? 'text-amber-400'
                  : localIsIdleSpeed
                  ? 'text-slate-400'
                  : localIsIdle
                  ? 'text-gray-500 dark:text-gray-600'
                  : undefined
                : anyInferring
                  ? 'text-green-400'
                  : 'text-slate-400'
          }
          sub={fleetTps != null
            ? isLocalMode
              ? localIsInferring
                ? 'live · inferring'
                : localIsBusy
                ? 'busy · non-inference'
                : localIsProbing
                ? 'probing baseline'
                : localIsIdleSpeed
                ? 'capacity · probe baseline'
                : localIsIdle
                ? 'capacity · idle'
                : 'this node'
              : `${tpsNodes.length} node${tpsNodes.length !== 1 ? 's' : ''} · ${anyInferring ? 'live' : 'capacity · baseline'}`
            : (hasAnyOllama || hasAnyVllm) ? 'sampling every 30s' : 'no inference runtime'}
          icon={Activity}
          iconCls="text-indigo-400"
        />

        {isLocalMode ? (() => {
          const nodeWatts = sentinel?.apple_soc_power_w ?? sentinel?.nvidia_power_draw_w ?? sentinel?.cpu_power_w ?? null;
          const ns = getNodeSettings?.(sentinel?.node_id ?? '');
          const kwhRate = ns?.kwhRate ?? fleetKwhRate;
          const dailyCost = nodeWatts != null ? (nodeWatts * 24 / 1000) * kwhRate : null;
          return (
            <InsightTile
              label="Node Cost/Day"
              value={dailyCost != null ? (dailyCost < 0.01 ? '< $0.01' : `$${dailyCost.toFixed(2)}`) : '—'}
              valueCls={dailyCost == null ? 'text-gray-400 dark:text-gray-600' : dailyCost < 0.50 ? 'text-emerald-400' : dailyCost < 2.00 ? 'text-yellow-400' : 'text-red-400'}
              sub={nodeWatts != null ? `${nodeWatts.toFixed(1)}W · $${kwhRate}/kWh` : 'no power data'}
              icon={DollarSign}
              iconCls="text-emerald-400"
            />
          );
        })() : (
          <InsightTile
            label="Fleet Health"
            value={fleetHealthPct != null ? `${fleetHealthPct}%` : '—'}
            valueCls={fleetHealthCls}
            sub={(() => {
              if (fleetHealthPct == null) return 'no nodes';
              const reachable = effectiveMetrics.filter(m => m.thermal_state != null).length;
              const unreachable = totalRegisteredNodes - reachable;
              const thermalPart = allNormal
                ? 'All Normal thermal'
                : Object.entries(thermalCounts)
                    .map(([s, n]) => `${n} ${s.charAt(0).toUpperCase() + s.slice(1)}`)
                    .join(' · ');
              return unreachable > 0
                ? `${thermalPart} · ${unreachable} unreachable`
                : thermalPart;
            })()}
            icon={Thermometer}
            iconCls="text-amber-400"
          />
        )}

        <InsightTile
          label={isLocalMode ? 'Node VRAM' : 'Total Fleet VRAM'}
          value={
            isLocalMode && localIsAppleSilicon
              ? (localGpuUsedGb != null && localWiredLimitGb != null
                  ? `${localGpuUsedGb} / ${localWiredLimitGb} GB`
                  : localGpuUsedGb != null ? `${localGpuUsedGb} GB` : '—')
              : vramUtilPct != null
              ? `${vramUtilPct}%`
              : effectiveMetrics.length > 0
              ? `${vramUsedGB} GB`
              : '—'
          }
          valueCls={
            (isLocalMode && localIsAppleSilicon && localGpuUsedGb == null)
              || (!isLocalMode && vramUtilPct == null && effectiveMetrics.length === 0)
              ? 'text-gray-400 dark:text-gray-600'
              : undefined
          }
          sub={
            isLocalMode && localIsAppleSilicon
              ? (localGpuAvailMb != null
                  ? `${(localGpuAvailMb / 1024).toFixed(1)} GB free`
                  : undefined)
              : (vramUsedGB != null && vramCapacityGB != null && Number(vramCapacityGB) > 0)
              ? `${vramUsedGB} / ${vramCapacityGB} GB${vramSubHint ? ` · ${vramSubHint}` : ''}`
              : (effectiveMetrics.length > 0 && vramUsedGB != null)
              ? `${vramUsedGB} GB used${vramSubHint ? ` · ${vramSubHint}` : ''}`
              : undefined
          }
          icon={Database}
          iconCls="text-blue-400"
        />

        {(() => {
          const ttftValues = effectiveMetrics
            .map(m => m.vllm_avg_ttft_ms ?? m.ollama_proxy_avg_ttft_ms ?? m.ollama_ttft_ms ?? null)
            .filter((v): v is number => v != null && v > 0);
          const avgTtft = ttftValues.length > 0
            ? ttftValues.reduce((a, b) => a + b, 0) / ttftValues.length
            : null;
          const ttftCls = avgTtft == null ? 'text-gray-400 dark:text-gray-600'
            : avgTtft < 100 ? 'text-emerald-400'
            : avgTtft < 500 ? 'text-yellow-400'
            : 'text-red-400';
          return (
            <InsightTile
              label={
                <MetricTooltip
                  metricId="fleet-ttft"
                  name="TTFT — Time To First Token"
                  oneLiner="Average time from request to first generated token. Best available: vLLM histogram, proxy rolling average, or Ollama probe."
                  ranges={[
                    { threshold: '< 100ms', color: 'green', label: 'Fast · interactive quality' },
                    { threshold: '100–500ms', color: 'amber', label: 'Moderate · noticeable delay' },
                    { threshold: '> 500ms', color: 'red', label: 'Slow · check model size or queue depth' },
                  ]}
                >
                  {isLocalMode ? 'Node TTFT' : 'Fleet TTFT'}
                </MetricTooltip>
              }
              value={avgTtft != null ? (avgTtft < 1000 ? `${Math.round(avgTtft)}ms` : `${(avgTtft / 1000).toFixed(1)}s`) : '—'}
              valueCls={ttftCls}
              sub={avgTtft != null
                ? `${ttftValues.length} node${ttftValues.length !== 1 ? 's' : ''} · avg latency`
                : 'no latency data'}
              icon={Clock}
              iconCls="text-cyan-400"
            />
          );
        })()}

        {isLocalMode && (
          <InsightTile
            label="Runtime"
            value={
              sentinel?.vllm_running  ? 'vLLM' :
              sentinel?.ollama_running ? 'Ollama' :
              sentinel ? 'No runtime' : '—'
            }
            valueCls={
              (sentinel?.ollama_running || sentinel?.vllm_running)
                ? 'text-green-400'
                : 'text-gray-400 dark:text-gray-600'
            }
            sub={
              sentinel?.vllm_running  ? (sentinel.vllm_model_name ?? 'vLLM · active') :
              sentinel?.ollama_running ? (sentinel.ollama_active_model ?? 'Ollama · active') :
              sentinel ? 'Ollama + vLLM not detected' : undefined
            }
            icon={Cpu}
            iconCls="text-green-400"
          />
        )}

        {isLocalMode && (
          <InsightTile
            label="Inference State"
            value={
              localIsInferring ? 'Live' :
              localIsBusy      ? 'Busy' :
              localIsIdleSpeed ? 'Idle-SPD' :
              localIsIdle      ? 'Idle' :
              '—'
            }
            valueCls={
              localIsInferring ? 'text-green-400' :
              localIsBusy      ? 'text-amber-400' :
              localIsIdleSpeed ? 'text-gray-400 dark:text-gray-500' :
              localIsIdle      ? 'text-gray-400 dark:text-gray-600' :
              'text-gray-400 dark:text-gray-600'
            }
            sub={
              localIsInferring ? 'actively generating tokens' :
              localIsBusy      ? 'GPU active · no token output' :
              localIsIdleSpeed ? 'model loaded · baseline ready' :
              localIsIdle      ? 'no model loaded' :
              undefined
            }
            icon={Activity}
            iconCls={
              localIsInferring ? 'text-green-400' :
              localIsBusy      ? 'text-amber-400' :
              'text-gray-500'
            }
          />
        )}

        {!isLocalMode && (() => {
          const gpuValues = effectiveMetrics
            .map(m => m.nvidia_gpu_utilization_percent ?? m.gpu_utilization_percent ?? null)
            .filter((v): v is number => v != null);
          const avgGpu = gpuValues.length > 0
            ? Math.round(gpuValues.reduce((a, b) => a + b, 0) / gpuValues.length)
            : null;
          const gpuCls = avgGpu == null ? 'text-gray-400 dark:text-gray-600'
            : avgGpu >= 80 ? 'text-red-400'
            : avgGpu >= 50 ? 'text-yellow-400'
            : 'text-emerald-400';

          let fleetDailyCost: number | null = null;
          let totalFleetWatts = 0;
          let costNodeCount = 0;
          for (const m of effectiveMetrics) {
            const w = m.nvidia_power_draw_w ?? m.apple_soc_power_w ?? m.cpu_power_w ?? null;
            if (w != null && w > 0) {
              const ns = getNodeSettings?.(m.node_id);
              const rate = ns?.kwhRate ?? fleetKwhRate;
              totalFleetWatts += w;
              fleetDailyCost = (fleetDailyCost ?? 0) + (w * 24 / 1000) * rate;
              costNodeCount++;
            }
          }

          return (
            <>
              <InsightTile
                label="Fleet GPU%"
                value={avgGpu != null ? `${avgGpu}%` : '—'}
                valueCls={gpuCls}
                sub={avgGpu != null ? `${gpuValues.length} node${gpuValues.length !== 1 ? 's' : ''} · compute utilization` : 'no GPU data'}
                icon={Cpu}
                iconCls={avgGpu != null && avgGpu >= 50 ? 'text-yellow-400' : 'text-emerald-400'}
              />
              <InsightTile
                label="Fleet Cost/Day"
                value={fleetDailyCost != null ? (fleetDailyCost < 0.01 ? '< $0.01' : `$${fleetDailyCost.toFixed(2)}`) : '—'}
                valueCls={fleetDailyCost == null ? 'text-gray-400 dark:text-gray-600' : fleetDailyCost < 1.00 ? 'text-emerald-400' : fleetDailyCost < 5.00 ? 'text-yellow-400' : 'text-red-400'}
                sub={fleetDailyCost != null ? `${costNodeCount} node${costNodeCount !== 1 ? 's' : ''} · ${totalFleetWatts.toFixed(0)}W total` : 'no power data'}
                icon={DollarSign}
                iconCls="text-emerald-400"
              />
            </>
          );
        })()}

        <InsightTile
          label={
            <MetricTooltip
              metricId="wes"
              name="WES — Wicklee Efficiency Score"
              oneLiner="(tok/s ÷ watts) × thermal_penalty × pue. Drops near-zero when idle — WES measures active inference efficiency, not standby. Use the 24h baseline in Triage for SLO tracking."
              ranges={[
                { threshold: '> 10', color: 'emerald', label: 'Excellent · highly efficient inference' },
                { threshold: '3–10', color: 'green',  label: 'Good · efficient for the power envelope' },
                { threshold: '1–3',  color: 'yellow', label: 'Acceptable · typical high-power hardware' },
                { threshold: '< 1',  color: 'red',    label: 'Low · check thermal state or model sizing' },
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
            : wesNullSub}
          icon={Zap}
          iconCls="text-amber-400"
        />

        <InsightTile
          label={
            <MetricTooltip
              metricId="w-1k"
              name="W/1K TKN — Accelerator Power Per 1K Tokens"
              oneLiner="Fleet power ÷ fleet throughput × 1,000. Only nodes actively generating tokens are included — idle nodes do not inflate this number. Per-node values in the table below use the same formula. Configure a power offset in Settings to include system idle draw for wall-power estimates."
            >
              Wattage / 1k Tkn
            </MetricTooltip>
          }
          value={displayWattPer1k != null ? `${displayWattPer1k.toFixed(1)} W` : '—'}
          valueCls={displayWattPer1k == null ? 'text-gray-400 dark:text-gray-600' : undefined}
          sub={wattPowerNodes.length > 0
            ? isLocalMode && sentinel
              ? (() => {
                  const w = getNodePowerW(sentinel);
                  const t = displayFleetTps;
                  return (w != null && t != null && t > 0)
                    ? `${w.toFixed(1)}W @ ${t.toFixed(0)} tok/s`
                    : '1 node reporting';
                })()
              : `${wattPowerNodes.length} node${wattPowerNodes.length === 1 ? '' : 's'} reporting`
            : undefined}
          icon={Zap}
          iconCls="text-emerald-400"
        />

        <InsightTile
          label={
            <MetricTooltip
              metricId="fleet-mem"
              name="Fleet Memory Pressure"
              oneLiner="Aggregate memory utilisation across all online nodes. Uses NVIDIA VRAM for GPU nodes and system RAM for CPU-only nodes."
              ranges={[
                { threshold: '< 60%', color: 'green', label: 'Healthy · room for larger models or batches' },
                { threshold: '60–80%', color: 'amber', label: 'Moderate · watch for eviction on busy nodes' },
                { threshold: '> 80%', color: 'red', label: 'Critical · risk of OOM or model eviction' },
              ]}
            >
              {isLocalMode ? 'Node Memory' : 'Fleet Memory'}
            </MetricTooltip>
          }
          value={displayMemPressure != null ? `${displayMemPressure}%` : '—'}
          valueCls={displayMemPressure == null ? 'text-gray-400 dark:text-gray-600'
            : displayMemPressure > 80 ? 'text-red-400'
            : displayMemPressure > 60 ? 'text-amber-400'
            : undefined}
          sub={effectiveMetrics.length > 0
            ? isLocalMode
              ? `${(effectiveMetrics[0]?.available_memory_mb / 1024).toFixed(1)} GB free`
              : `${effectiveMetrics.length} node${effectiveMetrics.length !== 1 ? 's' : ''} reporting`
            : 'no data'}
          icon={Database}
          iconCls={displayMemPressure != null && displayMemPressure > 80 ? 'text-red-400'
            : displayMemPressure != null && displayMemPressure > 60 ? 'text-amber-400'
            : 'text-indigo-400'}
        />

        <InsightTile
          label={
            <MetricTooltip
              metricId="fleet-tokw"
              name="tok/W — Tokens Per Watt"
              oneLiner="Raw inference efficiency: tok/s ÷ watts. Same as WES when thermal state is Normal. Diverges from WES when thermal penalty is active — the gap is the cost of heat."
              ranges={[
                { threshold: '> 10', color: 'emerald', label: 'Excellent · highly efficient inference' },
                { threshold: '3–10', color: 'green',  label: 'Good · efficient for the power envelope' },
                { threshold: '1–3',  color: 'yellow', label: 'Acceptable · typical high-power hardware' },
                { threshold: '< 1',  color: 'red',    label: 'Low · check thermal state or model sizing' },
              ]}
            >
              {isLocalMode ? 'Node tok/W' : 'Fleet tok/W'}
            </MetricTooltip>
          }
          value={displayFleetAvgTokW != null ? formatWES(displayFleetAvgTokW) : '—'}
          valueCls={wesColorClass(displayFleetAvgTokW)}
          sub={fleetAvgTokW != null
            ? isLocalMode
              ? 'raw · no thermal penalty'
              : `${rankedTokW.length} node${rankedTokW.length !== 1 ? 's' : ''} reporting`
            : wesNullSub}
          icon={Zap}
          iconCls={wesColorClass(displayFleetAvgTokW)}
        />

      </div>

      {isLocalMode && costByModel.length > 0 && (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-sm dark:shadow-none overflow-hidden">
          <button
            onClick={() => setCostByModelOpen(o => !o)}
            className="flex items-center justify-between w-full px-5 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
          >
            <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">Cost by Model (24h)</span>
            <ChevronDown className={`w-3.5 h-3.5 text-gray-500 transition-transform ${costByModelOpen ? 'rotate-180' : ''}`} />
          </button>
          {costByModelOpen && (
            <div className="px-5 pb-4">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[9px] uppercase tracking-wider text-gray-500 border-b border-gray-100 dark:border-gray-700">
                    <th className="text-left py-2 font-semibold">Model</th>
                    <th className="text-right py-2 font-semibold">Hours</th>
                    <th className="text-right py-2 font-semibold">Avg W</th>
                    <th className="text-right py-2 font-semibold">tok/s</th>
                    <th className="text-right py-2 font-semibold">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {costByModel.map((m, i) => (
                    <tr key={m.model ?? `idle-${i}`} className="border-b border-gray-50 dark:border-gray-700/50">
                      <td className="py-2 text-gray-300 font-mono text-[11px]">{m.model ?? '(idle)'}</td>
                      <td className="py-2 text-right text-gray-400">{m.hours_active?.toFixed(1) ?? '—'}</td>
                      <td className="py-2 text-right text-gray-400">{m.avg_watts?.toFixed(1) ?? '—'}</td>
                      <td className="py-2 text-right text-gray-400">{m.tok_s_avg?.toFixed(1) ?? '—'}</td>
                      <td className="py-2 text-right font-semibold text-emerald-400">${m.cost_usd?.toFixed(4) ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4} className="py-2 text-right text-[9px] uppercase tracking-wider text-gray-500 font-semibold">Total (24h)</td>
                    <td className="py-2 text-right font-bold text-emerald-400">${costByModelTotal.toFixed(4)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-sm dark:shadow-none overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-gray-400" />
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              {isLocalMode ? 'Live Hardware' : 'Fleet Status'}
            </h3>
            {isLocalMode ? (<>
              <span className="text-[10px] text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded-full font-semibold">
                1 Hz
              </span>
              {sentinel?.ollama_proxy_active && (
                <span className="text-[10px] text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded-full font-semibold">
                  PROXY
                </span>
              )}
            </>) : (
              <span className="text-[10px] text-gray-400 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded-full">
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
          <div>
          <DiagnosticRail
            sentinel={sentinel}
            transport={transport}
            peakTps={sentinel
              ? (peakTpsMap[sentinel.node_id] ?? localPeakTpsRef.current ?? undefined)
              : undefined}
          />
          {sentinel?.active_models && sentinel.active_models.length > 1 && (() => {
            const s = sentinel!;
            const totalVramBudget = s.nvidia_vram_total_mb ?? s.gpu_wired_limit_mb ?? 0;
            const usedVram = s.active_models!.reduce((sum, am) => sum + (am.vram_mb ?? 0), 0);
            const VRAM_COLORS = ['bg-cyan-500', 'bg-indigo-500', 'bg-amber-500', 'bg-emerald-500', 'bg-rose-500', 'bg-violet-500'];
            return (
            <div className="px-4 py-3 border-t border-gray-100 dark:border-gray-700/60">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-2">
                Active Models ({s.active_models!.length})
              </p>
              <div className="space-y-1.5">
                {s.active_models!.map(am => (
                  <div key={am.model} className="flex items-center gap-3 text-xs">
                    <span className="text-gray-300 font-mono truncate min-w-0 flex-1">{am.model}</span>
                    {am.tok_s != null && <span className="text-emerald-400 font-mono tabular-nums whitespace-nowrap">{am.tok_s.toFixed(1)} tok/s</span>}
                    {am.wes != null && <span className={`font-mono tabular-nums whitespace-nowrap ${wesColorClass(am.wes)}`}>{am.wes.toFixed(1)} WES</span>}
                    {am.vram_mb != null && <span className="text-gray-500 font-mono tabular-nums whitespace-nowrap">{(am.vram_mb / 1024).toFixed(1)}G</span>}
                    {am.request_count > 0 && <span className="text-gray-600 tabular-nums whitespace-nowrap">{am.request_count} req</span>}
                    {s.runtime_config_available === true && (
                      <button
                        onClick={() => setRuntimeConfigModel(am.model)}
                        className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 transition-colors whitespace-nowrap"
                      >
                        Config
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {totalVramBudget > 0 && (
                <div className="mt-3">
                  <div className="flex items-center justify-between text-[10px] text-gray-500 mb-1">
                    <span>VRAM Budget</span>
                    <span className="font-mono tabular-nums">{(usedVram / 1024).toFixed(1)}G / {(totalVramBudget / 1024).toFixed(0)}G ({totalVramBudget > 0 ? Math.round(usedVram / totalVramBudget * 100) : 0}%)</span>
                  </div>
                  <div className="h-2.5 bg-gray-700 rounded-full overflow-hidden flex">
                    {s.active_models!.map((am, i) => {
                      const pct = am.vram_mb ? (am.vram_mb / totalVramBudget * 100) : 0;
                      return pct > 0 ? (
                        <div key={am.model} className={`${VRAM_COLORS[i % VRAM_COLORS.length]} opacity-80`} style={{ width: `${pct}%` }}
                          title={`${am.model}: ${(am.vram_mb! / 1024).toFixed(1)}G (${Math.round(pct)}%)`} />
                      ) : null;
                    })}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5">
                    {s.active_models!.map((am, i) => (
                      <div key={am.model} className="flex items-center gap-1.5 text-[10px] text-gray-500">
                        <div className={`w-2 h-2 rounded-sm ${VRAM_COLORS[i % VRAM_COLORS.length]} opacity-80`} />
                        <span className="font-mono truncate">{am.model.split(':')[0]}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            );
          })()}
          </div>
        ) : (
          nodeRows.length > 0 ? (
            <div className="overflow-x-auto">
              <div className="flex items-center justify-end px-4 py-1.5 border-b border-gray-100 dark:border-gray-700/60">
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
              {nodeRows.filter(r => r.restricted).length > 0 && (
                <div className="px-4 py-3 space-y-2 border-b border-gray-100 dark:border-gray-700/60">
                  {nodeRows.filter(r => r.restricted).map(r => (
                    <RestrictedNodeBanner
                      key={r.nodeId}
                      hostname={r.hostname}
                      onUpgrade={onUpgrade ?? (() => {})}
                    />
                  ))}
                </div>
              )}
              <FleetStatusHeader />
              <div className="divide-y divide-gray-100 dark:divide-gray-800">
                {visibleRows.map(row => (
                  <FleetStatusRow key={row.nodeId} {...row} onOpenConfig={setRuntimeConfigModel} />
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


      {(() => {
        const METRICS: Record<string, { label: string; color: string; gradId: string; unit: string; isPercent: boolean }> = {
          gpu:   { label: 'GPU Utilization', color: '#6366f1', gradId: 'gradGpu',   unit: '%', isPercent: true  },
          cpu:   { label: 'CPU Usage',       color: '#10b981', gradId: 'gradCpu',   unit: '%', isPercent: true  },
          mem:   { label: 'Mem Pressure',    color: '#22d3ee', gradId: 'gradMem',   unit: '%', isPercent: true  },
          power: { label: 'Board Power',     color: '#f59e0b', gradId: 'gradPower', unit: 'W', isPercent: false },
          tps:   { label: 'Tok/s',           color: '#818cf8', gradId: 'gradTps',   unit: ' tok/s', isPercent: false },
        };

        const settled = history.length >= 3;
        const hasGpu   = history.some(p => p.gpu   != null);
        const hasMem   = history.some(p => p.mem   != null);
        const hasPower = history.some(p => p.power != null);
        const hasTps   = history.some(p => p.tps   != null);

        const effectiveKey = selectedMetric === 'gpu' && settled && !hasGpu ? 'cpu' : selectedMetric;
        const cfg = METRICS[effectiveKey];
        const isLive = history.length > 0;

        return (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl p-6 shadow-sm dark:shadow-none">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-6">
                <div>
                  <h3 className="font-semibold text-gray-800 dark:text-gray-200">
                    {cfg.label}
                    {isLive && (
                      <span className="ml-2 text-[10px] text-indigo-400 font-normal tabular-nums">
                        LIVE · 1 Hz · Current Session
                      </span>
                    )}
                  </h3>
                </div>
                <div ref={metricDropdownRef} className="relative">
                  <button
                    onClick={() => setMetricOpen(o => !o)}
                    className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-700 rounded-lg text-xs text-gray-600 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600 transition-colors select-none"
                  >
                    <span className="font-medium">
                      {{ gpu: 'GPU Util', cpu: 'CPU', mem: 'Mem Pressure', power: 'Board Power', tps: 'Tok/s' }[selectedMetric]}
                    </span>
                    <ChevronDown className={`w-3 h-3 text-gray-400 transition-transform duration-150 ${metricOpen ? 'rotate-180' : ''}`} />
                  </button>

                  {metricOpen && (
                    <div className="absolute right-0 top-full mt-1.5 z-30 min-w-[172px] bg-gray-800 border border-gray-700/80 rounded-xl shadow-2xl shadow-black/50 py-1 animate-in fade-in slide-in-from-top-1 duration-150">
                      {(
                        [
                          { key: 'gpu'   as MetricKey, label: 'GPU Util',     na: settled && !hasGpu,   naLabel: ''          },
                          { key: 'cpu'   as MetricKey, label: 'CPU',          na: false,                 naLabel: ''          },
                          { key: 'mem'   as MetricKey, label: 'Mem Pressure', na: settled && !hasMem,   naLabel: 'macOS only' },
                          { key: 'power' as MetricKey, label: 'Board Power',  na: settled && !hasPower, naLabel: ''          },
                          { key: 'tps'   as MetricKey, label: 'Tok/s',        na: settled && !hasTps,   naLabel: 'no model'  },
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
                              : 'text-gray-300 hover:bg-gray-700'
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
                <ResponsiveContainer width="100%" height="100%" minHeight={1}>
                  <AreaChart data={history}>
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
                      dataKey={effectiveKey}
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
                Live · 1 Hz · Current Session
              </p>
            </div>

            <div className="lg:col-span-1 h-[400px]">
              <EventFeed events={activeEvents} />
            </div>
          </div>
        );
      })()}

      {isLocalMode ? (
        <div className="space-y-4">
          {pairingInfo?.status !== 'connected' && (
            <div className="bg-gray-800/60 border border-gray-700 rounded-2xl p-5 flex flex-col sm:flex-row items-center justify-between gap-4">
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
          )}
          {sentinel && (
            <ModelFitSummaryStrip
              node={sentinel}
              getNodeSettings={getNodeSettings}
              onNavigate={onNavigateToInsights
                ? () => onNavigateToInsights('performance', 'model-fit-analysis')
                : undefined
              }
            />
          )}
        </div>
      ) : (
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {(() => {
            const displayCostPer1M = displayCostPer1kNew != null ? displayCostPer1kNew * 1000 : null;
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

          <FleetCard
            label={
              <MetricTooltip
                metricId="fleet-avg-wes"
                name="FLEET AVG WES"
                oneLiner="Average WES score across all online nodes."
                ranges={[
                  { threshold: '> 10', color: 'emerald', label: 'Excellent fleet efficiency' },
                  { threshold: '3–10', color: 'green',  label: 'Good · efficient fleet' },
                  { threshold: '1–3',  color: 'yellow', label: 'Acceptable · mixed hardware fleet' },
                  { threshold: '< 1',  color: 'red',    label: 'Low · check thermal state across fleet' },
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
        </div>

        {(() => {
          const fitCandidate = effectiveMetrics
            .filter(n =>
              n.ollama_active_model
              || n.vllm_model_name
              || n.llamacpp_model_name
            )
            .sort((a, b) =>
              ((b.ollama_tokens_per_second ?? b.vllm_tokens_per_sec ?? 0) -
               (a.ollama_tokens_per_second ?? a.vllm_tokens_per_sec ?? 0))
            )[0];
          return fitCandidate
            ? (
              <ModelFitSummaryStrip
                node={fitCandidate}
                nodes={effectiveMetrics}
                getNodeSettings={getNodeSettings}
                onNavigate={onNavigateToInsights
                  ? () => onNavigateToInsights('performance', 'model-fit-analysis')
                  : undefined
                }
              />
            )
            : null;
        })()}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <FleetCard label="Best Route Now">
            {activeEntries.length === 0 ? (
              <p className="text-sm font-telin text-gray-600">— no active inference</p>
            ) : activeEntries.length === 1 ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">→</span>
                <button onClick={() => onNavigateToObservability?.({ nodeId: activeEntries[0].nodeId })} className="text-sm font-bold font-telin text-gray-200 hover:text-indigo-400 transition-colors cursor-pointer">{activeEntries[0].hostname || activeEntries[0].nodeId}</button>
                <span className="text-xs text-gray-500">(only active node)</span>
              </div>
            ) : sameNode && bestCostNode == null ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">→</span>
                <button onClick={() => onNavigateToObservability?.({ nodeId: bestLatNode!.nodeId })} className="text-sm font-bold font-telin text-gray-200 hover:text-indigo-400 transition-colors cursor-pointer">{bestLatNode!.hostname || bestLatNode!.nodeId}</button>
                <span className="text-[10px] text-green-400">Best for latency and efficiency</span>
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-[9px] uppercase tracking-widest text-gray-500 w-16 shrink-0">Latency</span>
                  <span className="text-xs text-gray-400">→</span>
                  <div className="flex flex-col min-w-0">
                    <button onClick={() => onNavigateToObservability?.({ nodeId: bestLatNode!.nodeId })} className="text-sm font-bold font-telin text-gray-200 hover:text-indigo-400 transition-colors cursor-pointer leading-tight">{bestLatNode!.hostname || bestLatNode!.nodeId}</button>
                    {bestLatNode!.activeModel && <span className="text-[9px] text-gray-600 font-mono truncate leading-tight">{bestLatNode!.activeModel}</span>}
                  </div>
                  <span className="text-xs font-telin text-green-400 ml-auto shrink-0">{bestLatNode!.tps!.toFixed(1)} tok/s</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] uppercase tracking-widest text-gray-500 w-16 shrink-0">Efficiency</span>
                  <span className="text-xs text-gray-400">→</span>
                  <div className="flex flex-col min-w-0">
                    <button onClick={() => onNavigateToObservability?.({ nodeId: bestEffNode!.nodeId })} className="text-sm font-bold font-telin text-gray-200 hover:text-indigo-400 transition-colors cursor-pointer leading-tight">{bestEffNode!.hostname || bestEffNode!.nodeId}</button>
                    {bestEffNode!.activeModel && <span className="text-[9px] text-gray-600 font-mono truncate leading-tight">{bestEffNode!.activeModel}</span>}
                  </div>
                  <div className="ml-auto shrink-0 flex flex-col items-end gap-0">
                    <span className={`text-xs font-telin ${wesColorClass(bestEffNode!.wes)}`}>WES {formatWES(bestEffNode!.wes)}</span>
                    {bestEffNode!.tcPct > 0 && (
                      <span className="text-[9px] font-telin text-amber-400/70">-{bestEffNode!.tcPct}% thermal</span>
                    )}
                  </div>
                </div>
                {bestCostNode != null && activeCostEntries.length >= 2 && (
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] uppercase tracking-widest text-gray-500 w-16 shrink-0">Cost</span>
                    <span className="text-xs text-gray-400">→</span>
                    <div className="flex flex-col min-w-0">
                      <button onClick={() => onNavigateToObservability?.({ nodeId: bestCostNode.nodeId })} className="text-sm font-bold font-telin text-gray-200 hover:text-indigo-400 transition-colors cursor-pointer leading-tight">{bestCostNode.hostname || bestCostNode.nodeId}</button>
                      {bestCostNode.activeModel && <span className="text-[9px] text-gray-600 font-mono truncate leading-tight">{bestCostNode.activeModel}</span>}
                    </div>
                    <span className="text-xs font-telin text-cyan-400 ml-auto shrink-0">
                      {bestCostNode.costPer1m! < 0.001 ? `$${(bestCostNode.costPer1m! * 1000).toFixed(2)}m` : bestCostNode.costPer1m! < 0.01 ? `$${bestCostNode.costPer1m!.toFixed(3)}` : `$${bestCostNode.costPer1m!.toFixed(2)}`}/1M
                    </span>
                  </div>
                )}
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

          {costEntries.some(e => e.costPer1mRaw != null || e.tps == null || e.tps <= 0) && (
            <FleetCard label="Node Cost / 1M Tokens">
              {(() => {
                const active = costEntries
                  .filter(e => e.tps != null && e.tps > 0)
                  .sort((a, b) => {
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
                      const costStr = e.costPer1m == null ? '— no power data' : e.costPer1m < 0.01 ? '< $0.01' : `$${e.costPer1m.toFixed(2)}`;
                      const costCls = e.costPer1m == null ? 'text-gray-600' : isChampion ? 'text-green-400' : 'text-cyan-400';
                      return (
                        <div key={e.nodeId} className="flex items-center gap-2 min-w-0">
                          <span className="text-[9px] uppercase tracking-widest text-gray-500 w-4 shrink-0 text-right">{e.costPer1m != null ? `${i + 1}.` : '—'}</span>
                          <span className="text-xs font-bold font-telin text-gray-200 truncate flex-1 min-w-0">{e.hostname !== e.nodeId ? e.hostname : e.nodeId}</span>
                          <span className={`text-xs font-telin font-semibold shrink-0 ${costCls}`}>{costStr}</span>
                          {e.costPer1m != null && <span className="text-[10px] text-gray-600 shrink-0">/1M</span>}
                          {e.tps != null && <span className="text-[10px] font-telin text-gray-500 shrink-0 w-16 text-right">{e.tps.toFixed(1)} tok/s</span>}
                        </div>
                      );
                    })}
                    {idle.length > 0 && (
                      <div className={`${active.length > 0 ? 'border-t border-gray-700 pt-1.5 mt-1' : ''} space-y-1`}>
                        {idle.map(e => (
                          <div key={e.nodeId} className="flex items-center gap-2 min-w-0">
                            <span className="text-[9px] uppercase tracking-widest text-gray-700 w-4 shrink-0">—</span>
                            <span className="text-xs font-telin text-gray-600 truncate flex-1 min-w-0">{e.hostname !== e.nodeId ? e.hostname : e.nodeId}</span>
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
        </div>

        {(() => {
          const idleNodes = effectiveMetrics.filter(n => {
            const tps   = n.ollama_tokens_per_second ?? n.vllm_tokens_per_sec ?? null;
            const watts = getNodePowerW(n);
            return watts != null && (tps == null || tps <= 0);
          });
          if (idleNodes.length === 0) return null;
          const idleCosts = idleNodes.map(n => {
            const ns    = getNodeSettings?.(n.node_id) ?? { pue: 1.0, kwhRate: fleetKwhRate };
            const watts = getNodePowerW(n) ?? 0;
            return { hostname: n.hostname ?? n.node_id, dailyCost: watts * ns.pue * 24 * (ns.kwhRate / 1000) };
          });
          const fleetDailyTotal = idleCosts.reduce((sum, n) => sum + n.dailyCost, 0);
          return (
            <FleetCard label="Idle Fleet Cost" sub={<p className="text-[10px] text-gray-600 leading-tight">{idleNodes.length} idle node{idleNodes.length !== 1 ? 's' : ''} · est. electricity</p>}>
              <div className="space-y-1 w-full">
                {idleCosts.map((n, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 min-w-0">
                    <span className="text-xs text-gray-500 truncate flex-1 min-w-0">{n.hostname}</span>
                    <span className="font-telin text-xs text-amber-400 shrink-0">${n.dailyCost.toFixed(2)}/day</span>
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
      </div>
      )} {}

      {isLocalHost && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl border border-gray-700 bg-gray-800/50 text-[11px] flex-wrap">

          {(!pairingInfo || pairingInfo.status === 'unpaired') && (
            <div className="flex items-center gap-2 text-gray-500">
              <Fingerprint className="w-3.5 h-3.5 text-gray-600 shrink-0" />
              <span className="font-mono text-gray-400">{pairingInfo?.node_id ?? '—'}</span>
              <span className="text-gray-700">·</span>
              <span>Not paired to fleet</span>
            </div>
          )}

          {pairingInfo?.status === 'pending' && (
            <div className="flex items-center gap-2 text-amber-400/80">
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-60" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
              </span>
              <span className="font-mono text-gray-400">{pairingInfo.node_id ?? '—'}</span>
              <span className="text-gray-700">·</span>
              <span>Pairing code:&nbsp;
                <span className="font-mono font-bold text-amber-300 tracking-widest">
                  {pairingInfo.code ? `${pairingInfo.code.slice(0, 3)} ${pairingInfo.code.slice(3)}` : '——'}
                </span>
              </span>
              {pairingInfo.expires_at && (
                <>
                  <span className="text-gray-700">·</span>
                  <span className="tabular-nums text-amber-500/70">
                    expires in {Math.max(0, Math.floor((pairingInfo.expires_at - Date.now()) / 1000))}s
                  </span>
                </>
              )}
            </div>
          )}

          {pairingInfo?.status === 'connected' && (
            <div className="flex items-center gap-2 text-gray-400">
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-40" style={{ animationDuration: '3s' }} />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
              </span>
              <span className="text-green-400 font-medium">Connected to Fleet</span>
              <span className="text-gray-700">·</span>
              <span className="font-mono text-gray-500">{pairingInfo.node_id}</span>
              <span className="text-gray-700">·</span>
              <span className="text-gray-600">wicklee.dev</span>
            </div>
          )}

          {(!pairingInfo || pairingInfo.status === 'unpaired') && (
            <button
              onClick={onOpenPairing}
              className="px-3 py-1 bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/30 text-indigo-400 hover:text-indigo-300 font-medium rounded-lg transition-all"
            >
              Connect to Cloud →
            </button>
          )}

          {pairingInfo?.status === 'pending' && (
            <button
              onClick={onOpenPairing}
              className="px-3 py-1 border border-amber-500/30 text-amber-400/70 hover:text-amber-300 font-medium rounded-lg transition-all"
            >
              Cancel
            </button>
          )}

          {pairingInfo?.status === 'connected' && (
            <div className="flex items-center gap-2">
              <a
                href="https://wicklee.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-1 bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/30 text-indigo-400 hover:text-indigo-300 font-medium rounded-lg transition-all"
              >
                View Fleet →
              </a>
              <button
                onClick={onOpenPairing}
                className="px-3 py-1 border border-gray-700 hover:border-red-500/40 text-gray-600 hover:text-red-400 font-medium rounded-lg transition-all"
              >
                Disconnect
              </button>
            </div>
          )}

        </div>
      )}

      {runtimeConfigModel && (
        <RuntimeConfigModal
          modelName={runtimeConfigModel}
          onClose={() => setRuntimeConfigModel(null)}
        />
      )}
    </div>
  );
};

export default Overview;
