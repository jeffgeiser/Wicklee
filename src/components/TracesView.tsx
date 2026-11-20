/**
 * TracesView — Observability tab
 *
 * Six sections:
 *   1. Sovereignty — always visible (cloud + local). Telemetry destination,
 *      outbound connection manifest, and live connection event log.
 *   2. Request Traces — localhost only. local-store-backed trace table with
 *      latency / TTFT / TPOT per inference request.
 *   3. Metric History — localhost only. Phase 4A: time-series charts from the
 *      agent local store (GET /api/history). Unblocks "View source →" links
 *      in AIInsights.
 *   4. Agent Health — localhost only. Phase 4A: harvester status, SSE
 *      connection health, local store write-path availability.
 *   5. Event History — localhost only. Phase 3B: persisted Live Activity events
 *      from agent local store (node_events table). 7-day retention, paginated.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Database, Clock, RefreshCw, Filter, Activity, Download,
  Shield, Lock,
  CheckCircle,
  Cpu, Zap, Server, AlertTriangle,
  ChevronDown, ChevronRight} from 'lucide-react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer} from 'recharts';
import { TrendingUp } from 'lucide-react';
import { NodeAgent, TraceRecord, HistorySample, HistoryResponse, EventHistoryRecord, SentinelMetrics } from '../types';
import { useEventHistory } from '../hooks/useEventHistory';
import { fmtAgo } from '../utils/time';

import { IS_LOCAL_HOST as isLocalHost } from '../utils/buildTarget';

function useProxyStatus() {
  const [status, setStatus] = useState<{
    proxyActive: boolean;
    listenPort: number | null;
    targetPort: number | null;
    runtimeOverrides: string | null;
  }>({ proxyActive: false, listenPort: null, targetPort: null, runtimeOverrides: null });

  useEffect(() => {
    if (!isLocalHost) return;
    let cancelled = false;
    fetch('/api/metrics/snapshot')
      .then(r => r.json())
      .then((data: SentinelMetrics) => {
        if (cancelled) return;
        setStatus({
          proxyActive: data.ollama_proxy_active === true,
          listenPort:  data.proxy_listen_port ?? null,
          targetPort:  data.proxy_target_port ?? null,
          runtimeOverrides: data.runtime_port_overrides ?? null,
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return status;
}

import type { NodeEffectiveSettings } from '../hooks/useSettings';

interface TracesViewProps {
  nodes: NodeAgent[];
  tenantId: string;
  getNodeSettings?: (nodeId: string) => NodeEffectiveSettings;
  /** Cross-nav params from Insights → Observability (node_id + time filter). */
  navParams?: import('../types').ObservabilityNavParams;
  /** Called after nav params are consumed to clear stale state. */
  onNavConsumed?: () => void;
}

const SovereigntySection: React.FC<{
  proxyActive: boolean;
  proxyListenPort: number | null;
  proxyTargetPort: number | null;
  runtimeOverrides: string | null;
}> = ({ proxyActive, proxyListenPort, proxyTargetPort, runtimeOverrides }) => {
  const [expanded, setExpanded] = useState(false);

  const manifest = [
    proxyActive ? {
      purpose:  'Wicklee Proxy',
      endpoint: `localhost:${proxyListenPort ?? 11434} → :${proxyTargetPort ?? 11435}`,
      data:     'Exact tok/s + inference traces (TTFT, TPOT)',
      status:   'active' as const,
    } : {
      purpose:  'Ollama inference probe',
      endpoint: 'localhost:11434',
      data:     'Metric only — tok/s sample (20 tokens)',
      status:   'local' as const,
    },
  ];

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-sm dark:shadow-none overflow-hidden">

      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-indigo-500/10 border border-indigo-500/20 rounded-xl flex items-center justify-center shrink-0">
            <Shield className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="text-left">
            <h2 className="text-sm font-bold text-white">Sovereignty</h2>
            <p className="text-xs text-gray-500">
              {expanded ? 'The agent makes no outbound connections; here is everything it talks to' : 'All local · Nothing leaves this machine'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[9px] px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 font-semibold uppercase tracking-wide">
            Sovereign
          </span>
          {expanded ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
        </div>
      </button>

      {expanded && (
      <div className="px-5 pb-5 space-y-4 border-t border-gray-100 dark:border-gray-700 pt-4">
      <div className="grid md:grid-cols-2 gap-4">

        <div className="bg-gray-800 border border-gray-700 rounded-2xl p-5 space-y-4">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500">
            Telemetry Destination
          </p>

          <div className="flex items-start gap-3">
            <div className="mt-0.5 w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-green-500/10 border border-green-500/20">
              <Lock className="w-4 h-4 text-green-400" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-sm text-white">localhost:7700</span>
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest bg-green-500/10 border border-green-500/20 text-green-400">
                  Local only
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                No outbound telemetry. Everything the agent measures stays on this machine.
              </p>
            </div>
          </div>

          <div className="border-t border-gray-700 pt-4">
            <p className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold mb-2">
              Never leaves this machine
            </p>
            <div className="space-y-1.5">
              {[
                'Hardware and inference metrics',
                'Inference content / prompts',
                'Request payloads / responses',
              ].map(label => (
                <div key={label} className="flex items-center gap-2">
                  <CheckCircle className="w-3 h-3 text-green-400 shrink-0" />
                  <span className="text-xs text-green-400/70">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="bg-gray-800 border border-gray-700 rounded-2xl p-5 space-y-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500">
            Connection Manifest
          </p>
          <div className="divide-y divide-gray-800/60">
            {manifest.map((row, idx) => (
              <div key={row.purpose} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold text-gray-300">{row.purpose}</span>
                      <span className={`inline-flex px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${
                        row.status === 'local' ? 'bg-green-500/10 text-green-400' : 'bg-indigo-500/10 text-indigo-400'
                      }`}>
                        {row.status}
                      </span>
                      {idx === 0 && runtimeOverrides && (
                        <span className="inline-flex px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-blue-500/10 text-blue-400">
                          config.toml
                        </span>
                      )}
                    </div>
                    <p className="font-mono text-[11px] text-gray-500 mt-0.5">{row.endpoint}</p>
                    <p className="text-[11px] text-gray-600 mt-0.5">{row.data}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="border-t border-gray-700 pt-3">
            <p className="text-[11px] text-gray-600 leading-relaxed">
              Both connections are to inference runtimes on this machine. The Ollama probe issues a few tokens to measure throughput — the content is discarded. Prompts and responses are processed entirely on-device.
            </p>
          </div>
        </div>
      </div>
      </div>
      )}
    </div>
  );
};

type HistoryWindow = 1 | 6 | 24;

/** Format a ts_ms timestamp as a short HH:MM label for chart x-axis. */
function fmtChartTime(tsMs: number): string {
  const d = new Date(tsMs);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Return the best tps value from a sample (raw → avg → null). */
function sampleTps(s: HistorySample): number | null {
  return s.tps ?? s.tps_avg ?? null;
}

interface MiniChartProps {
  data:      HistorySample[];
  getValue:  (s: HistorySample) => number | null;
  label:     string;
  unit:      string;
  color:     string;
  colorFill: string;
  /** Fixed Y-axis domain — pass [0, 100] for percentage metrics to prevent
   *  the recharts auto-domain collapsing when all values are similar. */
  yDomain?:  [number, number];
}

const MiniChart: React.FC<MiniChartProps> = ({ data, getValue, label, unit, color, colorFill, yDomain }) => {
  const chartData = data
    .map(s => ({ ts: s.ts_ms, v: getValue(s) ?? undefined }))
    .filter(d => d.v !== undefined);

  const values = chartData.map(d => d.v as number).filter(v => v > 0);
  const peak   = values.length > 0 ? Math.max(...values) : null;
  const latest = values.length > 0 ? values[values.length - 1] : null;

  const derivedDomain: [number, number] | undefined = (() => {
    if (yDomain) return yDomain;
    if (values.length < 2) return undefined;
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (max - min < 1) return [Math.max(0, min - 5), max + 5];
    return undefined;
  })();

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-xl p-3 space-y-1">
      <div className="flex items-center justify-between">
        <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-500">{label}</p>
        {peak != null && (
          <div className="flex items-center gap-1">
            <TrendingUp className="w-2.5 h-2.5 text-gray-600" />
            <span className={`font-mono text-[10px] font-bold ${color}`}>
              {peak % 1 === 0 ? peak.toFixed(0) : peak.toFixed(1)}{unit}
            </span>
          </div>
        )}
      </div>
      {chartData.length > 1 ? (
        <ResponsiveContainer width="100%" height={56}>
          <AreaChart data={chartData} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={`grad-${label}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={colorFill} stopOpacity={0.25} />
                <stop offset="95%" stopColor={colorFill} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <XAxis dataKey="ts" hide />
            {derivedDomain
              ? <YAxis domain={derivedDomain} hide />
              : <YAxis hide />
            }
            <Tooltip
              contentStyle={{ background: '#111', border: '1px solid #374151', borderRadius: 8, fontSize: 10 }}
              formatter={(v: number) => [`${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}${unit}`, label]}
              labelFormatter={(ts: number) => fmtChartTime(ts)}
            />
            <Area
              type="monotone"
              dataKey="v"
              stroke={colorFill}
              strokeWidth={1.5}
              fill={`url(#grad-${label})`}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <div className="h-14 flex items-center justify-center">
          <p className="text-[10px] text-gray-700">No data</p>
        </div>
      )}
      <div className="flex items-center justify-between">
        <p className="text-[9px] text-gray-700">{chartData.length} samples</p>
        {latest != null && peak != null && Math.abs(latest - peak) > 0.5 && (
          <p className="text-[9px] text-gray-700 font-mono">
            now {latest % 1 === 0 ? latest.toFixed(0) : latest.toFixed(1)}{unit}
          </p>
        )}
      </div>
    </div>
  );
};

const MetricHistoryPanel: React.FC<{ nodeId: string }> = ({ nodeId }) => {
  const window_ = 1 as HistoryWindow;
  const [resp,    setResp]   = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!nodeId) return;
    setLoading(true);
    setError(null);
    try {
      const to   = Date.now();
      const from = to - window_ * 3_600_000;
      const url  = `/api/history?node_id=${encodeURIComponent(nodeId)}&from=${from}&to=${to}`;
      const r    = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data: HistoryResponse = await r.json();
      setResp(data);
    } catch {
      setError('History unavailable on this platform.');
      setResp(null);
    }
    setLoading(false);
  }, [nodeId, window_]);

  useEffect(() => { load(); }, [load]);

  const samples = resp?.samples ?? [];

  return (
    <div className="space-y-4">

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-indigo-500/10 border border-indigo-500/20 rounded-xl flex items-center justify-center shrink-0">
            <Database className="w-4 h-4 text-indigo-400" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-white">Metric History</h2>
            <p className="text-xs text-gray-500">
              Raw samples from the local store
              {resp && (
                <span className="ml-2 font-mono text-[9px] text-indigo-400/60 bg-indigo-500/10 px-1.5 py-0.5 rounded">
                  {resp.resolution}
                </span>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1 bg-gray-800 border border-gray-700 rounded-xl p-1">
          <button
            className="px-3 py-1 rounded-lg text-[10px] font-semibold bg-indigo-600 text-white"
          >
            1h
          </button>
          <button
            onClick={load}
            disabled={loading}
            className="ml-1 p-1 text-gray-600 hover:text-gray-400 transition-colors disabled:opacity-40"
            title="Refresh"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-3 p-4 bg-amber-500/8 border border-amber-500/20 rounded-xl">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
          <p className="text-xs text-amber-400/80">{error}</p>
        </div>
      )}

      {!error && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <MiniChart
            data={samples}
            getValue={sampleTps}
            label="Tok / sec"
            unit=" tok/s"
            color="text-indigo-400"
            colorFill="#6366f1"
          />
          <div className="relative">
            <MiniChart
              data={samples}
              getValue={s => s.gpu_power_w ?? null}
              label="Power Draw"
              unit="W"
              color="text-amber-400"
              colorFill="#f59e0b"
            />
            {samples.some(s => (s.clock_throttle_pct ?? 0) > 0) && (() => {
              const latestThrottle = [...samples].reverse().find(s => (s.clock_throttle_pct ?? 0) > 0)?.clock_throttle_pct ?? 0;
              return (
                <span
                  className="absolute top-2.5 right-14 text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20 cursor-help"
                  title={`GPU clock reduced by ${latestThrottle.toFixed(0)}% — thermal or power limit active. Check thermal state and cooling.`}
                >
                  ⚡ Throttled {latestThrottle.toFixed(0)}%
                </span>
              );
            })()}
          </div>
          <MiniChart
            data={samples}
            getValue={s => s.gpu_util_pct ?? null}
            label="GPU Util"
            unit="%"
            color="text-cyan-400"
            colorFill="#06b6d4"
            yDomain={[0, 100]}
          />
          <MiniChart
            data={samples}
            getValue={s => s.cpu_usage_pct ?? null}
            label="CPU Usage"
            unit="%"
            color="text-blue-400"
            colorFill="#3b82f6"
            yDomain={[0, 100]}
          />
          <MiniChart
            data={samples}
            getValue={s => s.mem_pressure_pct ?? null}
            label="Mem Pressure"
            unit="%"
            color="text-blue-300"
            colorFill="#93c5fd"
            yDomain={[0, 100]}
          />
          <MiniChart
            data={samples}
            getValue={s => s.swap_write_mb_s ?? null}
            label="Swap Write"
            unit=" MB/s"
            color="text-rose-400"
            colorFill="#f43f5e"
          />
        </div>
      )}

      {!error && !loading && samples.length === 0 && (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <Database className="w-6 h-6 text-gray-700 mb-2" />
          <p className="text-xs text-gray-600">
            No samples in this window. Run some inference — history collects at 1 Hz.
          </p>
        </div>
      )}

    </div>
  );
};

const AgentHealthPanel: React.FC<{ nodeId: string }> = ({ nodeId }) => {
  const [localAgentOk, setLocalAgentOk]         = useState(false);
  const [localLastMs, setLocalLastMs]            = useState<number | null>(null);
  const [dbStatus, setDbStatus] = useState<'ok' | 'unavailable' | 'checking'>('checking');
  const [liveMetrics, setLiveMetrics]            = useState<SentinelMetrics | null>(null);

  useEffect(() => {
    if (!nodeId) return;
    const probe = async () => {
      try {
        const to   = Date.now();
        const from = to - 30_000;
        const r    = await fetch(`/api/history?node_id=${encodeURIComponent(nodeId)}&from=${from}&to=${to}`);
        setDbStatus(r.ok ? 'ok' : 'unavailable');
        if (r.ok) {
          setLocalAgentOk(true);
          setLocalLastMs(Date.now());
        }
      } catch {
        setDbStatus('unavailable');
      }
    };
    const sseProbe = async () => {
      try {
        const r = await fetch('/api/metrics/snapshot');
        if (r.ok) {
          const data: SentinelMetrics = await r.json();
          setLocalAgentOk(true);
          setLocalLastMs(Date.now());
          setLiveMetrics(data);
        }
      } catch { }
    };
    probe();
    sseProbe();
  }, [nodeId]);

  const connectionState = localAgentOk ? 'connected' : 'disconnected';
  const lastTelemetryMs = localLastMs;
  const transport       = localAgentOk ? 'http' : null;

  const relTelemetry = lastTelemetryMs
    ? (() => {
        const s = Math.round((Date.now() - lastTelemetryMs) / 1000);
        if (s < 5)  return 'just now';
        if (s < 60) return `${s}s ago`;
        return `${Math.floor(s / 60)}m ago`;
      })()
    : '—';

  const connDot   = connectionState === 'connected' ? 'bg-green-400 animate-pulse' : 'bg-red-500';
  const connLabel = connectionState === 'connected' ? 'Connected' : 'Disconnected';

  const m = liveMetrics;
  const connected = connectionState === 'connected';

  const chip   = ((m?.chip_name ?? m?.gpu_name) ?? '').toLowerCase();
  const isApple  = m?.memory_pressure_percent != null || chip.includes('apple') || /\bm[1-4]\b/.test(chip);
  const isNvidia = m?.nvidia_vram_total_mb != null;

  type HarvesterEntry = { label: string; ok: boolean | null; detail: string };
  const harvesters: HarvesterEntry[] = m ? [
    {
      label:  'metrics_harvester (tok/s · CPU% · memory)',
      ok:     m.cpu_usage_pct != null || m.total_memory_mb != null,
      detail: m.cpu_usage_pct != null ? `CPU ${m.cpu_usage_pct.toFixed(0)}%` : 'active',
    },
    {
      label:  isApple
        ? 'apple_silicon (power W · GPU%)'
        : isNvidia
          ? 'nvidia / nvml (power W · GPU%)'
          : 'power_harvester (power W)',
      ok: isApple
        ? (m.cpu_power_w != null || (m as unknown as Record<string, unknown>).apple_soc_power_w != null)
        : isNvidia
          ? m.nvidia_power_draw_w != null
          : m.cpu_power_w != null,
      detail: isApple
        ? (m.cpu_power_w != null ? `${m.cpu_power_w.toFixed(1)}W SoC` : 'no power data')
        : isNvidia
          ? (m.nvidia_power_draw_w != null ? `${m.nvidia_power_draw_w.toFixed(0)}W GPU` : 'NVML power unavailable')
          : (m.cpu_power_w != null ? `${m.cpu_power_w.toFixed(1)}W` : 'no power data'),
    },
    {
      label:  'ollama_harvester (model probe · TTFT)',
      ok:     m.ollama_running === true,
      detail: m.ollama_running
        ? (m.ollama_active_model ?? 'idle')
        : 'not detected',
    },
    {
      label:  'thermal_harvester (state · temp °C)',
      ok:     m.thermal_state != null,
      detail: m.thermal_state ?? (isNvidia ? 'GPU temp via NVML' : 'not available'),
    },
  ] : [
    { label: 'metrics_harvester (tok/s · CPU% · memory)', ok: connected ? true : null, detail: connected ? 'active' : 'awaiting data' },
    { label: 'apple_silicon / nvidia (power W · GPU%)',    ok: connected ? true : null, detail: connected ? 'active' : 'awaiting data' },
    { label: 'ollama_harvester (model probe · TTFT)',      ok: connected ? true : null, detail: connected ? 'active' : 'awaiting data' },
    { label: 'thermal_harvester (state · temp °C)',        ok: connected ? true : null, detail: connected ? 'active' : 'awaiting data' },
  ];

  return (
    <div className="space-y-4">

      <div className="flex items-center gap-3">
        <div className="w-8 h-8 bg-green-500/10 border border-green-500/20 rounded-xl flex items-center justify-center shrink-0">
          <Server className="w-4 h-4 text-green-400" />
        </div>
        <div>
          <h2 className="text-sm font-bold text-white">Diagnostics</h2>
          <p className="text-xs text-gray-500">Collection layer · Local Store · Telemetry pipeline</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">

        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-2">
          <div className="flex items-center gap-2">
            <Activity className="w-3.5 h-3.5 text-gray-500 shrink-0" />
            <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-500">Collection</p>
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full shrink-0 ${connDot}`} />
            <span className="text-sm font-semibold text-gray-200">{connLabel}</span>
          </div>
          {transport && (
            <p className="font-mono text-[9px] text-gray-600 uppercase tracking-widest">
              transport: {transport}
            </p>
          )}
        </div>

        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-2">
          <div className="flex items-center gap-2">
            <Database className="w-3.5 h-3.5 text-gray-500 shrink-0" />
            <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-500">Local Store</p>
          </div>
          <div className="flex items-center gap-2">
            {dbStatus === 'checking' ? (
              <RefreshCw className="w-3 h-3 text-gray-600 animate-spin shrink-0" />
            ) : (
              <div className={`w-2 h-2 rounded-full shrink-0 ${
                dbStatus === 'ok' ? 'bg-green-400' : 'bg-red-500'
              }`} />
            )}
            <span className="text-sm font-semibold text-gray-200">
              {dbStatus === 'checking' ? 'Probing…' : dbStatus === 'ok' ? 'Available' : 'Unavailable'}
            </span>
          </div>
          <p className="text-[9px] text-gray-600">
            {dbStatus === 'unavailable' ? 'local store disabled on this build' : '/api/history OK'}
          </p>
        </div>

        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-2">
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-gray-500 shrink-0" />
            <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-500">Last Frame</p>
          </div>
          <span className="text-sm font-semibold text-gray-200">{relTelemetry}</span>
          <p className="text-[9px] text-gray-600">last telemetry received</p>
        </div>

      </div>

      <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4 space-y-2">
        <div className="flex items-center gap-2 mb-3">
          <Cpu className="w-3 h-3 text-gray-600 shrink-0" />
          <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">
            Active Harvesters
          </p>
        </div>
        {harvesters.map(h => (
          <div key={h.label} className="flex items-center gap-2.5">
            <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              h.ok === null ? 'bg-gray-600' :
              h.ok          ? 'bg-green-400/70' :
                              'bg-amber-500/70'
            }`} />
            <span className="font-mono text-[10px] text-gray-500 flex-1">{h.label}</span>
            {m && (
              <span className={`font-mono text-[9px] shrink-0 ${h.ok ? 'text-gray-600' : 'text-amber-600'}`}>
                {h.detail}
              </span>
            )}
          </div>
        ))}
        <div className="flex items-center gap-2.5 pt-0.5 border-t border-gray-700 mt-2">
          <Zap className="w-3 h-3 text-indigo-400/60 shrink-0" />
          <span className="font-mono text-[10px] text-gray-600">
            cadence: WS 100ms · SSE 1Hz · history 1Hz
          </span>
        </div>
      </div>

    </div>
  );
};

const TraceTable: React.FC<{
  tenantId: string;
  proxyActive: boolean;
  proxyListenPort: number | null;
  proxyTargetPort: number | null;
}> = ({ tenantId, proxyActive, proxyListenPort, proxyTargetPort }) => {
  const [traces, setTraces]   = useState<TraceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const fetchTraces = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const response = await fetch('/api/traces', {
        headers: { 'X-Tenant-ID': tenantId },
      });
      if (!response.ok) throw new Error('Failed to reach local Wicklee agent');
      const data = await response.json();
      setTraces(data);
      setError(null);
    } catch {
      setError('Agent disconnected');
      setTraces([]);
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    fetchTraces(true);
    const interval = setInterval(() => fetchTraces(), 5000);
    return () => clearInterval(interval);
  }, [fetchTraces]);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div className="flex gap-2">
          <button
            onClick={() => fetchTraces(true)}
            className="px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-500 transition-colors flex items-center gap-2"
          >
            <Database className="w-3.5 h-3.5" />
            Query Local Logs
          </button>
          <button className="px-3 py-1.5 bg-gray-700 text-gray-300 text-xs font-medium rounded-lg border border-gray-700 hover:bg-gray-700 transition-colors flex items-center gap-2">
            <Filter className="w-3.5 h-3.5" />
            Filter Logs
          </button>
        </div>
        <div className="flex items-center gap-3">
          {loading && <RefreshCw className="w-3 h-3 text-cyan-400 animate-spin" />}
          <span className="text-xs text-gray-500 flex items-center gap-1">
            <Clock className="w-3 h-3" /> Auto-syncing (5s)
          </span>
          <div className={`w-2 h-2 rounded-full ${
            error         ? 'bg-red-500'                  :
            traces.length > 0 ? 'bg-green-500 animate-pulse' :
                            'bg-gray-500'
          }`} />
        </div>
      </div>

      <div className="bg-gray-800 border border-gray-700 rounded-2xl overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-gray-900/50 text-[10px] text-gray-500 uppercase tracking-widest font-bold border-b border-gray-700">
              <th className="px-6 py-4">Timestamp</th>
              <th className="px-6 py-4">Node / Model</th>
              <th className="px-6 py-4">Latency (ms)</th>
              <th className="px-6 py-4">TTFT</th>
              <th className="px-6 py-4">TPOT</th>
              <th className="px-6 py-4">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800 font-telin text-xs">
            {traces.length > 0 ? (
              traces.map(trace => (
                <tr key={trace.id} className="hover:bg-gray-700/30 transition-colors">
                  <td className="px-6 py-4 text-gray-500">{trace.timestamp}</td>
                  <td className="px-6 py-4">
                    <div className="flex flex-col">
                      <span className="text-gray-300 font-semibold">{trace.nodeId}</span>
                      <span className="text-cyan-400/80">{trace.model}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <div className="h-1 w-12 bg-gray-700 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-600"
                          style={{ width: `${Math.min(100, (trace.latency / 1200) * 100)}%` }}
                        />
                      </div>
                      <span className="text-gray-300">{trace.latency}ms</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-gray-400">{trace.ttft}ms</td>
                  <td className="px-6 py-4 text-gray-400">{trace.tpot}ms/tok</td>
                  <td className="px-6 py-4">
                    <span className={trace.status >= 400 ? 'text-red-500' : 'text-green-500'}>
                      {trace.status}
                    </span>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="px-6 py-12 text-center">
                  {proxyActive ? (
                    <div className="flex flex-col items-center justify-center max-w-md mx-auto">
                      <div className="w-12 h-12 bg-green-500/10 rounded-2xl flex items-center justify-center mb-4 border border-green-500/20">
                        <Activity className="w-6 h-6 text-green-400" />
                      </div>
                      <h3 className="text-sm font-bold text-white mb-2">Proxy Active — Waiting for Requests</h3>
                      <p className="text-xs text-gray-500 leading-relaxed mb-4">
                        Traces will appear as inference requests flow through the proxy on{' '}
                        <span className="font-mono text-gray-400">:{proxyListenPort ?? 11434}</span>{' → '}
                        <span className="font-mono text-gray-400">:{proxyTargetPort ?? 11435}</span>.
                      </p>
                      <div className="bg-gray-700/50 border border-white/5 rounded-lg px-4 py-3 w-full text-left">
                        <p className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold mb-1.5">Test it</p>
                        <code className="text-[11px] font-mono text-gray-400 leading-relaxed block whitespace-pre-wrap break-all">
{`curl http://localhost:${proxyListenPort ?? 11434}/api/generate \\
  -d '{"model":"llama3","prompt":"hi","stream":false}'`}
                        </code>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center max-w-lg mx-auto text-left">
                      <div className="w-12 h-12 bg-gray-700/50 rounded-2xl flex items-center justify-center mb-4 border border-white/5">
                        <Activity className="w-6 h-6 text-gray-500" />
                      </div>
                      <h3 className="text-sm font-bold text-white mb-1 text-center">Inference Traces require the Wicklee Proxy</h3>
                      <p className="text-xs text-gray-500 leading-relaxed mb-4 text-center">
                        The proxy intercepts Ollama requests and logs latency, TTFT, and TPOT for every inference. Without it, the agent uses a lightweight probe for tok/s only.
                      </p>
                      <div className="bg-gray-700/30 border border-white/5 rounded-xl p-4 w-full space-y-3">
                        <p className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold">Setup (3 steps)</p>
                        <div className="space-y-2.5 text-xs text-gray-400">
                          <div className="flex gap-2.5">
                            <span className="text-gray-600 font-mono shrink-0">1.</span>
                            <div>
                              <span className="text-gray-300">Move Ollama to a different port:</span>
                              <code className="block font-mono text-[11px] text-gray-500 mt-1 bg-gray-800/50 rounded px-2 py-1">OLLAMA_HOST=127.0.0.1:11435 ollama serve</code>
                            </div>
                          </div>
                          <div className="flex gap-2.5">
                            <span className="text-gray-600 font-mono shrink-0">2.</span>
                            <div>
                              <span className="text-gray-300">Enable the proxy in config:</span>
                              <code className="block font-mono text-[11px] text-gray-500 mt-1 bg-gray-800/50 rounded px-2 py-1 whitespace-pre">{`[ollama_proxy]\nenabled = true\nollama_port = 11435`}</code>
                              <p className="text-[10px] text-gray-600 mt-1">
                                Config: <span className="font-mono">/Library/Application Support/Wicklee/config.toml</span> (macOS) or <span className="font-mono">/etc/wicklee/config.toml</span> (Linux)
                              </p>
                            </div>
                          </div>
                          <div className="flex gap-2.5">
                            <span className="text-gray-600 font-mono shrink-0">3.</span>
                            <span className="text-gray-300">Restart the Wicklee agent</span>
                          </div>
                        </div>
                      </div>
                      <div className="bg-gray-700/20 border border-white/5 rounded-xl p-4 w-full mt-3">
                        <p className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold mb-2">Non-default runtime port?</p>
                        <p className="text-[11px] text-gray-500 leading-relaxed mb-2">
                          If your inference runtime uses a custom port, add it to config so the agent connects to the right endpoint:
                        </p>
                        <code className="block font-mono text-[11px] text-gray-500 bg-gray-800/50 rounded px-2 py-1 whitespace-pre">{`[runtime_ports]\nvllm = 18010      # or ollama = 11435`}</code>
                      </div>
                    </div>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const EVENT_TYPE_COLORS: Record<string, string> = {
  startup:        'text-green-400',
  update:         'text-blue-400',
  model_swap:     'text-indigo-400',
  thermal_change: 'text-amber-400',
  error:          'text-red-400',
};

const LEVEL_DOT: Record<string, string> = {
  info:  'bg-gray-400',
  warn:  'bg-amber-400',
  error: 'bg-red-400',
};

const EventHistoryPanel: React.FC = () => {
  const { events, loading, error, hasMore, loadMore, refresh } = useEventHistory({ limit: 30 });

  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-cyan-400" />
          <h3 className="text-sm font-semibold text-gray-300">Event History</h3>
          <span className="text-[10px] text-gray-600 font-mono ml-1">node_events · 7d</span>
        </div>
        <div className="flex items-center gap-1.5">
          <a
            href="/api/export?format=csv"
            download=""
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-gray-500 hover:text-gray-300 hover:bg-gray-700 transition-colors"
            title="Download audit log as CSV"
          >
            <Download className="w-3 h-3" />
            <span>CSV</span>
          </a>
          <a
            href="/api/export?format=json"
            download=""
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-gray-500 hover:text-gray-300 hover:bg-gray-700 transition-colors"
            title="Download audit log as JSON"
          >
            <Download className="w-3 h-3" />
            <span>JSON</span>
          </a>
          <button
            onClick={refresh}
            className="p-1 rounded hover:bg-gray-700 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-gray-500 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-amber-400 text-xs mb-3">
          <AlertTriangle className="w-3.5 h-3.5" />
          <span>Failed to load event history: {error}</span>
        </div>
      )}

      {!loading && !error && events.length === 0 && (
        <p className="text-xs text-gray-600 text-center py-4">
          No events recorded yet. Events persist to local store on agent startup, updates, and
          lifecycle changes.
        </p>
      )}

      {events.length > 0 && (
        <div className="space-y-1.5 max-h-[300px] overflow-y-auto pr-1">
          {events
            .reduce<{ event: EventHistoryRecord; count: number }[]>((acc, ev) => {
              const prev = acc[acc.length - 1];
              if (
                prev &&
                prev.event.message === ev.message &&
                prev.event.event_type === ev.event_type
              ) {
                prev.count++;
              } else {
                acc.push({ event: ev, count: 1 });
              }
              return acc;
            }, [])
            .map(({ event: ev, count }, i) => (
              <div key={`${ev.ts_ms}-${i}`}
                className="flex items-start gap-2.5 py-1.5 px-2 rounded hover:bg-gray-700/50 transition-colors"
              >
                <span className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${LEVEL_DOT[ev.level] ?? 'bg-gray-500'}`} />

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-xs text-gray-300 leading-snug truncate">{ev.message}</p>
                    {count > 1 && (
                      <span className="shrink-0 text-[9px] font-mono text-gray-600 bg-gray-700 px-1 py-0.5 rounded">
                        ×{count}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-gray-600 font-mono">{fmtAgo(ev.ts_ms)}</span>
                    {ev.event_type && (
                      <span className={`text-[10px] font-mono ${EVENT_TYPE_COLORS[ev.event_type] ?? 'text-gray-500'}`}>
                        {ev.event_type}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))
          }
        </div>
      )}

      {hasMore && events.length > 0 && (
        <button
          onClick={loadMore}
          disabled={loading}
          className="mt-3 w-full text-[11px] text-gray-500 hover:text-gray-400 py-1.5 rounded border border-gray-700 hover:border-gray-700 transition-colors"
        >
          {loading ? 'Loading…' : 'Load older events'}
        </button>
      )}

      {events.length > 0 && (
        <p className="text-[11px] text-gray-700 leading-relaxed mt-3">
          Stored in <span className="font-mono text-gray-600">node_events</span> table ·{' '}
          agent-local <span className="font-mono text-gray-600">metrics.db</span> · 7-day retention.
        </p>
      )}
    </div>
  );
};

/** The agent's own node id, from /api/health. */
function useLocalNodeId(): string {
  const [id, setId] = useState('');
  useEffect(() => {
    let cancelled = false;
    fetch('/api/health')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { node_id?: string } | null) => { if (!cancelled && d?.node_id) setId(d.node_id); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return id;
}

const TracesView: React.FC<TracesViewProps> = ({ tenantId, navParams, onNavConsumed }) => {
  const nodeId = useLocalNodeId();
  const { proxyActive, listenPort: proxyListenPort, targetPort: proxyTargetPort, runtimeOverrides } = useProxyStatus();

  useEffect(() => {
    if (navParams && onNavConsumed) {
      const id = setTimeout(onNavConsumed, 500);
      return () => clearTimeout(id);
    }
  }, [navParams, onNavConsumed]);

  return (
    <div className="space-y-8">
      <SovereigntySection proxyActive={proxyActive} proxyListenPort={proxyListenPort} proxyTargetPort={proxyTargetPort} runtimeOverrides={runtimeOverrides} />
      {nodeId && <MetricHistoryPanel nodeId={nodeId} />}
      <TraceTable tenantId={tenantId} proxyActive={proxyActive} proxyListenPort={proxyListenPort} proxyTargetPort={proxyTargetPort} />
      <EventHistoryPanel />
      {nodeId && <AgentHealthPanel nodeId={nodeId} />}
    </div>
  );
};

export default TracesView;
