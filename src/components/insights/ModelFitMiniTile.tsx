/**
 * ModelFitMiniTile — compact 2-across model fit tile.
 *
 * Shows model name + fit dot + score label + thin VRAM bar.
 * Replaces full-width ModelFitInsightCard in the Triage tab.
 */

import React from 'react';
import type { SentinelMetrics } from '../../types';
import type { FitResult, FitScore } from '../../utils/modelFit';

const DOT_COLOR: Record<FitScore, string> = {
  good: 'bg-green-500',
  fair: 'bg-amber-500',
  poor: 'bg-red-500',
};

const LABEL_COLOR: Record<FitScore, string> = {
  good: 'text-green-400',
  fair: 'text-amber-400',
  poor: 'text-red-400',
};

interface ModelFitMiniTileProps {
  result:          FitResult;
  node:            SentinelMetrics;
  showNodeHeader?: boolean;
}

const ModelFitMiniTile: React.FC<ModelFitMiniTileProps> = ({ result, node, showNodeHeader = false }) => {
  const modelName = node.ollama_active_model ?? 'Unknown model';

  // Memory bar segments as % of totalGb
  const usedGb      = result.totalGb - result.headroomGb;
  const otherUsedGb = Math.max(0, usedGb - result.modelSizeGb);
  const modelBarPct = Math.min((result.modelSizeGb / result.totalGb) * 100, 100);
  const usedBarPct  = Math.min((otherUsedGb / result.totalGb) * 100, 100 - modelBarPct);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl px-3 py-2.5 space-y-1.5">
      {/* Row 1: model name + fit indicator */}
      <div className="flex items-center gap-2 min-w-0">
        <span className={`shrink-0 w-2 h-2 rounded-full ${DOT_COLOR[result.score]}`} />
        <span className="text-xs text-gray-200 truncate flex-1 font-medium">{modelName}</span>
        <span className={`text-[9px] font-bold uppercase tracking-wide shrink-0 ${LABEL_COLOR[result.score]}`}>
          {result.score}
        </span>
      </div>

      {/* Row 2: node hostname (fleet mode) */}
      {showNodeHeader && (
        <p className="text-[9px] text-gray-600 truncate">
          {node.hostname && node.hostname !== node.node_id ? node.hostname : node.node_id}
        </p>
      )}

      {/* Row 3: thin VRAM bar */}
      <div className="flex items-center gap-2">
        <div className="h-[3px] flex-1 bg-gray-800 rounded-full overflow-hidden flex">
          <div
            className="h-full bg-indigo-500/80"
            style={{ width: `${modelBarPct}%` }}
          />
          {usedBarPct > 0.5 && (
            <div
              className="h-full bg-gray-500/50"
              style={{ width: `${usedBarPct}%` }}
            />
          )}
        </div>
        <span className="text-[9px] font-mono text-gray-600 shrink-0">
          {result.headroomGb.toFixed(1)}GB free
        </span>
      </div>
    </div>
  );
};

export default ModelFitMiniTile;
