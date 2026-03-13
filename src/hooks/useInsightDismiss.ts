import { useState } from 'react';

/**
 * Per-session dismiss state for Insight cards.
 *
 * Keys are stored in sessionStorage — dismissed cards reappear on next page load.
 * Tier 1 cards never call this hook; only Tier 2 cards are dismissable.
 *
 * Key format:  insight-dismissed:<cardId>:<nodeId>   (per-node cards)
 *              insight-dismissed:<cardId>             (fleet-wide cards)
 */
export function useInsightDismiss(cardId: string, nodeId?: string) {
  const key = nodeId
    ? `insight-dismissed:${cardId}:${nodeId}`
    : `insight-dismissed:${cardId}`;

  const [dismissed, setDismissed] = useState(() =>
    sessionStorage.getItem(key) === 'true',
  );

  const dismiss = () => {
    sessionStorage.setItem(key, 'true');
    setDismissed(true);
  };

  return { dismissed, dismiss };
}
