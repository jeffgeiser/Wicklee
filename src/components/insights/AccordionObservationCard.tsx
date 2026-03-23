/**
 * AccordionObservationCard — collapsible observation card.
 *
 * Collapsed (default): ~44px row with severity dot + title + node badge + hook + timestamp + chevron.
 * Expanded (on click): full body, recommendation, resolution steps, curl actions, dismiss.
 *
 * Supports grouped (deduped) patterns via groupedNodes prop.
 */

import React, { useState, useCallback } from 'react';
import { ChevronDown, X, CheckCircle, Lightbulb, ListChecks } from 'lucide-react';
import type { DetectedInsight } from '../../lib/patternEngine';
import { appendRecentEvent } from '../../lib/insightLifecycle';
import {
  readDismissed,
  writeDismissed,
  patternIcon,
  hookColor,
  ActionIdBadge,
  CopyButton,
  ConfidenceBar,
} from './ObservationCard';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtAge(tsMs: number): string {
  const elapsed = Date.now() - tsMs;
  const m = Math.round(elapsed / 60_000);
  if (m < 1)  return '<1m';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

function severityDotCls(confidence: string | undefined): string {
  switch (confidence) {
    case 'high':     return 'bg-red-500';
    case 'moderate': return 'bg-amber-500';
    default:         return 'bg-gray-500';
  }
}

// ── Props ────────────────────────────────────────────────────────────────────

interface AccordionObservationCardProps {
  insight:         DetectedInsight & { firstFiredMs?: number };
  showNodeHeader:  boolean;
  resolvedMs?:     number | null;
  onDismiss?:      () => void;
  /** When part of a grouped/deduped incident, lists all affected nodes. */
  groupedNodes?:   Array<{ nodeId: string; hostname: string }>;
}

// ── Component ────────────────────────────────────────────────────────────────

const AccordionObservationCard: React.FC<AccordionObservationCardProps> = ({
  insight,
  showNodeHeader,
  resolvedMs,
  onDismiss,
  groupedNodes,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(
    () => readDismissed(insight.patternId, insight.nodeId),
  );

  const handleDismiss = useCallback(() => {
    writeDismissed(insight.patternId, insight.nodeId);
    setDismissed(true);
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
    onDismiss?.();
  }, [insight, onDismiss]);

  if (dismissed) return null;

  const isBuilding = insight.confidence === 'building';
  const isResolved = resolvedMs != null;
  const isGrouped  = groupedNodes && groupedNodes.length > 1;

  return (
    <div className={`border rounded-2xl transition-opacity ${
      isResolved
        ? 'bg-gray-900/30 border-gray-800/50 opacity-70'
        : 'bg-gray-900/60 border-gray-800'
    }`}>
      {/* ── Collapsed header — always visible ─────────────────────────── */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2.5 px-4 py-3 text-left group"
      >
        {/* Severity dot */}
        <span className={`shrink-0 w-2 h-2 rounded-full ${severityDotCls(insight.confidence)}`} />

        {/* Pattern icon */}
        <span className="shrink-0">{patternIcon(insight.patternId)}</span>

        {/* Title */}
        <span className="flex-1 text-sm font-semibold text-white truncate min-w-0">
          {insight.title}
        </span>

        {/* Grouped badge */}
        {isGrouped && (
          <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-blue-400 bg-blue-500/10 border border-blue-500/20 px-1.5 py-0.5 rounded-md">
            {groupedNodes!.length} nodes
          </span>
        )}

        {/* Node hostname */}
        {showNodeHeader && !isGrouped && (
          <span className="shrink-0 text-[10px] text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded">
            {insight.hostname}
          </span>
        )}

        {/* Resolved badge */}
        {isResolved && (
          <span className="shrink-0 flex items-center gap-1 text-[10px] text-green-400/80">
            <CheckCircle className="w-3 h-3" />
            Resolved
          </span>
        )}

        {/* Hook value */}
        <span className={`shrink-0 text-xs font-bold font-mono ${isResolved ? 'text-gray-500' : hookColor(insight.patternId)}`}>
          {insight.hook}
        </span>

        {/* Age */}
        {insight.firstFiredMs && (
          <span className="shrink-0 text-[10px] text-gray-600 font-mono">
            {fmtAge(insight.firstFiredMs)}
          </span>
        )}

        {/* Chevron */}
        <ChevronDown className={`shrink-0 w-3.5 h-3.5 text-gray-600 group-hover:text-gray-400 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {/* ── Expanded body ─────────────────────────────────────────────── */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-gray-800/50">

          {/* Grouped nodes list */}
          {isGrouped && (
            <div className="flex flex-wrap gap-1.5 pt-3">
              {groupedNodes!.map(n => (
                <span key={n.nodeId} className="text-[10px] text-gray-400 bg-gray-800 px-2 py-0.5 rounded">
                  {n.hostname || n.nodeId}
                </span>
              ))}
            </div>
          )}

          {/* Body */}
          <p className="text-xs text-gray-400 leading-relaxed pt-3">{insight.body}</p>

          {/* Recommendation */}
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

          {/* Resolution steps */}
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

          {/* Action copy buttons */}
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

          {/* Confidence bar */}
          {isBuilding && !isResolved && <ConfidenceBar insight={insight} />}

          {/* Dismiss button */}
          {!isResolved && (
            <div className="flex justify-end pt-1">
              <button
                onClick={(e) => { e.stopPropagation(); handleDismiss(); }}
                className="flex items-center gap-1.5 text-[10px] text-gray-600 hover:text-gray-400 transition-colors"
              >
                <X className="w-3 h-3" />
                Dismiss for 1h
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default AccordionObservationCard;
