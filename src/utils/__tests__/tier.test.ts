/**
 * The tier ordering is a contract between the pricing page, the permission
 * hook, the range gates and the backend's node_limit_for_tier(). These tests
 * pin the two facts that were broken before tier.ts existed: Business ranks
 * above Team (it had been missing from a rank map and got LESS history than
 * Team), and the two Team sizes are the same tier for every feature gate.
 */

import { describe, it, expect } from 'vitest';
import { TIER_RANK, NODE_LIMIT, tierRank, isProOrAbove, isTeamOrAbove, isBusinessOrAbove, tierLabel } from '../tier';
import { TIER_BADGE } from '../../types';
import type { SubscriptionTier } from '../../types';

const ALL: SubscriptionTier[] = ['community', 'pro', 'team_10', 'team', 'business', 'enterprise'];

describe('tier ordering', () => {
  it('is monotonic in the documented order', () => {
    for (let i = 1; i < ALL.length; i++) {
      expect(TIER_RANK[ALL[i]]).toBeGreaterThanOrEqual(TIER_RANK[ALL[i - 1]]);
    }
    expect(TIER_RANK.business).toBeGreaterThan(TIER_RANK.team);
  });

  it('treats both Team sizes as the same tier for feature gates', () => {
    expect(TIER_RANK.team_10).toBe(TIER_RANK.team);
    for (const t of ['team_10', 'team'] as const) {
      expect(isTeamOrAbove(t)).toBe(true);
      expect(isProOrAbove(t)).toBe(true);
      expect(isBusinessOrAbove(t)).toBe(false);
    }
  });

  it('fails closed on unknown or missing strings', () => {
    expect(tierRank('gold')).toBe(0);
    expect(tierRank(null)).toBe(0);
    expect(tierRank(undefined)).toBe(0);
    expect(isProOrAbove('')).toBe(false);
  });
});

describe('node caps', () => {
  it('differ only by size between the two Team plans', () => {
    expect(NODE_LIMIT.team_10).toBe(10);
    expect(NODE_LIMIT.team).toBe(25);
    expect(NODE_LIMIT.community).toBe(3);
    expect(NODE_LIMIT.enterprise).toBe(Infinity);
  });
});

describe('labels', () => {
  it('every tier has a badge and a label', () => {
    for (const t of ALL) {
      expect(TIER_BADGE[t].label.length).toBeGreaterThan(0);
      expect(tierLabel(t)).toBe(TIER_BADGE[t].label);
    }
  });
});
