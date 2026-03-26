import React from 'react';
import { Lock } from 'lucide-react';
import type { SubscriptionTier } from '../types';

// ── SubscriptionGuard ────────────────────────────────────────────────────────
//
// Wraps children with a locked overlay when the user's tier is below
// `requiredTier`. Children render at 40% opacity with a blur, and a centered
// badge links to the upgrade path.
//
// Usage:
//   <SubscriptionGuard requiredTier="pro" currentTier={permissions.subscriptionTier}>
//     <ProOnlyWidget />
//   </SubscriptionGuard>

interface SubscriptionGuardProps {
  /** Minimum tier required to view the content. */
  requiredTier: 'pro' | 'team' | 'enterprise';
  /** The user's current tier (null = community). */
  currentTier?: SubscriptionTier | null;
  /** Navigate to pricing / upgrade. */
  onUpgrade?: () => void;
  children: React.ReactNode;
}

const TIER_RANK: Record<string, number> = {
  community: 1,
  pro: 2,
  team: 3,
  enterprise: 4,
};

const TIER_LABEL: Record<string, string> = {
  pro: 'Pro',
  team: 'Team',
  enterprise: 'Enterprise',
};

const TIER_COLOR: Record<string, string> = {
  pro: 'text-blue-400 bg-blue-500/10 border-blue-500/30',
  team: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  enterprise: 'text-purple-400 bg-purple-500/10 border-purple-500/30',
};

const SubscriptionGuard: React.FC<SubscriptionGuardProps> = ({
  requiredTier,
  currentTier,
  onUpgrade,
  children,
}) => {
  const userRank  = TIER_RANK[currentTier ?? 'community'] ?? 1;
  const needed    = TIER_RANK[requiredTier] ?? 2;

  if (userRank >= needed) {
    return <>{children}</>;
  }

  return (
    <div className="relative">
      {/* Blurred locked content */}
      <div className="opacity-40 blur-[2px] pointer-events-none select-none" aria-hidden>
        {children}
      </div>

      {/* Overlay badge */}
      <div className="absolute inset-0 flex items-center justify-center z-10">
        <button
          onClick={onUpgrade}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold border transition-all hover:scale-105 ${
            TIER_COLOR[requiredTier] ?? TIER_COLOR.pro
          }`}
        >
          <Lock className="w-3.5 h-3.5" />
          Available on {TIER_LABEL[requiredTier] ?? requiredTier} &rarr;
        </button>
      </div>
    </div>
  );
};

export default SubscriptionGuard;
