import React, { useEffect, useMemo, useState } from 'react';
import { Boxes, ChevronRight, ChevronDown } from 'lucide-react';
import { ModelLiveMetrics, SentinelMetrics } from '../types';
import { wesColorClass } from '../utils/wes';
import { useLocalMetricsStream } from '../hooks/useLocalMetricsStream';
import ModelDiscoveryCard from './insights/ModelDiscoveryCard';

interface ModelsPageProps {
  /** Deep-link into Insights → Performance. */
  onNavigateToInsightsPerformance?: () => void;
}

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

function singleModelFallback(s: SentinelMetrics): ModelLiveMetrics | null {
  if (!s.ollama_active_model) return null;
  return {
    model: s.ollama_active_model,
    tok_s: s.ollama_tokens_per_second ?? null,
    vram_mb: s.ollama_model_size_gb != null ? Math.round(s.ollama_model_size_gb * 1024) : null,
    wes: null,
    request_count: 0,
    runtime: 'ollama',
  } as ModelLiveMetrics;
}

interface LoadedModelRow {
  node_id: string;
  node_label: string;
  model: ModelLiveMetrics;
  /** Runtime-aware Active flag: Ollama rows compare against the node's
   *  ollama_active_model (most-recently-inferenced per /api/ps); vLLM and
   *  llama.cpp keep the model resident, so Active = inference_state 'live'. */
  active: boolean;
}

const LoadedSection: React.FC = () => {
  const [localSentinel, setLocalSentinel] = useState<SentinelMetrics | null>(null);
  useLocalMetricsStream(setLocalSentinel, true);

  const rows: LoadedModelRow[] = useMemo(() => {
    const out: LoadedModelRow[] = [];
    const collectFromSentinel = (s: SentinelMetrics, label: string) => {
      const shared = { node_id: s.node_id, node_label: label };

      if (s.active_models?.length) {
        for (const m of s.active_models) {
          out.push({ ...shared, model: m, active: m.model === s.ollama_active_model });
        }
      } else {
        const fallback = singleModelFallback(s);
        if (fallback) {
          out.push({ ...shared, model: fallback, active: true });
        }
      }

      if (s.vllm_running && s.vllm_model_name) {
        out.push({
          ...shared,
          active: s.inference_state === 'live' || (s.vllm_requests_running ?? 0) > 0,
          model: {
            model: s.vllm_model_name,
            quantization: s.vllm_dtype ?? null,
            vram_mb: s.nvidia_vram_used_mb && s.nvidia_vram_used_mb > 0 ? s.nvidia_vram_used_mb : null,
            tok_s: s.vllm_tokens_per_sec ?? null,
            request_count: s.vllm_requests_running ?? 0,
          } as ModelLiveMetrics,
        });
      }

      if (s.llamacpp_running && s.llamacpp_model_name) {
        out.push({
          ...shared,
          active: s.inference_state === 'live' || (s.llamacpp_slots_processing ?? 0) > 0,
          model: {
            model: s.llamacpp_model_name,
            quantization: null,
            tok_s: s.llamacpp_tokens_per_sec ?? null,
            request_count: s.llamacpp_slots_processing ?? 0,
          } as ModelLiveMetrics,
        });
      }
    };

    const s = localSentinel;
      if (s) collectFromSentinel(s, s.hostname || s.node_id);
    return out;
  }, [localSentinel]);

  const nodeCount = useMemo(() => {
    const seen = new Set(rows.map(r => r.node_id));
    return seen.size;
  }, [rows]);

  const activeCount = useMemo(() =>
    rows.filter(r => r.active).length,
  [rows]);

  const meta = rows.length === 0
    ? 'no models loaded'
    : `${rows.length} model${rows.length === 1 ? '' : 's'} loaded across ${nodeCount} node${nodeCount === 1 ? '' : 's'} · ${activeCount} active`;

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
            <table className="w-full text-sm table-fixed">
              <colgroup>
                <col />
                <col className="w-[12%]" />
                <col className="w-[16%]" />
                <col className="w-[14%]" />
              </colgroup>
              <thead>
                <tr className="text-[10px] uppercase tracking-widest text-gray-500 border-b border-gray-700">
                  <th className="text-left font-medium px-3 py-2">Model</th>
                  <th className="text-left font-medium px-3 py-2">Quant</th>
                  <th className="text-right font-medium px-3 py-2" title="GPU VRAM when available, else model file size in system memory">Memory</th>
                  <th className="text-left font-medium px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
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

                  const isActive = r.active;

                  return (
                    <tr key={`${r.node_id}-${r.model.model}-${i}`} className="border-b border-gray-700/50 last:border-0 hover:bg-gray-800/30">
                      <td className="px-3 py-2 font-mono text-xs text-white truncate" title={r.model.model}>{r.model.model}</td>
                      <td className="px-3 py-2 font-mono text-[10px] text-gray-500">{r.model.quantization ?? '—'}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-gray-200 whitespace-nowrap"
                          title={memoryTooltip}>
                        {memoryDisplay}
                        {memoryLabel && <span className="ml-1 text-[9px] text-gray-600">{memoryLabel}</span>}
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap"
                          title={isActive ? 'Most recently used model on this node' : 'Loaded in memory, not currently inferring'}>
                        {isActive
                          ? <span className="text-emerald-400">● Active</span>
                          : <span className="text-gray-500">○ Idle</span>}
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
    </>
  );
};

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

const RecentSection: React.FC = () => {
  const [rows, setRows] = useState<ComparisonRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sortBy, setSortBy] = useState<'wes' | 'tok_s' | 'cost'>('wes');

  useEffect(() => {
    let cancelled = false;
    const fetchData = async () => {
      try {
        const res = await fetch('/api/model-comparison?hours=168');
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
  }, []);

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
      ? 'no data yet'
      : `${sortedRows.length} model${sortedRows.length === 1 ? '' : 's'} · last 7 days`;

  return (
    <Section eyebrow="Recent" meta={meta}>
      {!loaded ? (
        <EmptyState>Loading…</EmptyState>
      ) : sortedRows.length === 0 ? (
        <EmptyState>
          No models tracked in the past 7 days.
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

interface SwapEntry { ts_ms: number; node_id?: string; from_model: string | null; to_model: string | null; gap_ms: number; }
interface SwapsResponse { swaps: SwapEntry[]; total_swaps: number; total_gap_ms: number; total_gap_minutes: number; }

const SwapsSection: React.FC = () => {
  const [data, setData] = useState<SwapsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchData = async () => {
      try {
        const res = await fetch('/api/model-switches?hours=24');
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
  }, []);

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
      ? 'no swaps · last 24h'
      : `${data.total_swaps} swap${data.total_swaps === 1 ? '' : 's'} · ${data.total_gap_minutes.toFixed(1)} min idle · last 24h`;

  return (
    <Section eyebrow="Swaps" meta={meta}>
      {!loaded ? (
        <EmptyState>Loading…</EmptyState>
      ) : !data || data.swaps.length === 0 ? (
        <EmptyState>
          No model swaps in the past 24 hours. Each swap costs idle time while VRAM is reallocated — fewer is better.
        </EmptyState>
      ) : (
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
      )}
    </Section>
  );
};

const BrowseSection: React.FC = () => (
  <Section eyebrow="Browse" meta="HuggingFace GGUF catalog scored against your hardware">
    <ModelDiscoveryCard isLocalHost />
  </Section>
);

const PastActivityFooter: React.FC<{
  onNavigateToInsightsPerformance?: () => void;
}> = ({ onNavigateToInsightsPerformance }) => {
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
      {openSection === 'recent' && (
        <>
          <RecentSection />
          {onNavigateToInsightsPerformance && (
            <p className="text-[11px] text-gray-600 px-1">
              Efficiency trends and cost live on{' '}
              <button
                onClick={onNavigateToInsightsPerformance}
                className="text-blue-400 hover:text-blue-300 underline decoration-blue-500/40 underline-offset-2 transition-colors"
              >
                Insights → Performance
              </button>.
            </p>
          )}
        </>
      )}
      <ToggleButton id="swaps" label="Model swap activity" hint="last 24h · transitions and idle gaps" />
      {openSection === 'swaps' && <SwapsSection />}
    </div>
  );
};

const ModelsPage: React.FC<ModelsPageProps> = ({ onNavigateToInsightsPerformance }) => {
  return (
    <div className="space-y-6 p-4 sm:p-6 max-w-7xl mx-auto">
      <header className="flex items-start gap-3 pb-2">
        <div className="h-10 w-10 rounded-xl bg-blue-600/10 border border-blue-600/20 flex items-center justify-center text-blue-400">
          <Boxes className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white">Models</h1>
          <p className="text-sm text-gray-400 mt-1">
            What's loaded, what each model ran and cost, and what you could add.
            Live node telemetry is on Overview
            {onNavigateToInsightsPerformance ? (
              <>
                ; efficiency and cost trends live on{' '}
                <button
                  onClick={onNavigateToInsightsPerformance}
                  className="text-blue-400 hover:text-blue-300 underline decoration-blue-500/40 underline-offset-2 transition-colors"
                >
                  Insights → Performance
                </button>.
              </>
            ) : (
              '; efficiency and cost trends live on Insights → Performance.'
            )}
          </p>
        </div>
      </header>

      {/* Two primary sections answering "what's running" and "what could I run". */}
      <LoadedSection />
      <BrowseSection />

      {/* Demoted secondary views — collapsed by default, expand for deep history. */}
      <PastActivityFooter onNavigateToInsightsPerformance={onNavigateToInsightsPerformance} />
    </div>
  );
};

export default ModelsPage;
