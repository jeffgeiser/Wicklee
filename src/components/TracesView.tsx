/**
 * TracesView — Observability tab
 *
 * Six sections:
 *   1. Sovereignty — always visible (cloud + local). Telemetry destination,
 *      outbound connection manifest, and live connection event log.
 *   2. Request Traces — localhost only. DuckDB-backed trace table with
 *      latency / TTFT / TPOT per inference request.
 *   3. Metric History — localhost only. Phase 4A: time-series charts from the
 *      agent DuckDB store (GET /api/history). Unblocks "View source →" links
 *      in AIInsights.
 *   4. Agent Health — localhost only. Phase 4A: harvester status, SSE
 *      connection health, DuckDB write-path availability.
 *   5. Event History — localhost only. Phase 3B: persisted Live Activity events
 *      from agent DuckDB (node_events table). 7-day retention, paginated.
 *   6. Dismissal Log — localhost only. Sprint 6: all active accepted_states
 *      rows from agent DuckDB. Audit trail for dismissed pattern insights.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Database, Clock, RefreshCw, Filter, Activity,
  Shield, Lock, Globe, Radio,
  ArrowUpRight, CheckCircle,
  Cpu, Zap, Server, AlertTriangle,
  ClipboardList, XCircle, Timer,
} from 'lucide-react';
import {
  AreaChart, Area, XAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import { NodeAgent, TraceRecord, PairingInfo, HistorySample, HistoryResponse, EventHistoryRecord, SentinelMetrics } from '../types';
import { useFleetStream } from '../contexts/FleetStreamContext';
import { useEventHistory } from '../hooks/useEventHistory';

const isLocalHost =
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1';

// ── Proxy status hook — one-shot fetch from /api/metrics ─────────────────────
// Proxy config is immutable at runtime (set at agent startup), so a single
// fetch is sufficient. Returns { proxyActive, listenPort, targetPort }.
function useProxyStatus() {
  const [status, setStatus] = useState<{
    proxyActive: boolean;
    listenPort: number | null;
    targetPort: number | null;
  }>({ proxyActive: false, listenPort: null, targetPort: null });

  useEffect(() => {
    if (!isLocalHost) return;
    let cancelled = false;
    fetch('/api/metrics')
      .then(r => r.json())
      .then((data: SentinelMetrics) => {
        if (cancelled) return;
        setStatus({
          proxyActive: data.ollama_proxy_active === true,
          listenPort:  data.proxy_listen_port ?? null,
          targetPort:  data.proxy_target_port ?? null,
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return status;
}

interface TracesViewProps {
  nodes: NodeAgent[];
  tenantId: string;
  pairingInfo: PairingInfo | null;
}

// ── Sovereignty Section ────────────────────────────────────────────────────────

const SovereigntySection: React.FC<{
  pairingInfo: PairingInfo | null;
  proxyActive: boolean;
  proxyListenPort: number | null;
  proxyTargetPort: number | null;
}> = ({ pairingInfo, proxyActive, proxyListenPort, proxyTargetPort }) => {
  const { fleetEvents, connectionState } = useFleetStream();

  // In Cockpit mode (localhost), pairing state comes from the local agent's /api/pair/status.
  // In Mission Control mode (cloud), the fleet is "connected" when the SSE stream is live —
  // pairingInfo reflects the local agent pair handshake, which is irrelevant in this context.
  const isPaired = isLocalHost
    ? pairingInfo?.status === 'connected'
    : connectionState === 'connected' || connectionState === 'degraded';
  const fleetUrl   = pairingInfo?.fleet_url ?? (isPaired ? 'wicklee.dev' : null);
  const nodeId     = pairingInfo?.node_id ?? null;

  // Connection events — most recent first, cap at 8
  const connectionEvents = fleetEvents
    .filter(e => e.type === 'node_online' || e.type === 'node_offline')
    .slice(0, 8);

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
    {
      purpose:  'Fleet telemetry',
      endpoint: fleetUrl ?? '—',
      data:     'System metrics + WES scores',
      status:   isPaired ? 'active' as const : 'inactive' as const,
    },
    {
      purpose:  'Clerk authentication',
      endpoint: 'api.clerk.dev',
      data:     'Session JWT — no inference data',
      status:   isLocalHost ? 'inactive' as const : 'active' as const,
    },
  ];

  return (
    <div className="space-y-4">

      {/* ── Section header ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 bg-indigo-500/10 border border-indigo-500/20 rounded-xl flex items-center justify-center shrink-0">
          <Shield className="w-4 h-4 text-indigo-400" />
        </div>
        <div>
          <h2 className="text-sm font-bold text-white">Sovereignty</h2>
          <p className="text-xs text-gray-500">
            Structural proof that inference data never left your network
          </p>
        </div>
      </div>

      {/* ── Destination + Manifest ───────────────────────────────────────────── */}
      <div className="grid md:grid-cols-2 gap-4">

        {/* Telemetry Destination */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-4">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500">
            Telemetry Destination
          </p>

          <div className="flex items-start gap-3">
            <div className={`mt-0.5 w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
              isPaired
                ? 'bg-indigo-500/10 border border-indigo-500/20'
                : isLocalHost
                  ? 'bg-green-500/10 border border-green-500/20'
                  : 'bg-gray-800 border border-gray-700'
            }`}>
              {isPaired
                ? <Globe className="w-4 h-4 text-indigo-400" />
                : isLocalHost
                  ? <Lock className="w-4 h-4 text-green-400" />
                  : <Radio className="w-4 h-4 text-gray-500" />}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-sm text-white">
                  {isPaired
                    ? (fleetUrl ?? 'wicklee.dev')
                    : isLocalHost
                      ? 'localhost:7700'
                      : '—'}
                </span>
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest ${
                  isPaired
                    ? 'bg-indigo-500/10 border border-indigo-500/20 text-indigo-400'
                    : isLocalHost
                      ? 'bg-green-500/10 border border-green-500/20 text-green-400'
                      : 'bg-gray-800 border border-gray-700 text-gray-500'
                }`}>
                  {isPaired ? 'Fleet connected' : isLocalHost ? 'Local only' : 'No nodes'}
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                {isPaired
                  ? 'Each node transmits only system metrics and WES scores. Inference content is processed on-device and never leaves the node.'
                  : isLocalHost
                    ? 'No outbound telemetry. All inference data stays on this machine.'
                    : 'No nodes connected yet. Add a node to see its telemetry routing details here.'}
              </p>
              {isPaired && nodeId && (
                <p className="font-mono text-[11px] text-gray-600 mt-1.5">{nodeId}</p>
              )}
            </div>
          </div>

          {/* What is (and isn't) transmitted */}
          <div className="border-t border-gray-800 pt-4 space-y-3">
            <div>
              <p className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold mb-2">
                {isLocalHost ? 'Transmitted to fleet' : 'Each node transmits'}
              </p>
              <div className="space-y-1.5">
                {[
                  'CPU / GPU / memory metrics',
                  'WES score + thermal state',
                  'Active model name',
                ].map(label => (
                  <div key={label} className="flex items-center gap-2">
                    <ArrowUpRight className="w-3 h-3 text-indigo-400 shrink-0" />
                    <span className="text-xs text-gray-400">{label}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold mb-2">
                {isLocalHost ? 'Never leaves this machine' : 'Never leaves the node'}
              </p>
              <div className="space-y-1.5">
                {[
                  'Inference content / prompts',
                  'Request payloads / responses',
                  'User conversations',
                ].map(label => (
                  <div key={label} className="flex items-center gap-2">
                    <CheckCircle className="w-3 h-3 text-green-400 shrink-0" />
                    <span className="text-xs text-green-400/70">{label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Outbound Connection Manifest */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500">
            Outbound Connection Manifest
          </p>
          <div className="divide-y divide-gray-800/60">
            {manifest.map(row => (
              <div key={row.purpose} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold text-gray-300">{row.purpose}</span>
                      <span className={`inline-flex px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${
                        row.status === 'local'    ? 'bg-green-500/10 text-green-400'   :
                        row.status === 'active'   ? 'bg-indigo-500/10 text-indigo-400' :
                                                    'bg-gray-500/10 text-gray-500'
                      }`}>
                        {row.status}
                      </span>
                    </div>
                    <p className="font-mono text-[11px] text-gray-500 mt-0.5">{row.endpoint}</p>
                    <p className="text-[11px] text-gray-600 mt-0.5">{row.data}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="border-t border-gray-800 pt-3">
            <p className="text-[11px] text-gray-600 leading-relaxed">
              <span className="text-green-400/70 font-semibold">No inference data</span>{' '}
              appears in any outbound connection. The Ollama probe issues 3 tokens to measure throughput — the content is discarded. Prompts and responses are processed entirely on-device.
            </p>
          </div>
        </div>
      </div>

      {/* ── Connection Event Log ─────────────────────────────────────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500">
            Connection Event Log
          </p>
          <div className="flex items-center gap-1.5">
            <div className={`w-1.5 h-1.5 rounded-full ${
              connectionState === 'connected' ? 'bg-green-400 animate-pulse' : 'bg-gray-600'
            }`} />
            <span className="text-[10px] text-gray-600">Live</span>
          </div>
        </div>

        {connectionEvents.length > 0 ? (
          <div className="divide-y divide-gray-800/50">
            {connectionEvents.map(evt => (
              <div key={evt.id} className="px-5 py-3 flex items-center gap-4">
                <span className="font-mono text-[11px] text-gray-600 shrink-0 w-[4.5rem]">
                  {new Date(evt.ts).toLocaleTimeString([], {
                    hour:   '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
                <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  evt.type === 'node_online' ? 'bg-green-400' : 'bg-gray-500'
                }`} />
                <span className="text-xs text-gray-400">
                  <span className="font-mono text-gray-300">
                    {evt.hostname ?? evt.nodeId}
                  </span>
                  {evt.type === 'node_online'
                    ? ' connected to fleet'
                    : ' disconnected from fleet'}
                  {evt.detail ? ` · ${evt.detail}` : ''}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-5 py-10 text-center">
            <Radio className="w-5 h-5 text-gray-700 mx-auto mb-2" />
            <p className="text-xs text-gray-600">No connection events in this session</p>
          </div>
        )}
      </div>
    </div>
  );
};

// ── Metric History Panel — Phase 4A ──────────────────────────────────────────
// Fetches GET /api/history from the local agent DuckDB store.
// Available in Cockpit mode (isLocalHost) only — the agent must be running.
//
// "View source →" links in AIInsights will deep-link here so operators can
// see the raw samples that triggered a pattern observation.

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
}

const MiniChart: React.FC<MiniChartProps> = ({ data, getValue, label, unit, color, colorFill }) => {
  const chartData = data
    .map(s => ({ ts: s.ts_ms, v: getValue(s) ?? undefined }))
    .filter(d => d.v !== undefined);

  const values = chartData.map(d => d.v as number).filter(v => v > 0);
  const peak   = values.length > 0 ? Math.max(...values) : null;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 space-y-1">
      <div className="flex items-center justify-between">
        <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-500">{label}</p>
        {peak != null && (
          <span className={`font-mono text-[10px] font-bold ${color}`}>
            {peak % 1 === 0 ? peak.toFixed(0) : peak.toFixed(1)}{unit}
          </span>
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
      <p className="text-[9px] text-gray-700">{chartData.length} samples</p>
    </div>
  );
};

const MetricHistoryPanel: React.FC<{ nodeId: string }> = ({ nodeId }) => {
  const [window_, setWindow] = useState<HistoryWindow>(1);
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
      setError('History unavailable — agent may not support DuckDB on this platform.');
      setResp(null);
    }
    setLoading(false);
  }, [nodeId, window_]);

  useEffect(() => { load(); }, [load]);

  const samples = resp?.samples ?? [];

  return (
    <div className="space-y-4">

      {/* ── Section header ──────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-indigo-500/10 border border-indigo-500/20 rounded-xl flex items-center justify-center shrink-0">
            <Database className="w-4 h-4 text-indigo-400" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-white">Metric History</h2>
            <p className="text-xs text-gray-500">
              Raw samples from the local DuckDB store
              {resp && (
                <span className="ml-2 font-mono text-[9px] text-indigo-400/60 bg-indigo-500/10 px-1.5 py-0.5 rounded">
                  {resp.resolution}
                </span>
              )}
            </p>
          </div>
        </div>

        {/* Time window selector */}
        <div className="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1">
          {([1, 6, 24] as HistoryWindow[]).map(w => (
            <button
              key={w}
              onClick={() => setWindow(w)}
              className={`px-3 py-1 rounded-lg text-[10px] font-semibold transition-colors ${
                window_ === w
                  ? 'bg-indigo-600 text-white'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {w}h
            </button>
          ))}
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

      {/* ── Error state ─────────────────────────────────────────────────────── */}
      {error && (
        <div className="flex items-center gap-3 p-4 bg-amber-500/8 border border-amber-500/20 rounded-xl">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
          <p className="text-xs text-amber-400/80">{error}</p>
        </div>
      )}

      {/* ── Charts — 2×3 grid ───────────────────────────────────────────────── */}
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
          <MiniChart
            data={samples}
            getValue={s => s.gpu_power_w ?? null}
            label="Power Draw"
            unit="W"
            color="text-amber-400"
            colorFill="#f59e0b"
          />
          <MiniChart
            data={samples}
            getValue={s => s.gpu_util_pct ?? null}
            label="GPU Util"
            unit="%"
            color="text-cyan-400"
            colorFill="#06b6d4"
          />
          <MiniChart
            data={samples}
            getValue={s => s.cpu_usage_pct ?? null}
            label="CPU Usage"
            unit="%"
            color="text-blue-400"
            colorFill="#3b82f6"
          />
          <MiniChart
            data={samples}
            getValue={s => s.swap_write_mb_s ?? null}
            label="Swap Write"
            unit=" MB/s"
            color="text-rose-400"
            colorFill="#f43f5e"
          />
          <MiniChart
            data={samples}
            getValue={s => s.clock_throttle_pct ?? null}
            label="Clock Throttle"
            unit="%"
            color="text-violet-400"
            colorFill="#8b5cf6"
          />
        </div>
      )}

      {/* ── Empty state ─────────────────────────────────────────────────────── */}
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

// ── Agent Health Panel — Phase 4A ─────────────────────────────────────────────
// Surfaces the internal health of the local Wicklee agent:
//   - Collection layer  — is the SSE/WS harvester delivering telemetry?
//   - DuckDB store      — does GET /api/history respond successfully?
//   - Last telemetry    — when did the last metric frame arrive?
//
// Available in Cockpit mode (isLocalHost) only.

const AgentHealthPanel: React.FC<{ nodeId: string }> = ({ nodeId }) => {
  const { connectionState, lastTelemetryMs, transport } = useFleetStream();
  const [dbStatus, setDbStatus] = useState<'ok' | 'unavailable' | 'checking'>('checking');

  // Lightweight DuckDB probe — tiny 30-second window to minimise query cost.
  useEffect(() => {
    if (!nodeId) return;
    const probe = async () => {
      try {
        const to   = Date.now();
        const from = to - 30_000;
        const r    = await fetch(`/api/history?node_id=${encodeURIComponent(nodeId)}&from=${from}&to=${to}`);
        setDbStatus(r.ok ? 'ok' : 'unavailable');
      } catch {
        setDbStatus('unavailable');
      }
    };
    probe();
  }, [nodeId]);

  const relTelemetry = lastTelemetryMs
    ? (() => {
        const s = Math.round((Date.now() - lastTelemetryMs) / 1000);
        if (s < 5)  return 'just now';
        if (s < 60) return `${s}s ago`;
        return `${Math.floor(s / 60)}m ago`;
      })()
    : '—';

  const connDot =
    connectionState === 'connected'    ? 'bg-green-400 animate-pulse' :
    connectionState === 'degraded'     ? 'bg-amber-400 animate-pulse' :
    connectionState === 'idle'         ? 'bg-yellow-400'              :
                                         'bg-red-500';

  const connLabel =
    connectionState === 'connected'    ? 'Connected'    :
    connectionState === 'degraded'     ? 'Degraded'     :
    connectionState === 'idle'         ? 'Idle'         :
                                         'Disconnected';

  const harvesters = [
    'metrics_harvester      (tok/s · CPU% · memory)',
    'apple_silicon / nvidia (power W · GPU%)',
    'ollama_harvester        (model probe · TTFT)',
    'thermal_harvester       (state · temp °C)',
  ];

  return (
    <div className="space-y-4">

      {/* ── Section header ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 bg-green-500/10 border border-green-500/20 rounded-xl flex items-center justify-center shrink-0">
          <Server className="w-4 h-4 text-green-400" />
        </div>
        <div>
          <h2 className="text-sm font-bold text-white">Agent Health</h2>
          <p className="text-xs text-gray-500">Collection layer · DuckDB store · Telemetry pipeline</p>
        </div>
      </div>

      {/* ── Health indicators ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">

        {/* SSE/WS Collection */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2">
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

        {/* DuckDB store */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2">
          <div className="flex items-center gap-2">
            <Database className="w-3.5 h-3.5 text-gray-500 shrink-0" />
            <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-500">DuckDB Store</p>
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
            {dbStatus === 'unavailable' ? 'musl target — DuckDB disabled' : '/api/history OK'}
          </p>
        </div>

        {/* Last telemetry */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2">
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-gray-500 shrink-0" />
            <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-500">Last Frame</p>
          </div>
          <span className="text-sm font-semibold text-gray-200">{relTelemetry}</span>
          <p className="text-[9px] text-gray-600">last telemetry received</p>
        </div>

      </div>

      {/* ── Harvesters list ──────────────────────────────────────────────────── */}
      <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-4 space-y-2">
        <div className="flex items-center gap-2 mb-3">
          <Cpu className="w-3 h-3 text-gray-600 shrink-0" />
          <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">
            Active Harvesters
          </p>
        </div>
        {harvesters.map(h => (
          <div key={h} className="flex items-center gap-2.5">
            <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              connectionState === 'connected' ? 'bg-green-400/70' : 'bg-gray-600'
            }`} />
            <span className="font-mono text-[10px] text-gray-500">{h}</span>
          </div>
        ))}
        <div className="flex items-center gap-2.5 pt-0.5 border-t border-gray-800 mt-2">
          <Zap className="w-3 h-3 text-indigo-400/60 shrink-0" />
          <span className="font-mono text-[10px] text-gray-600">
            cadence: WS 100ms · SSE 1Hz · history 1Hz (DuckDB)
          </span>
        </div>
      </div>

    </div>
  );
};

// ── Local trace table ──────────────────────────────────────────────────────────

const TraceTable: React.FC<{
  tenantId: string;
  proxyActive: boolean;
  proxyListenPort: number | null;
  proxyTargetPort: number | null;
}> = ({ tenantId, proxyActive, proxyListenPort, proxyTargetPort }) => {
  const [traces, setTraces]   = useState<TraceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const fetchTraces = async () => {
    setLoading(true);
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
  };

  useEffect(() => {
    fetchTraces();
    const interval = setInterval(fetchTraces, 5000);
    return () => clearInterval(interval);
  }, [tenantId]);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div className="flex gap-2">
          <button
            onClick={fetchTraces}
            className="px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2"
          >
            <Database className="w-3.5 h-3.5" />
            Query Local Logs
          </button>
          <button className="px-3 py-1.5 bg-gray-800 text-gray-300 text-xs font-medium rounded-lg border border-gray-700 hover:bg-gray-700 transition-colors flex items-center gap-2">
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

      <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-gray-950/50 text-[10px] text-gray-500 uppercase tracking-widest font-bold border-b border-gray-800">
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
                <tr key={trace.id} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-6 py-4 text-gray-500">{trace.timestamp}</td>
                  <td className="px-6 py-4">
                    <div className="flex flex-col">
                      <span className="text-gray-300 font-semibold">{trace.nodeId}</span>
                      <span className="text-cyan-400/80">{trace.model}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <div className="h-1 w-12 bg-gray-800 rounded-full overflow-hidden">
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
                    /* Proxy active, just waiting for traffic */
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
                      <div className="bg-gray-800/50 border border-white/5 rounded-lg px-4 py-3 w-full text-left">
                        <p className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold mb-1.5">Test it</p>
                        <code className="text-[11px] font-mono text-gray-400 leading-relaxed block whitespace-pre-wrap break-all">
{`curl http://localhost:${proxyListenPort ?? 11434}/api/generate \\
  -d '{"model":"llama3","prompt":"hi","stream":false}'`}
                        </code>
                      </div>
                    </div>
                  ) : (
                    /* Proxy not active — onboarding guide */
                    <div className="flex flex-col items-center justify-center max-w-lg mx-auto text-left">
                      <div className="w-12 h-12 bg-gray-800/50 rounded-2xl flex items-center justify-center mb-4 border border-white/5">
                        <Activity className="w-6 h-6 text-gray-500" />
                      </div>
                      <h3 className="text-sm font-bold text-white mb-1 text-center">Inference Traces require the Wicklee Proxy</h3>
                      <p className="text-xs text-gray-500 leading-relaxed mb-4 text-center">
                        The proxy intercepts Ollama requests and logs latency, TTFT, and TPOT for every inference. Without it, the agent uses a lightweight probe for tok/s only.
                      </p>
                      <div className="bg-gray-800/30 border border-white/5 rounded-xl p-4 w-full space-y-3">
                        <p className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold">Setup (3 steps)</p>
                        <div className="space-y-2.5 text-xs text-gray-400">
                          <div className="flex gap-2.5">
                            <span className="text-gray-600 font-mono shrink-0">1.</span>
                            <div>
                              <span className="text-gray-300">Move Ollama to a different port:</span>
                              <code className="block font-mono text-[11px] text-gray-500 mt-1 bg-gray-900/50 rounded px-2 py-1">OLLAMA_HOST=127.0.0.1:11435 ollama serve</code>
                            </div>
                          </div>
                          <div className="flex gap-2.5">
                            <span className="text-gray-600 font-mono shrink-0">2.</span>
                            <div>
                              <span className="text-gray-300">Enable the proxy in config:</span>
                              <code className="block font-mono text-[11px] text-gray-500 mt-1 bg-gray-900/50 rounded px-2 py-1 whitespace-pre">{`[ollama_proxy]\nenabled = true\nollama_port = 11435`}</code>
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
                      <div className="bg-gray-800/20 border border-white/5 rounded-xl p-4 w-full mt-3">
                        <p className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold mb-2">Non-default runtime port?</p>
                        <p className="text-[11px] text-gray-500 leading-relaxed mb-2">
                          If your inference runtime uses a custom port, add it to config so the agent connects to the right endpoint:
                        </p>
                        <code className="block font-mono text-[11px] text-gray-500 bg-gray-900/50 rounded px-2 py-1 whitespace-pre">{`[runtime_ports]\nvllm = 18010      # or ollama = 11435`}</code>
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

// ── Dismissal Log Panel — Sprint 6 ────────────────────────────────────────────
// Renders all active (non-expired) accepted_states rows from the agent DuckDB.
// Source: GET /api/insights/dismissed (proxied to localhost:7700 in dev;
//         served directly by the embedded frontend in production).
// Available in Cockpit mode (isLocalHost) only — same gate as Agent Health.
//
// Columns: Pattern (human label + id), Scope (Fleet-wide / node_id),
//          Dismissed At, Expires (relative), Note (operator-supplied).

interface Dismissal {
  pattern_id:      string;
  node_id:         string;
  dismissed_at_ms: number;
  expires_at_ms:   number;
  note?:           string | null;
}

const PATTERN_LABELS: Record<string, string> = {
  thermal_drain:         'Thermal Drain',
  phantom_load:          'Phantom Load',
  wes_velocity_drop:     'WES Velocity Drop',
  power_gpu_decoupling:  'Power-GPU Decoupling',
  fleet_load_imbalance:  'Fleet Load Imbalance',
  memory_trajectory:     'Memory Trajectory',
  bandwidth_saturation:  'Bandwidth Saturation',
  power_jitter:          'Power Jitter',
  efficiency_drag:       'Efficiency Drag',
  swap_io_pressure:      'Swap I/O Pressure',
  clock_drift:           'Clock Drift',
  pcie_lane_degradation: 'PCIe Lane Degradation',
};

const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1_000;

function fmtExpiry(expiresAtMs: number): string {
  const diff = expiresAtMs - Date.now();
  if (diff <= 0)               return 'Expired';
  if (diff > FIVE_YEARS_MS)    return 'Permanent';
  const s = Math.floor(diff / 1_000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0)  return `in ${d}d ${h % 24}h`;
  if (h > 0)  return `in ${h}h ${m % 60}m`;
  return `in ${m}m`;
}

function fmtDismissedAt(ms: number): string {
  return new Date(ms).toLocaleString([], {
    month:  'short',
    day:    'numeric',
    hour:   '2-digit',
    minute: '2-digit',
  });
}

const DismissalLogPanel: React.FC = () => {
  const [rows,    setRows]    = useState<Dismissal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [, forceUpdate]       = useState(0); // ticks relative-time labels

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/insights/dismissed', {
        signal: (AbortSignal as { timeout?: (ms: number) => AbortSignal }).timeout?.(4_000) ?? undefined,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data: { dismissals: Dismissal[] } = await r.json();
      setRows(data.dismissals ?? []);
    } catch {
      setError('Dismissal log unavailable — agent may be offline or running a musl build.');
      setRows([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const poll = setInterval(load, 30_000);
    return () => clearInterval(poll);
  }, [load]);

  // Re-render every 30s so relative-time labels stay fresh without a re-fetch.
  useEffect(() => {
    const tick = setInterval(() => forceUpdate(n => n + 1), 30_000);
    return () => clearInterval(tick);
  }, []);

  return (
    <div className="space-y-4">

      {/* ── Section header ──────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-amber-500/10 border border-amber-500/20 rounded-xl flex items-center justify-center shrink-0">
            <ClipboardList className="w-4 h-4 text-amber-400" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-white">Dismissal Log</h2>
            <p className="text-xs text-gray-500">
              Accepted states · agent-persisted · DuckDB
              {rows.length > 0 && (
                <span className="ml-2 font-mono text-[9px] text-amber-400/60 bg-amber-500/10 px-1.5 py-0.5 rounded">
                  {rows.length} active
                </span>
              )}
            </p>
          </div>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="p-1.5 text-gray-600 hover:text-gray-400 transition-colors disabled:opacity-40"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* ── Error state ─────────────────────────────────────────────────────── */}
      {error && (
        <div className="flex items-center gap-3 p-4 bg-amber-500/8 border border-amber-500/20 rounded-xl">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
          <p className="text-xs text-amber-400/80">{error}</p>
        </div>
      )}

      {/* ── Table ───────────────────────────────────────────────────────────── */}
      {!error && (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
          {rows.length > 0 ? (
            <table className="w-full text-left">
              <thead>
                <tr className="bg-gray-950/50 text-[10px] text-gray-500 uppercase tracking-widest font-bold border-b border-gray-800">
                  <th className="px-5 py-3">Pattern</th>
                  <th className="px-5 py-3">Scope</th>
                  <th className="px-5 py-3">Dismissed</th>
                  <th className="px-5 py-3">Expires</th>
                  <th className="px-5 py-3">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/60 text-xs">
                {rows.map(row => {
                  const now         = Date.now();
                  const isPermanent = (row.expires_at_ms - now) > FIVE_YEARS_MS;
                  const isExpired   = row.expires_at_ms <= now;
                  return (
                    <tr
                      key={`${row.pattern_id}::${row.node_id}`}
                      className="hover:bg-gray-800/30 transition-colors"
                    >
                      {/* Pattern */}
                      <td className="px-5 py-3">
                        <div className="flex flex-col gap-0.5">
                          <span className="font-semibold text-gray-200">
                            {PATTERN_LABELS[row.pattern_id] ?? row.pattern_id}
                          </span>
                          <span className="font-mono text-[10px] text-gray-600">
                            {row.pattern_id}
                          </span>
                        </div>
                      </td>

                      {/* Scope */}
                      <td className="px-5 py-3">
                        {row.node_id === '' ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                            Fleet-wide
                          </span>
                        ) : (
                          <span className="font-mono text-[11px] text-gray-400">
                            {row.node_id}
                          </span>
                        )}
                      </td>

                      {/* Dismissed At */}
                      <td className="px-5 py-3 text-gray-500 font-mono text-[11px] whitespace-nowrap">
                        {fmtDismissedAt(row.dismissed_at_ms)}
                      </td>

                      {/* Expires */}
                      <td className="px-5 py-3 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1 text-[11px] font-mono font-semibold ${
                          isExpired   ? 'text-red-400'     :
                          isPermanent ? 'text-gray-500'    :
                                        'text-amber-400/80'
                        }`}>
                          {isPermanent ? (
                            <><XCircle className="w-3 h-3 shrink-0" /> Permanent</>
                          ) : isExpired ? (
                            'Expired'
                          ) : (
                            <><Timer className="w-3 h-3 shrink-0" /> {fmtExpiry(row.expires_at_ms)}</>
                          )}
                        </span>
                      </td>

                      {/* Note */}
                      <td className="px-5 py-3 text-gray-600 text-[11px] max-w-[14rem] truncate">
                        {row.note ?? '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : loading ? (
            <div className="flex items-center justify-center py-10 gap-2 text-gray-700">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              <span className="text-xs">Loading dismissals…</span>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-center px-6">
              <ClipboardList className="w-6 h-6 text-gray-700 mb-2" />
              <p className="text-xs text-gray-600 font-semibold mb-1">No active dismissals</p>
              <p className="text-[11px] text-gray-700 max-w-xs leading-relaxed">
                Dismissed insights appear here and persist across browser reloads. They expire
                after 1 hour by default, or indefinitely when permanently accepted.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Footer hint ─────────────────────────────────────────────────────── */}
      {!error && rows.length > 0 && (
        <p className="text-[11px] text-gray-700 leading-relaxed">
          Stored in <span className="font-mono text-gray-600">accepted_states</span> table ·{' '}
          agent-local <span className="font-mono text-gray-600">metrics.db</span> · expired rows
          pruned automatically. Re-dismiss an insight to extend its expiry window.
        </p>
      )}

    </div>
  );
};

// ── Event History Panel ──────────────────────────────────────────────────────
// Persisted Live Activity events from the agent's DuckDB (node_events table).
// 7-day retention. Cockpit-only — same gate as Agent Health and Metric History.

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

function relativeTime(tsMs: number): string {
  const delta = Date.now() - tsMs;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

const EventHistoryPanel: React.FC = () => {
  const { events, loading, error, hasMore, loadMore, refresh } = useEventHistory({ limit: 30 });

  return (
    <div className="bg-gray-900/50 border border-gray-800 rounded-lg p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-cyan-400" />
          <h3 className="text-sm font-semibold text-gray-300">Event History</h3>
          <span className="text-[10px] text-gray-600 font-mono ml-1">node_events · 7d</span>
        </div>
        <button
          onClick={refresh}
          className="p-1 rounded hover:bg-gray-800 transition-colors"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 text-gray-500 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 text-amber-400 text-xs mb-3">
          <AlertTriangle className="w-3.5 h-3.5" />
          <span>Failed to load event history: {error}</span>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && events.length === 0 && (
        <p className="text-xs text-gray-600 text-center py-4">
          No events recorded yet. Events persist to DuckDB on agent startup, updates, and
          lifecycle changes.
        </p>
      )}

      {/* Event list */}
      {events.length > 0 && (
        <div className="space-y-1.5 max-h-[300px] overflow-y-auto pr-1">
          {events.map((ev, i) => (
            <div key={`${ev.ts_ms}-${i}`}
              className="flex items-start gap-2.5 py-1.5 px-2 rounded hover:bg-gray-800/50 transition-colors"
            >
              {/* Level dot */}
              <span className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${LEVEL_DOT[ev.level] ?? 'bg-gray-500'}`} />

              {/* Content */}
              <div className="flex-1 min-w-0">
                <p className="text-xs text-gray-300 leading-snug truncate">{ev.message}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[10px] text-gray-600 font-mono">{relativeTime(ev.ts_ms)}</span>
                  {ev.event_type && (
                    <span className={`text-[10px] font-mono ${EVENT_TYPE_COLORS[ev.event_type] ?? 'text-gray-500'}`}>
                      {ev.event_type}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Load more */}
      {hasMore && events.length > 0 && (
        <button
          onClick={loadMore}
          disabled={loading}
          className="mt-3 w-full text-[11px] text-gray-500 hover:text-gray-400 py-1.5 rounded border border-gray-800 hover:border-gray-700 transition-colors"
        >
          {loading ? 'Loading…' : 'Load older events'}
        </button>
      )}

      {/* Footer */}
      {events.length > 0 && (
        <p className="text-[11px] text-gray-700 leading-relaxed mt-3">
          Stored in <span className="font-mono text-gray-600">node_events</span> table ·{' '}
          agent-local <span className="font-mono text-gray-600">metrics.db</span> · 7-day retention.
        </p>
      )}
    </div>
  );
};

// ── Main component ─────────────────────────────────────────────────────────────

const TracesView: React.FC<TracesViewProps> = ({ nodes: _nodes, tenantId, pairingInfo }) => {
  // node_id is always populated once pairingInfo loads from /api/pair/status.
  // Gate on pairingInfo !== null (not on nodeId) so the panels aren't permanently
  // hidden during the brief window before the first API response arrives.
  const nodeId = pairingInfo?.node_id ?? '';
  const { proxyActive, listenPort: proxyListenPort, targetPort: proxyTargetPort } = useProxyStatus();

  return (
    <div className="space-y-8">
      <SovereigntySection pairingInfo={pairingInfo} proxyActive={proxyActive} proxyListenPort={proxyListenPort} proxyTargetPort={proxyTargetPort} />
      {isLocalHost && <TraceTable tenantId={tenantId} proxyActive={proxyActive} proxyListenPort={proxyListenPort} proxyTargetPort={proxyTargetPort} />}
      {/* Phase 4A — Raw Metric History + Agent Health (Cockpit / localhost only) */}
      {isLocalHost && pairingInfo !== null && <MetricHistoryPanel nodeId={nodeId} />}
      {isLocalHost && pairingInfo !== null && <AgentHealthPanel   nodeId={nodeId} />}
      {/* Phase 3B — Event History (Cockpit / localhost only) */}
      {isLocalHost && pairingInfo !== null && <EventHistoryPanel />}
      {/* Sprint 6 — Dismissal Log (Cockpit / localhost only) */}
      {isLocalHost && pairingInfo !== null && <DismissalLogPanel />}
    </div>
  );
};

export default TracesView;
