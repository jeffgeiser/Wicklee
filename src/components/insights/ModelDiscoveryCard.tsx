/**
 * ModelDiscoveryCard — localhost model discovery panel.
 *
 * Fetches GGUF models from HuggingFace via the local agent's /api/model-candidates.
 * When a search term is entered: queries HF live (bypasses cache).
 * With no search: shows the cached trending top-20 by downloads.
 *
 * Scored dimensions:
 *   VRAM headroom (40 pts) · Thermal margin (20 pts) · WES proxy (20 pts) · Power fraction (20 pts)
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Search, Package, ExternalLink, Copy, Check, ChevronDown, ChevronRight, Cpu, Loader2 } from 'lucide-react';

interface VariantResult {
  quant:              string;
  filename:           string;
  file_size_mb:       number;
  vram_required_mb:   number;
  fit_score:          number;
  fit_label:          string;
  estimated_wes:      number | null;
  vram_headroom_pct:  number;
  recommendation:     string;
  pull_cmd:           string;
}

interface ModelResult {
  model_id:  string;
  downloads: number;
  variants:  VariantResult[];
}

interface HardwareInfo {
  vram_mb:       number;
  chip:          string | null;
  power_budget_w: number;
  thermal_state: string;
}

interface DiscoveryResponse {
  node_id:        string;
  is_live_search: boolean;
  hardware:       HardwareInfo;
  models:         ModelResult[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fitColors(score: number): { dot: string; badge: string; text: string } {
  if (score >= 80) return { dot: 'bg-emerald-500', badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20', text: 'text-emerald-400' };
  if (score >= 60) return { dot: 'bg-green-500',   badge: 'bg-green-500/15 text-green-400 border-green-500/20',       text: 'text-green-400' };
  if (score >= 40) return { dot: 'bg-yellow-500',  badge: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/20',    text: 'text-yellow-400' };
  if (score > 0)   return { dot: 'bg-orange-500',  badge: 'bg-orange-500/15 text-orange-400 border-orange-500/20',    text: 'text-orange-400' };
  return             { dot: 'bg-red-500',    badge: 'bg-red-500/15 text-red-400 border-red-500/20',          text: 'text-red-400' };
}

function fmtDl(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`;
  return `${n}`;
}

function shortModelName(model_id: string): string {
  return model_id.split('/').pop() ?? model_id;
}

function hfUrl(model_id: string): string {
  return `https://huggingface.co/${model_id}`;
}

// ── Copy button ───────────────────────────────────────────────────────────────

const CopyButton: React.FC<{ text: string; className?: string }> = ({ text, className = '' }) => {
  const [copied, setCopied] = useState(false);
  const handle = () => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <button
      onClick={handle}
      title="Copy command"
      className={`p-1 rounded transition-colors hover:bg-gray-700/60 ${className}`}
    >
      {copied
        ? <Check className="w-3 h-3 text-emerald-400" />
        : <Copy className="w-3 h-3 text-gray-500 hover:text-gray-300" />}
    </button>
  );
};

// ── Variant table (extracted to allow useState) ───────────────────────────────

function quantLabel(v: VariantResult): string {
  if (v.quant && v.quant !== 'unknown') return v.quant;
  // Fall back to last segment of filename (e.g. "Q4_K_M" from "model-Q4_K_M.gguf")
  const stem = v.filename.replace(/\.gguf$/i, '');
  return stem.split(/[-.]/).pop() ?? stem;
}

const VariantTable: React.FC<{ variants: VariantResult[]; modelId: string; pullCmd?: string }> = ({ variants, modelId, pullCmd }) => {
  const [showAll, setShowAll] = useState(false);
  const fitting  = variants.filter(v => v.fit_score >= 40);
  const wontFit  = variants.filter(v => v.fit_score < 40);
  const displayed = showAll ? variants : fitting;

  return (
    <>
      {/* Variants header + HF link on the same row */}
      <div className="flex items-center justify-between mt-1">
        <span className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">
          Quants{fitting.length < variants.length ? ` · ${fitting.length} fit` : ` · ${variants.length}`}
        </span>
        <a
          href={hfUrl(modelId)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-0.5 text-[10px] text-gray-600 hover:text-cyan-400 transition-colors"
        >
          <ExternalLink className="w-2.5 h-2.5" />
          <span className="hidden sm:inline text-[9px]">HuggingFace</span>
        </a>
      </div>

      {/* Variant rows */}
      <div className="space-y-0">
        {displayed.map(v => {
          const vc = fitColors(v.fit_score);
          return (
            <div key={v.filename} className="flex items-center gap-2 py-1 border-t border-gray-700/20 first:border-t-0">
              <div className={`w-1.5 h-1.5 rounded-full ${vc.dot} shrink-0`} />
              <span className="text-[11px] text-gray-400 font-mono shrink-0 w-[72px] truncate" title={v.filename}>
                {quantLabel(v)}
              </span>
              <span className={`text-[10px] font-medium px-1.5 py-px rounded ${vc.badge} border shrink-0`}>
                {v.fit_label}
              </span>
              <span className="text-[11px] text-gray-500 font-mono tabular-nums shrink-0">
                {(v.file_size_mb / 1024).toFixed(1)} GB
              </span>
              <span className="text-[10px] text-gray-600 truncate flex-1">
                {v.vram_headroom_pct >= 0 ? `${v.vram_headroom_pct.toFixed(0)}% headroom` : 'over budget'}
              </span>
            </div>
          );
        })}
      </div>

      {/* Won't fit disclosure */}
      {wontFit.length > 0 && (
        <button
          onClick={() => setShowAll(s => !s)}
          className="text-[10px] text-gray-600 hover:text-gray-400 transition-colors mt-0.5"
        >
          {showAll ? '↑ Hide' : `+ ${wontFit.length} that won't fit`}
        </button>
      )}

      {/* Pull command — inline, no recommendation paragraph */}
      {pullCmd && (
        <div className="flex items-center gap-1 mt-1.5 bg-gray-900/60 border border-gray-700/60 rounded px-2 py-1">
          <code className="text-[11px] text-cyan-300 font-mono flex-1 truncate">{pullCmd}</code>
          <CopyButton text={pullCmd} />
        </div>
      )}
    </>
  );
};

// ── Model row ─────────────────────────────────────────────────────────────────

const ModelRow: React.FC<{ model: ModelResult }> = ({ model }) => {
  const [open, setOpen] = useState(false);
  const best = model.variants[0];
  if (!best) return null;
  const colors = fitColors(best.fit_score);

  return (
    <div className="border border-gray-700/60 rounded-lg overflow-hidden">
      {/* Summary row */}
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-gray-700/20 transition-colors text-left"
      >
        <div className={`w-2 h-2 rounded-full ${colors.dot} shrink-0`} />

        <span className="text-xs text-gray-300 font-mono truncate flex-1 min-w-0">
          {shortModelName(model.model_id)}
        </span>

        {/* Best-fit badge — label first */}
        <span
          title={`Fit score ${best.fit_score}/100 · Excellent ≥80 · Good ≥60 · Tight ≥40 · Won't Fit <40`}
          className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${colors.badge} shrink-0 whitespace-nowrap cursor-default`}
        >
          {best.fit_label}
        </span>

        {/* Best quant */}
        {best.quant && best.quant !== 'unknown' && (
          <span className="text-[10px] text-gray-500 font-mono shrink-0 hidden sm:inline">
            {best.quant}
          </span>
        )}

        {/* Size */}
        <span className="text-[10px] text-gray-600 tabular-nums shrink-0 hidden sm:inline">
          {(best.file_size_mb / 1024).toFixed(1)} GB
        </span>

        {/* Downloads */}
        <span className="text-[10px] text-gray-700 tabular-nums shrink-0">
          {fmtDl(model.downloads)}↓
        </span>

        {open
          ? <ChevronDown className="w-3 h-3 text-gray-600 shrink-0" />
          : <ChevronRight className="w-3 h-3 text-gray-600 shrink-0" />}
      </button>

      {/* Expanded: variants + pull command, no separate HF link row */}
      {open && (
        <div className="px-3 pb-2 border-t border-gray-700/40">
          <VariantTable variants={model.variants} modelId={model.model_id} pullCmd={best.pull_cmd || undefined} />
        </div>
      )}
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

const ModelDiscoveryCard: React.FC<{ isLocalHost?: boolean }> = ({ isLocalHost = true }) => {
  const [search, setSearch]         = useState('');
  const [pendingSearch, setPending] = useState('');
  const [data, setData]             = useState<DiscoveryResponse | null>(null);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const debounceRef                 = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchModels = useCallback(async (query?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '20' });
      if (query) params.set('search', query);
      const resp = await fetch(`/api/model-candidates?${params}`);
      if (!resp.ok) throw new Error(`${resp.status}`);
      setData(await resp.json());
    } catch (e: any) {
      setError(e.message ?? 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  // Load trending on mount
  useEffect(() => {
    if (isLocalHost) fetchModels();
  }, [isLocalHost, fetchModels]);

  // Debounced live search
  const handleSearchChange = (val: string) => {
    setPending(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSearch(val);
      fetchModels(val || undefined);
    }, 600);
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSearch(pendingSearch);
    fetchModels(pendingSearch || undefined);
  };

  if (!isLocalHost) return null;

  const fittingCount = data?.models.filter(m => m.variants.some(v => v.fit_score >= 60)).length ?? 0;
  const hw = data?.hardware;

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Package className="w-4 h-4 text-cyan-400" />
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
            Model Discovery
          </span>
          {data && !loading && (
            <span
              title="Models scoring ≥60 — VRAM headroom (40 pts) · thermal margin (20 pts) · WES history (20 pts) · power efficiency (20 pts)"
              className="text-[10px] text-cyan-400 bg-cyan-500/10 px-2 py-0.5 rounded-full border border-cyan-500/15 font-medium cursor-default"
            >
              {fittingCount} fit your hardware
            </span>
          )}
        </div>
        {/* Hardware context pill */}
        {hw && (
          <div className="flex items-center gap-2 text-[10px] text-gray-600">
            <Cpu className="w-3 h-3" />
            <span>{hw.chip ?? 'Unknown chip'}</span>
            <span>·</span>
            <span>{hw.vram_mb >= 1024 ? `${(hw.vram_mb / 1024).toFixed(0)} GB` : `${hw.vram_mb} MB`}</span>
            <span>·</span>
            <span className={hw.thermal_state === 'Normal' ? 'text-emerald-500' : 'text-yellow-500'}>
              {hw.thermal_state}
            </span>
          </div>
        )}
      </div>

      {/* Search */}
      <form onSubmit={handleSearchSubmit} className="flex gap-2">
        <div className="flex-1 relative">
          {loading
            ? <Loader2 className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-cyan-500 animate-spin" />
            : <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-600" />
          }
          <input
            type="text"
            value={pendingSearch}
            onChange={e => handleSearchChange(e.target.value)}
            placeholder="Search HuggingFace GGUF (e.g. llama, qwen, phi)…"
            className="w-full pl-8 pr-3 py-2 bg-gray-700/60 border border-gray-700/50 rounded-lg text-xs text-gray-300 placeholder:text-gray-600 focus:outline-none focus:border-cyan-500/40"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="px-3 py-2 bg-gray-700 border border-gray-700/50 rounded-lg text-xs text-gray-400 hover:text-cyan-400 hover:border-cyan-500/30 transition-colors disabled:opacity-40"
        >
          Search
        </button>
      </form>

      {/* Source label */}
      <div className="text-[10px] text-gray-700">
        {data?.is_live_search
          ? `Live HuggingFace search · ${data.models.length} model${data.models.length !== 1 ? 's' : ''} scored against your hardware`
          : `Trending GGUF models by downloads · scored against your hardware`}
      </div>

      {/* Error */}
      {error && (
        <p className="text-xs text-red-400 py-1">Failed to load: {error}</p>
      )}

      {/* Empty */}
      {data && data.models.length === 0 && !loading && (
        <p className="text-xs text-gray-600 py-6 text-center">
          No GGUF models found for "{search}". Try a different search term.
        </p>
      )}

      {/* Initial loading skeleton */}
      {loading && !data && (
        <div className="flex items-center justify-center py-10 gap-2 text-xs text-gray-600">
          <Loader2 className="w-4 h-4 animate-spin text-cyan-500/60" />
          {search ? 'Searching HuggingFace…' : 'Loading trending models…'}
        </div>
      )}

      {/* Results */}
      {data && data.models.length > 0 && (
        <div className="space-y-1">
          {data.models.map(model => (
            <ModelRow key={model.model_id} model={model} />
          ))}
        </div>
      )}
    </div>
  );
};

export default ModelDiscoveryCard;
