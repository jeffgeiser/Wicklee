/**
 * MemoryExhaustionCard — Tier 1 Active Alert
 *
 * Condition: memory headroom < 10% of total AND a model is loaded.
 * Uses same NVIDIA/unified-memory detection logic as computeModelFitScore.
 * Not dismissable. Disappears when headroom recovers or model unloads.
 */

import React from 'react';
import type { SentinelMetrics } from '../../../types';
import { INFERENCE_VRAM_THRESHOLD_MB } from '../../../utils/efficiency';
import InsightCard from '../InsightCard';

// ── Memory helpers ────────────────────────────────────────────────────────────

interface MemorySnapshot {
  headroomGb:  number;
  headroomPct: number;
  totalGb:     number;
  modelSizeGb: number;
  modelName:   string;
  isNvidia:    boolean;
}

function getMemorySnapshot(node: SentinelMetrics): MemorySnapshot | null {
  const modelSizeGb = node.ollama_model_size_gb ?? null;
  if (modelSizeGb == null) return null;

  const isNvidia = (node.nvidia_vram_total_mb ?? 0) >= INFERENCE_VRAM_THRESHOLD_MB;

  const totalMb = isNvidia ? node.nvidia_vram_total_mb! : node.total_memory_mb;
  const usedMb: number | null = isNvidia
    ? node.nvidia_vram_used_mb
    : node.total_memory_mb - node.available_memory_mb;

  if (usedMb == null || totalMb <= 0) return null;

  const headroomMb  = totalMb - usedMb;
  const headroomPct = (headroomMb / totalMb) * 100;

  return {
    headroomGb:  headroomMb / 1024,
    headroomPct,
    totalGb:     totalMb   / 1024,
    modelSizeGb,
    modelName:   node.ollama_active_model ?? 'active model',
    isNvidia,
  };
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  node: SentinelMetrics;
  showNodeHeader?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

const MemoryExhaustionCard: React.FC<Props> = ({ node, showNodeHeader = false }) => {
  const snap = getMemorySnapshot(node);

  // Guard: model must be loaded AND headroom < 10%
  if (!snap || snap.headroomPct >= 10) return null;

  const titleSuffix = showNodeHeader ? ` · ${node.node_id}` : '';
  const memLabel    = snap.isNvidia ? 'VRAM' : 'unified memory';

  return (
    <InsightCard
      id="memory-exhaustion"
      nodeId={node.node_id}
      tier={1}
      severity="red"
      title={`Memory Exhaustion Imminent${titleSuffix}`}
    >
      <div className="px-5 py-4 space-y-3">

        {/* ── Memory status line ───────────────────────────────────────────── */}
        <div className="flex items-center gap-2 text-sm flex-wrap">
          <span className="font-telin text-red-400">{snap.headroomGb.toFixed(1)} GB</span>
          <span className="text-gray-500">free {memLabel} ·</span>
          <span className="font-mono text-gray-300 text-xs">{snap.modelName}</span>
          <span className="text-gray-500">requires ~</span>
          <span className="font-telin text-gray-300">{snap.modelSizeGb.toFixed(1)} GB</span>
        </div>

        {/* ── Description ──────────────────────────────────────────────────── */}
        <p className="text-sm text-gray-400 leading-relaxed">
          Only{' '}
          <span className="font-telin text-red-400">{snap.headroomGb.toFixed(1)} GB</span>
          {' '}remaining — swap risk is imminent. Tok/s will collapse when the OS
          begins swapping model weights to disk.
        </p>

        {/* ── Hostname (fleet mode only) ───────────────────────────────────── */}
        {showNodeHeader && node.hostname && node.hostname !== node.node_id && (
          <p className="text-xs text-gray-500 font-mono">{node.hostname}</p>
        )}

        {/* ── Recommendations ──────────────────────────────────────────────── */}
        <div className="pt-1 border-t border-gray-700">
          <p className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold mb-1.5">
            Recommended
          </p>
          <p className="text-xs text-gray-400">
            Unload model · Switch to smaller quantization · Free system memory
          </p>
        </div>

      </div>
    </InsightCard>
  );
};

export default MemoryExhaustionCard;
