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
import { Search, Package, ExternalLink, Copy, Check, ChevronDown, ChevronRight, Cpu, Loader2, Sparkles } from 'lucide-react';
import { useSettings } from '../../hooks/useSettings';
import {
  quantQualityHint,
  recommendedQuant,
  vramAtContext,
  fitLabelAtContext,
  parseParameterCountB,
  CONTEXT_LENGTH_OPTIONS,
  DEFAULT_CONTEXT_LENGTH,
  contextLengthLabel,
} from '../../utils/quantQuality';
import { useModelComparisonHistory, projectTpsForVariant, type ComparisonRow } from '../../utils/modelHistory';

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
  /** HuggingFace likes — current bookmark interest (complements downloads). */
  likes?:    number;
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

function uploaderName(model_id: string): string | null {
  const parts = model_id.split('/');
  return parts.length > 1 ? parts[0] : null;
}

function fitGradeLabel(score: number): string {
  if (score >= 80) return 'Excellent';
  if (score >= 60) return 'Good';
  if (score >= 40) return 'Tight';
  if (score > 0)   return 'Marginal';
  return "Won't Fit";
}

function fitBarClass(score: number): string {
  if (score >= 80) return 'bg-emerald-500';
  if (score >= 60) return 'bg-green-500';
  if (score >= 40) return 'bg-yellow-500';
  if (score > 0)   return 'bg-orange-500';
  return 'bg-red-500';
}

/**
 * Per-row inline copy button — stops propagation so clicking it doesn't
 * also toggle the row's expand state.
 */
const RowCopyButton: React.FC<{ text: string; title?: string }> = ({ text, title }) => {
  const [copied, setCopied] = useState(false);
  const handle = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={handle}
      title={title ?? 'Copy pull command'}
      className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border transition-colors ${
        copied
          ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
          : 'bg-gray-800/60 border-gray-700/60 text-gray-400 hover:text-cyan-300 hover:border-cyan-500/30'
      }`}
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      <span>{copied ? 'Copied!' : 'Copy pull'}</span>
    </button>
  );
};

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

const VariantTable: React.FC<{
  variants: VariantResult[];
  modelId: string;
  pullCmd?: string;
  history: ComparisonRow[] | null;
  contextLength: number;
  vramBudgetMb: number;
  kwhRate: number;
}> = ({ variants, modelId, pullCmd, history, contextLength, vramBudgetMb, kwhRate }) => {
  const [showAll, setShowAll] = useState(false);
  const paramsB = parseParameterCountB(modelId) ?? 7;
  const isDefaultCtx = contextLength === DEFAULT_CONTEXT_LENGTH;

  // Recompute per-variant VRAM + fit at chosen context. At default context,
  // trust the backend's score so colors match the parent row.
  const recomputed = variants.map(v => {
    if (isDefaultCtx) {
      return { ...v, _vramMb: v.vram_required_mb, _label: v.fit_label, _score: v.fit_score, _headroomPct: v.vram_headroom_pct };
    }
    const vramMb = vramAtContext(v.file_size_mb, paramsB, contextLength);
    const fit = fitLabelAtContext(vramMb, vramBudgetMb);
    return { ...v, _vramMb: vramMb, _label: fit.label, _score: fit.score, _headroomPct: fit.headroomPct };
  });

  const fitting  = recomputed.filter(v => v._score >= 40);
  const wontFit  = recomputed.filter(v => v._score < 40);
  const displayed = showAll ? recomputed : fitting;
  const maxSize  = variants.reduce((m, v) => Math.max(m, v.file_size_mb), 0);
  const recQuant = recommendedQuant(maxSize);
  const hasRecQuant = variants.some(v => v.quant?.toUpperCase() === recQuant.toUpperCase());

  // Estimate avg watts at inference from history (same-class models).
  // Used for per-variant cost-per-million-tokens.
  const avgWatts = (() => {
    if (!history || !history.length) return null;
    const withWatts = history.filter(r => r.avg_watts != null && r.avg_watts > 0);
    if (!withWatts.length) return null;
    const sum = withWatts.reduce((s, r) => s + (r.avg_watts as number), 0);
    return sum / withWatts.length;
  })();

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
          const vc = fitColors(v._score);
          const label = quantLabel(v);
          const isRecommended = hasRecQuant && v.quant?.toUpperCase() === recQuant.toUpperCase();
          const proj = history ? projectTpsForVariant(history, v.file_size_mb, v.quant) : null;
          // Cost-per-million-tokens — only when we have both a tok/s projection
          // and a watts estimate from fleet/local telemetry.
          let costPerM: number | null = null;
          if (proj && avgWatts != null) {
            const tpsAvg = (proj.min + proj.max) / 2;
            if (tpsAvg > 0) {
              // (watts / 1000) * (1,000,000 / tps / 3600) * rate
              costPerM = (avgWatts / 1000) * (1_000_000 / tpsAvg / 3600) * kwhRate;
            }
          }
          return (
            <div key={v.filename} className="flex items-center gap-2 py-1 border-t border-gray-700/20 first:border-t-0">
              <div className={`w-1.5 h-1.5 rounded-full ${vc.dot} shrink-0`} />
              <span
                className="text-[11px] text-gray-400 font-mono shrink-0 w-[72px] truncate cursor-help"
                title={`${v.filename}\n\n${quantQualityHint(label)}`}
              >
                {label}
              </span>
              <span className={`text-[10px] font-medium px-1.5 py-px rounded ${vc.badge} border shrink-0`}>
                {v._label}
              </span>
              {isRecommended && (
                <span
                  title={`Recommended quant for this size class — typical sweet spot of quality vs. file size.`}
                  className="text-[9px] font-semibold px-1.5 py-px rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 shrink-0 cursor-default uppercase tracking-wider"
                >
                  Recommended
                </span>
              )}
              <span className="text-[11px] text-gray-500 font-mono tabular-nums shrink-0">
                {(v.file_size_mb / 1024).toFixed(1)} GB
              </span>
              <span
                className="text-[10px] text-gray-600 truncate flex-1"
                title={isDefaultCtx ? undefined : `VRAM at ${contextLengthLabel(contextLength)} ctx: ${(v._vramMb / 1024).toFixed(2)} GB (model + KV cache + overhead)`}
              >
                {v._headroomPct >= 0 ? `${v._headroomPct.toFixed(0)}% headroom` : 'over budget'}
                {!isDefaultCtx && (
                  <span className="ml-1 text-gray-700">
                    · {(v._vramMb / 1024).toFixed(1)} GB @ {contextLengthLabel(contextLength)}
                  </span>
                )}
                {proj && (
                  <span
                    className="ml-2 text-gray-500"
                    title={`Projected from ${proj.count} similar-size model${proj.count === 1 ? '' : 's'} you've run in the last 7 days.`}
                  >
                    ≈ {proj.min.toFixed(0)}-{proj.max.toFixed(0)} tok/s ({proj.count})
                  </span>
                )}
                {costPerM != null && (
                  <span
                    className="ml-2 text-gray-600"
                    title={`Estimated electricity cost at ${kwhRate.toFixed(3)} $/kWh, using projected tok/s and ${avgWatts!.toFixed(0)} W avg from your hardware.`}
                  >
                    ≈ ${costPerM < 0.01 ? costPerM.toFixed(4) : costPerM.toFixed(3)} / M tokens
                  </span>
                )}
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

// ── Speed comparison chart ────────────────────────────────────────────────────

/**
 * Inline horizontal-bar chart showing each variant's projected tok/s on
 * the user's hardware. Rendered with plain divs (no chart library) to
 * keep bundle size flat. Skipped when fewer than 2 variants have a
 * projection — a single bar is not a comparison.
 */
const QuantSpeedChart: React.FC<{
  variants: VariantResult[];
  history: ComparisonRow[] | null;
}> = ({ variants, history }) => {
  if (!history || history.length === 0) return null;

  type Bar = { quant: string; mid: number };
  const bars: Bar[] = [];
  for (const v of variants) {
    const proj = projectTpsForVariant(history, v.file_size_mb, v.quant);
    if (!proj) continue;
    bars.push({ quant: quantLabel(v), mid: (proj.min + proj.max) / 2 });
  }
  if (bars.length < 2) return null;

  const max = bars.reduce((m, b) => Math.max(m, b.mid), 0);
  if (max <= 0) return null;

  return (
    <div className="mt-2 space-y-1">
      <div className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">
        Estimated tok/s by quant on your hardware
      </div>
      <div className="space-y-1">
        {bars.map(b => {
          const pct = Math.max(4, Math.round((b.mid / max) * 100));
          return (
            <div key={b.quant} className="flex items-center gap-2">
              <span className="text-[10px] text-gray-500 font-mono w-[72px] shrink-0 truncate">
                {b.quant}
              </span>
              <div className="flex-1 h-3 bg-gray-700/40 rounded-sm overflow-hidden">
                <div
                  className="h-full bg-emerald-500/70 rounded-sm flex items-center justify-end pr-1.5"
                  style={{ width: `${pct}%` }}
                >
                  <span className="text-[9px] text-gray-100 font-mono tabular-nums">
                    {b.mid.toFixed(0)}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ── Model row ─────────────────────────────────────────────────────────────────

const ModelRow: React.FC<{
  model: ModelResult;
  history: ComparisonRow[] | null;
  contextLength: number;
  vramBudgetMb: number;
  kwhRate: number;
}> = ({ model, history, contextLength, vramBudgetMb, kwhRate }) => {
  const [open, setOpen] = useState(false);
  const best = model.variants[0];
  if (!best) return null;
  const colors = fitColors(best.fit_score);
  const uploader = uploaderName(model.model_id);

  // Recommended quant for line 2. Falls back to best variant when no rec.
  const maxSize = model.variants.reduce((m, v) => Math.max(m, v.file_size_mb), 0);
  const recQuantName = recommendedQuant(maxSize);
  const recVariant = model.variants.find(v => v.quant?.toUpperCase() === recQuantName.toUpperCase()) ?? best;

  // Projections + cost — use best (top-scored) variant for the row line.
  const proj = history ? projectTpsForVariant(history, best.file_size_mb, best.quant) : null;
  const avgWatts = (() => {
    if (!history || !history.length) return null;
    const w = history.filter(r => r.avg_watts != null && r.avg_watts > 0);
    if (!w.length) return null;
    return w.reduce((s, r) => s + (r.avg_watts as number), 0) / w.length;
  })();
  let costPerM: number | null = null;
  if (proj && avgWatts != null) {
    const tpsAvg = (proj.min + proj.max) / 2;
    if (tpsAvg > 0) costPerM = (avgWatts / 1000) * (1_000_000 / tpsAvg / 3600) * kwhRate;
  }

  return (
    <div className="border border-gray-700/60 rounded-lg overflow-hidden">
      {/* Summary row — two lines mirroring the fleet variant. */}
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex flex-col gap-1 px-3 py-2 hover:bg-gray-700/20 transition-colors text-left"
      >
        {/* Line 1 — identity + copy CTA */}
        <div className="flex items-center gap-2 w-full">
          <div className={`w-2 h-2 rounded-full ${colors.dot} shrink-0`} />
          <span className="text-xs text-gray-200 font-mono truncate min-w-0 flex-1">
            {shortModelName(model.model_id)}
            {uploader && (
              <span className="text-gray-600 font-sans"> · {uploader}</span>
            )}
          </span>
          {best.pull_cmd && best.fit_score >= 40 && (
            <RowCopyButton
              text={best.pull_cmd}
              title={`Copy pull command for recommended quant`}
            />
          )}
          {open
            ? <ChevronDown className="w-3 h-3 text-gray-600 shrink-0" />
            : <ChevronRight className="w-3 h-3 text-gray-600 shrink-0" />}
        </div>

        {/* Line 2 — quant, size, fit grade, speed, cost, downloads, likes */}
        <div className="flex items-center gap-2 w-full flex-wrap text-[10px] pl-4">
          <span
            className="text-gray-400 font-mono tabular-nums"
            title={quantQualityHint(recVariant.quant ?? '')}
          >
            <span className="text-gray-300">{recVariant.quant && recVariant.quant !== 'unknown' ? recVariant.quant : 'GGUF'}</span>
            <span className="text-gray-600"> ({(recVariant.file_size_mb / 1024).toFixed(1)} GB)</span>
          </span>

          <span className="text-gray-600">·</span>
          <span className="inline-flex items-center gap-1.5" title={`Fit score ${best.fit_score}/100`}>
            <span className={`inline-block w-1.5 h-3 rounded-sm ${fitBarClass(best.fit_score)}`} />
            <span className={colors.text}>{fitGradeLabel(best.fit_score)}</span>
            <span className="text-gray-600">fit</span>
          </span>

          {proj && (
            <>
              <span className="text-gray-600">·</span>
              <span
                className="text-gray-400 tabular-nums"
                title={`Projected from ${proj.count} similar-size model${proj.count === 1 ? '' : 's'} (last 7 days)`}
              >
                ≈{((proj.min + proj.max) / 2).toFixed(0)} tok/s
              </span>
            </>
          )}

          {costPerM != null && (
            <>
              <span className="text-gray-600">·</span>
              <span
                className="text-gray-500 tabular-nums"
                title={`Electricity at ${kwhRate.toFixed(3)} $/kWh · projected tok/s · ${avgWatts?.toFixed(0)} W avg`}
              >
                ${costPerM < 0.01 ? costPerM.toFixed(4) : costPerM.toFixed(3)}/M
              </span>
            </>
          )}

          <span className="text-gray-700 tabular-nums ml-auto" title="HuggingFace downloads (all time)">
            {fmtDl(model.downloads)}↓
          </span>

          {model.likes != null && model.likes > 0 && (
            <span className="text-rose-400/50 tabular-nums" title="HuggingFace likes">
              {fmtDl(model.likes)}♥
            </span>
          )}
        </div>
      </button>

      {/* Expanded: variants + pull command, no separate HF link row */}
      {open && (
        <div className="px-3 pb-2 border-t border-gray-700/40">
          <VariantTable
            variants={model.variants}
            modelId={model.model_id}
            pullCmd={best.pull_cmd || undefined}
            history={history}
            contextLength={contextLength}
            vramBudgetMb={vramBudgetMb}
            kwhRate={kwhRate}
          />
          <QuantSpeedChart variants={model.variants} history={history} />
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
  const history                     = useModelComparisonHistory(isLocalHost);
  const [contextLength, setContextLength] = useState<number>(DEFAULT_CONTEXT_LENGTH);
  const { settings }                = useSettings();
  const kwhRate                     = settings.fleet.kwhRate || 0.16;
  const historyCount                = history?.length ?? 0;

  const fetchModels = useCallback(async (query?: string) => {
    setLoading(true);
    setError(null);
    try {
      // Pull a wide catalog so trending lists actually have depth on
      // capable nodes. Backend caps at 200.
      const params = new URLSearchParams({ limit: '200' });
      if (query) params.set('search', query);
      const resp = await fetch(`/api/model-candidates?${params}`);
      if (!resp.ok) throw new Error(`${resp.status}`);
      // When the agent doesn't have this route, axum's static fallback
      // serves index.html (HTML) — JSON.parse then fails with a cryptic
      // "Unexpected token '<'". Detect via Content-Type to surface a
      // clean "update your agent" message instead.
      const ct = resp.headers.get('content-type') ?? '';
      if (!ct.includes('application/json')) {
        throw new Error('agent endpoint missing — update your agent: `curl -fsSL https://wicklee.dev/install.sh | bash`');
      }
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
    setContextLength(DEFAULT_CONTEXT_LENGTH);
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

      {/* "Your hardware" positioning callout */}
      <div className="flex items-start gap-2 px-3 py-2 bg-blue-500/5 border border-blue-500/20 rounded-lg">
        <Sparkles className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-px" />
        <p className="text-[11px] text-gray-400 leading-snug">
          {historyCount > 0 ? (
            <>
              Wicklee scores models against <span className="text-gray-200 font-medium">YOUR hardware's actual performance</span> —
              not generic benchmarks. Projections use telemetry from{' '}
              <span className="text-blue-300 font-medium">{historyCount}</span> model{historyCount === 1 ? '' : 's'} you've run.
            </>
          ) : (
            <>
              Run a few models — Wicklee will then project tok/s and cost for
              candidates based on your <span className="text-gray-200 font-medium">actual hardware's performance</span>.
            </>
          )}
        </p>
      </div>

      {/* Context length picker */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-gray-600 uppercase tracking-widest">Context length:</span>
        {CONTEXT_LENGTH_OPTIONS.map(ctx => (
          <button
            key={ctx}
            onClick={() => setContextLength(ctx)}
            title={`Recalculate VRAM and fit assuming ${contextLengthLabel(ctx)} token context window`}
            className={`text-[10px] font-mono px-2 py-0.5 rounded-full border transition-colors ${
              contextLength === ctx
                ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                : 'bg-transparent border-gray-700 text-gray-600 hover:text-gray-400 hover:border-gray-700'
            }`}
          >
            {contextLengthLabel(ctx)}
          </button>
        ))}
      </div>

      {/* Source label */}
      <div className="text-[10px] text-gray-700">
        {data?.is_live_search
          ? `Live HuggingFace search · ${data.models.length} model${data.models.length !== 1 ? 's' : ''} scored against your hardware`
          : !search
            ? <span><span className="text-gray-400 font-semibold">Recommended for your hardware</span> — sorted by fit, then popularity</span>
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
          {(() => {
            const list = [...data.models];
            // When no search query, re-sort by best fit then by downloads.
            if (!search) {
              list.sort((a, b) => {
                const aFit = a.variants.reduce((m, v) => Math.max(m, v.fit_score), 0);
                const bFit = b.variants.reduce((m, v) => Math.max(m, v.fit_score), 0);
                if (bFit !== aFit) return bFit - aFit;
                return (b.downloads ?? 0) - (a.downloads ?? 0);
              });
            }
            return list.map(model => (
              <ModelRow
                key={model.model_id}
                model={model}
                history={history}
                contextLength={contextLength}
                vramBudgetMb={hw?.vram_mb ?? 0}
                kwhRate={kwhRate}
              />
            ));
          })()}
        </div>
      )}
    </div>
  );
};

export default ModelDiscoveryCard;
