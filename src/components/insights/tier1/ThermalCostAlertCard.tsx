/**
 * ThermalCostAlertCard — Tier 1 WES Platform Alert
 *
 * Fires when Thermal Cost % exceeds 10% and the node is NOT already in
 * Serious/Critical thermal state (those nodes are covered by ThermalDegradationCard).
 * This card is the early-warning surface for "Fair" thermal state — catching
 * efficiency creep before it becomes a full throttle event.
 *
 * Severity thresholds:
 *   Info     TC% > 10%  : amber  — running below hardware ceiling
 *   Warning  TC% > 25%  : orange — significant overhead
 *   Critical TC% > 40%  : red    — severe loss, consider rerouting
 *
 * Rate-of-change escalation: if TC% rose ≥ 15pp in the recent rolling window,
 * severity escalates one level. A spike from 5% → 20% in 2 minutes is more
 * urgent than a steady 20%.
 *
 * TC% = (RawWES − PenalizedWES) / RawWES × 100
 */

import React from 'react';
import { Flame } from 'lucide-react';
import type { SentinelMetrics } from '../../../types';
import InsightCard from '../InsightCard';

// ── Severity logic ─────────────────────────────────────────────────────────────

type TCSeverity = 'info' | 'warning' | 'critical';

function getSeverity(tcPct: number, rateOfChangePct: number): TCSeverity {
  // Rate-of-change escalation: a ≥15pp rise in the recent window bumps severity up one level.
  const escalated = rateOfChangePct >= 15;
  if (tcPct >= 40 || (escalated && tcPct >= 25)) return 'critical';
  if (tcPct >= 25 || (escalated && tcPct >= 10)) return 'warning';
  return 'info';
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  node: SentinelMetrics;
  /** Thermal Cost % — caller guarantees > 10 and thermal_state not Serious/Critical */
  tcPct: number;
  /** How much TC% rose in the recent rolling window (positive = worsening). */
  rateOfChangePct?: number;
  showNodeHeader?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

const ThermalCostAlertCard: React.FC<Props> = ({
  node,
  tcPct,
  rateOfChangePct = 0,
  showNodeHeader = false,
}) => {
  const severity    = getSeverity(tcPct, rateOfChangePct);
  const cardSeverity = severity === 'critical' ? 'red' : 'amber';
  const titleSuffix  = showNodeHeader ? ` · ${node.hostname ?? node.node_id}` : '';

  const titleLabel =
    severity === 'critical' ? `Thermal Cost Critical${titleSuffix}` :
    severity === 'warning'  ? `Thermal Cost Warning${titleSuffix}`  :
                              `Thermal Cost Elevated${titleSuffix}`;

  const description =
    severity === 'critical'
      ? 'Severe efficiency loss from thermal pressure. Consider rerouting inference to a cooler node.'
      : severity === 'warning'
      ? 'Significant thermal overhead is reducing inference efficiency below hardware ceiling.'
      : 'This node is running below its hardware ceiling due to building thermal pressure.';

  const recommendation =
    severity === 'critical'
      ? 'Reroute load · Reduce batch size · Check cooling'
      : 'Monitor trend · Reduce load if rising · Check airflow';

  const tcColor =
    severity === 'critical' ? 'text-red-400'    :
    severity === 'warning'  ? 'text-orange-400' : 'text-amber-400';

  const badgeCls =
    severity === 'critical'
      ? 'bg-red-500/10 border border-red-500/20 text-red-400'
      : severity === 'warning'
      ? 'bg-orange-500/10 border border-orange-500/20 text-orange-400'
      : 'bg-amber-500/10 border border-amber-500/20 text-amber-400';

  return (
    <InsightCard
      id="thermal-cost"
      nodeId={node.node_id}
      tier={1}
      severity={cardSeverity}
      title={titleLabel}
    >
      <div className="px-5 py-4 space-y-3">

        {/* ── TC% badge + rate-of-change spike indicator ───────────────────── */}
        <div className="flex items-center gap-3 flex-wrap">
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest ${badgeCls}`}>
            TC% {tcPct}%
          </span>
          {rateOfChangePct >= 15 && (
            <span className={`text-[10px] font-semibold flex items-center gap-1 ${tcColor}`}>
              <Flame className="w-3 h-3" />
              +{rateOfChangePct.toFixed(0)}pp recent spike
            </span>
          )}
          <p className="text-sm text-gray-300">
            Efficiency loss:{' '}
            <span className={`font-telin ${tcColor}`}>~{tcPct}%</span>
          </p>
        </div>

        {/* ── Description ──────────────────────────────────────────────────── */}
        <p className="text-sm text-gray-400 leading-relaxed">{description}</p>

        {/* ── Hostname (fleet mode only) ───────────────────────────────────── */}
        {showNodeHeader && node.hostname && node.hostname !== node.node_id && (
          <p className="text-xs text-gray-500 font-mono">{node.hostname}</p>
        )}

        {/* ── Recommendations ──────────────────────────────────────────────── */}
        <div className="pt-1 border-t border-gray-800">
          <p className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold mb-1.5">
            Recommended
          </p>
          <p className="text-xs text-gray-400">{recommendation}</p>
        </div>

      </div>
    </InsightCard>
  );
};

export default ThermalCostAlertCard;
