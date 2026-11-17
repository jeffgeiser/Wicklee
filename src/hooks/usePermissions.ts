import { User, UserRole, SubscriptionTier, InsightsTier } from '../types';
import { isProOrAbove, isTeamOrAbove, isBusinessOrAbove } from '../utils/tier';

const SUBSCRIPTION_TO_INSIGHTS: Record<SubscriptionTier, InsightsTier> = {
  community:  'live_session',
  pro:        'persistent',
  team_10:    'trend',
  team:       'trend',
  business:   'trend',
  enterprise: 'predictive',
};

const INSIGHTS_ORDER: InsightsTier[] = [
  'live_session', 'persistent', 'trend', 'predictive',
];

/**
 * Insight tier gate — maps each of the 14 insights to the minimum InsightsTier
 * required to render the full card. Community users always see the card shell;
 * locked tiers render InsightsLockedCard instead of the real content.
 *
 * Source of truth: docs/INSIGHTS.md § Gating Implementation
 */
const INSIGHT_TIER_GATE: Record<number, InsightsTier> = {
  1:  'live_session',
  2:  'live_session',
  3:  'live_session',
  4:  'live_session',
  5:  'live_session',
  6:  'live_session',
  7:  'live_session',
  8:  'trend',
  9:  'trend',
  10: 'live_session',
  11: 'trend',
  12: 'trend',
  13: 'trend',
  14: 'predictive',
};

export const usePermissions = (user: User | null) => {
  const hasRole = (roles: UserRole[]) => {
    if (!user) return false;
    return roles.includes(user.role);
  };

  const subscriptionTier: SubscriptionTier = user?.tier ?? 'community';

  const insightsTier: InsightsTier = SUBSCRIPTION_TO_INSIGHTS[subscriptionTier];

  /**
   * Returns true if the user's insightsTier meets the requirement for
   * the given insight ID (1–14). See INSIGHT_TIER_GATE for the map.
   */
  const canViewInsight = (insightId: number): boolean => {
    const required = INSIGHT_TIER_GATE[insightId];
    if (!required) return false;
    return INSIGHTS_ORDER.indexOf(insightsTier) >= INSIGHTS_ORDER.indexOf(required);
  };

  return {
    isOwner:          user?.role === 'Owner',
    isCollaborator:   user?.role === 'Collaborator',
    isViewer:         user?.role === 'Viewer',
    canManageFleet:   hasRole(['Owner', 'Collaborator']),
    canRunAIAnalysis: hasRole(['Owner', 'Collaborator']),
    canManageTeam:    hasRole(['Owner']),

    subscriptionTier,
    insightsTier,
    canViewInsight,

    historyDays: (
      { community: 1, pro: 7, team_10: 90, team: 90, business: 365, enterprise: Infinity } as Record<SubscriptionTier, number>
    )[subscriptionTier],

    canGoSovereign: subscriptionTier === 'enterprise',
    hasPrometheusExport: isTeamOrAbove(subscriptionTier),

    isPro:        isProOrAbove(subscriptionTier),
    isTeamOrAbove:  isTeamOrAbove(subscriptionTier),
    isBusinessOrAbove: isBusinessOrAbove(subscriptionTier),
    isEnterprise: subscriptionTier === 'enterprise',
  };
};
