/**
 * Time-range selector config shared by the two history charts
 * (MetricsHistoryChart and WESHistoryChart): label, the minimum tier that
 * unlocks the range, the history depth it needs, and the x-axis formatter.
 */

import type { SubscriptionTier } from '../types';
import { tierLabel } from './tier';

export type TimeRange = '1h' | '24h' | '7d' | '30d' | '90d';

export const RANGE_CONFIG: Record<TimeRange, {
  label:      string;
  minTier:    SubscriptionTier;
  historyMin: number;    // historyDays required
  fmtTs:      (ms: number) => string;
}> = {
  '1h':  { label: '1H',  minTier: 'community', historyMin: 1,  fmtTs: (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
  '24h': { label: '24H', minTier: 'community', historyMin: 1,  fmtTs: (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
  '7d':  { label: '7D',  minTier: 'pro',       historyMin: 7,  fmtTs: (ms) => new Date(ms).toLocaleDateString([], { month: 'numeric', day: 'numeric' }) },
  '30d': { label: '30D', minTier: 'team',      historyMin: 30, fmtTs: (ms) => new Date(ms).toLocaleDateString([], { month: 'numeric', day: 'numeric' }) },
  '90d': { label: '90D', minTier: 'team',      historyMin: 90, fmtTs: (ms) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' }) },
};

export const RANGES: TimeRange[] = ['1h', '24h', '7d', '30d', '90d'];

/** "Requires <tier>" label for a locked range; empty for Community ranges. */
export function tierUpgradeLabel(minTier: SubscriptionTier): string {
  return minTier === 'community' ? '' : tierLabel(minTier);
}
