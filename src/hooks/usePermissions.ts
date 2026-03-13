import { User, UserRole, SubscriptionTier, InsightsTier } from '../types';

// ── Tier mappings ──────────────────────────────────────────────────────────────

const SUBSCRIPTION_TO_INSIGHTS: Record<SubscriptionTier, InsightsTier> = {
  community:  'live_session',
  pro:        'persistent',
  team:       'trend',
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
  1:  'live_session',   // Thermal Degradation     — Community
  2:  'live_session',   // Power Anomaly            — Community
  3:  'live_session',   // Memory Exhaustion        — Community
  4:  'persistent',     // Model Fit Score          — Pro
  5:  'persistent',     // Model Eviction           — Pro
  6:  'persistent',     // Idle Resource Cost       — Pro
  7:  'persistent',     // WES Peer Leaderboard     — Pro
  8:  'trend',          // Efficiency Regression    — Team
  9:  'trend',          // Memory Forecast          — Team
  10: 'trend',          // Quantization ROI         — Team
  11: 'trend',          // Hardware Cold Start      — Team
  12: 'trend',          // Fleet Thermal Diversity  — Team
  13: 'trend',          // Inference Density        — Team
  14: 'predictive',     // Sovereignty Audit        — Enterprise
};

// ── Dev tier override ──────────────────────────────────────────────────────────

/**
 * URL param override for local development — never affects production users.
 * Usage: append ?devTier=pro (or team / enterprise) to the URL.
 * Clerk publicMetadata is the authoritative source in production.
 *
 * Example: http://localhost:5173/?devTier=team
 */
function getDevTierOverride(): SubscriptionTier | null {
  try {
    const p = new URLSearchParams(window.location.search).get('devTier');
    if (p === 'community' || p === 'pro' || p === 'team' || p === 'enterprise') {
      return p as SubscriptionTier;
    }
  } catch {
    /* SSR or window unavailable */
  }
  return null;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export const usePermissions = (user: User | null) => {
  const hasRole = (roles: UserRole[]) => {
    if (!user) return false;
    return roles.includes(user.role);
  };

  // Resolve subscription tier:
  //   1. ?devTier= URL param (dev/testing only)
  //   2. user.tier from Clerk publicMetadata
  //   3. Default: community
  const subscriptionTier: SubscriptionTier =
    getDevTierOverride() ?? user?.tier ?? 'community';

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
    // ── RBAC (role-based) ──────────────────────────────────────────────────
    isOwner:          user?.role === 'Owner',
    isCollaborator:   user?.role === 'Collaborator',
    isViewer:         user?.role === 'Viewer',
    canManageFleet:   hasRole(['Owner', 'Collaborator']),
    canViewScaffolding: hasRole(['Owner', 'Collaborator']),
    canRunAIAnalysis: hasRole(['Owner', 'Collaborator']),
    canManageTeam:    hasRole(['Owner']),

    // ── Subscription tier ─────────────────────────────────────────────────
    subscriptionTier,
    insightsTier,
    canViewInsight,

    // ── Convenience booleans ──────────────────────────────────────────────
    isPro:        subscriptionTier !== 'community',
    isTeamOrAbove:  subscriptionTier === 'team' || subscriptionTier === 'enterprise',
    isEnterprise: subscriptionTier === 'enterprise',
  };
};
