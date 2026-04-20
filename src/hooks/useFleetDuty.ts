/**
 * useFleetDuty — fetches inference duty-cycle data from the cloud.
 *
 * Returns per-node duty percentages computed from DuckDB metrics history
 * (metrics_raw for 1h, metrics_5min for longer ranges). This is historical,
 * not session-relative, so it fires even on a fresh page load for nodes that
 * have been idle all day.
 *
 * Refreshes every 5 minutes.  Returns null until the first fetch completes.
 */

import { useState, useEffect, useRef } from 'react';

export interface NodeDuty {
  node_id:  string;
  hostname: string;
  duty_pct: number | null;
}

export interface FleetDutyData {
  range:         string;
  duty_pct:      number | null;
  total_samples: number;
  live_samples:  number;
  nodes:         NodeDuty[];
}

const REFRESH_MS = 5 * 60 * 1_000; // 5 minutes
const CLOUD_BASE = 'https://wicklee.dev';

export function useFleetDuty(
  getToken: (() => Promise<string | null>) | null,
  range = '24h',
): FleetDutyData | null {
  const [data, setData]   = useState<FleetDutyData | null>(null);
  const cancelRef         = useRef(false);

  useEffect(() => {
    if (!getToken) return;
    cancelRef.current = false;

    async function load() {
      try {
        const token = await getToken();
        if (!token || cancelRef.current) return;
        const res = await fetch(`${CLOUD_BASE}/api/fleet/duty?range=${range}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!cancelRef.current && res.ok) {
          setData(await res.json());
        }
      } catch { /* network error — keep stale data */ }
    }

    load();
    const iv = setInterval(load, REFRESH_MS);
    return () => {
      cancelRef.current = true;
      clearInterval(iv);
    };
  }, [getToken, range]);

  return data;
}
