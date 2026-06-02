import React, { useEffect, useMemo, useState } from 'react';
import { Boxes } from 'lucide-react';
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

// ── Section wrapper — thin rule, small-caps eyebrow, optional inline meta ──
// Replaces the prior icon-box pattern. Removes ~120px of vertical chrome per
// section so the page fits roughly one viewport on desktop.
interface SectionProps {
  eyebrow: string;
  meta?: string;
  children: React.ReactNode;
}
const Section: React.FC<SectionProps> = ({ eyebrow, meta, children }) => (
  <section className="space-y-3">
    <div className="flex items-baseline gap-2 border-b border-gray-700/60 pb-2">
      <span className="text-[10px] font-bold tracking-widest uppercase text-blue-400">{eyebrow}</span>
      {meta && (
        <>
          <span className="text-gray-600">·</span>
          <span className="text-xs text-gray-500">{meta}</span>
        </>
      )}
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

// ── Bug fix: synthesize a per-model entry from singular fields ─────────────
// The active_models array on MetricsPayload is only populated when 2+ models
// are loaded concurrently — Ollama's /api/ps + the agent's per-model
// accumulators kick in only in that case. When a single model is loaded,
// the agent uses the legacy ollama_active_model + ollama_tokens_per_second
// singular fields. Prior to this fix, single-model nodes appeared empty
// on this page even though the Intelligence dashboard showed them just fine.
function singleModelFallback(s: SentinelMetrics): ModelLiveMetrics | null {
  if (!s.ollama_active_model) return null;
  return {
    model: s.ollama_active_model,
    tok_s: s.ollama_tokens_per_second ?? null,
    vram_mb: s.ollama_model_size_gb != null ? Math.round(s.ollama_model_size_gb * 1024) : null,
    wes: null,           // singular WES isn't per-model attributed; surfaced via leaderboard instead
    request_count: 0,    // singular path has no per-model request count without the proxy
    runtime: 'ollama',
  } as ModelLiveMetrics;
}

// ── Section 1: LIVE — what's loaded right now ──────────────────────────────
interface ActiveModelRow {
  node_id: string;
  node_label: string;
  model: ModelLiveMetrics;
}

const LiveSection: React.FC<{ isLocalHost: boolean; nodes: FleetNode[] }> = ({ isLocalHost, nodes }) => {
  const { allNodeMetrics } = useFleetStream();
  const [localSentinel, setLocalSentinel] = useState<SentinelMetrics | null>(null);

  // Localhost: subscribe to /api/metrics SSE (self-contained — doesn't share Overview's WS)
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
    const collectFromSentinel = (s: SentinelMetrics, label: string) => {
      // Multi-model path
      if (s.active_models?.length) {
        for (const m of s.active_models) {
          out.push({ node_id: s.node_id, node_label: label, model: m });
        }
        return;
      }
      // Single-model fallback
      const fallback = singleModelFallback(s);
      if (fallback) {
        out.push({ node_id: s.node_id, node_label: label, model: fallback });
      }
    };

    if (isLocalHost) {
      const s = localSentinel;
      if (s) collectFromSentinel(s, s.hostname || s.node_id);
    } else {
      // Prefer node.metrics (already attached to FleetNode) and fall back to
      // allNodeMetrics by node_id. Different upstream paths populate these
      // at slightly different times during the SSE lifecycle; using both
      // ensures we never miss a node that's online and reporting.
      for (const node of nodes) {
        const m = node.metrics ?? allNodeMetrics[node.node_id];
        if (!m) continue;
        const label = node.display_name || m.hostname || node.node_id;
        collectFromSentinel(m, label);
      }
    }
    return out;
  }, [isLocalHost, localSentinel, nodes, allNodeMetrics]);

  const nodeCount = useMemo(() => {
    const ids = new Set(rows.map(r => r.node_id));
    return ids.size;
  }, [rows]);

  const meta = rows.length === 0
    ? 'no models loaded'
    : rows.length === 1
      ? '1 model active'
      : `${rows.length} models active across ${nodeCount} node${nodeCount === 1 ? '' : 's'}`;

  return (
    <Section eyebrow="Live" meta={meta}>
      {rows.length === 0 ? (
        <EmptyState>
          No models currently loaded. Pull one with{' '}
          <code className="font-mono text-emerald-300">ollama pull llama3.2</code>.
        </EmptyState>
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
                    <td className="px-4 py-3 text-right font-mono text-xs text-gray-200">{r.model.request_count || '—'}</td>
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

// ── Section 2: RECENT — last 7 days, merged comparison + cost ──────────────
// Folds the previously-separate Cost-by-Model section into the comparison
// table as a column. Cost is a stat about historical runs, not its own
// first-class concept — keeping them separate read as repetitive.
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

const RecentSection: React.FC<{ isLocalHost: boolean; getToken?: () => Promise<string | null> }> = ({ isLocalHost, getToken }) => {
  const [rows, setRows] = useState<ComparisonRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sortBy, setSortBy] = useState<'wes' | 'tok_s' | 'cost'>('wes');

  useEffect(() => {
    // Fleet mode needs an authenticated session; bail if no token plumbing.
    if (!isLocalHost && !getToken) return;
    let cancelled = false;
    const fetchData = async () => {
      try {
        const url = isLocalHost
          ? 'http://localhost:7700/api/model-comparison?hours=168'
          : '/api/v1/fleet/model-comparison?hours=168';
        const headers: Record<string, string> = {};
        if (!isLocalHost && getToken) {
          const token = await getToken();
          if (!token) { setLoaded(true); return; }
          headers['Authorization'] = `Bearer ${token}`;
        }
        const res = await fetch(url, { headers });
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
  }, [isLocalHost, getToken]);

  const sortedRows = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = sortBy === 'wes' ? (a.wes ?? 0) : sortBy === 'tok_s' ? (a.avg_tok_s ?? 0) : (a.total_cost ?? 0);
      const bv = sortBy === 'wes' ? (b.wes ?? 0) : sortBy === 'tok_s' ? (b.avg_tok_s ?? 0) : (b.total_cost ?? 0);
      return bv - av;
    });
    return copy;
  }, [rows, sortBy]);

  const meta = !loaded
    ? 'loading'
    : sortedRows.length === 0
      ? (isLocalHost ? 'no data yet' : 'fleet aggregation pending')
      : `${sortedRows.length} model${sortedRows.length === 1 ? '' : 's'} · last 7 days${isLocalHost ? '' : ' · fleet'}`;

  return (
    <Section eyebrow="Recent" meta={meta}>
      {!loaded ? (
        <EmptyState>Loading…</EmptyState>
      ) : sortedRows.length === 0 ? (
        <EmptyState>
          {isLocalHost
            ? 'No models tracked in the past 7 days.'
            : 'No models tracked yet — fleet aggregation needs a few hours of telemetry under the new schema. Local nodes have full data via the localhost dashboard.'}
        </EmptyState>
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

// ── Section 3: SWAPS — model switching activity ───────────────────────────
interface SwapEntry { ts_ms: number; node_id?: string; from_model: string | null; to_model: string | null; gap_ms: number; }
interface SwapsResponse { swaps: SwapEntry[]; total_swaps: number; total_gap_ms: number; total_gap_minutes: number; }

const SwapsSection: React.FC<{ isLocalHost: boolean; getToken?: () => Promise<string | null> }> = ({ isLocalHost, getToken }) => {
  const [data, setData] = useState<SwapsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!isLocalHost && !getToken) return;
    let cancelled = false;
    const fetchData = async () => {
      try {
        const url = isLocalHost
          ? 'http://localhost:7700/api/model-switches?hours=24'
          : '/api/v1/fleet/model-switches?hours=24';
        const headers: Record<string, string> = {};
        if (!isLocalHost && getToken) {
          const token = await getToken();
          if (!token) { setLoaded(true); return; }
          headers['Authorization'] = `Bearer ${token}`;
        }
        const res = await fetch(url, { headers });
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
  }, [isLocalHost, getToken]);

  const fmtTime = (ms: number) => {
    const d = new Date(ms);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };
  const fmtGap = (ms: number) => {
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}m`;
  };

  const meta = !loaded
    ? 'loading'
    : !data || data.swaps.length === 0
      ? (isLocalHost ? 'no swaps · last 24h' : 'fleet aggregation pending')
      : `${data.total_swaps} swap${data.total_swaps === 1 ? '' : 's'} · ${data.total_gap_minutes.toFixed(1)} min idle · last 24h${isLocalHost ? '' : ' · fleet'}`;

  return (
    <Section eyebrow="Swaps" meta={meta}>
      {!loaded ? (
        <EmptyState>Loading…</EmptyState>
      ) : !data || data.swaps.length === 0 ? (
        <EmptyState>
          {isLocalHost
            ? 'No model swaps in the past 24 hours. Each swap costs idle time while VRAM is reallocated — fewer is better.'
            : 'No model swaps tracked yet — fleet aggregation needs a few hours of telemetry under the new schema. Local nodes have full data via the localhost dashboard.'}
        </EmptyState>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-widest text-gray-500 border-b border-gray-700">
                  <th className="text-left font-medium px-4 py-3">Time</th>
                  {!isLocalHost && <th className="text-left font-medium px-4 py-3">Node</th>}
                  <th className="text-left font-medium px-4 py-3">From</th>
                  <th className="text-left font-medium px-4 py-3">To</th>
                  <th className="text-right font-medium px-4 py-3">Idle gap</th>
                </tr>
              </thead>
              <tbody>
                {data.swaps.map((s, i) => (
                  <tr key={`${s.ts_ms}-${i}`} className="border-b border-gray-700/50 last:border-0 hover:bg-gray-800/30">
                    <td className="px-4 py-3 font-mono text-xs text-gray-300">{fmtTime(s.ts_ms)}</td>
                    {!isLocalHost && <td className="px-4 py-3 font-mono text-xs text-gray-300">{s.node_id ?? '—'}</td>}
                    <td className="px-4 py-3 font-mono text-xs text-gray-200">{s.from_model ?? '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs text-white">{s.to_model ?? '—'}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-yellow-300">{fmtGap(s.gap_ms)}</td>
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

// ── Section 4: BROWSE — HuggingFace GGUF catalog (lowest urgency, last) ────
const BrowseSection: React.FC<{ isLocalHost: boolean; getToken?: () => Promise<string | null> }> = ({ isLocalHost, getToken }) => (
  <Section eyebrow="Browse" meta="HuggingFace GGUF catalog scored against your hardware">
    {isLocalHost ? (
      <ModelDiscoveryCard isLocalHost={isLocalHost} />
    ) : getToken ? (
      <FleetModelDiscovery getToken={getToken} />
    ) : (
      <EmptyState>Sign in to use Fleet Model Discovery.</EmptyState>
    )}
  </Section>
);

// ── Page ────────────────────────────────────────────────────────────────────
const ModelsPage: React.FC<ModelsPageProps> = ({ isLocalHost, getToken, nodes }) => {
  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Page header — establishes identity, doesn't duplicate section subtitles */}
      <header className="flex items-start gap-3 pb-2">
        <div className="h-10 w-10 rounded-xl bg-blue-600/10 border border-blue-600/20 flex items-center justify-center text-blue-400">
          <Boxes className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white">Models</h1>
          <p className="text-sm text-gray-400 mt-1">
            Live state, recent history, and discovery for every model on your fleet.
          </p>
        </div>
      </header>

      {/* Builder-first section order: what's running NOW → what ran RECENTLY → SWAPS → DISCOVER */}
      <LiveSection isLocalHost={isLocalHost} nodes={nodes} />
      <RecentSection isLocalHost={isLocalHost} getToken={getToken} />
      <SwapsSection isLocalHost={isLocalHost} getToken={getToken} />
      <BrowseSection isLocalHost={isLocalHost} getToken={getToken} />
    </div>
  );
};

export default ModelsPage;
