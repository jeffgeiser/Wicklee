/**
 * tier.ts — the subscription-tier ordering and the predicates built on it.
 *
 * Before this file, "is this tier Team or above?" was spelled out as a chain
 * of `=== 'team' || === 'enterprise'` in six components, and each chain was a
 * place a tier could be forgotten. It happened twice: `business` was missing
 * from MetricsHistoryChart's rank map (Business accounts got less history than
 * Team) and from two backend gates. Adding `team_10` would have been a seventh
 * edit. Now the union type drives one table and the compiler refuses a missing
 * key.
 */

import type { SubscriptionTier } from '../types';
import { TIER_BADGE } from '../types';

/** Ascending entitlement order. Both Team sizes share a rank — the size is a
 *  node cap, not a feature level. */
export const TIER_RANK: Record<SubscriptionTier, number> = {
  community:  0,
  pro:        1,
  team_10:    2,
  team:       2,
  business:   3,
  enterprise: 4,
};

/** Accepts plain strings on purpose: the tier arrives from Clerk metadata as
 *  text and several components carry it as `string`. An unknown string ranks 0
 *  — fail closed, the same rule the Rust helpers follow. */
export const tierRank = (t: string | null | undefined): number =>
  t ? (TIER_RANK[t as SubscriptionTier] ?? 0) : 0;

export const isProOrAbove      = (t: string | null | undefined) => tierRank(t) >= TIER_RANK.pro;
export const isTeamOrAbove     = (t: string | null | undefined) => tierRank(t) >= TIER_RANK.team;
export const isBusinessOrAbove = (t: string | null | undefined) => tierRank(t) >= TIER_RANK.business;

/** Display label, from the same table the badges use. */
export const tierLabel = (t: SubscriptionTier): string => TIER_BADGE[t].label;

/** Cloud fleet-view node cap per tier. Mirrors node_limit_for_tier() in
 *  cloud/src/main.rs — keep the two in sync. */
export const NODE_LIMIT: Record<SubscriptionTier, number> = {
  community:  3,
  pro:        10,
  team_10:    10,
  team:       25,
  business:   100,
  enterprise: Infinity,
};
