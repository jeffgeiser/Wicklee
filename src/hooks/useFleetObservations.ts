/**
 * useFleetObservations — fetches server-side alert observations from the cloud.
 *
 * Polls GET /api/fleet/observations every 60s and on mount.
 * Returns structured observation records for the Triage tab.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

const CLOUD_URL = ((import.meta.env.VITE_CLOUD_URL as string) ?? '').replace(/\/+$/, '') || 'https://wicklee.dev';

export interface FleetObservation {
  id:             string;
  node_id:        string;
  alert_type:     string;
  severity:       'warning' | 'critical';
  state:          'open' | 'resolved' | 'acknowledged';
  title:          string;
  detail:         string;
  context_json:   string | null;
  fired_at_ms:    number;
  resolved_at_ms: number | null;
  ack_at_ms:      number | null;
}

interface UseFleetObservationsOptions {
  /** JWT token getter for authenticated requests. */
  getToken?: () => Promise<string | null>;
  /** Filter by state: 'open' | 'resolved' | 'acknowledged' | 'all'. Default: 'all'. */
  state?: string;
  /** Filter by node_id. */
  nodeId?: string;
  /** Skip fetching (e.g. when not on cloud). */
  skip?: boolean;
  /** Max results. Default: 50. */
  limit?: number;
}

export function useFleetObservations({
  getToken,
  state = 'all',
  nodeId,
  skip = false,
  limit = 50,
}: UseFleetObservationsOptions) {
  const [observations, setObservations] = useState<FleetObservation[]>([]);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);

  const fetchObservations = useCallback(async () => {
    if (skip || !getToken) return;
    const token = await getToken();
    if (!token || !mountedRef.current) return;

    setLoading(true);
    try {
      const params = new URLSearchParams({ state, limit: String(limit) });
      if (nodeId) params.set('node_id', nodeId);

      const res = await fetch(`${CLOUD_URL}/api/fleet/observations?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (mountedRef.current) {
        setObservations(data.observations ?? []);
      }
    } catch (e) {
      console.warn('[useFleetObservations] fetch failed:', e);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [getToken, state, nodeId, skip, limit]);

  // Poll every 60s.
  useEffect(() => {
    mountedRef.current = true;
    fetchObservations();
    const id = setInterval(fetchObservations, 60_000);
    return () => { mountedRef.current = false; clearInterval(id); };
  }, [fetchObservations]);

  /** Acknowledge an observation (sets state='acknowledged'). */
  const acknowledge = useCallback(async (obsId: string) => {
    if (!getToken) return false;
    const token = await getToken();
    if (!token) return false;

    try {
      const res = await fetch(`${CLOUD_URL}/api/fleet/observations/${obsId}/acknowledge`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        // Optimistic update.
        setObservations(prev =>
          prev.map(o => o.id === obsId ? { ...o, state: 'acknowledged' as const, ack_at_ms: Date.now() } : o)
        );
        return true;
      }
    } catch (e) {
      console.warn('[useFleetObservations] acknowledge failed:', e);
    }
    return false;
  }, [getToken]);

  return { observations, loading, refresh: fetchObservations, acknowledge };
}
