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

import React, { useState, useRef, useEffect } from 'react';
import { Cpu, Gauge, Layers, ArrowRight, Server } from 'lucide-react';
import type { SentinelMetrics } from '../../types';
import { computeModelFitScore } from '../../utils/modelFit';
import { computeQuantRecommendation } from '../../utils/quantSweet';
import { computeContextRunway, fmtCtx, fmtKvSize } from '../../utils/kvCache';
import { lookupPerplexity, QUALITY_BAND_LABEL, QUALITY_BAND_TONE } from '../../utils/perplexity';
import { FLEET_ROW_ROLLING_WINDOW } from '../../hooks/useRollingMetrics';

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
  /** Default node — always shown when no picker selection is active. */
  node: SentinelMetrics;
  /**
   * Optional fleet roster.  When provided AND more than one node has a model
   * loaded, the strip renders a node-picker chip row above the tiles so the
   * fleet operator can switch which node the strip summarises.  Without this,
   * the strip silently summarises the default `node` only.
   */
  nodes?: SentinelMetrics[];
  /**
   * Optional resolver for the user-set per-node label (Pro feature). Same
   * shape as the `getNodeSettings` prop on Overview / TracesView — when
   * provided, the strip uses `locationLabel || hostname || node_id` so node
   * names match the rest of the page (KPI hero, Best Route, Cost tiles).
   */
  getNodeSettings?: (nodeId: string) => { locationLabel?: string | null } | undefined;
  /**
   * Click handler invoked when the user activates any tile.  Wired by
   * Overview to `onNavigateToInsights('performance', 'model-fit-analysis')`,
   * cross-tabbing to the full ModelFitAnalysis section in Insights where
   * it lives alongside the other deep-dive tools.  When undefined the
   * tiles still render but are not interactive.
   */
  onNavigate?: () => void;
}

/** Resolve a node's display label using the same chain as other Overview tiles. */
function nodeLabelFor(
  n: SentinelMetrics,
  getNodeSettings?: Props['getNodeSettings'],
): string {
  return (
    getNodeSettings?.(n.node_id)?.locationLabel
    ?? (n.hostname && n.hostname !== n.node_id ? n.hostname : null)
    ?? n.node_id
  );
}

const hasLoadedModel = (n: SentinelMetrics): boolean =>
  !!(n.ollama_active_model || n.vllm_model_name || n.llamacpp_model_name);

const ModelFitSummaryStrip: React.FC<Props> = ({
  node: defaultNode,
  nodes,
  getNodeSettings,
  onNavigate,
}) => {
  // Eligible-for-picker nodes: those with a loaded model.
  const candidateNodes = (nodes ?? []).filter(hasLoadedModel);
  const showPicker = candidateNodes.length > 1;

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const node = selectedNodeId
    ? (candidateNodes.find(n => n.node_id === selectedNodeId) ?? defaultNode)
    : defaultNode;

  // ── Per-node rolling buffer (mirror ModelFitAnalysis + Fleet Status row) ──
  // Without this, the Sweet Spot tile's "estimated tok/s after upgrade"
  // would scale off a noisy single-sample reading rather than the smoothed
  // value users see elsewhere on the page.
  const tpsBuffersRef = useRef<Record<string, number[]>>({});
  // Drop buffers for nodes that have left the candidate roster — prevents
  // unbounded growth on fleets where nodes churn.
  useEffect(() => {
    const live = new Set([defaultNode.node_id, ...(nodes ?? []).map(n => n.node_id)]);
    for (const k of Object.keys(tpsBuffersRef.current)) {
      if (!live.has(k)) delete tpsBuffersRef.current[k];
    }
  }, [defaultNode.node_id, nodes]);

  function smoothedCombinedTps(n: SentinelMetrics): number | null {
    const o = n.ollama_tokens_per_second ?? null;
    const v = n.vllm_tokens_per_sec      ?? null;
    const raw = (o != null && v != null) ? o + v : (o ?? v);
    const buf = tpsBuffersRef.current[n.node_id] ?? (tpsBuffersRef.current[n.node_id] = []);
    if (raw != null && isFinite(raw)) {
      buf.push(raw);
      if (buf.length > FLEET_ROW_ROLLING_WINDOW) buf.shift();
    }
    return buf.length > 0 ? buf.reduce((a, c) => a + c, 0) / buf.length : null;
  }

  const fit = computeModelFitScore(node);
  if (!fit) return null;

  const observedTps = smoothedCombinedTps(node);
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

  const hostLabel = nodeLabelFor(node, getNodeSettings);
  const chipLabel = node.chip_name ?? node.gpu_name ?? null;

  // Tile-click handler — wired to the Insights deep-link callback when
  // provided.  When `onNavigate` is undefined the tiles render as
  // non-interactive divs (no onClick, no hover-cursor) so the user
  // never sees a button shape that does nothing.
  const handleTileClick = onNavigate
    ? (e: React.MouseEvent) => { e.preventDefault(); onNavigate(); }
    : undefined;

  return (
    <div className="space-y-2">
      {/* Node attribution — always visible so the strip is unambiguous. */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
          <Server className="w-3 h-3 text-gray-600" />
          <span className="uppercase tracking-widest text-gray-600">Showing</span>
          <span className="font-mono text-gray-300">{hostLabel}</span>
          {chipLabel && <span className="text-gray-600">· {chipLabel}</span>}
          {showPicker && (
            <span className="text-gray-600">
              · {candidateNodes.findIndex(n => n.node_id === node.node_id) + 1} of {candidateNodes.length}
            </span>
          )}
        </div>
      </div>

      {/* Node picker chip row — only when fleet has multiple model-loaded nodes. */}
      {showPicker && (
        <div className="flex flex-wrap gap-1">
          {candidateNodes.map(n => {
            const isSelected = n.node_id === node.node_id;
            const nLabel = nodeLabelFor(n, getNodeSettings);
            return (
              <button
                key={n.node_id}
                onClick={() => setSelectedNodeId(
                  n.node_id === defaultNode.node_id && !selectedNodeId ? null : n.node_id
                )}
                className={`text-[9px] font-mono px-2 py-0.5 rounded-full border transition-colors ${
                  isSelected
                    ? 'bg-gray-700 border-gray-600 text-gray-200'
                    : 'bg-transparent border-gray-700 text-gray-600 hover:text-gray-400 hover:border-gray-600'
                }`}
              >
                {nLabel}
              </button>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {/* ── Tile 1 — Model Fit ───────────────────────────────────────────── */}
      <button type="button" disabled={!onNavigate}
        
        onClick={handleTileClick}
        className={`group bg-gray-800 border ${FIT_BORDER[fit.score]} rounded-2xl p-4 transition-colors block text-left w-full disabled:cursor-default cursor-pointer`}
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
      </button>

      {/* ── Tile 2 — Quant Sweet Spot ─────────────────────────────────────── */}
      <button type="button" disabled={!onNavigate}
        
        onClick={handleTileClick}
        className="group bg-gray-800 border border-gray-700 hover:border-gray-600 rounded-2xl p-4 transition-colors block text-left w-full disabled:cursor-default cursor-pointer"
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
            <p className="text-[10px] text-gray-600 truncate -mt-0.5 mb-1" title={modelName}>{modelName}</p>
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

            {/* Perplexity Tax footer — empirical quality cost of the
                CURRENT quant on this model family. Shown alongside the
                speed/headroom delta so users see all three dimensions
                (speed, memory, quality) at a glance. */}
            {(() => {
              const cost = lookupPerplexity(modelName, node.ollama_quantization);
              if (!cost) return null;
              const ppl = cost.pplDeltaPct === 0
                ? 'lossless'
                : cost.pplDeltaPct < 0.1
                ? '<0.1% PPL'
                : `+${cost.pplDeltaPct.toFixed(cost.pplDeltaPct < 1 ? 2 : 1)}% PPL`;
              return (
                <p className="text-[10px] mt-1 font-mono">
                  <span className="text-gray-600">Quality: </span>
                  <span className={QUALITY_BAND_TONE[cost.band]}>{QUALITY_BAND_LABEL[cost.band]}</span>
                  <span className="text-gray-600"> · {ppl}</span>
                </p>
              );
            })()}
          </>
        ) : (
          <>
            <p className="text-sm font-bold text-gray-500 mb-1">Unknown quant</p>
            <p className="text-[11px] text-gray-600 line-clamp-2">
              Cannot determine quant from model name. Quant Sweet Spot is unavailable.
            </p>
          </>
        )}
      </button>

      {/* ── Tile 3 — Context Runway ───────────────────────────────────────── */}
      <button type="button" disabled={!onNavigate}
        
        onClick={handleTileClick}
        className="group bg-gray-800 border border-gray-700 hover:border-gray-600 rounded-2xl p-4 transition-colors block text-left w-full disabled:cursor-default cursor-pointer"
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
            <p className="text-[10px] text-gray-600 truncate -mt-0.5 mb-1" title={modelName}>{modelName}</p>
            <p className="text-[11px] text-gray-400 line-clamp-2">{runway.summary}</p>
            <p className="text-[10px] text-gray-600 mt-1.5 font-mono">
              {runway.arch.layers}L · {runway.arch.kvHeads} KV heads · h={runway.arch.headDim}
            </p>
          </>
        ) : (
          <>
            <p className="text-sm font-bold text-gray-500 mb-1">Awaiting architecture</p>
            <p className="text-[11px] text-gray-600 line-clamp-2">
              No layer/head metadata and no parameter-count tag in the model name. Ollama auto-populates this on model load; for vLLM, ensure the model name carries a "<code className="text-gray-500">7b</code>"-style size tag.
            </p>
          </>
        )}
      </button>
      </div>
    </div>
  );
};

export default ModelFitSummaryStrip;
