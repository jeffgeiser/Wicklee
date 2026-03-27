/**
 * SiliconFitAudit — "How well does this model fit this silicon?"
 *
 * Replaces QuantizationROICard (v0.8.0).
 *
 * Severity-based Fit status derived from WES:
 *   Optimal  (green)  WES > 100
 *   Sub-Optimal (amber) WES ∈ [10, 100]
 *   Poor Fit (red)    WES < 10
 *
 * Features:
 *   - Multi-node selector (pill buttons)
 *   - VRAM savings calculation (FP16 estimated → current quant)
 *   - Plain-English trade-off summary
 *   - W/1K TKN as primary metric, WES as sub-label
 */

import React, { useState } from 'react';
import { Cpu, Activity } from 'lucide-react';
import type { SentinelMetrics } from '../../../types';
import { computeWES } from '../../../utils/wes';
import { getNodePowerW } from '../../../utils/power';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse quantization label from model name if the field is null. */
function parseQuantFromName(modelName: string): string | null {
  const m = modelName.match(/[._-](q\d[\w]*)/i);
  return m ? m[1].toUpperCase() : null;
}

/** Quant family from a label. */
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
 * Approximate VRAM compression ratio for a quant level relative to FP16.
 * These are rough averages across GGUF models.
 */
function quantCompressionRatio(family: string): number {
  switch (family) {
    case 'Q2':  return 0.25;
    case 'Q3':  return 0.35;
    case 'Q4':  return 0.45;
    case 'Q5':  return 0.55;
    case 'Q6':  return 0.65;
    case 'Q8':  return 0.80;
    case 'F16': return 1.0;
    case 'F32': return 2.0;
    default:    return 0.5;
  }
}

/** Parse parameter count from model name (e.g. "llama3.2:3b" → 3). */
function parseParamB(name: string): number | null {
  const m = name.match(/(\d+(?:\.\d+)?)\s*[bB]/);
  return m ? parseFloat(m[1]) : null;
}

type FitLevel = 'optimal' | 'sub-optimal' | 'poor';

function computeFit(wes: number | null): FitLevel {
  if (wes == null) return 'poor';
  if (wes > 100) return 'optimal';
  if (wes >= 10) return 'sub-optimal';
  return 'poor';
}

const FIT_CONFIG: Record<FitLevel, { label: string; color: string; dotColor: string; context: string }> = {
  'optimal':     { label: 'Optimal Fit',     color: 'text-green-400', dotColor: 'bg-green-400', context: 'Perfect architectural balance for this silicon.' },
  'sub-optimal': { label: 'Sub-Optimal Fit', color: 'text-amber-400', dotColor: 'bg-amber-400', context: 'Hardware is underutilized; consider a larger model or higher quantization.' },
  'poor':        { label: 'Poor Fit',        color: 'text-red-400',   dotColor: 'bg-red-400',   context: 'Silicon bottleneck detected. High energy cost per token relative to fleet baseline.' },
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface SiliconFitAuditProps {
  node: SentinelMetrics;
  nodes: SentinelMetrics[];
  onNavigateToPerformance?: () => void;
  /** System idle power (watts) from Settings — subtracted from accelerator power for WES. */
  systemIdleW?: number;
}

// ── Component ─────────────────────────────────────────────────────────────────

const SiliconFitAudit: React.FC<SiliconFitAuditProps> = ({ node: defaultNode, nodes, onNavigateToPerformance, systemIdleW = 0 }) => {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const node = selectedNodeId ? nodes.find(n => n.node_id === selectedNodeId) ?? defaultNode : defaultNode;

  const activeModel = node.ollama_active_model ?? node.vllm_model_name ?? null;

  // ── Empty state ─────────────────────────────────────────────────────────
  if (!activeModel) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Cpu className="w-3.5 h-3.5 text-gray-600 shrink-0" />
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">
            Silicon Fit Audit
          </span>
        </div>
        <p className="text-xs text-gray-600">
          No model loaded — load a model to see silicon fit analysis.
        </p>
      </div>
    );
  }

  // ── Data derivation ─────────────────────────────────────────────────────
  const rawQuant   = node.ollama_quantization ?? parseQuantFromName(activeModel);
  const quantLabel = rawQuant?.toUpperCase() ?? null;
  const family     = quantLabel ? quantFamily(quantLabel) : 'Unknown';

  const tps      = node.ollama_tokens_per_second ?? node.vllm_tokens_per_sec ?? null;
  const rawWatts = getNodePowerW(node);
  // Subtract idle system power so WES reflects inference-attributable efficiency.
  const watts    = rawWatts != null && systemIdleW > 0
    ? Math.max(rawWatts - systemIdleW, 0.1)
    : rawWatts;
  const w1k   = tps != null && watts != null && tps > 0 ? (watts / tps) * 1_000 : null;
  const wes   = tps != null && watts != null && tps > 0 && watts > 0
    ? computeWES(tps, watts, node.thermal_state)
    : null;

  const fit    = computeFit(wes);
  const fitCfg = FIT_CONFIG[fit];

  // VRAM savings: estimate FP16 size, compute delta
  const modelSizeGb   = node.ollama_model_size_gb ?? null;
  const ratio         = quantCompressionRatio(family);
  const fp16Estimate  = modelSizeGb != null && ratio > 0 && ratio < 1.0
    ? modelSizeGb / ratio
    : null;
  const vramSavedGb   = fp16Estimate != null && modelSizeGb != null
    ? fp16Estimate - modelSizeGb
    : null;

  // Model name display
  const [modelBase, modelTag] = activeModel.includes(':')
    ? activeModel.split(':', 2)
    : [activeModel, null];

  const chipName = node.chip_name ?? node.gpu_name ?? 'this chip';

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex flex-col gap-3">

      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Cpu className="w-3.5 h-3.5 text-gray-500 shrink-0" />
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 truncate">
            Silicon Fit Audit
          </span>
        </div>
        <span className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded border text-green-400 bg-green-500/10 border-green-500/25 shrink-0 flex items-center gap-1">
          <Activity className="w-2.5 h-2.5 animate-pulse" />
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

      {/* Node Picker — segmented pill buttons */}
      {nodes.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {nodes.map(n => {
            const isSelected = (selectedNodeId ?? defaultNode.node_id) === n.node_id;
            return (
              <button
                key={n.node_id}
                onClick={() => setSelectedNodeId(n.node_id === defaultNode.node_id && !selectedNodeId ? null : n.node_id)}
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

      {/* Fit Status */}
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full shrink-0 ${fitCfg.dotColor} ${fit === 'poor' ? 'animate-pulse' : ''}`} />
        <span className={`text-xs font-semibold ${fitCfg.color}`}>{fitCfg.label}</span>
      </div>

      {/* Metrics row — W/1K TKN primary, WES + tok/s secondary */}
      <div className="grid grid-cols-3 gap-2">
        {/* W/1K TKN — primary efficiency metric */}
        <div>
          <p className="text-[9px] text-gray-600 uppercase tracking-widest mb-0.5">W/1K Tkn</p>
          <p className="font-telin text-sm text-gray-200">
            {w1k != null ? `${w1k.toFixed(1)}W` : <span className="text-gray-600">—</span>}
          </p>
        </div>
        {/* TOK/S */}
        <div>
          <p className="text-[9px] text-gray-600 uppercase tracking-widest mb-0.5">Tok/s</p>
          <p className="font-telin text-sm text-gray-200">
            {tps != null ? tps.toFixed(1) : <span className="text-gray-600">—</span>}
          </p>
        </div>
        {/* WES — sub-label */}
        <div>
          <p className="text-[9px] text-gray-600 uppercase tracking-widest mb-0.5">WES</p>
          <p className={`font-telin text-sm ${wes != null
            ? wes >= 100 ? 'text-green-400' : wes >= 10 ? 'text-amber-400' : 'text-red-400'
            : 'text-gray-600'
          }`}>
            {wes != null ? wes.toFixed(1) : '—'}
          </p>
        </div>
      </div>

      {/* VRAM Savings — plain English */}
      {vramSavedGb != null && vramSavedGb > 0 && (
        <p className="text-[11px] text-gray-400 leading-snug">
          Saving <span className="text-cyan-400 font-semibold">{vramSavedGb.toFixed(1)} GB</span> VRAM via {quantLabel ?? 'quantization'} on {chipName}.
          {family === 'Q4' && ' Minimal intelligence loss for instruction-following and chat.'}
          {family === 'Q5' && ' Near-lossless quality with significant memory savings.'}
          {family === 'Q8' && ' Near-lossless — consider Q4_K_M to free ~50% more VRAM.'}
        </p>
      )}

      {/* Fit context */}
      <p className="text-[10px] text-gray-600 leading-relaxed">{fitCfg.context}</p>

    </div>
  );
};

export default SiliconFitAudit;
