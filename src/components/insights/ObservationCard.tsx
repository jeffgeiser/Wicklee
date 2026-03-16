/**
 * ObservationCard — Intelligence Briefing Feed card for pattern engine findings.
 *
 * Visual language:
 *  - High-contrast hook in top-right (the "$-or-metric" number, amber for cost
 *    patterns, indigo for performance patterns).
 *  - Thin confidence progress bar at bottom when confidence === 'building'.
 *  - One-click copy buttons for each operator action.
 *  - Dismiss button: hides the card for 1h. If the condition persists after
 *    1h the pattern engine re-fires and the card resurfaces automatically.
 *  - Node hostname badge when multiple nodes are in the fleet.
 */

import React, { useState, useCallback } from 'react';
import { Copy, Check, Thermometer, Zap, Server, TrendingDown, MemoryStick, X } from 'lucide-react';
import type { DetectedInsight } from '../../lib/patternEngine';

// ── Dismiss helpers ───────────────────────────────────────────────────────────

const DISMISS_RESURFACE_MS = 60 * 60 * 1000;   // resurface after 1h

function dismissKey(patternId: string, nodeId: string): string {
  return `obs-dismissed:${patternId}:${nodeId}`;
}

function readDismissed(patternId: string, nodeId: string): boolean {
  try {
    const raw = localStorage.getItem(dismissKey(patternId, nodeId));
    if (!raw) return false;
    const { dismissedAt } = JSON.parse(raw) as { dismissedAt: number };
    return typeof dismissedAt === 'number' && Date.now() - dismissedAt < DISMISS_RESURFACE_MS;
  } catch {
    return false;
  }
}

function writeDismissed(patternId: string, nodeId: string): void {
  try {
    localStorage.setItem(
      dismissKey(patternId, nodeId),
      JSON.stringify({ dismissedAt: Date.now() }),
    );
  } catch { /* storage unavailable — degrade gracefully */ }
}

// ── Icon + colour mapping by patternId ───────────────────────────────────────

function patternIcon(patternId: string) {
  switch (patternId) {
    case 'thermal_drain':      return <Thermometer  className="w-4 h-4 text-amber-400"  />;
    case 'phantom_load':       return <Zap          className="w-4 h-4 text-violet-400" />;
    case 'wes_velocity_drop':  return <TrendingDown className="w-4 h-4 text-indigo-400" />;
    case 'memory_trajectory':  return <MemoryStick  className="w-4 h-4 text-cyan-400"   />;
    default:                   return <Server       className="w-4 h-4 text-gray-400"   />;
  }
}

function hookColor(patternId: string): string {
  switch (patternId) {
    case 'thermal_drain':      return 'text-amber-400';
    case 'phantom_load':       return 'text-violet-400';
    case 'wes_velocity_drop':  return 'text-indigo-400';
    case 'memory_trajectory':  return 'text-cyan-400';
    default:                   return 'text-indigo-400';
  }
}

// ── CopyButton ────────────────────────────────────────────────────────────────

const CopyButton: React.FC<{ text: string; label: string }> = ({ text, label }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // Fallback for non-secure contexts
      const el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700
                 border border-gray-700 hover:border-gray-600 transition-colors group"
    >
      <code className="text-[10px] font-mono text-gray-300 group-hover:text-white truncate max-w-[180px]">
        {label}
      </code>
      {copied
        ? <Check  className="w-3 h-3 text-green-400 shrink-0" />
        : <Copy   className="w-3 h-3 text-gray-500 group-hover:text-gray-300 shrink-0" />
      }
    </button>
  );
}

// ── ConfidenceBar ─────────────────────────────────────────────────────────────

function ConfidenceBar({ insight }: { insight: DetectedInsight }) {
  const observedMin = Math.round(insight.observedMs / 60000);
  const requiredMin = Math.round(insight.requiredMs / 60000);
  const pct         = Math.round(insight.confidenceRatio * 100);

  return (
    <div className="mt-3 pt-3 border-t border-gray-800">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-gray-500 font-mono">
          Observing: {observedMin}m of {requiredMin}m required
        </span>
        <span className="text-[10px] text-gray-500">{pct}%</span>
      </div>
      <div className="h-0.5 bg-gray-800 rounded-full overflow-hidden">
        <div
          className="h-full bg-indigo-500/60 rounded-full transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ── ObservationCard ───────────────────────────────────────────────────────────

interface ObservationCardProps {
  insight:        DetectedInsight;
  showNodeHeader: boolean;
}

const ObservationCard: React.FC<ObservationCardProps> = ({ insight, showNodeHeader }) => {
  // Initialise from localStorage so dismiss state survives hot-reloads
  const [dismissed, setDismissed] = useState(
    () => readDismissed(insight.patternId, insight.nodeId),
  );

  const handleDismiss = useCallback(() => {
    writeDismissed(insight.patternId, insight.nodeId);
    setDismissed(true);
  }, [insight.patternId, insight.nodeId]);

  if (dismissed) return null;

  const isBuilding = insight.confidence === 'building';

  return (
    <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-4 space-y-3">

      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {patternIcon(insight.patternId)}
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              Observation
              {isBuilding && (
                <span className="ml-2 text-indigo-400/70 normal-case tracking-normal">
                  · Building
                </span>
              )}
            </p>
            <p className="text-sm font-semibold text-white truncate">{insight.title}</p>
          </div>
        </div>

        {/* Right side: hook + dismiss */}
        <div className="shrink-0 flex items-start gap-2">
          <div className="text-right">
            <p className={`text-base font-bold font-mono ${hookColor(insight.patternId)}`}>
              {insight.hook}
            </p>
            {showNodeHeader && (
              <p className="text-[10px] text-gray-500 mt-0.5">{insight.hostname}</p>
            )}
          </div>
          <button
            onClick={handleDismiss}
            title="Dismiss for 1 hour"
            className="mt-0.5 p-1 rounded-lg text-gray-600 hover:text-gray-400
                       hover:bg-gray-800 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Body */}
      <p className="text-xs text-gray-400 leading-relaxed">{insight.body}</p>

      {/* Action copy buttons */}
      {insight.actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {insight.actions.map(action => (
            <CopyButton
              key={action.copyText}
              text={action.copyText}
              label={action.label}
            />
          ))}
        </div>
      )}

      {/* Confidence bar — only shown while building */}
      {isBuilding && <ConfidenceBar insight={insight} />}
    </div>
  );
};

export default ObservationCard;
