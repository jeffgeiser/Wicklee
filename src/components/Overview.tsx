import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Thermometer, Database, Zap, Activity, Cloud, CloudLightning, Download, Terminal, Plus, ChevronDown, BrainCircuit, Check, DollarSign, Server, Star, AlertTriangle, Info } from 'lucide-react';
import { useAuth } from '@clerk/clerk-react';
import { computeWES, formatWES, wesColorClass } from '../utils/wes';
import { calculateFleetHealthPct, calculateTotalVramMb, calculateTotalVramCapacityMb, WES_TOOLTIP } from '../utils/efficiency';
import { NODE_REACHABLE_MS, fmtAgo as fmtNodeAgo } from '../utils/time';
import { ConnectionState, NodeAgent, PairingInfo, SentinelMetrics, FleetEvent } from '../types';
import { thermalColour, derivedNvidiaThermal } from './NodeHardwarePanel';
import EventFeed from './EventFeed';

const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

interface OverviewProps {
  nodes: NodeAgent[];
  isPro?: boolean;
  pairingInfo?: PairingInfo | null;
  onOpenPairing?: () => void;
  onAddNode?: () => void;
  onTelemetryUpdate?: () => void;
  onConnectionStateChange?: (state: ConnectionState) => void;
  getNodeSettings?: (nodeId: string) => { pue: number; kwhRate: number; currency: string };
  fleetKwhRate?: number;
}

const MOCK_HISTORY = Array.from({ length: 20 }).map((_, i) => ({
  time: `${i}:00`,
  requests: Math.floor(Math.random() * 50) + 10,
  latency: Math.floor(Math.random() * 100) + 200,
}));

// ── Insight Engine tile — uniform across all 8 fleet-header cells ────────────
interface InsightTileProps {
  label: string;
  value: string;
  valueCls?: string;
  valueTitle?: string;
  sub?: string;
  icon: React.ElementType;
  iconCls?: string;
}
const InsightTile: React.FC<InsightTileProps> = ({ label, value, valueCls, valueTitle, sub, icon: Icon, iconCls }) => (
  <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 flex flex-col justify-between h-[116px]">
    <div className="flex items-start justify-between gap-2">
      <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500 leading-tight">{label}</p>
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
// Columns: STATUS/ID · MEMORY · MODEL · WES · TOK/S · WATTS · THERMAL · SPACER
// Fixed widths — no responsive hiding. Container is overflow-x: auto so the
// table scrolls horizontally on narrow viewports rather than hiding columns.
// SPACER (1fr) absorbs excess space on wide screens.
const FLEET_GRID_CLS = 'grid gap-x-3 items-center [grid-template-columns:140px_120px_200px_80px_80px_80px_100px_1fr]';

const FS_HDR = 'text-[9px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-600 leading-none whitespace-nowrap';

// ── Column header row ─────────────────────────────────────────────────────────
const FleetStatusHeader: React.FC = () => (
  <div className={`${FLEET_GRID_CLS} px-4 py-2 border-b border-gray-100 dark:border-gray-800/60`}>
    <p className={`${FS_HDR} sticky left-4 bg-white dark:bg-gray-900`}>NODE</p>
    <p className={FS_HDR}>MEMORY</p>
    <p className={FS_HDR}>MODEL</p>
    <p className={FS_HDR}>WES</p>
    <p className={FS_HDR}>TOK/S</p>
    <p className={FS_HDR}>WATTS</p>
    <p className={FS_HDR}>THERMAL</p>
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
}

const FleetStatusRow: React.FC<NodeRowProps> = ({ nodeId, hostname, metrics: m, lastSeenMs, pue = 1.0 }) => {
  const isOnline = m !== null;

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
  const tps      = m?.ollama_tokens_per_second ?? null;
  const isActive = isOnline && tps != null && tps > 0;

  // Thermal
  const nvThermal  = m && m.thermal_state == null ? derivedNvidiaThermal(m.nvidia_gpu_temp_c ?? null) : null;
  const thermalStr = m?.thermal_state ?? nvThermal?.label ?? null;
  const thermalCls = m?.thermal_state != null ? thermalColour(m.thermal_state) : (nvThermal?.colour ?? 'text-gray-400');
  const thermalWarn = thermalStr != null && !['normal', 'nominal'].includes(thermalStr.toLowerCase());

  // Power
  const totalPowerW = m ? (m.cpu_power_w ?? 0) + (m.nvidia_power_draw_w ?? 0) : 0;
  const hasPower    = m ? (m.cpu_power_w != null || m.nvidia_power_draw_w != null) : false;

  // WES — only when actively inferencing
  const wes = isActive ? computeWES(tps, hasPower ? totalPowerW : null, m?.thermal_state ?? null, pue) : null;

  // Memory / VRAM
  const hasNvidia = m?.nvidia_vram_total_mb != null && m.nvidia_vram_total_mb > 0;
  const memLabel  = hasNvidia ? 'VRAM' : 'Memory';
  const memPct    = hasNvidia
    ? Math.round(((m!.nvidia_vram_used_mb ?? 0) / m!.nvidia_vram_total_mb!) * 1000) / 10
    : (m?.memory_pressure_percent != null ? Math.round(m.memory_pressure_percent * 10) / 10 : null);
  const memColorCls = memPct == null ? 'text-gray-500 dark:text-gray-600'
    : memPct >= 90 ? 'text-red-400'
    : memPct >= 70 ? 'text-amber-400'
    : 'text-green-400';
  const memBarCls = memPct == null ? 'bg-gray-500'
    : memPct >= 90 ? 'bg-red-400'
    : memPct >= 70 ? 'bg-amber-400'
    : 'bg-green-400';

  // Model string
  const modelStr = !isOnline ? '—'
    : !m!.ollama_running ? 'No runtime'
    : (m!.ollama_active_model ?? '—');

  const V = `text-xs font-telin ${!isOnline ? 'text-gray-400 dark:text-gray-600' : ''}`;

  // Condensed tooltip on NODE cell — surfaces columns hidden at narrow viewports
  const nodeTooltip = [
    modelStr !== '—' && modelStr !== 'No runtime' ? modelStr : null,
    hasPower && isOnline ? `${totalPowerW.toFixed(1)}W` : null,
    memPct != null ? `${memPct}% ${memLabel}` : null,
  ].filter(Boolean).join('  ·  ');

  return (
    <div
      className={`group ${FLEET_GRID_CLS} px-4 py-3 min-h-[44px] hover:bg-gray-50/50 dark:hover:bg-gray-800/30 transition-colors${!isOnline ? ' opacity-50' : ''}`}
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
            <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
          ) : (
            <span className="relative inline-flex rounded-full h-2 w-2 bg-gray-500" />
          )}
        </span>
        <div className="min-w-0">
          <p className="text-xs font-telin font-bold text-gray-900 dark:text-white truncate leading-none">{nodeId}</p>
          {hostname !== nodeId && (
            <p className="text-[10px] text-gray-500 truncate leading-none mt-0.5">{hostname}</p>
          )}
        </div>
      </div>

      {/* 2. MEMORY / VRAM */}
      <div
        className="min-w-0 overflow-hidden"
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

      {/* 3. MODEL */}
      <div className="min-w-0 overflow-hidden">
        <p className={`${V} truncate ${!isOnline || !m?.ollama_running ? 'text-gray-500' : 'text-gray-700 dark:text-gray-300'}`}>
          {modelStr}
        </p>
      </div>

      {/* 4. WES */}
      <div className="flex items-center gap-1 overflow-hidden">
        {thermalWarn && isOnline && (
          <AlertTriangle size={9} className="text-amber-400 shrink-0" title="Thermal throttling active" />
        )}
        <span
          className={`${V} font-semibold ${wes != null ? wesColorClass(wes) : 'text-gray-500 dark:text-gray-600'}`}
          title={wes != null && wes < 10
            ? wesBreakdownTitle(tps, hasPower ? totalPowerW : null, m?.thermal_state ?? null, m?.chip_name ?? m?.gpu_name ?? null)
            : WES_TOOLTIP}
        >
          {wes != null ? formatWES(wes) : '—'}
        </span>
      </div>

      {/* 5. TOK/S */}
      <div className="min-w-0 overflow-hidden">
        <span
          className={`${V} ${isActive ? 'text-green-400' : 'text-gray-500 dark:text-gray-600'}`}
          title="Tokens per second — measured generation throughput from the active model."
        >
          {isActive ? tps!.toFixed(1) : '—'}
        </span>
      </div>

      {/* 6. WATTS */}
      <div className="min-w-0 overflow-hidden">
        <span
          className={`${V} ${hasPower && isOnline ? 'text-gray-700 dark:text-gray-300' : 'text-gray-500 dark:text-gray-600'}`}
          title="Current power draw of this node."
        >
          {hasPower && isOnline ? `${totalPowerW.toFixed(1)}W` : '—'}
        </span>
      </div>

      {/* 7. THERMAL — pill badge */}
      <div className="min-w-0 overflow-hidden">
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

// ── WES breakdown tooltip (browser title attr, shown when WES < 10) ───────────
function wesBreakdownTitle(
  tps: number | null,
  watts: number | null,
  thermal: string | null,
  chipName: string | null | undefined,
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
  return [
    `tok/s: ${tps != null ? tps.toFixed(1) : '—'}  ·  Watts: ${watts != null ? `${watts.toFixed(1)}W` : '—'}  ·  Thermal: ${thermal ?? '—'}`,
    diagnosis,
  ].join('\n');
}

// ── Inference Density Map — hex hive, one hex per node ────────────────────────
const HexHive: React.FC<{ rows: NodeRowProps[] }> = ({ rows }) => {
  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[140px]">
        <p className="text-xs text-gray-600">No nodes</p>
      </div>
    );
  }
  const perRow = rows.length <= 3 ? rows.length : Math.ceil(Math.sqrt(rows.length * 1.4));
  const grid: NodeRowProps[][] = [];
  for (let i = 0; i < rows.length; i += perRow) grid.push(rows.slice(i, i + perRow));

  return (
    <div className="flex flex-col items-center justify-center gap-2.5 py-6 px-2 min-h-[160px]">
      {grid.map((gridRow, ri) => (
        <div key={ri} className="flex gap-2.5" style={{ marginLeft: ri % 2 === 1 ? 24 : 0 }}>
          {gridRow.map(entry => {
            const m          = entry.metrics;
            const tps        = m?.ollama_tokens_per_second ?? null;
            const isActive   = m != null && tps != null && tps > 0;
            const throttling = m?.thermal_state != null
              && ['serious', 'critical'].includes(m.thermal_state.toLowerCase());
            const isOnline   = m != null;
            const hexBg = !isOnline ? 'bg-gray-700/25'
              : throttling          ? 'bg-red-500/50'
              : isActive            ? 'bg-amber-500/40'
              :                       'bg-gray-600/30';
            const glow = throttling ? 'drop-shadow(0 0 6px rgba(239,68,68,0.55))'
              : isActive            ? 'drop-shadow(0 0 8px rgba(245,158,11,0.55))'
              :                       'none';
            return (
              <div key={entry.nodeId} className="flex flex-col items-center gap-1">
                <div style={{ filter: glow }}>
                  <div
                    className={`w-11 h-[50px] ${hexBg} ${isActive && !throttling ? 'animate-pulse' : ''}`}
                    style={{ clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)' }}
                  />
                </div>
                <p className="text-[8px] font-telin text-gray-500 truncate max-w-[44px] text-center leading-none">
                  {entry.nodeId}
                </p>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
};

// ── Fleet Intelligence card wrapper ───────────────────────────────────────────
const FleetCard: React.FC<{
  label: string;
  children: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
}> = ({ label, children, sub, className = '' }) => (
  <div className={`bg-gray-800/50 border border-gray-700/40 rounded-xl p-4 flex flex-col gap-2 ${className}`}>
    <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-500 leading-none">{label}</p>
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

// ── Main component ─────────────────────────────────────────────────────────────
const Overview: React.FC<OverviewProps> = ({ nodes, isPro, pairingInfo, onOpenPairing, onAddNode, onTelemetryUpdate, onConnectionStateChange, getNodeSettings, fleetKwhRate = 0.12 }) => {
  const { getToken } = useAuth();
  const [sentinel, setSentinel] = useState<SentinelMetrics | null>(null);
  const [connected, setConnected] = useState(false);
  const [transport, setTransport] = useState<'ws' | 'sse' | null>(null);
  const [allNodeMetrics, setAllNodeMetrics] = useState<Record<string, SentinelMetrics>>({});
  const [lastSeenMsMap, setLastSeenMsMap]   = useState<Record<string, number>>({});
  const [fleetEvents, setFleetEvents]       = useState<FleetEvent[]>([]);
  const prevLiveRef    = useRef<Record<string, boolean>>({});
  const prevThermalRef = useRef<Record<string, string | null>>({});

  type MetricKey = 'gpu' | 'cpu' | 'mem' | 'power';
  interface HistoryPoint { time: string; gpu: number | null; cpu: number; mem: number | null; power: number | null; }
  const [history, setHistory]           = useState<HistoryPoint[]>([]);
  const [selectedMetric, setSelectedMetric] = useState<MetricKey>('gpu');
  const MAX_HISTORY = 60;

  const [metricOpen, setMetricOpen] = useState(false);
  const metricDropdownRef = useRef<HTMLDivElement>(null);

  // Tick every 5s so stale-node detection re-evaluates even when no SSE arrives.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 5_000);
    return () => clearInterval(id);
  }, []);

  const wsRef = useRef<WebSocket | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const CLOUD_URL = (() => {
    const v = (import.meta.env.VITE_CLOUD_URL ?? '') as string;
    return !v ? 'https://vibrant-fulfillment-production-62c0.up.railway.app'
      : v.startsWith('http') ? v : `https://${v}`;
  })();

  const pushHistoryPoint = useCallback((data: SentinelMetrics) => {
    setHistory(prev => {
      const ts  = new Date(data.timestamp_ms);
      const lbl = `${ts.getMinutes().toString().padStart(2, '0')}:${ts.getSeconds().toString().padStart(2, '0')}`;
      const pt: HistoryPoint = {
        time:  lbl,
        gpu:   data.nvidia_gpu_utilization_percent ?? data.gpu_utilization_percent ?? null,
        cpu:   data.cpu_usage_percent,
        mem:   data.memory_pressure_percent ?? null,
        power: data.cpu_power_w ?? data.nvidia_power_draw_w ?? null,
      };
      const next = [...prev, pt];
      return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
    });
  }, []);

  const handleMetrics = useCallback((data: SentinelMetrics) => {
    setSentinel(data);
    setConnected(true);
    pushHistoryPoint(data);
  }, [pushHistoryPoint]);

  useEffect(() => {
    let retryWs:  ReturnType<typeof setTimeout>;
    let retrySse: ReturnType<typeof setTimeout>;
    let wsFailed = false;

    if (isLocalHost) {
      const connectSSE = () => {
        if (wsRef.current?.readyState === WebSocket.OPEN) return;
        const es = new EventSource('/api/metrics');
        esRef.current = es;
        es.onopen    = () => setTransport('sse');
        es.onmessage = (ev) => {
          try { handleMetrics(JSON.parse(ev.data) as SentinelMetrics); setTransport('sse'); }
          catch { /* malformed frame */ }
        };
        es.onerror = () => {
          setConnected(false);
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
            setTransport('ws');
            if (esRef.current) { esRef.current.close(); esRef.current = null; }
          } catch { /* malformed frame */ }
        };
        ws.onerror = () => { wsFailed = true; };
        ws.onclose = () => {
          wsRef.current = null;
          setConnected(false);
          if (wsFailed) { connectSSE(); }
          else {
            if (!esRef.current) connectSSE();
            retryWs = setTimeout(() => { wsFailed = false; connectWS(); }, 3000);
          }
        };
      };

      connectWS();
    } else {
      const connectCloudSSE = async () => {
        // Fetch a short-lived stream token (same pattern as App.tsx)
        try {
          const jwt = await getToken();
          if (!jwt) { retrySse = setTimeout(connectCloudSSE, 5000); return; }
          const res = await fetch(`${CLOUD_URL}/api/auth/stream-token`, {
            headers: { Authorization: `Bearer ${jwt}` },
          });
          if (!res.ok) { retrySse = setTimeout(connectCloudSSE, 5000); return; }
          const { stream_token: streamToken } = await res.json();
          const es = new EventSource(`${CLOUD_URL}/api/fleet/stream?token=${encodeURIComponent(streamToken)}`);
          esRef.current = es;
          es.onopen = () => { setTransport('sse'); setConnected(true); };
        es.onmessage = (ev) => {
          try {
            const fleet = JSON.parse(ev.data) as { nodes: Array<{ node_id: string; last_seen_ms: number; metrics: SentinelMetrics | null }> };
            const updated: Record<string, SentinelMetrics> = {};
            const updatedLastSeen: Record<string, number>  = {};
            const now = Date.now();
            const newEvents: FleetEvent[] = [];

            for (const n of fleet.nodes) {
              updatedLastSeen[n.node_id] = n.last_seen_ms;
              const isNowLive = n.metrics != null && (now - n.last_seen_ms) < 30_000;
              const wasLive   = prevLiveRef.current[n.node_id];

              if (isNowLive && n.metrics) {
                updated[n.node_id] = n.metrics;
                if (wasLive === false) {
                  // Node came back online
                  newEvents.push({ id: Math.random().toString(36).slice(2), ts: now, type: 'node_online', nodeId: n.node_id, hostname: n.metrics.hostname ?? n.node_id });
                } else if (wasLive === true) {
                  // Check thermal change
                  const prevThermal = prevThermalRef.current[n.node_id];
                  const curThermal  = n.metrics.thermal_state;
                  if (prevThermal !== undefined && prevThermal !== curThermal && curThermal != null) {
                    newEvents.push({ id: Math.random().toString(36).slice(2), ts: now, type: 'thermal_change', nodeId: n.node_id, hostname: n.metrics.hostname ?? n.node_id, detail: prevThermal != null ? `${prevThermal} → ${curThermal}` : curThermal ?? '' });
                  }
                }
                prevThermalRef.current[n.node_id] = n.metrics.thermal_state;
              } else if (!isNowLive && wasLive === true) {
                // Node went offline
                newEvents.push({ id: Math.random().toString(36).slice(2), ts: now, type: 'node_offline', nodeId: n.node_id, hostname: n.metrics?.hostname ?? n.node_id });
              }
              prevLiveRef.current[n.node_id] = isNowLive;
            }

            setLastSeenMsMap(prev => ({ ...prev, ...updatedLastSeen }));
            if (Object.keys(updated).length > 0) {
              setAllNodeMetrics(prev => ({ ...prev, ...updated }));
              // Feed the first live node's metrics into the history buffer
              // so the System Performance graph works on the hosted view too.
              const firstLive = Object.values(updated)[0];
              if (firstLive) pushHistoryPoint(firstLive);
              onTelemetryUpdate?.();
              setTransport('sse');
            }
            if (newEvents.length > 0) {
              setFleetEvents(prev => [...newEvents, ...prev].slice(0, 50));
            }
          } catch { /* malformed frame */ }
        };
        es.onerror = () => {
          setConnected(false);
          es.close();
          esRef.current = null;
          retrySse = setTimeout(connectCloudSSE, 5000);
        };
        } catch {
          retrySse = setTimeout(connectCloudSSE, 5000);
        }
      };
      connectCloudSSE();
    }

    return () => {
      clearTimeout(retryWs);
      clearTimeout(retrySse);
      wsRef.current?.close();
      esRef.current?.close();
    };
  }, [handleMetrics, pushHistoryPoint, CLOUD_URL, getToken]);

  // Close metric dropdown on outside click
  useEffect(() => {
    if (!metricOpen) return;
    const handler = (e: MouseEvent) => {
      if (!metricDropdownRef.current?.contains(e.target as Node)) setMetricOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [metricOpen]);

  // Derive ambient connection state for logo + status dot.
  // Must be computed BEFORE the early return — hooks (useEffect below) cannot
  // be called after a conditional return (React rules of hooks).
  const STALE_THRESHOLD_MS = 30_000;
  const nowMs = Date.now();
  const hasNodes = isLocalHost ? sentinel != null : Object.keys(allNodeMetrics).length > 0;
  const allStale = isLocalHost
    ? (sentinel != null && nowMs - (sentinel.timestamp_ms ?? 0) > STALE_THRESHOLD_MS)
    : Object.keys(lastSeenMsMap).length > 0 &&
      Object.values(lastSeenMsMap).every((t: number) => nowMs - t > STALE_THRESHOLD_MS);
  const connectionState: ConnectionState = !connected
    ? 'disconnected'
    : !hasNodes
    ? 'idle'
    : allStale
    ? 'degraded'
    : 'connected';

  // Report connection state change to parent (drives logo animation in Sidebar)
  useEffect(() => {
    onConnectionStateChange?.(connectionState);
  }, [connectionState, onConnectionStateChange]);

  if (!isLocalHost && nodes.length === 0) {
    return <EmptyFleetState onAddNode={onAddNode} />;
  }

  // ── Fleet-wide metric computations (all 8 Insight Engine tiles) ─────────────
  const liveMetrics: SentinelMetrics[] = Object.values(allNodeMetrics);
  // effectiveMetrics: handles localhost sentinel mode + hosted fleet mode uniformly
  const effectiveMetrics: SentinelMetrics[] = isLocalHost ? (sentinel ? [sentinel] : []) : liveMetrics;

  // Tile 1 — THROUGHPUT: ∑ tok/s across actively-inferencing nodes
  const hasAnyOllama = effectiveMetrics.some(m => m.ollama_running);
  const tpsNodes     = effectiveMetrics.filter(m => m.ollama_running && m.ollama_tokens_per_second != null);
  const fleetTps     = tpsNodes.length > 0
    ? tpsNodes.reduce((acc, m) => acc + (m.ollama_tokens_per_second ?? 0), 0)
    : null;

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
  const fleetLiveCount  = effectiveMetrics.length;
  const fleetTotalCount = isLocalHost ? (sentinel != null ? 1 : 0) : nodes.length;

  // Tiles 5-7 — WES leaderboard + fleet average
  interface WESEntry { nodeId: string; hostname: string; wes: number | null; tps: number | null; watts: number | null; thermalState: string | null; nullReason: string; }
  const wesEntries: WESEntry[] = effectiveMetrics.map(m => {
    const tps      = m.ollama_tokens_per_second ?? null;
    const totalW   = (m.cpu_power_w ?? 0) + (m.nvidia_power_draw_w ?? 0);
    const hasWatts = m.cpu_power_w != null || m.nvidia_power_draw_w != null;
    const watts    = hasWatts ? totalW : null;
    const pue      = getNodeSettings?.(m.node_id)?.pue ?? 1.0;
    const wes      = computeWES(tps, watts, m.thermal_state, pue);
    const nullReason = tps == null || tps <= 0 ? 'no inference' : !hasWatts ? 'no power data' : '';
    return { nodeId: m.node_id, hostname: m.hostname ?? m.node_id, wes, tps, watts, thermalState: m.thermal_state, nullReason };
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

  // ── Thermal diversity ───────────────────────────────────────────────────────
  const thermalCounts: Record<string, number> = {};
  effectiveMetrics.forEach(m => {
    const state = m.thermal_state ?? derivedNvidiaThermal(m.nvidia_gpu_temp_c ?? null)?.label ?? null;
    if (state) thermalCounts[state] = (thermalCounts[state] ?? 0) + 1;
  });
  const allNormal      = effectiveMetrics.length > 0 && Object.keys(thermalCounts).every(s => ['normal', 'nominal'].includes(s.toLowerCase()));
  const hasThrottling  = Object.keys(thermalCounts).some(s => ['serious', 'critical'].includes(s.toLowerCase()));

  // ── Best Route Now ──────────────────────────────────────────────────────────
  const activeEntries = wesEntries.filter(e => e.tps != null && e.tps > 0);
  const sortedByTps   = [...activeEntries].sort((a, b) => (b.tps ?? 0) - (a.tps ?? 0));
  const sortedByWes   = [...activeEntries].filter(e => e.wes != null).sort((a, b) => (b.wes ?? 0) - (a.wes ?? 0));
  const bestLatNode   = sortedByTps[0] ?? null;
  const bestEffNode   = sortedByWes[0] ?? null;
  const sameNode      = bestLatNode != null && bestEffNode != null && bestLatNode.nodeId === bestEffNode.nodeId;
  const tpsDelta      = !sameNode && bestLatNode && bestEffNode && (bestEffNode.tps ?? 0) > 0
    ? (bestLatNode.tps ?? 0) / bestEffNode.tps! : null;
  const wesDelta      = !sameNode && bestEffNode?.wes != null && (bestLatNode?.wes ?? 0) > 0
    ? bestEffNode.wes / bestLatNode!.wes! : null;

  // Tile 6 — WATTAGE / 1K TKN: total power ÷ fleet throughput × 1000
  const wattPer1k = (() => {
    if (fleetTps == null || fleetTps <= 0) return null;
    const powerNodes = tpsNodes.filter(m => m.cpu_power_w != null || m.nvidia_power_draw_w != null);
    if (powerNodes.length === 0) return null;
    const totalPowerW = powerNodes.reduce((acc, m) =>
      acc + (m.cpu_power_w ?? 0) + (m.nvidia_power_draw_w ?? 0), 0);
    return (totalPowerW / fleetTps) * 1000;
  })();

  // Tile 7 — COST / 1K TOKENS: wattPer1k × fleet_kwh_rate / 1000
  const costPer1k = wattPer1k != null ? (wattPer1k / 1000) * fleetKwhRate : null;

  // Tile 8 — IDLE FLEET COST / DAY: ∑ idle_watts × pue_i × 24h × rate_i
  const idleFleetCostPerDay = (() => {
    const idle = effectiveMetrics.filter(m =>
      (!m.ollama_tokens_per_second || m.ollama_tokens_per_second <= 0) &&
      (m.cpu_power_w != null || m.nvidia_power_draw_w != null)
    );
    if (idle.length === 0) return null;
    return idle.reduce((acc, m) => {
      const ns = getNodeSettings?.(m.node_id);
      const pue = ns?.pue ?? 1.0;
      const rate = ns?.kwhRate ?? fleetKwhRate;
      const watts = (m.cpu_power_w ?? 0) + (m.nvidia_power_draw_w ?? 0);
      return acc + watts * pue * 24 * (rate / 1000);
    }, 0);
  })();
  const idlePowerNodes = effectiveMetrics.filter(m =>
    (m.cpu_power_w != null || m.nvidia_power_draw_w != null) &&
    (!m.ollama_tokens_per_second || m.ollama_tokens_per_second <= 0)
  );
  const avgPue = effectiveMetrics.length > 0
    ? effectiveMetrics.reduce((acc, m) => acc + (getNodeSettings?.(m.node_id)?.pue ?? 1.0), 0) / effectiveMetrics.length
    : 1.0;

  // ── SSE connection indicator (3-state) ──────────────────────────────────────
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

  // Build Fleet Status row data
  const nodeRows: NodeRowProps[] = isLocalHost
    ? (sentinel ? [{
        nodeId: sentinel.node_id,
        hostname: sentinel.hostname ?? sentinel.node_id,
        metrics: sentinel,
        pue: getNodeSettings?.(sentinel.node_id)?.pue ?? 1.0,
      }] : [])
    : nodes.map(n => ({
        nodeId: n.id,
        hostname: n.hostname,
        metrics: allNodeMetrics[n.id] ?? null,
        lastSeenMs: lastSeenMsMap[n.id],
        pue: getNodeSettings?.(n.id)?.pue ?? 1.0,
      }));

  return (
    <div className="space-y-6">
      {/* ── 8-tile Insight Engine: 2 rows × 4 cols ───────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">

        {/* ── Row 1: Performance & Health ─────────────────────────────────── */}

        {/* 1. THROUGHPUT */}
        <InsightTile
          label="Throughput"
          value={fleetTps != null ? `${fleetTps.toFixed(1)} tok/s` : '—'}
          valueCls={fleetTps == null ? 'text-gray-400 dark:text-gray-600' : undefined}
          sub={fleetTps != null
            ? `${tpsNodes.length} node${tpsNodes.length !== 1 ? 's' : ''} · sampled`
            : hasAnyOllama ? 'sampling every 30s' : 'no inference runtime'}
          icon={Activity}
          iconCls="text-indigo-400"
        />

        {/* 2. FLEET HEALTH */}
        <InsightTile
          label="Fleet Health"
          value={fleetHealthPct != null ? `${fleetHealthPct}%` : '—'}
          valueCls={fleetHealthCls}
          sub={fleetHealthPct != null ? 'Normal / Fair thermal' : 'no thermal data'}
          icon={Thermometer}
          iconCls="text-amber-400"
        />

        {/* 3. TOTAL FLEET VRAM */}
        <InsightTile
          label="Total Fleet VRAM"
          value={vramUtilPct != null ? `${vramUtilPct}%` : effectiveMetrics.length > 0 ? `${vramUsedGB} GB` : '—'}
          valueCls={vramUtilPct == null && effectiveMetrics.length === 0 ? 'text-gray-400 dark:text-gray-600' : undefined}
          sub={vramUtilPct != null ? `${vramUsedGB} / ${vramCapacityGB} GB` : vramUtilPct == null && effectiveMetrics.length > 0 ? `${vramUsedGB} GB used` : undefined}
          icon={Database}
          iconCls="text-blue-400"
        />

        {/* 4. FLEET NODES */}
        <InsightTile
          label="Fleet Nodes"
          value={fleetTotalCount > 0 ? `${fleetLiveCount} / ${fleetTotalCount}` : '—'}
          sub={fleetLiveCount > 0
            ? `${fleetLiveCount} online`
            : fleetTotalCount > 0 ? 'no nodes live' : undefined}
          icon={Server}
          iconCls="text-green-400"
        />

        {/* ── Row 2: Efficiency & ROI ──────────────────────────────────────── */}

        {/* 5. AVG WES */}
        <InsightTile
          label="Avg WES"
          value={formatWES(fleetAvgWES)}
          valueCls={wesColorClass(fleetAvgWES)}
          valueTitle={WES_TOOLTIP}
          sub={fleetAvgWES != null
            ? `${rankedWES.length} node${rankedWES.length !== 1 ? 's' : ''} · inference MPG`
            : wesEntries.length > 0 ? 'no active inference' : 'connect runtime'}
          icon={Zap}
          iconCls="text-amber-400"
        />

        {/* 6. WATTAGE / 1K TKN */}
        <InsightTile
          label="Wattage / 1k Tkn"
          value={wattPer1k != null ? `${wattPer1k.toFixed(1)} W` : '—'}
          valueCls={wattPer1k == null ? 'text-gray-400 dark:text-gray-600' : undefined}
          sub="per 1k tokens"
          icon={Zap}
          iconCls="text-emerald-400"
        />

        {/* 7. COST / 1K TOKENS */}
        <InsightTile
          label="Cost / 1k Tokens"
          value={costPer1k != null ? `$${costPer1k.toFixed(4)}` : '—'}
          valueCls={costPer1k == null ? 'text-gray-400 dark:text-gray-600' : undefined}
          sub={`at $${fleetKwhRate}/kWh`}
          icon={DollarSign}
          iconCls="text-cyan-400"
        />

        {/* 8. IDLE FLEET COST */}
        <InsightTile
          label="Idle Fleet Cost"
          value={idleFleetCostPerDay != null ? `$${idleFleetCostPerDay.toFixed(2)}/day` : '—'}
          valueCls={idleFleetCostPerDay == null ? 'text-gray-400 dark:text-gray-600' : undefined}
          sub={idleFleetCostPerDay != null
            ? `${idlePowerNodes.length} node${idlePowerNodes.length !== 1 ? 's' : ''} idle · PUE ${avgPue.toFixed(1)}`
            : 'no power data'}
          icon={DollarSign}
          iconCls="text-gray-400 dark:text-gray-500"
        />

      </div>

      {/* ── Fleet Status ─────────────────────────────────────────────────────── */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl shadow-sm dark:shadow-none overflow-hidden">
        {/* Section header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-gray-400" />
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Fleet Status</h3>
            <span className="text-[10px] text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full">
              {isLocalHost ? (sentinel ? '1' : '0') : nodes.length} node{(isLocalHost ? (sentinel ? 1 : 0) : nodes.length) !== 1 ? 's' : ''}
            </span>
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

        {nodeRows.length > 0 ? (
          <div className="overflow-x-auto">
            <FleetStatusHeader />
            <div className="divide-y divide-gray-100 dark:divide-gray-800">
              {nodeRows.map(row => (
                <FleetStatusRow key={row.nodeId} {...row} />
              ))}
            </div>
          </div>
        ) : (
          <div className="py-10 text-center text-sm text-gray-500">
            {isLocalHost ? 'Connecting to local agent…' : 'No nodes paired yet.'}
          </div>
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

      {/* ── Fleet Intelligence ────────────────────────────────────────────────── */}
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

            {/* 1. Fleet Throughput */}
            <FleetCard
              label="Fleet Throughput"
              sub={
                <p className="text-[10px] text-gray-600">
                  {fleetTps != null ? `across ${tpsNodes.length} active node${tpsNodes.length !== 1 ? 's' : ''}` : 'no active inference'}
                </p>
              }
            >
              <p className={`text-xl font-bold font-telin leading-none ${fleetTps != null ? 'text-green-400' : 'text-gray-600'}`}>
                {fleetTps != null ? `${fleetTps.toFixed(1)}` : '—'}
              </p>
              {fleetTps != null && <p className="text-[10px] text-gray-500 mt-0.5">tok/s</p>}
            </FleetCard>

            {/* 2. Fleet Avg WES */}
            <FleetCard
              label="Fleet Avg WES"
              sub={
                <p className="text-[10px] text-gray-600">
                  {fleetAvgWES != null ? `avg across ${rankedWES.length} node${rankedWES.length !== 1 ? 's' : ''}` : 'no active inference'}
                </p>
              }
            >
              <p
                className={`text-xl font-bold font-telin leading-none ${wesColorClass(fleetAvgWES)}`}
                title={fleetAvgWES != null && fleetAvgWES < 10
                  ? (() => {
                      const firstRanked = rankedWES[0];
                      const m = effectiveMetrics.find(x => x.node_id === firstRanked?.nodeId);
                      const w = firstRanked?.watts;
                      return wesBreakdownTitle(firstRanked?.tps ?? null, w ?? null, firstRanked?.thermalState ?? null, m?.chip_name ?? m?.gpu_name ?? null);
                    })()
                  : WES_TOOLTIP}
              >
                {formatWES(fleetAvgWES)}
              </p>
            </FleetCard>

            {/* 3. Idle Fleet Cost */}
            <FleetCard
              label="Idle Fleet Cost"
              sub={
                <p className="text-[10px] text-gray-600 leading-tight">
                  {idleFleetCostPerDay != null
                    ? `${idlePowerNodes.length} node${idlePowerNodes.length !== 1 ? 's' : ''} at idle · est. at current draw`
                    : fleetKwhRate === 0.12 ? 'Set your kWh rate in Settings for accurate costs' : 'no power data'}
                </p>
              }
            >
              <p className={`text-xl font-bold font-telin leading-none ${idleFleetCostPerDay != null ? 'text-gray-200' : 'text-gray-600'}`}>
                {idleFleetCostPerDay != null ? `$${idleFleetCostPerDay.toFixed(2)}` : '—'}
              </p>
              {idleFleetCostPerDay != null && <p className="text-[10px] text-gray-500 mt-0.5">/day</p>}
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

            {/* 5. Best Route Now — spans both columns */}
            <FleetCard label="Best Route Now" className="col-span-2">
              {activeEntries.length === 0 ? (
                <p className="text-sm font-telin text-gray-600">— no active inference</p>
              ) : activeEntries.length === 1 ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">→</span>
                  <span className="text-sm font-bold font-telin text-gray-200">{activeEntries[0].nodeId}</span>
                  <span className="text-xs text-gray-500">(only active node)</span>
                </div>
              ) : sameNode ? (
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
                    <span className={`text-xs font-telin ml-auto ${wesColorClass(bestEffNode!.wes)}`}>WES {formatWES(bestEffNode!.wes)}</span>
                  </div>
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
    </div>
  );
};

export default Overview;
