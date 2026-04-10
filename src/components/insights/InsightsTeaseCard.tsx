/**
 * InsightsTeaseCard
 *
 * Replacement for InsightsLockedCard on Team-tier cards. Instead of a pure
 * blurred placeholder, this shows real live data so Community users get
 * immediate value while still driving organic upgrade to Team for trend history.
 *
 * Pattern:
 *   - Header (same chrome as InsightsLockedCard)
 *   - liveContent — rendered fully, no blur, no lock icon
 *   - Blurred "trend area" below — represents the Team-only history charts
 *   - Lock icon centered on the blurred area
 *   - Upgrade CTA at the bottom
 *
 * Rules:
 *   - liveContent comes from the caller — always live SSE data, never mock.
 *   - Blurred trend area is always a static placeholder (no fake data).
 *   - Used only for Team-tier cards; Enterprise cards continue to use InsightsLockedCard.
 *
 * Spec: docs/INSIGHTS.md § Tease Card Pattern
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

interface InsightsTeaseCardProps {
  title: string;
  icon: React.ReactNode;
  /** Minimum tier required for full (trend) view */
  tierRequired: SubscriptionTier;
  /** CTA copy — shown below the blurred trend area */
  upgradeCopy: string;
  /** Live SSE-derived content — always shown, never blurred */
  liveContent: React.ReactNode;
  onUpgradeClick?: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

const InsightsTeaseCard: React.FC<InsightsTeaseCardProps> = ({
  title,
  icon,
  tierRequired,
  upgradeCopy,
  liveContent,
  onUpgradeClick,
}) => {
  const label = tierLabel(tierRequired);
  const style = TIER_STYLE[label] ?? TIER_STYLE.Team;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex flex-col gap-3 relative overflow-hidden">

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

      {/* Live content — fully visible, no blur */}
      <div>{liveContent}</div>

      {/* Blurred trend placeholder — represents historical chart area */}
      <div className="relative mt-1">
        <div
          className="h-16 bg-gray-800/40 rounded-lg blur-sm select-none pointer-events-none"
          aria-hidden
        />
        <div className="absolute inset-0 flex items-center justify-center">
          <Lock className="w-4 h-4 text-gray-600" />
        </div>
      </div>

      {/* Upgrade CTA */}
      <button
        onClick={onUpgradeClick}
        className="text-xs text-indigo-500 hover:text-indigo-400 transition-colors text-left"
      >
        {upgradeCopy}
      </button>
    </div>
  );
};

export default InsightsTeaseCard;
