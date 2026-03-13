/**
 * HexHive — Inference Density Map
 *
 * One hex per node. State drives color + glow:
 *   Active inference  → amber pulse
 *   Thermal throttle  → red glow
 *   Online / idle     → dim gray
 *   Offline / unknown → darker gray
 *
 * Used in:
 *   Overview.tsx          — Fleet Intelligence panel (Community+)
 *   AIInsights.tsx        — Section 1 Health Indicators (Community+)
 */

import React from 'react';
import { SentinelMetrics } from '../../types';

export interface HexHiveRow {
  nodeId:    string;
  hostname:  string;
  metrics:   SentinelMetrics | null;
  lastSeenMs?: number;
}

const HexHive: React.FC<{ rows: HexHiveRow[] }> = ({ rows }) => {
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

            return (
              <div key={entry.nodeId} className="flex flex-col items-center gap-1">
                <div style={{ filter: glow }}>
                  <div
                    className={`w-11 h-[50px] ${hexBg} ${isActive && !throttling ? 'animate-pulse' : ''}`}
                    style={{ clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)' }}
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
