/**
 * ThermalDegradationCard — Tier 1 Active Alert
 *
 * Condition: thermal_state === 'Serious' | 'Critical'
 * Not dismissable. Disappears when thermal state resolves.
 *
 * Estimated tok/s loss = ((ThermalPenalty - 1) / ThermalPenalty) × 100
 *   Serious  → 1.75 → ~43% loss
 *   Critical → 2.0  → 50% loss
 */

import React from 'react';
import type { SentinelMetrics } from '../../../types';
import InsightCard from '../InsightCard';
import { THERMAL_PENALTY } from '../../../utils/wes';

function estimatedLossPct(thermalState: string): string {
  const penalty = THERMAL_PENALTY[thermalState.toLowerCase()] ?? 2.0;
  return ((penalty - 1) / penalty * 100).toFixed(0);
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  node: SentinelMetrics;
  showNodeHeader?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

const ThermalDegradationCard: React.FC<Props> = ({ node, showNodeHeader = false }) => {
  const thermalState = node.thermal_state;
  const thermalLower = thermalState?.toLowerCase() ?? '';

  // Guard: only render for Serious or Critical
  if (thermalLower !== 'serious' && thermalLower !== 'critical') return null;

  const lossPct = estimatedLossPct(thermalState!);

  const titleSuffix = showNodeHeader
    ? ` · ${node.node_id}`
    : '';

  return (
    <InsightCard
      id="thermal-degradation"
      nodeId={node.node_id}
      tier={1}
      severity="red"
      title={`Thermal Degradation Active${titleSuffix}`}
    >
      <div className="px-5 py-4 space-y-3">

        {/* ── State badge + loss estimate ──────────────────────────────────── */}
        <div className="flex items-center gap-3 flex-wrap">
          <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 text-[10px] font-bold uppercase tracking-widest">
            {thermalState}
          </span>
          <p className="text-sm text-gray-300">
            Estimated tok/s loss:{' '}
            <span className="font-telin text-red-400">~{lossPct}%</span>
          </p>
        </div>

        {/* ── Description ──────────────────────────────────────────────────── */}
        <p className="text-sm text-gray-400 leading-relaxed">
          This node is actively throttling. Tokens per second has dropped silently —
          hardware is managing heat by reducing clock speed.
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
            Reduce inference load · Check airflow · Monitor GPU temp
          </p>
        </div>

      </div>
    </InsightCard>
  );
};

export default ThermalDegradationCard;
