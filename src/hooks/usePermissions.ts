import { User, UserRole, SubscriptionTier, InsightsTier } from '../types';

// ── Tier mappings ──────────────────────────────────────────────────────────────

const SUBSCRIPTION_TO_INSIGHTS: Record<SubscriptionTier, InsightsTier> = {
  community:  'live_session',
  pro:        'persistent',
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
  1:  'live_session',   // Thermal Degradation     — Community
  2:  'live_session',   // Power Anomaly            — Community
  3:  'live_session',   // Memory Exhaustion        — Community
  4:  'live_session',   // Model Fit Score          — Community (was Pro)
  5:  'live_session',   // Model Eviction           — Community (was Pro)
  6:  'live_session',   // Idle Resource Cost       — Community
  7:  'live_session',   // WES Peer Leaderboard     — Community
  8:  'trend',          // Efficiency Regression    — Team
  9:  'trend',          // Memory Forecast          — Team
  10: 'live_session',   // Quantization ROI         — Community (was Team)
  11: 'trend',          // Hardware Cold Start      — Team
  12: 'trend',          // Fleet Thermal Diversity  — Team
  13: 'trend',          // Inference Density        — Team
  14: 'predictive',     // Sovereignty Audit        — Enterprise
};

// ── Hook ──────────────────────────────────────────────────────────────────────

export const usePermissions = (user: User | null) => {
  const hasRole = (roles: UserRole[]) => {
    if (!user) return false;
    return roles.includes(user.role);
  };

  // Resolve subscription tier from Clerk publicMetadata (set by Paddle webhook).
  // Default: community (free tier).
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

    // ── History depth ─────────────────────────────────────────────────────
    historyDays: (
      { community: 1, pro: 7, team: 90, business: 90, enterprise: Infinity } as Record<SubscriptionTier, number>
    )[subscriptionTier],

    // ── Enterprise capabilities ───────────────────────────────────────────
    // canGoSovereign: Enterprise-only. Airgapped mode — no outbound telemetry,
    //   no cloud pairing. On-prem Docker/Helm deployment path.
    canGoSovereign: subscriptionTier === 'enterprise',
    // hasPrometheusExport: Enterprise-only. Exposes /metrics endpoint in
    //   Prometheus exposition format for operator scraping into existing infra.
    hasPrometheusExport: subscriptionTier === 'enterprise',

    // ── Convenience booleans ──────────────────────────────────────────────
    isPro:        subscriptionTier !== 'community',
    isTeamOrAbove:  subscriptionTier === 'team' || subscriptionTier === 'business' || subscriptionTier === 'enterprise',
    isBusinessOrAbove: subscriptionTier === 'business' || subscriptionTier === 'enterprise',
    isEnterprise: subscriptionTier === 'enterprise',
  };
};
