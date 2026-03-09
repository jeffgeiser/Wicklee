import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Thermometer, Cpu, Database, Zap, ArrowUpRight, ArrowDownRight, Info, Activity, Cloud, CloudLightning, Download, Terminal, Plus, ChevronDown } from 'lucide-react';
import { NodeAgent, PairingInfo, SentinelMetrics } from '../types';
import { SentinelCard, HardwareDetailPanel, thermalColour, derivedNvidiaThermal } from './NodeHardwarePanel';
import EventFeed from './EventFeed';

const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

interface OverviewProps {
  nodes: NodeAgent[];
  isPro?: boolean;
  pairingInfo?: PairingInfo | null;
  onOpenPairing?: () => void;
  onAddNode?: () => void;
  onTelemetryUpdate?: () => void;
}

const MOCK_HISTORY = Array.from({ length: 20 }).map((_, i) => ({
  time: `${i}:00`,
  requests: Math.floor(Math.random() * 50) + 10,
  latency: Math.floor(Math.random() * 100) + 200,
}));

const StatCard: React.FC<{ title: React.ReactNode; value: React.ReactNode; icon: React.ElementType; trend?: string; color: string }> = ({ title, value, icon: Icon, trend, color }) => (
  <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 hover:border-gray-300 dark:hover:border-gray-700 transition-all shadow-sm dark:shadow-none">
    <div className="flex items-start justify-between">
      <div className={`flex items-center justify-center w-10 h-10 rounded-lg ${color}/10`}>
        <Icon size={20} className={color.replace('bg-', 'text-')} />
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

// ── Collapsible node row used in the All Nodes accordion ─────────────────────
interface NodeRowProps {
  nodeId: string;
  hostname: string;
  metrics: SentinelMetrics | null;
  defaultOpen?: boolean;
}

const NodeRow: React.FC<NodeRowProps> = ({ nodeId, hostname, metrics: m, defaultOpen = false }) => {
  const [open, setOpen] = useState(defaultOpen);

  const isOnline = m !== null;
  const cpuStr = m ? `${m.cpu_usage_percent.toFixed(0)}%` : '—';
  const gpuStr = m?.nvidia_gpu_utilization_percent != null
    ? `${m.nvidia_gpu_utilization_percent.toFixed(0)}%`
    : m?.gpu_utilization_percent != null
    ? `${m.gpu_utilization_percent.toFixed(0)}%`
    : '—';
  const memPressStr = m?.memory_pressure_percent != null
    ? `${m.memory_pressure_percent.toFixed(0)}%`
    : '—';
  const nvThermal   = m && m.thermal_state == null ? derivedNvidiaThermal(m.nvidia_gpu_temp_c ?? null) : null;
  const thermalStr  = m?.thermal_state ?? nvThermal?.label ?? '—';
  const thermalCls  = m?.thermal_state != null ? thermalColour(m.thermal_state) : (nvThermal?.colour ?? 'text-gray-400');

  return (
    <div className="border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors text-left"
      >
        {/* Status dot */}
        <span className={`shrink-0 w-2 h-2 rounded-full ${isOnline ? 'bg-green-500' : 'bg-gray-500'}`} />

        {/* Node identity */}
        <div className="min-w-0 flex-shrink-0 max-w-[200px]">
          <span className="font-mono text-xs font-bold text-gray-900 dark:text-white">{nodeId}</span>
          {hostname !== nodeId && (
            <span className="ml-2 text-xs text-gray-500 dark:text-gray-400 truncate">{hostname}</span>
          )}
          {m?.gpu_name && (
            <p className="text-[10px] text-indigo-400/80 truncate mt-0.5">{m.gpu_name}</p>
          )}
        </div>
        <span className={`text-[10px] font-semibold shrink-0 ${isOnline ? 'text-green-600 dark:text-green-400' : 'text-gray-500'}`}>
          {isOnline ? 'online' : 'offline'}
        </span>

        {/* Quick stats */}
        <div className="flex-1 flex items-center gap-4 justify-end text-[11px] text-gray-500 dark:text-gray-400 font-mono">
          <span>CPU: <span className="text-gray-700 dark:text-gray-300 font-semibold">{cpuStr}</span></span>
          <span className="hidden sm:inline">GPU: <span className="text-gray-700 dark:text-gray-300 font-semibold">{gpuStr}</span></span>
          <span className="hidden sm:inline">Mem: <span className="text-gray-700 dark:text-gray-300 font-semibold">{memPressStr}</span></span>
          <span className="hidden md:inline">
            Thermal: <span className={`font-semibold ${thermalCls}`}>{thermalStr}</span>
          </span>
        </div>

        <ChevronDown className={`w-4 h-4 text-gray-400 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="px-4 pb-4 pt-3 border-t border-gray-200 dark:border-gray-800">
          {m ? (
            <HardwareDetailPanel metrics={m} />
          ) : (
            <p className="text-sm text-gray-500 text-center py-6">No telemetry received yet — make sure the agent is running.</p>
          )}
        </div>
      )}
    </div>
  );
};

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
          body: <p className="mt-2 text-xs text-gray-500">Click "Connect to Fleet" in the header to get your 6-digit pairing code.</p>,
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
const Overview: React.FC<OverviewProps> = ({ nodes, isPro, pairingInfo, onOpenPairing, onAddNode, onTelemetryUpdate }) => {
  const [sentinel, setSentinel] = useState<SentinelMetrics | null>(null);
  const [connected, setConnected] = useState(false);
  const [transport, setTransport] = useState<'ws' | 'sse' | null>(null);
  const [allNodeMetrics, setAllNodeMetrics] = useState<Record<string, SentinelMetrics>>({});

  interface CpuPoint { time: string; cpu: number; mem: number; }
  const [cpuHistory, setCpuHistory] = useState<CpuPoint[]>([]);
  const MAX_HISTORY = 60;

  const wsRef = useRef<WebSocket | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const CLOUD_SSE_URL = (() => {
    const v = (import.meta.env.VITE_CLOUD_URL ?? '') as string;
    const base = !v ? 'https://vibrant-fulfillment-production-62c0.up.railway.app'
      : v.startsWith('http') ? v : `https://${v}`;
    return `${base}/api/fleet/stream`;
  })();

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
      const connectCloudSSE = () => {
        const es = new EventSource(CLOUD_SSE_URL);
        esRef.current = es;
        es.onopen = () => { setTransport('sse'); setConnected(true); };
        es.onmessage = (ev) => {
          try {
            const fleet = JSON.parse(ev.data) as { nodes: Array<{ node_id: string; last_seen_ms: number; metrics: SentinelMetrics | null }> };
            const updated: Record<string, SentinelMetrics> = {};
            for (const n of fleet.nodes) {
              if (n.metrics) updated[n.node_id] = n.metrics;
            }
            if (Object.keys(updated).length > 0) {
              setAllNodeMetrics(prev => ({ ...prev, ...updated }));
              onTelemetryUpdate?.();
              setTransport('sse');
            }
          } catch { /* malformed frame */ }
        };
        es.onerror = () => {
          setConnected(false);
          es.close();
          esRef.current = null;
          retrySse = setTimeout(connectCloudSSE, 3000);
        };
      };
      connectCloudSSE();
    }

    return () => {
      clearTimeout(retryWs);
      clearTimeout(retrySse);
      wsRef.current?.close();
      esRef.current?.close();
    };
  }, [handleMetrics, CLOUD_SSE_URL]);

  if (!isLocalHost && nodes.length === 0) {
    return <EmptyFleetState onAddNode={onAddNode} />;
  }

  const activeNodes = isPro ? nodes : nodes.slice(0, 1);
  const totalRPS   = activeNodes.reduce((acc, n) => acc + n.requestsPerSecond, 0);
  const avgTemp    = activeNodes.length > 0
    ? (activeNodes.reduce((acc, n) => acc + (n.gpuTemp ?? 0), 0) / activeNodes.length).toFixed(1)
    : '—';
  const totalVRAM      = activeNodes.reduce((acc, n) => acc + (n.vramUsed ?? 0), 0).toFixed(1);
  const totalWattage   = activeNodes.reduce((acc, n) => acc + (n.powerUsage ?? 0), 0);
  const hasTDP         = activeNodes.every(n => n.tdp !== undefined);
  const wattagePer1kTokens = totalRPS > 0 ? ((totalWattage / (totalRPS * 500)) * 1000).toFixed(1) : '0.0';
  const costPer1kTokens    = totalRPS > 0 ? ((totalWattage / (totalRPS * 500)) * 0.00015).toFixed(6) : '0.000000';

  // Build the accordion row data
  const nodeRows: NodeRowProps[] = isLocalHost
    ? (sentinel ? [{ nodeId: sentinel.node_id, hostname: sentinel.hostname ?? sentinel.node_id, metrics: sentinel, defaultOpen: true }] : [])
    : nodes.map((n, idx) => ({ nodeId: n.id, hostname: n.hostname, metrics: allNodeMetrics[n.id] ?? null, defaultOpen: idx === 0 }));

  return (
    <div className="space-y-6">
      {/* ── Fleet stat cards ─────────────────────────────────────────────────── */}
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
                  Calculated from GPU TDP × utilization ÷ tokens generated.
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
          icon={Zap} trend="-3.2%" color="bg-emerald-500"
        />
        <StatCard
          title="Cost per 1k Tokens"
          value={
            <div>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">${costPer1kTokens}</p>
              <p className="text-[10px] text-gray-500 font-medium">per 1k tokens</p>
            </div>
          }
          icon={Zap} trend="-8.2%" color="bg-cyan-400"
        />
        <StatCard title="Fleet Nodes" value={<p className="text-2xl font-bold text-gray-900 dark:text-white">{nodes.length.toString()}</p>} icon={Cpu} color="bg-green-500" />
      </div>

      {/* ── All Nodes accordion ──────────────────────────────────────────────── */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 shadow-sm dark:shadow-none">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-gray-400" />
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">All Nodes</h3>
            <span className="text-[10px] text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full">
              {isLocalHost ? (sentinel ? '1' : '0') : nodes.length} node{(isLocalHost ? (sentinel ? 1 : 0) : nodes.length) !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              {connected && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />}
              <span className={`relative inline-flex rounded-full h-2 w-2 ${connected ? 'bg-green-500' : 'bg-gray-500'}`} />
            </span>
            <span className={`text-[10px] font-medium ${connected ? 'text-green-600 dark:text-green-400' : 'text-gray-500'}`}>
              {connected ? (transport === 'ws' ? 'Live · WS' : 'Live · SSE') : 'Reconnecting…'}
            </span>
          </div>
        </div>

        {nodeRows.length > 0 ? (
          <div className="space-y-2">
            {nodeRows.map((row) => (
              <NodeRow key={row.nodeId} {...row} />
            ))}
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
              <div className="flex items-center gap-4">
                <div className="relative shrink-0">
                  <span className="animate-ping absolute inline-flex h-5 w-5 rounded-full bg-green-400 opacity-20" />
                  <CloudLightning className="w-5 h-5 text-green-400 relative" />
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-0.5">
                    <p className="text-sm font-bold text-white">Connected to Fleet</p>
                    <span className="text-[10px] font-mono bg-green-500/10 text-green-400 border border-green-500/20 rounded px-1.5 py-0.5">{pairingInfo.node_id}</span>
                  </div>
                  <p className="text-[11px] font-mono text-gray-500">wicklee.dev</p>
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
                <XAxis dataKey="time" stroke="#9ca3af" fontSize={10} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis stroke="#9ca3af" fontSize={10} axisLine={false} tickLine={false} domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} />
                <Tooltip
                  contentStyle={{ backgroundColor: 'var(--tooltip-bg, #1f2937)', border: '1px solid #374151', borderRadius: '8px', fontSize: '12px' }}
                  formatter={(value: number, name: string) => [`${value.toFixed(1)}%`, name === 'cpu' ? 'CPU' : 'Memory']}
                />
                <Area type="monotone" dataKey={cpuHistory.length > 0 ? 'cpu' : 'requests'} name="cpu" stroke="#6366f1" fillOpacity={1} fill="url(#colorCpu)" strokeWidth={2} dot={false} isAnimationActive={false} />
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
