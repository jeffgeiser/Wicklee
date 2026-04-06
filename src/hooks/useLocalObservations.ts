/**
 * useLocalObservations — polls the local agent's /api/observations endpoint.
 *
 * Returns server-side evaluated observations (Patterns A/B/C/F/H/J/K/L/N/P/Q/R)
 * from the Rust agent's DuckDB buffer.  Only active when running on localhost.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { DetectedInsight } from '../lib/patternEngine';

const AGENT_PORT = 7700;
const POLL_INTERVAL_MS = 30_000;

/** Raw shape returned by GET /api/observations. */
interface RawLocalObservation {
  pattern_id:       string;
  severity:         string;
  title:            string;
  hook:             string;
  body:             string;
  recommendation:   string;
  resolution_steps: string[];
  action_id:        string;
  confidence:       string;
  confidence_ratio: number;
  first_fired_ms:   number;
  node_id:          string;
  hostname:         string;
}

/** Map a RawLocalObservation to the DetectedInsight shape used by AccordionObservationCard. */
function toDetectedInsight(raw: RawLocalObservation): DetectedInsight {
  return {
    patternId:         raw.pattern_id,
    nodeId:            raw.node_id,
    hostname:          raw.hostname,
    title:             raw.title,
    hook:              raw.hook,
    body:              raw.body,
    recommendation:    raw.recommendation,
    resolution_steps:  raw.resolution_steps,
    action_id:         raw.action_id as DetectedInsight['action_id'],
    requiredMs:        300_000, // 5 min observation window
    observedMs:        raw.confidence_ratio * 300_000,
    confidence:        raw.confidence as DetectedInsight['confidence'],
    confidenceRatio:   raw.confidence_ratio,
    tier:              'community',
    actions:           raw.resolution_steps.slice(0, 2).map(step => ({
      label: step.length > 40 ? step.slice(0, 37) + '...' : step,
      copyText: step.replace(/^Run: /, ''),
    })),
    firstFiredMs:      raw.first_fired_ms,
    best_node_id:      null,
    best_node_hostname: null,
  };
}

interface UseLocalObservationsResult {
  observations: DetectedInsight[];
  loading: boolean;
}

export function useLocalObservations(skip = false): UseLocalObservationsResult {
  const [observations, setObservations] = useState<DetectedInsight[]>([]);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);

  const fetchObs = useCallback(async () => {
    if (skip) return;
    setLoading(true);
    try {
      const res = await fetch(`http://localhost:${AGENT_PORT}/api/observations`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (mountedRef.current) {
        const raw: RawLocalObservation[] = data.observations ?? [];
        setObservations(raw.map(toDetectedInsight));
      }
    } catch {
      // Agent may not support this endpoint yet — fail silently
      if (mountedRef.current) setObservations([]);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [skip]);

  useEffect(() => {
    mountedRef.current = true;
    fetchObs();
    const id = setInterval(fetchObs, POLL_INTERVAL_MS);
    return () => { mountedRef.current = false; clearInterval(id); };
  }, [fetchObs]);

  return { observations, loading };
}
