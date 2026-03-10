import React, { useState, useEffect, useRef } from 'react';
import {
  ExternalLink, ChevronDown, Search, X, ArrowUpDown,
  Lock, Cloud, Shield, AlertTriangle, Database, HardDrive,
  Zap, Clock, Square, CheckSquare, Activity,
} from 'lucide-react';
import { NodeAgent, SentinelMetrics } from '../types';
import { HardwareDetailPanel, thermalColour, derivedNvidiaThermal } from './NodeHardwarePanel';
import { computeWES, formatWES, wesColorClass } from '../utils/wes';
import { WES_TOOLTIP, calculateTotalVramMb, calculateTotalVramCapacityMb, ELECTRICITY_RATE_USD_PER_KWH } from '../utils/efficiency';

const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

const CLOUD_URL = (() => {
  const v = (import.meta.env.VITE_CLOUD_URL ?? '') as string;
  return !v ? 'https://vibrant-fulfillment-production-62c0.up.railway.app'
    : v.startsWith('http') ? v : `https://${v}`;
})();

const SOVEREIGNTY_TOOLTIP =
  'Sovereign Mode: Structural proof that inference data remains within your local network.';

// ── Utilities ─────────────────────────────────────────────────────────────────

const fmtAgo = (ms: number): string => {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

const detectOS = (m: SentinelMetrics): 'macOS' | 'Linux' | 'Unknown' => {
  const chip = (m.chip_name ?? m.gpu_name ?? '').toLowerCase();
  if (chip.includes('apple') || /\bm[1-4]\b/.test(chip)) return 'macOS';
  if (m.cpu_power_w != null && m.nvidia_vram_total_mb == null) return 'macOS';
  if (m.nvidia_vram_total_mb != null) return 'Linux';
  return 'Unknown';
};

// ── Per-node settings helper ──────────────────────────────────────────────────
// Returns effective PUE and electricity rate for a given node, plus whether
// either value is a custom override (drives the ◆ amber indicator in ComplianceBand).

interface NodeSettings {
  pue: number;
  rate: number;
  pueOverride: boolean;
}

function getNodeSettings(
  nodeId: string,
  nodePueSettings: Record<string, number> = {},
): NodeSettings {
  const pue = nodePueSettings[nodeId] ?? 1.0;
  const pueOverride = nodeId in nodePueSettings && nodePueSettings[nodeId] !== 1.0;
  return { pue, rate: ELECTRICITY_RATE_USD_PER_KWH, pueOverride };
}

// ── Sort / filter types ───────────────────────────────────────────────────────

type SortKey     = 'registered' | 'nodeId' | 'hostname' | 'cpu' | 'tps' | 'lastActive';
type StatusFilter = 'all' | 'online' | 'offline';

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'registered', label: 'Registration order' },
  { value: 'nodeId',     label: 'Node ID' },
  { value: 'hostname',   label: 'Hostname' },
  { value: 'cpu',        label: 'CPU usage ↓' },
  { value: 'tps',        label: 'Tok/s ↓' },
  { value: 'lastActive', label: 'Last active' },
];

// ── Registry header tile ──────────────────────────────────────────────────────
// Matches InsightTile from Overview for cross-page consistency.

interface RegistryTileProps {
  label: string;
  value: string;
  valueCls?: string;
  sub?: string;
  icon: React.ElementType;
  iconCls?: string;
}
const RegistryTile: React.FC<RegistryTileProps> = ({ label, value, valueCls, sub, icon: Icon, iconCls }) => (
  <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 flex flex-col justify-between h-[116px]">
    <div className="flex items-start justify-between gap-2">
      <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500 leading-tight">{label}</p>
      <Icon size={13} className={iconCls ?? 'text-gray-400 dark:text-gray-600'} />
    </div>
    <div>
      <p className={`text-2xl font-bold font-telin leading-none ${valueCls ?? 'text-gray-900 dark:text-white'}`}>
        {value}
      </p>
      {sub && <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-1.5 leading-tight">{sub}</p>}
    </div>
  </div>
);

// ── Sovereignty badge ─────────────────────────────────────────────────────────

const SovereigntyBadge: React.FC<{ sovereign: boolean }> = ({ sovereign }) => (
  sovereign ? (
    <div className="flex items-center gap-1" title={SOVEREIGNTY_TOOLTIP}>
      <Lock size={10} className="text-green-500 shrink-0" />
      <span className="text-[10px] font-semibold font-mono text-green-600 dark:text-green-500">Sovereign</span>
    </div>
  ) : (
    <div className="flex items-center gap-1" title="Paired to wicklee.dev fleet">
      <Cloud size={10} className="text-indigo-400 shrink-0" />
      <span className="text-[10px] font-semibold font-mono text-indigo-400">Paired</span>
    </div>
  )
);

// ── Compliance band ────────────────────────────────────────────────────────────
// Sovereignty & Compliance expanded section — sits above HardwareDetailPanel.

const ComplianceBand: React.FC<{
  m: SentinelMetrics | null;
  nodeId: string;
  sovereign: boolean;
  pue?: number;
  pueOverride?: boolean;
}> = ({ m, nodeId, sovereign, pue = 1.0, pueOverride = false }) => {
  const destination = sovereign ? 'Local Only' : CLOUD_URL.replace(/^https?:\/\//, '');
  const memPressure = m?.memory_pressure_percent ?? null;
  const forecastLabel = memPressure == null  ? '—'
    : memPressure > 85 ? 'Critical'
    : memPressure > 70 ? 'Elevated'
    : memPressure > 50 ? 'Moderate'
    : 'Nominal';
  const forecastCls = memPressure == null    ? 'text-gray-500'
    : memPressure > 85 ? 'text-red-500'
    : memPressure > 70 ? 'text-amber-500'
    : 'text-green-500';
  const modelSizeStr = m?.ollama_model_size_gb != null
    ? `${m.ollama_model_size_gb.toFixed(1)} GB` : '—';

  const overrideCls = 'text-amber-400 dark:text-amber-500';

  const ML = ({ children }: { children: React.ReactNode }) => (
    <p className="text-[8px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-600 leading-none mb-1">{children}</p>
  );

  return (
    <div className="border border-gray-200 dark:border-gray-800 rounded-xl px-4 py-3 mb-3 grid grid-cols-6 gap-4 bg-gray-50/30 dark:bg-gray-800/20">
      {/* Destination */}
      <div>
        <ML>Destination</ML>
        <p className="text-xs font-telin text-gray-700 dark:text-gray-300 truncate" title={destination}>{destination}</p>
        <p className="text-[9px] text-gray-500 mt-0.5">{sovereign ? 'local agent' : 'fleet relay'}</p>
      </div>

      {/* Pairing Log */}
      <div>
        <ML>Pairing Log</ML>
        <p className="text-xs font-telin text-gray-500">Node: {nodeId}</p>
        <p className="text-[9px] text-gray-600 mt-0.5">history N/A</p>
      </div>

      {/* Disk Usage */}
      <div>
        <ML>Disk Usage</ML>
        <p className="text-xs font-telin text-gray-700 dark:text-gray-300">{modelSizeStr}</p>
        <p className="text-[9px] text-gray-500 mt-0.5">active model</p>
      </div>

      {/* Memory Pressure Forecast */}
      <div>
        <ML>Mem Forecast</ML>
        <p className={`text-xs font-semibold ${forecastCls}`}>{forecastLabel}</p>
        {memPressure != null ? (
          <p className="text-[9px] font-telin text-gray-500 mt-0.5">{memPressure.toFixed(0)}% pressure</p>
        ) : (
          <p className="text-[9px] text-gray-600 mt-0.5">no data</p>
        )}
      </div>

      {/* Facility PUE */}
      <div>
        <ML>Facility PUE</ML>
        <p className={`text-xs font-telin ${pueOverride ? overrideCls : 'text-gray-700 dark:text-gray-300'}`}>
          {pue.toFixed(2)}{pueOverride && ' ◆'}
        </p>
        <p className="text-[9px] text-gray-500 mt-0.5">{pueOverride ? 'custom override' : 'default'}</p>
      </div>

      {/* Electricity Rate */}
      <div>
        <ML>Elec. Rate</ML>
        <p className="text-xs font-telin text-gray-700 dark:text-gray-300">
          ${ELECTRICITY_RATE_USD_PER_KWH}/kWh
        </p>
        <p className="text-[9px] text-gray-500 mt-0.5">fleet default</p>
      </div>
    </div>
  );
};

// ── Shared CSS grid template for registry rows + compliance band ───────────────
// checkbox | status+ID | hostname | chip(flex) | compliance | uptime | WES | chevron
const REGISTRY_ROW_COLS = '1.25rem 7.5rem 6.5rem minmax(0,1fr) 72px 72px 68px 16px';

// ── Collapsible registry row ──────────────────────────────────────────────────

interface CollapsibleNodeProps {
  node: NodeAgent;
  metrics: SentinelMetrics | null;
  lastSeenMs?: number;
  defaultOpen?: boolean;
  pue?: number;
  onUpdatePue?: (pue: number) => void;
  onCopyPueToAll?: (pue: number) => void;
  hasMultipleNodes?: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
  sovereign?: boolean;
}

const CollapsibleNode: React.FC<CollapsibleNodeProps> = ({
  node, metrics: m, lastSeenMs: ls, defaultOpen = false,
  pue = 1.0, onUpdatePue, onCopyPueToAll, hasMultipleNodes = false,
  isSelected = false, onToggleSelect, sovereign = false,
}) => {
  const [open, setOpen] = useState(defaultOpen);

  const isLive   = m !== null && (ls == null || Date.now() - ls < 30_000);
  const chipName = m?.gpu_name ?? m?.chip_name ?? node.ip ?? null;
  const hostname = node.hostname && node.hostname !== node.id ? node.hostname : null;

  // WES (live — 7-day avg available when history API is added)
  const totalPowerW = m ? (m.cpu_power_w ?? 0) + (m.nvidia_power_draw_w ?? 0) : 0;
  const hasPower    = m ? (m.cpu_power_w != null || m.nvidia_power_draw_w != null) : false;
  const wes         = computeWES(
    m?.ollama_tokens_per_second ?? null,
    hasPower ? totalPowerW : null,
    m?.thermal_state ?? null,
    pue,
  );

  const ROW_VAL = 'text-xs font-telin';

  return (
    <div className="border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden bg-white dark:bg-gray-900">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full grid items-center gap-x-3 px-4 py-3 min-h-[44px] hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors text-left"
        style={{ gridTemplateColumns: REGISTRY_ROW_COLS }}
      >
        {/* Col 1 — Multi-select checkbox */}
        <div
          onClick={e => { e.stopPropagation(); onToggleSelect?.(); }}
          className="flex items-center justify-center"
        >
          {isSelected
            ? <CheckSquare className="w-3.5 h-3.5 text-indigo-400" />
            : <Square className="w-3.5 h-3.5 text-gray-500 hover:text-gray-300 transition-colors" />
          }
        </div>

        {/* Col 2 — Status dot + Node ID */}
        <div className="flex items-center gap-2 min-w-0">
          <span className={`shrink-0 w-2 h-2 rounded-full ${isLive ? 'bg-green-500' : 'bg-gray-400'}`} />
          <span className={`${ROW_VAL} font-bold text-gray-900 dark:text-white truncate`}>{node.id}</span>
        </div>

        {/* Col 3 — Hostname (fixed-width so chip column always starts at the same x-position) */}
        <div className="min-w-0">
          {hostname ? (
            <span className={`${ROW_VAL} text-gray-500 block truncate`}>{hostname}</span>
          ) : <span />}
        </div>

        {/* Col 4 — Chip / processor type (flex, same font size as other values) */}
        <div className="min-w-0">
          {chipName && (
            <span className={`${ROW_VAL} text-indigo-400/80 block truncate`}>{chipName}</span>
          )}
        </div>

        {/* Col 5 — Compliance: Sovereignty badge */}
        <div className="text-left">
          <SovereigntyBadge sovereign={sovereign} />
        </div>

        {/* Col 6 — Stability: Uptime */}
        <div className="text-right">
          {isLive ? (
            <span className={`${ROW_VAL} text-gray-500`} title="Time since agent startup">
              {node.uptime ?? '—'}
            </span>
          ) : ls ? (
            <span className={`${ROW_VAL} text-gray-500`}>{fmtAgo(ls)}</span>
          ) : (
            <span className={`${ROW_VAL} text-gray-600`}>—</span>
          )}
        </div>

        {/* Col 7 — Efficiency: live WES (7-day avg when history available) */}
        <div className="text-right">
          {isLive && wes != null ? (
            <span
              className={`${ROW_VAL} font-semibold ${wesColorClass(wes)}`}
              title={WES_TOOLTIP}
            >
              WES {formatWES(wes)}
            </span>
          ) : (
            <span className={`${ROW_VAL} text-gray-600`}>—</span>
          )}
        </div>

        {/* Chevron */}
        <ChevronDown className={`w-4 h-4 text-gray-400 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="px-4 pb-4 pt-3 border-t border-gray-200 dark:border-gray-800">
          {m ? (
            <>
              <ComplianceBand m={m} nodeId={node.id} sovereign={sovereign} pue={pue} pueOverride={pue !== 1.0} />
              <HardwareDetailPanel
                metrics={m}
                pue={pue}
                onUpdatePue={onUpdatePue}
                onCopyPueToAll={onCopyPueToAll}
                hasMultipleNodes={hasMultipleNodes}
              />
            </>
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

// ── NodesListProps ─────────────────────────────────────────────────────────────

interface NodesListProps {
  nodes: NodeAgent[];
  nodePueSettings?: Record<string, number>;
  onUpdateNodePue?: (nodeId: string, pue: number) => void;
  onCopyPueToAll?: (pue: number) => void;
}

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

  // Multi-select state (Task 5)
  const [selectedNodes, setSelectedNodes] = useState<Set<string>>(new Set());

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
            const updM: Record<string, SentinelMetrics> = {};
            const updLS: Record<string, number> = {};
            for (const n of fleet.nodes) {
              updLS[n.node_id] = n.last_seen_ms;
              if (n.metrics) updM[n.node_id] = n.metrics;
            }
            setLastSeenMs(prev => ({ ...prev, ...updLS }));
            if (Object.keys(updM).length > 0) setAllMetrics(prev => ({ ...prev, ...updM }));
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

  // ── Bulk actions ────────────────────────────────────────────────────────────

  const handleBulkExport = () => {
    const rows = [...selectedNodes].map(id => ({
      node_id:  id,
      hostname: nodes.find(n => n.id === id)?.hostname ?? null,
      metrics:  allMetrics[id] ?? null,
      exported_at: new Date().toISOString(),
    }));
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `wicklee-audit-${Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  const toggleSelect = (id: string) =>
    setSelectedNodes(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleSelectAll = (ids: string[]) => {
    setSelectedNodes(prev => {
      const allSelected = ids.every(id => prev.has(id));
      if (allSelected) return new Set([...prev].filter(id => !ids.includes(id)));
      const next = new Set(prev);
      ids.forEach(id => next.add(id));
      return next;
    });
  };

  // ── Localhost view ──────────────────────────────────────────────────────────
  if (isLocalHost) {
    const m        = localMetrics;
    const chipName = m?.gpu_name ?? m?.chip_name ?? null;

    return (
      <div className="space-y-6">
        {/* Registry header — 1-node view */}
        {m && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <RegistryTile
              label="Total Fleet VRAM"
              value={(() => {
                const cap = (m.nvidia_vram_total_mb ?? m.total_memory_mb ?? 0);
                const used = (m.nvidia_vram_used_mb ?? m.used_memory_mb ?? 0);
                return cap > 0 ? `${Math.round(used / cap * 100)}%` : '—';
              })()}
              sub={(() => {
                const cap = (m.nvidia_vram_total_mb ?? m.total_memory_mb ?? 0);
                const used = (m.nvidia_vram_used_mb ?? m.used_memory_mb ?? 0);
                return cap > 0 ? `${(used/1024).toFixed(1)} / ${(cap/1024).toFixed(0)} GB` : undefined;
              })()}
              icon={Database} iconCls="text-blue-400"
            />
            <RegistryTile
              label="Sovereignty Score"
              value="100%"
              valueCls="text-green-600 dark:text-green-400"
              sub="1 node · local only"
              icon={Shield} iconCls="text-green-400"
            />
            <RegistryTile
              label="OS Distribution"
              value={detectOS(m)}
              sub="1 node"
              icon={Activity} iconCls="text-gray-400"
            />
            <RegistryTile
              label="Lifecycle Alerts"
              value={(() => {
                const thermal = m.thermal_state?.toLowerCase();
                return (thermal === 'serious' || thermal === 'critical') ? '1' : '0';
              })()}
              valueCls={(() => {
                const t = m.thermal_state?.toLowerCase();
                return (t === 'serious' || t === 'critical') ? 'text-red-500' : undefined;
              })()}
              sub={(() => {
                const t = m.thermal_state?.toLowerCase();
                return (t === 'serious' || t === 'critical') ? 'thermal alert' : 'all clear';
              })()}
              icon={AlertTriangle} iconCls="text-amber-400"
            />
          </div>
        )}

        {/* Single-node card */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl shadow-sm dark:shadow-none overflow-hidden">
          <button
            onClick={() => setLocalExpanded(o => !o)}
            className="w-full grid items-center gap-x-3 px-5 py-4 min-h-[44px] hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors text-left"
            style={{ gridTemplateColumns: '7.5rem 6.5rem minmax(0,1fr) 72px 72px 68px 16px' }}
          >
            {/* Status + ID */}
            <div className="flex items-center gap-2 min-w-0">
              <span className={`shrink-0 w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-400'}`} />
              <span className="text-xs font-bold font-mono text-gray-900 dark:text-white truncate">
                {m?.node_id ?? '—'}
              </span>
            </div>
            {/* Hostname */}
            <div className="min-w-0">
              {m?.hostname && m.hostname !== m.node_id ? (
                <span className="text-xs font-mono text-gray-500 block truncate">{m.hostname}</span>
              ) : <span />}
            </div>
            {/* Chip */}
            <div className="min-w-0">
              {chipName && (
                <span className="text-xs font-mono text-indigo-400/80 block truncate">{chipName}</span>
              )}
            </div>
            {/* Sovereignty */}
            <div><SovereigntyBadge sovereign={true} /></div>
            {/* Uptime */}
            <div className="text-right">
              <span className="text-xs font-mono tabular-nums text-gray-500">{connected ? 'live' : '—'}</span>
            </div>
            {/* WES */}
            <div className="text-right">
              {(() => {
                if (!m) return <span className="text-xs font-telin text-gray-600">—</span>;
                const watts = (m.cpu_power_w ?? 0) + (m.nvidia_power_draw_w ?? 0);
                const hasPwr = m.cpu_power_w != null || m.nvidia_power_draw_w != null;
                const wes = computeWES(m.ollama_tokens_per_second ?? null, hasPwr ? watts : null, m.thermal_state, nodePueSettings?.[m.node_id] ?? 1.0);
                return wes != null ? (
                  <span className={`text-xs font-telin font-semibold ${wesColorClass(wes)}`} title={WES_TOOLTIP}>
                    WES {formatWES(wes)}
                  </span>
                ) : <span className="text-xs font-telin text-gray-600">—</span>;
              })()}
            </div>
            <ChevronDown className={`w-4 h-4 text-gray-400 shrink-0 transition-transform duration-200 ${localExpanded ? 'rotate-180' : ''}`} />
          </button>

          {localExpanded && (
            <div className="px-5 pb-5 border-t border-gray-100 dark:border-gray-800">
              {m ? (
                <div className="pt-4">
                  {(() => { const ns = getNodeSettings(m.node_id, nodePueSettings); return (
                  <ComplianceBand m={m} nodeId={m.node_id} sovereign={true} pue={ns.pue} pueOverride={ns.pueOverride} />
                  ); })()}
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

        {/* CTA */}
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

  // ── Registry header tile computations ────────────────────────────────────────
  const allLiveMetrics = enriched.filter(e => e.isLive).map(e => e.m!);

  const totalVramMb    = calculateTotalVramMb(allLiveMetrics);
  const totalVramCapMb = calculateTotalVramCapacityMb(allLiveMetrics);
  const vramUtilPct    = totalVramCapMb > 0 ? Math.round(totalVramMb / totalVramCapMb * 100) : null;

  // Sovereignty Score: % of fleet nodes running local inference (sovereign inference)
  // In fleet mode, "sovereign" means nodes with ollama_running (data stays on-device)
  const sovereignCount = allLiveMetrics.filter(m => m.ollama_running).length;
  const sovereignPct   = allLiveMetrics.length > 0
    ? Math.round(sovereignCount / allLiveMetrics.length * 100) : null;

  // OS Distribution
  const osCounts = allLiveMetrics.reduce((acc, m) => {
    const os = detectOS(m);
    acc[os] = (acc[os] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const osSubParts = (Object.entries(osCounts) as [string, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([os, count]) => `${os} ${count}`)
    .join(' · ');

  // Lifecycle Alerts: thermal warnings + offline nodes
  const thermalAlerts  = allLiveMetrics.filter(m => ['serious', 'critical'].includes(m.thermal_state?.toLowerCase() ?? '')).length;
  const offlineAlerts  = offlineCount;
  const totalAlerts    = thermalAlerts + offlineAlerts;

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

  const filteredIds = filtered.map(e => e.n.id);

  return (
    <div className="space-y-4">

      {/* ── Task 1: Registry Header — 2×2 / 1×4 tile grid ─────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <RegistryTile
          label="Total Fleet VRAM"
          value={vramUtilPct != null ? `${vramUtilPct}%` : allLiveMetrics.length > 0 ? `${(totalVramMb/1024).toFixed(1)} GB` : '—'}
          sub={vramUtilPct != null ? `${(totalVramMb/1024).toFixed(1)} / ${(totalVramCapMb/1024).toFixed(1)} GB` : undefined}
          icon={Database} iconCls="text-blue-400"
        />
        <RegistryTile
          label="Sovereignty Score"
          value={sovereignPct != null ? `${sovereignPct}%` : '—'}
          valueCls={sovereignPct != null && sovereignPct >= 75 ? 'text-green-600 dark:text-green-400'
            : sovereignPct != null && sovereignPct >= 40 ? 'text-amber-600 dark:text-amber-500'
            : undefined}
          sub={sovereignCount > 0 ? `${sovereignCount} local inference` : allLiveMetrics.length > 0 ? 'all fleet-routed' : 'no live nodes'}
          icon={Shield} iconCls="text-green-400"
        />
        <RegistryTile
          label="OS Distribution"
          value={Object.keys(osCounts).length > 0 ? Object.keys(osCounts)[0] : '—'}
          sub={osSubParts || undefined}
          icon={Activity} iconCls="text-gray-400"
        />
        <RegistryTile
          label="Lifecycle Alerts"
          value={String(totalAlerts)}
          valueCls={totalAlerts > 0 ? 'text-red-500 dark:text-red-400' : 'text-green-600 dark:text-green-400'}
          sub={totalAlerts > 0
            ? [thermalAlerts > 0 ? `${thermalAlerts} thermal` : null, offlineAlerts > 0 ? `${offlineAlerts} offline` : null].filter(Boolean).join(' · ')
            : 'all systems nominal'}
          icon={AlertTriangle} iconCls={totalAlerts > 0 ? 'text-red-400' : 'text-gray-500'}
        />
      </div>

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

      {/* ── Status filter tabs ───────────────────────────────────────────────── */}
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

        {/* Select-all for visible rows */}
        {filtered.length > 0 && (
          <button
            onClick={() => toggleSelectAll(filteredIds)}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[9px] font-semibold uppercase tracking-widest text-gray-400 hover:text-gray-200 transition-colors"
          >
            {filteredIds.every(id => selectedNodes.has(id))
              ? <CheckSquare className="w-3 h-3" />
              : <Square className="w-3 h-3" />
            }
            Select all
          </button>
        )}
      </div>

      {/* ── Column headers ───────────────────────────────────────────────────── */}
      <div
        className="grid gap-x-3 px-4 pb-1"
        style={{ gridTemplateColumns: REGISTRY_ROW_COLS }}
      >
        <div />
        <p className="text-[8px] font-semibold uppercase tracking-widest text-gray-500">Node ID</p>
        <p className="text-[8px] font-semibold uppercase tracking-widest text-gray-500">Hostname</p>
        <p className="text-[8px] font-semibold uppercase tracking-widest text-gray-500">Processor</p>
        <p className="text-[8px] font-semibold uppercase tracking-widest text-gray-500">Compliance</p>
        <p className="text-[8px] font-semibold uppercase tracking-widest text-gray-500 text-right">Uptime</p>
        <p className="text-[8px] font-semibold uppercase tracking-widest text-gray-500 text-right">WES (live)</p>
        <div />
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
          {filtered.map(({ n, m, ls, isLive, idx }) => {
            const ns = getNodeSettings(n.id, nodePueSettings);
            return (
            <CollapsibleNode
              key={n.id}
              node={n}
              metrics={m}
              lastSeenMs={ls}
              defaultOpen={idx === 0}
              pue={ns.pue}
              onUpdatePue={(p) => onUpdateNodePue?.(n.id, p)}
              onCopyPueToAll={onCopyPueToAll}
              hasMultipleNodes={nodes.length >= 2}
              isSelected={selectedNodes.has(n.id)}
              onToggleSelect={() => toggleSelect(n.id)}
              sovereign={false}
            />
            );
          })}
        </div>
      )}

      {/* ── Footer ────────────────────────────────────────────────────────────── */}
      <p className="text-[11px] text-gray-600 text-center pt-1">
        Fleet: <span className="text-gray-400 font-semibold">{onlineCount} node{onlineCount !== 1 ? 's' : ''} online</span>
        {' '}· {nodes.length} total
        {selectedNodes.size > 0 && (
          <span className="text-indigo-400"> · {selectedNodes.size} selected</span>
        )}
      </p>

      {/* ── Task 5: Bulk Actions floating bar ───────────────────────────────── */}
      {selectedNodes.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-5 py-3 bg-gray-950 border border-gray-700/80 rounded-2xl shadow-2xl shadow-black/60 backdrop-blur-sm animate-in fade-in slide-in-from-bottom-2 duration-200">
          <span className="text-xs font-semibold text-gray-200 tabular-nums">
            {selectedNodes.size} node{selectedNodes.size !== 1 ? 's' : ''} selected
          </span>
          <div className="w-px h-4 bg-gray-700 shrink-0" />
          <button
            onClick={handleBulkExport}
            className="text-xs font-medium text-gray-300 hover:text-white transition-colors"
          >
            Export Audit Log
          </button>
          <div className="w-px h-4 bg-gray-700 shrink-0" />
          <button
            onClick={() => alert(`Disconnect ${selectedNodes.size} node(s)? This would remove them from the fleet. (API coming soon.)`)}
            className="text-xs font-medium text-red-400 hover:text-red-300 transition-colors"
          >
            Disconnect
          </button>
          <div className="w-px h-4 bg-gray-700 shrink-0" />
          <button
            onClick={() => setSelectedNodes(new Set())}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};

export default NodesList;
