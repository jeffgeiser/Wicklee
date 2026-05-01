/**
 * PowerAnomalyCard — Tier 1 Active Alert
 *
 * Condition (either):
 *   A) current watts > session baseline × 2  (requires baselineWatts != null)
 *   B) current watts > 50 AND gpu utilization < 20%
 *
 * baselineWatts is the rolling average of the first 10 watt readings,
 * computed in AIInsights.tsx and passed down. Pass null for fleet mode —
 * only condition B fires when baseline is unavailable.
 *
 * Not dismissable. Disappears when condition resolves.
 */

import React from 'react';
import type { SentinelMetrics } from '../../../types';
import InsightCard from '../InsightCard';
import { getNodePowerW } from '../../../utils/power';

// ── Power helpers ─────────────────────────────────────────────────────────────

/** Returns the active board/CPU power watts for a node. */
function currentWatts(node: SentinelMetrics): number | null {
  return getNodePowerW(node);
}

/** Returns the active GPU utilization % for a node. */
function gpuUtil(node: SentinelMetrics): number | null {
  return node.gpu_utilization_percent ?? node.nvidia_gpu_utilization_percent ?? null;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  node:           SentinelMetrics;
  baselineWatts:  number | null;
  showNodeHeader?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

const PowerAnomalyCard: React.FC<Props> = ({ node, baselineWatts, showNodeHeader = false }) => {
  const watts = currentWatts(node);
  const util  = gpuUtil(node);

  if (watts == null) return null;

  const conditionA = baselineWatts != null && watts > baselineWatts * 2;
  const conditionB = watts > 50 && util != null && util < 20;

  if (!conditionA && !conditionB) return null;

  const titleSuffix = showNodeHeader ? ` · ${node.node_id}` : '';
  const utilLabel   = util != null ? `${util.toFixed(0)}%` : 'low';

  return (
    <InsightCard
      id="power-anomaly"
      nodeId={node.node_id}
      tier={1}
      severity="red"
      title={`Power Anomaly Detected${titleSuffix}`}
    >
      <div className="px-5 py-4 space-y-3">

        {/* ── Watts + GPU line ─────────────────────────────────────────────── */}
        <div className="flex items-center gap-2 text-sm flex-wrap">
          <span className="font-telin text-red-400">{watts.toFixed(1)} W</span>
          <span className="text-gray-500">at</span>
          <span className="font-telin text-gray-300">{utilLabel}</span>
          <span className="text-gray-500">GPU utilization</span>
          {conditionA && baselineWatts != null && (
            <span className="text-gray-600 text-xs">
              ({(watts / baselineWatts).toFixed(1)}× session baseline)
            </span>
          )}
        </div>

        {/* ── Description ──────────────────────────────────────────────────── */}
        <p className="text-sm text-gray-400 leading-relaxed">
          This node is drawing{' '}
          <span className="font-telin text-gray-300">{watts.toFixed(1)} W</span>
          {' '}with only{' '}
          <span className="font-telin text-gray-300">{utilLabel}</span>
          {' '}GPU utilization. Something is consuming power that isn&apos;t
          inference work — background process, memory leak, or runaway job.
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
            Check running processes · Restart inference runtime · Monitor for
            sustained anomaly
          </p>
        </div>

      </div>
    </InsightCard>
  );
};

export default PowerAnomalyCard;
