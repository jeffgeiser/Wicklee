/**
 * useEventHistory — paginated DuckDB-backed event history for the Observability tab.
 *
 * Fetches persisted Live Activity events from:
 *   - Cockpit (localhost):  GET /api/events/history
 *   - Fleet   (wicklee.dev): GET /api/fleet/events/history
 *
 * Cursor-based pagination via the `before` parameter (ts_ms of the last event).
 */

import { useState, useCallback, useEffect } from 'react';
import type { EventHistoryRecord } from '../types';

interface UseEventHistoryOptions {
  /** Max events per page (default 50, max 200). */
  limit?: number;
  /** Filter by event_type (e.g. "startup", "update"). */
  eventType?: string;
  /** If true, fetch from wicklee.dev fleet endpoint; else localhost agent. */
  isFleet?: boolean;
  /** Auth token for fleet mode. */
  token?: string;
}

interface UseEventHistoryReturn {
  events:   EventHistoryRecord[];
  loading:  boolean;
  error:    string | null;
  hasMore:  boolean;
  loadMore: () => void;
  refresh:  () => void;
}

const PAGE_SIZE_DEFAULT = 50;

export function useEventHistory(opts: UseEventHistoryOptions = {}): UseEventHistoryReturn {
  const limit    = opts.limit ?? PAGE_SIZE_DEFAULT;
  const isFleet  = opts.isFleet ?? false;

  const [events,  setEvents]  = useState<EventHistoryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);

  const fetchPage = useCallback(async (before?: number) => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      if (before != null) params.set('before', String(before));
      if (opts.eventType)  params.set('event_type', opts.eventType);

      const baseUrl = isFleet ? '' : 'http://localhost:7700';
      const path    = isFleet ? '/api/fleet/events/history' : '/api/events/history';
      const headers: Record<string, string> = {};
      if (isFleet && opts.token) {
        headers['Authorization'] = `Bearer ${opts.token}`;
      }

      const res = await fetch(`${baseUrl}${path}?${params}`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const page: EventHistoryRecord[] = data.events ?? [];

      setHasMore(page.length >= limit);

      if (before != null) {
        // Append (pagination)
        setEvents(prev => [...prev, ...page]);
      } else {
        // Fresh load
        setEvents(page);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [limit, opts.eventType, opts.token, isFleet]);

  // Initial load
  useEffect(() => {
    fetchPage();
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (events.length > 0 && hasMore && !loading) {
      const lastTs = events[events.length - 1].ts_ms;
      fetchPage(lastTs);
    }
  }, [events, hasMore, loading, fetchPage]);

  const refresh = useCallback(() => {
    setEvents([]);
    setHasMore(true);
    fetchPage();
  }, [fetchPage]);

  return { events, loading, error, hasMore, loadMore, refresh };
}
