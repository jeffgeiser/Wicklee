/**
 * ModelDiscoveryCard
 *
 * Expandable card that shows GGUF models from HuggingFace scored against
 * local hardware. Community tier: local discovery. Pro: hardware simulation.
 * Team: fleet matching.
 *
 * Fetches from /api/model-candidates on the local agent.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Search, ChevronDown, ChevronRight, Package, Cpu } from 'lucide-react';

interface VariantResult {
  quant: string;
  file_size_mb: number;
  vram_required_mb: number;
  fit_score: number;
  fit_label: string;
  estimated_wes: number | null;
  vram_headroom_pct: number;
  recommendation: string;
}

interface ModelResult {
  model_id: string;
  downloads: number;
  variants: VariantResult[];
}

interface HardwareInfo {
  vram_mb: number;
  chip: string | null;
  power_budget_w: number;
  thermal_state: string;
}

interface DiscoveryResponse {
  node_id: string;
  hardware: HardwareInfo;
  models: ModelResult[];
}

function fitColor(score: number): string {
  if (score >= 80) return 'text-emerald-400';
  if (score >= 60) return 'text-green-300';
  if (score >= 40) return 'text-yellow-400';
  return 'text-red-400';
}

function fitBg(score: number): string {
  if (score >= 80) return 'bg-emerald-500';
  if (score >= 60) return 'bg-green-500';
  if (score >= 40) return 'bg-yellow-500';
  return 'bg-red-500';
}

function fmtDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return `${n}`;
}

const ModelDiscoveryCard: React.FC<{ isLocalHost?: boolean }> = ({ isLocalHost = true }) => {
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState('');
  const [data, setData] = useState<DiscoveryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedModel, setExpandedModel] = useState<string | null>(null);

  const fetchModels = useCallback(async (query?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (query) params.set('search', query);
      params.set('limit', '20');
      const resp = await fetch(`/api/model-candidates?${params}`);
      if (!resp.ok) throw new Error(`${resp.status}`);
      const json = await resp.json();
      setData(json);
    } catch (e: any) {
      setError(e.message ?? 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on first expand
  useEffect(() => {
    if (expanded && !data && !loading) {
      fetchModels();
    }
  }, [expanded, data, loading, fetchModels]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    fetchModels(search || undefined);
  };

  // Count models that fit (best variant score >= 60)
  const fittingCount = data?.models.filter(m =>
    m.variants.some(v => v.fit_score >= 60)
  ).length ?? 0;

  if (!isLocalHost) return null; // Cloud version is Step 5-7

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      {/* Collapsed header */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-gray-800/30 transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <Package className="w-4 h-4 text-cyan-400" />
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
            Model Discovery
          </span>
          {data && !expanded && (
            <span className="text-[10px] text-cyan-400 bg-cyan-500/10 px-2 py-0.5 rounded-full font-medium">
              {fittingCount} model{fittingCount !== 1 ? 's' : ''} fit your hardware
            </span>
          )}
        </div>
        {expanded
          ? <ChevronDown className="w-3.5 h-3.5 text-gray-600" />
          : <ChevronRight className="w-3.5 h-3.5 text-gray-600" />
        }
      </button>

      {/* Expanded body */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-gray-800/60">

          {/* Hardware summary */}
          {data?.hardware && (
            <div className="flex items-center gap-4 py-2 text-[10px] text-gray-500">
              <div className="flex items-center gap-1.5">
                <Cpu className="w-3 h-3 text-gray-600" />
                <span>{data.hardware.chip ?? 'Unknown'}</span>
              </div>
              <span>{data.hardware.vram_mb >= 1024 ? `${(data.hardware.vram_mb / 1024).toFixed(0)}G VRAM` : `${data.hardware.vram_mb}MB`}</span>
              <span>{data.hardware.power_budget_w > 0 ? `${data.hardware.power_budget_w}W` : ''}</span>
              <span className={data.hardware.thermal_state === 'Normal' ? 'text-emerald-500' : 'text-yellow-500'}>
                {data.hardware.thermal_state}
              </span>
            </div>
          )}

          {/* Search */}
          <form onSubmit={handleSearch} className="flex gap-2">
            <div className="flex-1 relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-600" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search models (e.g. llama, qwen, phi)..."
                className="w-full pl-8 pr-3 py-2 bg-gray-800/60 border border-gray-700/50 rounded-lg text-xs text-gray-300 placeholder:text-gray-600 focus:outline-none focus:border-cyan-500/30"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="px-3 py-2 bg-gray-800 border border-gray-700/50 rounded-lg text-xs text-gray-400 hover:text-cyan-400 hover:border-cyan-500/30 transition-colors disabled:opacity-40"
            >
              {loading ? '...' : 'Search'}
            </button>
          </form>

          {/* Error */}
          {error && (
            <p className="text-xs text-red-400">Failed to load models: {error}</p>
          )}

          {/* Results */}
          {data && data.models.length === 0 && !loading && (
            <p className="text-xs text-gray-600 py-4 text-center">No GGUF models found. Try a different search term.</p>
          )}

          {data && data.models.length > 0 && (
            <div className="space-y-1">
              {data.models.map(model => {
                const bestVariant = model.variants[0]; // already sorted by fit_score desc
                const isExpanded = expandedModel === model.model_id;
                return (
                  <div key={model.model_id} className="border border-gray-800/60 rounded-lg overflow-hidden">
                    {/* Model row */}
                    <button
                      onClick={() => setExpandedModel(isExpanded ? null : model.model_id)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-gray-800/20 transition-colors"
                    >
                      {/* Fit score dot */}
                      <div className={`w-2 h-2 rounded-full ${fitBg(bestVariant?.fit_score ?? 0)} shrink-0`} />

                      {/* Model name */}
                      <span className="text-xs text-gray-300 font-mono truncate flex-1 text-left">
                        {model.model_id.split('/').pop() ?? model.model_id}
                      </span>

                      {/* Best fit badge */}
                      {bestVariant && (
                        <span className={`text-[10px] font-mono tabular-nums ${fitColor(bestVariant.fit_score)}`}>
                          {bestVariant.fit_score}/100
                        </span>
                      )}

                      {/* Downloads */}
                      <span className="text-[10px] text-gray-600 tabular-nums whitespace-nowrap">
                        {fmtDownloads(model.downloads)}
                      </span>

                      {isExpanded
                        ? <ChevronDown className="w-3 h-3 text-gray-600 shrink-0" />
                        : <ChevronRight className="w-3 h-3 text-gray-600 shrink-0" />
                      }
                    </button>

                    {/* Expanded: all variants */}
                    {isExpanded && (
                      <div className="px-3 pb-3 space-y-1.5">
                        <div className="text-[9px] font-semibold uppercase tracking-widest text-gray-600 pt-1">
                          Quantization Variants
                        </div>
                        {model.variants.map(v => (
                          <div key={v.quant} className="flex items-center gap-2 text-[11px] py-1 border-t border-gray-800/30">
                            <div className={`w-1.5 h-1.5 rounded-full ${fitBg(v.fit_score)} shrink-0`} />
                            <span className="text-gray-400 font-mono w-16 shrink-0">{v.quant}</span>
                            <span className={`font-mono tabular-nums ${fitColor(v.fit_score)} w-10 shrink-0`}>{v.fit_score}</span>
                            <span className="text-gray-500 font-mono tabular-nums w-12 shrink-0">{(v.file_size_mb / 1024).toFixed(1)}G</span>
                            <span className="text-gray-600 truncate flex-1">{v.fit_label}</span>
                            <span className="text-gray-700 tabular-nums whitespace-nowrap">
                              {v.vram_headroom_pct >= 0 ? `${v.vram_headroom_pct.toFixed(0)}% free` : 'Over budget'}
                            </span>
                          </div>
                        ))}
                        {/* Recommendation from best variant */}
                        {bestVariant && (
                          <p className="text-[10px] text-gray-500 mt-1 leading-relaxed italic">
                            {bestVariant.recommendation}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Loading state */}
          {loading && !data && (
            <div className="flex items-center justify-center py-8 gap-2 text-xs text-gray-600">
              <div className="w-3 h-3 border border-gray-600 border-t-cyan-400 rounded-full animate-spin" />
              Fetching models from HuggingFace...
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ModelDiscoveryCard;
