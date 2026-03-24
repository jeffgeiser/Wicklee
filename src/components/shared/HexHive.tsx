/**
 * HexHive — Node Vitals Map
 *
 * One hex per node. State drives color + glow:
 *   Active inference  → amber pulse
 *   Thermal throttle  → red glow
 *   Online / idle     → dim gray
 *   Offline / unknown → darker gray
 *
 * Used in:
 *   Overview.tsx          — Fleet Intelligence panel (Community+)
 *   AIInsights.tsx        — Performance tab Node Vitals (Community+)
 */

import React from 'react';
import { SentinelMetrics } from '../../types';
import { computeWES } from '../../utils/wes';
import { getNodePowerW } from '../../utils/power';

export interface HexHiveRow {
  nodeId:    string;
  hostname:  string;
  metrics:   SentinelMetrics | null;
  lastSeenMs?: number;
}

interface HexHiveProps {
  rows: HexHiveRow[];
  /** Optional click handler for a specific node. Used by Node Vitals to open per-node benchmark. */
  onNodeClick?: (node: SentinelMetrics) => void;
}

const HexHive: React.FC<HexHiveProps> = ({ rows, onNodeClick }) => {
  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[140px]">
        <p className="text-xs text-gray-600">No nodes</p>
      </div>
    );
  }

  const perRow = rows.length <= 3 ? rows.length : Math.ceil(Math.sqrt(rows.length * 1.4));
  const grid: HexHiveRow[][] = [];
  for (let i = 0; i < rows.length; i += perRow) grid.push(rows.slice(i, i + perRow));

  return (
    <div className="flex flex-col items-center justify-center gap-2.5 py-6 px-2 min-h-[160px]">
      {grid.map((gridRow, ri) => (
        <div key={ri} className="flex gap-2.5" style={{ marginLeft: ri % 2 === 1 ? 24 : 0 }}>
          {gridRow.map(entry => {
            const m = entry.metrics;
            const tps = (() => {
              const o = m?.ollama_tokens_per_second ?? null;
              const v = m?.vllm_tokens_per_sec ?? null;
              return o != null && v != null ? o + v : (o ?? v);
            })();
            const isActive   = m != null && tps != null && tps > 0;
            const throttling = m?.thermal_state != null
              && ['serious', 'critical'].includes(m.thermal_state.toLowerCase());
            const isOnline = m != null;

            const hexBg = !isOnline   ? 'bg-gray-700/25'
              : throttling            ? 'bg-red-500/50'
              : isActive              ? 'bg-amber-500/40'
              :                         'bg-gray-600/30';
            const glow = throttling   ? 'drop-shadow(0 0 6px rgba(239,68,68,0.55))'
              : isActive              ? 'drop-shadow(0 0 8px rgba(245,158,11,0.55))'
              :                         'none';

            // Compute WES for tooltip
            const watts = m ? getNodePowerW(m) : null;
            const wes = (m && tps != null && tps > 0 && watts != null && watts > 0)
              ? computeWES(tps, watts, m.thermal_state)
              : null;
            const status = !isOnline ? 'Offline'
              : throttling           ? 'Throttled'
              : isActive             ? 'Active'
              :                        'Idle';
            const thermal = m?.thermal_state ?? 'Unknown';

            const tooltipText = [
              entry.hostname || entry.nodeId,
              status,
              wes != null ? `WES ${wes.toFixed(1)}` : null,
              `Thermal: ${thermal}`,
              onNodeClick ? 'Click for benchmark' : null,
            ].filter(Boolean).join(' · ');

            const clickable = onNodeClick && m != null;

            return (
              <div
                key={entry.nodeId}
                className={`flex flex-col items-center gap-1 group relative ${clickable ? 'cursor-pointer' : ''}`}
                onClick={clickable ? () => onNodeClick(m) : undefined}
              >
                <div
                  style={{ filter: glow }}
                  className={clickable ? 'transition-transform group-hover:scale-110' : ''}
                >
                  <div
                    className={`w-11 h-[50px] ${hexBg} ${isActive && !throttling ? 'animate-pulse' : ''}`}
                    style={{ clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)' }}
                    title={tooltipText}
                  />
                </div>
                <p className="text-[8px] font-telin text-gray-500 truncate max-w-[44px] text-center leading-none">
                  {entry.nodeId}
                </p>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
};

export default HexHive;
