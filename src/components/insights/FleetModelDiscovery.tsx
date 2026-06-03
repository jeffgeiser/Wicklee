/**
 * FleetModelDiscovery — cloud fleet model discovery panel.
 *
 * Fetches GGUF models from HuggingFace via /api/fleet/model-candidates,
 * which scores each model against every online fleet node's hardware profile.
 *
 * For each model the user can see:
 *   - Which nodes can run it and at what quality (Excellent/Good/Tight/Marginal/Won't Fit)
 *   - The best-fit quantization variant per node
 *   - The Ollama pull command, ready to copy
 *
 * Node filter: selecting a specific node re-sorts and filters results to show
 * what fits that machine, with a per-node pull command highlighted.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Search, Package, ExternalLink, Copy, Check, ChevronDown, ChevronRight, Server, Loader2, AlertCircle } from 'lucide-react';
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
import { useSettings } from '../../hooks/useSettings';
import DiscoveryHoverCard, { type DiscoveryHoverRow } from './DiscoveryHoverCard';

// ── Projection-tier helpers (mirror of ModelDiscoveryCard helpers) ────────
function projConfidenceLabel(c: TpsProjection['confidence']): string {
  switch (c) {
    case 'cohort':      return 'measured';
    case 'sample':      return 'measured (1 sample)';
    case 'bandwidth':   return 'scaled estimate';
    case 'theoretical': return 'spec estimate';
  }
}
function projConfidenceBody(p: TpsProjection): string {
  switch (p.confidence) {
    case 'cohort':
      return `Average across ${p.count} similar-size models that have actually run on this fleet. Highest fidelity.`;
    case 'sample':
      return `Single similar-size measurement on this fleet, shown as a point estimate ±10%.`;
    case 'bandwidth':
      return `Scaled from your fleet's measured throughput on a different-size model. Inference is memory-bandwidth-bound: tok/s ∝ 1/size.`;
    case 'theoretical':
      return `Estimated from this node's chip memory bandwidth and the model's file size. No telemetry needed — refines once a model runs.`;
  }
}
function projConfidenceRows(p: TpsProjection): DiscoveryHoverRow[] {
  return [
    { label: 'Range',  value: `${p.min} – ${p.max} tok/s` },
    { label: 'Source', value: projConfidenceLabel(p.confidence), accent: p.confidence === 'theoretical' ? 'amber' : 'cyan' },
    ...(p.count > 0 ? [{ label: 'Samples', value: `${p.count}` } as DiscoveryHoverRow] : []),
  ];
}

/** Sort modes for the Discovery results list. Default = 'fit' (current behavior). */
type SortMode = 'fit' | 'popularity' | 'speed' | 'cost' | 'size_asc' | 'size_desc';

interface NodeFit {
  node_id:      string;
  hostname:     string | null;
  mem_budget_gb: number;
  thermal:      string;
  /** Apple/NVIDIA chip identifier (e.g. "Apple M4 Pro", "NVIDIA RTX 4090").
   *  Enables the theoretical tok/s fallback via chipBandwidth.ts when the
   *  fleet has no telemetry for this candidate's size class yet. Optional
   *  to remain backward-compatible with older agents that pre-date this
   *  field. */
  chip_name?:   string | null;
  fit_score:    number;
  fit_label:    string;
  best_quant:   string;
  file_size_mb: number;
  pull_cmd:     string;
}

interface FleetModel {
  model_id:          string;
  downloads:         number;
  /** HuggingFace likes — current bookmark interest (complements downloads). */
  likes?:            number;
  fleet_best_score:  number;
  nodes:             NodeFit[];
}

interface FleetDiscoveryResponse {
  is_live_search: boolean;
  online_nodes:   number;
  hf_reachable:   boolean;
  models:         FleetModel[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fitColors(score: number) {
  if (score >= 80) return { dot: 'bg-emerald-500', badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20', bar: 'bg-emerald-500' };
  if (score >= 60) return { dot: 'bg-green-500',   badge: 'bg-green-500/15 text-green-400 border-green-500/20',       bar: 'bg-green-500' };
  if (score >= 40) return { dot: 'bg-yellow-500',  badge: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/20',    bar: 'bg-yellow-500' };
  if (score > 0)   return { dot: 'bg-orange-500',  badge: 'bg-orange-500/15 text-orange-400 border-orange-500/20',    bar: 'bg-orange-500' };
  return             { dot: 'bg-red-900',    badge: 'bg-red-900/20 text-red-500 border-red-900/30',           bar: 'bg-red-900' };
}

function fmtDl(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`;
  return `${n}`;
}

function shortName(model_id: string): string {
  return model_id.split('/').pop() ?? model_id;
}

function uploaderName(model_id: string): string | null {
  const parts = model_id.split('/');
  return parts.length > 1 ? parts[0] : null;
}

/** Word label for a fit score, used in the line-2 "Excellent fit on 3 nodes". */
function fitGradeLabel(score: number): string {
  if (score >= 80) return 'Excellent';
  if (score >= 60) return 'Good';
  if (score >= 40) return 'Tight';
  if (score > 0)   return 'Marginal';
  return "Won't Fit";
}

// ── Copy button ───────────────────────────────────────────────────────────────

const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);
  const handle = () => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <button onClick={handle} title="Copy" className="p-1 rounded hover:bg-gray-700/60 transition-colors">
      {copied
        ? <Check className="w-3 h-3 text-emerald-400" />
        : <Copy className="w-3 h-3 text-gray-500 hover:text-gray-300" />}
    </button>
  );
};

/**
 * Per-row inline copy button. Used on line 1 of the summary row — must
 * not propagate the click to the row's expand toggle. Renders as a
 * compact button with icon + "Copy" label that flips to "Copied!" for
 * 1.5 s on success.
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

/**
 * Visual fit-bars — one colored bar per node in the fleet, color-coded
 * by that node's fit score. Width is uniform so the strip is a quick
 * at-a-glance fleet compatibility heatmap.
 */
const FitBars: React.FC<{ nodes: NodeFit[]; getScore: (n: NodeFit) => number }> = ({ nodes, getScore }) => (
  <span className="inline-flex items-center gap-0.5">
    {nodes.map(n => {
      const c = fitColors(getScore(n));
      return (
        <span
          key={n.node_id}
          title={`${n.hostname ?? n.node_id}: ${fitGradeLabel(getScore(n))}`}
          className={`inline-block w-1.5 h-3 rounded-sm ${c.bar}`}
        />
      );
    })}
  </span>
);

// ── Fleet model row ───────────────────────────────────────────────────────────

const FleetModelRow: React.FC<{
  model:          FleetModel;
  getToken:       () => Promise<string | null>;
  focusNodeId:    string | null;
  history:        ComparisonRow[] | null;
  /** True when ANY row in the visible set has projections — drives whether the
   * speed/cost grid column appears at all. With no fleet-wide history yet
   * (typical for fresh installs or post-schema-migration), the column would
   * just render em-dash for every row. Hiding it lets identity/fit/popularity
   * use the freed width and the page-level "Run a few models" callout speaks
   * for the missing projections instead. */
  hasFleetHistory: boolean;
  contextLength:  number;
  kwhRate:        number;
  /** Phase 3: show the cost-per-M column only when the user has actually
   *  configured their power rate in Settings. Tok/s is unconditional now
   *  (theoretical fallback covers the no-history case). */
  showCost:       boolean;
}> = ({ model, focusNodeId, history, hasFleetHistory, contextLength, kwhRate, showCost }) => {
  const [open, setOpen] = useState(false);
  // Max file size across all nodes' best-quant variants — proxy for model class.
  const maxFileSizeMb = model.nodes.reduce((m, n) => Math.max(m, n.file_size_mb), 0);
  const recQuant = recommendedQuant(maxFileSizeMb);
  const hasRecQuant = model.nodes.some(n => n.best_quant?.toUpperCase() === recQuant.toUpperCase());
  const paramsB = parseParameterCountB(model.model_id) ?? 7;
  const isDefaultCtx = contextLength === DEFAULT_CONTEXT_LENGTH;
  const avgWatts = (() => {
    if (!history || !history.length) return null;
    const w = history.filter(r => r.avg_watts != null && r.avg_watts > 0);
    if (!w.length) return null;
    return w.reduce((s, r) => s + (r.avg_watts as number), 0) / w.length;
  })();

  // When a node is focused, score and sort from that node's perspective.
  const focusedNode = focusNodeId
    ? model.nodes.find(n => n.node_id === focusNodeId) ?? null
    : null;

  // Recompute each node's fit score at the chosen context length. The
  // backend's fit_score uses a default context — once the user picks 32K
  // or 128K, those server-computed scores drift. Recompute client-side
  // so per-row counts and fit labels actually move with the picker.
  const nodeScoresAtCtx = useMemo<Map<string, { score: number; label: string }>>(() => {
    const map = new Map<string, { score: number; label: string }>();
    for (const n of model.nodes) {
      if (isDefaultCtx) {
        // At default context, trust the backend's already-computed score
        // (avoids subtle drift from differing overhead constants).
        map.set(n.node_id, { score: n.fit_score, label: n.fit_label });
      } else {
        const vramReq = vramAtContext(n.file_size_mb, paramsB, contextLength);
        const fit = fitLabelAtContext(vramReq, n.mem_budget_gb * 1024);
        map.set(n.node_id, { score: fit.score, label: fit.label });
      }
    }
    return map;
  }, [model.nodes, isDefaultCtx, contextLength, paramsB]);

  const effectiveScore = focusedNode
    ? (nodeScoresAtCtx.get(focusedNode.node_id)?.score ?? focusedNode.fit_score)
    : Math.max(...Array.from(nodeScoresAtCtx.values()).map((v: { score: number; label: string }) => v.score), 0);
  const best = fitColors(effectiveScore);

  // When a node is focused, report fit status for just that node; otherwise fleet-wide count.
  const fittingNodes = focusNodeId
    ? model.nodes.filter(n => n.node_id === focusNodeId && (nodeScoresAtCtx.get(n.node_id)?.score ?? 0) >= 40)
    : model.nodes.filter(n => (nodeScoresAtCtx.get(n.node_id)?.score ?? 0) >= 40);
  const fitSummary = focusNodeId
    ? (fittingNodes.length > 0 ? 'fits this node' : "won't fit")
    : `${fittingNodes.length}/${model.nodes.length} nodes fit`;

  // Best node for the pull command — focused node first, then highest scorer.
  const pullNode = focusedNode ?? model.nodes[0];

  // Find the recommended-quant file size from any node that selected it.
  // Falls back to the smallest variant across nodes when none have rec.
  const recQuantFileSizeMb = (() => {
    const recNode = model.nodes.find(n => n.best_quant?.toUpperCase() === recQuant.toUpperCase());
    if (recNode) return recNode.file_size_mb;
    if (!model.nodes.length) return 0;
    return Math.min(...model.nodes.map(n => n.file_size_mb));
  })();
  const recQuantToShow = (() => {
    const recNode = model.nodes.find(n => n.best_quant?.toUpperCase() === recQuant.toUpperCase());
    return recNode ? recNode.best_quant : (pullNode?.best_quant ?? recQuant);
  })();

  // Speed + cost projections — use the best-fitting node's variant.
  // Pass the node's chip so projectTpsForVariant can fall back to the
  // theoretical (spec-derived) bandwidth estimate when no telemetry exists
  // yet for this size class — same Phase 3 behavior the localhost panel
  // already has.
  const projForRow = pullNode
    ? projectTpsForVariant(history ?? [], pullNode.file_size_mb, pullNode.best_quant, pullNode.chip_name ?? null)
    : null;
  let costPerMRow: number | null = null;
  if (projForRow && avgWatts != null) {
    const tpsAvg = (projForRow.min + projForRow.max) / 2;
    if (tpsAvg > 0) {
      costPerMRow = (avgWatts / 1000) * (1_000_000 / tpsAvg / 3600) * kwhRate;
    }
  }

  const uploader = uploaderName(model.model_id);
  const bestPullCmd = pullNode?.pull_cmd ?? '';

  return (
    <div className="border border-gray-700/60 rounded-xl overflow-hidden">
      {/* Single-line grid summary — each column has a fixed proportion so the
          identity / quant / fit / projection / popularity / action columns
          line up vertically across every row. Truncation + title hover
          handles long model names without column shift.

          Responsive: at narrow widths popularity hides first (lowest decision
          value), then projection, then quant. Identity + fit + action always
          visible. */}
      <button
        onClick={() => setOpen(v => !v)}
        className={[
          'w-full grid gap-2 items-center px-3 py-2 hover:bg-gray-700/20 transition-colors text-left',
          // Grid template adapts to whether projections are available
          // fleet-wide. Without history, the speed/cost column would just be
          // em-dash for every row — so we drop it and let identity/fit/
          // popularity use the freed width.
          //
          // Tuned to give identity ~47% of the row when all columns visible
          // (was ~33%) — long model names like Gemma-3-1B-it-GLM-4.7-Flash-
          // Heretic-Uncensored-Thinking truncated too aggressively before.
          // Right-side columns tightened up so fit/speed/popularity/actions
          // group visually together rather than spreading across the row.
          hasFleetHistory
            ? 'grid-cols-[minmax(0,3fr)_minmax(0,1.1fr)_auto] lg:grid-cols-[minmax(0,3fr)_minmax(0,0.9fr)_minmax(0,1.1fr)_minmax(0,0.9fr)_auto] xl:grid-cols-[minmax(0,3fr)_minmax(0,0.9fr)_minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,0.5fr)_auto]'
            : 'grid-cols-[minmax(0,3fr)_minmax(0,1.1fr)_auto] lg:grid-cols-[minmax(0,3.4fr)_minmax(0,0.9fr)_minmax(0,1.3fr)_minmax(0,0.5fr)_auto] xl:grid-cols-[minmax(0,3.4fr)_minmax(0,0.9fr)_minmax(0,1.3fr)_minmax(0,0.5fr)_auto]',
        ].join(' ')}
      >
        {/* Col 1 — identity (dot + stacked name/uploader) */}
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-2 h-2 rounded-full ${best.dot} shrink-0`} />
          <div className="min-w-0 flex-1">
            <div
              className="text-xs text-gray-200 font-mono truncate"
              title={shortName(model.model_id)}
            >
              {shortName(model.model_id)}
            </div>
            {uploader && (
              <div className="text-[10px] text-gray-600 truncate" title={uploader}>
                {uploader}
              </div>
            )}
          </div>
        </div>

        {/* Col 2 — recommended quant + size (hidden on small screens) */}
        <div
          className="text-[10px] font-mono tabular-nums hidden md:block min-w-0"
          title={quantQualityHint(recQuantToShow)}
        >
          {recQuantFileSizeMb > 0 ? (
            <>
              <span className="text-gray-300">{recQuantToShow}</span>
              <span className="text-gray-600"> · {(recQuantFileSizeMb / 1024).toFixed(1)} GB</span>
            </>
          ) : (
            <span className="text-gray-700">—</span>
          )}
        </div>

        {/* Col 3 — fit bars + label + count */}
        <div
          className="flex items-center gap-1.5 text-[10px] min-w-0"
          title={focusNodeId
            ? `Fit on ${focusedNode?.hostname ?? focusNodeId}`
            : `Highest fit grade across ${model.nodes.length} fleet node${model.nodes.length === 1 ? '' : 's'}`}
        >
          <FitBars
            nodes={model.nodes}
            getScore={n => nodeScoresAtCtx.get(n.node_id)?.score ?? n.fit_score}
          />
          <span className={`${best.badge.split(' ').find(c => c.startsWith('text-')) ?? 'text-gray-400'} truncate`}>
            {fitGradeLabel(effectiveScore)}
          </span>
          <span className="text-gray-600 tabular-nums whitespace-nowrap">
            {focusNodeId
              ? fitSummary
              : `${fittingNodes.length}/${model.nodes.length}`}
          </span>
        </div>

        {/* Col 4 — speed + (optional) cost projections.
            Phase 3 contract: tok/s always renders when we can derive any number
            (telemetry-measured first, theoretical bandwidth fallback last);
            cost-per-M only renders when the user has set their $/kWh in
            Settings. The hasFleetHistory grid-omission is preserved for the
            edge case where the projection is genuinely null (chip not in the
            bandwidth lookup AND no history). */}
        {(hasFleetHistory || projForRow) && (
          <div className="text-[10px] tabular-nums hidden lg:flex items-center gap-2 min-w-0">
            {projForRow ? (
              <DiscoveryHoverCard
                heading={`≈${((projForRow.min + projForRow.max) / 2).toFixed(0)} tok/s · ${projConfidenceLabel(projForRow.confidence)}`}
                body={projConfidenceBody(projForRow)}
                rows={projConfidenceRows(projForRow)}
              >
                <span className={projForRow.confidence === 'theoretical' ? 'text-gray-500 italic' : 'text-gray-400'}>
                  ≈{((projForRow.min + projForRow.max) / 2).toFixed(0)} t/s
                </span>
              </DiscoveryHoverCard>
            ) : null}
            {showCost && costPerMRow != null ? (
              <DiscoveryHoverCard
                heading="Cost per million tokens"
                body="Estimated electricity cost to generate 1M tokens at this row's projected tok/s and the fleet's average power draw."
                rows={[
                  { label: 'Power rate', value: `$${kwhRate.toFixed(3)}/kWh` },
                  { label: 'Avg watts',  value: avgWatts != null ? `${avgWatts.toFixed(0)} W (measured)` : '—' },
                  { label: 'Formula',    value: 'watts × $/kWh ÷ (tok/s × 3600) × 1M' },
                ]}
              >
                <span className="text-gray-500">
                  ${costPerMRow < 0.01 ? costPerMRow.toFixed(4) : costPerMRow.toFixed(3)}/M
                </span>
              </DiscoveryHoverCard>
            ) : null}
            {!projForRow && costPerMRow == null && (
              <span
                className="text-gray-700"
                title="Projection unavailable for this row (no telemetry and chip not in our bandwidth lookup)."
              >
                —
              </span>
            )}
          </div>
        )}

        {/* Col 5 — popularity (hidden on < xl, lowest decision value) */}
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
          {bestPullCmd && (effectiveScore >= 40) && (
            <RowCopyButton
              text={bestPullCmd}
              title={`Copy pull command for ${recQuantToShow} on ${pullNode?.hostname ?? pullNode?.node_id ?? 'best-fitting node'}`}
            />
          )}
          {open
            ? <ChevronDown className="w-3 h-3 text-gray-600" />
            : <ChevronRight className="w-3 h-3 text-gray-600" />}
        </div>
      </button>

      {/* Expanded: per-node breakdown */}
      {open && (
        <div className="px-3 pb-3 border-t border-gray-700/40 space-y-3 pt-3">
          {/* HF link */}
          <a
            href={`https://huggingface.co/${model.model_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-[10px] text-cyan-500 hover:text-cyan-400 transition-colors"
          >
            <ExternalLink className="w-2.5 h-2.5" />
            {model.model_id}
          </a>

          {/* Per-node table */}
          <div className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">
            Per-node fit
          </div>
          <div className="space-y-0">
            {model.nodes.map(node => {
              // Per-node recomputation at chosen context.
              let vramMb = node.file_size_mb; // not used directly when default
              let displayLabel = node.fit_label;
              let displayScore = node.fit_score;
              if (!isDefaultCtx) {
                const budgetMb = node.mem_budget_gb * 1024;
                vramMb = vramAtContext(node.file_size_mb, paramsB, contextLength);
                const fit = fitLabelAtContext(vramMb, budgetMb);
                displayLabel = fit.label;
                displayScore = fit.score;
              }
              const nc = fitColors(displayScore);
              const displayName = node.hostname ?? node.node_id;
              const isFocused = focusNodeId === node.node_id;
              const isRecommended = hasRecQuant && node.best_quant?.toUpperCase() === recQuant.toUpperCase();
              const proj = projectTpsForVariant(history ?? [], node.file_size_mb, node.best_quant, node.chip_name ?? null);
              let costPerM: number | null = null;
              if (proj && avgWatts != null) {
                const tpsAvg = (proj.min + proj.max) / 2;
                if (tpsAvg > 0) {
                  costPerM = (avgWatts / 1000) * (1_000_000 / tpsAvg / 3600) * kwhRate;
                }
              }
              return (
                <div
                  key={node.node_id}
                  className={`flex items-center gap-2 py-2 border-t border-gray-700/20 first:border-t-0 transition-opacity ${focusNodeId && !isFocused ? 'opacity-40' : ''}`}
                >
                  <Server className="w-3 h-3 text-gray-600 shrink-0" />
                  <span className={`text-[11px] w-24 shrink-0 truncate ${isFocused ? 'text-gray-200 font-semibold' : 'text-gray-400'}`} title={displayName}>
                    {displayName}
                  </span>
                  <span className={`text-[10px] font-medium px-1.5 py-px rounded border ${nc.badge} shrink-0`}>
                    {displayLabel}
                  </span>
                  <span
                    className="text-[10px] text-gray-500 font-mono shrink-0 cursor-help"
                    title={quantQualityHint(node.best_quant)}
                  >
                    {node.best_quant}
                  </span>
                  {isRecommended && (
                    <span
                      title="Recommended quant for this size class — typical sweet spot of quality vs. file size."
                      className="text-[9px] font-semibold px-1.5 py-px rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 shrink-0 cursor-default uppercase tracking-wider"
                    >
                      Rec
                    </span>
                  )}
                  <span
                    className="text-[10px] text-gray-600 shrink-0"
                    title={isDefaultCtx ? undefined : `VRAM at ${contextLengthLabel(contextLength)} ctx: ${(vramMb / 1024).toFixed(2)} GB (model + KV cache + overhead)`}
                  >
                    {isDefaultCtx
                      ? `${(node.file_size_mb / 1024).toFixed(1)} GB`
                      : `${(vramMb / 1024).toFixed(1)} GB @ ${contextLengthLabel(contextLength)}`}
                  </span>
                  <span className="text-[10px] text-gray-700 shrink-0 hidden md:inline">
                    {node.mem_budget_gb} GB pool
                  </span>
                  {proj && (
                    <span
                      className="text-[10px] text-gray-500 shrink-0 hidden md:inline"
                      title={`Projected from ${proj.count} similar-size model${proj.count === 1 ? '' : 's'} from fleet history (last 7 days).`}
                    >
                      ≈ {proj.min.toFixed(0)}-{proj.max.toFixed(0)} tok/s
                    </span>
                  )}
                  {costPerM != null && (
                    <span
                      className="text-[10px] text-gray-600 shrink-0 hidden md:inline"
                      title={`Estimated electricity cost at ${kwhRate.toFixed(3)} $/kWh, using projected tok/s and ${avgWatts!.toFixed(0)} W avg from fleet telemetry.`}
                    >
                      ≈ ${costPerM < 0.01 ? costPerM.toFixed(4) : costPerM.toFixed(3)} / M
                    </span>
                  )}
                  {/* Pull command inline */}
                  {node.pull_cmd && node.fit_score >= 40 && (
                    <div className="flex items-center gap-1 ml-auto">
                      <code className="text-[10px] text-cyan-400/70 font-mono truncate max-w-[200px] hidden lg:inline">
                        {node.pull_cmd}
                      </code>
                      <CopyButton text={node.pull_cmd} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Pull command — focused node or best node */}
          {pullNode && pullNode.pull_cmd && pullNode.fit_score >= 40 && (
            <div className="space-y-1 pt-1">
              <div className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">
                {focusedNode ? `${focusedNode.hostname ?? focusedNode.node_id}` : 'Best node'} · {pullNode.hostname ?? pullNode.node_id} · {pullNode.best_quant}
              </div>
              <div className="flex items-center gap-1.5 bg-gray-900/60 border border-gray-700/60 rounded-lg px-2.5 py-1.5">
                <code className="text-[11px] text-cyan-300 font-mono flex-1 truncate">
                  {pullNode.pull_cmd}
                </code>
                <CopyButton text={pullNode.pull_cmd} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  getToken: () => Promise<string | null>;
}

const FleetModelDiscovery: React.FC<Props> = ({ getToken }) => {
  const [pendingSearch, setPending]   = useState('');
  const [data, setData]               = useState<FleetDiscoveryResponse | null>(null);
  // Cache of the "all nodes" baseline so switching back doesn't re-fetch.
  const baseDataRef                   = useRef<FleetDiscoveryResponse | null>(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [focusNodeId, setFocusNode]   = useState<string | null>(null);
  const debounceRef                   = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable list of online nodes (from most recent all-nodes response).
  const [onlineNodes, setOnlineNodes] = useState<Pick<NodeFit, 'node_id' | 'hostname'>[]>([]);
  const history                       = useModelComparisonHistory(false, getToken);
  const [contextLength, setContextLength] = useState<number>(DEFAULT_CONTEXT_LENGTH);
  // "any" (default, broader) vs "all" (intersection — every node must fit).
  // The intersection view punishes heterogeneous fleets — adding a small
  // node shrinks the catalog. Default to "any" so the model list reflects
  // the largest box in the fleet, not the smallest.
  const [fitMode, setFitMode] = useState<'any' | 'all'>('any');
  // Phase 2: category + sort. 'All' shows everything; sort defaults to 'fit'.
  const [category, setCategory] = useState<ModelCategory | 'All'>('All');
  const [sortMode, setSortMode] = useState<SortMode>('fit');
  const { settings, isKwhRateConfigured } = useSettings();
  const kwhRate                        = settings.fleet.kwhRate || 0.16;
  const historyCount                   = history?.length ?? 0;

  const fetchModels = useCallback(async (query?: string, nodeId?: string | null) => {
    const token = await getToken();
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      // Pull a wide catalog so the client-side fit-mode filter and per-node
      // focus have enough candidates to work with. Backend caps at 200.
      const params = new URLSearchParams({ limit: '200' });
      if (query)  params.set('search', query);
      if (nodeId) params.set('node_id', nodeId);
      const resp = await fetch(`/api/fleet/model-candidates?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error(`${resp.status}`);
      const json: FleetDiscoveryResponse = await resp.json();
      setData(json);
      // Keep a stable node list from the all-nodes response (not per-node filtered).
      if (!nodeId) {
        const nodes = json.models[0]?.nodes ?? [];
        setOnlineNodes(nodes);
        baseDataRef.current = json;
      }
    } catch (e: any) {
      setError((e as Error).message ?? 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  // Load trending on mount — retry up to 5× with 600ms backoff.
  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    const tryFetch = async () => {
      if (cancelled) return;
      const token = await getToken();
      if (token) {
        fetchModels();
      } else if (attempt < 5) {
        attempt++;
        setTimeout(tryFetch, 600);
      }
    };
    tryFetch();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch when node focus changes — server ranks results for the selected node.
  useEffect(() => {
    if (focusNodeId === null) {
      // Restore cached baseline instead of re-fetching.
      if (baseDataRef.current) setData(baseDataRef.current);
      else fetchModels(pendingSearch || undefined, null);
    } else {
      fetchModels(pendingSearch || undefined, focusNodeId);
    }
  }, [focusNodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-retry when catalog is still loading (hf_reachable === false).
  useEffect(() => {
    if (!data || data.hf_reachable !== false || loading) return;
    const id = setTimeout(() => fetchModels(undefined, focusNodeId ?? undefined), 30_000);
    return () => clearTimeout(id);
  }, [data, loading, fetchModels, focusNodeId]);

  const handleChange = (val: string) => {
    setPending(val);
    setContextLength(DEFAULT_CONTEXT_LENGTH);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchModels(val || undefined, focusNodeId ?? undefined), 600);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    fetchModels(pendingSearch || undefined, focusNodeId ?? undefined);
  };

  // Apply fit-mode filter to the raw catalog. "Any" keeps models where at
  // least one node has score ≥40 (Tight or better). "All" requires every
  // node to score ≥40. Per-node focus bypasses the toggle — that view is
  // already implicitly single-node.
  //
  // Context-aware: at non-default context we recompute each node's score
  // using vramAtContext + fitLabelAtContext so the displayed SET actually
  // changes when the picker moves. The backend's n.fit_score uses a default
  // context and would otherwise lock the membership at default-context fit.
  // Pre-category filter: only fit-mode + context-aware membership. The
  // category filter is applied after so chip counts can reflect what's
  // *available* in the current fit view (not what's left after category).
  const fitFilteredModels = useMemo(() => {
    const all = data?.models ?? [];
    if (focusNodeId || onlineNodes.length <= 1) return all;
    const isDefault = contextLength === DEFAULT_CONTEXT_LENGTH;
    return all.filter(m => {
      const paramsB = parseParameterCountB(m.model_id) ?? 7;
      const scores = m.nodes.map(n => {
        if (isDefault) return n.fit_score;
        const vramReq = vramAtContext(n.file_size_mb, paramsB, contextLength);
        return fitLabelAtContext(vramReq, n.mem_budget_gb * 1024).score;
      });
      if (scores.length === 0) return false;
      return fitMode === 'all'
        ? scores.every(s => s >= 40)
        : scores.some(s => s >= 40);
    });
  }, [data, focusNodeId, onlineNodes.length, fitMode, contextLength]);

  // Per-category counts for the chip badges, evaluated against the
  // fit-filtered set. 'All' is the total — every model survives.
  const categoryCounts = useMemo<Record<ModelCategory | 'All', number>>(() => {
    const counts: Record<ModelCategory | 'All', number> = {
      All: fitFilteredModels.length,
      General: 0, Code: 0, Reasoning: 0, Vision: 0, Embedding: 0, Audio: 0,
    };
    for (const m of fitFilteredModels) {
      const c = inferCategory(m.model_id);
      counts[c]++;
    }
    return counts;
  }, [fitFilteredModels]);

  // Final displayed list: fit filter + category filter.
  const displayModels = useMemo(() => {
    if (category === 'All') return fitFilteredModels;
    return fitFilteredModels.filter(m => inferCategory(m.model_id) === category);
  }, [fitFilteredModels, category]);

  const focusNodeLabel = focusNodeId
    ? (onlineNodes.find(n => n.node_id === focusNodeId)?.hostname ?? focusNodeId)
    : null;

  // Count "good fit" models (score ≥60) for the current view, recomputed at
  // the chosen context length. The backend's fit_score uses a default context
  // (~8K-ish); once the user picks 32K or 128K, those scores drift. We
  // recompute per-node-per-model using the same vramAtContext helper as the
  // per-row fittingNodes calc — same source of truth, consistent badges.
  // Counts models that are a "good fit" (score ≥60) given the current view's
  // aggregation rule. Context-aware (recomputes scores at chosen context) and
  // fit-mode-aware (Any = at least one node ≥60 via Math.max, All = every node
  // ≥60 via Math.min). Single-node focus collapses both — scores has one entry.
  const fitCount = useMemo(() => {
    return displayModels.filter(m => {
      const paramsB = parseParameterCountB(m.model_id) ?? 7;
      const nodes = focusNodeId
        ? m.nodes.filter(n => n.node_id === focusNodeId)
        : m.nodes;
      const isDefault = contextLength === DEFAULT_CONTEXT_LENGTH;
      const scores = nodes.map(n => {
        if (isDefault) return n.fit_score;
        const vramReq = vramAtContext(n.file_size_mb, paramsB, contextLength);
        return fitLabelAtContext(vramReq, n.mem_budget_gb * 1024).score;
      });
      if (!scores.length) return false;
      // Single-node focus: only one score, min == max. Multi-node fleet view
      // respects the user's chosen aggregation: 'all' = intersection (worst
      // node must fit), 'any' = union (best node only needs to fit).
      const agg = focusNodeId || fitMode === 'any'
        ? Math.max(...scores)
        : Math.min(...scores);
      return agg >= 60;
    }).length;
  }, [displayModels, focusNodeId, contextLength, fitMode]);

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Package className="w-4 h-4 text-cyan-400" />
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
            Fleet Model Discovery
          </span>
          {data && !loading && (
            <span
              title={focusNodeId
                ? `Models where ${focusNodeLabel} scores ≥60 — VRAM headroom · thermal margin · power efficiency`
                : onlineNodes.length > 1
                  ? 'Models every online node can run — intersection of fleet VRAM budgets. Select a single node to see its full compatible catalog.'
                  : 'Models this node scores ≥60 — VRAM headroom (40 pts) · thermal margin (20 pts) · WES history (20 pts) · power efficiency (20 pts)'}
              className="text-[10px] text-cyan-400 bg-cyan-500/10 px-2 py-0.5 rounded-full border border-cyan-500/15 font-medium cursor-default"
            >
              {fitCount} fit {focusNodeLabel ?? 'your fleet'}
            </span>
          )}
        </div>
        {data && (
          <span className="text-[10px] text-gray-600">
            {data.online_nodes} node{data.online_nodes !== 1 ? 's' : ''} online
          </span>
        )}
      </div>

      {/* Unified view selector — replaces the prior split between a "Filter"
          pill row (node focus) and a separate "Show models that fit"
          fit-mode toggle. Those two controls were answering related-but-
          confusingly-redundant questions; this single row makes every option
          unambiguous and self-explanatory.

            [Any fleet node]   = focus null + fitMode 'any'   (default)
            [Every fleet node] = focus null + fitMode 'all'   (intersection)
            [<hostname>]       = focus that node              (fitMode N/A)
       */}
      {onlineNodes.length > 1 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[9px] text-gray-700 uppercase tracking-widest mr-0.5">View:</span>
          {/* Any fleet node — broadest, default */}
          <button
            onClick={() => { setFocusNode(null); setFitMode('any'); }}
            title="Show models any one of your fleet nodes can run (broadest catalog)."
            className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
              focusNodeId == null && fitMode === 'any'
                ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                : 'bg-transparent border-gray-700 text-gray-600 hover:text-gray-400 hover:border-gray-700'
            }`}
          >
            Any fleet node {focusNodeId == null && fitMode === 'any' ? '✓' : ''}
          </button>
          {/* Every fleet node — intersection */}
          <button
            onClick={() => { setFocusNode(null); setFitMode('all'); }}
            title="Show only models EVERY node in your fleet can run (intersection — safe for fleet-wide deployment)."
            className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
              focusNodeId == null && fitMode === 'all'
                ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                : 'bg-transparent border-gray-700 text-gray-600 hover:text-gray-400 hover:border-gray-700'
            }`}
          >
            Every fleet node {focusNodeId == null && fitMode === 'all' ? '✓' : ''}
          </button>
          {/* Subtle separator before per-node pills */}
          <span className="text-gray-800">·</span>
          {/* Per-node pills */}
          {onlineNodes.map(n => (
            <button
              key={n.node_id}
              onClick={() => setFocusNode(prev => prev === n.node_id ? null : n.node_id)}
              title={`Show only models that fit ${n.hostname ?? n.node_id}.`}
              className={`text-[10px] font-mono px-2 py-0.5 rounded-full border transition-colors ${
                focusNodeId === n.node_id
                  ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                  : 'bg-transparent border-gray-700 text-gray-600 hover:text-gray-400 hover:border-gray-700'
              }`}
            >
              {n.hostname ?? n.node_id}
            </button>
          ))}
        </div>
      )}

      {/* Search */}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <div className="flex-1 relative">
          {loading
            ? <Loader2 className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-cyan-500 animate-spin" />
            : <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-600" />
          }
          <input
            type="text"
            value={pendingSearch}
            onChange={e => handleChange(e.target.value)}
            placeholder="Search HuggingFace GGUF across your fleet (e.g. llama, qwen, mistral)…"
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
          explain how each tok/s projection was derived, and the full
          methodology lives in docs/docs.md under "Model Discovery Scoring". */}

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

      {/* Category chip row — inferred client-side from model_id (Phase 2).
          Backend-sourced HF pipeline_tag tracked as Phase 2.5 in ROADMAP. */}
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

      {/* Sort chip row. 'speed' and 'cost' degrade gracefully — models without
          a projection sink to the bottom rather than disappearing. */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] text-gray-600 uppercase tracking-widest mr-0.5">Sort:</span>
        {([
          { key: 'fit',        label: 'Fit',        hint: 'Highest fit score first (default).' },
          { key: 'popularity', label: 'Popularity', hint: 'Most-downloaded on HuggingFace first.' },
          { key: 'speed',      label: 'Speed',      hint: 'Projected tok/s — fastest first. Requires fleet history.' },
          { key: 'cost',       label: 'Cost',       hint: 'Cheapest tokens per dollar first. Requires fleet history.' },
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
              title={s.hint + (disabled ? ' Unavailable until you run a model — projections need ≥1 measurement.' : '')}
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

      {/* Source label */}
      {data && (
        <div className="text-[10px] text-gray-700">
          {data.is_live_search
            ? `Live HuggingFace search · scored against ${data.online_nodes} online node${data.online_nodes !== 1 ? 's' : ''}`
            : !pendingSearch
              ? <span><span className="text-gray-400 font-semibold">Recommended for your fleet</span> — sorted by fit, then popularity</span>
              : `Trending GGUF by downloads · scored across your ${data.online_nodes} online node${data.online_nodes !== 1 ? 's' : ''}`}
          {focusNodeId && focusNodeLabel
            ? <span className="text-cyan-600 ml-1">· showing {focusNodeLabel} compatible models</span>
            : onlineNodes.length > 1
              ? <span className="ml-1">· showing models {fitMode === 'all' ? 'every node can run' : 'at least one node can run'}</span>
              : null}
        </div>
      )}

      {/* No nodes online warning */}
      {data && data.online_nodes === 0 && (
        <div className="flex items-center gap-2 py-3 px-3 bg-yellow-500/5 border border-yellow-500/15 rounded-lg text-xs text-yellow-500/80">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          No nodes are currently online. Connect at least one node to score models against your hardware.
        </div>
      )}

      {/* Model catalog not yet populated */}
      {data && data.hf_reachable === false && !loading && (
        <div className="flex items-start gap-2 py-3 px-3 bg-orange-500/5 border border-orange-500/15 rounded-lg text-xs text-orange-400/80">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
          <div>
            <span className="font-medium">Model catalog is still loading.</span>
            <span className="text-gray-600 ml-1">The server fetches GGUF metadata from HuggingFace at startup — this takes about 30 seconds. Try searching by name below, or check back in a moment.</span>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="text-xs text-red-400 py-1">Failed to load: {error}</p>
      )}

      {/* Initial loading */}
      {loading && !data && (
        <div className="flex items-center justify-center py-10 gap-2 text-xs text-gray-600">
          <Loader2 className="w-4 h-4 animate-spin text-cyan-500/60" />
          {pendingSearch ? 'Searching HuggingFace…' : 'Loading trending models…'}
        </div>
      )}

      {/* Empty */}
      {data && displayModels.length === 0 && !loading && data.hf_reachable !== false && (
        <p className="text-xs text-gray-600 py-6 text-center">
          {focusNodeId
            ? `No models scored for ${focusNodeLabel}. Try a different search or select a different node.`
            : `No GGUF models found${pendingSearch ? ` for "${pendingSearch}"` : ''}. Try a different search term.`}
        </p>
      )}

      {/* Results */}
      {displayModels.length > 0 && (
        <div className="space-y-1">
          {(() => {
            const list = [...displayModels];
            if (!pendingSearch) {
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

              // Per-model fit score under the current view (focus or fleet aggregate).
              const fitOf = (m: FleetModel) => focusNodeId
                ? (m.nodes.find(n => n.node_id === focusNodeId)?.fit_score ?? 0)
                : m.fleet_best_score;
              // "Pull node" — the row's headline node used for projection + size.
              const pullNodeOf = (m: FleetModel) => focusNodeId
                ? (m.nodes.find(n => n.node_id === focusNodeId) ?? m.nodes[0])
                : m.nodes[0];
              const projOf = (m: FleetModel) => {
                const n = pullNodeOf(m);
                if (!n) return null;
                return projectTpsForVariant(history ?? [], n.file_size_mb, n.best_quant, n.chip_name ?? null);
              };
              const sizeOf = (m: FleetModel) => pullNodeOf(m)?.file_size_mb ?? 0;
              // Compose: primary key by sortMode, tiebreak on fit (or popularity for fit-mode).
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
                    // null projections sink to bottom; among nulls, fall back to fit.
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
                    // Cheaper wins (asc); Infinity buckets sink. Tiebreak on fit.
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
              <FleetModelRow
                key={model.model_id}
                model={model}
                getToken={getToken}
                focusNodeId={focusNodeId}
                history={history}
                hasFleetHistory={historyCount > 0}
                contextLength={contextLength}
                kwhRate={kwhRate}
                showCost={isKwhRateConfigured}
              />
            ));
          })()}
        </div>
      )}
    </div>
  );
};

export default FleetModelDiscovery;
