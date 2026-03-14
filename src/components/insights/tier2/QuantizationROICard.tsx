/**
 * QuantizationROICard — Tier 2 Insight (Community+)
 *
 * Live snapshot of quantization efficiency from current SSE telemetry.
 * Computes tok/s, W/1K TKN, and WES from the active SSE frame.
 * Educational copy is quant-level-aware — gives the user a concrete
 * trade-off statement for the quant they are currently running.
 *
 * Historical comparison across quantizations is a Team feature.
 * This card shows the live snapshot; the trend chart is teased via InsightsTeaseCard.
 *
 * Data sources (all live SSE — no historical DB required):
 *   ollama_active_model         → model name
 *   ollama_quantization         → quant level label (Q4_K_M, Q8_0, F16 …)
 *   ollama_tokens_per_second    → raw tok/s from current probe
 *   cpu_power_w / nvidia_power_draw_w → watts
 *   thermal_state               → penalty factor for WES
 */

import React from 'react';
import { Scale } from 'lucide-react';
import type { SentinelMetrics } from '../../../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse quantization label from model name if the field is null. */
function parseQuantFromName(modelName: string): string | null {
  // Matches common patterns: phi3:mini:q4_k_m, llama3.2:3b-q4_K_M, etc.
  const m = modelName.match(/[._-](q\d[\w]*)/i);
  return m ? m[1].toUpperCase() : null;
}

/** Quant family from a label, e.g. "Q4_K_M" → "Q4", "Q8_0" → "Q8", "F16" → "F16". */
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

/** Educational copy keyed by quant family. */
const QUANT_COPY: Record<string, { headline: string; detail: string }> = {
  Q2: {
    headline: 'Maximum compression, noticeable quality drop.',
    detail:   'Q2 uses ~75% less VRAM vs Q8, but expect measurable reasoning degradation. Good for fast prototyping on memory-constrained hardware.',
  },
  Q3: {
    headline: 'Very compressed — quality varies by model.',
    detail:   'Q3 reduces VRAM by ~60% vs Q8. Acceptable for some instruction-tuned models; avoid for coding or math-heavy tasks.',
  },
  Q4: {
    headline: 'Sweet spot: ~50% less VRAM vs Q8 at 10–15% throughput cost.',
    detail:   'Q4_K_M is the recommended default for most use cases. Minimal quality loss for instruction-following and chat.',
  },
  Q5: {
    headline: 'Near-lossless quality with significant VRAM savings.',
    detail:   'Q5 is a strong choice when Q8 fills VRAM. The trade-off is slightly higher inference latency.',
  },
  Q6: {
    headline: 'High fidelity — VRAM savings start to diminish.',
    detail:   'Q6 is near-identical to Q8 in output quality. Choose Q6 when VRAM is tight but Q8 almost fits.',
  },
  Q8: {
    headline: 'Near-lossless. Consider Q4_K_M to free ~50% VRAM.',
    detail:   'Q8 gives maximum accuracy at the cost of VRAM. If you have headroom, keep it. If not, Q4_K_M is the best alternative.',
  },
  F16: {
    headline: 'Full precision — maximum quality, maximum VRAM.',
    detail:   'F16 is for research or production deployments where accuracy is critical. Use Q8 or Q4_K_M for most workloads.',
  },
  F32: {
    headline: 'Double precision — exceptionally high VRAM usage.',
    detail:   'F32 is rarely needed at inference time. Use F16 or Q8 unless a specific evaluation workflow requires full double precision.',
  },
  Unknown: {
    headline: 'Quantization level could not be determined.',
    detail:   'Load time and VRAM usage depend on the quantization. Check the model name for a Q4/Q8/F16 suffix.',
  },
};

function computeWes(tps: number, watts: number, thermalState: string | null): number {
  const th = thermalState?.toLowerCase() ?? 'normal';
  const penalty = th === 'critical' || th === 'serious' ? 2.0 : th === 'fair' ? 1.25 : 1.0;
  return tps / (watts * penalty);
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface QuantizationROICardProps {
  /** Primary node — provides the model + metrics for the snapshot. */
  node: SentinelMetrics;
  /** All effective nodes — used for fleet-level annotations when multi-node. */
  nodes: SentinelMetrics[];
}

// ── Component ─────────────────────────────────────────────────────────────────

const QuantizationROICard: React.FC<QuantizationROICardProps> = ({ node }) => {
  const activeModel = node.ollama_active_model ?? null;

  // ── Empty state ─────────────────────────────────────────────────────────
  if (!activeModel) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Scale className="w-3.5 h-3.5 text-gray-600 shrink-0" />
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">
            Quantization ROI
          </span>
        </div>
        <p className="text-xs text-gray-600">
          No model loaded — load a model to see efficiency metrics.
        </p>
        <button className="text-xs text-indigo-500 hover:text-indigo-400 transition-colors text-left opacity-50 cursor-default">
          Compare quantizations over time on Team →
        </button>
      </div>
    );
  }

  // ── Data derivation ─────────────────────────────────────────────────────
  const rawQuant   = node.ollama_quantization ?? parseQuantFromName(activeModel);
  const quantLabel = rawQuant?.toUpperCase() ?? null;
  const family     = quantLabel ? quantFamily(quantLabel) : 'Unknown';
  const copy       = QUANT_COPY[family] ?? QUANT_COPY.Unknown;

  const tps    = node.ollama_tokens_per_second ?? null;
  const watts  = node.cpu_power_w ?? node.nvidia_power_draw_w ?? null;
  const w1k    = tps != null && watts != null && tps > 0 ? (watts / tps) * 1_000 : null;
  const wes    = tps != null && watts != null && tps > 0 && watts > 0
    ? computeWes(tps, watts, node.thermal_state)
    : null;

  // ── Model name display — truncate tag after colon for readability ───────
  const [modelBase, modelTag] = activeModel.includes(':')
    ? activeModel.split(':', 2)
    : [activeModel, null];

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex flex-col gap-3">

      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Scale className="w-3.5 h-3.5 text-gray-500 shrink-0" />
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 truncate">
            Quantization ROI
          </span>
        </div>
        <span className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded border text-green-400 bg-green-500/10 border-green-500/25 shrink-0">
          Live
        </span>
      </div>

      {/* Model name + quant badge */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-xs text-gray-200">
          {modelBase}
          {modelTag && <span className="text-gray-500">:{modelTag}</span>}
        </span>
        {quantLabel && (
          <span className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700 text-cyan-400">
            {quantLabel}
          </span>
        )}
      </div>

      {/* Metrics row */}
      <div className="grid grid-cols-3 gap-2">
        {/* TOK/S */}
        <div>
          <p className="text-[9px] text-gray-600 uppercase tracking-widest mb-0.5">Tok/s</p>
          <p className="font-telin text-sm text-gray-200">
            {tps != null ? tps.toFixed(1) : <span className="text-gray-600">—</span>}
          </p>
        </div>
        {/* W/1K TKN */}
        <div>
          <p className="text-[9px] text-gray-600 uppercase tracking-widest mb-0.5">W/1K Tkn</p>
          <p className="font-telin text-sm text-gray-200">
            {w1k != null ? `${w1k.toFixed(1)}W` : <span className="text-gray-600">—</span>}
          </p>
        </div>
        {/* WES */}
        <div>
          <p className="text-[9px] text-gray-600 uppercase tracking-widest mb-0.5">WES</p>
          <p className={`font-telin text-sm ${wes != null
            ? wes >= 3 ? 'text-green-400' : wes >= 1.5 ? 'text-amber-400' : 'text-red-400'
            : 'text-gray-600'
          }`}>
            {wes != null ? wes.toFixed(1) : '—'}
          </p>
        </div>
      </div>

      {/* Educational copy */}
      <div className="space-y-1">
        <p className="text-[11px] text-gray-400 font-medium leading-snug">{copy.headline}</p>
        <p className="text-[10px] text-gray-600 leading-relaxed">{copy.detail}</p>
      </div>

      {/* Team upgrade CTA */}
      <button className="text-xs text-indigo-500 hover:text-indigo-400 transition-colors text-left">
        Compare quantizations over time on Team →
      </button>

    </div>
  );
};

export default QuantizationROICard;
