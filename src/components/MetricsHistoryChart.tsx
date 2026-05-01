/**
 * MetricsHistoryChart — historical time-series for Tok/s, Power, GPU%, and Mem%.
 *
 * Fetches from GET /api/fleet/metrics-history?range=...&node_id=...
 * Short ranges (1h) pull from metrics_raw (60-second buckets).
 * Longer ranges pull from metrics_5min aggregates (no CPU% available).
 * The tok/s metric shows a dashed P95 reference line when data is from metrics_5min.
 *
 * Tier gating mirrors WESHistoryChart:
 *   Community — 1H / 24H
 *   Pro       — + 7D
 *   Team      — + 30D / 90D
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { Activity, Lock, RefreshCw, FileDown } from 'lucide-react';
import { SubscriptionTier, SentinelMetrics } from '../types';
import { useFleetStream } from '../contexts/FleetStreamContext';
import { getNodePowerW } from '../utils/power';

// ── Config ────────────────────────────────────────────────────────────────────

const CLOUD_URL = (() => {
  const v = (import.meta.env.VITE_CLOUD_URL as string) ?? '';
  if (!v) return 'https://vibrant-fulfillment-production-62c0.up.railway.app';
  if (v === '/') return '';
  return v.startsWith('http') ? v : `https://${v}`;
})();

// ── Types ─────────────────────────────────────────────────────────────────────

type TimeRange  = '1h' | '24h' | '7d' | '30d' | '90d';
type MetricKey  = 'tok_s' | 'watts' | 'gpu_pct' | 'mem_pct' | 'ttft_ms' | 'e2e_latency_ms';

interface MetricPoint {
  ts_ms:            number;
  tok_s:            number | null;
  tok_s_p95:        number | null;
  watts:            number | null;
  gpu_pct:          number | null;
  mem_pct:          number | null;
  ttft_ms?:         number | null;
  e2e_latency_ms?:  number | null;
}

interface MetricsNode {
  node_id:  string;
  hostname: string;
  points:   MetricPoint[];
}

interface ChartPoint {
  label:     string;
  value:     number | null;  // selected metric
  p95:       number | null;  // tok_s P95 (only for tok_s metric)
}

// ── Metric definitions ────────────────────────────────────────────────────────

const METRIC_CONFIG: Record<MetricKey, {
  label:      string;
  unit:       string;
  color:      string;
  gradId:     string;
  getPoint:   (p: MetricPoint) => number | null;
  getLive:    (m: SentinelMetrics) => number | null;
  getP95:     (p: MetricPoint) => number | null;
  decimals:   number;
  domain:     [number | 'auto', number | 'auto'];
}> = {
  tok_s: {
    label:    'Tok/s',
    unit:     'tok/s',
    color:    '#6366f1',
    gradId:   'gradToks',
    getPoint: (p) => p.tok_s,
    getLive:  (m) => m.ollama_tokens_per_second ?? m.vllm_tokens_per_sec ?? null,
    getP95:   (p) => p.tok_s_p95,
    decimals: 1,
    domain:   [0, 'auto'],
  },
  watts: {
    label:    'Power',
    unit:     'W',
    color:    '#f59e0b',
    gradId:   'gradWatts',
    getPoint: (p) => p.watts,
    getLive:  (m) => getNodePowerW(m),
    getP95:   () => null,
    decimals: 1,
    domain:   [0, 'auto'],
  },
  gpu_pct: {
    label:    'GPU%',
    unit:     '%',
    color:    '#8b5cf6',
    gradId:   'gradGpu',
    getPoint: (p) => p.gpu_pct,
    getLive:  (m) => m.gpu_utilization_percent ?? m.nvidia_gpu_utilization_percent ?? null,
    getP95:   () => null,
    decimals: 0,
    domain:   [0, 100],
  },
  mem_pct: {
    label:    'Mem%',
    unit:     '%',
    color:    '#06b6d4',
    gradId:   'gradMem',
    getPoint: (p) => p.mem_pct,
    getLive:  (m) => m.memory_pressure_percent ?? (
      m.total_memory_mb > 0
        ? Math.round((m.used_memory_mb / m.total_memory_mb) * 100)
        : null
    ),
    getP95:   () => null,
    decimals: 0,
    domain:   [0, 100],
  },
  ttft_ms: {
    label:    'TTFT',
    unit:     'ms',
    color:    '#22d3ee',
    gradId:   'gradTtft',
    getPoint: (p) => p.ttft_ms ?? null,
    getLive:  (m) => m.vllm_avg_ttft_ms ?? m.ollama_proxy_avg_ttft_ms ?? m.ollama_ttft_ms ?? null,
    getP95:   () => null,
    decimals: 0,
    domain:   [0, 'auto'],
  },
  e2e_latency_ms: {
    label:    'E2E Latency',
    unit:     'ms',
    color:    '#a78bfa',
    gradId:   'gradE2e',
    getPoint: (p) => p.e2e_latency_ms ?? null,
    getLive:  (m) => m.vllm_avg_e2e_latency_ms ?? m.ollama_proxy_avg_latency_ms ?? null,
    getP95:   () => null,
    decimals: 0,
    domain:   [0, 'auto'],
  },
};

const METRICS: MetricKey[] = ['tok_s', 'watts', 'gpu_pct', 'mem_pct', 'ttft_ms', 'e2e_latency_ms'];

// ── Range config ──────────────────────────────────────────────────────────────

const RANGE_CONFIG: Record<TimeRange, {
  label:      string;
  minTier:    SubscriptionTier;
  historyMin: number;
  fmtTs:      (ms: number) => string;
}> = {
  '1h':  { label: '1H',  minTier: 'community', historyMin: 1,  fmtTs: (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
  '24h': { label: '24H', minTier: 'community', historyMin: 1,  fmtTs: (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
  '7d':  { label: '7D',  minTier: 'pro',       historyMin: 7,  fmtTs: (ms) => new Date(ms).toLocaleDateString([], { month: 'numeric', day: 'numeric' }) },
  '30d': { label: '30D', minTier: 'team',      historyMin: 30, fmtTs: (ms) => new Date(ms).toLocaleDateString([], { month: 'numeric', day: 'numeric' }) },
  '90d': { label: '90D', minTier: 'team',      historyMin: 90, fmtTs: (ms) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' }) },
};

const RANGES: TimeRange[] = ['1h', '24h', '7d', '30d', '90d'];

function tierUpgradeLabel(minTier: SubscriptionTier): string {
  return minTier === 'pro' ? 'Pro' : minTier === 'team' ? 'Pro' : '';
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  getToken:         () => Promise<string | null>;
  historyDays:      number;
  subscriptionTier: SubscriptionTier;
  /** External node selection — syncs with WESHistoryChart */
  selectedNodeId?: string | null;
  onNodeSelect?:   (nodeId: string) => void;
}

// ── Tooltip ───────────────────────────────────────────────────────────────────

const MetricTooltip: React.FC<{
  active?: boolean;
  payload?: Array<{ value: number | null; name: string; color: string }>;
  label?: string;
  metric: MetricKey;
}> = ({ active, payload, label, metric }) => {
  if (!active || !payload?.length) return null;
  const cfg = METRIC_CONFIG[metric];
  const main = payload.find(p => p.name === 'value');
  const p95  = payload.find(p => p.name === 'p95');
  if (!main?.value) return null;
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-xs shadow-xl">
      <p className="text-gray-500 mb-1">{label}</p>
      <p className="font-telin text-white font-semibold">
        {main.value.toFixed(cfg.decimals)} <span className="text-gray-500">{cfg.unit}</span>
      </p>
      {p95?.value != null && (
        <p className="text-indigo-400/70 mt-0.5">
          P95: {p95.value.toFixed(cfg.decimals)} {cfg.unit}
        </p>
      )}
    </div>
  );
};

// ── Component ─────────────────────────────────────────────────────────────────

const MetricsHistoryChart: React.FC<Props> = ({
  getToken, historyDays, subscriptionTier,
  selectedNodeId: externalSelectedId,
  onNodeSelect: externalOnNodeSelect,
}) => {
  const [range,      setRange]      = useState<TimeRange>('1h');
  const [metric,     setMetric]     = useState<MetricKey>('tok_s');
  const [nodes,      setNodes]      = useState<MetricsNode[]>([]);
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null);

  const selectedId = externalSelectedId ?? internalSelectedId;
  const setSelectedId = (id: string) => {
    if (externalOnNodeSelect) externalOnNodeSelect(id);
    else setInternalSelectedId(id);
  };
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [lastFetch,  setLastFetch]  = useState(0);

  const { allNodeMetrics } = useFleetStream();

  const fetchHistory = useCallback(async (r: TimeRange) => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const url   = `${CLOUD_URL}/api/fleet/metrics-history?range=${r}`;
      const res   = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) { setError(`Server returned ${res.status}`); return; }
      const data           = await res.json();
      const fetched: MetricsNode[] = data.nodes ?? [];
      setNodes(fetched);
      const currentId = externalSelectedId ?? internalSelectedId;
      if (!currentId || !fetched.some(n => n.node_id === currentId)) {
        const newId = fetched.find(n => n.points.length > 0)?.node_id ?? fetched[0]?.node_id ?? null;
        if (newId) setSelectedId(newId);
      }
      setLastFetch(Date.now());
    } catch {
      setError('Network error — check connection');
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => { fetchHistory(range); }, [range]);

  const cfg        = METRIC_CONFIG[metric];
  const rangeCfg   = RANGE_CONFIG[range];
  const node       = nodes.find(n => n.node_id === selectedId);
  const hasData    = (node?.points.length ?? 0) > 0;
  const hasP95     = metric === 'tok_s' && range !== '1h';

  const chartData: ChartPoint[] = (node?.points ?? []).map(p => ({
    label: rangeCfg.fmtTs(p.ts_ms),
    value: cfg.getPoint(p) != null ? parseFloat((cfg.getPoint(p) as number).toFixed(cfg.decimals)) : null,
    p95:   hasP95 && cfg.getP95(p) != null ? parseFloat((cfg.getP95(p) as number).toFixed(cfg.decimals)) : null,
  }));

  // Live current value from SSE (shown as a reference line annotation)
  const liveNode  = selectedId ? allNodeMetrics[selectedId] : null;
  const liveValue = liveNode ? cfg.getLive(liveNode) : null;

  const tierRank: Record<string, number> = { community: 0, pro: 1, team: 2, enterprise: 3 };
  const userRank = tierRank[subscriptionTier] ?? 0;
  const isRangeLocked = (r: TimeRange): boolean => {
    const rc = RANGE_CONFIG[r];
    const requiredRank = tierRank[rc.minTier] ?? 0;
    return userRank < requiredRank;
  };

  const ago = lastFetch > 0
    ? Math.round((Date.now() - lastFetch) / 1000)
    : null;

  // ── CSV export — build from in-memory chart data ──────────────────────
  const handleCsvDownload = useCallback(() => {
    if (!node || node.points.length === 0) return;
    const header = 'timestamp,tok_s,watts,gpu_pct,mem_pct';
    const rows = node.points.map(p =>
      `${new Date(p.ts_ms).toISOString()},${p.tok_s ?? ''},${p.watts ?? ''},${p.gpu_pct ?? ''},${p.mem_pct ?? ''}`
    );
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wicklee-metrics-${node.hostname || node.node_id}-${range}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [node, range]);

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-2xl overflow-hidden">

      {/* ── Header ───────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700 gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Activity className="w-3.5 h-3.5 text-gray-500 shrink-0" />
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
            Performance History
          </span>
          {loading && <RefreshCw className="w-3 h-3 text-indigo-400 animate-spin" />}
          {ago != null && !loading && (
            <span className="text-[10px] text-gray-700">{ago}s ago</span>
          )}
        </div>

        {/* Time range + refresh */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-gray-900/60 rounded-lg p-0.5">
            {RANGES.map(r => {
              const locked = isRangeLocked(r);
              return (
                <button
                  key={r}
                  onClick={() => !locked && setRange(r)}
                  disabled={locked}
                  title={locked ? `Requires ${tierUpgradeLabel(RANGE_CONFIG[r].minTier)}` : undefined}
                  className={`relative px-2.5 py-1 rounded-md text-[10px] font-bold transition-colors ${
                    locked
                      ? 'text-gray-700 cursor-not-allowed'
                      : range === r
                      ? 'bg-gray-700 text-white'
                      : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {RANGE_CONFIG[r].label}
                  {locked && (
                    <Lock className="w-2 h-2 absolute -top-0.5 -right-0.5 text-gray-600" />
                  )}
                </button>
              );
            })}
          </div>
          {hasData && (
            <button
              onClick={handleCsvDownload}
              title="Download CSV"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold text-gray-500 hover:text-gray-300 hover:bg-gray-700 transition-colors"
            >
              <FileDown className="w-3.5 h-3.5" />
              CSV
            </button>
          )}
          <button
            onClick={() => fetchHistory(range)}
            className="p-1.5 rounded-lg text-gray-600 hover:text-gray-400 hover:bg-gray-700 transition-colors"
            aria-label="Refresh"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* ── Metric selector ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 px-5 pt-3 pb-1">
        {METRICS.map(m => {
          const mc = METRIC_CONFIG[m];
          return (
            <button
              key={m}
              onClick={() => setMetric(m)}
              className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-colors ${
                metric === m
                  ? 'text-white border'
                  : 'text-gray-500 hover:text-gray-300 border border-transparent'
              }`}
              style={metric === m ? { borderColor: `${mc.color}40`, backgroundColor: `${mc.color}15`, color: mc.color } : undefined}
            >
              {mc.label}
            </button>
          );
        })}
      </div>

      {/* ── Node tabs (multi-node) ───────────────────────────────────────────── */}
      {nodes.length > 1 && (
        <div className="flex items-center gap-1 px-5 pb-2 overflow-x-auto">
          {nodes.map(n => (
            <button
              key={n.node_id}
              onClick={() => setSelectedId(n.node_id)}
              className={`px-2.5 py-1 rounded-lg text-[10px] font-medium whitespace-nowrap transition-colors ${
                selectedId === n.node_id
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-600 hover:text-gray-400'
              }`}
            >
              {n.hostname !== n.node_id ? n.hostname : n.node_id}
            </button>
          ))}
        </div>
      )}

      {/* ── Chart area ───────────────────────────────────────────────────────── */}
      <div className="px-2 pb-4 pt-2">
        {error ? (
          <div className="flex flex-col items-center justify-center h-40 gap-3">
            <p className="text-xs text-red-400">{error}</p>
            <button
              onClick={() => fetchHistory(range)}
              className="text-xs text-gray-500 hover:text-gray-300 underline"
            >
              Retry
            </button>
          </div>
        ) : !hasData ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2 text-center px-6">
            <Activity className="w-5 h-5 text-gray-700" />
            <p className="text-xs text-gray-600">
              {loading ? 'Loading…' : 'Collecting data — history builds as your node reports metrics.'}
            </p>
            {!loading && subscriptionTier === 'community' && range === '24h' && (
              <p className="text-[11px] text-indigo-400/60">
                Fleet history is active. <strong>Pro</strong> unlocks 7-day historical trends.
              </p>
            )}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: 0 }} syncId="perf-charts">
              <defs>
                <linearGradient id={cfg.gradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={cfg.color} stopOpacity={0.22} />
                  <stop offset="95%" stopColor={cfg.color} stopOpacity={0.03} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
              <XAxis
                dataKey="label"
                stroke="#374151"
                tick={{ fill: '#6b7280', fontSize: 10 }}
                interval="preserveStartEnd"
                minTickGap={60}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                stroke="#374151"
                tick={{ fill: '#6b7280', fontSize: 10 }}
                domain={cfg.domain}
                tickFormatter={(v) => `${v}${cfg.unit === '%' ? '%' : ''}`}
                tickLine={false}
                axisLine={false}
                width={38}
              />
              <Tooltip
                content={<MetricTooltip metric={metric} />}
                cursor={{ stroke: '#374151', strokeWidth: 1 }}
              />

              {/* Main area */}
              <Area
                type="monotone"
                dataKey="value"
                stroke={cfg.color}
                strokeWidth={2}
                fill={`url(#${cfg.gradId})`}
                dot={false}
                activeDot={{ r: 3, fill: cfg.color, stroke: 'transparent' }}
                connectNulls
              />

              {/* P95 dashed reference line for tok/s on 24h+ */}
              {hasP95 && (
                <Line
                  type="monotone"
                  dataKey="p95"
                  stroke={cfg.color}
                  strokeWidth={1}
                  strokeDasharray="4 3"
                  strokeOpacity={0.45}
                  dot={false}
                  activeDot={false}
                  connectNulls
                />
              )}

              {/* Live current value — horizontal reference */}
              {liveValue != null && (
                <ReferenceLine
                  y={liveValue}
                  stroke={cfg.color}
                  strokeOpacity={0.6}
                  strokeDasharray="2 4"
                  label={{
                    value: `Now: ${liveValue.toFixed(cfg.decimals)}${cfg.unit}`,
                    position: 'insideTopRight',
                    fill: cfg.color,
                    fontSize: 9,
                    opacity: 0.7,
                  }}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── Legend ───────────────────────────────────────────────────────────── */}
      {hasData && hasP95 && (
        <div className="flex items-center gap-4 px-5 pb-3 text-[10px] text-gray-600">
          <span className="flex items-center gap-1.5">
            <span className="w-6 h-0.5 bg-indigo-500 inline-block rounded" />
            avg
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-6 h-0.5 inline-block rounded" style={{ background: 'repeating-linear-gradient(to right, #6366f1 0, #6366f1 4px, transparent 4px, transparent 7px)', opacity: 0.45 }} />
            P95
          </span>
          {liveValue != null && (
            <span className="flex items-center gap-1.5">
              <span className="w-6 h-0.5 inline-block rounded" style={{ background: 'repeating-linear-gradient(to right, #6366f1 0, #6366f1 2px, transparent 2px, transparent 6px)', opacity: 0.6 }} />
              live
            </span>
          )}
        </div>
      )}
    </div>
  );
};

export default MetricsHistoryChart;
