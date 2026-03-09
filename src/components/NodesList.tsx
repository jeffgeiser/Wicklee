import React, { useState, useEffect, useRef } from 'react';
import { ExternalLink } from 'lucide-react';
import { NodeAgent, SentinelMetrics } from '../types';
import { HardwareDetailPanel, thermalColour, derivedNvidiaThermal } from './NodeHardwarePanel';

const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

const CLOUD_URL = (() => {
  const v = (import.meta.env.VITE_CLOUD_URL ?? '') as string;
  return !v ? 'https://vibrant-fulfillment-production-62c0.up.railway.app'
    : v.startsWith('http') ? v : `https://${v}`;
})();

const fmtAgo = (ms: number): string => {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

interface NodesListProps {
  nodes: NodeAgent[];
}

const NodesList: React.FC<NodesListProps> = ({ nodes }) => {
  const [localMetrics, setLocalMetrics] = useState<SentinelMetrics | null>(null);
  const [allMetrics, setAllMetrics]     = useState<Record<string, SentinelMetrics>>({});
  const [lastSeenMs, setLastSeenMs]     = useState<Record<string, number>>({});
  const [connected, setConnected]       = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      if (isLocalHost) {
        const es = new EventSource('/api/metrics');
        esRef.current = es;
        es.onmessage = (ev) => {
          try { setLocalMetrics(JSON.parse(ev.data) as SentinelMetrics); setConnected(true); }
          catch { /* malformed */ }
        };
        es.onerror = () => {
          setConnected(false);
          es.close();
          esRef.current = null;
          retryTimer = setTimeout(connect, 3000);
        };
      } else {
        const es = new EventSource(`${CLOUD_URL}/api/fleet/stream`);
        esRef.current = es;
        es.onopen = () => setConnected(true);
        es.onmessage = (ev) => {
          try {
            const fleet = JSON.parse(ev.data) as { nodes: Array<{ node_id: string; last_seen_ms: number; metrics: SentinelMetrics | null }> };
            const updatedMetrics: Record<string, SentinelMetrics> = {};
            const updatedLastSeen: Record<string, number> = {};
            for (const n of fleet.nodes) {
              updatedLastSeen[n.node_id] = n.last_seen_ms;
              if (n.metrics) updatedMetrics[n.node_id] = n.metrics;
            }
            setLastSeenMs(prev => ({ ...prev, ...updatedLastSeen }));
            if (Object.keys(updatedMetrics).length > 0) {
              setAllMetrics(prev => ({ ...prev, ...updatedMetrics }));
            }
          } catch { /* malformed */ }
        };
        es.onerror = () => {
          setConnected(false);
          es.close();
          esRef.current = null;
          retryTimer = setTimeout(connect, 3000);
        };
      }
    };

    connect();
    return () => { esRef.current?.close(); clearTimeout(retryTimer); };
  }, []);

  // ── Localhost view ─────────────────────────────────────────────────────────
  if (isLocalHost) {
    const m = localMetrics;
    return (
      <div className="space-y-6">
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 shadow-sm dark:shadow-none">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <span className={`w-2.5 h-2.5 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-400'}`} />
              <div>
                <p className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold">Local Agent</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="font-mono text-sm font-bold text-gray-900 dark:text-white">
                    {m?.node_id ?? '—'}
                  </span>
                  {m?.hostname && m.hostname !== m.node_id && (
                    <span className="text-xs text-gray-500">{m.hostname}</span>
                  )}
                </div>
                {m?.gpu_name && (
                  <p className="text-[10px] text-indigo-400/80 mt-0.5">{m.gpu_name}</p>
                )}
              </div>
            </div>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${
              connected
                ? 'bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20'
                : 'bg-gray-500/10 text-gray-500 border-gray-500/20'
            }`}>
              {connected ? 'Online' : 'Connecting…'}
            </span>
          </div>

          {m ? (
            <HardwareDetailPanel metrics={m} />
          ) : (
            <div className="py-12 text-center">
              <p className="text-sm text-gray-500">Waiting for local agent telemetry…</p>
              <p className="text-xs text-gray-400 mt-1 font-mono">make sure <span className="text-indigo-400">wicklee</span> is running</p>
            </div>
          )}
        </div>

        <div className="bg-indigo-500/5 border border-indigo-500/20 rounded-2xl p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-gray-800 dark:text-gray-200">Running multiple machines?</p>
            <p className="text-xs text-gray-500 mt-0.5">Add and manage all your nodes from the Fleet dashboard at wicklee.dev.</p>
          </div>
          <a
            href="https://wicklee.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold rounded-xl transition-all shadow-lg shadow-indigo-500/20"
          >
            Add more nodes
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>
    );
  }

  // ── Hosted view — empty state ───────────────────────────────────────────────
  if (nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-32 text-center space-y-4">
        <p className="text-gray-400 font-semibold">No nodes paired yet</p>
        <p className="text-sm text-gray-500">Pair your first node from Fleet Overview.</p>
      </div>
    );
  }

  // ── Hosted view — stacked node cards ───────────────────────────────────────
  return (
    <div className="space-y-4">
      {nodes.map(n => {
        const m   = allMetrics[n.id] ?? null;
        const ls  = lastSeenMs[n.id];
        const isLive = m !== null && (ls == null || Date.now() - ls < 30_000);

        const nvThermal     = m && m.thermal_state == null ? derivedNvidiaThermal(m.nvidia_gpu_temp_c ?? null) : null;
        const thermalDisplay = m?.thermal_state ?? nvThermal?.label ?? null;
        const thermalCls     = m?.thermal_state != null ? thermalColour(m.thermal_state) : (nvThermal?.colour ?? 'text-gray-400');
        const thermalTitle   = nvThermal ? 'GPU Thermal' : 'Thermal';

        return (
          <div key={n.id} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 shadow-sm dark:shadow-none">
            {/* Node identity header */}
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <span className={`w-2.5 h-2.5 rounded-full mt-1 shrink-0 ${isLive ? 'bg-green-500' : 'bg-gray-400'}`} />
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-sm font-bold text-gray-900 dark:text-white">{n.id}</span>
                    {n.hostname && n.hostname !== n.id && (
                      <span className="text-xs text-gray-500">{n.hostname}</span>
                    )}
                  </div>
                  {m?.gpu_name && (
                    <p className="text-[10px] text-indigo-400/80 mt-0.5">{m.gpu_name}</p>
                  )}
                  {thermalDisplay && (
                    <p className={`text-[11px] font-semibold mt-0.5 ${thermalCls}`}>
                      {thermalTitle}: {thermalDisplay}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${
                  isLive
                    ? 'bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20'
                    : 'bg-gray-500/10 text-gray-500 border-gray-500/20'
                }`}>
                  {isLive ? 'Online' : 'Offline'}
                </span>
                {!isLive && ls != null && (
                  <p className="text-[10px] text-gray-500 font-mono">last seen {fmtAgo(ls)}</p>
                )}
              </div>
            </div>

            {/* Hardware detail */}
            {m ? (
              <HardwareDetailPanel metrics={m} />
            ) : (
              <div className="py-8 text-center border-t border-gray-100 dark:border-gray-800">
                <p className="text-sm text-gray-500">
                  {ls != null ? `No telemetry — last seen ${fmtAgo(ls)}` : 'Awaiting telemetry…'}
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-600 mt-1">Make sure the agent is running on this machine</p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default NodesList;
