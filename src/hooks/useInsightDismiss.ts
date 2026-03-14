import { useState } from 'react';

/**
 * Per-session dismiss state for Insight cards.
 *
 * Keys are stored in localStorage with a 24-hour expiry — dismissed cards
 * reappear on next page load after 24h. Tier 1 cards never call this hook;
 * only Tier 2 cards are dismissable.
 *
 * Key format:  insight-dismissed:<cardId>:<nodeId>   (per-node cards)
 *              insight-dismissed:<cardId>             (fleet-wide cards)
 */

const PERSIST_MS = 24 * 60 * 60 * 1_000; // 24 hours

function readDismissed(key: string): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { dismissed?: boolean; expiresAt?: number };
    return parsed.dismissed === true && typeof parsed.expiresAt === 'number' && Date.now() < parsed.expiresAt;
  } catch {
    return false;
  }
}

export function useInsightDismiss(cardId: string, nodeId?: string) {
  const key = nodeId
    ? `insight-dismissed:${cardId}:${nodeId}`
    : `insight-dismissed:${cardId}`;

  const [dismissed, setDismissed] = useState(() => readDismissed(key));

  const dismiss = () => {
    try {
      localStorage.setItem(key, JSON.stringify({ dismissed: true, expiresAt: Date.now() + PERSIST_MS }));
    } catch {
      /* storage unavailable — degrade gracefully */
    }
    setDismissed(true);
  };

  return { dismissed, dismiss };
}
