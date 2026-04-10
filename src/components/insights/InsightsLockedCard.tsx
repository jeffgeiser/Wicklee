/**
 * InsightsLockedCard
 *
 * Gate wrapper for insight cards that require a higher subscription tier.
 * Always rendered (never hidden) — provides product roadmap visibility to
 * lower-tier users and drives organic upgrade consideration.
 *
 * Rules:
 *  - No mock or sample data in the blurred body — description text only.
 *  - Full card chrome at same dimensions as the live card.
 *  - "Available on [Tier] →" CTA links to billing/upgrade flow.
 *
 * Spec: docs/INSIGHTS.md § Locked Card Pattern
 */

import React from 'react';
import { Lock } from 'lucide-react';
import { SubscriptionTier } from '../../types';

// ── Tier styling ───────────────────────────────────────────────────────────────

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
    business:   'Business',
    enterprise: 'Enterprise',
  };
  return map[t];
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface InsightsLockedCardProps {
  title: string;
  icon: React.ReactNode;
  description: string;
  /** Minimum tier required to unlock this card */
  tierRequired: SubscriptionTier;
  onUpgradeClick?: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

const InsightsLockedCard: React.FC<InsightsLockedCardProps> = ({
  title,
  icon,
  description,
  tierRequired,
  onUpgradeClick,
}) => {
  const label = tierLabel(tierRequired);
  const style = TIER_STYLE[label] ?? TIER_STYLE.Pro;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex flex-col gap-3 relative overflow-hidden">

      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-gray-600 shrink-0">{icon}</span>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-600 truncate">
            {title}
          </span>
        </div>
        <span className={`text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded border shrink-0 ${style}`}>
          {label}
        </span>
      </div>

      {/* Blurred placeholder body */}
      <div className="relative py-1">
        <div className="blur-sm select-none pointer-events-none space-y-2" aria-hidden>
          <div className="h-6 bg-gray-800 rounded-lg w-2/3" />
          <div className="h-3 bg-gray-800/60 rounded w-1/2" />
        </div>
        <div className="absolute inset-0 flex items-center justify-center">
          <Lock className="w-4 h-4 text-gray-600" />
        </div>
      </div>

      {/* Description */}
      <p className="text-[11px] text-gray-600 leading-relaxed">{description}</p>

      {/* Upgrade CTA */}
      <button
        onClick={onUpgradeClick}
        className="text-xs text-indigo-500 hover:text-indigo-400 transition-colors text-left"
      >
        Available on {label} →
      </button>
    </div>
  );
};

export default InsightsLockedCard;
