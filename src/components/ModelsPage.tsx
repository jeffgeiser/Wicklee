import React, { useEffect, useMemo, useState } from 'react';
import { Boxes, ArrowRightLeft, DollarSign, BarChart3, Activity } from 'lucide-react';
import { FleetNode, ModelLiveMetrics, SentinelMetrics } from '../types';
import { useFleetStream } from '../contexts/FleetStreamContext';
import { wesColorClass } from '../utils/wes';
import ModelDiscoveryCard from './insights/ModelDiscoveryCard';
import FleetModelDiscovery from './insights/FleetModelDiscovery';

interface ModelsPageProps {
  isLocalHost: boolean;
  getToken?: () => Promise<string | null>;
  nodes: FleetNode[];
}

// ── Section wrapper ─────────────────────────────────────────────────────────
interface SectionProps {
  eyebrow: string;
  title: string;
  icon: React.ReactNode;
  subtitle?: string;
  children: React.ReactNode;
}
const Section: React.FC<SectionProps> = ({ eyebrow, title, icon, subtitle, children }) => (
  <section className="space-y-3">
    <div className="flex items-start gap-3">
      <div className="h-9 w-9 rounded-lg bg-gray-800/50 border border-gray-700 flex items-center justify-center text-blue-400 shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[10px] tracking-widest uppercase text-gray-500 font-medium">{eyebrow}</p>
        <h2 className="text-lg font-semibold text-white leading-tight">{title}</h2>
        {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
      </div>
    </div>
    {children}
  </section>
);

const EmptyState: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="rounded-2xl border border-gray-700 bg-gray-800/30 p-8 text-center">
    <p className="text-sm text-gray-400">{children}</p>
  </div>
);

const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`rounded-2xl border border-gray-700 bg-gray-800/50 ${className}`}>{children}</div>
);

// ── Section: Active Models ──────────────────────────────────────────────────
interface ActiveModelRow {
  node_id: string;
  node_label: string;
  model: ModelLiveMetrics;
}

const ActiveModelsSection: React.FC<{ isLocalHost: boolean; nodes: FleetNode[] }> = ({ isLocalHost, nodes }) => {
  const { allNodeMetrics } = useFleetStream();
  const [localSentinel, setLocalSentinel] = useState<SentinelMetrics | null>(null);

  // Localhost: subscribe to /api/metrics SSE
  useEffect(() => {
    if (!isLocalHost) return;
    let es: EventSource | null = null;
    try {
      es = new EventSource('http://localhost:7700/api/metrics');
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as SentinelMetrics;
          setLocalSentinel(data);
        } catch { /* ignore parse errors */ }
      };
      es.onerror = () => { /* keep retrying */ };
    } catch { /* ignore */ }
    return () => { es?.close(); };
  }, [isLocalHost]);

  const rows: ActiveModelRow[] = useMemo(() => {
    const out: ActiveModelRow[] = [];
    if (isLocalHost) {
      const s = localSentinel;
      if (s?.active_models?.length) {
        for (const m of s.active_models) {
          out.push({ node_id: s.node_id, node_label: s.hostname || s.node_id, model: m });
        }
      }
    } else {
      for (const node of nodes) {
        const m = allNodeMetrics[node.node_id];
        if (!m?.active_models?.length) continue;
        const label = node.display_name || m.hostname || node.node_id;
        for (const am of m.active_models) {
          out.push({ node_id: node.node_id, node_label: label, model: am });
        }
      }
    }
    return out;
  }, [isLocalHost, localSentinel, nodes, allNodeMetrics]);

  return (
    <Section
      eyebrow="Live"
      title="Active Models"
      icon={<Activity className="w-4 h-4" />}
      subtitle="Models currently loaded into GPU memory and serving requests."
    >
      {rows.length === 0 ? (
        <EmptyState>No models currently loaded. Pull one with <code className="font-mono text-emerald-300">ollama pull llama3.2</code>.</EmptyState>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-widest text-gray-500 border-b border-gray-700">
                  {!isLocalHost && <th className="text-left font-medium px-4 py-3">Node</th>}
                  <th className="text-left font-medium px-4 py-3">Model</th>
                  <th className="text-right font-medium px-4 py-3">tok/s</th>
                  <th className="text-right font-medium px-4 py-3">WES</th>
                  <th className="text-right font-medium px-4 py-3">VRAM</th>
                  <th className="text-right font-medium px-4 py-3">Requests</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.node_id}-${r.model.model}-${i}`} className="border-b border-gray-700/50 last:border-0 hover:bg-gray-800/30">
                    {!isLocalHost && <td className="px-4 py-3 text-gray-300 text-xs">{r.node_label}</td>}
                    <td className="px-4 py-3 font-mono text-xs text-white">{r.model.model}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-gray-200">{r.model.tok_s != null ? r.model.tok_s.toFixed(1) : '—'}</td>
                    <td className={`px-4 py-3 text-right font-mono text-xs ${wesColorClass(r.model.wes ?? null)}`}>
                      {r.model.wes != null ? r.model.wes.toFixed(2) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-gray-200">
                      {r.model.vram_mb != null ? `${(r.model.vram_mb / 1024).toFixed(1)} GB` : '—'}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-gray-200">{r.model.request_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </Section>
  );
};

// ── Section: Model Comparison ───────────────────────────────────────────────
interface ComparisonRow {
  model: string | null;
  hours_active: number | null;
  avg_tok_s: number | null;
  avg_watts: number | null;
  wes: number | null;
  avg_ttft_ms: number | null;
  cost_per_hour: number | null;
  total_cost: number | null;
  sample_count: number;
}

const ModelComparisonSection: React.FC<{ isLocalHost: boolean }> = ({ isLocalHost }) => {
  const [rows, setRows] = useState<ComparisonRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sortBy, setSortBy] = useState<'wes' | 'tok_s' | 'cost'>('wes');

  useEffect(() => {
    if (!isLocalHost) return;
    let cancelled = false;
    const fetchData = async () => {
      try {
        const res = await fetch('http://localhost:7700/api/model-comparison?hours=168');
        if (!res.ok) { setLoaded(true); return; }
        const data = await res.json();
        if (cancelled) return;
        setRows(data.models ?? []);
        setLoaded(true);
      } catch {
        if (!cancelled) setLoaded(true);
      }
    };
    fetchData();
    const id = setInterval(fetchData, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [isLocalHost]);

  const sortedRows = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = sortBy === 'wes' ? (a.wes ?? 0) : sortBy === 'tok_s' ? (a.avg_tok_s ?? 0) : (a.total_cost ?? 0);
      const bv = sortBy === 'wes' ? (b.wes ?? 0) : sortBy === 'tok_s' ? (b.avg_tok_s ?? 0) : (b.total_cost ?? 0);
      return bv - av;
    });
    return copy;
  }, [rows, sortBy]);

  return (
    <Section
      eyebrow="7-day"
      title="Model Comparison"
      icon={<BarChart3 className="w-4 h-4" />}
      subtitle="Side-by-side efficiency for every model that has run on this node."
    >
      {!isLocalHost ? (
        <EmptyState>Model comparison is currently available on localhost only. Open Wicklee on the node running inference.</EmptyState>
      ) : !loaded ? (
        <EmptyState>Loading…</EmptyState>
      ) : sortedRows.length === 0 ? (
        <EmptyState>No models tracked in the past 7 days.</EmptyState>
      ) : (
        <Card>
          <div className="px-4 py-3 border-b border-gray-700 flex items-center gap-2 text-xs">
            <span className="text-gray-500 uppercase tracking-widest">Sort by</span>
            {(['wes', 'tok_s', 'cost'] as const).map(k => (
              <button
                key={k}
                onClick={() => setSortBy(k)}
                className={`px-2 py-1 rounded text-xs font-medium ${
                  sortBy === k
                    ? 'bg-blue-600/20 text-blue-400 border border-blue-600/30'
                    : 'text-gray-400 hover:text-gray-200 border border-transparent'
                }`}
              >
                {k === 'wes' ? 'WES' : k === 'tok_s' ? 'tok/s' : 'Cost'}
              </button>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-widest text-gray-500 border-b border-gray-700">
                  <th className="text-left font-medium px-4 py-3">Model</th>
                  <th className="text-right font-medium px-4 py-3">Hours</th>
                  <th className="text-right font-medium px-4 py-3">tok/s</th>
                  <th className="text-right font-medium px-4 py-3">Watts</th>
                  <th className="text-right font-medium px-4 py-3">WES</th>
                  <th className="text-right font-medium px-4 py-3">TTFT</th>
                  <th className="text-right font-medium px-4 py-3">Cost</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r, i) => (
                  <tr key={`${r.model}-${i}`} className="border-b border-gray-700/50 last:border-0 hover:bg-gray-800/30">
                    <td className="px-4 py-3 font-mono text-xs text-white">{r.model ?? '—'}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-gray-300">{r.hours_active != null ? r.hours_active.toFixed(2) : '—'}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-gray-200">{r.avg_tok_s != null ? r.avg_tok_s.toFixed(1) : '—'}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-gray-200">{r.avg_watts != null ? r.avg_watts.toFixed(1) : '—'}</td>
                    <td className={`px-4 py-3 text-right font-mono text-xs ${wesColorClass(r.wes ?? null)}`}>{r.wes != null ? r.wes.toFixed(2) : '—'}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-gray-200">{r.avg_ttft_ms != null ? `${r.avg_ttft_ms.toFixed(0)}ms` : '—'}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-emerald-300">{r.total_cost != null ? `$${r.total_cost.toFixed(4)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </Section>
  );
};

// ── Section: Model Switches ─────────────────────────────────────────────────
interface SwapEntry { ts_ms: number; from_model: string | null; to_model: string | null; gap_ms: number; }
interface SwapsResponse { swaps: SwapEntry[]; total_swaps: number; total_gap_ms: number; total_gap_minutes: number; }

const ModelSwitchesSection: React.FC<{ isLocalHost: boolean }> = ({ isLocalHost }) => {
  const [data, setData] = useState<SwapsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!isLocalHost) return;
    let cancelled = false;
    const fetchData = async () => {
      try {
        const res = await fetch('http://localhost:7700/api/model-switches?hours=24');
        if (!res.ok) { setLoaded(true); return; }
        const json = await res.json();
        if (!cancelled) { setData(json); setLoaded(true); }
      } catch {
        if (!cancelled) setLoaded(true);
      }
    };
    fetchData();
    const id = setInterval(fetchData, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [isLocalHost]);

  const fmtTime = (ms: number) => {
    const d = new Date(ms);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };
  const fmtGap = (ms: number) => {
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}m`;
  };

  return (
    <Section
      eyebrow="24h"
      title="Model Switching Analysis"
      icon={<ArrowRightLeft className="w-4 h-4" />}
      subtitle="Swap frequency and idle time between model transitions."
    >
      {!isLocalHost ? (
        <EmptyState>Swap analysis is currently available on localhost only.</EmptyState>
      ) : !loaded ? (
        <EmptyState>Loading…</EmptyState>
      ) : !data || data.swaps.length === 0 ? (
        <EmptyState>No model swaps in the past 24 hours.</EmptyState>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Card className="p-4">
              <p className="text-[10px] uppercase tracking-widest text-gray-500">Total swaps</p>
              <p className="font-mono text-2xl text-white mt-1">{data.total_swaps}</p>
            </Card>
            <Card className="p-4">
              <p className="text-[10px] uppercase tracking-widest text-gray-500">Total idle time</p>
              <p className="font-mono text-2xl text-white mt-1">{data.total_gap_minutes.toFixed(1)}<span className="text-sm text-gray-400 ml-1">min</span></p>
            </Card>
          </div>
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] uppercase tracking-widest text-gray-500 border-b border-gray-700">
                    <th className="text-left font-medium px-4 py-3">Time</th>
                    <th className="text-left font-medium px-4 py-3">From</th>
                    <th className="text-left font-medium px-4 py-3">To</th>
                    <th className="text-right font-medium px-4 py-3">Idle gap</th>
                  </tr>
                </thead>
                <tbody>
                  {data.swaps.map((s, i) => (
                    <tr key={`${s.ts_ms}-${i}`} className="border-b border-gray-700/50 last:border-0 hover:bg-gray-800/30">
                      <td className="px-4 py-3 font-mono text-xs text-gray-300">{fmtTime(s.ts_ms)}</td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-200">{s.from_model ?? '—'}</td>
                      <td className="px-4 py-3 font-mono text-xs text-white">{s.to_model ?? '—'}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-yellow-300">{fmtGap(s.gap_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </Section>
  );
};

// ── Section: Cost by Model ──────────────────────────────────────────────────
interface CostEntry {
  model: string | null;
  hours_active: number | null;
  avg_watts: number | null;
  cost_usd: number | null;
  tok_s_avg: number | null;
  sample_count: number;
}

const CostByModelSection: React.FC<{ isLocalHost: boolean }> = ({ isLocalHost }) => {
  const [models, setModels] = useState<CostEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!isLocalHost) return;
    let cancelled = false;
    const fetchData = async () => {
      try {
        const res = await fetch('http://localhost:7700/api/cost-by-model?hours=24');
        if (!res.ok) { setLoaded(true); return; }
        const data = await res.json();
        if (cancelled) return;
        setModels(data.models ?? []);
        setTotal(data.total_cost_usd ?? 0);
        setLoaded(true);
      } catch {
        if (!cancelled) setLoaded(true);
      }
    };
    fetchData();
    const id = setInterval(fetchData, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [isLocalHost]);

  const maxCost = useMemo(() => models.reduce((m, x) => Math.max(m, x.cost_usd ?? 0), 0), [models]);

  return (
    <Section
      eyebrow="24h"
      title="Cost by Model"
      icon={<DollarSign className="w-4 h-4" />}
      subtitle="Daily power cost breakdown by model, based on local kWh rate."
    >
      {!isLocalHost ? (
        <EmptyState>Per-model cost breakdown is currently available on localhost only.</EmptyState>
      ) : !loaded ? (
        <EmptyState>Loading…</EmptyState>
      ) : models.length === 0 ? (
        <EmptyState>No cost data yet — Wicklee needs at least 1 hour of telemetry to compute daily costs.</EmptyState>
      ) : (
        <Card className="p-4 space-y-3">
          <div className="flex items-baseline justify-between border-b border-gray-700 pb-3">
            <p className="text-[10px] uppercase tracking-widest text-gray-500">Total (24h)</p>
            <p className="font-mono text-xl text-emerald-300">${total.toFixed(4)}</p>
          </div>
          <div className="space-y-2">
            {models.map((m, i) => {
              const pct = maxCost > 0 ? ((m.cost_usd ?? 0) / maxCost) * 100 : 0;
              return (
                <div key={`${m.model}-${i}`} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="font-mono text-white truncate">{m.model ?? '—'}</span>
                    <span className="font-mono text-emerald-300 shrink-0">${(m.cost_usd ?? 0).toFixed(4)}</span>
                  </div>
                  <div className="h-2 bg-gray-700/50 rounded-full overflow-hidden">
                    <div className="h-full bg-emerald-500/70" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="flex justify-between text-[10px] text-gray-500 font-mono">
                    <span>{m.hours_active != null ? `${m.hours_active.toFixed(2)} hr` : '—'} · {m.tok_s_avg != null ? `${m.tok_s_avg.toFixed(1)} tok/s avg` : '—'}</span>
                    <span>{m.avg_watts != null ? `${m.avg_watts.toFixed(1)} W avg` : '—'}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </Section>
  );
};

// ── Page ────────────────────────────────────────────────────────────────────
const ModelsPage: React.FC<ModelsPageProps> = ({ isLocalHost, getToken, nodes }) => {
  return (
    <div className="space-y-8 p-4 sm:p-6">
      <header className="flex items-start gap-3">
        <div className="h-10 w-10 rounded-xl bg-blue-600/10 border border-blue-600/20 flex items-center justify-center text-blue-400">
          <Boxes className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white">Models</h1>
          <p className="text-sm text-gray-400 mt-1">
            Discover, compare, and track every model that runs on your fleet.
          </p>
        </div>
      </header>

      {/* Section 1: Model Discovery */}
      <Section
        eyebrow="Discover"
        title="Model Discovery"
        icon={<Boxes className="w-4 h-4" />}
        subtitle="GGUF models scored against this hardware — pick what fits."
      >
        {isLocalHost ? (
          <ModelDiscoveryCard isLocalHost={isLocalHost} />
        ) : getToken ? (
          <FleetModelDiscovery getToken={getToken} />
        ) : (
          <EmptyState>Sign in to use Fleet Model Discovery.</EmptyState>
        )}
      </Section>

      {/* Section 2: Active Models */}
      <ActiveModelsSection isLocalHost={isLocalHost} nodes={nodes} />

      {/* Section 3: Model Comparison */}
      <ModelComparisonSection isLocalHost={isLocalHost} />

      {/* Section 4: Model Switching Analysis */}
      <ModelSwitchesSection isLocalHost={isLocalHost} />

      {/* Section 5: Cost by Model */}
      <CostByModelSection isLocalHost={isLocalHost} />
    </div>
  );
};

export default ModelsPage;
