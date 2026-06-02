import React, { useEffect, useMemo, useState } from 'react';
import { Boxes, ChevronRight, ChevronDown } from 'lucide-react';
import { FleetNode, ModelLiveMetrics, SentinelMetrics } from '../types';
import { wesColorClass } from '../utils/wes';
import ModelDiscoveryCard from './insights/ModelDiscoveryCard';
import FleetModelDiscovery from './insights/FleetModelDiscovery';
import RuntimeConfigModal from './RuntimeConfigModal';

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

// ── Section 1: LOADED — pure model-state view ───────────────────────────────
// Reframe from "LIVE" inference metrics (tok/s, WES, requests) → pure
// model-state: what's loaded, where, with what config, active vs idle.
// Inference performance is already on the Intelligence tab at the node
// level (with greater fidelity than we can offer per-model without the
// optional Ollama proxy). The Models tab now answers a question Intelligence
// can't: "what does my fleet have loaded right now, and which is active?"
interface LoadedModelRow {
  node_id: string;
  node_label: string;
  model: ModelLiveMetrics;
  /** The node's current sentinel.ollama_active_model — used to decide Active vs Idle status. */
  sentinel_active_model: string | null;
  /** Local agent base URL for fetching runtime config via the Config modal. */
  agent_base_url: string;
}

const LoadedSection: React.FC<{ isLocalHost: boolean; getToken?: () => Promise<string | null> }> = ({ isLocalHost, getToken }) => {
  const [localSentinel, setLocalSentinel] = useState<SentinelMetrics | null>(null);
  const [fleetNodes, setFleetNodes] = useState<Array<{ node_id: string; metrics: SentinelMetrics | null; display_name?: string | null }>>([]);

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

  // Fleet: poll /api/fleet every 3s. We deliberately don't reach into
  // useFleetStream's allNodeMetrics here — different upstream populating
  // schedules made the React state miss singular ollama_active_model on
  // first paint, even though the underlying SSE was sending it. Hitting
  // /api/fleet directly is simpler and matches Recent/Swaps' pattern.
  useEffect(() => {
    if (isLocalHost || !getToken) return;
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const token = await getToken();
        if (!token || cancelled) return;
        const res = await fetch('/api/fleet', {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled) return;
        setFleetNodes(data.nodes || []);
      } catch { /* ignore transient fetch errors */ }
    };
    fetchOnce();
    const id = setInterval(fetchOnce, 3_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [isLocalHost, getToken]);

  const rows: LoadedModelRow[] = useMemo(() => {
    const out: LoadedModelRow[] = [];
    // For Config modal: localhost agent vs fleet — fleet path doesn't currently
    // expose runtime-config through the cloud (per-node localhost call only).
    // Fleet rows will get a disabled Config link with a tooltip.
    const agentBaseUrl = isLocalHost ? 'http://localhost:7700' : '';

    const collectFromSentinel = (s: SentinelMetrics, label: string) => {
      const shared = {
        node_id: s.node_id,
        node_label: label,
        sentinel_active_model: s.ollama_active_model ?? null,
        agent_base_url: agentBaseUrl,
      };

      // Multi-model path
      if (s.active_models?.length) {
        for (const m of s.active_models) {
          out.push({ ...shared, model: m });
        }
        return;
      }
      // Single-model fallback (legacy singular fields)
      const fallback = singleModelFallback(s);
      if (fallback) {
        out.push({ ...shared, model: fallback });
      }
    };

    if (isLocalHost) {
      const s = localSentinel;
      if (s) collectFromSentinel(s, s.hostname || s.node_id);
    } else {
      for (const node of fleetNodes) {
        if (!node.metrics) continue;
        const label = node.display_name || node.metrics.hostname || node.node_id;
        collectFromSentinel(node.metrics, label);
      }
    }
    return out;
  }, [isLocalHost, localSentinel, fleetNodes]);

  const nodeCount = useMemo(() => {
    const seen = new Set(rows.map(r => r.node_id));
    return seen.size;
  }, [rows]);

  const activeCount = useMemo(() =>
    rows.filter(r => r.model.model === r.sentinel_active_model).length,
  [rows]);

  const meta = rows.length === 0
    ? 'no models loaded'
    : `${rows.length} model${rows.length === 1 ? '' : 's'} loaded across ${nodeCount} node${nodeCount === 1 ? '' : 's'} · ${activeCount} active`;

  // Config modal state — clicking a row's "Config" link opens it
  const [configModel, setConfigModel] = useState<{ name: string; baseUrl: string } | null>(null);

  return (
    <>
    <Section eyebrow="Loaded" meta={meta}>
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
                  <th className="text-left font-medium px-4 py-3">Quant</th>
                  <th className="text-right font-medium px-4 py-3" title="GPU VRAM when available, else model file size in system memory">Memory</th>
                  <th className="text-left font-medium px-4 py-3">Status</th>
                  <th className="text-right font-medium px-4 py-3">Config</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  // Memory: prefer VRAM (GPU nodes), fall back to size_gb (CPU nodes).
                  let memoryDisplay = '—';
                  let memoryLabel: 'VRAM' | 'RAM' | null = null;
                  if (r.model.vram_mb != null && r.model.vram_mb > 0) {
                    memoryDisplay = `${(r.model.vram_mb / 1024).toFixed(1)} GB`;
                    memoryLabel = 'VRAM';
                  } else if (r.model.size_gb != null && r.model.size_gb > 0) {
                    memoryDisplay = `${r.model.size_gb.toFixed(1)} GB`;
                    memoryLabel = 'RAM';
                  }
                  const memoryTooltip = memoryLabel === 'RAM'
                    ? 'CPU-only inference: model is in system RAM. No GPU VRAM in use.'
                    : memoryLabel === 'VRAM'
                      ? 'GPU memory currently allocated to this model.'
                      : undefined;

                  // Status: ● Active if this model is the node's currently-active one
                  // (most-recently-inferenced per /api/ps), ○ Idle otherwise.
                  const isActive = r.model.model === r.sentinel_active_model;

                  // Config link: only functional on localhost mode (fleet cloud
                  // doesn't proxy /api/runtime-config across nodes). Fleet rows
                  // show a disabled link with an explanatory tooltip.
                  const configEnabled = !!r.agent_base_url;

                  return (
                    <tr key={`${r.node_id}-${r.model.model}-${i}`} className="border-b border-gray-700/50 last:border-0 hover:bg-gray-800/30">
                      {!isLocalHost && <td className="px-4 py-3 text-gray-300 text-xs">{r.node_label}</td>}
                      <td className="px-4 py-3 font-mono text-xs text-white">{r.model.model}</td>
                      <td className="px-4 py-3 font-mono text-[10px] text-gray-500">{r.model.quantization ?? '—'}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-gray-200"
                          title={memoryTooltip}>
                        {memoryDisplay}
                        {memoryLabel && <span className="ml-1 text-[9px] text-gray-600">{memoryLabel}</span>}
                      </td>
                      <td className="px-4 py-3 text-xs"
                          title={isActive ? 'Most recently used model on this node' : 'Loaded in memory, not currently inferring'}>
                        {isActive
                          ? <span className="text-emerald-400">● Active</span>
                          : <span className="text-gray-500">○ Idle</span>}
                      </td>
                      <td className="px-4 py-3 text-right text-xs">
                        {configEnabled ? (
                          <button
                            onClick={() => setConfigModel({ name: r.model.model, baseUrl: r.agent_base_url })}
                            className="text-blue-400 hover:text-blue-300 underline underline-offset-2"
                          >
                            View →
                          </button>
                        ) : (
                          <span className="text-gray-600" title="Runtime config is available via the localhost dashboard for each node.">
                            View →
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </Section>
    {configModel && (
      <RuntimeConfigModal
        modelName={configModel.name}
        agentBaseUrl={configModel.baseUrl}
        onClose={() => setConfigModel(null)}
      />
    )}
    </>
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

// ── Collapsible "Past activity" footer ─────────────────────────────────────
// Recent (7-day comparison) and Swaps (24h transitions) are useful but
// secondary — they answer "how did models perform historically" rather than
// "what's loaded right now." Demoted below the primary Loaded + Browse view
// to a collapsed-by-default disclosure that operators can expand when
// they need the deeper history.
//
// Long-term: Swaps belongs in the Observability tab as a `model_swap_thrashing`
// alert pattern (fires when swap frequency exceeds threshold). For now it
// lives here as a manual deep-dive. See backlog.
const PastActivityFooter: React.FC<{ isLocalHost: boolean; getToken?: () => Promise<string | null> }> = ({ isLocalHost, getToken }) => {
  const [openSection, setOpenSection] = useState<'recent' | 'swaps' | null>(null);

  const ToggleButton: React.FC<{ id: 'recent' | 'swaps'; label: string; hint: string }> = ({ id, label, hint }) => {
    const isOpen = openSection === id;
    return (
      <button
        onClick={() => setOpenSection(isOpen ? null : id)}
        className="w-full flex items-center justify-between text-left py-3 px-4 rounded-xl bg-gray-800/30 border border-gray-700 hover:bg-gray-800/60 transition-colors"
      >
        <span className="flex items-center gap-2">
          {isOpen ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
          <span className="text-sm font-medium text-gray-200">{label}</span>
          <span className="text-xs text-gray-500">· {hint}</span>
        </span>
      </button>
    );
  };

  return (
    <div className="space-y-3 pt-6 border-t border-gray-800">
      <p className="text-[10px] tracking-widest uppercase text-gray-600 font-medium">Past activity</p>
      <ToggleButton id="recent" label="7-day model performance comparison" hint="WES, tok/s, watts, TTFT, cost per model" />
      {openSection === 'recent' && <RecentSection isLocalHost={isLocalHost} getToken={getToken} />}
      <ToggleButton id="swaps" label="Model swap activity" hint="last 24h · transitions and idle gaps" />
      {openSection === 'swaps' && <SwapsSection isLocalHost={isLocalHost} getToken={getToken} />}
    </div>
  );
};

// ── Page ────────────────────────────────────────────────────────────────────
const ModelsPage: React.FC<ModelsPageProps> = ({ isLocalHost, getToken }) => {
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
            What's loaded across your fleet, and what could you add. Inference performance lives on the Intelligence tab.
          </p>
        </div>
      </header>

      {/* Two primary sections answering "what's running" and "what could I run". */}
      <LoadedSection isLocalHost={isLocalHost} getToken={getToken} />
      <BrowseSection isLocalHost={isLocalHost} getToken={getToken} />

      {/* Demoted secondary views — collapsed by default, expand for deep history. */}
      <PastActivityFooter isLocalHost={isLocalHost} getToken={getToken} />
    </div>
  );
};

export default ModelsPage;
