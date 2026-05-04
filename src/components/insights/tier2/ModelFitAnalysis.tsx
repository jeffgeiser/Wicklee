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

import React, { useState, useRef } from 'react';
import { Cpu, Activity } from 'lucide-react';
import type { SentinelMetrics } from '../../../types';
import { computeModelFitScore } from '../../../utils/modelFit';
import type { FitScore } from '../../../utils/modelFit';
import { computeWES, formatWES, wesColorClass } from '../../../utils/wes';
import { getNodePowerW } from '../../../utils/power';
import { computeContextRunway, fmtCtx, fmtKvSize } from '../../../utils/kvCache';
import { computeQuantRecommendation } from '../../../utils/quantSweet';
import { lookupPerplexity, QUALITY_BAND_LABEL, QUALITY_BAND_TONE, type QualityCost } from '../../../utils/perplexity';
import { FLEET_ROW_ROLLING_WINDOW } from '../../../hooks/useRollingMetrics';

// ── Styled hover tooltip ──────────────────────────────────────────────────────
// Lightweight version of MetricTooltip — no metricId/link needed for labels.

interface TipProps {
  text: string;
  children: React.ReactNode;
  /** Where the panel opens relative to the trigger. Default: top. */
  side?: 'top' | 'bottom';
  width?: string;
}

const Tip: React.FC<TipProps> = ({ text, children, side = 'top', width = 'w-56' }) => {
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = () => {
    if (!window.matchMedia('(hover: hover)').matches) return;
    timer.current = setTimeout(() => setVisible(true), 350);
  };
  const hide = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setVisible(false);
  };

  return (
    <span className="relative inline-flex items-center" onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {visible && (
        <span
          role="tooltip"
          className={[
            'absolute z-50 pointer-events-none',
            width,
            side === 'top' ? 'bottom-full left-0 mb-1.5' : 'top-full left-0 mt-1.5',
            'bg-gray-800 border border-gray-700/50 rounded-xl',
            'shadow-2xl shadow-black/50 px-3 py-2.5',
            'text-[11px] text-gray-400 font-sans leading-relaxed whitespace-normal',
          ].join(' ')}
        >
          {text}
        </span>
      )}
    </span>
  );
};

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
  watts:        number | null,
  pue:          number,
  thermalState: string | null,
): ModelEntry {
  const quant  = quantRaw?.toUpperCase() ?? parseQuantFromName(modelName)?.toUpperCase() ?? null;
  const family = quant ? quantFamily(quant) : 'Unknown';
  const ratio  = quantCompressionRatio(family);

  // W/1K tkn — facility-load adjusted to match Overview row formula.
  // Overview's per-row W/1K omits PUE, so we mirror that exactly here:
  // (watts / tps) × 1000 with raw watts.  Lower = more efficient.
  const w1k = tps != null && watts != null && tps > 0
    ? (watts / tps) * 1_000
    : null;

  // WES — canonical formula tps / (watts × PUE × thermal_penalty).
  // Prefer the agent-provided per-model WES when present (active_models[].wes
  // carries proxy-based per-model attribution that node-level math can't
  // reproduce).  When absent, compute against the same inputs Overview uses.
  const wes = modelWes ?? (
    tps != null && watts != null && tps > 0 && watts > 0
      ? computeWES(tps, watts, thermalState, pue)
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
  /**
   * Per-node settings resolver — used to pull the user-configured PUE
   * multiplier so WES values shown here match the Overview tile exactly.
   * Without this, WES uses the canonical PUE=1.0 default.
   */
  getNodeSettings?: (nodeId: string) => { pue?: number; locationLabel?: string | null } | undefined;
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
  getNodeSettings,
}) => {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // ── Per-node rolling buffers (mirror Overview's Fleet Status row) ─────────
  // The Fleet Status row on the Intelligence tab smooths watts and tok/s
  // through `useNodeRollingMetrics(FLEET_ROW_ROLLING_WINDOW)` — a 4-sample
  // moving average that dampens probe-residency spikes (Apple Silicon idle
  // power can read 0.2–5W within a single probe cycle).  MFA used to read
  // raw values, which is why its WES diverged from the row WES (e.g.
  // macmini showed Efficiency 27.3 here while the Fleet Status row showed
  // 17.5).  We now smooth here with the same window so the values match
  // exactly.  Buffers are keyed by node_id and live across renders via a
  // ref — no React state churn.
  const buffersRef = useRef<Record<string, { watts: number[]; tps: number[] }>>({});

  function pushAndAvg(nodeId: string, key: 'watts' | 'tps', value: number | null): number | null {
    const node = buffersRef.current[nodeId] ?? (buffersRef.current[nodeId] = { watts: [], tps: [] });
    if (value != null && isFinite(value)) {
      const buf = node[key];
      buf.push(value);
      if (buf.length > FLEET_ROW_ROLLING_WINDOW) buf.shift();
    }
    const buf = node[key];
    return buf.length > 0 ? buf.reduce((a, c) => a + c, 0) / buf.length : null;
  }

  // ── Canonical WES + W/1K math ─────────────────────────────────────────────
  // Aligned with the Overview Fleet Status row:
  //   WES   = tok/s ÷ (smoothed_watts × PUE × thermal_penalty)
  //   W/1K  = (smoothed_watts / tok/s) × 1000
  // Both watts and tps are smoothed via 4-sample rolling buffer so values
  // match the Fleet Status row exactly. systemIdleW deliberately NOT
  // subtracted — that knob is for active-inference cost displays.
  function wattsFor(n: SentinelMetrics): number | null {
    return pushAndAvg(n.node_id, 'watts', getNodePowerW(n));
  }
  function pueFor(n: SentinelMetrics): number {
    return getNodeSettings?.(n.node_id)?.pue ?? 1.0;
  }
  // Combine Ollama + vLLM tok/s when both runtimes are reporting non-null
  // values on the same node — same convention as Overview.estimateTps's
  // `rawCombined`. Single-runtime nodes get the one value. Smoothed via
  // the same 4-sample rolling buffer as watts.
  function combinedTpsFor(n: SentinelMetrics): number | null {
    const o = n.ollama_tokens_per_second ?? null;
    const v = n.vllm_tokens_per_sec      ?? null;
    const raw = (o != null && v != null) ? o + v : (o ?? v);
    return pushAndAvg(n.node_id, 'tps', raw);
  }

  function buildEntries(n: SentinelMetrics): ModelEntry[] {
    const watts = wattsFor(n);
    const pue   = pueFor(n);
    if (n.active_models && n.active_models.length > 0) {
      const hasPerModelThroughput = n.active_models.some(am => am.tok_s != null);
      const nodeTps = combinedTpsFor(n);
      return n.active_models.map(am => {
        // When no per-model throughput (no proxy), attribute node-level tok/s
        // to whichever model was most recently active — others show —.
        const isActive = !hasPerModelThroughput && am.model === n.ollama_active_model;
        const tps = am.tok_s ?? (isActive ? nodeTps : null);
        return deriveModelEntry(am.model, tps, am.wes ?? null, am.quantization ?? null, am.size_gb ?? null, watts, pue, n.thermal_state);
      });
    }
    const primary = n.ollama_active_model ?? n.vllm_model_name ?? n.llamacpp_model_name ?? null;
    if (!primary) return [];
    return [deriveModelEntry(
      primary,
      combinedTpsFor(n),
      null,
      n.ollama_quantization ?? parseQuantFromName(primary),
      n.ollama_model_size_gb ?? null,
      watts,
      pue,
      n.thermal_state,
    )];
  }

  // ── Fleet view ─────────────────────────────────────────────────────────────
  // Drop into detail view when the operator has clicked a row — preserves
  // the back-to-fleet affordance via the `cameFromFleet` flag rendered in
  // the detail view header.
  const cameFromFleet = fleetView && selectedNodeId != null;
  if (fleetView && !selectedNodeId) {
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
      <div className="bg-gray-800 border border-gray-700 rounded-2xl p-4 flex flex-col gap-3">

        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Cpu className="w-3.5 h-3.5 text-gray-500 shrink-0" />
            <Tip
              text="Two-dimensional fit scored per model: Memory (headroom vs model size after load) and Efficiency (WES: tok/s per watt, thermal penalty applied)."
              side="bottom"
              width="w-64"
            >
              <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
                Model Fit Analysis
              </span>
            </Tip>
          </div>
          <span className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded border text-green-400 bg-green-500/10 border-green-500/25 flex items-center gap-1 shrink-0">
            <Activity className="w-2.5 h-2.5 animate-pulse" />
            Live
          </span>
        </div>

        {/* Plain-English fleet verdict sentence */}
        {rows.length > 0 && (() => {
          const total       = rows.length;
          const dominantTone =
            poorCount > 0 ? 'text-red-400'
            : fairCount > goodCount ? 'text-amber-400'
            : 'text-green-400';
          const dominantWord =
            poorCount > 0 ? `${poorCount} of ${total} models need attention`
            : fairCount > goodCount ? `${fairCount} of ${total} models in the fair range`
            : `all ${total} models running optimally`;
          const drillHint =
            poorCount > 0 ? 'Click any Poor row below to see per-model breakdown for that node.'
            : fairCount > 0 ? 'Click any row to see per-model breakdown for that node.'
            : 'No fit issues across the fleet. Click any row for per-model breakdown.';
          return (
            <p className="text-xs text-gray-400 leading-relaxed">
              <span className={`font-semibold ${dominantTone}`}>{dominantWord}</span>
              <span className="text-gray-500"> across {activeNodeCount} active node{activeNodeCount !== 1 ? 's' : ''}.</span>
              {' '}<span className="text-gray-500">{drillHint}</span>
            </p>
          );
        })()}

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
                <tr className="text-[9px] uppercase tracking-widest text-gray-600 border-b border-gray-700">
                  <th className="text-left pb-1.5 font-semibold pr-4">Node</th>
                  <th className="text-left pb-1.5 font-semibold pr-4">Model</th>
                  <th className="text-left pb-1.5 font-semibold pr-4">Quant</th>
                  <th className="text-left pb-1.5 font-semibold pr-4">
                    <Tip text="Headroom after model load. Good >20% free, Fair 10–20%, Poor <10% or thermal Serious/Critical." side="bottom">
                      Memory
                    </Tip>
                  </th>
                  <th className="text-left pb-1.5 font-semibold pr-4">
                    <Tip text="WES: tok/s ÷ (watts × thermal penalty). Excellent >10, Good 3–10, Acceptable 1–3, Low <1. Shows — when no inference has been measured yet." side="bottom">
                      Efficiency
                    </Tip>
                  </th>
                  <th className="text-right pb-1.5 font-semibold pr-4">Tok/s</th>
                  <th className="text-right pb-1.5 font-semibold pr-4">
                    <Tip text="Watts per 1,000 tokens at current draw. Hardware-agnostic — lower is better." side="bottom">
                      W/1K Tkn
                    </Tip>
                  </th>
                  <th className="text-right pb-1.5 font-semibold">
                    <Tip text="Largest context window where the KV cache fits in memory headroom. ~ = estimated from param count. — = no architecture data (vLLM nodes always show —)." side="bottom" width="w-64">
                      Max Ctx
                    </Tip>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/40">
                {rows.map((row, i) => {
                  const effCfg = EFF_CONFIG[row.entry.effLevel];
                  const memCfg = row.memScore ? MEM_CONFIG[row.memScore] : null;
                  return (
                    <tr
                      key={`${row.nodeId}-${row.entry.modelName}-${i}`}
                      onClick={() => setSelectedNodeId(row.nodeId)}
                      className="hover:bg-gray-700/30 transition-colors cursor-pointer"
                      title="Click to drill into this node"
                    >
                      <td className="py-2 pr-4 font-mono text-gray-400 whitespace-nowrap">{row.hostname}</td>
                      <td className="py-2 pr-4 whitespace-nowrap">
                        <span className="text-gray-200">{row.entry.base}</span>
                        {row.entry.tag && <span className="text-gray-600">:{row.entry.tag}</span>}
                      </td>
                      <td className="py-2 pr-4">
                        {row.entry.quant ? (
                          <span
                            title={QUANT_DESCRIPTION[row.entry.family] ?? ''}
                            className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded bg-gray-700 border border-gray-700 text-cyan-400"
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
                            className="text-gray-700"
                            title="No efficiency data. On CPU-only nodes or multi-model setups, per-model throughput can't be attributed without proxy instrumentation."
                          >—</span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right font-mono text-gray-300">
                        {row.entry.tps != null ? row.entry.tps.toFixed(1) : (
                          <span
                            className="text-gray-700"
                            title="No throughput reading. Multi-model setups show tok/s for the most-recently-active model only; others require proxy instrumentation."
                          >—</span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right font-mono text-gray-300">
                        {row.entry.w1k != null ? `${row.entry.w1k.toFixed(0)}W` : <span className="text-gray-700">—</span>}
                      </td>
                      <td className="py-2 text-right font-mono">
                        {row.maxFitsCtx === undefined ? (
                          <span className="text-gray-700" title="Context runway not available — requires architecture data (layers, KV heads) from Ollama /api/show, or a parameter count for estimation. vLLM nodes always show —.">—</span>
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
      <div className="bg-gray-800 border border-gray-700 rounded-2xl p-4 flex flex-col gap-3">
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
    <div className="bg-gray-800 border border-gray-700 rounded-2xl p-4 flex flex-col gap-3">

      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {cameFromFleet && (
            <button
              type="button"
              onClick={() => setSelectedNodeId(null)}
              className="text-[10px] font-semibold uppercase tracking-widest text-cyan-400 hover:text-cyan-300 transition-colors flex items-center gap-1"
              title="Back to fleet view"
            >
              ← Fleet
            </button>
          )}
          <Cpu className="w-3.5 h-3.5 text-gray-500 shrink-0" />
          <span
            className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 truncate"
          >
            Model Fit Analysis{entries.length > 1 ? ` · ${entries.length} Models` : ''}
          </span>
        </div>
        <span className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded border text-green-400 bg-green-500/10 border-green-500/25 shrink-0 flex items-center gap-1">
          <Activity className="w-2.5 h-2.5 animate-pulse" />
          Live
        </span>
      </div>

      {/* Plain-English verdict sentence — the first thing the user reads. */}
      {(() => {
        if (!memFit) return null;
        const primary    = entries[0];
        const fitLabel   = memFit.score === 'good' ? 'Good fit' : memFit.score === 'fair' ? 'Fair fit' : 'Poor fit';
        const fitTone    =
          memFit.score === 'good' ? 'text-green-400'
          : memFit.score === 'fair' ? 'text-amber-400'
          : 'text-red-400';
        const tpsStr     = primary.tps != null ? `${primary.tps.toFixed(0)} tok/s` : 'idle';
        const quantStr   = primary.quant ?? 'unknown quant';
        const headroomStr = `${memFit.headroomPct.toFixed(0)}% memory headroom`;
        const rec        = primary.tps != null && primary.family !== 'Unknown'
          ? computeQuantRecommendation(primary.family, memFit.modelSizeGb, memFit.headroomGb, primary.tps, node)
          : null;
        const recTail    = (() => {
          if (!rec) return null;
          if (rec.kind === 'upgrade')   return `${rec.targetFamily ? `Recommend ${rec.targetFamily}` : 'Quality is degraded'} — ${rec.headline.toLowerCase()}`;
          if (rec.kind === 'consider')  return rec.targetFamily ? `Consider ${rec.targetFamily} for near-lossless quality (+${(rec.vramDeltaGb ?? 0).toFixed(1)} GB).` : null;
          if (rec.kind === 'sweet-spot') return rec.headline;
          if (rec.kind === 'downgrade') return rec.headline;
          if (rec.kind === 'lossless')  return rec.headline;
          return null;
        })();
        return (
          <p className="text-xs text-gray-400 leading-relaxed">
            <span className="text-gray-200 font-medium">{chipName}</span> is running{' '}
            <span className="text-gray-200 font-medium">{primary.base}</span>
            {primary.quant ? <> at <span className="text-gray-200 font-mono">{quantStr}</span></> : null}
            {' '}— <span className={`font-semibold ${fitTone}`}>{fitLabel}</span>
            {primary.tps != null ? <>, {tpsStr}</> : null}, {headroomStr}.
            {recTail && <> <span className="text-gray-500">{recTail}</span></>}
          </p>
        );
      })()}

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
                    : 'bg-transparent border-gray-700 text-gray-600 hover:text-gray-400 hover:border-gray-700'
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
          <div key={e.modelName} className={entries.length > 1 && i > 0 ? 'pt-3 border-t border-gray-700/50' : ''}>

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
                  className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded bg-gray-700 border border-gray-700 text-cyan-400"
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
                <p className="text-[9px] text-gray-600 uppercase tracking-widest mb-0.5">
                  <Tip text="Watts per 1,000 tokens at current accelerator draw. Hardware-agnostic efficiency metric — lower is better." side="bottom">
                    W/1K Tkn
                  </Tip>
                </p>
                <p className="font-telin text-sm text-gray-200">
                  {e.w1k != null ? `${e.w1k.toFixed(0)}W` : <span className="text-gray-600">—</span>}
                </p>
              </div>
              <div>
                <p className="text-[9px] text-gray-600 uppercase tracking-widest mb-0.5">
                  <Tip text="Wicklee Efficiency Score: tok/s ÷ (watts × thermal penalty). The thermal penalty increases with throttling (Fair 1.25×, Serious 1.75×, Critical 2×), so a throttled node's WES drops even if tok/s looks stable." side="bottom">
                    WES
                  </Tip>
                </p>
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
                    <p className="text-[9px] text-gray-600 uppercase tracking-widest">
                      <Tip
                        text={`${memFit.isNvidia ? 'Dedicated GPU VRAM (NVML)' : 'Unified memory (shared CPU + GPU)'}. Headroom is free space after all loaded models and system processes. Context windows and KV cache grow into this space during inference.`}
                        side="bottom"
                      >
                        {memFit.isNvidia ? 'VRAM' : 'Memory'}
                      </Tip>
                    </p>
                  </div>
                  {memCfg && (
                    <span
                      className={`text-[9px] font-semibold ${memCfg.textColor}`}
                      title={memFit.reason}
                    >
                      ● {memCfg.label}
                    </span>
                  )}
                </div>
                {/* Stacked bar: model (indigo) · other used (gray) · free (dark bg) */}
                <div className="h-1.5 w-full bg-gray-700 rounded-full overflow-hidden flex mb-1">
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

              const approx = runway.arch.isExact ? '' : '~';
              // "Compact" mode: model max context is small enough that every milestone fits.
              // Showing bars for a single passing row is noisy — use an inline badge instead.
              const isCompact = runway.points.length === 1 ||
                (runway.maxFitsCtx != null && runway.maxFitsCtx >= runway.arch.maxCtx);

              if (isCompact) {
                const maxPt = runway.points[runway.points.length - 1];
                return (
                  <div className="mb-2.5">
                    <div className="flex items-center justify-between">
                      <p className="text-[9px] text-gray-600 uppercase tracking-widest">
                        <Tip
                          text={`KV cache at max context (${fmtCtx(runway.arch.maxCtx)}): ${approx}${fmtKvSize(maxPt.kvGb)}. ${runway.arch.isExact ? 'Architecture from /api/show.' : 'Estimated from parameter count (±30%).'}`}
                          side="bottom"
                        >
                          Context Runway
                        </Tip>
                      </p>
                      <span className="text-[9px] text-green-400 font-mono flex items-center gap-1">
                        ✓ Full {fmtCtx(runway.arch.maxCtx)} window
                        <span className="text-gray-600">· {approx}{fmtKvSize(maxPt.kvGb)} KV cache</span>
                      </span>
                    </div>
                  </div>
                );
              }

              // Multi-milestone bar chart
              const visiblePoints = runway.points.slice(0, 5);
              const scale = Math.max(...visiblePoints.map(p => p.kvGb), memFit.headroomGb * 0.1);

              return (
                <div className="mb-2.5">
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-[9px] text-gray-600 uppercase tracking-widest">
                      <Tip
                        text={`KV cache memory at each context length. Formula: 2 × layers × KV-heads × head-dim × ctx × 2 bytes (FP16). ${runway.arch.isExact ? 'Architecture from /api/show.' : 'Estimated from parameter count (±30%).'}`}
                        side="bottom"
                      >
                        Context Runway
                      </Tip>
                    </p>
                    <span className="text-[9px] text-gray-600 font-mono">
                      {fmtKvSize(memFit.headroomGb)} headroom{!runway.arch.isExact && <span className="ml-1 text-gray-700">est.</span>}
                    </span>
                  </div>

                  <div className="space-y-1">
                    {visiblePoints.map(pt => {
                      const isMax      = pt.tokens === runway.arch.maxCtx;
                      const barPct     = Math.min((pt.kvGb / scale) * 100, 100);
                      const fitsColor  = pt.fits
                        ? pt.headroomRatio > 0.7 ? 'bg-amber-500/70' : 'bg-green-500/70'
                        : 'bg-red-500/70';
                      const labelColor = pt.fits
                        ? pt.headroomRatio > 0.7 ? 'text-amber-400' : 'text-green-400'
                        : 'text-red-400';

                      return (
                        <div
                          key={pt.tokens}
                          className="flex items-center gap-2"
                          title={`${fmtCtx(pt.tokens)} context → ${approx}${fmtKvSize(pt.kvGb)} KV cache (${(pt.headroomRatio * 100).toFixed(0)}% of ${fmtKvSize(memFit.headroomGb)} headroom)`}
                        >
                          <span className={`text-[9px] font-mono w-9 shrink-0 text-right ${isMax ? 'text-gray-400 font-semibold' : 'text-gray-600'}`}>
                            {fmtCtx(pt.tokens)}
                          </span>
                          <div className="flex-1 h-1 bg-gray-700 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${fitsColor}`} style={{ width: `${barPct}%` }} />
                          </div>
                          <span className={`text-[9px] font-mono w-14 shrink-0 text-right ${labelColor}`}>
                            {approx}{fmtKvSize(pt.kvGb)}
                          </span>
                          <span className={`text-[8px] shrink-0 ${pt.fits ? 'text-gray-700' : 'text-red-500'}`}>
                            {pt.fits ? '✓' : '✗'}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {runway.summary && (
                    <p className="text-[9px] text-gray-600 leading-relaxed mt-1.5">{runway.summary}</p>
                  )}
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
                <div className="pt-2 border-t border-gray-700/50">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-[9px] text-gray-600 uppercase tracking-widest">
                      <Tip text="Bandwidth-aware quantization recommendation. Speed estimates scale observed tok/s by inverse size ratio. Quality deltas now sourced from empirical Perplexity Tax data when available." side="top">
                        Quant Sweet Spot
                      </Tip>
                    </p>
                    {rec.bandwidthGbs != null && (
                      <span
                        className="text-[9px] text-gray-700 font-mono"
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
                </div>
              );
            })()}

            {/* Perplexity Tax — empirical quality cost vs FP16 baseline.
                Renders only when the loaded quant has an entry in the
                bundled perplexity_baseline.json. Falls back silently
                otherwise so we never display fabricated numbers. */}
            {i === 0 && e.quant != null && (() => {
              const cost: QualityCost | null = lookupPerplexity(
                node.ollama_active_model
                  ?? node.vllm_model_name
                  ?? node.llamacpp_model_name
                  ?? null,
                e.quant,
              );
              if (!cost) return null;

              const bandLabel = QUALITY_BAND_LABEL[cost.band];
              const bandTone  = QUALITY_BAND_TONE[cost.band];
              const pplStr = cost.pplDeltaPct === 0
                ? 'lossless'
                : cost.pplDeltaPct < 0.1
                ? '< 0.1%'
                : `+${cost.pplDeltaPct.toFixed(cost.pplDeltaPct < 1 ? 2 : 1)}%`;

              return (
                <div className="pt-2 border-t border-gray-700/50">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-[9px] text-gray-600 uppercase tracking-widest">
                      <Tip
                        text={`Empirical KL divergence vs FP16 baseline from Unsloth Dynamic GGUF benchmarks and llama.cpp perplexity discussions. KLD < 0.001 = empirically indistinguishable from FP16 in blind A/B tests. ${cost.isExactFamily ? `Match: ${cost.matchedFamily}.` : 'No exact family match — using generic baseline (conservative; tends to overstate cost for larger models).'}`}
                        side="top"
                        width="w-72"
                      >
                        Perplexity Tax
                      </Tip>
                    </p>
                    <span className="text-[9px] text-gray-700 font-mono">
                      {cost.isExactFamily ? cost.matchedFamily : 'generic baseline'}
                    </span>
                  </div>
                  <div className="flex items-baseline gap-3 flex-wrap">
                    <span className={`text-[14px] font-bold ${bandTone}`}>{bandLabel}</span>
                    <span className="text-[11px] font-mono text-gray-300">{pplStr} <span className="text-gray-600">PPL vs FP16</span></span>
                    <span className="text-[10px] font-mono text-gray-600">KLD {cost.kld.toExponential(1)}</span>
                  </div>
                  <p className="text-[10px] text-gray-500 leading-relaxed mt-1">
                    {cost.band === 'imperceptible' && `${e.quant} on this model family is empirically indistinguishable from FP16 in blind A/B tests.`}
                    {cost.band === 'mild'          && `${e.quant} adds a small but measurable quality cost. Most users won't notice on general-purpose tasks.`}
                    {cost.band === 'noticeable'    && `${e.quant} is a noticeable quality drop vs FP16. Acceptable for many tasks; inspect output if quality matters.`}
                    {cost.band === 'severe'        && `${e.quant} carries a substantial quality cost — output may show coherence issues. Consider Q4_K_M or higher if headroom allows.`}
                    {cost.band === 'unusable'      && `${e.quant} is empirically unreliable for production use — strongly consider a larger quant.`}
                  </p>
                </div>
              );
            })()}

          </div>
        );
      })}
    </div>
  );
};

export default ModelFitAnalysis;
