/**
 * IdleResourceCard — Tier 2 Insight
 *
 * Two fire paths, both backed by historical data:
 *
 *   Cloud path  (dutyPct provided):
 *     Fires when a node's 24h inference duty cycle is below IDLE_DUTY_THRESHOLD (5%).
 *     Uses data from /api/fleet/duty — historical DuckDB aggregates, not session time.
 *
 *   Localhost path  (idleSinceMs provided):
 *     Fires when inference_state has been non-live for ≥ 60 continuous minutes.
 *     idleSinceMs is pre-seeded from /api/history on mount, so it fires immediately
 *     for nodes that were idle before the page loaded.
 *
 * Idle cost formula:  watts × PUE × (kwhRate / 1000)  per hour.
 */

import React from 'react';
import type { SentinelMetrics } from '../../../types';
import InsightCard from '../InsightCard';
import { getNodePowerW } from '../../../utils/power';

// ── Constants ─────────────────────────────────────────────────────────────────

const ONE_HOUR_MS         = 60 * 60 * 1_000;
/** Nodes with 24h duty below this threshold trigger the card (cloud path). */
const IDLE_DUTY_THRESHOLD = 5; // percent

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const hours   = Math.floor(ms / ONE_HOUR_MS);
  const minutes = Math.floor((ms % ONE_HOUR_MS) / 60_000);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

interface CostDisplay {
  perHr:  string;
  perDay: string;
}

function computeCost(node: SentinelMetrics, kwhRate: number, pue: number): CostDisplay | null {
  const watts = getNodePowerW(node);
  if (watts == null) return null;
  const hr = watts * pue * (kwhRate / 1000);
  return {
    perHr:  hr < 0.01  ? hr.toFixed(3) : hr.toFixed(2),
    perDay: (hr * 24) < 0.01 ? (hr * 24).toFixed(3) : (hr * 24).toFixed(2),
  };
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  node:            SentinelMetrics;
  /**
   * Cloud path: 24h inference duty cycle (0–100).
   * When provided, fires when dutyPct < IDLE_DUTY_THRESHOLD.
   */
  dutyPct?:        number | null;
  /**
   * Localhost path: timestamp (ms) when idle state began.
   * When provided (and dutyPct is absent), fires when ≥ 60 min old.
   */
  idleSinceMs?:    number | null;
  kwhRate:         number;
  pue:             number;
  /** When true, always show node hostname in title and recommendation text. */
  showNodeHeader?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

const IdleResourceCard: React.FC<Props> = ({
  node,
  dutyPct,
  idleSinceMs,
  kwhRate,
  pue,
  showNodeHeader = false,
}) => {
  const titleSuffix  = showNodeHeader ? ` · ${node.hostname ?? node.node_id}` : '';
  const nodeName     = node.hostname ?? node.node_id;
  const suspendLabel = showNodeHeader ? nodeName : 'this node';
  const cost         = computeCost(node, kwhRate, pue);

  // ── Cloud path (duty-based) ──────────────────────────────────────────────
  if (dutyPct != null) {
    if (dutyPct >= IDLE_DUTY_THRESHOLD) return null;

    return (
      <InsightCard
        id="idle-resource"
        nodeId={node.node_id}
        tier={2}
        severity="amber"
        title={`Idle Resource Notice${titleSuffix}`}
      >
        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-gray-400">
            Only{' '}
            <span className="font-telin text-gray-300">{dutyPct.toFixed(1)}%</span>
            {' '}inference duty in the last 24 hours.
          </p>

          {cost != null && (
            <p className="text-sm text-gray-400">
              Estimated idle cost:{' '}
              <span className="font-telin text-amber-400">${cost.perHr}/hr</span>
              <span className="text-gray-500 mx-1">·</span>
              <span className="font-telin text-amber-300/70">${cost.perDay}/day</span>
              <span className="text-gray-600 text-xs ml-1">
                at ${kwhRate}/kWh · PUE {pue}
              </span>
            </p>
          )}

          <div className="pt-1 border-t border-gray-700">
            <p className="text-xs text-gray-500">
              Consider suspending{' '}
              <span className="text-gray-400">{suspendLabel}</span>
              {' '}if inference is not needed.
            </p>
          </div>
        </div>
      </InsightCard>
    );
  }

  // ── Localhost path (idle-since tracking) ─────────────────────────────────
  if (idleSinceMs == null) return null;
  const idleMs = Date.now() - idleSinceMs;
  if (idleMs < ONE_HOUR_MS) return null;

  return (
    <InsightCard
      id="idle-resource"
      nodeId={node.node_id}
      tier={2}
      severity="amber"
      title={`Idle Resource Notice${titleSuffix}`}
    >
      <div className="px-5 py-4 space-y-3">
        <p className="text-sm text-gray-400">
          No inference activity for{' '}
          <span className="font-telin text-gray-300">{formatDuration(idleMs)}</span>.
        </p>

        {cost != null && (
          <p className="text-sm text-gray-400">
            Estimated idle cost:{' '}
            <span className="font-telin text-amber-400">${cost.perHr}/hr</span>
            <span className="text-gray-500 mx-1">·</span>
            <span className="font-telin text-amber-300/70">${cost.perDay}/day</span>
            <span className="text-gray-600 text-xs ml-1">
              at ${kwhRate}/kWh · PUE {pue}
            </span>
          </p>
        )}

        <div className="pt-1 border-t border-gray-700">
          <p className="text-xs text-gray-500">
            Consider suspending{' '}
            <span className="text-gray-400">{suspendLabel}</span>
            {' '}if inference is not needed.
          </p>
        </div>
      </div>
    </InsightCard>
  );
};

export default IdleResourceCard;
