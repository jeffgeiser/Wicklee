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
import { Copy, Check, Thermometer, Zap, Server, TrendingDown, MemoryStick, X, CheckCircle, Lightbulb, Cpu, BarChart2, Wind, Search, Clock, Gauge, Waves, ListChecks, HardDrive } from 'lucide-react';
import type { DetectedInsight, ActionId } from '../../lib/patternEngine';
import { appendRecentEvent } from '../../lib/insightLifecycle';

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

// ── ActionId badge ────────────────────────────────────────────────────────────

interface ActionBadgeConfig {
  label: string;
  icon:  React.ReactNode;
  cls:   string;
}

function actionBadgeConfig(actionId: ActionId): ActionBadgeConfig {
  switch (actionId) {
    case 'rebalance_workload':
      return { label: 'Rebalance Workload', icon: <BarChart2 className="w-2.5 h-2.5" />, cls: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20' };
    case 'evict_idle_models':
      return { label: 'Evict Idle Models',  icon: <Cpu       className="w-2.5 h-2.5" />, cls: 'text-amber-400  bg-amber-500/10  border-amber-500/20'  };
    case 'reduce_batch_size':
      return { label: 'Reduce Batch Size',  icon: <BarChart2 className="w-2.5 h-2.5" />, cls: 'text-cyan-400   bg-cyan-500/10   border-cyan-500/20'   };
    case 'check_thermal_zone':
      return { label: 'Check Thermal Zone', icon: <Wind      className="w-2.5 h-2.5" />, cls: 'text-red-400    bg-red-500/10    border-red-500/20'    };
    case 'investigate_phantom':
      return { label: 'Investigate Phantom',icon: <Search    className="w-2.5 h-2.5" />, cls: 'text-violet-400 bg-violet-500/10 border-violet-500/20' };
    case 'schedule_offpeak':
      return { label: 'Schedule Off-Peak',  icon: <Clock     className="w-2.5 h-2.5" />, cls: 'text-blue-400   bg-blue-500/10   border-blue-500/20'   };
    case 'switch_quantization':
      return { label: 'Switch Quantization',icon: <Gauge     className="w-2.5 h-2.5" />, cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' };
    default:
      return { label: 'Action Required',    icon: <Server    className="w-2.5 h-2.5" />, cls: 'text-gray-400   bg-gray-500/10   border-gray-500/20'   };
  }
}

const ActionIdBadge: React.FC<{ actionId: ActionId }> = ({ actionId }) => {
  const cfg = actionBadgeConfig(actionId);
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[9px] font-semibold uppercase tracking-wider ${cfg.cls}`}>
      {cfg.icon}
      {cfg.label}
    </span>
  );
};

// ── Icon + colour mapping by patternId ───────────────────────────────────────

function patternIcon(patternId: string) {
  switch (patternId) {
    case 'thermal_drain':        return <Thermometer  className="w-4 h-4 text-amber-400"  />;
    case 'phantom_load':         return <Zap          className="w-4 h-4 text-violet-400" />;
    case 'wes_velocity_drop':    return <TrendingDown className="w-4 h-4 text-indigo-400" />;
    case 'power_gpu_decoupling': return <Cpu          className="w-4 h-4 text-cyan-400"   />;
    case 'fleet_load_imbalance': return <BarChart2    className="w-4 h-4 text-blue-400"   />;
    case 'memory_trajectory':    return <MemoryStick  className="w-4 h-4 text-cyan-400"    />;
    case 'bandwidth_saturation': return <Gauge        className="w-4 h-4 text-emerald-400" />;
    case 'power_jitter':         return <Waves        className="w-4 h-4 text-orange-400"  />;
    case 'efficiency_drag':      return <TrendingDown className="w-4 h-4 text-yellow-400"  />;
    case 'swap_io_pressure':     return <HardDrive    className="w-4 h-4 text-rose-400"    />;
    default:                     return <Server       className="w-4 h-4 text-gray-400"    />;
  }
}

function hookColor(patternId: string): string {
  switch (patternId) {
    case 'thermal_drain':        return 'text-amber-400';
    case 'phantom_load':         return 'text-violet-400';
    case 'wes_velocity_drop':    return 'text-indigo-400';
    case 'power_gpu_decoupling': return 'text-cyan-400';
    case 'fleet_load_imbalance': return 'text-blue-400';
    case 'memory_trajectory':    return 'text-cyan-400';
    case 'bandwidth_saturation': return 'text-emerald-400';
    case 'power_jitter':         return 'text-orange-400';
    case 'efficiency_drag':      return 'text-yellow-400';
    case 'swap_io_pressure':     return 'text-rose-400';
    default:                     return 'text-indigo-400';
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
  /** If set, the pattern has stopped firing; card shows a resolved badge. */
  resolvedMs?:    number | null;
  /**
   * Called after the card is dismissed (after localStorage write + buffer append).
   * AIInsights uses this to emit a 'pattern_dismissed' FleetEvent so the Live
   * Activity Feed shows the acknowledgement.
   */
  onDismiss?:     () => void;
}

function fmtResolvedAge(resolvedMs: number): string {
  const elapsed = Date.now() - resolvedMs;
  const m = Math.round(elapsed / 60_000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

const ObservationCard: React.FC<ObservationCardProps> = ({ insight, showNodeHeader, resolvedMs, onDismiss }) => {
  // Initialise from localStorage so dismiss state survives hot-reloads
  const [dismissed, setDismissed] = useState(
    () => readDismissed(insight.patternId, insight.nodeId),
  );

  const handleDismiss = useCallback(() => {
    writeDismissed(insight.patternId, insight.nodeId);
    setDismissed(true);
    // Write a 'dismissed' record to the 24h recent-events buffer so the
    // Morning Briefing Card can surface operator acknowledgements.
    appendRecentEvent({
      id:             crypto.randomUUID(),
      ts:             Date.now(),
      eventType:      'dismissed',
      nodeId:         insight.nodeId,
      hostname:       insight.hostname,
      patternId:      insight.patternId,
      title:          insight.title,
      action_id:      insight.action_id,
      hook:           insight.hook,
      recommendation: insight.recommendation,
    });
    // Notify parent so it can emit the pattern_dismissed FleetEvent.
    onDismiss?.();
  }, [insight, onDismiss]);

  if (dismissed) return null;

  const isBuilding = insight.confidence === 'building';
  const isResolved = resolvedMs != null;

  return (
    <div className={`border rounded-2xl p-4 space-y-3 transition-opacity ${
      isResolved
        ? 'bg-gray-900/30 border-gray-800/50 opacity-70'
        : 'bg-gray-900/60 border-gray-800'
    }`}>

      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {patternIcon(insight.patternId)}
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              Observation
              {isBuilding && !isResolved && (
                <span className="ml-2 text-indigo-400/70 normal-case tracking-normal">
                  · Building
                </span>
              )}
              {isResolved && (
                <span className="ml-2 text-green-400/80 normal-case tracking-normal flex-inline items-center gap-1">
                  · <CheckCircle className="w-2.5 h-2.5 inline -mt-px" /> Resolved {fmtResolvedAge(resolvedMs)}
                </span>
              )}
            </p>
            <p className="text-sm font-semibold text-white truncate">{insight.title}</p>
          </div>
        </div>

        {/* Right side: hook + dismiss */}
        <div className="shrink-0 flex items-start gap-2">
          <div className="text-right">
            <p className={`text-base font-bold font-mono ${isResolved ? 'text-gray-500' : hookColor(insight.patternId)}`}>
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

      {/* Recommendation row — prescriptive 1–2 sentence operator action */}
      {insight.recommendation && !isResolved && (
        <div className="flex gap-2 p-3 rounded-xl bg-gray-950/60 border border-gray-800/60">
          <Lightbulb className="w-3.5 h-3.5 text-indigo-400/70 shrink-0 mt-0.5" />
          <div className="min-w-0 space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-indigo-400/70">
              Recommended Action
            </p>
            <p className="text-xs text-gray-300 leading-relaxed">{insight.recommendation}</p>
            <ActionIdBadge actionId={insight.action_id} />
          </div>
        </div>
      )}

      {/* Resolution steps — numbered step-by-step playbook, collapsed if resolved */}
      {insight.resolution_steps && insight.resolution_steps.length > 0 && !isResolved && (
        <div className="flex gap-2 p-3 rounded-xl bg-gray-950/60 border border-gray-800/60">
          <ListChecks className="w-3.5 h-3.5 text-gray-500 shrink-0 mt-0.5" />
          <div className="min-w-0 space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              Resolution Steps
            </p>
            <ol className="space-y-1 list-none">
              {insight.resolution_steps.map((step, idx) => (
                <li key={idx} className="flex gap-2 text-xs text-gray-400 leading-relaxed">
                  <span className="shrink-0 font-mono text-gray-600 w-3 text-right">{idx + 1}.</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}

      {/* Action copy buttons — hidden when resolved (condition is gone) */}
      {insight.actions.length > 0 && !isResolved && (
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

      {/* Confidence bar — only shown while building and not resolved */}
      {isBuilding && !isResolved && <ConfidenceBar insight={insight} />}
    </div>
  );
};

export default ObservationCard;
