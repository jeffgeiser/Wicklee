/**
 * Shared reachability constants and time helpers.
 * Used by the SSE indicator, Fleet Status rows, Management node rows, and footer.
 */

/** A node is considered reachable if its last_seen_ms is within this window. */
export const NODE_REACHABLE_MS = 60_000;

/**
 * Human-readable elapsed time: "just now" / "5m ago" / "3h ago" / "2d ago".
 * `seconds: true` shows "42s ago" instead of "just now" under a minute —
 * for live feeds and last-seen readouts where second-level freshness matters.
 * A timestamp slightly in the future (clock skew) reads as zero elapsed.
 */
export const fmtAgo = (ms: number, opts?: { seconds?: boolean }): string => {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60)    return opts?.seconds ? `${s}s ago` : 'just now';
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
