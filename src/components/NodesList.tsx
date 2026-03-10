import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ExternalLink, ChevronDown, Search, X, ArrowUpDown } from 'lucide-react';
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

type SortKey     = 'registered' | 'nodeId' | 'hostname' | 'cpu' | 'tps' | 'lastActive';

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'registered', label: 'Registration order' },
  { value: 'nodeId',     label: 'Node ID' },
  { value: 'hostname',   label: 'Hostname' },
  { value: 'cpu',        label: 'CPU usage ↓' },
  { value: 'tps',        label: 'Tok/s ↓' },
  { value: 'lastActive', label: 'Last active' },
];
type StatusFilter = 'all' | 'online' | 'offline';

interface NodesListProps {
  nodes: NodeAgent[];
  nodePueSettings?: Record<string, number>;
  onUpdateNodePue?: (nodeId: string, pue: number) => void;
  onCopyPueToAll?: (pue: number) => void;
}

// ── Collapsible node row ───────────────────────────────────────────────────────
interface CollapsibleNodeProps {
  node: NodeAgent;
  metrics: SentinelMetrics | null;
  lastSeenMs?: number;
  defaultOpen?: boolean;
  pue?: number;
  onUpdatePue?: (pue: number) => void;
  onCopyPueToAll?: (pue: number) => void;
  hasMultipleNodes?: boolean;
}

const CollapsibleNode: React.FC<CollapsibleNodeProps> = ({ node, metrics: m, lastSeenMs: ls, defaultOpen = false, pue = 1.0, onUpdatePue, onCopyPueToAll, hasMultipleNodes = false }) => {
  const [open, setOpen] = useState(defaultOpen);

  const isLive     = m !== null && (ls == null || Date.now() - ls < 30_000);
  const chipName   = m?.gpu_name ?? m?.chip_name ?? null;
  const hostname   = node.hostname && node.hostname !== node.id ? node.hostname : null;

  const nvThermal  = m && m.thermal_state == null ? derivedNvidiaThermal(m.nvidia_gpu_temp_c ?? null) : null;
  const thermalStr = m?.thermal_state ?? nvThermal?.label ?? null;
  const thermalCls = m?.thermal_state != null ? thermalColour(m.thermal_state) : (nvThermal?.colour ?? 'text-gray-400');

  const tps        = m?.ollama_tokens_per_second;

  return (
    <div className="border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden bg-white dark:bg-gray-900">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 min-h-[44px] hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors text-left"
      >
        <span className={`shrink-0 w-2 h-2 rounded-full ${isLive ? 'bg-green-500' : 'bg-gray-400'}`} />

        {/* Left: identity — single baseline */}
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="text-xs font-bold text-gray-900 dark:text-white shrink-0">{node.id}</span>
          {hostname && (
            <span className="text-xs text-gray-500 shrink-0">· {hostname}</span>
          )}
          {chipName && (
            <span className="text-[10px] text-indigo-400/80 truncate">· {chipName}</span>
          )}
        </div>

        {/* Center: thermal (online) or last-seen (offline) — fixed width, always present */}
        <div className="w-20 text-right shrink-0">
          {isLive
            ? <span className={`text-[11px] font-semibold ${thermalCls}`}>{thermalStr ?? '—'}</span>
            : ls
              ? <span className="text-[10px] text-gray-500">{fmtAgo(ls)}</span>
              : <span className="text-[10px] text-gray-500">—</span>
          }
        </div>

        {/* Right: tok/s or no inference (online) or offline — fixed width */}
        <div className="w-24 text-right shrink-0">
          {isLive
            ? tps != null
              ? <span className="text-green-400 font-bold text-sm tabular-nums">{tps.toFixed(1)} tok/s</span>
              : <span className="text-[10px] text-gray-500">no inference</span>
            : <span className="text-[10px] text-gray-500">offline</span>
          }
        </div>

        <ChevronDown className={`w-4 h-4 text-gray-400 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="px-4 pb-4 pt-3 border-t border-gray-200 dark:border-gray-800">
          {m ? (
            <HardwareDetailPanel metrics={m} pue={pue} onUpdatePue={onUpdatePue} onCopyPueToAll={onCopyPueToAll} hasMultipleNodes={hasMultipleNodes} />
          ) : (
            <p className="text-sm text-gray-500 text-center py-6">
              {ls ? `No telemetry — last seen ${fmtAgo(ls)}` : 'No telemetry received yet — make sure the agent is running.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

// ── Main component ─────────────────────────────────────────────────────────────
const NodesList: React.FC<NodesListProps> = ({ nodes, nodePueSettings, onUpdateNodePue, onCopyPueToAll }) => {
  const [localMetrics, setLocalMetrics] = useState<SentinelMetrics | null>(null);
  const [allMetrics, setAllMetrics]     = useState<Record<string, SentinelMetrics>>({});
  const [lastSeenMs, setLastSeenMs]     = useState<Record<string, number>>({});
  const [connected, setConnected]       = useState(false);
  const [localExpanded, setLocalExpanded] = useState(true);

  const [search, setSearch]             = useState('');
  const [sortKey, setSortKey]           = useState<SortKey>('registered');
  const [sortOpen, setSortOpen]         = useState(false);
  const sortRef                         = useRef<HTMLDivElement>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const esRef     = useRef<EventSource | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) setSortOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ── Localhost view ─────────────────────────────────────────────────────────
  if (isLocalHost) {
    const m        = localMetrics;
    const chipName = m?.gpu_name ?? m?.chip_name;

    const nvThermal  = m && m.thermal_state == null ? derivedNvidiaThermal(m.nvidia_gpu_temp_c ?? null) : null;
    const thermalStr = m?.thermal_state ?? nvThermal?.label ?? null;
    const thermalCls = m?.thermal_state != null ? thermalColour(m.thermal_state) : (nvThermal?.colour ?? 'text-gray-400');
    const tps        = m?.ollama_tokens_per_second;

    return (
      <div className="space-y-6">
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl shadow-sm dark:shadow-none overflow-hidden">
          <button
            onClick={() => setLocalExpanded(o => !o)}
            className="w-full flex items-center gap-3 px-5 py-4 min-h-[44px] hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors text-left"
          >
            <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${connected ? 'bg-green-500' : 'bg-gray-400'}`} />
            {/* Left: identity — single baseline */}
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <span className="text-xs font-bold text-gray-900 dark:text-white shrink-0">{m?.node_id ?? '—'}</span>
              {m?.hostname && m.hostname !== m.node_id && (
                <span className="text-xs text-gray-500 shrink-0">· {m.hostname}</span>
              )}
              {chipName && (
                <span className="text-[10px] text-indigo-400/80 truncate">· {chipName}</span>
              )}
            </div>
            {/* Center: thermal (connected) or — — fixed width, always present */}
            <div className="w-20 text-right shrink-0">
              {connected && m
                ? <span className={`text-[11px] font-semibold ${thermalCls}`}>{thermalStr ?? '—'}</span>
                : <span className="text-[10px] text-gray-500">—</span>
              }
            </div>
            {/* Right: tok/s or no inference (connected) or connecting… — fixed width */}
            <div className="w-24 text-right shrink-0">
              {connected && m
                ? tps != null
                  ? <span className="text-green-400 font-bold text-sm tabular-nums">{tps.toFixed(1)} tok/s</span>
                  : <span className="text-[10px] text-gray-500">no inference</span>
                : <span className="text-[10px] text-gray-500">connecting…</span>
              }
            </div>
            <ChevronDown className={`w-4 h-4 text-gray-400 shrink-0 transition-transform duration-200 ${localExpanded ? 'rotate-180' : ''}`} />
          </button>

          {localExpanded && (
            <div className="px-5 pb-5 border-t border-gray-100 dark:border-gray-800">
              {m ? (
                <div className="pt-4">
                  <HardwareDetailPanel
                    metrics={m}
                    pue={nodePueSettings?.[m.node_id] ?? 1.0}
                    onUpdatePue={(p) => onUpdateNodePue?.(m.node_id, p)}
                    hasMultipleNodes={false}
                  />
                </div>
              ) : (
                <div className="py-12 text-center">
                  <p className="text-sm text-gray-500">Waiting for local agent telemetry…</p>
                  <p className="text-xs text-gray-400 mt-1 font-mono">make sure <span className="text-indigo-400">wicklee</span> is running</p>
                </div>
              )}
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

  // ── Hosted view — enrich nodes with live metrics ────────────────────────────
  const enriched = nodes.map((n, idx) => {
    const m   = allMetrics[n.id] ?? null;
    const ls  = lastSeenMs[n.id];
    const isLive = m !== null && (ls == null || Date.now() - ls < 30_000);
    return { n, m, ls, isLive, idx };
  });

  const onlineCount  = enriched.filter(e => e.isLive).length;
  const offlineCount = enriched.filter(e => !e.isLive).length;

  // Search + status filter
  const q = search.trim().toLowerCase();
  let filtered = enriched.filter(({ n, m, isLive }) => {
    if (statusFilter === 'online'  && !isLive) return false;
    if (statusFilter === 'offline' &&  isLive) return false;
    if (!q) return true;
    const chip   = (m?.gpu_name ?? m?.chip_name ?? '').toLowerCase();
    const status = isLive ? 'online' : 'offline';
    return (
      n.id.toLowerCase().includes(q) ||
      (n.hostname ?? '').toLowerCase().includes(q) ||
      chip.includes(q) ||
      status.includes(q)
    );
  });

  // Sort — 'registered' preserves the stable props array order (no SSE-driven reshuffling)
  if (sortKey !== 'registered') {
    filtered = [...filtered].sort((a, b) => {
      switch (sortKey) {
        case 'nodeId':     return a.n.id.localeCompare(b.n.id);
        case 'hostname':   return (a.n.hostname ?? '').localeCompare(b.n.hostname ?? '');
        case 'cpu':        return (b.m?.cpu_usage_percent ?? -1) - (a.m?.cpu_usage_percent ?? -1);
        case 'tps':        return (b.m?.ollama_tokens_per_second ?? -1) - (a.m?.ollama_tokens_per_second ?? -1);
        case 'lastActive': return (b.ls ?? 0) - (a.ls ?? 0);
        default:           return 0;
      }
    });
  }

  return (
    <div className="space-y-4">
      {/* ── Search + sort bar ────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search nodes…"
            className="w-full pl-8 pr-8 py-2 text-sm bg-gray-900 border border-gray-700 rounded-xl text-gray-200 placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition-colors"
          />
          {search && (
            <button
              onClick={() => { setSearch(''); searchRef.current?.focus(); }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div className="relative shrink-0" ref={sortRef}>
          <button
            onClick={() => setSortOpen(o => !o)}
            className="flex items-center gap-2 px-4 py-2 text-xs font-medium bg-gray-900 border border-gray-700 rounded-xl text-gray-300 hover:border-indigo-500 hover:text-gray-200 transition-colors focus:outline-none"
          >
            <ArrowUpDown className="w-3.5 h-3.5 text-gray-500" />
            <span>{SORT_OPTIONS.find(o => o.value === sortKey)?.label ?? 'Sort'}</span>
            <ChevronDown className={`w-3.5 h-3.5 text-gray-500 transition-transform duration-150 ${sortOpen ? 'rotate-180' : ''}`} />
          </button>
          {sortOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-44 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-20 py-1 overflow-hidden">
              {SORT_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => { setSortKey(opt.value); setSortOpen(false); }}
                  className={`w-full text-left px-3 py-2 text-xs transition-colors ${
                    sortKey === opt.value
                      ? 'text-indigo-300 bg-indigo-500/10'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Status filter tabs ────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1">
        {(['all', 'online', 'offline'] as StatusFilter[]).map(f => {
          const count  = f === 'all' ? nodes.length : f === 'online' ? onlineCount : offlineCount;
          const active = statusFilter === f;
          return (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[9px] font-semibold uppercase tracking-widest transition-all ${
                active
                  ? 'text-gray-900 dark:text-white bg-gray-100 dark:bg-gray-800'
                  : 'text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              {f !== 'all' && (
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${f === 'online' ? 'bg-green-400' : 'bg-gray-500'}`} />
              )}
              <span className="capitalize">{f}</span>
              <span className={active ? 'text-gray-500 dark:text-gray-400' : 'text-gray-400 dark:text-gray-600'}>({count})</span>
            </button>
          );
        })}
      </div>

      {/* ── Node rows ─────────────────────────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <div className="py-16 text-center">
          <p className="text-sm text-gray-500">No nodes match your search</p>
          <button
            onClick={() => { setSearch(''); setStatusFilter('all'); }}
            className="mt-3 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(({ n, m, ls, idx }) => (
            <CollapsibleNode
              key={n.id}
              node={n}
              metrics={m}
              lastSeenMs={ls}
              defaultOpen={idx === 0}
              pue={nodePueSettings?.[n.id] ?? 1.0}
              onUpdatePue={(p) => onUpdateNodePue?.(n.id, p)}
              onCopyPueToAll={onCopyPueToAll}
              hasMultipleNodes={nodes.length >= 2}
            />
          ))}
        </div>
      )}

      {/* ── Footer ────────────────────────────────────────────────────────────── */}
      <p className="text-[11px] text-gray-600 text-center pt-1">
        Fleet: <span className="text-gray-400 font-semibold">{onlineCount} node{onlineCount !== 1 ? 's' : ''} online</span>
        {' '}· {nodes.length} total
      </p>
    </div>
  );
};

export default NodesList;
