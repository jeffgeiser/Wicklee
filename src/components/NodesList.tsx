import React, { useState, useEffect, useRef } from 'react';
import {
  Search, X, ArrowUpDown, ChevronDown,
  Cloud, Lock, CheckSquare, Square,
  Database, Wifi, Cpu, AlertTriangle,
  ExternalLink, CheckCircle, AlertCircle,
} from 'lucide-react';
import { NodeAgent, SentinelMetrics } from '../types';
import type { NodeEffectiveSettings } from '../hooks/useSettings';

// ── Constants ─────────────────────────────────────────────────────────────────

const isLocalHost =
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

const CLOUD_URL = (() => {
  const v = (import.meta.env.VITE_CLOUD_URL ?? '') as string;
  return !v
    ? 'https://vibrant-fulfillment-production-62c0.up.railway.app'
    : v.startsWith('http') ? v : `https://${v}`;
})();

// ── Responsive grid approach ───────────────────────────────────────────────────
// Columns hide at priority tiers as viewport narrows.
// display:none removes a cell from grid flow, so grid-template-columns must
// match the EXACT number of visible cells at every breakpoint.
//
// Column order in DOM (priority — always visible marked with ★):
//   1. Checkbox          ★  40px
//   2. Status + Node ID  ★  180px (flex at narrow)
//   3. Identity          ★  200px (flex at narrow)
//   4. OS                   hide < 1024px
//   5. Memory               hide < 860px
//   6. Connectivity      ★  120px
//   7. Uptime               hide < 1024px
//   8. Version              hide < 1200px
//   9. Permissions       ★  110px
//
// Grid template changes in lockstep with hidden cells:
//   < 860px  : 5 cols  — checkbox | node | identity | connectivity | perms
//   860–1024 : 6 cols  — + memory
//   1024–1200: 8 cols  — + os + uptime
//   1200px+  : 9 cols  — + version (fixed px everywhere)
//
// Tailwind arbitrary property + arbitrary breakpoint syntax (v3.2+)
const MGMT_GRID_CLS = [
  'grid gap-x-3 items-center',
  '[grid-template-columns:40px_minmax(0,1fr)_minmax(0,1fr)_120px_110px]',
  'min-[860px]:[grid-template-columns:40px_minmax(0,1fr)_minmax(0,1fr)_110px_120px_110px]',
  'lg:[grid-template-columns:40px_minmax(0,1fr)_minmax(0,1fr)_140px_110px_120px_120px_110px]',
  'min-[1200px]:[grid-template-columns:40px_180px_200px_140px_110px_120px_120px_90px_110px]',
].join(' ');

// Per-column visibility — applied to both header cells and data cells
const COL_OS      = 'hidden lg:block';            // show >= 1024px
const COL_MEMORY  = 'hidden min-[860px]:block';   // show >= 860px
const COL_UPTIME  = 'hidden lg:block';            // show >= 1024px
const COL_VERSION = 'hidden min-[1200px]:block';  // show >= 1200px

// ── Utilities ─────────────────────────────────────────────────────────────────

const fmtAgo = (ms: number): string => {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

type NodeOS = 'macOS' | 'Linux' | 'Windows' | 'Unknown';
const deriveOS = (m: SentinelMetrics | null): NodeOS => {
  if (!m) return 'Unknown';
  if (m.cpu_power_w != null) return 'macOS';
  if (m.nvidia_vram_total_mb != null) return 'Linux';
  const chip = (m.chip_name ?? '').toLowerCase();
  if (chip.includes('apple') || /\bm[1-4]\b/.test(chip)) return 'macOS';
  return 'Unknown';
};

type PermLevel = 'full' | 'partial' | 'limited';
const derivePermissions = (m: SentinelMetrics | null): PermLevel => {
  if (!m) return 'limited';
  if (m.cpu_power_w != null || m.nvidia_vram_total_mb != null) return 'full';
  const chip = (m.chip_name ?? m.gpu_name ?? '').toLowerCase();
  if (chip.includes('apple') || /\bm[1-4]\b/.test(chip)) return 'partial';
  return 'limited';
};

const deriveMemCapacity = (m: SentinelMetrics | null): string => {
  if (!m) return '—';
  if (m.nvidia_vram_total_mb != null)
    return `${Math.round(m.nvidia_vram_total_mb / 1024)} GB VRAM`;
  if (m.cpu_power_w != null && m.total_memory_mb > 0)
    return `${Math.round(m.total_memory_mb / 1024)} GB unified`;
  if (m.total_memory_mb > 0)
    return `${Math.round(m.total_memory_mb / 1024)} GB RAM`;
  return '—';
};

// ── Internal types ────────────────────────────────────────────────────────────

type SortKey     = 'registered' | 'nodeId' | 'hostname';
type StatusFilter = 'all' | 'online' | 'offline';

interface EnrichedNode {
  node:      NodeAgent;
  metrics:   SentinelMetrics | null;
  lastSeenMs: number | undefined;
  isOnline:  boolean;
  isFlagged: boolean;
  idx:       number;
}

// ── Header tile ───────────────────────────────────────────────────────────────

const MgmtTile: React.FC<{
  label:    string;
  children: React.ReactNode;
  icon:     React.ElementType;
  iconCls?: string;
  onClick?: () => void;
  active?:  boolean;
  tooltip?: string;
}> = ({ label, children, icon: Icon, iconCls, onClick, active, tooltip }) => (
  <div
    className={`bg-white dark:bg-gray-900 border rounded-2xl p-5 flex flex-col justify-between h-[116px] transition-colors ${
      onClick ? 'cursor-pointer hover:border-indigo-500/40' : ''
    } ${active
      ? 'border-indigo-500/50 bg-indigo-500/5 dark:bg-indigo-500/5'
      : 'border-gray-200 dark:border-gray-800'
    }`}
    onClick={onClick}
    title={tooltip}
  >
    <div className="flex items-start justify-between gap-2">
      <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500 leading-tight">
        {label}
      </p>
      <Icon size={13} className={iconCls ?? 'text-gray-400 dark:text-gray-600'} />
    </div>
    <div>{children}</div>
  </div>
);

// ── Table header row ──────────────────────────────────────────────────────────

const MgmtTableHeader: React.FC<{
  filteredIds:      string[];
  selectedNodes:    Set<string>;
  onToggleSelectAll: (ids: string[]) => void;
}> = ({ filteredIds, selectedNodes, onToggleSelectAll }) => {
  const allSelected =
    filteredIds.length > 0 && filteredIds.every(id => selectedNodes.has(id));
  const COL =
    'text-[9px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-600 leading-none';
  return (
    <div
      className={`${MGMT_GRID_CLS} px-4 py-2 border-b border-gray-100 dark:border-gray-800/60`}
    >
      <div
        className="flex items-center justify-center cursor-pointer"
        onClick={() => onToggleSelectAll(filteredIds)}
      >
        {allSelected
          ? <CheckSquare className="w-3 h-3 text-indigo-400" />
          : <Square className="w-3 h-3 text-gray-500" />
        }
      </div>
      <p className={COL}>Node</p>
      <p className={COL}>Identity</p>
      <p className={`${COL} ${COL_OS}`}>OS</p>
      <p className={`${COL} ${COL_MEMORY}`}>Memory</p>
      <p className={COL}>Connectivity</p>
      <p className={`${COL} ${COL_UPTIME}`}>Uptime</p>
      <p className={`${COL} ${COL_VERSION}`}>Version</p>
      <p className={COL}>Permissions</p>
    </div>
  );
};

// ── Expanded detail band ──────────────────────────────────────────────────────

const DetailBand: React.FC<{
  node:              NodeAgent;
  metrics:           SentinelMetrics | null;
  lastSeenMs:        number | undefined;
  isOnline:          boolean;
  isLocal:           boolean;
  effectiveSettings?: NodeEffectiveSettings;
  onNavigateToSettings?: () => void;
}> = ({ node, metrics: m, lastSeenMs, isOnline, isLocal, effectiveSettings: eff, onNavigateToSettings }) => {

  const DL = ({ label }: { label: string }) => (
    <p className="text-[8px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-600 leading-none mb-1">
      {label}
    </p>
  );
  const DV = ({ children, cls }: { children: React.ReactNode; cls?: string }) => (
    <p className={`text-xs font-telin leading-tight ${cls ?? 'text-gray-700 dark:text-gray-300'}`}>
      {children}
    </p>
  );

  const cpuPowerAvail  = m?.cpu_power_w != null;
  const nvidiaAvail    = m?.nvidia_vram_total_mb != null;
  const thermalAvail   = m?.thermal_state != null;
  const ollamaDetected = m?.ollama_running === true;

  return (
    <div className="border-t border-gray-100 dark:border-gray-800 grid grid-cols-1 divide-y divide-gray-100 dark:divide-gray-800 min-[860px]:grid-cols-3 min-[860px]:divide-y-0 min-[860px]:divide-x">

      {/* A — CONNECTIVITY */}
      <div className="px-4 py-4 space-y-3">
        <p className="text-[8px] font-bold uppercase tracking-widest text-gray-400 dark:text-gray-500">
          Connectivity
        </p>
        <div>
          <DL label="Data Destination" />
          <DV>{isLocal ? 'This device only' : 'Wicklee Cloud'}</DV>
        </div>
        <div>
          <DL label="Last Telemetry" />
          <DV>{lastSeenMs ? fmtAgo(lastSeenMs) : isOnline ? 'live' : '—'}</DV>
        </div>
        <div>
          <DL label="Node ID" />
          <DV cls="text-indigo-400">{node.id}</DV>
        </div>
        <div>
          <DL label="Pairing Log" />
          <DV cls="text-gray-500">history N/A</DV>
        </div>
      </div>

      {/* B — NODE SETTINGS */}
      <div className="px-4 py-4 space-y-3">
        <p className="text-[8px] font-bold uppercase tracking-widest text-gray-400 dark:text-gray-500">
          Node Settings
        </p>
        {eff ? (
          <>
            <div>
              <DL label="kWh Rate" />
              <DV>
                ${eff.kwhRate.toFixed(3)}/kWh{' '}
                <span className={`text-[9px] ${eff.kwhRateOverride ? 'text-amber-400' : 'text-gray-500'}`}>
                  ({eff.kwhRateOverride ? 'override' : 'fleet default'})
                </span>
              </DV>
            </div>
            <div>
              <DL label="Currency" />
              <DV>
                {eff.currency}{' '}
                <span className={`text-[9px] ${eff.currencyOverride ? 'text-amber-400' : 'text-gray-500'}`}>
                  ({eff.currencyOverride ? 'override' : 'fleet default'})
                </span>
              </DV>
            </div>
            <div>
              <DL label="PUE" />
              <DV>
                {eff.pue.toFixed(2)}{' '}
                <span className={`text-[9px] ${eff.pueOverride ? 'text-amber-400' : 'text-gray-500'}`}>
                  ({eff.pueOverride ? 'override' : 'fleet default'})
                </span>
              </DV>
            </div>
            {eff.locationLabel && (
              <div>
                <DL label="Location" />
                <DV>{eff.locationLabel}</DV>
              </div>
            )}
          </>
        ) : (
          <DV cls="text-gray-500">Settings unavailable</DV>
        )}
        {onNavigateToSettings && (
          <button
            onClick={onNavigateToSettings}
            className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            Edit in Settings →
          </button>
        )}
      </div>

      {/* C — DIAGNOSTICS */}
      <div className="px-4 py-4 space-y-3">
        <p className="text-[8px] font-bold uppercase tracking-widest text-gray-400 dark:text-gray-500">
          Diagnostics
        </p>
        <div className="space-y-2">

          <div className="flex items-start gap-2">
            {cpuPowerAvail
              ? <CheckCircle size={10} className="text-green-400 shrink-0 mt-0.5" />
              : <AlertCircle size={10} className="text-amber-400 shrink-0 mt-0.5" />
            }
            <div>
              <p className="text-[10px] text-gray-600 dark:text-gray-400 leading-tight">CPU Power</p>
              <p className="text-[9px] text-gray-500">{cpuPowerAvail ? 'available' : 'requires sudo'}</p>
            </div>
          </div>

          <div className="flex items-start gap-2">
            {nvidiaAvail
              ? <CheckCircle size={10} className="text-green-400 shrink-0 mt-0.5" />
              : <span className="text-[10px] text-gray-600 leading-none shrink-0 mt-0.5">—</span>
            }
            <div>
              <p className="text-[10px] text-gray-600 dark:text-gray-400 leading-tight">GPU (NVML)</p>
              <p className="text-[9px] text-gray-500">{nvidiaAvail ? 'available' : 'not applicable'}</p>
            </div>
          </div>

          <div className="flex items-start gap-2">
            {thermalAvail
              ? <CheckCircle size={10} className="text-green-400 shrink-0 mt-0.5" />
              : <span className="text-[10px] text-gray-600 leading-none shrink-0 mt-0.5">—</span>
            }
            <div>
              <p className="text-[10px] text-gray-600 dark:text-gray-400 leading-tight">Thermal</p>
              <p className="text-[9px] text-gray-500">
                {thermalAvail ? 'available' : '— (Phase 3B: Linux)'}
              </p>
            </div>
          </div>

          <div className="flex items-start gap-2">
            {ollamaDetected
              ? <CheckCircle size={10} className="text-green-400 shrink-0 mt-0.5" />
              : <span className="text-[10px] text-gray-600 leading-none shrink-0 mt-0.5">—</span>
            }
            <div>
              <p className="text-[10px] text-gray-600 dark:text-gray-400 leading-tight">Ollama</p>
              <p className="text-[9px] text-gray-500">{ollamaDetected ? 'detected' : 'not detected'}</p>
            </div>
          </div>

          <div className="flex items-start gap-2">
            <span className="text-[10px] text-gray-600 leading-none shrink-0 mt-0.5">—</span>
            <div>
              <p className="text-[10px] text-gray-600 dark:text-gray-400 leading-tight">vLLM</p>
              <p className="text-[9px] text-gray-500">not detected</p>
            </div>
          </div>

        </div>

        {m?.ollama_model_size_gb != null && (
          <div>
            <DL label="Disk Usage" />
            <DV>{m.ollama_model_size_gb.toFixed(1)} GB — Ollama model storage</DV>
          </div>
        )}
      </div>

    </div>
  );
};

// ── Management row ────────────────────────────────────────────────────────────

const MgmtRow: React.FC<{
  enriched:          EnrichedNode;
  isLocal:           boolean;
  isSelected:        boolean;
  onToggleSelect:    () => void;
  effectiveSettings?: NodeEffectiveSettings;
  onNavigateToSettings?: () => void;
}> = ({ enriched, isLocal, isSelected, onToggleSelect, effectiveSettings, onNavigateToSettings }) => {
  const { node, metrics: m, lastSeenMs, isOnline } = enriched;
  const [open, setOpen] = useState(false);

  const perm     = derivePermissions(m);
  const os       = deriveOS(m);
  const memCap   = deriveMemCapacity(m);
  const chipName = m?.gpu_name ?? m?.chip_name ?? null;
  const hostname = node.hostname && node.hostname !== node.id ? node.hostname : null;

  const dotCls = !isOnline
    ? 'bg-gray-500'
    : perm !== 'full'
    ? 'bg-amber-400 animate-pulse'
    : 'bg-green-400 animate-pulse';

  // Condensed tooltip for Identity cell — surfaces columns hidden at narrow widths
  const identityTooltip = [
    os !== 'Unknown' ? os : null,
    memCap !== '—'   ? memCap : null,
    isOnline && node.uptime ? `Up ${node.uptime}` : null,
    'Agent v—',
  ].filter(Boolean).join('  ·  ');

  return (
    <div
      className={`${enriched.isFlagged ? 'border-l-2 border-l-amber-400/50' : ''} ${!isOnline ? 'opacity-60' : ''}`}
    >
      {/* Collapsed row */}
      <div
        className={`${MGMT_GRID_CLS} px-4 py-3 min-h-[48px] hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors cursor-pointer`}
        onClick={() => setOpen(o => !o)}
      >
        {/* Checkbox */}
        <div
          onClick={e => { e.stopPropagation(); onToggleSelect(); }}
          className="flex items-center justify-center"
        >
          {isSelected
            ? <CheckSquare className="w-3.5 h-3.5 text-indigo-400" />
            : <Square className="w-3.5 h-3.5 text-gray-500 hover:text-gray-300 transition-colors" />
          }
        </div>

        {/* Status + Node ID */}
        <div className="flex items-center gap-2 min-w-0">
          <span className={`shrink-0 w-2 h-2 rounded-full ${dotCls}`} />
          <div className="min-w-0">
            <p className="text-xs font-bold font-telin text-gray-900 dark:text-white truncate">{node.id}</p>
            {hostname && (
              <p className="text-[10px] text-gray-500 font-telin truncate">{hostname}</p>
            )}
          </div>
        </div>

        {/* Identity — tooltip condenses hidden columns at narrow viewports */}
        <div className="min-w-0" title={identityTooltip}>
          {chipName ? (
            <>
              <p className="text-xs font-telin text-indigo-400/90 truncate">{chipName}</p>
              <p className="text-[10px] text-gray-500 truncate">
                {m?.nvidia_vram_total_mb != null
                  ? 'NVIDIA · Discrete GPU'
                  : m?.cpu_power_w != null
                  ? 'ARM · Unified Memory'
                  : 'x86'}
              </p>
            </>
          ) : (
            <p className="text-xs text-gray-600">—</p>
          )}
        </div>

        {/* OS — hide below 1024px */}
        <div className={`min-w-0 ${COL_OS}`}>
          {isOnline && os !== 'Unknown'
            ? <p className="text-xs font-telin text-gray-700 dark:text-gray-300 truncate">{os}</p>
            : <p className="text-xs text-gray-600">—</p>
          }
        </div>

        {/* Memory capacity — inventory, not live usage — hide below 860px */}
        <div className={`min-w-0 ${COL_MEMORY}`}>
          <p className="text-xs font-telin text-gray-700 dark:text-gray-300 truncate">{memCap}</p>
        </div>

        {/* Connectivity */}
        <div>
          {isOnline ? (
            isLocal ? (
              <div className="flex items-center gap-1.5">
                <Lock size={10} className="text-gray-400 shrink-0" />
                <span className="text-xs font-telin text-gray-400">Local</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <Cloud size={10} className="text-indigo-400 shrink-0" />
                <span className="text-xs font-telin text-indigo-400">Paired</span>
              </div>
            )
          ) : (
            <span className="text-xs text-gray-600">Offline</span>
          )}
        </div>

        {/* Uptime — hide below 1024px */}
        <div className={COL_UPTIME}>
          <span className="text-xs font-telin tabular-nums text-gray-500">
            {isOnline ? (node.uptime ?? '—') : '—'}
          </span>
        </div>

        {/* Agent Version — not yet reported by agent — hide below 1200px */}
        <div className={COL_VERSION}>
          <span className="text-xs font-telin text-gray-600">—</span>
        </div>

        {/* Permissions */}
        <div>
          {perm === 'full'
            ? <span className="text-xs font-telin text-green-400">✓ Full</span>
            : perm === 'partial'
            ? (
              <span
                className="text-xs font-telin text-amber-400"
                title="sudo missing — CPU power unavailable"
              >
                ⚠ Partial
              </span>
            ) : (
              <span
                className="text-xs font-telin text-red-400"
                title="Significant data unavailable"
              >
                ✗ Limited
              </span>
            )
          }
        </div>
      </div>

      {/* Expanded detail band */}
      {open && (
        <DetailBand
          node={node}
          metrics={m}
          lastSeenMs={lastSeenMs}
          isOnline={isOnline}
          isLocal={isLocal}
          effectiveSettings={effectiveSettings}
          onNavigateToSettings={onNavigateToSettings}
        />
      )}
    </div>
  );
};

// ── NodesListProps ────────────────────────────────────────────────────────────

interface NodesListProps {
  nodes:                 NodeAgent[];
  getNodeSettings?:      (nodeId: string) => NodeEffectiveSettings;
  onNavigateToSettings?: () => void;
}

// ── Main component ────────────────────────────────────────────────────────────

const NodesList: React.FC<NodesListProps> = ({
  nodes, getNodeSettings, onNavigateToSettings,
}) => {
  const [localMetrics, setLocalMetrics] = useState<SentinelMetrics | null>(null);
  const [allMetrics, setAllMetrics]     = useState<Record<string, SentinelMetrics>>({});
  const [lastSeenMap, setLastSeenMap]   = useState<Record<string, number>>({});
  const [connected, setConnected]       = useState(false);

  const [search, setSearch]               = useState('');
  const [sortKey, setSortKey]             = useState<SortKey>('registered');
  const [sortOpen, setSortOpen]           = useState(false);
  const [statusFilter, setStatusFilter]   = useState<StatusFilter>('all');
  const [showFlaggedOnly, setShowFlaggedOnly] = useState(false);
  const [selectedNodes, setSelectedNodes] = useState<Set<string>>(new Set());

  const esRef    = useRef<EventSource | null>(null);
  const sortRef  = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // ── SSE ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout>;
    const connect = () => {
      if (isLocalHost) {
        const es = new EventSource('/api/metrics');
        esRef.current = es;
        es.onmessage = ev => {
          try { setLocalMetrics(JSON.parse(ev.data) as SentinelMetrics); setConnected(true); }
          catch { /* ignore */ }
        };
        es.onerror = () => {
          setConnected(false); es.close(); esRef.current = null;
          retryTimer = setTimeout(connect, 3000);
        };
      } else {
        const es = new EventSource(`${CLOUD_URL}/api/fleet/stream`);
        esRef.current = es;
        es.onopen = () => setConnected(true);
        es.onmessage = ev => {
          try {
            const fleet = JSON.parse(ev.data) as {
              nodes: Array<{ node_id: string; last_seen_ms: number; metrics: SentinelMetrics | null }>;
            };
            const updM: Record<string, SentinelMetrics> = {};
            const updLS: Record<string, number> = {};
            for (const n of fleet.nodes) {
              updLS[n.node_id] = n.last_seen_ms;
              if (n.metrics) updM[n.node_id] = n.metrics;
            }
            setLastSeenMap(prev => ({ ...prev, ...updLS }));
            if (Object.keys(updM).length > 0)
              setAllMetrics(prev => ({ ...prev, ...updM }));
          } catch { /* ignore */ }
        };
        es.onerror = () => {
          setConnected(false); es.close(); esRef.current = null;
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

  // ── Bulk helpers ───────────────────────────────────────────────────────────
  const handleBulkExport = () => {
    const rows = [...selectedNodes].map(id => ({
      node_id:     id,
      hostname:    nodes.find(n => n.id === id)?.hostname ?? null,
      metrics:     allMetrics[id] ?? null,
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
      const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
    });

  const toggleSelectAll = (ids: string[]) =>
    setSelectedNodes(prev => {
      const allSel = ids.every(id => prev.has(id));
      if (allSel) return new Set([...prev].filter(id => !ids.includes(id)));
      const next = new Set(prev); ids.forEach(id => next.add(id)); return next;
    });

  // ── Localhost single-node view ─────────────────────────────────────────────
  if (isLocalHost) {
    const m    = localMetrics;
    const perm = derivePermissions(m);
    const os   = deriveOS(m);
    const mem  = deriveMemCapacity(m);

    const localNode: NodeAgent = {
      id: m?.node_id ?? 'local',
      hostname: m?.hostname ?? 'localhost',
      ip: 'localhost',
      status: connected ? 'online' : 'offline',
      gpuTemp: null, vramUsed: null, vramTotal: null, powerUsage: null,
      requestsPerSecond: 0, activeInterceptors: [],
      uptime: connected ? 'live' : '—',
    };

    const localEnriched: EnrichedNode = {
      node: localNode, metrics: m,
      lastSeenMs: m ? Date.now() : undefined,
      isOnline: connected,
      isFlagged: perm !== 'full',
      idx: 0,
    };

    const nodeSettingsEff = m ? getNodeSettings?.(m.node_id) : undefined;

    return (
      <div className="space-y-6">
        {/* Header tiles */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <MgmtTile label="Fleet VRAM" icon={Database} iconCls="text-blue-400">
            <p className="text-xl font-bold font-telin text-gray-900 dark:text-white leading-none">{mem}</p>
            <p className="text-[10px] text-gray-500 mt-1">
              {m?.nvidia_vram_total_mb != null ? '1 NVIDIA node'
                : m?.cpu_power_w != null       ? '1 Apple Silicon node'
                : '1 node'}
            </p>
          </MgmtTile>

          <MgmtTile
            label="Connectivity" icon={Wifi} iconCls="text-gray-500"
            tooltip="Paired = telemetry sent to wicklee.dev cloud. Local = agent running without cloud connection."
          >
            <p className="text-xl font-bold font-telin text-gray-900 dark:text-white leading-none">1 Local</p>
            <p className="text-[10px] text-gray-500 mt-1">0 nodes offline</p>
          </MgmtTile>

          <MgmtTile label="Hardware Mix" icon={Cpu} iconCls="text-indigo-400">
            <div className="flex items-center gap-1.5 flex-wrap">
              {os !== 'Unknown'
                ? <span className="text-[10px] font-telin text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">{os} [1]</span>
                : <span className="text-[10px] text-gray-600">—</span>
              }
            </div>
            <p className="text-[10px] text-gray-500 mt-1 truncate">
              {m?.chip_name ?? m?.gpu_name ?? '—'}
            </p>
          </MgmtTile>

          <MgmtTile
            label="Lifecycle Alerts"
            icon={AlertTriangle}
            iconCls={perm !== 'full' ? 'text-amber-400' : 'text-gray-500'}
          >
            {perm === 'full' ? (
              <>
                <p className="text-xl font-bold font-telin text-green-400 leading-none">0</p>
                <p className="text-[10px] text-green-500 mt-1">All clear ✓</p>
              </>
            ) : (
              <>
                <p className="text-xl font-bold font-telin text-amber-400 leading-none">1</p>
                <p className="text-[10px] text-amber-500 mt-1">permission limited</p>
              </>
            )}
          </MgmtTile>
        </div>

        {/* Node table */}
        <div className="border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden bg-white dark:bg-gray-900">
          <MgmtTableHeader
            filteredIds={[localNode.id]}
            selectedNodes={selectedNodes}
            onToggleSelectAll={toggleSelectAll}
          />
          <MgmtRow
            enriched={localEnriched}
            isLocal={true}
            isSelected={selectedNodes.has(localNode.id)}
            onToggleSelect={() => toggleSelect(localNode.id)}
            effectiveSettings={nodeSettingsEff}
            onNavigateToSettings={onNavigateToSettings}
          />
        </div>

        {/* CTA */}
        <div className="bg-indigo-500/5 border border-indigo-500/20 rounded-2xl p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-gray-800 dark:text-gray-200">
              Running multiple machines?
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              Add and manage all your nodes from the Fleet dashboard at wicklee.dev.
            </p>
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

  // ── Hosted view — empty state ──────────────────────────────────────────────
  if (nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-32 text-center space-y-4">
        <p className="text-gray-400 font-semibold">No nodes paired yet</p>
        <p className="text-sm text-gray-500">Pair your first node from Fleet Overview.</p>
      </div>
    );
  }

  // ── Enrich nodes ────────────────────────────────────────────────────────────
  const enriched: EnrichedNode[] = nodes.map((node, idx) => {
    const metrics  = allMetrics[node.id] ?? null;
    const ls       = lastSeenMap[node.id];
    const isOnline = metrics !== null && (ls == null || Date.now() - ls < 30_000);
    const perm     = derivePermissions(metrics);
    const ollamaOk = metrics?.ollama_running === true;
    const offlineGt10 = !isOnline && ls != null && Date.now() - ls > 10 * 60 * 1000;
    const isFlagged = perm !== 'full' || !ollamaOk || offlineGt10;
    return { node, metrics, lastSeenMs: ls, isOnline, isFlagged, idx };
  });

  const onlineCount  = enriched.filter(e => e.isOnline).length;
  const offlineCount = enriched.filter(e => !e.isOnline).length;
  const flaggedCount = enriched.filter(e => e.isFlagged).length;
  const allLive      = enriched.filter(e => e.isOnline).map(e => e.metrics!);

  // ── Header tile computations ────────────────────────────────────────────────

  // Fleet VRAM
  const nvidiaNodes    = allLive.filter(m => m.nvidia_vram_total_mb != null);
  const appleNodes     = allLive.filter(m => m.cpu_power_w != null);
  const nvTotalGb      = (nvidiaNodes.reduce((s, m) => s + (m.nvidia_vram_total_mb ?? 0), 0) / 1024).toFixed(1);
  const nvUsedGb       = (nvidiaNodes.reduce((s, m) => s + (m.nvidia_vram_used_mb ?? 0), 0) / 1024).toFixed(1);
  const unifiedTotalGb = (appleNodes.reduce((s, m) => s + m.total_memory_mb, 0) / 1024).toFixed(1);

  const vramPrimary =
    nvidiaNodes.length > 0 ? `${nvUsedGb} / ${nvTotalGb} GB`
    : appleNodes.length > 0 ? `${unifiedTotalGb} GB`
    : '—';
  const vramSub =
    nvidiaNodes.length > 0
      ? `across ${nvidiaNodes.length} NVIDIA node${nvidiaNodes.length !== 1 ? 's' : ''}`
      : appleNodes.length > 0
      ? `${appleNodes.length} Apple Silicon node${appleNodes.length !== 1 ? 's' : ''} unified`
      : 'no GPU nodes detected';

  // Hardware Mix
  const osCounts: Record<string, number> = {};
  const chipFamilies: Set<string> = new Set();
  enriched.forEach(({ metrics: m }) => {
    const os = deriveOS(m);
    if (os !== 'Unknown') osCounts[os] = (osCounts[os] ?? 0) + 1;
    if (m?.nvidia_vram_total_mb != null) chipFamilies.add('NVIDIA');
    else if (m?.cpu_power_w != null) chipFamilies.add('Apple Silicon');
    else if (m) chipFamilies.add('Generic');
  });
  const osPills       = Object.entries(osCounts).sort((a, b) => b[1] - a[1]);
  const chipFamilyStr = [...chipFamilies].join(' · ') || '—';

  // ── Filter + sort ───────────────────────────────────────────────────────────
  const q = search.trim().toLowerCase();
  let filtered = enriched.filter(({ node, metrics: m, isOnline, isFlagged }) => {
    if (showFlaggedOnly && !isFlagged) return false;
    if (statusFilter === 'online'  && !isOnline) return false;
    if (statusFilter === 'offline' &&  isOnline) return false;
    if (!q) return true;
    const chip = (m?.gpu_name ?? m?.chip_name ?? '').toLowerCase();
    return (
      node.id.toLowerCase().includes(q) ||
      (node.hostname ?? '').toLowerCase().includes(q) ||
      chip.includes(q) ||
      (isOnline ? 'online' : 'offline').includes(q)
    );
  });

  if (sortKey === 'nodeId')
    filtered = [...filtered].sort((a, b) => a.node.id.localeCompare(b.node.id));
  else if (sortKey === 'hostname')
    filtered = [...filtered].sort((a, b) =>
      (a.node.hostname ?? '').localeCompare(b.node.hostname ?? ''));

  const filteredIds = filtered.map(e => e.node.id);

  return (
    <div className="space-y-4">

      {/* ── Header tiles ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">

        <MgmtTile label="Fleet VRAM" icon={Database} iconCls="text-blue-400">
          <p className="text-xl font-bold font-telin text-gray-900 dark:text-white leading-none">
            {vramPrimary}
          </p>
          <p className="text-[10px] text-gray-500 mt-1">{vramSub}</p>
        </MgmtTile>

        <MgmtTile
          label="Connectivity" icon={Wifi} iconCls="text-indigo-400"
          tooltip="Paired = telemetry sent to wicklee.dev cloud. Local = agent running without cloud connection."
        >
          <p className="text-base font-bold font-telin text-gray-900 dark:text-white leading-none">
            {onlineCount} Paired  ·  0 Local
          </p>
          {offlineCount > 0
            ? <p className="text-[10px] text-amber-500 mt-1">
                {offlineCount} node{offlineCount !== 1 ? 's' : ''} offline
              </p>
            : <p className="text-[10px] text-gray-500 mt-1">all nodes reachable</p>
          }
        </MgmtTile>

        <MgmtTile label="Hardware Mix" icon={Cpu} iconCls="text-indigo-400">
          <div className="flex items-center gap-1 flex-wrap min-h-[22px]">
            {osPills.length > 0
              ? osPills.map(([os, count]) => (
                  <span
                    key={os}
                    className="text-[10px] font-telin text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded"
                  >
                    {os} [{count}]
                  </span>
                ))
              : <span className="text-[10px] text-gray-600">—</span>
            }
          </div>
          <p className="text-[10px] text-gray-500 mt-1 truncate">{chipFamilyStr}</p>
        </MgmtTile>

        <MgmtTile
          label="Lifecycle Alerts"
          icon={AlertTriangle}
          iconCls={flaggedCount > 0 ? 'text-amber-400' : 'text-gray-500'}
          onClick={flaggedCount > 0 ? () => setShowFlaggedOnly(f => !f) : undefined}
          active={showFlaggedOnly}
        >
          {flaggedCount === 0 ? (
            <>
              <p className="text-xl font-bold font-telin text-green-400 leading-none">0</p>
              <p className="text-[10px] text-green-500 mt-1">All clear ✓</p>
            </>
          ) : (
            <>
              <p className="text-xl font-bold font-telin text-amber-400 leading-none">{flaggedCount}</p>
              <p className="text-[10px] text-amber-500 mt-1">
                {showFlaggedOnly ? 'showing flagged ↑' : 'click to filter'}
              </p>
            </>
          )}
        </MgmtTile>

      </div>

      {/* ── Search + sort bar ─────────────────────────────────────────────── */}
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
            className="flex items-center gap-2 px-4 py-2 text-xs font-medium bg-gray-900 border border-gray-700 rounded-xl text-gray-300 hover:border-indigo-500 transition-colors focus:outline-none"
          >
            <ArrowUpDown className="w-3.5 h-3.5 text-gray-500" />
            <span>
              {sortKey === 'nodeId' ? 'Node ID'
                : sortKey === 'hostname' ? 'Hostname'
                : 'Registration order'}
            </span>
            <ChevronDown className={`w-3.5 h-3.5 text-gray-500 transition-transform duration-150 ${sortOpen ? 'rotate-180' : ''}`} />
          </button>
          {sortOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-44 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-20 py-1">
              {(['registered', 'nodeId', 'hostname'] as SortKey[]).map(key => (
                <button
                  key={key}
                  onClick={() => { setSortKey(key); setSortOpen(false); }}
                  className={`w-full text-left px-3 py-2 text-xs transition-colors ${
                    sortKey === key
                      ? 'text-indigo-300 bg-indigo-500/10'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
                  }`}
                >
                  {key === 'registered' ? 'Registration order'
                    : key === 'nodeId' ? 'Node ID'
                    : 'Hostname'}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Status filter tabs ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 flex-wrap">
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
              <span className={active ? 'text-gray-500' : 'text-gray-400 dark:text-gray-600'}>
                ({count})
              </span>
            </button>
          );
        })}

        {showFlaggedOnly && (
          <button
            onClick={() => setShowFlaggedOnly(false)}
            className="flex items-center gap-1.5 ml-2 px-2 py-1 rounded text-[9px] font-semibold text-amber-400 bg-amber-400/10 border border-amber-400/20 hover:bg-amber-400/20 transition-colors"
          >
            <X className="w-2.5 h-2.5" />
            Flagged only
          </button>
        )}

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

      {/* ── Node table ────────────────────────────────────────────────────── */}
      <div className="border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden bg-white dark:bg-gray-900">
        <MgmtTableHeader
          filteredIds={filteredIds}
          selectedNodes={selectedNodes}
          onToggleSelectAll={toggleSelectAll}
        />

        {filtered.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-sm text-gray-500">No nodes match your filters</p>
            <button
              onClick={() => { setSearch(''); setStatusFilter('all'); setShowFlaggedOnly(false); }}
              className="mt-3 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800/60">
            {filtered.map(e => (
              <MgmtRow
                key={e.node.id}
                enriched={e}
                isLocal={false}
                isSelected={selectedNodes.has(e.node.id)}
                onToggleSelect={() => toggleSelect(e.node.id)}
                effectiveSettings={getNodeSettings?.(e.node.id)}
                onNavigateToSettings={onNavigateToSettings}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <p className="text-[11px] text-gray-600 text-center pt-1">
        <span className="text-gray-400 font-semibold">
          {onlineCount} node{onlineCount !== 1 ? 's' : ''} online
        </span>
        {' '}· {nodes.length} total
        {selectedNodes.size > 0 && (
          <span className="text-indigo-400"> · {selectedNodes.size} selected</span>
        )}
      </p>

      {/* ── Bulk Actions bar ─────────────────────────────────────────────── */}
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
            Export Audit
          </button>
          <div className="w-px h-4 bg-gray-700 shrink-0" />
          <button className="text-xs font-medium text-red-400 hover:text-red-300 transition-colors">
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
