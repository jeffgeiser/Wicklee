/**
 * FleetHeaderBar — 60px HUD bar at the top of the Triage tab.
 *
 * Merges Fleet Pulse stats (left) + Compact Health Pips (right) into one
 * dense always-visible strip. Replaces both InsightsBriefingCard and the
 * standalone Fleet Pulse stat grid.
 */

import React from 'react';
import { Thermometer, Zap, HardDrive } from 'lucide-react';

// ── Types ────────────────────────────────────────────────────────────────────

interface HealthPip {
  key:     string;
  icon:    React.ReactNode;
  label:   string;
  reading: string | null;
}

interface FleetHeaderBarProps {
  /** Number of online nodes. */
  onlineCount:  number;
  /** Total registered nodes. */
  totalCount:   number;
  /** Fleet aggregate tok/s (null = no inference). */
  fleetTokS:    number | null;
  /** Top WES value (null = unavailable). */
  topWes:       number | null;
  /** Hostname of the top-WES node. */
  topWesHost:   string | null;
  /** Fleet total watts (null = unavailable). */
  fleetWatts:   number | null;
  /** Health pips — only items whose latch is NOT active (dormant dimensions). */
  healthPips:   HealthPip[];
  /** When true, suppress the "peak" prefix (single-node context). */
  isSingleNode?: boolean;
}

// ── Component ────────────────────────────────────────────────────────────────

const FleetHeaderBar: React.FC<FleetHeaderBarProps> = ({
  onlineCount,
  totalCount,
  fleetTokS,
  topWes,
  topWesHost,
  fleetWatts,
  healthPips,
  isSingleNode = false,
}) => {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-2xl px-4 py-2.5 flex items-center gap-4 flex-wrap">

      {/* ── Left: Pulse Stats ─────────────────────────────────────────── */}
      <div className="flex items-center gap-4 flex-wrap">

        {/* Online count */}
        <div className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            onlineCount > 0 ? 'bg-green-400 animate-pulse' : 'bg-gray-600'
          }`} />
          <span className="font-mono text-sm font-bold text-white">
            {onlineCount}
          </span>
          <span className="text-[10px] text-gray-600">
            / {totalCount}
          </span>
        </div>

        <span className="text-gray-700">·</span>

        {/* Throughput */}
        <div className="flex items-center gap-1">
          <span className={`font-mono text-sm font-bold ${
            fleetTokS != null && fleetTokS > 0 ? 'text-green-400' : 'text-gray-600'
          }`}>
            {fleetTokS != null ? fleetTokS.toFixed(1) : '—'}
          </span>
          <span className="text-[9px] text-gray-600">tok/s</span>
        </div>

        <span className="text-gray-700">·</span>

        {/* Top WES */}
        <div className="flex items-center gap-1">
          {!isSingleNode && (
            <span className="text-[9px] text-gray-600 uppercase tracking-wider">peak</span>
          )}
          <span className={`font-mono text-sm font-bold ${
            topWes != null
              ? topWes > 10 ? 'text-emerald-400' : topWes >= 3 ? 'text-green-300' : topWes >= 1 ? 'text-yellow-400' : 'text-red-400'
              : 'text-gray-600'
          }`}>
            {topWes != null ? topWes.toFixed(1) : '—'}
          </span>
          <span className="text-[9px] text-gray-600">WES</span>
          {!isSingleNode && topWesHost && (
            <span className="text-[9px] text-gray-500 truncate max-w-[80px]">{topWesHost}</span>
          )}
        </div>

        <span className="text-gray-700">·</span>

        {/* Power */}
        <div className="flex items-center gap-1">
          <span className={`font-mono text-sm font-bold ${
            fleetWatts == null   ? 'text-gray-600'
            : fleetWatts > 200   ? 'text-amber-400'
            : fleetWatts > 50    ? 'text-gray-300'
            :                      'text-green-400'
          }`}>
            {fleetWatts != null ? `${fleetWatts.toFixed(0)}W` : '—'}
          </span>
        </div>
      </div>

      {/* ── Spacer ────────────────────────────────────────────────────── */}
      <div className="flex-1" />

      {/* ── Right: Health Pips ─────────────────────────────────────────── */}
      {healthPips.length > 0 && (
        <div className="flex items-center gap-3">
          {healthPips.map(pip => (
            <div key={pip.key} className="flex items-center gap-1.5">
              <span className="relative flex h-1.5 w-1.5 shrink-0">
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500/80" />
              </span>
              <span className="text-gray-600 shrink-0">{pip.icon}</span>
              <span className="text-[9px] font-semibold uppercase tracking-wider text-gray-600">
                {pip.label}
              </span>
              {pip.reading && (
                <span className="text-[9px] font-mono text-gray-500">{pip.reading}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default FleetHeaderBar;
