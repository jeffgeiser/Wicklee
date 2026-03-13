import { useMemo } from 'react';
import { NodeAgent } from '../types';

/**
 * Single source of truth for fleet node counts.
 *
 * All components that display node totals, online counts, or status
 * breakdowns must call this hook rather than independently filtering
 * the nodes array. One hook, one source, zero divergence.
 *
 * @param nodes  Live NodeAgent array from FleetStreamContext (or local prop).
 */
export function useFleetCounts(nodes: NodeAgent[]) {
  return useMemo(() => ({
    total:       nodes.length,
    online:      nodes.filter(n => n.status === 'online').length,
    unreachable: nodes.filter(n => n.status === 'unreachable').length,
    idle:        nodes.filter(n => n.status === 'idle').length,
  }), [nodes]);
}
