/**
 * InsightCard — base shell for all Insight tab cards.
 *
 * Provides:
 *   - Left border color keyed to severity
 *   - Standardised title row with severity icon
 *   - Dismiss button (Tier 2 only) backed by sessionStorage via useInsightDismiss
 *   - Returns null when dismissed (Tier 2) so parent sections can hide
 *
 * Tier 1 cards: red left border, no dismiss capability.
 * Tier 2 cards: amber (or red for poor fit) left border, ✕ in top-right.
 */

import React from 'react';
import { X, AlertCircle, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useInsightDismiss } from '../../hooks/useInsightDismiss';

// ── Props ─────────────────────────────────────────────────────────────────────

export interface InsightCardProps {
  /** Unique card ID — combined with nodeId as the sessionStorage dismiss key. */
  id: string;
  /** Per-node cards pass the node_id so each node's card is dismissed independently. */
  nodeId?: string;
  /** Tier 1 = undismissable active alert. Tier 2 = dismissable insight. */
  tier: 1 | 2;
  severity: 'red' | 'amber' | 'green';
  title: string;
  children: React.ReactNode;
}

// ── Component ─────────────────────────────────────────────────────────────────

const InsightCard: React.FC<InsightCardProps> = ({
  id,
  nodeId,
  tier,
  severity,
  title,
  children,
}) => {
  const { dismissed, dismiss } = useInsightDismiss(id, nodeId);

  // Tier 1 cards are never dismissed; Tier 2 cards vanish when dismissed.
  if (tier === 2 && dismissed) return null;

  const borderCls =
    severity === 'red'   ? 'border-l-red-500/70'
    : severity === 'amber' ? 'border-l-amber-500/60'
    : 'border-l-green-500/60';

  const iconCls =
    severity === 'red'   ? 'text-red-400'
    : severity === 'amber' ? 'text-amber-400'
    : 'text-green-400';

  const Icon =
    severity === 'red'   ? AlertCircle
    : severity === 'amber' ? AlertTriangle
    : CheckCircle2;

  return (
    <div
      className={`bg-gray-800 border border-gray-700 border-l-[3px] ${borderCls} rounded-2xl overflow-hidden`}
    >
      {/* ── Title row ───────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-gray-700/60">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className={`w-3.5 h-3.5 shrink-0 ${iconCls}`} />
          <p className={`text-[10px] font-bold uppercase tracking-widest leading-none ${iconCls}`}>
            {title}
          </p>
        </div>

        {tier === 2 && (
          <button
            onClick={dismiss}
            aria-label="Dismiss"
            className="text-gray-600 hover:text-gray-400 transition-colors shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* ── Card content — children own their padding ────────────────────────── */}
      {children}
    </div>
  );
};

export default InsightCard;
