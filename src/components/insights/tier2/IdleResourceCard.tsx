/**
 * IdleResourceCard — Tier 2 Insight
 *
 * Condition:
 *   - Session uptime ≥ 1 hour (from first SSE message received)
 *   - No tok/s activity observed at any point this session
 *
 * `sessionStartMs` = timestamp of first SSE frame (passed from AIInsights).
 * `hadAnyActivity` = set to true when tok/s > 0 was ever seen (passed from AIInsights).
 *
 * Idle cost uses the per-node kWhRate and PUE from getNodeSettings().
 * Dismissable per session.
 */

import React from 'react';
import type { SentinelMetrics } from '../../../types';
import InsightCard from '../InsightCard';
import { getNodePowerW } from '../../../utils/power';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ONE_HOUR_MS = 60 * 60 * 1_000;

/** Watts to display for idle cost calculation. */
function idleWatts(node: SentinelMetrics): number | null {
  return getNodePowerW(node);
}

/** Format duration as "Xh Ym". */
function formatDuration(ms: number): string {
  const hours   = Math.floor(ms / ONE_HOUR_MS);
  const minutes = Math.floor((ms % ONE_HOUR_MS) / 60_000);
  return `${hours}h ${minutes}m`;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  node:            SentinelMetrics;
  /**
   * Timestamp of the last tok/s > 0 observation for this node.
   * Initialised to session-start time (or node-first-seen time for fleet nodes)
   * so that a node that never infers counts as "idle since first seen".
   */
  lastActiveTsMs:  number;
  kwhRate:         number;
  pue:             number;
  showNodeHeader?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

const IdleResourceCard: React.FC<Props> = ({
  node,
  lastActiveTsMs,
  kwhRate,
  pue,
  showNodeHeader = false,
}) => {
  // Guard: must have had no inference activity for ≥ 60 continuous minutes.
  // Fires even if the node was active earlier — the clock resets on each tok/s > 0.
  const idleMs = Date.now() - lastActiveTsMs;
  if (idleMs < ONE_HOUR_MS) return null;

  const watts        = idleWatts(node);
  const titleSuffix  = showNodeHeader ? ` · ${node.node_id}` : '';
  const duration     = formatDuration(idleMs);

  // Idle cost per hour: watts × PUE × (kwhRate / 1000)
  const costPerHr    = watts != null
    ? (watts * pue * (kwhRate / 1000)).toFixed(3)
    : null;

  return (
    <InsightCard
      id="idle-resource"
      nodeId={node.node_id}
      tier={2}
      severity="amber"
      title={`Idle Resource Notice${titleSuffix}`}
    >
      <div className="px-5 py-4 space-y-3">

        {/* ── Duration line ────────────────────────────────────────────────── */}
        <p className="text-sm text-gray-400">
          No inference activity for{' '}
          <span className="font-telin text-gray-300">{duration}</span>.
        </p>

        {/* ── Idle cost ────────────────────────────────────────────────────── */}
        {costPerHr != null && (
          <div className="flex items-center gap-2">
            <p className="text-sm text-gray-400">
              Estimated idle cost:{' '}
              <span className="font-telin text-amber-400">${costPerHr}/hr</span>
              <span className="text-gray-600 text-xs ml-1">
                at ${kwhRate}/kWh · PUE {pue}
              </span>
            </p>
          </div>
        )}

        {/* ── Recommendation ───────────────────────────────────────────────── */}
        <div className="pt-1 border-t border-gray-800">
          <p className="text-xs text-gray-500">
            Consider suspending this node if inference is not needed.
          </p>
        </div>

      </div>
    </InsightCard>
  );
};

export default IdleResourceCard;
