/**
 * InsightsLiteCard
 *
 * Partial-data wrapper for insight cards where Community users can see
 * a reduced view (e.g., a single score or ranking) but the full card
 * (sparklines, history charts, deep breakdown) requires Pro or higher.
 *
 * Used for: Model Fit Score (#4) and WES Leaderboard (#7) in Section 1.
 *
 * Lite view rationale:
 *   These cards have immediate signal value even without history depth.
 *   Showing a single number is honest, non-deceptive, and drives organic
 *   upgrade curiosity ("how do I see the full trend?").
 *
 * Spec: docs/INSIGHTS.md § Section A lite-view rationale
 */

import React from 'react';
import { SubscriptionTier } from '../../types';

const TIER_STYLE: Record<string, string> = {
  Pro:        'text-blue-400 bg-blue-500/10 border-blue-500/25',
  Team:       'text-violet-400 bg-violet-500/10 border-violet-500/25',
  Enterprise: 'text-amber-400 bg-amber-500/10 border-amber-500/25',
};

function tierLabel(t: SubscriptionTier): string {
  const map: Record<SubscriptionTier, string> = {
    community:  'Community',
    pro:        'Pro',
    team:       'Team',
    enterprise: 'Enterprise',
  };
  return map[t];
}

interface InsightsLiteCardProps {
  title: string;
  icon: React.ReactNode;
  /** Tier needed for the full card — shown as badge + upgrade CTA */
  tierRequired: SubscriptionTier;
  /** Override the default "Unlock full view on [Tier] →" CTA copy */
  upgradeCopy?: string;
  onUpgradeClick?: () => void;
  children: React.ReactNode;
}

const InsightsLiteCard: React.FC<InsightsLiteCardProps> = ({
  title,
  icon,
  tierRequired,
  upgradeCopy,
  onUpgradeClick,
  children,
}) => {
  const label = tierLabel(tierRequired);
  const style = TIER_STYLE[label] ?? TIER_STYLE.Pro;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex flex-col gap-3">

      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-gray-500 shrink-0">{icon}</span>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 truncate">
            {title}
          </span>
        </div>
        <span className={`text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded border shrink-0 ${style}`}>
          {label}
        </span>
      </div>

      {/* Lite content — caller controls what's shown */}
      <div>{children}</div>

      {/* Upgrade CTA */}
      <button
        onClick={onUpgradeClick}
        className="text-xs text-indigo-500 hover:text-indigo-400 transition-colors text-left"
      >
        {upgradeCopy ?? `Unlock full view on ${label} →`}
      </button>
    </div>
  );
};

export default InsightsLiteCard;
