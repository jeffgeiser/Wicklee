/**
 * ModelFitAnalysis — "Is this model a good match for this hardware?"
 *
 * Unified two-dimensional fit analysis:
 *
 *   Dimension 1 — Memory Fit  (src/utils/modelFit.ts :: computeModelFitScore)
 *     good : headroom > 20% AND thermal Normal or unknown
 *     fair : headroom 10–20% OR thermal Fair
 *     poor : headroom < 10%, model exceeds capacity, OR thermal Serious/Critical
 *
 *   Dimension 2 — Efficiency  (WES — Wicklee Efficiency Score, src/utils/wes.ts)
 *     excellent  : WES > 10   — tok/s ÷ (watts × thermal penalty)
 *     good       : WES 3–10
 *     acceptable : WES 1–3
 *     low        : WES < 1
 *
 * Render modes (controlled by fleetView prop):
 *   Fleet  — compact summary table, one row per node×model (cloud Intelligence tab)
 *   Detail — single-node analysis: memory bar, quant insight, efficiency verdict
 *
 * Quantization compression ratios (quantCompressionRatio):
 *   Source: GGUF spec averages and llama.cpp benchmark measurements.
 *   https://github.com/ggerganov/llama.cpp/blob/master/docs/development/gguf.md
 *   These are approximate (±10%); actual ratios vary by model architecture
 *   (attention head count, MoE sparsity, K-quant mixed precision).
 *
 * Planned additions:
 *   Phase 2 — Context Runway: KV cache VRAM projection at 8k / 32k / 128k context
 *     milestones. Requires llama.block_count + llama.attention.head_count_kv from
 *     Ollama /api/show (already cached by the agent; need to surface in payload).
 *   Phase 3 — Quant Sweet Spot: memory-bandwidth-aware quantization recommendation
 *     using chip bandwidth lookup vs model parameter count.
 *   Phase 4 — MCP tool: get_model_fit returns pre-computed fit + plain-English
 *     reasoning, enabling AI agents to answer "can I run this model safely?"
 */

import React, { useState } from 'react';
import { Cpu, Activity } from 'lucide-react';
import type { SentinelMetrics } from '../../../types';
import { computeModelFitScore } from '../../../utils/modelFit';
import type { FitScore } from '../../../utils/modelFit';
import { computeWES, formatWES, wesColorClass } from '../../../utils/wes';
import { getNodePowerW } from '../../../utils/power';
import { computeContextRunway, fmtCtx } from '../../../utils/kvCache';
import { computeQuantRecommendation } from '../../../utils/quantSweet';

// ── Quantization helpers ───────────────────────────────────────────────────────

function parseQuantFromName(modelName: string): string | null {
  const m = modelName.match(/[._-](q\d[\w]*)/i);
  return m ? m[1].toUpperCase() : null;
}

function quantFamily(label: string): string {
  if (/^q2/i.test(label)) return 'Q2';
  if (/^q3/i.test(label)) return 'Q3';
  if (/^q4/i.test(label)) return 'Q4';
  if (/^q5/i.test(label)) return 'Q5';
  if (/^q6/i.test(label)) return 'Q6';
  if (/^q8/i.test(label)) return 'Q8';
  if (/^f16/i.test(label)) return 'F16';
  if (/^f32/i.test(label)) return 'F32';
  return 'Unknown';
}

/**
 * VRAM size relative to FP16 full-precision weights.
 * ratio < 1.0 → smaller than FP16 baseline
 * ratio = 1.0 → FP16 baseline
 * ratio > 1.0 → larger than FP16 (F32 only)
 */
function quantCompressionRatio(family: string): number {
  switch (family) {
    case 'Q2':  return 0.25; // ~2 bits/weight average
    case 'Q3':  return 0.35; // ~3 bits/weight average
    case 'Q4':  return 0.45; // ~4.5 bits/weight avg (K-quant mixed precision overhead)
    case 'Q5':  return 0.55; // ~5 bits/weight average
    case 'Q6':  return 0.65; // ~6 bits/weight average
    case 'Q8':  return 0.80; // ~8 bits/weight (slight overhead vs pure int8)
    case 'F16': return 1.0;  // FP16 baseline — 16 bits/weight
    case 'F32': return 2.0;  // FP32 — double the FP16 footprint
    default:    return 0.5;  // Unknown — conservative mid-range estimate
  }
}

/**
 * Quant tradeoff summary shown in tooltips and quant insight rows.
 * Claims are conservative and reflect consensus perplexity benchmarks
 * (delta vs FP16 on standard LLaMA-family models).
 */
const QUANT_DESCRIPTION: Record<string, string> = {
  Q2: 'Severe quality loss. Only viable if VRAM is extremely constrained.',
  Q3: 'Noticeable degradation. Use as a last resort for very large models.',
  Q4: 'Good quality–size tradeoff. Near-lossless for chat and instruction-following.',
  Q5: 'Near-lossless. Minimal perplexity delta vs FP16 for most tasks.',
  Q6: 'Excellent quality. Perplexity within ~1% of FP16.',
  Q8: 'Near-lossless quality. Consider Q6_K or Q5_K_M to free headroom for context.',
  F16: 'Full-precision baseline. Maximum quality at maximum VRAM cost.',
  F32: 'Double-precision. Rarely needed for inference — consider F16 or Q8.',
};

// ── Efficiency scoring (aligned with wesColorClass thresholds in wes.ts) ───────

type EfficiencyLevel = 'excellent' | 'good' | 'acceptable' | 'low';

const EFF_CONFIG: Record<EfficiencyLevel, {
  label: string;
  dotColor: string;
  textColor: string;
  tooltip: string;
}> = {
  excellent:  {
    label: 'Excellent',
    dotColor: 'bg-emerald-400',
    textColor: 'text-emerald-400',
    tooltip: 'WES > 10: exceptional throughput per watt. This silicon is extremely well-matched to this model.',
  },
  good: {
    label: 'Good',
    dotColor: 'bg-green-400',
    textColor: 'text-green-400',
    tooltip: 'WES 3–10: solid inference efficiency for this hardware class.',
  },
  acceptable: {
    label: 'Acceptable',
    dotColor: 'bg-amber-400',
    textColor: 'text-amber-400',
    tooltip: 'WES 1–3: adequate efficiency. A different quantization or model size may improve throughput per watt.',
  },
  low: {
    label: 'Low',
    dotColor: 'bg-red-400',
    textColor: 'text-red-400',
    tooltip: 'WES < 1: high energy cost per token. Check thermal state — throttling amplifies WES penalty.',
  },
};

const MEM_CONFIG: Record<FitScore, {
  label: string;
  dotColor: string;
  textColor: string;
  tooltip: string;
}> = {
  good: {
    label: 'Good',
    dotColor: 'bg-green-400',
    textColor: 'text-green-400',
    tooltip: 'Memory headroom > 20%. Comfortable room for context growth and KV cache expansion.',
  },
  fair: {
    label: 'Fair',
    dotColor: 'bg-amber-400',
    textColor: 'text-amber-400',
    tooltip: 'Memory headroom 10–20% or thermal Fair. Monitor closely under long contexts.',
  },
  poor: {
    label: 'Poor',
    dotColor: 'bg-red-400',
    textColor: 'text-red-400',
    tooltip: 'Headroom < 10%, model exceeds capacity, or thermal Serious/Critical. Risk of VRAM swapping or OOM.',
  },
};

function efficiencyLevel(wes: number | null): EfficiencyLevel {
  if (wes == null || wes < 1) return 'low';
  if (wes < 3)                return 'acceptable';
  if (wes <= 10)              return 'good';
  return 'excellent';
}

// ── Per-model data ─────────────────────────────────────────────────────────────

interface ModelEntry {
  modelName:   string;
  base:        string;
  tag:         string | null;
  quant:       string | null;
  family:      string;
  tps:         number | null;
  w1k:         number | null;
  wes:         number | null;
  effLevel:    EfficiencyLevel;
  vramSavedGb: number | null; // estimated savings vs FP16 baseline; null if unknown or N/A
}

function deriveModelEntry(
  modelName:    string,
  tps:          number | null,
  modelWes:     number | null,
  quantRaw:     string | null,
  sizeGb:       number | null,
  adjWatts:     number | null,
  thermalState: string | null,
): ModelEntry {
  const quant  = quantRaw?.toUpperCase() ?? parseQuantFromName(modelName)?.toUpperCase() ?? null;
  const family = quant ? quantFamily(quant) : 'Unknown';
  const ratio  = quantCompressionRatio(family);

  const w1k = tps != null && adjWatts != null && tps > 0
    ? (adjWatts / tps) * 1_000
    : null;

  const wes = modelWes ?? (
    tps != null && adjWatts != null && tps > 0 && adjWatts > 0
      ? computeWES(tps, adjWatts, thermalState)
      : null
  );

  // Estimated VRAM savings vs FP16 baseline.
  // fp16Est = what this model would require at full FP16 precision.
  // Only meaningful when current quant is below FP16 (ratio < 1.0)
  // and we have an observed model size to anchor the estimate.
  const fp16Est     = sizeGb != null && ratio > 0 && ratio < 1.0 ? sizeGb / ratio : null;
  const vramSavedGb = fp16Est != null && sizeGb != null && fp16Est > sizeGb
    ? fp16Est - sizeGb
    : null;

  const [base, tag] = modelName.includes(':')
    ? modelName.split(':', 2) as [string, string]
    : [modelName, null];

  return { modelName, base, tag, quant, family, tps, w1k, wes, effLevel: efficiencyLevel(wes), vramSavedGb };
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface ModelFitAnalysisProps {
  node:        SentinelMetrics;
  nodes:       SentinelMetrics[];
  /**
   * Renders a fleet-wide summary table instead of the single-node detail view.
   * Use on the cloud Intelligence tab where full-width real estate allows
   * showing all nodes and models at a glance.
   */
  fleetView?:  boolean;
  onNavigateToPerformance?: () => void;
  /** System idle power offset (W) subtracted from accelerator draw before WES. */
  systemIdleW?: number;
}

// ── Fleet table helpers ────────────────────────────────────────────────────────

interface FleetRow {
  nodeId:         string;
  hostname:       string;
  chipName:       string;
  entry:          ModelEntry;
  memScore:       FitScore | null;
  memReason:      string | null;
  memHeadroomPct: number | null;
  maxFitsCtx:     number | null | undefined; // undefined = runway not computable
  runwayExact:    boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

const ModelFitAnalysis: React.FC<ModelFitAnalysisProps> = ({
  node: defaultNode,
  nodes,
  fleetView = false,
  systemIdleW = 0,
}) => {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  function adjWattsFor(n: SentinelMetrics): number | null {
    const raw = getNodePowerW(n);
    return raw != null && systemIdleW > 0 ? Math.max(raw - systemIdleW, 0.1) : raw;
  }

  function buildEntries(n: SentinelMetrics): ModelEntry[] {
    const adj = adjWattsFor(n);
    if (n.active_models && n.active_models.length > 0) {
      return n.active_models.map(am =>
        deriveModelEntry(am.model, am.tok_s ?? null, am.wes ?? null, am.quantization ?? null, am.size_gb ?? null, adj, n.thermal_state)
      );
    }
    const primary = n.ollama_active_model ?? n.vllm_model_name ?? n.llamacpp_model_name ?? null;
    if (!primary) return [];
    return [deriveModelEntry(
      primary,
      n.ollama_tokens_per_second ?? n.vllm_tokens_per_sec ?? null,
      null,
      n.ollama_quantization ?? parseQuantFromName(primary),
      n.ollama_model_size_gb ?? null,
      adj,
      n.thermal_state,
    )];
  }

  // ── Fleet view ─────────────────────────────────────────────────────────────
  if (fleetView) {
    const rows: FleetRow[] = [];
    for (const n of nodes) {
      const entries = buildEntries(n);
      if (entries.length === 0) continue;
      const memFit = computeModelFitScore(n);
      const runway = memFit ? computeContextRunway(n, memFit.headroomGb) : null;
      for (const entry of entries) {
        rows.push({
          nodeId:         n.node_id,
          hostname:       n.hostname ?? n.node_id,
          chipName:       n.chip_name ?? n.gpu_name ?? '—',
          entry,
          memScore:       memFit?.score ?? null,
          memReason:      memFit?.reason ?? null,
          memHeadroomPct: memFit?.headroomPct ?? null,
          maxFitsCtx:     runway ? runway.maxFitsCtx : undefined,
          runwayExact:    runway?.arch.isExact ?? false,
        });
      }
    }

    const activeNodeCount = new Set(rows.map(r => r.nodeId)).size;
    const poorCount = rows.filter(r =>
      r.memScore === 'poor' || (r.entry.effLevel === 'low' && r.entry.wes != null)
    ).length;
    const fairCount = rows.filter(r =>
      (r.memScore === 'fair' || r.entry.effLevel === 'acceptable') &&
      r.memScore !== 'poor' && !(r.entry.effLevel === 'low' && r.entry.wes != null)
    ).length;
    const goodCount = rows.length - poorCount - fairCount;

    return (
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex flex-col gap-3">

        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Cpu className="w-3.5 h-3.5 text-gray-500 shrink-0" />
            <span
              className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 cursor-help"
              title="Two-dimensional fit scored per model: Memory (headroom vs model size after load) and Efficiency (WES: tok/s per watt, thermal penalty applied)."
            >
              Model Fit Analysis
            </span>
          </div>
          <span className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded border text-green-400 bg-green-500/10 border-green-500/25 flex items-center gap-1 shrink-0">
            <Activity className="w-2.5 h-2.5 animate-pulse" />
            Live
          </span>
        </div>

        {/* Fleet headline */}
        <div className="flex items-center gap-3 text-[10px] flex-wrap">
          <span className="text-gray-500">
            {activeNodeCount} node{activeNodeCount !== 1 ? 's' : ''} · {rows.length} model{rows.length !== 1 ? 's' : ''}
          </span>
          {goodCount > 0 && <span className="text-green-400 font-semibold">● {goodCount} optimal</span>}
          {fairCount > 0 && <span className="text-amber-400 font-semibold">● {fairCount} fair</span>}
          {poorCount > 0 && <span className="text-red-400 font-semibold">● {poorCount} needs attention</span>}
        </div>

        {rows.length === 0 ? (
          <p className="text-xs text-gray-600">No models loaded across the fleet — load a model on any node to see fit analysis.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-[9px] uppercase tracking-widest text-gray-600 border-b border-gray-800">
                  <th className="text-left pb-1.5 font-semibold pr-4">Node</th>
                  <th className="text-left pb-1.5 font-semibold pr-4">Model</th>
                  <th className="text-left pb-1.5 font-semibold pr-4">Quant</th>
                  <th
                    className="text-left pb-1.5 font-semibold pr-4 cursor-help"
                    title="Headroom after model load. Good >20% free, Fair 10–20%, Poor <10% or thermal Serious/Critical."
                  >Memory</th>
                  <th
                    className="text-left pb-1.5 font-semibold pr-4 cursor-help"
                    title="WES: tok/s ÷ (watts × thermal penalty). Excellent >10, Good 3–10, Acceptable 1–3, Low <1. Shown as — when no inference has been measured."
                  >Efficiency</th>
                  <th className="text-right pb-1.5 font-semibold pr-4">Tok/s</th>
                  <th
                    className="text-right pb-1.5 font-semibold pr-4 cursor-help"
                    title="Watts per 1,000 tokens at current draw. Hardware-agnostic — lower is better."
                  >W/1K Tkn</th>
                  <th
                    className="text-right pb-1.5 font-semibold cursor-help"
                    title="Largest context window where the KV cache fits within available memory headroom. KV cache = 2 × layers × KV-heads × head-dim × ctx × 2 bytes (FP16). ~ = estimated from parameter count."
                  >Max Ctx</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/40">
                {rows.map((row, i) => {
                  const effCfg = EFF_CONFIG[row.entry.effLevel];
                  const memCfg = row.memScore ? MEM_CONFIG[row.memScore] : null;
                  return (
                    <tr key={`${row.nodeId}-${row.entry.modelName}-${i}`} className="hover:bg-gray-800/30 transition-colors">
                      <td className="py-2 pr-4 font-mono text-gray-400 whitespace-nowrap">{row.hostname}</td>
                      <td className="py-2 pr-4 whitespace-nowrap">
                        <span className="text-gray-200">{row.entry.base}</span>
                        {row.entry.tag && <span className="text-gray-600">:{row.entry.tag}</span>}
                      </td>
                      <td className="py-2 pr-4">
                        {row.entry.quant ? (
                          <span
                            title={QUANT_DESCRIPTION[row.entry.family] ?? ''}
                            className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700 text-cyan-400 cursor-help"
                          >
                            {row.entry.quant}
                          </span>
                        ) : <span className="text-gray-700">—</span>}
                      </td>
                      <td className="py-2 pr-4">
                        {memCfg ? (
                          <span
                            className={`flex items-center gap-1.5 ${memCfg.textColor}`}
                            title={row.memReason ?? memCfg.tooltip}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${memCfg.dotColor}`} />
                            {memCfg.label}
                            {row.memHeadroomPct != null && (
                              <span className="text-gray-600 font-mono">({row.memHeadroomPct.toFixed(0)}%)</span>
                            )}
                          </span>
                        ) : <span className="text-gray-700">—</span>}
                      </td>
                      <td className="py-2 pr-4">
                        {row.entry.wes != null ? (
                          <span
                            className={`flex items-center gap-1.5 ${effCfg.textColor}`}
                            title={`WES ${row.entry.wes.toFixed(1)} · ${effCfg.tooltip}`}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${effCfg.dotColor}`} />
                            {effCfg.label}
                            <span className="text-gray-600 font-mono">({formatWES(row.entry.wes)})</span>
                          </span>
                        ) : (
                          <span
                            className="text-gray-700 cursor-help"
                            title="Efficiency not available. On CPU-only nodes, or when multiple models share memory, per-model throughput cannot be attributed without proxy instrumentation."
                          >—</span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right font-mono text-gray-300">
                        {row.entry.tps != null ? row.entry.tps.toFixed(1) : (
                          <span
                            className="text-gray-700 cursor-help"
                            title="No throughput reading. CPU-only nodes or multi-model setups require proxy instrumentation for per-model tok/s."
                          >—</span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right font-mono text-gray-300">
                        {row.entry.w1k != null ? `${row.entry.w1k.toFixed(0)}W` : <span className="text-gray-700">—</span>}
                      </td>
                      <td className="py-2 text-right font-mono">
                        {row.maxFitsCtx === undefined ? (
                          <span className="text-gray-700">—</span>
                        ) : row.maxFitsCtx === null ? (
                          <span className="text-red-500 text-[10px]">swap</span>
                        ) : (
                          <span
                            className="text-gray-300"
                            title={`${row.runwayExact ? '' : 'Estimated: '}KV cache fits up to ${fmtCtx(row.maxFitsCtx)} context within available headroom`}
                          >
                            {row.runwayExact ? '' : '~'}{fmtCtx(row.maxFitsCtx)}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Footer note when any row lacks efficiency data */}
        {rows.some(r => r.entry.wes == null) && (
          <p className="text-[9px] text-gray-700 mt-1">
            — Efficiency and tok/s require active inference data. CPU-only nodes and multi-model setups need proxy instrumentation for per-model throughput.
          </p>
        )}
      </div>
    );
  }

  // ── Detail view (single node or node-picker drill-down) ────────────────────
  const node     = selectedNodeId ? nodes.find(n => n.node_id === selectedNodeId) ?? defaultNode : defaultNode;
  const entries  = buildEntries(node);
  const memFit   = computeModelFitScore(node);
  const chipName = node.chip_name ?? node.gpu_name ?? 'this chip';

  if (entries.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Cpu className="w-3.5 h-3.5 text-gray-600 shrink-0" />
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">
            Model Fit Analysis
          </span>
        </div>
        <p className="text-xs text-gray-600">No model loaded — load a model to see fit analysis.</p>
      </div>
    );
  }

  // Memory bar segments as % of totalGb
  const memUsedGb   = memFit ? memFit.totalGb - memFit.headroomGb : 0;
  const modelBarPct = memFit ? Math.min((memFit.modelSizeGb / memFit.totalGb) * 100, 100) : 0;
  const otherBarPct = memFit ? Math.max(0, Math.min(
    ((memUsedGb - memFit.modelSizeGb) / memFit.totalGb) * 100,
    100 - modelBarPct,
  )) : 0;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex flex-col gap-3">

      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Cpu className="w-3.5 h-3.5 text-gray-500 shrink-0" />
          <span
            className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 truncate cursor-help"
            title="Two-dimensional fit: Memory (headroom after model load) and Efficiency (WES: tok/s per watt, thermal penalty applied). Both dimensions are needed — a model can fit in memory but still run inefficiently, or vice versa."
          >
            Model Fit Analysis{entries.length > 1 ? ` · ${entries.length} Models` : ''}
          </span>
        </div>
        <span className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded border text-green-400 bg-green-500/10 border-green-500/25 shrink-0 flex items-center gap-1">
          <Activity className="w-2.5 h-2.5 animate-pulse" />
          Live
        </span>
      </div>

      {/* Node picker — multi-node detail mode (Insights / Performance tab) */}
      {nodes.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {nodes.map(n => {
            const isSelected = (selectedNodeId ?? defaultNode.node_id) === n.node_id;
            return (
              <button
                key={n.node_id}
                onClick={() => setSelectedNodeId(
                  n.node_id === defaultNode.node_id && !selectedNodeId ? null : n.node_id
                )}
                className={`text-[9px] font-mono px-2 py-0.5 rounded-full border transition-colors ${
                  isSelected
                    ? 'bg-gray-700 border-gray-600 text-gray-200'
                    : 'bg-transparent border-gray-800 text-gray-600 hover:text-gray-400 hover:border-gray-700'
                }`}
              >
                {n.hostname ?? n.node_id}
              </button>
            );
          })}
        </div>
      )}

      {/* Per-model entries */}
      {entries.map((e, i) => {
        const effCfg = EFF_CONFIG[e.effLevel];
        const memCfg = memFit ? MEM_CONFIG[memFit.score] : null;

        return (
          <div key={e.modelName} className={entries.length > 1 && i > 0 ? 'pt-3 border-t border-gray-800/50' : ''}>

            {/* Identity row: model name + quant badge */}
            <div className="flex items-center gap-2 flex-wrap mb-2.5">
              <span className={`w-2 h-2 rounded-full shrink-0 ${e.wes != null ? effCfg.dotColor : 'bg-gray-600'} ${e.effLevel === 'low' && e.wes != null ? 'animate-pulse' : ''}`} />
              <span className="font-mono text-xs text-gray-200">
                {e.base}
                {e.tag && <span className="text-gray-500">:{e.tag}</span>}
              </span>
              {e.quant && (
                <span
                  title={QUANT_DESCRIPTION[e.family] ?? ''}
                  className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700 text-cyan-400 cursor-help"
                >
                  {e.quant}
                </span>
              )}
            </div>

            {/* Metrics row: tok/s · W/1K · WES */}
            <div className="grid grid-cols-3 gap-3 mb-2.5">
              <div>
                <p className="text-[9px] text-gray-600 uppercase tracking-widest mb-0.5">Tok/s</p>
                <p className="font-telin text-sm text-gray-200">
                  {e.tps != null ? e.tps.toFixed(1) : <span className="text-gray-600">—</span>}
                </p>
              </div>
              <div>
                <p
                  className="text-[9px] text-gray-600 uppercase tracking-widest mb-0.5 cursor-help"
                  title="Watts per 1,000 tokens at current accelerator draw. Hardware-agnostic efficiency metric — lower is better. Computed as: (accelerator watts ÷ tok/s) × 1000."
                >W/1K Tkn</p>
                <p className="font-telin text-sm text-gray-200">
                  {e.w1k != null ? `${e.w1k.toFixed(0)}W` : <span className="text-gray-600">—</span>}
                </p>
              </div>
              <div>
                <p
                  className="text-[9px] text-gray-600 uppercase tracking-widest mb-0.5 cursor-help"
                  title="Wicklee Efficiency Score: tok/s ÷ (watts × thermal penalty). The thermal penalty increases with throttling (Fair 1.25×, Serious 1.75×, Critical 2×), so a throttled node's WES drops even if tok/s looks stable."
                >WES</p>
                <p className={`font-telin text-sm ${wesColorClass(e.wes)}`}>
                  {e.wes != null ? formatWES(e.wes) : <span className="text-gray-600">—</span>}
                </p>
                {e.wes != null && (
                  <p className={`text-[9px] ${effCfg.textColor}`} title={effCfg.tooltip}>
                    {effCfg.label}
                  </p>
                )}
              </div>
            </div>

            {/* Memory picture — shown once (represents overall node memory state) */}
            {i === 0 && memFit && (
              <div className="mb-2.5">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-0.5">
                    <p
                      className="text-[9px] text-gray-600 uppercase tracking-widest cursor-help"
                      title={`${memFit.isNvidia ? 'Dedicated GPU VRAM (NVML)' : 'Unified memory (shared CPU + GPU)'}. Headroom is free space after all loaded models and system processes. Context windows and KV cache grow into this space during inference.`}
                    >
                      {memFit.isNvidia ? 'VRAM' : 'Memory'}
                    </p>
                  </div>
                  {memCfg && (
                    <span
                      className={`text-[9px] font-semibold ${memCfg.textColor} cursor-help`}
                      title={memFit.reason}
                    >
                      ● {memCfg.label}
                    </span>
                  )}
                </div>
                {/* Stacked bar: model (indigo) · other used (gray) · free (dark bg) */}
                <div className="h-1.5 w-full bg-gray-800 rounded-full overflow-hidden flex mb-1">
                  <div
                    className="h-full bg-indigo-500/80"
                    style={{ width: `${modelBarPct}%` }}
                    title={`Model weights: ${memFit.modelSizeGb.toFixed(1)} GB`}
                  />
                  {otherBarPct > 0.5 && (
                    <div
                      className="h-full bg-gray-500/40"
                      style={{ width: `${otherBarPct}%` }}
                      title="OS and other processes"
                    />
                  )}
                </div>
                <div className="flex justify-between text-[9px] font-mono text-gray-600">
                  <span>
                    <span className="text-indigo-400">{memFit.modelSizeGb.toFixed(1)} GB</span> model
                    {otherBarPct > 0.5 && (
                      <span> · {Math.max(0, memUsedGb - memFit.modelSizeGb).toFixed(1)} GB other</span>
                    )}
                  </span>
                  <span>
                    {memFit.headroomGb.toFixed(1)} GB free · {memFit.totalGb.toFixed(0)} GB {memFit.isNvidia ? 'VRAM' : 'unified'}
                  </span>
                </div>
              </div>
            )}

            {/* Context Runway — shown once, after memory bar, on first entry */}
            {i === 0 && memFit && (() => {
              const runway = computeContextRunway(node, memFit.headroomGb);
              if (!runway) return null;

              // Show milestones up to the model's max context (cap at 5 points for space)
              const visiblePoints = runway.points.slice(0, 5);
              const maxBarKvGb    = visiblePoints[visiblePoints.length - 1]?.kvGb ?? 1;

              return (
                <div className="mb-2.5">
                  <div className="flex items-center gap-0.5 mb-1.5">
                    <p
                      className="text-[9px] text-gray-600 uppercase tracking-widest cursor-help"
                      title={`How much memory the KV cache consumes at each context length. Formula: 2 × layers × KV-heads × head-dim × ctx-tokens × 2 bytes (FP16). ${runway.arch.isExact ? 'Architecture from /api/show (exact).' : 'Estimated from parameter count (±30%).'}`}
                    >Context Runway</p>
                    {!runway.arch.isExact && (
                      <span className="text-[8px] text-gray-600 ml-1">est.</span>
                    )}
                  </div>

                  {/* Milestone bars */}
                  <div className="space-y-1">
                    {visiblePoints.map(pt => {
                      const isMax     = pt.tokens === runway.arch.maxCtx;
                      const barPct    = Math.min((pt.kvGb / (memFit.headroomGb + maxBarKvGb * 0.1)) * 100, 100);
                      const fitsColor = pt.fits
                        ? pt.headroomRatio > 0.7 ? 'bg-amber-500/70' : 'bg-green-500/70'
                        : 'bg-red-500/70';
                      const labelColor = pt.fits
                        ? pt.headroomRatio > 0.7 ? 'text-amber-400' : 'text-green-400'
                        : 'text-red-400';

                      return (
                        <div
                          key={pt.tokens}
                          className="flex items-center gap-2"
                          title={`${fmtCtx(pt.tokens)} context → KV cache ${runway.arch.isExact ? '' : '~'}${pt.kvGb.toFixed(2)} GB (${(pt.headroomRatio * 100).toFixed(0)}% of ${memFit.headroomGb.toFixed(1)} GB headroom)`}
                        >
                          <span className={`text-[9px] font-mono w-9 shrink-0 text-right ${isMax ? 'text-gray-400 font-semibold' : 'text-gray-600'}`}>
                            {fmtCtx(pt.tokens)}
                          </span>
                          <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${fitsColor}`}
                              style={{ width: `${barPct}%` }}
                            />
                          </div>
                          <span className={`text-[9px] font-mono w-12 shrink-0 ${labelColor}`}>
                            {runway.arch.isExact ? '' : '~'}{pt.kvGb.toFixed(1)} GB
                          </span>
                          <span className={`text-[8px] shrink-0 ${pt.fits ? 'text-gray-700' : 'text-red-500'}`}>
                            {pt.fits ? '✓' : '✗'}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {/* Headroom reference line */}
                  <p className="text-[9px] text-gray-600 mt-1">
                    {memFit.headroomGb.toFixed(1)} GB available for KV cache
                    {runway.arch.maxCtx && (
                      <span> · max context {fmtCtx(runway.arch.maxCtx)}</span>
                    )}
                  </p>

                  {/* Summary sentence */}
                  <p className="text-[10px] text-gray-500 leading-relaxed mt-0.5">{runway.summary}</p>
                </div>
              );
            })()}

            {/* Quant Sweet Spot — shown on first entry when quant + size are known */}
            {i === 0 && e.family !== 'Unknown' && memFit != null && (() => {
              const rec = computeQuantRecommendation(
                e.family,
                memFit.modelSizeGb,
                memFit.headroomGb,
                e.tps,
                node,
              );
              if (rec.kind === 'none') return null;

              const kindColor: Record<string, string> = {
                upgrade:    'text-red-400',
                consider:   'text-cyan-400',
                downgrade:  'text-amber-400',
                'sweet-spot': 'text-green-400',
                lossless:   'text-green-400',
              };
              const headlineColor = kindColor[rec.kind] ?? 'text-gray-400';

              return (
                <div className="pt-2 border-t border-gray-800/50">
                  <div className="flex items-center gap-0.5 mb-1">
                    <p
                      className="text-[9px] text-gray-600 uppercase tracking-widest cursor-help"
                      title="Bandwidth-aware quantization recommendation. Speed estimates scale observed tok/s by inverse size ratio (memory-bandwidth-bound assumption). Quality deltas from llama.cpp perplexity benchmarks."
                    >Quant Sweet Spot</p>
                    {rec.bandwidthGbs != null && (
                      <span
                        className="text-[8px] text-gray-700 ml-1.5 font-mono"
                        title={`${node.chip_name ?? node.gpu_name ?? 'Chip'} rated memory bandwidth`}
                      >
                        {rec.bandwidthGbs.toLocaleString()} GB/s
                      </span>
                    )}
                  </div>
                  <p className={`text-[11px] font-semibold leading-snug ${headlineColor}`}>
                    {rec.headline}
                  </p>
                  <p className="text-[10px] text-gray-500 leading-relaxed mt-0.5">
                    {rec.detail}
                  </p>
                  {/* VRAM savings vs FP16 — compact supporting fact */}
                  {e.vramSavedGb != null && e.vramSavedGb > 0.1 && (
                    <p
                      className="text-[9px] text-gray-700 mt-1"
                      title="Estimated savings vs FP16 full-precision weights. Based on GGUF average compression ratios (±10%)."
                    >
                      {e.quant} saves ~{e.vramSavedGb.toFixed(1)} GB vs FP16 baseline
                    </p>
                  )}
                </div>
              );
            })()}

            {/* Efficiency verdict — only when WES has been measured */}
            {e.wes != null && (
              <p className="text-[10px] text-gray-600 leading-relaxed mt-1" title={effCfg.tooltip}>
                {effCfg.tooltip}
              </p>
            )}

          </div>
        );
      })}
    </div>
  );
};

export default ModelFitAnalysis;
