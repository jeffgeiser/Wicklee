/**
 * insightLifecycle.ts — Sprint 4 localStorage buffer for the 24h insight event log.
 *
 * Three-tier logging overview:
 *   1. Live Activity Feed  — FleetEvent 'pattern_onset' / 'pattern_resolved' / 'pattern_dismissed'
 *                            emitted by AIInsights.tsx and consumed by the feed panel.
 *   2. Recent Events       — InsightRecentEvent[] in localStorage (this file).
 *                            24h rolling window, consumed by InsightsBriefingCard.
 *   3. Audit Trail         — pattern_transitions table in metrics.db (Sprint 6).
 *
 * Alert-fatigue constants
 * ─────────────────────────────────────────────────────────────────────────────
 * ONSET_SUPPRESSION_MS > OBS_HOLD_MS by design.
 *
 * Timeline for a pattern that resolves and immediately re-fires:
 *   T+0m  → onset emitted   (ONSET_SUPPRESSION_MS starts)
 *   T+10m → resolved emitted (OBS_HOLD_MS elapses — condition confirmed gone)
 *   T+15m → next onset permitted (ONSET_SUPPRESSION_MS elapses)
 *
 * The 5-minute quiet window prevents borderline conditions from producing
 * rapid onset/resolved churn in the Live Activity Feed and localStorage buffer.
 */

import type { ActionId, PatternConfidence } from './patternEngine';

// ── Alert-fatigue constants ───────────────────────────────────────────────────

/**
 * Pattern must be continuously absent for this long before pattern_resolved fires.
 * Mirrors the OBS_HOLD_MS constant in AIInsights.tsx — keep in sync.
 */
export const OBS_HOLD_MS = 10 * 60 * 1000;   // 10 min

/**
 * Minimum elapsed time before a pattern_onset may re-fire for the same
 * patternId + nodeId pair. Intentionally longer than OBS_HOLD_MS to create
 * a 5-minute quiet gap after resolution.
 */
export const ONSET_SUPPRESSION_MS = 15 * 60 * 1000;   // 15 min

// ── InsightRecentEvent ────────────────────────────────────────────────────────

export interface InsightRecentEvent {
  /** UUID — stable identifier for dedup inside InsightsBriefingCard. */
  id:             string;
  /** Date.now() at the moment of the transition. */
  ts:             number;
  eventType:      'onset' | 'resolved' | 'dismissed';
  nodeId:         string;
  hostname:       string;
  patternId:      string;
  /** Human-readable card title, e.g. "Thermal Performance Drain". */
  title:          string;
  action_id:      ActionId;
  /** The hook string captured at the time of the event, e.g. "-4.2 tok/s". */
  hook:           string;
  /** Recommendation text from DetectedInsight (populated on onset). */
  recommendation: string;
  /** Confidence level at onset — omitted for 'resolved' / 'dismissed' events. */
  confidence?:    PatternConfidence;
  /**
   * WES score captured at the moment of onset.
   * Null when WES is unavailable (e.g. no active inference).
   * Populated on 'onset' events only; omitted on 'resolved' / 'dismissed'.
   * Used by InsightsBriefingCard to show "WES 181.5 → 142.0" diffs.
   */
  wes_at_onset?:  number | null;
  /**
   * Actual hardware stress duration in ms (only present on 'resolved' events).
   * Calculated as: lastSeenFiringMs − onsetMs
   * Excludes the OBS_HOLD_MS confirmation wait — reflects real stress time.
   */
  durationMs?:    number;
  /**
   * The fleet peer this insight recommended routing to at the time of onset.
   * Null for local-action patterns (evict model, reduce batch, check thermal).
   *
   * InsightsBriefingCard verifies this node's current online status at render
   * time via useFleetStream() — the peer may have gone offline since capture.
   * If offline, the recommendation is shown with a stale-node warning and the
   * routing action is suppressed until the operator queries /api/v1/route/best.
   */
  best_node_id?:       string | null;
  best_node_hostname?: string | null;
}

// ── Storage config ────────────────────────────────────────────────────────────

/** localStorage key — version-tagged so a schema change triggers a clean start. */
const EVENTS_KEY = 'insight-events:v1';

/** How long events are retained. Events older than this are pruned on each read. */
const TTL_MS = 24 * 60 * 60 * 1000;   // 24h

/** Maximum events stored across all nodes. Oldest are pruned first when exceeded. */
const MAX_EVENTS = 500;

// ── Read / write helpers ──────────────────────────────────────────────────────

/**
 * Read all recent events from localStorage, pruning any older than TTL_MS.
 * Returns newest-first. Safe to call on every render — cheap JSON parse + filter.
 */
export function readRecentEvents(): InsightRecentEvent[] {
  try {
    const raw = localStorage.getItem(EVENTS_KEY);
    if (!raw) return [];
    const all = JSON.parse(raw) as InsightRecentEvent[];
    const cutoff = Date.now() - TTL_MS;
    return all.filter(e => e.ts > cutoff);
  } catch {
    return [];
  }
}

/**
 * Append a single event to the buffer. Prunes expired events and enforces MAX_EVENTS.
 * Safe to call in rapid succession — each call reads + writes the full array.
 */
export function appendRecentEvent(event: InsightRecentEvent): void {
  try {
    let events = readRecentEvents();          // already TTL-pruned
    events = [event, ...events];              // newest first
    if (events.length > MAX_EVENTS) {
      events = events.slice(0, MAX_EVENTS);   // drop oldest beyond cap
    }
    localStorage.setItem(EVENTS_KEY, JSON.stringify(events));
  } catch {
    // Storage unavailable (private browsing, quota exceeded) — degrade gracefully.
  }
}

// ── Morning Briefing helpers ──────────────────────────────────────────────────

/**
 * Dedup helper for InsightsBriefingCard: returns only the most recent 'onset'
 * per patternId + nodeId pair within the 24h window.
 *
 * Rationale: if a thermal drain fired 3 times overnight, the operator needs to
 * know it happened — not see 3 identical rows. A "×N in 24h" count badge is
 * added by the card for repeated patterns.
 */
export function deduplicateOnsets(events: InsightRecentEvent[]): {
  event: InsightRecentEvent;
  count: number;
}[] {
  const seen   = new Map<string, { event: InsightRecentEvent; count: number }>();
  const onsets = events.filter(e => e.eventType === 'onset');

  for (const e of onsets) {
    const key = `${e.patternId}:${e.nodeId}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { event: e, count: 1 });
    } else {
      // Already have a newer entry (onsets are newest-first) — just increment count
      existing.count++;
    }
  }

  return [...seen.values()];
}

/** Format a duration (ms) as a human-readable string like "14m" or "2h 7m". */
export function fmtDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Format a timestamp as a relative age like "just now", "14m ago", "3h ago". */
export function fmtEventAge(ts: number): string {
  const elapsed = Date.now() - ts;
  const m = Math.round(elapsed / 60_000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
