import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Thermometer, Cpu, Database, Zap, Activity, Cloud, CloudLightning, Download, Terminal, Plus, ChevronDown, BrainCircuit, Check, Gauge, DollarSign, Server, Star, AlertTriangle, Info, BotMessageSquare } from 'lucide-react';
import { computeWES, formatWES, wesColorClass } from '../utils/wes';
import { ConnectionState, NodeAgent, PairingInfo, SentinelMetrics, FleetEvent } from '../types';
import { HardwareDetailPanel, thermalColour, derivedNvidiaThermal } from './NodeHardwarePanel';
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
  nodePueSettings?: Record<string, number>;
  onUpdateNodePue?: (nodeId: string, pue: number) => void;
  onCopyPueToAll?: (pue: number) => void;
}

const MOCK_HISTORY = Array.from({ length: 20 }).map((_, i) => ({
  time: `${i}:00`,
  requests: Math.floor(Math.random() * 50) + 10,
  latency: Math.floor(Math.random() * 100) + 200,
}));

// Primary: WES + Throughput — larger footprint, higher contrast border
const PrimaryStatCard: React.FC<{ title: React.ReactNode; value: React.ReactNode; icon: React.ElementType; color: string }> = ({ title, value, icon: Icon, color }) => (
  <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl p-6 hover:border-gray-300 dark:hover:border-gray-600 transition-all shadow-sm dark:shadow-none">
    <div className="flex items-center gap-3">
      <div className={`flex items-center justify-center w-10 h-10 rounded-xl ${color}/10`}>
        <Icon size={20} className={color.replace('bg-', 'text-')} />
      </div>
      <h4 className="text-gray-500 dark:text-gray-400 text-xs font-medium uppercase tracking-wider">{title}</h4>
    </div>
    <div className="mt-5">{value}</div>
  </div>
);

// Secondary: supporting metrics — compact 4-col grid
const StatCard: React.FC<{ title: React.ReactNode; value: React.ReactNode; icon: React.ElementType; color: string }> = ({ title, value, icon: Icon, color }) => (
  <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 hover:border-gray-300 dark:hover:border-gray-700 transition-all shadow-sm dark:shadow-none">
    <div className={`flex items-center justify-center w-9 h-9 rounded-lg ${color}/10`}>
      <Icon size={17} className={color.replace('bg-', 'text-')} />
    </div>
    <div className="mt-3">
      <h4 className="text-gray-500 dark:text-gray-400 text-[10px] font-medium uppercase tracking-wider">{title}</h4>
      <div className="mt-1">{value}</div>
    </div>
  </div>
);

const fmtAgo = (ms: number): string => {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

// ── Compact inference + hardware summary for Fleet Overview expansions ────────
// Full HardwareDetailPanel belongs in Node Registry only.
const FleetNodeSummary: React.FC<{ m: SentinelMetrics; pue: number }> = ({ m, pue }) => {
  const ollamaTps   = m.ollama_tokens_per_second;
  const totalPowerW = (m.cpu_power_w ?? 0) + (m.nvidia_power_draw_w ?? 0);
  const hasPower    = m.cpu_power_w != null || m.nvidia_power_draw_w != null;
  const wPer1kStr   = ollamaTps != null && ollamaTps > 0 && hasPower
    ? `${((totalPowerW / ollamaTps) * 1000).toFixed(0)} W/1k` : null;
  const wes         = computeWES(ollamaTps, hasPower ? totalPowerW : null, m.thermal_state, pue);

  const nvThermal    = m.thermal_state == null ? derivedNvidiaThermal(m.nvidia_gpu_temp_c ?? null) : null;
  const thermalLabel = m.thermal_state ?? nvThermal?.label ?? null;
  const thermalCls   = m.thermal_state != null ? thermalColour(m.thermal_state) : (nvThermal?.colour ?? 'text-gray-500');

  const memUsedGB  = (m.used_memory_mb / 1024).toFixed(1);
  const memTotalGB = m.total_memory_mb ? `${(m.total_memory_mb / 1024).toFixed(0)}` : null;

  return (
    <div className="space-y-1.5 py-1">
      {/* Inference band */}
      {m.ollama_running ? (
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-800/50 rounded-lg flex-wrap gap-y-1.5">
          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded ${wesColorClass(wes)}`}>
            WES {formatWES(wes)}
          </span>
          {m.ollama_active_model ? (
            <span className="text-xs text-gray-500 truncate max-w-[160px]">{m.ollama_active_model}</span>
          ) : (
            <span className="text-xs text-gray-600">no model loaded</span>
          )}
          {m.ollama_quantization && (
            <span className="text-[10px] text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded">{m.ollama_quantization}</span>
          )}
          <div className="flex items-center gap-2.5 ml-auto shrink-0">
            {ollamaTps != null && (
              <span className="text-xs font-semibold text-green-400">{ollamaTps.toFixed(1)} tok/s</span>
            )}
            {wPer1kStr && (
              <span className="text-xs text-gray-500">{wPer1kStr}</span>
            )}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-gray-500 bg-gray-50 dark:bg-gray-800/30 rounded-lg">
          <BotMessageSquare size={11} className="shrink-0 text-gray-600" />
          No inference runtime
        </div>
      )}

      {/* Hardware summary line */}
      <div className="flex items-center gap-4 px-3 text-xs text-gray-500 flex-wrap">
        <span>{m.cpu_core_count} cores</span>
        <span>{memUsedGB}{memTotalGB ? ` / ${memTotalGB} GB` : ' GB'} RAM</span>
        {thermalLabel && (
          <span className={`font-medium ${thermalCls}`}>{thermalLabel}</span>
        )}
      </div>
    </div>
  );
};

// ── Collapsible node row used in the All Nodes accordion ─────────────────────
interface NodeRowProps {
  nodeId: string;
  hostname: string;
  metrics: SentinelMetrics | null;
  lastSeenMs?: number;
  defaultOpen?: boolean;
  pue?: number;
}

const NodeRow: React.FC<NodeRowProps> = ({ nodeId, hostname, metrics: m, lastSeenMs: ls, defaultOpen = false, pue = 1.0 }) => {
  const [open, setOpen] = useState(defaultOpen);

  const isOnline   = m !== null;
  const nvThermal  = m && m.thermal_state == null ? derivedNvidiaThermal(m.nvidia_gpu_temp_c ?? null) : null;
  const thermalStr = m?.thermal_state ?? nvThermal?.label ?? '—';
  const thermalCls = m?.thermal_state != null ? thermalColour(m.thermal_state) : (nvThermal?.colour ?? 'text-gray-400');
  const chipName   = m?.gpu_name ?? m?.chip_name ?? null;
  const tps        = m?.ollama_tokens_per_second ?? null;

  return (
    <div className="border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden bg-white dark:bg-gray-900">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 min-h-[44px] hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors text-left"
      >
        <span className={`shrink-0 w-2 h-2 rounded-full ${isOnline ? 'bg-green-500' : 'bg-gray-400'}`} />

        {/* Identity — single baseline: ID · hostname · chip  [· last-seen if offline] */}
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="text-xs font-bold text-gray-900 dark:text-white shrink-0">{nodeId}</span>
          {hostname !== nodeId && (
            <span className="text-xs text-gray-500 shrink-0">· {hostname}</span>
          )}
          {chipName && (
            <span className="text-[10px] text-indigo-400/80 truncate">· {chipName}</span>
          )}
          {!isOnline && ls && (
            <span className="text-[10px] text-gray-500 shrink-0">· {fmtAgo(ls)}</span>
          )}
        </div>

        {/* Right: thermal + tok/s (online) or "offline" */}
        <div className="flex items-center gap-3 shrink-0">
          {isOnline ? (
            <>
              <span className={`text-[11px] font-semibold hidden sm:inline ${thermalCls}`}>{thermalStr}</span>
              {tps != null ? (
                <span className="text-green-400 font-bold text-sm tabular-nums">{tps.toFixed(1)} tok/s</span>
              ) : (
                <span className="text-[10px] text-gray-500 hidden sm:inline">no inference</span>
              )}
            </>
          ) : (
            <span className="text-[10px] text-gray-500">offline</span>
          )}
        </div>

        <ChevronDown className={`w-4 h-4 text-gray-400 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="px-4 pb-3 pt-2 border-t border-gray-200 dark:border-gray-800">
          {m ? (
            <FleetNodeSummary m={m} pue={pue} />
          ) : (
            <p className="text-sm text-gray-500 text-center py-6">
              {ls ? `No telemetry — last seen ${fmtAgo(ls)}` : 'No telemetry received yet — make sure the agent is running.'}
            </p>
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
const Overview: React.FC<OverviewProps> = ({ nodes, isPro, pairingInfo, onOpenPairing, onAddNode, onTelemetryUpdate, onConnectionStateChange, nodePueSettings, onUpdateNodePue, onCopyPueToAll }) => {
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

  const CLOUD_SSE_URL = (() => {
    const v = (import.meta.env.VITE_CLOUD_URL ?? '') as string;
    const base = !v ? 'https://vibrant-fulfillment-production-62c0.up.railway.app'
      : v.startsWith('http') ? v : `https://${v}`;
    return `${base}/api/fleet/stream`;
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
      const connectCloudSSE = () => {
        const es = new EventSource(CLOUD_SSE_URL);
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
  }, [handleMetrics, pushHistoryPoint, CLOUD_SSE_URL]);

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

  // Real stat values derived from live telemetry
  const liveMetrics: SentinelMetrics[] = Object.values(allNodeMetrics);
  const gpuTemps     = liveMetrics.map(m => m.nvidia_gpu_temp_c).filter((t): t is number => t != null);
  const avgTempStr   = gpuTemps.length > 0
    ? `${(gpuTemps.reduce((a, b) => a + b, 0) / gpuTemps.length).toFixed(1)}°C`
    : '—';
  // Ollama fleet stats
  const hasAnyOllama = liveMetrics.some(m => m.ollama_running);
  // Sum tok/s across nodes that have a sampled value; null if none available yet
  const tpsNodes = liveMetrics.filter(m => m.ollama_running && m.ollama_tokens_per_second != null);
  const fleetTps = tpsNodes.length > 0
    ? tpsNodes.reduce((acc, m) => acc + (m.ollama_tokens_per_second ?? 0), 0)
    : null;
  // Wattage per 1k tokens: total CPU+GPU power across Ollama nodes / fleet tok/s * 1000
  // Uses cpu_power_w (macOS powermetrics or Linux RAPL) + nvidia_power_draw_w
  const wattPer1k = (() => {
    if (fleetTps == null || fleetTps <= 0) return null;
    const powerNodes = tpsNodes.filter(m => m.cpu_power_w != null || m.nvidia_power_draw_w != null);
    if (powerNodes.length === 0) return null;
    const totalPowerW = powerNodes.reduce((acc, m) =>
      acc + (m.cpu_power_w ?? 0) + (m.nvidia_power_draw_w ?? 0), 0);
    return (totalPowerW / fleetTps) * 1000;
  })();

  // Cost per 1k tokens derived from wattPer1k — never re-derives from raw fields.
  // Rate: $0.13/kWh (US average; 1W sustained = 1 Wh/h = 0.001 kWh/h).
  // Formula: (wattPer1k W / 1000) * $0.13/kWh = cost in $ per 1k tokens.
  const ELECTRICITY_RATE = 0.13; // $/kWh
  const costPer1k = wattPer1k != null ? (wattPer1k / 1000) * ELECTRICITY_RATE : null;

  // WES fleet computations — use sentinel in local mode, liveMetrics in hosted mode
  const effectiveMetrics: SentinelMetrics[] = isLocalHost ? (sentinel ? [sentinel] : []) : liveMetrics;
  interface WESEntry {
    nodeId: string;
    hostname: string;
    wes: number | null;
    tps: number | null;
    watts: number | null;
    thermalState: string | null;
    nullReason: string;
  }
  const wesEntries: WESEntry[] = effectiveMetrics.map(m => {
    const tps       = m.ollama_tokens_per_second ?? null;
    const totalW    = (m.cpu_power_w ?? 0) + (m.nvidia_power_draw_w ?? 0);
    const hasWatts  = m.cpu_power_w != null || m.nvidia_power_draw_w != null;
    const watts     = hasWatts ? totalW : null;
    const pue       = nodePueSettings?.[m.node_id] ?? 1.0;
    const wes       = computeWES(tps, watts, m.thermal_state, pue);
    const nullReason = tps == null || tps <= 0 ? 'no inference' : !hasWatts ? 'no power data' : '';
    return { nodeId: m.node_id, hostname: m.hostname ?? m.node_id, wes, tps, watts, thermalState: m.thermal_state, nullReason };
  });

  // Detect PUE diversity — used for the ⓘ notice on the leaderboard header
  const pueValues = effectiveMetrics.map(m => nodePueSettings?.[m.node_id] ?? 1.0);
  const hasPerNodePueDiversity = new Set(pueValues).size > 1;

  const sortedWES = [...wesEntries].sort((a, b) => {
    if (a.wes != null && b.wes != null) return b.wes - a.wes;
    if (a.wes != null) return -1;
    if (b.wes != null) return 1;
    return 0;
  });

  const rankedWES    = sortedWES.filter(e => e.wes != null);
  const fleetAvgWES  = rankedWES.length > 0
    ? rankedWES.reduce((acc, e) => acc + e.wes!, 0) / rankedWES.length
    : null;
  const efficiencyRatio = rankedWES.length >= 2
    ? rankedWES[0].wes! / rankedWES[rankedWES.length - 1].wes!
    : null;

  // Build the accordion row data — PUE is read-only in Fleet Overview (editing lives in Node Registry)
  const nodeRows: NodeRowProps[] = isLocalHost
    ? (sentinel ? [{
        nodeId: sentinel.node_id,
        hostname: sentinel.hostname ?? sentinel.node_id,
        metrics: sentinel,
        pue: nodePueSettings?.[sentinel.node_id] ?? 1.0,
      }] : [])
    : nodes.map(n => ({
        nodeId: n.id,
        hostname: n.hostname,
        metrics: allNodeMetrics[n.id] ?? null,
        lastSeenMs: lastSeenMsMap[n.id],
        pue: nodePueSettings?.[n.id] ?? 1.0,
      }));

  return (
    <div className="space-y-6">
      {/* ── Fleet stat cards ─────────────────────────────────────────────────── */}
      <div className="space-y-3">
        {/* Primary tier: Throughput (hero) + Fleet Avg WES */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <PrimaryStatCard
            title="Throughput"
            value={
              <div>
                <p className="text-3xl font-bold text-gray-900 dark:text-white tabular-nums">
                  {fleetTps != null ? `${fleetTps.toFixed(1)} tok/s` : '—'}
                </p>
                <p className="text-[11px] text-gray-500 font-medium mt-1">
                  {fleetTps != null
                    ? `sampled · ${tpsNodes.length} node${tpsNodes.length !== 1 ? 's' : ''}`
                    : hasAnyOllama ? 'Ollama connected · sampling every 30s' : 'connect inference runtime'}
                </p>
              </div>
            }
            icon={Gauge}
            color="bg-indigo-500"
          />
          <PrimaryStatCard
            title={<span title="Wicklee Efficiency Score — tok/s ÷ (Watts × ThermalPenalty × PUE). Higher is better.">Fleet Avg WES</span>}
            value={
              <div>
                <p className={`text-3xl font-bold tabular-nums ${wesColorClass(fleetAvgWES)}`}>
                  {formatWES(fleetAvgWES)}
                </p>
                <p className="text-[11px] text-gray-500 font-medium mt-1">
                  {fleetAvgWES != null
                    ? `avg across ${rankedWES.length} active node${rankedWES.length !== 1 ? 's' : ''}`
                    : wesEntries.length > 0 ? 'no active inference' : 'connect inference runtime'}
                </p>
              </div>
            }
            icon={Zap}
            color="bg-amber-500"
          />
        </div>

        {/* Secondary tier: supporting metrics */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            title="Avg GPU Temp"
            value={<p className="text-2xl font-bold text-gray-900 dark:text-white">{avgTempStr}</p>}
            icon={Thermometer} color="bg-red-500"
          />
          <StatCard
            title="Wattage / 1k tkn"
            value={
              <div>
                <p className="text-2xl font-bold text-gray-900 dark:text-white">
                  {wattPer1k != null ? `${wattPer1k.toFixed(1)} W` : '—'}
                </p>
                <p className="text-[10px] text-gray-500 font-medium">
                  {wattPer1k != null ? 'per 1k tokens' : fleetTps != null ? 'calculating…' : 'connect inference runtime'}
                </p>
              </div>
            }
            icon={Zap} color="bg-emerald-500"
          />
          <StatCard
            title="Cost / 1k Tokens"
            value={
              <div>
                <p className="text-2xl font-bold text-gray-900 dark:text-white">
                  {costPer1k != null ? `$${costPer1k.toFixed(4)}` : '—'}
                </p>
                <p className="text-[10px] text-gray-500 font-medium">
                  {costPer1k != null ? 'per 1k tokens · $0.13/kWh' : fleetTps != null ? 'calculating…' : 'connect inference runtime'}
                </p>
              </div>
            }
            icon={DollarSign} color="bg-cyan-400"
          />
          <StatCard
            title="Fleet Nodes"
            value={<p className="text-2xl font-bold text-gray-900 dark:text-white">{nodes.length.toString()}</p>}
            icon={Server} color="bg-green-500"
          />
        </div>
      </div>

      {/* ── All Nodes accordion (collapsed by default) ───────────────────────── */}
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
            {{
              connected:    <span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" style={{ animationDuration: '2s' }} /><span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" /></span>,
              degraded:     <span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" style={{ animationDuration: '4s' }} /><span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" /></span>,
              idle:         <span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-40" style={{ animationDuration: '6s' }} /><span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-600" /></span>,
              disconnected: <span className="relative flex h-2 w-2"><span className="relative inline-flex rounded-full h-2 w-2 bg-gray-500" /></span>,
            }[connectionState]}
            <span className={`text-[10px] font-medium ${{
              connected:    'text-green-600 dark:text-green-400',
              degraded:     'text-amber-500 dark:text-amber-400',
              idle:         'text-cyan-600 dark:text-cyan-500',
              disconnected: 'text-gray-500',
            }[connectionState]}`}>
              {{
                connected:    transport === 'ws' ? 'Live · WS' : 'Live · SSE',
                degraded:     'Stale · >30s',
                idle:         'Idle · No Nodes',
                disconnected: 'Reconnecting…',
              }[connectionState]}
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

      {/* ── Fleet Intelligence — WES Leaderboard ─────────────────────────────── */}
      <div className="bg-gray-900 dark:bg-gray-900 border border-gray-800 rounded-2xl p-6">
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <BrainCircuit className="w-4 h-4 text-indigo-400" />
          <h3 className="text-sm font-semibold text-gray-200">Fleet Intelligence</h3>
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
            WES Leaderboard
          </span>
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

        {sortedWES.length === 0 ? (
          <div>
            <p className="text-sm text-gray-500">Automated observations will appear here once an inference runtime is connected.</p>
            <p className="text-xs text-gray-600 mt-1">Connect Ollama or vLLM to unlock the Fleet WES Leaderboard and thermal-aware efficiency insights.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Column headers */}
            <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-4 px-3 pb-1">
              <p className="text-[9px] text-gray-600 uppercase tracking-widest font-semibold">Node</p>
              <p className="text-[9px] text-gray-600 uppercase tracking-widest font-semibold text-right w-16">WES</p>
              <p className="text-[9px] text-gray-600 uppercase tracking-widest font-semibold text-right w-16 hidden sm:block">tok/s</p>
              <p className="text-[9px] text-gray-600 uppercase tracking-widest font-semibold text-right w-14 hidden sm:block">Watts</p>
              <p className="text-[9px] text-gray-600 uppercase tracking-widest font-semibold text-right w-16">Thermal</p>
            </div>

            {sortedWES.map((entry, idx) => {
              const isTop    = idx === 0 && entry.wes != null;
              const rank     = entry.wes != null ? rankedWES.indexOf(entry) + 1 : null;
              const thermal  = entry.thermalState;
              const thermalWarning = thermal != null && ['fair', 'serious', 'critical'].includes(thermal.toLowerCase());
              const thermalCls = thermal?.toLowerCase() === 'normal'  ? 'text-green-400'
                               : thermal?.toLowerCase() === 'elevated'? 'text-yellow-400'
                               : thermal?.toLowerCase() === 'fair'    ? 'text-yellow-400'
                               : thermal?.toLowerCase() === 'serious' ? 'text-orange-400'
                               : thermal?.toLowerCase() === 'critical'? 'text-red-500'
                               : 'text-gray-500';
              return (
                <div
                  key={entry.nodeId}
                  className={`grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-4 items-center px-3 py-2.5 rounded-xl transition-colors ${
                    isTop
                      ? 'bg-amber-500/5 border border-amber-500/20'
                      : 'bg-gray-800/50 border border-transparent hover:border-gray-700'
                  }`}
                >
                  {/* Node identity */}
                  <div className="flex items-center gap-2 min-w-0">
                    {isTop ? (
                      <Star size={11} className="text-amber-400 shrink-0 fill-amber-400" />
                    ) : (
                      <span className="text-[10px] text-gray-600 tabular-nums shrink-0 w-3">{rank ?? '—'}</span>
                    )}
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-gray-200 truncate">{entry.nodeId}</p>
                      {entry.hostname !== entry.nodeId && (
                        <p className="text-[10px] text-gray-500 truncate leading-none">{entry.hostname}</p>
                      )}
                      {isTop && <p className="text-[9px] text-amber-400/80 leading-none mt-0.5">Most Efficient</p>}
                    </div>
                  </div>

                  {/* WES */}
                  <div className="w-16 text-right">
                    {entry.wes != null ? (
                      <p className={`text-sm font-bold tabular-nums ${wesColorClass(entry.wes)}`}>
                        {formatWES(entry.wes)}
                      </p>
                    ) : (
                      <p className="text-sm text-gray-600 tabular-nums" title={entry.nullReason}>—</p>
                    )}
                    {entry.wes == null && entry.nullReason && (
                      <p className="text-[9px] text-gray-600 leading-none">{entry.nullReason}</p>
                    )}
                  </div>

                  {/* tok/s */}
                  <div className="w-16 text-right hidden sm:block">
                    <p className={`text-xs tabular-nums ${entry.tps != null ? 'text-green-400' : 'text-gray-600'}`}>
                      {entry.tps != null ? `${entry.tps.toFixed(1)}` : '—'}
                    </p>
                  </div>

                  {/* Watts */}
                  <div className="w-14 text-right hidden sm:block">
                    <p className="text-xs tabular-nums text-gray-400">
                      {entry.watts != null ? `${entry.watts.toFixed(1)}W` : '—'}
                    </p>
                  </div>

                  {/* Thermal */}
                  <div className="w-16 text-right flex items-center justify-end gap-1">
                    {thermalWarning && <AlertTriangle size={9} className="text-amber-400 shrink-0" />}
                    <p className={`text-xs font-semibold ${thermalCls}`}>
                      {thermal ?? '—'}
                    </p>
                  </div>
                </div>
              );
            })}

            {/* Efficiency ratio */}
            {efficiencyRatio != null && efficiencyRatio > 1 && (
              <p className="text-[11px] text-gray-500 pt-2 px-3">
                <span className="font-semibold text-amber-400">{rankedWES[0].nodeId}</span>
                {' '}is{' '}
                <span className="font-semibold tabular-nums text-amber-400">
                  {efficiencyRatio >= 1000
                    ? `${(efficiencyRatio / 1000).toFixed(1)}k×`
                    : efficiencyRatio >= 10
                    ? `${efficiencyRatio.toFixed(0)}×`
                    : `${efficiencyRatio.toFixed(1)}×`}
                </span>
                {' '}more WES-efficient than{' '}
                <span className="text-gray-400">{rankedWES[rankedWES.length - 1].nodeId}</span>
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default Overview;
