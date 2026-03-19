import { useState, useEffect } from 'react';

/**
 * Per-session dismiss state for Insight cards.
 *
 * Primary store: localStorage (works offline, survives reload, zero-latency).
 * Secondary store: agent DuckDB via POST localhost:7700/api/insights/dismiss
 *   — best-effort, fire-and-forget. Persists across browser clears + syncs
 *   across tabs/devices that share the same local agent.
 *
 * On mount, active dismissals are fetched from the agent and merged into
 * localStorage so a page reload after agent restart inherits previous decisions.
 *
 * Keys:
 *   insight-dismissed:<cardId>:<nodeId>   (per-node cards)
 *   insight-dismissed:<cardId>            (fleet-wide cards)
 */

const PERSIST_MS   = 24 * 60 * 60 * 1_000; // 24 hours (default TTL)
const AGENT_BASE   = 'http://localhost:7700';
const DISMISS_URL  = `${AGENT_BASE}/api/insights/dismiss`;
const DISMISSED_URL = `${AGENT_BASE}/api/insights/dismissed`;

// ── localStorage helpers ──────────────────────────────────────────────────────

function lsKey(cardId: string, nodeId?: string): string {
  return nodeId
    ? `insight-dismissed:${cardId}:${nodeId}`
    : `insight-dismissed:${cardId}`;
}

function readDismissed(key: string): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { dismissed?: boolean; expiresAt?: number };
    return parsed.dismissed === true
        && typeof parsed.expiresAt === 'number'
        && Date.now() < parsed.expiresAt;
  } catch {
    return false;
  }
}

function writeDismissed(key: string, expiresAt: number): void {
  try {
    localStorage.setItem(key, JSON.stringify({ dismissed: true, expiresAt }));
  } catch {
    /* QuotaExceededError — degrade gracefully */
  }
}

// ── Agent sync (module-level, runs once) ─────────────────────────────────────

/**
 * On first load, pull active dismissals from the agent and merge into
 * localStorage.  Fires once per page load; errors are silently swallowed.
 */
let agentSyncDone = false;

function syncDismissalsFromAgent(): void {
  if (agentSyncDone) return;
  agentSyncDone = true;

  fetch(DISMISSED_URL, { signal: AbortSignal.timeout?.(3_000) ?? undefined })
    .then(r => r.ok ? r.json() : null)
    .then((data: { dismissals?: Array<{ pattern_id: string; node_id: string; expires_at_ms: number }> } | null) => {
      if (!data?.dismissals) return;
      for (const d of data.dismissals) {
        // node_id is '' for fleet-wide (agent sentinel)
        const key = d.node_id
          ? `insight-dismissed:${d.pattern_id}:${d.node_id}`
          : `insight-dismissed:${d.pattern_id}`;
        // Only write if the agent has a longer-lived record than what's in localStorage
        const existing = (() => {
          try {
            const raw = localStorage.getItem(key);
            return raw ? (JSON.parse(raw) as { expiresAt?: number }).expiresAt ?? 0 : 0;
          } catch { return 0; }
        })();
        if (d.expires_at_ms > existing) {
          writeDismissed(key, d.expires_at_ms);
        }
      }
    })
    .catch(() => { /* agent offline — no-op */ });
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useInsightDismiss(cardId: string, nodeId?: string) {
  const key = lsKey(cardId, nodeId);

  // Sync from agent once per page load (fires on first hook instantiation)
  useEffect(() => {
    syncDismissalsFromAgent();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [dismissed, setDismissed] = useState(() => readDismissed(key));

  /**
   * Dismiss this insight card.
   *
   * @param expiresInMs  How long to suppress (default 24 h). Pass
   *                     `Infinity` for permanent (maps to 10-year expiry).
   * @param note         Optional operator note stored in agent DuckDB.
   */
  const dismiss = (expiresInMs = PERSIST_MS, note?: string) => {
    const safeExpiry = Number.isFinite(expiresInMs) ? expiresInMs : 10 * 365 * 24 * 60 * 60 * 1_000;
    const expiresAt  = Date.now() + safeExpiry;

    // 1. Write localStorage immediately — zero-latency, works offline.
    writeDismissed(key, expiresAt);
    setDismissed(true);

    // 2. Persist to agent — best-effort, fire-and-forget.
    fetch(DISMISS_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        pattern_id:    cardId,
        node_id:       nodeId ?? null,
        expires_at_ms: expiresAt,
        note:          note ?? null,
      }),
      signal: AbortSignal.timeout?.(4_000) ?? undefined,
    }).catch(() => { /* agent offline — localStorage is the source of truth */ });
  };

  return { dismissed, dismiss };
}
