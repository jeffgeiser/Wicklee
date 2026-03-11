/**
 * Shared reachability constants and time helpers.
 * Used by the SSE indicator, Fleet Status rows, Management node rows, and footer.
 */

/** A node is considered reachable if its last_seen_ms is within this window. */
export const NODE_REACHABLE_MS = 60_000;

/**
 * Human-readable elapsed time — <60s returns "just now".
 * Use for dot tooltips and reachability display.
 */
export const fmtAgo = (ms: number): string => {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60)    return 'just now';
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
