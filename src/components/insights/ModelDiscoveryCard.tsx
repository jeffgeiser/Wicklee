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
import { ELECTRICITY_RATE_USD_PER_KWH } from '../../utils/efficiency';
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
import { useModelComparisonHistory, projectTpsForVariant, type ComparisonRow, type TpsProjection } from '../../utils/modelHistory';
import { inferCategory, categoryDescription, ALL_CATEGORIES, type ModelCategory } from '../../utils/modelCategory';
import DiscoveryHoverCard, { type DiscoveryHoverRow } from './DiscoveryHoverCard';

// ── Projection-tier helpers (shared with FleetModelDiscovery — when those
// stabilise, lift these into modelHistory.ts) ─────────────────────────────

/** Single-word label for a projection's confidence tier. */
function projConfidenceLabel(c: TpsProjection['confidence']): string {
  switch (c) {
    case 'cohort':      return 'measured';
    case 'sample':      return 'measured (1 sample)';
    case 'bandwidth':   return 'scaled estimate';
    case 'theoretical': return 'spec estimate';
  }
}
/** One-line body explaining how this projection was produced. */
function projConfidenceBody(p: TpsProjection): string {
  switch (p.confidence) {
    case 'cohort':
      return `Average across ${p.count} similar-size models that have actually run on this node. Highest fidelity.`;
    case 'sample':
      return `Single similar-size measurement on this node, shown as a point estimate ±10%.`;
    case 'bandwidth':
      return `Scaled from your node's measured throughput on a different-size model. Inference is memory-bandwidth-bound: tok/s ∝ 1/size.`;
    case 'theoretical':
      return `Estimated from this chip's published memory bandwidth and the model's file size. No telemetry needed — refines once you run a model.`;
  }
}
/** Structured rows summarising the projection range + method. */
function projConfidenceRows(p: TpsProjection): DiscoveryHoverRow[] {
  return [
    { label: 'Range',  value: `${p.min} – ${p.max} tok/s` },
    { label: 'Source', value: projConfidenceLabel(p.confidence), accent: p.confidence === 'theoretical' ? 'amber' : 'cyan' },
    ...(p.count > 0 ? [{ label: 'Samples', value: `${p.count}` } as DiscoveryHoverRow] : []),
  ];
}

/** Sort modes for the Discovery results list. Default = 'fit' (current behavior). */
type SortMode = 'fit' | 'popularity' | 'speed' | 'cost' | 'size_asc' | 'size_desc';

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
                    title={proj.confidence === 'cohort'
                      ? `Projected from ${proj.count} similar-size model${proj.count === 1 ? '' : 's'} you've run in the last 7 days (high fidelity).`
                      : proj.confidence === 'sample'
                        ? `Projected from 1 similar-size model — point estimate ±10%.`
                        : `Scaled from your measured tok/s on a different-size model. LLM inference is memory-bandwidth-bound (tok/s ∝ 1/size). Lowest-fidelity tier; precision improves as you run more models in this size class.`}
                  >
                    ≈ {proj.min.toFixed(0)}-{proj.max.toFixed(0)} tok/s
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
  /** Chip name (e.g. "Apple M4 Pro") — enables theoretical-fallback tok/s
   *  when no telemetry history exists. */
  chipName: string | null;
  /** When false, suppress the cost-per-M column (user has not set kWh rate). */
  showCost: boolean;
}> = ({ model, history, contextLength, vramBudgetMb, kwhRate, chipName, showCost }) => {
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
  // Pass chipName so the projection falls back to a theoretical bandwidth-based
  // estimate when no telemetry history exists yet (Phase 3).
  const proj = projectTpsForVariant(history ?? [], best.file_size_mb, best.quant, chipName);
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

  // Localhost always has a single node — there's no "hasFleetHistory" toggle,
  // but the same grid template makes the row visually consistent with the
  // cloud Fleet panel. Phase 3 theoretical fallback means tok/s ~always~
  // renders here (chip lookup almost always succeeds on Apple/NVIDIA), so we
  // use the wider speed-column variant of the grid unconditionally.
  return (
    <div className="border border-gray-700/60 rounded-xl overflow-hidden">
      {/* Single-line grid summary — column proportions mirror the cloud Fleet
          variant exactly so users moving between localhost and the fleet
          dashboard see the same layout. Responsive: popularity hides first,
          then projection, then quant. Identity + fit + action always visible. */}
      <button
        onClick={() => setOpen(v => !v)}
        className={[
          'w-full grid gap-2 items-center px-3 py-2 hover:bg-gray-700/20 transition-colors text-left',
          // Identity gets ~47% of the row; right-side columns tightened so
          // fit/speed/popularity/actions group visually together. Same
          // proportions as the cloud Fleet panel so users moving between
          // localhost and the fleet dashboard see consistent column widths.
          'grid-cols-[minmax(0,3fr)_minmax(0,1.1fr)_auto]',
          'lg:grid-cols-[minmax(0,3fr)_minmax(0,0.9fr)_minmax(0,1.1fr)_minmax(0,0.9fr)_auto]',
          'xl:grid-cols-[minmax(0,3fr)_minmax(0,0.9fr)_minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,0.5fr)_auto]',
        ].join(' ')}
      >
        {/* Col 1 — identity (dot + stacked name/uploader) */}
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-2 h-2 rounded-full ${colors.dot} shrink-0`} />
          <div className="min-w-0 flex-1">
            <div
              className="text-xs text-gray-200 font-mono truncate"
              title={shortModelName(model.model_id)}
            >
              {shortModelName(model.model_id)}
            </div>
            {uploader && (
              <div className="text-[10px] text-gray-600 truncate" title={uploader}>
                {uploader}
              </div>
            )}
          </div>
        </div>

        {/* Col 2 — recommended quant + size (hidden on < md) */}
        <div
          className="text-[10px] font-mono tabular-nums hidden md:block min-w-0"
          title={quantQualityHint(recVariant.quant ?? '')}
        >
          <span className="text-gray-300">{recVariant.quant && recVariant.quant !== 'unknown' ? recVariant.quant : 'GGUF'}</span>
          <span className="text-gray-600"> · {(recVariant.file_size_mb / 1024).toFixed(1)} GB</span>
        </div>

        {/* Col 3 — fit grade */}
        <div
          className="flex items-center gap-1.5 text-[10px] min-w-0"
          title={`Fit score ${best.fit_score}/100`}
        >
          <span className={`inline-block w-1.5 h-3 rounded-sm shrink-0 ${fitBarClass(best.fit_score)}`} />
          <span className={`${colors.text} truncate`}>{fitGradeLabel(best.fit_score)}</span>
          <span className="text-gray-600 tabular-nums whitespace-nowrap">fit</span>
        </div>

        {/* Col 4 — speed + (optional) cost projection. Hidden on < lg. */}
        <div className="text-[10px] tabular-nums hidden lg:flex items-center gap-2 min-w-0">
          {proj ? (
            <DiscoveryHoverCard
              heading={`≈${((proj.min + proj.max) / 2).toFixed(0)} tok/s · ${projConfidenceLabel(proj.confidence)}`}
              body={projConfidenceBody(proj)}
              rows={projConfidenceRows(proj)}
            >
              <span className={proj.confidence === 'theoretical' ? 'text-gray-500 italic' : 'text-gray-400'}>
                ≈{((proj.min + proj.max) / 2).toFixed(0)} t/s
              </span>
            </DiscoveryHoverCard>
          ) : null}
          {showCost && costPerM != null ? (
            <DiscoveryHoverCard
              heading="Cost per million tokens"
              body="Estimated electricity cost to generate 1M tokens at this node's projected tok/s and average power draw."
              rows={[
                { label: 'Power rate',  value: `$${kwhRate.toFixed(3)}/kWh` },
                { label: 'Avg watts',   value: avgWatts != null ? `${avgWatts.toFixed(0)} W (measured)` : '—' },
                { label: 'Formula',     value: 'watts × $/kWh ÷ (tok/s × 3600) × 1M' },
              ]}
            >
              <span className="text-gray-500">
                ${costPerM < 0.01 ? costPerM.toFixed(4) : costPerM.toFixed(3)}/M
              </span>
            </DiscoveryHoverCard>
          ) : null}
          {!proj && (
            <span className="text-gray-700" title="Projection unavailable for this row.">
              —
            </span>
          )}
        </div>

        {/* Col 5 — popularity (hidden on < xl) */}
        <div className="text-[10px] tabular-nums hidden xl:flex items-center gap-2 min-w-0 justify-end">
          <span className="text-gray-700" title="HuggingFace downloads (all time)">
            {fmtDl(model.downloads)}↓
          </span>
          {model.likes != null && model.likes > 0 && (
            <span className="text-rose-400/50" title="HuggingFace likes">
              {fmtDl(model.likes)}♥
            </span>
          )}
        </div>

        {/* Col 6 — actions (always visible, right-aligned) */}
        <div className="flex items-center gap-1 shrink-0">
          {best.pull_cmd && best.fit_score >= 40 && (
            <RowCopyButton
              text={best.pull_cmd}
              title={`Copy pull command for ${recVariant.quant && recVariant.quant !== 'unknown' ? recVariant.quant : 'recommended quant'}`}
            />
          )}
          {open
            ? <ChevronDown className="w-3 h-3 text-gray-600" />
            : <ChevronRight className="w-3 h-3 text-gray-600" />}
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
  // useSettings exposes `isKwhRateConfigured` so cost-per-M only shows when
  // the user has actually entered their power rate in Settings — not when
  // they're seeing the default $0.12 placeholder they never engaged with.
  const [contextLength, setContextLength] = useState<number>(DEFAULT_CONTEXT_LENGTH);
  // Phase 2: category + sort. 'All' shows everything; sort defaults to 'fit'.
  const [category, setCategory] = useState<ModelCategory | 'All'>('All');
  const [sortMode, setSortMode] = useState<SortMode>('fit');
  const { settings, isKwhRateConfigured } = useSettings();
  const kwhRate                     = settings.fleet.kwhRate || ELECTRICITY_RATE_USD_PER_KWH;
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

  // ── Phase 2: category + sort plumbing ────────────────────────────────────
  // Base pool: everything the agent returned. Localhost has a single node so
  // there's no fit-mode filter to layer on first (unlike the fleet variant).
  const basePool = data?.models ?? [];
  const categoryCounts: Record<ModelCategory | 'All', number> = {
    All: basePool.length,
    General: 0, Code: 0, Reasoning: 0, Vision: 0, Embedding: 0, Audio: 0,
  };
  for (const m of basePool) categoryCounts[inferCategory(m.model_id)]++;
  const displayModels = category === 'All'
    ? basePool
    : basePool.filter(m => inferCategory(m.model_id) === category);

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

      {/* Page-level methodology callout removed — per-row hover tooltips now
          explain how each tok/s projection was derived (cohort/sample/
          bandwidth/theoretical), and the full methodology lives in
          docs/docs.md under "Model Discovery Scoring". The page banner was
          drifting toward over-claim now that theoretical fallback can produce
          tok/s estimates without any telemetry input. */}

      {/* Context length + Sort — paired on one row at ≥lg widths; restack
          via flex-wrap on narrower viewports. Mirrors FleetModelDiscovery
          so the two panels stay visually identical. */}
      <div className="flex items-start gap-x-6 gap-y-2 flex-wrap">
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

        {/* Vertical separator between the paired groups, lg+ only. */}
        <div className="hidden lg:block w-px self-stretch bg-gray-700/40" aria-hidden="true" />

        {/* Sort chip row. 'speed' and 'cost' degrade gracefully — models
            without a projection sink to the bottom rather than disappearing. */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-gray-600 uppercase tracking-widest mr-0.5">Sort:</span>
          {([
            { key: 'fit',        label: 'Fit',        hint: 'Highest fit score first (default).' },
            { key: 'popularity', label: 'Popularity', hint: 'Most-downloaded on HuggingFace first.' },
            { key: 'speed',      label: 'Speed',      hint: 'Projected tok/s — fastest first. Requires at least one model run.' },
            { key: 'cost',       label: 'Cost',       hint: 'Cheapest tokens per dollar first. Requires at least one model run.' },
            { key: 'size_asc',   label: 'Size ↑',     hint: 'Smallest model first.' },
            { key: 'size_desc',  label: 'Size ↓',     hint: 'Largest model first.' },
          ] as { key: SortMode; label: string; hint: string }[]).map(s => {
            const needsHistory = s.key === 'speed' || s.key === 'cost';
            const disabled = needsHistory && historyCount === 0;
            return (
              <button
                key={s.key}
                onClick={() => !disabled && setSortMode(s.key)}
                disabled={disabled}
                title={s.hint + (disabled ? ' Unavailable until at least one model has run.' : '')}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                  sortMode === s.key
                    ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                    : disabled
                      ? 'bg-transparent border-gray-800 text-gray-700 cursor-not-allowed opacity-50'
                      : 'bg-transparent border-gray-700 text-gray-600 hover:text-gray-400 hover:border-gray-700'
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Category chip row — own row because counts in the chips give it
          variable width and 7 chips need breathing room. Inferred client-
          side from model_id (Phase 2). */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] text-gray-600 uppercase tracking-widest mr-0.5">Category:</span>
        <button
          onClick={() => setCategory('All')}
          title="Show all categories"
          className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
            category === 'All'
              ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
              : 'bg-transparent border-gray-700 text-gray-600 hover:text-gray-400 hover:border-gray-700'
          }`}
        >
          All <span className="text-gray-600 font-mono">{categoryCounts.All}</span>
        </button>
        {ALL_CATEGORIES.map(cat => {
          const count = categoryCounts[cat];
          const disabled = count === 0;
          return (
            <button
              key={cat}
              onClick={() => !disabled && setCategory(cat)}
              disabled={disabled}
              title={categoryDescription(cat) + (disabled ? ' — no matches in current view.' : '')}
              className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                category === cat
                  ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                  : disabled
                    ? 'bg-transparent border-gray-800 text-gray-700 cursor-not-allowed opacity-50'
                    : 'bg-transparent border-gray-700 text-gray-600 hover:text-gray-400 hover:border-gray-700'
              }`}
            >
              {cat} <span className="text-gray-600 font-mono">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Source label */}
      <div className="text-[10px] text-gray-700">
        {data?.is_live_search
          ? `Live HuggingFace search · ${displayModels.length} model${displayModels.length !== 1 ? 's' : ''} scored against your hardware`
          : !search
            ? <span><span className="text-gray-400 font-semibold">Recommended for your hardware</span> — {displayModels.length} model{displayModels.length !== 1 ? 's' : ''} {category !== 'All' ? `in ${category}` : 'across all categories'}</span>
            : `Trending GGUF models by downloads · scored against your hardware`}
      </div>

      {/* Error */}
      {error && (
        <p className="text-xs text-red-400 py-1">Failed to load: {error}</p>
      )}

      {/* Empty */}
      {data && displayModels.length === 0 && !loading && (
        <p className="text-xs text-gray-600 py-6 text-center">
          {data.models.length === 0
            ? `No GGUF models found for "${search}". Try a different search term.`
            : `No ${category} models in the current view. Try a different category or "All".`}
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
      {data && displayModels.length > 0 && (
        <div className="space-y-1">
          {(() => {
            const list = [...displayModels];
            // Hoist avgWatts here so 'cost' sort uses the same value the rows
            // render — fleet-wide average from history, identical for every model.
            const avgWatts = history && history.length
              ? (() => {
                  const w = history.filter(r => r.avg_watts != null && r.avg_watts > 0);
                  return w.length
                    ? w.reduce((s, r) => s + (r.avg_watts as number), 0) / w.length
                    : null;
                })()
              : null;
            // The "best variant" — highest fit_score — drives speed/cost/size sorts.
            const bestVariantOf = (m: ModelResult) =>
              m.variants.reduce<VariantResult | null>(
                (best, v) => (!best || v.fit_score > best.fit_score) ? v : best,
                null,
              );
            const fitOf = (m: ModelResult) =>
              m.variants.reduce((acc, v) => Math.max(acc, v.fit_score), 0);
            const projOf = (m: ModelResult) => {
              const best = bestVariantOf(m);
              if (!history || !best) return null;
              return projectTpsForVariant(history, best.file_size_mb, best.quant);
            };
            const sizeOf = (m: ModelResult) => bestVariantOf(m)?.file_size_mb ?? 0;
            // When no search query, sort by the user's selected sort mode.
            // Search results stay in HF's download-rank order so the relevance
            // signal from HF's search isn't overridden.
            if (!search) {
              list.sort((a, b) => {
                switch (sortMode) {
                  case 'popularity':
                    return (b.downloads ?? 0) - (a.downloads ?? 0);
                  case 'size_asc':
                    return sizeOf(a) - sizeOf(b);
                  case 'size_desc':
                    return sizeOf(b) - sizeOf(a);
                  case 'speed': {
                    const pa = projOf(a), pb = projOf(b);
                    const ta = pa ? (pa.min + pa.max) / 2 : -1;
                    const tb = pb ? (pb.min + pb.max) / 2 : -1;
                    if (tb !== ta) return tb - ta;
                    return fitOf(b) - fitOf(a);
                  }
                  case 'cost': {
                    const pa = projOf(a), pb = projOf(b);
                    const costOf = (proj: ReturnType<typeof projOf>) => {
                      if (!proj || avgWatts == null) return Number.POSITIVE_INFINITY;
                      const tps = (proj.min + proj.max) / 2;
                      if (tps <= 0) return Number.POSITIVE_INFINITY;
                      return (avgWatts / 1000) * (1_000_000 / tps / 3600) * kwhRate;
                    };
                    const ca = costOf(pa), cb = costOf(pb);
                    if (ca !== cb) return ca - cb;
                    return fitOf(b) - fitOf(a);
                  }
                  case 'fit':
                  default: {
                    const aFit = fitOf(a), bFit = fitOf(b);
                    if (bFit !== aFit) return bFit - aFit;
                    return (b.downloads ?? 0) - (a.downloads ?? 0);
                  }
                }
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
                chipName={hw?.chip ?? null}
                showCost={isKwhRateConfigured}
              />
            ));
          })()}
        </div>
      )}
    </div>
  );
};

export default ModelDiscoveryCard;
