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
  if (wes > 10) return 'optimal';
  if (wes >= 3) return 'sub-optimal';
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

  // Build list of models to analyze — prefer active_models when available
  const multiModels = node.active_models && node.active_models.length > 0
    ? node.active_models
    : null;
  const primaryModel = node.ollama_active_model ?? node.vllm_model_name ?? null;

  // ── Empty state ─────────────────────────────────────────────────────────
  if (!primaryModel && !multiModels) {
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

  const chipName = node.chip_name ?? node.gpu_name ?? 'this chip';
  const rawWatts = getNodePowerW(node);
  const adjWatts = rawWatts != null && systemIdleW > 0 ? Math.max(rawWatts - systemIdleW, 0.1) : rawWatts;

  // Helper: derive fit data for a single model entry
  const deriveModelFit = (modelName: string, tps: number | null, modelWes: number | null, quantRaw: string | null, sizeGb: number | null) => {
    const quant = quantRaw?.toUpperCase() ?? parseQuantFromName(modelName)?.toUpperCase() ?? null;
    const family = quant ? quantFamily(quant) : 'Unknown';
    const w1k = tps != null && adjWatts != null && tps > 0 ? (adjWatts / tps) * 1_000 : null;
    const wes = modelWes ?? (tps != null && adjWatts != null && tps > 0 && adjWatts > 0 ? computeWES(tps, adjWatts, node.thermal_state) : null);
    const fit = computeFit(wes);
    const ratio = quantCompressionRatio(family);
    const fp16Est = sizeGb != null && ratio > 0 && ratio < 1.0 ? sizeGb / ratio : null;
    const vramSaved = fp16Est != null && sizeGb != null ? fp16Est - sizeGb : null;
    const [base, tag] = modelName.includes(':') ? modelName.split(':', 2) : [modelName, null as string | null];
    return { modelName, base, tag, quant, family, tps, w1k, wes, fit, fitCfg: FIT_CONFIG[fit], vramSaved };
  };

  // Build entries — one per loaded model
  const entries = multiModels
    ? multiModels.map(am => deriveModelFit(am.model, am.tok_s ?? null, am.wes ?? null, am.quantization ?? null, am.size_gb ?? null))
    : primaryModel
      ? [deriveModelFit(primaryModel, node.ollama_tokens_per_second ?? node.vllm_tokens_per_sec ?? null, null, node.ollama_quantization ?? null, node.ollama_model_size_gb ?? null)]
      : [];

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex flex-col gap-3">

      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Cpu className="w-3.5 h-3.5 text-gray-500 shrink-0" />
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 truncate">
            Silicon Fit Audit{entries.length > 1 ? ` · ${entries.length} Models` : ''}
          </span>
        </div>
        <span className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded border text-green-400 bg-green-500/10 border-green-500/25 shrink-0 flex items-center gap-1">
          <Activity className="w-2.5 h-2.5 animate-pulse" />
          Live
        </span>
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

      {/* Per-model fit cards */}
      {entries.map((e, i) => (
        <div key={e.modelName} className={entries.length > 1 && i > 0 ? 'pt-3 border-t border-gray-800/50' : ''}>
          {/* Model name + quant badge + fit status */}
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <span className={`w-2 h-2 rounded-full shrink-0 ${e.fitCfg.dotColor} ${e.fit === 'poor' ? 'animate-pulse' : ''}`} />
            <span className="font-mono text-xs text-gray-200">
              {e.base}
              {e.tag && <span className="text-gray-500">:{e.tag}</span>}
            </span>
            {e.quant && (
              <span className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700 text-cyan-400">
                {e.quant}
              </span>
            )}
            <span className={`text-[10px] font-semibold ${e.fitCfg.color} ml-auto`}>{e.fitCfg.label}</span>
          </div>

          {/* Metrics row */}
          <div className="grid grid-cols-3 gap-2">
            <div>
              <p className="text-[9px] text-gray-600 uppercase tracking-widest mb-0.5">W/1K Tkn</p>
              <p className="font-telin text-sm text-gray-200">
                {e.w1k != null ? `${e.w1k.toFixed(1)}W` : <span className="text-gray-600">—</span>}
              </p>
            </div>
            <div>
              <p className="text-[9px] text-gray-600 uppercase tracking-widest mb-0.5">Tok/s</p>
              <p className="font-telin text-sm text-gray-200">
                {e.tps != null ? e.tps.toFixed(1) : <span className="text-gray-600">—</span>}
              </p>
            </div>
            <div>
              <p className="text-[9px] text-gray-600 uppercase tracking-widest mb-0.5">WES</p>
              <p className={`font-telin text-sm ${e.wes != null
                ? e.wes >= 100 ? 'text-green-400' : e.wes >= 10 ? 'text-amber-400' : 'text-red-400'
                : 'text-gray-600'
              }`}>
                {e.wes != null ? e.wes.toFixed(1) : '—'}
              </p>
            </div>
          </div>

          {/* VRAM Savings — plain English */}
          {e.vramSaved != null && e.vramSaved > 0 && (
            <p className="text-[11px] text-gray-400 leading-snug mt-1.5">
              Saving <span className="text-cyan-400 font-semibold">{e.vramSaved.toFixed(1)} GB</span> VRAM via {e.quant ?? 'quantization'} on {chipName}.
              {e.family === 'Q4' && ' Minimal intelligence loss for instruction-following and chat.'}
              {e.family === 'Q5' && ' Near-lossless quality with significant memory savings.'}
              {e.family === 'Q8' && ' Near-lossless — consider Q4_K_M to free ~50% more VRAM.'}
            </p>
          )}

          {/* Fit context (only on single model or last entry to avoid repetition) */}
          {(entries.length === 1 || i === entries.length - 1) && (
            <p className="text-[10px] text-gray-600 leading-relaxed mt-1">{e.fitCfg.context}</p>
          )}
        </div>
      ))}

    </div>
  );
};

export default SiliconFitAudit;
