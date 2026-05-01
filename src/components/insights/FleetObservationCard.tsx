/**
 * FleetObservationCard — collapsible card for cloud-side fleet observations.
 *
 * Renders a `FleetObservation` (the wire shape from /api/fleet/observations)
 * with a compact collapsed row + click-to-expand body.
 *
 * Design intent:
 *  - Hostname is a first-class pill (not a tiny gray label in the corner).
 *  - The "hook" (the headline metric) is right-aligned, color-coded, and the
 *    biggest number on the row — so the operator can scan a list of cards and
 *    immediately see what's happening.
 *  - Internal/debug context fields (action_id, confidence, confidence_ratio,
 *    resolution_steps) are NOT rendered as chips. Resolution steps get their
 *    own numbered list in the expanded body. The other fields are noise.
 *  - "Acknowledge" and "View in Timeline" live in the expanded body, which
 *    reduces visual clutter when the operator is just scanning.
 */

import React, { useState, useMemo } from 'react';
import { ChevronDown, CheckCircle, Activity, Lightbulb, ListChecks, Cpu } from 'lucide-react';
import type { FleetObservation } from '../../hooks/useFleetObservations';
import { patternIcon, hookColor } from './ObservationCard';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtAge(tsMs: number): string {
  const elapsed = Date.now() - tsMs;
  const m = Math.round(elapsed / 60_000);
  if (m < 1)  return '<1m';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

/** Internal fields never shown in the chip strip — they're either debug
 *  metadata or rendered with dedicated UI elsewhere in the card. */
const HIDDEN_CTX_KEYS = new Set([
  'hook',
  'action_id',
  'confidence',
  'confidence_ratio',
  'resolution_steps',
  'recommendation',
  'hot_ticks',
]);

interface ParsedContext {
  hook?:             string;
  recommendation?:   string;
  resolution_steps?: string[];
  /** Remaining chip-worthy fields (hostname, model, etc.) */
  chips:             Array<[string, string]>;
}

function parseContext(json: string | null): ParsedContext {
  if (!json) return { chips: [] };
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(json); } catch { return { chips: [] }; }

  const hook            = typeof raw.hook === 'string' ? raw.hook : undefined;
  const recommendation  = typeof raw.recommendation === 'string' ? raw.recommendation : undefined;
  const resolution_steps =
    Array.isArray(raw.resolution_steps)
      ? raw.resolution_steps.filter((s): s is string => typeof s === 'string')
      : undefined;

  const chips: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(raw)) {
    if (HIDDEN_CTX_KEYS.has(k)) continue;
    if (v == null) continue;
    if (typeof v === 'object') continue;       // skip nested arrays/objects
    const str  = String(v);
    const num  = Number(str);
    const disp = !isNaN(num) && str.includes('.') ? num.toFixed(1) : str;
    chips.push([k.replace(/_/g, ' '), disp]);
  }

  return { hook, recommendation, resolution_steps, chips };
}

/** Map cloud alert_type → existing patternId for icon/color reuse. */
function alertTypeToPatternId(alertType: string): string {
  // Direct matches with existing pattern engine IDs:
  switch (alertType) {
    case 'wes_velocity_drop':
    case 'wes_cliff':
      return 'wes_velocity_drop';
    case 'fleet_load_imbalance':
      return 'fleet_load_imbalance';
    case 'thermal_redline':
    case 'thermal_drain':
      return 'thermal_drain';
    case 'oom_warning':
    case 'memory_trajectory':
      return 'memory_trajectory';
    case 'phantom_load':
    case 'zombied_engine':
      return 'phantom_load';
    case 'swap_io_pressure':
      return 'swap_io_pressure';
    default:
      return alertType;  // falls through to default icon/color
  }
}

// ── Props ────────────────────────────────────────────────────────────────────

interface FleetObservationCardProps {
  obs:                  FleetObservation;
  hostname:             string;
  onAcknowledge?:       () => void;
  onViewInTimeline?:    () => void;
}

// ── Component ────────────────────────────────────────────────────────────────

const FleetObservationCard: React.FC<FleetObservationCardProps> = ({
  obs,
  hostname,
  onAcknowledge,
  onViewInTimeline,
}) => {
  const [expanded, setExpanded] = useState(false);

  const { hook, recommendation, resolution_steps, chips } = useMemo(
    () => parseContext(obs.context_json),
    [obs.context_json],
  );

  const patternId  = alertTypeToPatternId(obs.alert_type);
  const isCritical = obs.severity === 'critical';
  const isOpen     = obs.state === 'open';
  const isAcked    = obs.state === 'acknowledged';
  const dotCls     = !isOpen
    ? 'bg-gray-600'
    : isCritical ? 'bg-red-500 animate-pulse'
    : 'bg-amber-500';

  // Outer container: severity-tinted border when open, muted when resolved/acked.
  const containerCls = !isOpen
    ? 'border-gray-700/40 bg-gray-800/30 opacity-70'
    : isCritical
    ? 'border-red-500/30 bg-red-500/5'
    : 'border-amber-500/30 bg-amber-500/5';

  return (
    <div className={`rounded-2xl border transition-all ${containerCls}`}>
      {/* ── Collapsed header row ─────────────────────────────────────── */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2.5 px-4 py-3 text-left group"
      >
        {/* Severity dot */}
        <span className={`shrink-0 w-2 h-2 rounded-full ${dotCls}`} />

        {/* Pattern icon */}
        <span className="shrink-0">{patternIcon(patternId)}</span>

        {/* Title */}
        <span className={`flex-1 text-sm font-semibold truncate min-w-0 ${
          isOpen ? 'text-white' : 'text-gray-500'
        }`}>
          {obs.title}
        </span>

        {/* Hostname pill — promoted from tiny upper-right label.
            This is what the operator scans for first when several cards
            are stacked: "which node?" */}
        <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-mono text-gray-300 bg-gray-700/80 border border-gray-700/60 px-2 py-0.5 rounded-md">
          <Cpu className="w-2.5 h-2.5 text-gray-500" />
          {hostname}
        </span>

        {/* Resolved / Acknowledged badge */}
        {!isOpen && (
          <span className="shrink-0 flex items-center gap-1 text-[10px] text-green-400/80">
            <CheckCircle className="w-3 h-3" />
            {isAcked ? 'Acked' : 'Resolved'}
          </span>
        )}

        {/* Hook value — the headline metric, big and color-coded.
            Falls back to '—' rather than rendering nothing, so the row
            grid stays consistent across cards. */}
        <span className={`shrink-0 text-xs font-bold font-mono ${
          isOpen ? hookColor(patternId) : 'text-gray-600'
        }`}>
          {hook ?? ''}
        </span>

        {/* Age */}
        <span className="shrink-0 text-[10px] text-gray-600 font-mono w-8 text-right">
          {fmtAge(obs.fired_at_ms)}
        </span>

        {/* Chevron */}
        <ChevronDown className={`shrink-0 w-3.5 h-3.5 text-gray-600 group-hover:text-gray-400 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {/* ── Expanded body ────────────────────────────────────────────── */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-gray-700/50">
          {/* Detail */}
          <p className={`text-xs leading-relaxed pt-3 ${isOpen ? 'text-gray-300' : 'text-gray-500'}`}>
            {obs.detail.replace(/~0 min/g, 'imminent')}
          </p>

          {/* Recommendation — if the agent supplied one in context_json */}
          {recommendation && isOpen && (
            <div className="flex gap-2 p-3 rounded-xl bg-gray-900/60 border border-gray-700/60">
              <Lightbulb className="w-3.5 h-3.5 text-indigo-400/70 shrink-0 mt-0.5" />
              <div className="min-w-0 space-y-1">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-indigo-400/70">
                  Recommended Action
                </p>
                <p className="text-xs text-gray-300 leading-relaxed">{recommendation}</p>
              </div>
            </div>
          )}

          {/* Resolution Steps — proper numbered list, not a stringified chip */}
          {resolution_steps && resolution_steps.length > 0 && isOpen && (
            <div className="flex gap-2 p-3 rounded-xl bg-gray-900/60 border border-gray-700/60">
              <ListChecks className="w-3.5 h-3.5 text-gray-500 shrink-0 mt-0.5" />
              <div className="min-w-0 space-y-1.5 flex-1">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  Resolution Steps
                </p>
                <ol className="space-y-1.5 list-none">
                  {resolution_steps.map((step, idx) => (
                    <li key={idx} className="flex gap-2 text-xs text-gray-300 leading-relaxed">
                      <span className="shrink-0 font-mono text-gray-600 w-4 text-right">{idx + 1}.</span>
                      <span className="font-mono text-[11px] break-all">{step}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          )}

          {/* Remaining context chips (anything that wasn't hook/recommendation/
              resolution_steps/debug). These are usually scalar metrics like
              "node version: 0.7.14" — useful but secondary. */}
          {chips.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {chips.map(([k, v]) => (
                <span key={k} className="text-[9px] px-1.5 py-0.5 rounded bg-gray-700/60 text-gray-500 font-mono">
                  {k}: {v}
                </span>
              ))}
            </div>
          )}

          {/* Action row */}
          <div className="flex items-center gap-3 pt-1">
            {isOpen && onAcknowledge && (
              <button
                onClick={(e) => { e.stopPropagation(); onAcknowledge(); }}
                className="text-[10px] text-gray-300 hover:text-white transition-colors flex items-center gap-1"
              >
                <CheckCircle className="w-3 h-3" />
                Acknowledge
              </button>
            )}
            {onViewInTimeline && (
              <button
                onClick={(e) => { e.stopPropagation(); onViewInTimeline(); }}
                className="text-[10px] text-indigo-400/70 hover:text-indigo-400 transition-colors flex items-center gap-1"
              >
                <Activity className="w-3 h-3" />
                View in Timeline →
              </button>
            )}
            <span className="ml-auto text-[9px] text-gray-700 font-mono">
              {new Date(obs.fired_at_ms).toLocaleTimeString()}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

export default FleetObservationCard;
