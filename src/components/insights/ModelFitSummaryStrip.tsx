/**
 * ModelFitSummaryStrip — first-fold model fit verdict on Overview.
 *
 * Three compact tiles condensing the conclusions from the three model-fit
 * calculators into a single row:
 *
 *   [ MODEL FIT ]              [ QUANT SWEET SPOT ]        [ CONTEXT RUNWAY ]
 *
 * Composes the existing utilities — no new math:
 *   - computeModelFitScore   (utils/modelFit.ts)
 *   - computeQuantRecommendation (utils/quantSweet.ts)
 *   - computeContextRunway   (utils/kvCache.ts)
 *
 * Renders nothing when no model is loaded.  Each tile is clickable and scrolls
 * to the full ModelFitAnalysis card lower on the page.
 */

import React from 'react';
import { Cpu, Gauge, Layers, ArrowRight } from 'lucide-react';
import type { SentinelMetrics } from '../../types';
import { computeModelFitScore } from '../../utils/modelFit';
import { computeQuantRecommendation } from '../../utils/quantSweet';
import { computeContextRunway, fmtCtx, fmtKvSize } from '../../utils/kvCache';

// ── Score → colour helpers ──────────────────────────────────────────────────

const FIT_DOT: Record<'good' | 'fair' | 'poor', string> = {
  good: 'bg-green-500',
  fair: 'bg-amber-500',
  poor: 'bg-red-500',
};

const FIT_TEXT: Record<'good' | 'fair' | 'poor', string> = {
  good: 'text-green-400',
  fair: 'text-amber-400',
  poor: 'text-red-400',
};

const FIT_BORDER: Record<'good' | 'fair' | 'poor', string> = {
  good: 'border-green-500/30 hover:border-green-500/50',
  fair: 'border-amber-500/30 hover:border-amber-500/50',
  poor: 'border-red-500/30 hover:border-red-500/50',
};

const RECOMMENDATION_LABEL: Record<string, string> = {
  upgrade:    'Upgrade quant',
  consider:   'Consider upgrade',
  'sweet-spot': 'Sweet spot',
  downgrade:  'Free headroom',
  lossless:   'Maximum quality',
  none:       '—',
};

const RECOMMENDATION_TONE: Record<string, string> = {
  upgrade:    'text-amber-400',
  consider:   'text-cyan-300',
  'sweet-spot': 'text-green-400',
  downgrade:  'text-amber-400',
  lossless:   'text-cyan-300',
  none:       'text-gray-500',
};

// ── Quant family extraction (mirrors ModelFitAnalysis) ───────────────────────

function extractQuantFamily(quant: string | null | undefined): string {
  if (!quant) return 'unknown';
  const q = quant.toUpperCase();
  if (q.startsWith('Q2') || q.startsWith('IQ2'))  return 'Q2';
  if (q.startsWith('Q3') || q.startsWith('IQ3'))  return 'Q3';
  if (q.startsWith('Q4') || q.startsWith('IQ4'))  return 'Q4';
  if (q.startsWith('Q5'))                          return 'Q5';
  if (q.startsWith('Q6'))                          return 'Q6';
  if (q.startsWith('Q8'))                          return 'Q8';
  if (q === 'F16' || q === 'BF16' || q === 'FP16') return 'F16';
  if (q === 'F32' || q === 'FP32')                 return 'F32';
  return 'unknown';
}

// ── Component ───────────────────────────────────────────────────────────────

interface Props {
  node: SentinelMetrics;
  /** Anchor id of the full ModelFitAnalysis section to scroll to. */
  anchorId?: string;
}

const ModelFitSummaryStrip: React.FC<Props> = ({ node, anchorId = 'model-fit-analysis' }) => {
  const fit = computeModelFitScore(node);
  if (!fit) return null;

  const observedTps =
    node.ollama_tokens_per_second
    ?? node.vllm_tokens_per_sec
    ?? null;
  const currentFamily = extractQuantFamily(node.ollama_quantization);
  const rec = currentFamily !== 'unknown'
    ? computeQuantRecommendation(currentFamily, fit.modelSizeGb, fit.headroomGb, observedTps, node)
    : null;

  const runway = computeContextRunway(node, fit.headroomGb);

  const modelName =
    node.ollama_active_model
    ?? node.vllm_model_name
    ?? node.llamacpp_model_name
    ?? 'Unknown model';

  const scrollToFullAnalysis = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = document.getElementById(anchorId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {/* ── Tile 1 — Model Fit ───────────────────────────────────────────── */}
      <a
        href={`#${anchorId}`}
        onClick={scrollToFullAnalysis}
        className={`group bg-gray-800 border ${FIT_BORDER[fit.score]} rounded-2xl p-4 transition-colors block`}
      >
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-1.5">
            <Cpu className="w-3.5 h-3.5 text-gray-500" />
            <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">Model Fit</span>
          </div>
          <ArrowRight className="w-3 h-3 text-gray-700 group-hover:text-gray-400 transition-colors" />
        </div>
        <div className="flex items-baseline gap-2 mb-1.5">
          <span className={`w-2 h-2 rounded-full ${FIT_DOT[fit.score]}`} />
          <span className={`text-lg font-bold ${FIT_TEXT[fit.score]}`}>
            {fit.score === 'good' ? 'Good' : fit.score === 'fair' ? 'Fair' : 'Poor'}
          </span>
          <span className="text-[10px] text-gray-600 font-mono ml-auto">
            {fit.headroomPct.toFixed(0)}% free
          </span>
        </div>
        <p className="text-[11px] text-gray-400 truncate" title={modelName}>{modelName}</p>
        {/* Memory bar */}
        <div className="mt-2 h-1 bg-gray-700 rounded-full overflow-hidden flex">
          <div
            className="h-full bg-indigo-500/80"
            style={{ width: `${Math.min((fit.modelSizeGb / fit.totalGb) * 100, 100)}%` }}
          />
          <div
            className="h-full bg-gray-500/40"
            style={{ width: `${Math.max(0, ((fit.totalGb - fit.headroomGb - fit.modelSizeGb) / fit.totalGb) * 100)}%` }}
          />
        </div>
        <p className="text-[10px] text-gray-600 mt-1.5 font-mono">
          {fit.modelSizeGb.toFixed(1)} GB model · {fit.totalGb.toFixed(0)} GB total
        </p>
      </a>

      {/* ── Tile 2 — Quant Sweet Spot ─────────────────────────────────────── */}
      <a
        href={`#${anchorId}`}
        onClick={scrollToFullAnalysis}
        className="group bg-gray-800 border border-gray-700 hover:border-gray-600 rounded-2xl p-4 transition-colors block"
      >
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-1.5">
            <Gauge className="w-3.5 h-3.5 text-gray-500" />
            <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">Quant Sweet Spot</span>
          </div>
          <ArrowRight className="w-3 h-3 text-gray-700 group-hover:text-gray-400 transition-colors" />
        </div>
        {rec ? (
          <>
            <div className="flex items-baseline gap-2 mb-1.5">
              <span className={`text-lg font-bold ${RECOMMENDATION_TONE[rec.kind]}`}>
                {RECOMMENDATION_LABEL[rec.kind]}
              </span>
              {rec.targetFamily && (
                <span className="text-[10px] text-gray-500 font-mono ml-auto">
                  {rec.currentFamily} → {rec.targetFamily}
                </span>
              )}
            </div>
            <p className="text-[11px] text-gray-400 line-clamp-2">{rec.headline}</p>
            {rec.estimatedTps != null && rec.currentTps != null && (
              <p className="text-[10px] text-gray-600 mt-1.5 font-mono">
                ~{rec.estimatedTps.toFixed(0)} tok/s
                {rec.estimatedTps > rec.currentTps
                  ? ` (+${((rec.estimatedTps / rec.currentTps - 1) * 100).toFixed(0)}%)`
                  : ` (${((rec.estimatedTps / rec.currentTps - 1) * 100).toFixed(0)}%)`}
              </p>
            )}
            {rec.estimatedTps == null && rec.vramDeltaGb != null && (
              <p className="text-[10px] text-gray-600 mt-1.5 font-mono">
                {rec.vramDeltaGb > 0 ? '+' : ''}{rec.vramDeltaGb.toFixed(1)} GB
                {rec.targetFits === false ? ' · won\'t fit' : ''}
              </p>
            )}
            {rec.estimatedTps == null && rec.vramDeltaGb == null && (
              <p className="text-[10px] text-gray-600 mt-1.5 font-mono">{rec.currentQuality}</p>
            )}
          </>
        ) : (
          <>
            <p className="text-sm font-bold text-gray-500 mb-1">Unknown quant</p>
            <p className="text-[11px] text-gray-600 line-clamp-2">
              Cannot determine quant from model name. Quant Sweet Spot is unavailable.
            </p>
          </>
        )}
      </a>

      {/* ── Tile 3 — Context Runway ───────────────────────────────────────── */}
      <a
        href={`#${anchorId}`}
        onClick={scrollToFullAnalysis}
        className="group bg-gray-800 border border-gray-700 hover:border-gray-600 rounded-2xl p-4 transition-colors block"
      >
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-gray-500" />
            <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">Context Runway</span>
          </div>
          <ArrowRight className="w-3 h-3 text-gray-700 group-hover:text-gray-400 transition-colors" />
        </div>
        {runway ? (
          <>
            <div className="flex items-baseline gap-2 mb-1.5">
              <span className={`text-lg font-bold ${runway.maxFitsCtx ? 'text-emerald-400' : 'text-red-400'}`}>
                {runway.maxFitsCtx ? `${fmtCtx(runway.maxFitsCtx)} fits` : 'Tight'}
              </span>
              <span className="text-[10px] text-gray-500 font-mono ml-auto">
                {runway.arch.isExact ? 'GQA-aware' : '~est'}
              </span>
            </div>
            <p className="text-[11px] text-gray-400 line-clamp-2">{runway.summary}</p>
            <p className="text-[10px] text-gray-600 mt-1.5 font-mono">
              {runway.arch.layers}L · {runway.arch.kvHeads} KV heads · h={runway.arch.headDim}
            </p>
          </>
        ) : (
          <>
            <p className="text-sm font-bold text-gray-500 mb-1">Awaiting architecture</p>
            <p className="text-[11px] text-gray-600 line-clamp-2">
              Layer / head metadata not yet captured. Context runway estimate pending.
            </p>
          </>
        )}
      </a>
    </div>
  );
};

export default ModelFitSummaryStrip;
