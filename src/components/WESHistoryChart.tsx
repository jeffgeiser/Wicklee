import React, { useState, useEffect, useCallback } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';
import { TrendingUp, Lock, RefreshCw } from 'lucide-react';
import { SubscriptionTier } from '../types';

// ── Config ────────────────────────────────────────────────────────────────────

const CLOUD_URL = (() => {
  const v = (import.meta.env.VITE_CLOUD_URL as string) ?? '';
  if (!v) return 'https://vibrant-fulfillment-production-62c0.up.railway.app';
  if (v === '/') return '';
  return v.startsWith('http') ? v : `https://${v}`;
})();

// ── Types ─────────────────────────────────────────────────────────────────────

type TimeRange = '1h' | '24h' | '7d' | '30d' | '90d';

interface WESPoint {
  ts_ms: number;
  raw_wes:        number | null;
  penalized_wes:  number | null;
  thermal_state:  string;
}

interface WESNode {
  node_id:  string;
  hostname: string;
  points:   WESPoint[];
}

interface ChartPoint {
  label:          string;
  penalized_wes:  number | null;
  thermal_gap:    number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const RANGE_CONFIG: Record<TimeRange, {
  label:      string;
  minTier:    SubscriptionTier;
  historyMin: number;    // historyDays required
  fmtTs:      (ms: number) => string;
}> = {
  '1h':  { label: '1H',  minTier: 'community',  historyMin: 1,  fmtTs: (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
  '24h': { label: '24H', minTier: 'community',  historyMin: 1,  fmtTs: (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
  '7d':  { label: '7D',  minTier: 'pro',        historyMin: 7,  fmtTs: (ms) => new Date(ms).toLocaleDateString([], { month: 'numeric', day: 'numeric' }) },
  '30d': { label: '30D', minTier: 'team',       historyMin: 30, fmtTs: (ms) => new Date(ms).toLocaleDateString([], { month: 'numeric', day: 'numeric' }) },
  '90d': { label: '90D', minTier: 'team',       historyMin: 90, fmtTs: (ms) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' }) },
};

const RANGES: TimeRange[] = ['1h', '24h', '7d', '30d', '90d'];

function buildChartPoints(points: WESPoint[], fmtTs: (ms: number) => string): ChartPoint[] {
  return points.map(p => {
    const penalized = p.penalized_wes;
    const raw       = p.raw_wes;
    const gap       = raw != null && penalized != null && raw > penalized
      ? parseFloat((raw - penalized).toFixed(3))
      : 0;
    return {
      label:         fmtTs(p.ts_ms),
      penalized_wes: penalized != null ? parseFloat(penalized.toFixed(3)) : null,
      thermal_gap:   gap > 0 ? gap : 0,
    };
  });
}

function tierUpgradeLabel(minTier: SubscriptionTier): string {
  return minTier === 'pro'  ? 'Pro' :
         minTier === 'team' ? 'Team' : '';
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface WESHistoryChartProps {
  getToken:    () => Promise<string | null>;
  historyDays: number;
  /** Subscription tier for upgrade copy */
  subscriptionTier: SubscriptionTier;
}

// ── Component ─────────────────────────────────────────────────────────────────

const WESHistoryChart: React.FC<WESHistoryChartProps> = ({
  getToken,
  historyDays,
  subscriptionTier,
}) => {
  const [range,       setRange]       = useState<TimeRange>('24h');
  const [nodes,       setNodes]       = useState<WESNode[]>([]);
  const [selectedId,  setSelectedId]  = useState<string | null>(null);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [lastFetch,   setLastFetch]   = useState(0);

  const fetchHistory = useCallback(async (r: TimeRange) => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const url   = `${CLOUD_URL}/api/fleet/wes-history?range=${r}`;
      const res   = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        setError(`Server returned ${res.status}`);
        return;
      }
      const data = await res.json();
      const fetched: WESNode[] = data.nodes ?? [];
      setNodes(fetched);
      // Auto-select first node with data, or first node overall
      const withData = fetched.find(n => n.points.length > 0);
      setSelectedId(prev =>
        fetched.some(n => n.node_id === prev) ? prev : (withData?.node_id ?? fetched[0]?.node_id ?? null)
      );
      setLastFetch(Date.now());
    } catch (e) {
      setError('Failed to load history');
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  // Fetch on range change
  useEffect(() => {
    if (RANGE_CONFIG[range].historyMin > historyDays) return; // gate
    fetchHistory(range);
  }, [range, fetchHistory, historyDays]);

  // ── Derived chart data ────────────────────────────────────────────────────

  const selectedNode  = nodes.find(n => n.node_id === selectedId);
  const cfg           = RANGE_CONFIG[range];
  const chartPoints   = selectedNode ? buildChartPoints(selectedNode.points, cfg.fmtTs) : [];

  const hasData = chartPoints.some(p => p.penalized_wes != null && p.penalized_wes > 0);
  const hasThermalCost = chartPoints.some(p => (p.thermal_gap ?? 0) > 0);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-6 shadow-sm dark:shadow-none">

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-indigo-400" />
          <h3 className="font-semibold text-sm text-gray-800 dark:text-gray-200">
            WES Trend
          </h3>
          {hasThermalCost && (
            <span className="text-[10px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded px-1.5 py-0.5">
              Thermal Cost Visible
            </span>
          )}
        </div>

        {/* Time range selector */}
        <div className="flex items-center gap-1">
          {RANGES.map(r => {
            const rcfg    = RANGE_CONFIG[r];
            const locked  = rcfg.historyMin > historyDays;
            const active  = r === range;
            return (
              <button
                key={r}
                onClick={() => !locked && setRange(r)}
                disabled={locked}
                title={locked ? `Requires ${tierUpgradeLabel(rcfg.minTier)} plan` : undefined}
                className={`
                  flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors
                  ${active && !locked
                    ? 'bg-indigo-600 text-white'
                    : locked
                    ? 'text-gray-600 dark:text-gray-700 cursor-not-allowed'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'}
                `}
              >
                {locked && <Lock className="w-2.5 h-2.5" />}
                {rcfg.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Node tabs (if multiple nodes) */}
      {nodes.length > 1 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {nodes.map(n => (
            <button
              key={n.node_id}
              onClick={() => setSelectedId(n.node_id)}
              className={`px-3 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
                n.node_id === selectedId
                  ? 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'
                  : 'text-gray-500 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-400'
              }`}
            >
              {n.hostname}
            </button>
          ))}
        </div>
      )}

      {/* Locked state */}
      {cfg.historyMin > historyDays && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Lock className="w-8 h-8 text-gray-600 mb-3" />
          <p className="text-sm font-semibold text-gray-500">
            {tierUpgradeLabel(cfg.minTier)} Plan Required
          </p>
          <p className="text-xs text-gray-600 mt-1">
            {cfg.historyMin}-day history unlocks on {tierUpgradeLabel(cfg.minTier)}.
          </p>
        </div>
      )}

      {/* Loading */}
      {loading && cfg.historyMin <= historyDays && (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="w-5 h-5 text-gray-600 animate-spin" />
        </div>
      )}

      {/* Error */}
      {error && !loading && cfg.historyMin <= historyDays && (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <p className="text-xs text-red-400">{error}</p>
          <button
            onClick={() => fetchHistory(range)}
            className="mt-2 text-[11px] text-gray-500 hover:text-gray-400 underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* No data yet */}
      {!loading && !error && cfg.historyMin <= historyDays && !hasData && lastFetch > 0 && (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <TrendingUp className="w-7 h-7 text-gray-600 mb-2" />
          <p className="text-sm text-gray-500 font-medium">Collecting data…</p>
          <p className="text-xs text-gray-600 mt-1">
            WES history builds as your fleet runs. Check back after a few inference cycles.
          </p>
          {subscriptionTier === 'community' && (
            <p className="mt-3 text-[11px] text-indigo-400/70">
              DuckDB is active.{' '}
              <span className="text-indigo-400 font-semibold">Pro</span>
              {' '}unlocks 7-day historical trends.
            </p>
          )}
        </div>
      )}

      {/* Chart */}
      {!loading && !error && hasData && (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartPoints} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="gradWES" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#6366f1" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0.04} />
                </linearGradient>
                <linearGradient id="gradThermal" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"  stopColor="#f59e0b" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="#f59e0b" stopOpacity={0.15} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="currentColor"
                className="text-gray-100 dark:text-gray-800"
                vertical={false}
              />
              <XAxis
                dataKey="label"
                stroke="#6b7280"
                fontSize={10}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                stroke="#6b7280"
                fontSize={10}
                axisLine={false}
                tickLine={false}
                domain={[0, 'auto']}
                tickFormatter={(v: number) => v >= 1 ? v.toFixed(1) : v.toFixed(2)}
                width={36}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1f2937',
                  border: '1px solid #374151',
                  borderRadius: '8px',
                  fontSize: '12px',
                }}
                labelStyle={{ color: '#9ca3af', marginBottom: 4 }}
                formatter={(value: number, name: string) => {
                  if (name === 'penalized_wes') return [value?.toFixed(3) ?? '—', 'Penalized WES'];
                  if (name === 'thermal_gap')   return [value?.toFixed(3) ?? '—', 'Thermal Cost'];
                  return [value, name];
                }}
              />
              {/* Penalized WES — main fill (indigo) */}
              <Area
                type="monotone"
                dataKey="penalized_wes"
                stackId="wes"
                stroke="#6366f1"
                strokeWidth={1.5}
                fill="url(#gradWES)"
                dot={false}
                activeDot={{ r: 3, fill: '#6366f1' }}
                connectNulls={false}
              />
              {/* Thermal gap — amber band stacked on top of penalized WES */}
              {hasThermalCost && (
                <Area
                  type="monotone"
                  dataKey="thermal_gap"
                  stackId="wes"
                  stroke="none"
                  fill="url(#gradThermal)"
                  dot={false}
                  connectNulls={false}
                />
              )}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Legend / key */}
      {!loading && hasData && (
        <div className="flex items-center gap-4 mt-3">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-0.5 bg-indigo-400" />
            <span className="text-[10px] text-gray-500">Penalized WES</span>
          </div>
          {hasThermalCost && (
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-2 bg-amber-500/30 rounded-sm" />
              <span className="text-[10px] text-gray-500">Thermal Cost</span>
            </div>
          )}
          {lastFetch > 0 && (
            <span className="text-[10px] text-gray-600 ml-auto">
              {selectedNode?.hostname}
            </span>
          )}
        </div>
      )}
    </div>
  );
};

export default WESHistoryChart;
