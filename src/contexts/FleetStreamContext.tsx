import React, { createContext, useContext, useState, useMemo } from 'react';
import type { FleetEvent, FleetNode, FleetStreamState, SentinelMetrics } from '../types';

/**
 * Shared dashboard state: the Live Activity event list and the (empty) node
 * maps that older components still read.
 *
 * There is no fleet stream any more. The agent has no cloud connection, so
 * this provider holds no remote telemetry; every dashboard view reads the local
 * agent directly (`useLocalMetricsStream`, `/api/*`). What remains is the event
 * list that views append to through `addFleetEvent`.
 */

const MAX_EVENTS = 50;

const NO_METRICS: Record<string, SentinelMetrics> = {};
const NO_LAST_SEEN: Record<string, number> = {};
const NO_PEAKS: Record<string, number> = {};
const NO_RESTRICTED: ReadonlySet<string> = new Set();

const FleetStreamContext = createContext<FleetStreamState | null>(null);

interface FleetStreamProviderProps {
  children:          React.ReactNode;
  /** Accepted for caller compatibility; nothing emits node snapshots any more. */
  onNodesSnapshot?:  (nodes: FleetNode[]) => void;
}

export const FleetStreamProvider: React.FC<FleetStreamProviderProps> = ({ children }) => {
  const [fleetEvents, setFleetEvents] = useState<FleetEvent[]>([]);

  const addFleetEvent = React.useCallback((event: FleetEvent) => {
    setFleetEvents(prev => [event, ...prev].slice(0, MAX_EVENTS));
  }, []);

  const value = useMemo<FleetStreamState>(() => ({
    allNodeMetrics:    NO_METRICS,
    lastSeenMsMap:     NO_LAST_SEEN,
    peakTpsMap:        NO_PEAKS,
    fleetEvents,
    addFleetEvent,
    connected:         false,
    transport:         null,
    lastTelemetryMs:   null,
    connectionState:   'disconnected',
    restrictedNodeIds: NO_RESTRICTED,
  }), [fleetEvents, addFleetEvent]);

  return (
    <FleetStreamContext.Provider value={value}>
      {children}
    </FleetStreamContext.Provider>
  );
};

export function useFleetStream(): FleetStreamState {
  const ctx = useContext(FleetStreamContext);
  if (!ctx) throw new Error('useFleetStream must be used within FleetStreamProvider');
  return ctx;
}
