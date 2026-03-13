/**
 * InsightsGlobalStatusRail
 *
 * Full-width bar pinned at the top of the Insights tab. Always visible — never hidden.
 *
 * Nominal state  — green pulse dot + "ALL SYSTEMS NOMINAL" + fleet stats ticker
 * Active state   — full amber/red background + high-contrast firing alert rows
 *
 * Spec: docs/INSIGHTS.md § 1. The Global Status Rail
 */

import React from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FiringAlert {
  /** Unique key for React + anchor link target */
  id: string;
  /** Display name: "THERMAL DEGRADATION" */
  name: string;
  /** Node hostname or node_id */
  nodeId: string;
  /** Ms since the condition was first detected */
  elapsedMs: number;
  severity: 'red' | 'amber';
}

interface InsightsGlobalStatusRailProps {
  firingAlerts: FiringAlert[];
  fleetWes: number | null;
  reachableNodes: number;
  fleetTokS: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m} min ago`;
  return `${Math.floor(m / 60)}h ago`;
}

// ── Component ─────────────────────────────────────────────────────────────────

const InsightsGlobalStatusRail: React.FC<InsightsGlobalStatusRailProps> = ({
  firingAlerts,
  fleetWes,
  reachableNodes,
  fleetTokS,
}) => {
  const isFiring    = firingAlerts.length > 0;
  const hasCritical = firingAlerts.some(a => a.severity === 'red');

  // ── Active state ───────────────────────────────────────────────────────────
  if (isFiring) {
    return (
      <div
        className={`w-full px-4 py-2.5 border-b flex items-center gap-3 min-h-[40px] ${
          hasCritical
            ? 'bg-red-950 border-red-900/50'
            : 'bg-amber-950 border-amber-900/50'
        }`}
      >
        {/* Severity pulse bar */}
        <div
          className={`w-0.5 self-stretch rounded-full shrink-0 animate-pulse ${
            hasCritical ? 'bg-red-500' : 'bg-amber-500'
          }`}
        />

        {/* Alert rows — scrollable on narrow viewports */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 min-w-0 overflow-hidden">
          {firingAlerts.map((alert, i) => (
            <React.Fragment key={alert.id}>
              {i > 0 && (
                <span className="text-gray-600 text-xs select-none">|</span>
              )}
              <a
                href={`#insight-${alert.id}`}
                className="font-telin text-xs uppercase tracking-widest text-white hover:text-gray-200 transition-colors whitespace-nowrap"
              >
                {alert.name} — {alert.nodeId} — {fmtElapsed(alert.elapsedMs)}
              </a>
            </React.Fragment>
          ))}
        </div>
      </div>
    );
  }

  // ── Nominal state ──────────────────────────────────────────────────────────
  return (
    <div className="w-full px-4 py-2.5 bg-gray-900 border-b border-gray-800 flex items-center gap-3 min-h-[40px]">
      {/* Green pulse dot */}
      <div className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0 animate-pulse shadow-[0_0_6px_rgba(34,197,94,0.5)]" />

      <span className="font-telin text-[10px] tracking-widest text-gray-400 uppercase">
        All Systems Nominal
      </span>

      {/* Fleet stats ticker — right-aligned */}
      <div className="ml-auto flex items-center gap-4">
        {fleetWes != null && (
          <span className="font-telin text-[10px] text-gray-600 uppercase tracking-widest">
            Fleet WES: {fleetWes.toFixed(1)}
          </span>
        )}
        {reachableNodes > 0 && (
          <span className="font-telin text-[10px] text-gray-600 uppercase tracking-widest">
            Nodes: {reachableNodes}
          </span>
        )}
        {fleetTokS != null && fleetTokS > 0 && (
          <span className="font-telin text-[10px] text-gray-600 uppercase tracking-widest">
            {fleetTokS.toFixed(0)} tok/s
          </span>
        )}
      </div>
    </div>
  );
};

export default InsightsGlobalStatusRail;
