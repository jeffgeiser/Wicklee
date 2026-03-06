import React, { useState, useEffect, useRef, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts';
import { Thermometer, Cpu, Database, Zap, ArrowUpRight, ArrowDownRight, Info, Activity, MemoryStick, Wind, Cloud, CloudLightning } from 'lucide-react';
import { NodeAgent, PairingInfo } from '../types';
import EventFeed from './EventFeed';

interface OverviewProps {
  nodes: NodeAgent[];
  isPro?: boolean;
  pairingInfo?: PairingInfo | null;
  onOpenPairing?: () => void;
}

// ── SSE payload shape (mirrors MetricsPayload in agent/src/main.rs) ──────────
interface SentinelMetrics {
  node_id: string;
  cpu_usage_percent: number;
  total_memory_mb: number;
  used_memory_mb: number;
  available_memory_mb: number;
  cpu_core_count: number;
  timestamp_ms: number;
  // Apple Silicon deep-metal (null on non-Apple / no-sudo)
  cpu_power_w:             number | null;
  ecpu_power_w:            number | null;
  pcpu_power_w:            number | null;
  gpu_utilization_percent: number | null;
  memory_pressure_percent: number | null;
  thermal_state:           string | null;
  // NVIDIA GPU fields (null on non-NVIDIA platforms)
  nvidia_gpu_utilization_percent: number | null;
  nvidia_vram_used_mb:            number | null;
  nvidia_vram_total_mb:           number | null;
  nvidia_gpu_temp_c:              number | null;
  nvidia_power_draw_w:            number | null;
}

const MOCK_HISTORY = Array.from({ length: 20 }).map((_, i) => ({
  time: `${i}:00`,
  requests: Math.floor(Math.random() * 50) + 10,
  latency: Math.floor(Math.random() * 100) + 200,
}));

const StatCard: React.FC<{ title: React.ReactNode; value: React.ReactNode; icon: React.ElementType; trend?: string; color: string }> = ({ title, value, icon: Icon, trend, color }) => (
  <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 hover:border-gray-300 dark:hover:border-gray-700 transition-all shadow-sm dark:shadow-none">
    <div className="flex items-start justify-between">
      <div className={`p-2 rounded-xl bg-opacity-10 ${color}`}>
        <Icon className={`w-5 h-5 ${color.replace('bg-', 'text-')}`} />
      </div>
      {trend && (
        <span className={`flex items-center text-xs font-medium ${trend.startsWith('+') ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
          {trend.startsWith('+') ? <ArrowUpRight className="w-3 h-3 mr-1" /> : <ArrowDownRight className="w-3 h-3 mr-1" />}
          {trend}
        </span>
      )}
    </div>
    <div className="mt-4">
      <h4 className="text-gray-500 dark:text-gray-400 text-xs font-medium uppercase tracking-wider">{title}</h4>
      <div className="mt-1">{value}</div>
    </div>
  </div>
);

// Compact card used in the Sentinel hardware row
const SentinelCard: React.FC<{
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  accent: string;
}> = ({ label, value, sub, icon: Icon, accent }) => (
  <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4 flex items-center gap-3 min-w-0">
    <div className={`shrink-0 p-2 rounded-lg ${accent} bg-opacity-10`}>
      <Icon className={`w-4 h-4 ${accent.replace('bg-', 'text-')}`} />
    </div>
    <div className="min-w-0">
      <p className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wider font-medium truncate">{label}</p>
      <p className="text-base font-bold text-gray-900 dark:text-white leading-tight truncate">{value}</p>
      {sub && <p className="text-[10px] text-gray-400 dark:text-gray-500 truncate">{sub}</p>}
    </div>
  </div>
);

// Thermal state → badge colours
const thermalColour = (state: string | null) => {
  switch (state?.toLowerCase()) {
    case 'normal':   return 'text-green-400';
    case 'elevated': return 'text-yellow-400';
    case 'high':     return 'text-orange-400';
    case 'critical': return 'text-red-400';
    default:         return 'text-gray-400';
  }
};

const Overview: React.FC<OverviewProps> = ({ nodes, isPro, pairingInfo, onOpenPairing }) => {
  const activeNodes = isPro ? nodes : nodes.slice(0, 1);
  const totalRPS = activeNodes.reduce((acc, n) => acc + n.requestsPerSecond, 0);
  const avgTemp = (activeNodes.reduce((acc, n) => acc + n.gpuTemp, 0) / activeNodes.length).toFixed(1);
  const totalVRAM = activeNodes.reduce((acc, n) => acc + n.vramUsed, 0).toFixed(1);
  const totalWattage = activeNodes.reduce((acc, n) => acc + n.powerUsage, 0);

  const hasTDP = activeNodes.every(n => n.tdp !== undefined);

  const wattagePer1kTokens = totalRPS > 0
    ? ((totalWattage / (totalRPS * 500)) * 1000).toFixed(1)
    : "0.0";

  const costPer1kTokens = totalRPS > 0
    ? ((totalWattage / (totalRPS * 500)) * 0.00015).toFixed(6)
    : "0.000000";

  // ── Live telemetry — WS primary (10 Hz), SSE fallback (1 Hz) ──────────────
  const [sentinel, setSentinel] = useState<SentinelMetrics | null>(null);
  const [connected, setConnected] = useState(false);
  const [transport, setTransport] = useState<'ws' | 'sse' | null>(null);

  // Ring-buffer for the live performance chart (max 60 points = 6 s at 10 Hz)
  interface CpuPoint { time: string; cpu: number; mem: number; }
  const [cpuHistory, setCpuHistory] = useState<CpuPoint[]>([]);
  const MAX_HISTORY = 60;

  const wsRef = useRef<WebSocket | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const handleMetrics = useCallback((data: SentinelMetrics) => {
    setSentinel(data);
    setConnected(true);
    setCpuHistory(prev => {
      const ts  = new Date(data.timestamp_ms);
      const lbl = `${ts.getMinutes().toString().padStart(2, '0')}:${ts.getSeconds().toString().padStart(2, '0')}`;
      const pt  = { time: lbl, cpu: data.cpu_usage_percent, mem: (data.used_memory_mb / (data.total_memory_mb || 1)) * 100 };
      const next = [...prev, pt];
      return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
    });
  }, []);

  useEffect(() => {
    let retryWs:  ReturnType<typeof setTimeout>;
    let retrySse: ReturnType<typeof setTimeout>;
    let wsFailed  = false;

    const connectSSE = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) return; // WS recovered
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
          // WS is healthy — close the SSE fallback if it was running
          if (esRef.current) { esRef.current.close(); esRef.current = null; }
        } catch { /* malformed frame */ }
      };

      ws.onerror = () => { wsFailed = true; };

      ws.onclose = () => {
        wsRef.current = null;
        setConnected(false);
        if (wsFailed) {
          // Server doesn't support WS yet — fall back permanently to SSE
          connectSSE();
        } else {
          // Transient disconnect — retry WS, SSE picks up the gap
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

  // Derived display values (show "—" until first SSE frame arrives)
  const cpuPct      = sentinel ? `${sentinel.cpu_usage_percent.toFixed(1)}%`         : '—';
  const memUsed     = sentinel ? `${(sentinel.used_memory_mb / 1024).toFixed(1)} GB`  : '—';
  const memTotal    = sentinel ? `${(sentinel.total_memory_mb / 1024).toFixed(0)} GB` : '';
  const memAvail    = sentinel ? `${(sentinel.available_memory_mb / 1024).toFixed(1)} GB` : '—';
  const coreCount   = sentinel ? `${sentinel.cpu_core_count} cores`                   : '—';
  const cpuPowerStr = sentinel?.cpu_power_w    != null ? `${sentinel.cpu_power_w.toFixed(1)} W`    : null;
  const gpuUtilStr  = sentinel?.gpu_utilization_percent != null ? `${sentinel.gpu_utilization_percent.toFixed(0)}%` : null;
  const memPressStr = sentinel?.memory_pressure_percent != null ? `${sentinel.memory_pressure_percent.toFixed(0)}%` : null;
  // NVIDIA display strings
  const nvidiaGpuUtilStr = sentinel?.nvidia_gpu_utilization_percent != null
    ? `${sentinel.nvidia_gpu_utilization_percent.toFixed(0)}%` : null;
  const nvidiaVramStr = sentinel?.nvidia_vram_used_mb != null && sentinel?.nvidia_vram_total_mb != null
    ? `${(sentinel.nvidia_vram_used_mb / 1024).toFixed(1)} GB` : null;
  const nvidiaVramTotalStr = sentinel?.nvidia_vram_total_mb != null
    ? `${(sentinel.nvidia_vram_total_mb / 1024).toFixed(0)} GB` : null;
  const nvidiaTempStr  = sentinel?.nvidia_gpu_temp_c   != null ? `${sentinel.nvidia_gpu_temp_c}°C`            : null;
  const nvidiaPowerStr = sentinel?.nvidia_power_draw_w != null ? `${sentinel.nvidia_power_draw_w.toFixed(1)} W` : null;
  // Show the hardware row when any platform-specific metrics are live.
  const hasHardwareRow = gpuUtilStr !== null || memPressStr !== null
    || nvidiaGpuUtilStr !== null || nvidiaVramStr !== null;

  return (
    <div className="space-y-6">
      {/* ── Fleet stat cards ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 [&>*]:min-w-0">
        <StatCard title="Throughput" value={<p className="text-2xl font-bold text-gray-900 dark:text-white">{totalRPS.toFixed(1)} req/s</p>} icon={Zap} trend="+12.4%" color="bg-amber-500" />
        <StatCard title="Avg Temperature" value={<p className="text-2xl font-bold text-gray-900 dark:text-white">{avgTemp}°C</p>} icon={Thermometer} trend="-2.1%" color="bg-red-500" />
        <StatCard title="Total VRAM Usage" value={<p className="text-2xl font-bold text-gray-900 dark:text-white">{totalVRAM} GB</p>} icon={Database} trend="+4.3%" color="bg-blue-600" />
        <StatCard
          title={
            <div className="flex items-center gap-1.5">
              <span>Wattage / 1k tkn</span>
              <div className="group relative">
                <Info className="w-3 h-3 text-gray-400 cursor-help" />
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 p-2 bg-gray-900 text-[10px] text-gray-300 rounded-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 shadow-xl border border-white/10">
                  Calculated from GPU TDP × utilization ÷ tokens generated. Set your GPU TDP in Settings to calibrate this number.
                </div>
              </div>
            </div>
          }
          value={
            hasTDP ? (
              <div>
                <p className="text-2xl font-bold text-gray-900 dark:text-white">{wattagePer1kTokens}W</p>
                <p className="text-[10px] text-gray-500 font-medium">per 1,000 tokens</p>
              </div>
            ) : (
              <button className="text-left group">
                <p className="text-[11px] font-bold text-blue-600 dark:text-blue-400 group-hover:underline leading-tight">
                  Configure GPU TDP to see cost metrics →
                </p>
              </button>
            )
          }
          icon={Zap}
          trend="-3.2%"
          color="bg-emerald-500"
        />
        <StatCard
          title="Cost per 1k Tokens"
          value={
            <div>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">${costPer1kTokens}</p>
              <p className="text-[10px] text-gray-500 font-medium">per 1k tokens</p>
            </div>
          }
          icon={Zap}
          trend="-8.2%"
          color="bg-cyan-400"
        />
        <StatCard title="Fleet Nodes" value={<p className="text-2xl font-bold text-gray-900 dark:text-white">{nodes.length.toString()}</p>} icon={Cpu} color="bg-green-500" />
      </div>

      {/* ── Sentinel live hardware telemetry ────────────────────────────────── */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 shadow-sm dark:shadow-none">
        {/* Header with SSE connection dot */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-gray-400" />
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              Sentinel Node — Live Hardware
            </h3>
            {sentinel?.node_id && (
              <span className="text-[10px] font-mono text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded">
                {sentinel.node_id}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              {connected && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              )}
              <span className={`relative inline-flex rounded-full h-2 w-2 ${connected ? 'bg-green-500' : 'bg-gray-500'}`} />
            </span>
            <span className={`text-[10px] font-medium ${connected ? 'text-green-600 dark:text-green-400' : 'text-gray-500'}`}>
              {connected ? (transport === 'ws' ? 'Live · WS' : 'Live · SSE') : 'Reconnecting…'}
            </span>
          </div>
        </div>

        {/* Core metrics row */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <SentinelCard label="CPU Usage"      value={cpuPct}   icon={Cpu}         accent="bg-indigo-500" />
          <SentinelCard label="Memory Used"    value={memUsed}  sub={memTotal ? `of ${memTotal}` : undefined} icon={MemoryStick} accent="bg-blue-500" />
          <SentinelCard label="Mem Available"  value={memAvail} icon={Database}    accent="bg-sky-500" />
          <SentinelCard label="CPU Cores"      value={coreCount} icon={Cpu}        accent="bg-violet-500" />

          {/* Thermal state — shown with dynamic colour when data is available */}
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4 flex items-center gap-3 min-w-0">
            <div className="shrink-0 p-2 rounded-lg bg-orange-500 bg-opacity-10">
              <Thermometer className="w-4 h-4 text-orange-400" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wider font-medium">Thermal State</p>
              <p className={`text-base font-bold leading-tight ${thermalColour(sentinel?.thermal_state ?? null)}`}>
                {sentinel?.thermal_state ?? '—'}
              </p>
            </div>
          </div>
        </div>

        {/* Hardware deep-metal row — rendered when any platform-specific metrics are live */}
        {hasHardwareRow && (
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {/* ── Apple Silicon ── */}
            {(gpuUtilStr !== null || memPressStr !== null) && (
              cpuPowerStr ? (
                <SentinelCard label="CPU Power" value={cpuPowerStr}
                  sub={sentinel!.ecpu_power_w != null && sentinel!.pcpu_power_w != null
                    ? `E ${sentinel!.ecpu_power_w!.toFixed(1)}W  P ${sentinel!.pcpu_power_w!.toFixed(1)}W`
                    : undefined}
                  icon={Zap} accent="bg-amber-500" />
              ) : (
                <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4 flex items-center gap-3 min-w-0">
                  <div className="shrink-0 p-2 rounded-lg bg-amber-500 bg-opacity-10">
                    <Zap className="w-4 h-4 text-amber-500 opacity-40" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wider font-medium">CPU Power</p>
                    <p className="text-[11px] font-semibold text-gray-400 dark:text-gray-500 leading-tight">—</p>
                    <p className="text-[9px] text-gray-500 dark:text-gray-600 font-mono leading-tight mt-0.5">requires elevated permissions</p>
                  </div>
                </div>
              )
            )}
            {gpuUtilStr && (
              <SentinelCard label="GPU Utilization" value={gpuUtilStr} icon={Activity} accent="bg-purple-500" />
            )}
            {memPressStr && (
              <SentinelCard label="Mem Pressure" value={memPressStr} icon={Wind} accent="bg-rose-500" />
            )}
            {/* ── NVIDIA ── */}
            {nvidiaGpuUtilStr && (
              <SentinelCard label="NVIDIA GPU" value={nvidiaGpuUtilStr} icon={Activity} accent="bg-green-500" />
            )}
            {nvidiaVramStr && (
              <SentinelCard label="VRAM Used" value={nvidiaVramStr}
                sub={nvidiaVramTotalStr ? `of ${nvidiaVramTotalStr}` : undefined}
                icon={Database} accent="bg-emerald-500" />
            )}
            {nvidiaTempStr && (
              <SentinelCard label="GPU Temp" value={nvidiaTempStr} icon={Thermometer} accent="bg-orange-500" />
            )}
            {nvidiaPowerStr && (
              <SentinelCard label="Board Power" value={nvidiaPowerStr} icon={Zap} accent="bg-yellow-500" />
            )}
          </div>
        )}
      </div>

      {/* ── Fleet Connect card ──────────────────────────────────────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
        {(!pairingInfo || pairingInfo.status === 'unpaired') && (
          <div className="sm:grid sm:grid-cols-2 gap-6 flex flex-col">
            <div className="flex flex-col justify-between gap-4">
              <div className="flex items-center gap-3">
                <Cloud className="w-5 h-5 text-gray-400" />
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wider font-bold">Sentinel Identity</p>
                  <p className="text-sm font-mono font-bold text-white">{pairingInfo?.node_id ?? '—'}</p>
                </div>
              </div>
              <p className="text-xs text-gray-500">
                Enter your pairing code at wicklee.dev to connect this node to your fleet.
              </p>
              <button
                onClick={onOpenPairing}
                className="self-start px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold rounded-xl transition-all shadow-lg shadow-indigo-500/20"
              >
                Connect to Fleet →
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
              <p className="text-3xl font-mono font-bold text-white tracking-[0.3em]">
                {pairingInfo.code ? `${pairingInfo.code.slice(0, 3)} ${pairingInfo.code.slice(3)}` : '——'}
              </p>
              {pairingInfo.expires_at && (
                <p className="text-[11px] text-amber-400 font-mono">
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
            <div className="flex items-center gap-3">
              <CloudLightning className="w-5 h-5 text-green-400" />
              <div>
                <p className="text-sm font-bold text-white">Connected to Fleet</p>
                <p className="text-[11px] font-mono text-gray-500">{pairingInfo.fleet_url}</p>
              </div>
            </div>
            <button
              onClick={onOpenPairing}
              className="px-3 py-1.5 border border-red-500/30 hover:border-red-500/60 text-red-400 hover:text-red-300 text-xs font-medium rounded-xl transition-all"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>

      {/* ── Charts + event feed ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-6 shadow-sm dark:shadow-none">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-6">
            <h3 className="font-semibold text-gray-800 dark:text-gray-200">
              System Performance
              {cpuHistory.length > 0 && <span className="ml-2 text-[10px] font-mono text-indigo-400 font-normal">LIVE · {transport === 'ws' ? '10 Hz' : '1 Hz'}</span>}
            </h3>
            <select className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-xs rounded-lg px-2 py-1 outline-none text-gray-600 dark:text-gray-400">
              <option>Last 24 Hours</option>
              <option>Last 7 Days</option>
            </select>
          </div>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={cpuHistory.length > 0 ? cpuHistory : MOCK_HISTORY}>
                <defs>
                  <linearGradient id="colorCpu" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#6366f1" stopOpacity={0.35}/>
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorMem" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#22d3ee" stopOpacity={0.25}/>
                    <stop offset="95%" stopColor="#22d3ee" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-gray-200 dark:text-gray-800" vertical={false} />
                <XAxis
                  dataKey="time"
                  stroke="#9ca3af"
                  fontSize={10}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  stroke="#9ca3af"
                  fontSize={10}
                  axisLine={false}
                  tickLine={false}
                  domain={[0, 100]}
                  tickFormatter={(v: number) => `${v}%`}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: 'var(--tooltip-bg, #1f2937)', border: '1px solid #374151', borderRadius: '8px', fontSize: '12px' }}
                  formatter={(value: number, name: string) => [`${value.toFixed(1)}%`, name === 'cpu' ? 'CPU' : 'Memory']}
                />
                <Area type="monotone" dataKey={cpuHistory.length > 0 ? 'cpu'      : 'requests'} name="cpu" stroke="#6366f1" fillOpacity={1} fill="url(#colorCpu)" strokeWidth={2} dot={false} isAnimationActive={false} />
                {cpuHistory.length > 0 && (
                  <Area type="monotone" dataKey="mem" name="mem" stroke="#22d3ee" fillOpacity={1} fill="url(#colorMem)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="lg:col-span-1 h-full min-h-[400px]">
          <EventFeed nodes={activeNodes} />
        </div>
      </div>
    </div>
  );
};

export default Overview;
