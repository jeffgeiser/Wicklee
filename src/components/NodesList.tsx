import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Search, X, ArrowUpDown, ChevronDown,
  Cloud, Lock, CheckSquare, Square,
  Database, Wifi, Cpu, AlertTriangle,
  ExternalLink, CheckCircle, AlertCircle,
  Radio, Zap, Thermometer, Activity,
} from 'lucide-react';
import { NodeAgent, PairingInfo, SentinelMetrics } from '../types';
import type { NodeEffectiveSettings } from '../hooks/useSettings';
import { NODE_REACHABLE_MS, fmtAgo as fmtNodeAgo } from '../utils/time';
import { useFleetStream } from '../contexts/FleetStreamContext';
import { useFleetCounts } from '../hooks/useFleetCounts';

// ── Constants ─────────────────────────────────────────────────────────────────

const isLocalHost =
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// ── Management table grid ──────────────────────────────────────────────────────
// Fixed column widths — no responsive hiding.
// Container is overflow-x: auto so the table scrolls horizontally on narrow
// viewports rather than collapsing or hiding columns.
// Columns: SELECT(40) | NODE ID(100) | IDENTITY(220) | OS(80) | MEMORY(120) |
//          CONNECTIVITY(110) | UPTIME(90) | VERSION(80) | COVERAGE(120) | SPACER(1fr)
const MGMT_GRID_CLS = 'grid gap-x-3 items-center [grid-template-columns:40px_100px_220px_80px_120px_110px_90px_80px_120px_1fr]';

// ── Utilities ─────────────────────────────────────────────────────────────────

const fmtAgo = (ms: number): string => {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

type NodeOS = 'macOS' | 'Linux' | 'Windows' | 'Unknown';

// Fallback inference for older agents that predate the explicit os field.
const inferOsFromMetrics = (m: SentinelMetrics | null): NodeOS => {
  if (!m) return 'Unknown';
  if (m.nvidia_power_draw_w != null) return 'Linux';
  if (m.memory_pressure_percent != null) return 'macOS';
  const chip = (m.chip_name ?? '').toLowerCase();
  if (chip.includes('ryzen') || chip.includes('intel core') || chip.includes('amd')) return 'Linux';
  if (chip.includes('apple') || /\bm[1-4]\b/.test(chip)) return 'macOS';
  return 'Unknown';
};

const deriveOS = (m: SentinelMetrics | null): NodeOS => {
  const explicit = m?.os;
  if (explicit === 'macOS' || explicit === 'Linux' || explicit === 'Windows') return explicit;
  return inferOsFromMetrics(m);
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
    'text-[9px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-600 leading-none whitespace-nowrap';
  return (
    <div
      className={`${MGMT_GRID_CLS} px-4 py-2 border-b border-gray-100 dark:border-gray-800/60`}
    >
      <div
        className="flex items-center justify-center cursor-pointer sticky left-4 bg-white dark:bg-gray-900"
        onClick={() => onToggleSelectAll(filteredIds)}
      >
        {allSelected
          ? <CheckSquare className="w-3 h-3 text-indigo-400" />
          : <Square className="w-3 h-3 text-gray-500" />
        }
      </div>
      <p className={`${COL} sticky left-[68px] bg-white dark:bg-gray-900`}>Node</p>
      <p className={COL}>Identity</p>
      <p className={COL}>OS</p>
      <p className={COL}>Memory</p>
      <p className={COL}>Connectivity</p>
      <p className={COL}>Uptime</p>
      <p className={COL}>Version</p>
      <p className={COL} title="Metric coverage — what this agent can see on its node">Coverage</p>
      <div />
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
  const vllmDetected   = m?.vllm_running   === true;

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
            {vllmDetected
              ? <CheckCircle size={10} className="text-green-400 shrink-0 mt-0.5" />
              : <span className="text-[10px] text-gray-600 leading-none shrink-0 mt-0.5">—</span>
            }
            <div>
              <p className="text-[10px] text-gray-600 dark:text-gray-400 leading-tight">vLLM</p>
              {vllmDetected ? (
                <>
                  <p className="text-[9px] text-gray-500 truncate">
                    {m?.vllm_model_name ?? 'detected'}
                  </p>
                  {m?.vllm_tokens_per_sec != null && (
                    <p className="text-[9px] text-green-400 font-telin">
                      {m.vllm_tokens_per_sec.toFixed(1)} tok/s
                    </p>
                  )}
                  {m?.vllm_cache_usage_perc != null && (
                    <p className="text-[9px] text-cyan-400 font-telin">
                      Cache: {m.vllm_cache_usage_perc.toFixed(0)}%
                    </p>
                  )}
                </>
              ) : (
                <p className="text-[9px] text-gray-500">not detected</p>
              )}
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

  const dotState: 'online' | 'offline' | 'pending' =
    isOnline ? 'online' :
    lastSeenMs != null ? 'offline' :
    'pending';
  const dotCls =
    dotState === 'online'  ? 'bg-green-400 animate-pulse' :
    dotState === 'offline' ? 'bg-red-500' :
    'bg-gray-500';
  const dotTooltip =
    dotState === 'online'  ? 'Online · last seen just now' :
    dotState === 'offline' ? `Unreachable · last seen ${fmtNodeAgo(lastSeenMs!)}` :
    'Pending · waiting for first report';

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
        className={`group ${MGMT_GRID_CLS} px-4 py-3 min-h-[48px] hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors cursor-pointer`}
        onClick={() => setOpen(o => !o)}
      >
        {/* Checkbox (sticky) */}
        <div
          onClick={e => { e.stopPropagation(); onToggleSelect(); }}
          className="flex items-center justify-center overflow-hidden sticky left-4 bg-white dark:bg-gray-900 group-hover:bg-gray-50 dark:group-hover:bg-gray-800/40"
        >
          {isSelected
            ? <CheckSquare className="w-3.5 h-3.5 text-indigo-400" />
            : <Square className="w-3.5 h-3.5 text-gray-500 hover:text-gray-300 transition-colors" />
          }
        </div>

        {/* Status + Node ID (sticky) */}
        <div className="flex items-center gap-2 overflow-hidden sticky left-[68px] bg-white dark:bg-gray-900 group-hover:bg-gray-50 dark:group-hover:bg-gray-800/40">
          <span className={`shrink-0 w-2 h-2 rounded-full ${dotCls}`} title={dotTooltip} />
          <div className="min-w-0">
            <p className="text-xs font-bold font-telin text-gray-900 dark:text-white truncate">{node.id}</p>
            {hostname && (
              <p className="text-[10px] text-gray-500 font-telin truncate">{hostname}</p>
            )}
          </div>
        </div>

        {/* Identity */}
        <div className="min-w-0 overflow-hidden" title={identityTooltip}>
          {chipName ? (
            <>
              <p className="text-xs font-telin text-indigo-400/90 truncate">{chipName}</p>
              <p className="text-[10px] text-gray-500 truncate">
                {m?.nvidia_vram_total_mb != null
                  ? 'NVIDIA · Discrete GPU'
                  : os === 'macOS'
                  ? 'ARM · Unified Memory'
                  : m?.arch === 'aarch64'
                  ? 'ARM · Linux'
                  : 'x86'}
              </p>
            </>
          ) : isOnline && os !== 'Unknown' ? (
            // Node is online and sending metrics, but chip/GPU name wasn't reported.
            // Common on ARM Linux (e.g. NVIDIA Grace) where the linux-aarch64 build
            // lacks NVML — re-run the install script to pick up the correct binary.
            <>
              <p className="text-xs font-telin text-gray-500 truncate">{os} Node</p>
              <p
                className="text-[10px] text-amber-500/70 truncate"
                title="GPU data unavailable — re-run the install script to enable full metrics"
              >
                GPU data unavailable
              </p>
            </>
          ) : (
            <p className="text-xs text-gray-600">—</p>
          )}
        </div>

        {/* OS */}
        <div className="min-w-0 overflow-hidden">
          {isOnline && os !== 'Unknown'
            ? <p className="text-xs font-telin text-gray-700 dark:text-gray-300 truncate">{os}</p>
            : <p className="text-xs text-gray-600">—</p>
          }
        </div>

        {/* Memory capacity — inventory, not live usage */}
        <div className="min-w-0 overflow-hidden">
          <p className="text-xs font-telin text-gray-700 dark:text-gray-300 truncate">{memCap}</p>
        </div>

        {/* Connectivity */}
        <div className="overflow-hidden">
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

        {/* Uptime */}
        <div className="overflow-hidden">
          <span className="text-xs font-telin tabular-nums text-gray-500">
            {isOnline ? (node.uptime ?? '—') : '—'}
          </span>
        </div>

        {/* Agent Version */}
        <div className="overflow-hidden">
          <span className="text-xs font-telin text-gray-500">
            {isLocal ? ((import.meta.env.VITE_AGENT_VERSION as string | undefined) ?? '—') : '—'}
          </span>
        </div>

        {/* Coverage */}
        <div className="overflow-hidden min-w-0">
          {!isOnline ? (
            <span
              className="text-xs font-telin text-gray-500 block truncate"
              title="Node offline — coverage unknown"
            >
              —
            </span>
          ) : perm === 'full' ? (
            <span
              className="text-xs font-telin text-green-400 block truncate"
              title="All metrics available — power, thermal, GPU, memory reporting normally"
            >
              ✓ Full
            </span>
          ) : (
            <span
              className="text-xs font-telin text-amber-400 block truncate"
              title={[
                'Some metrics unavailable',
                m?.cpu_power_w == null    ? 'CPU power data missing' : null,
                m?.nvidia_vram_total_mb == null ? 'GPU data missing'  : null,
                m?.thermal_state == null  ? 'Thermal data missing'    : null,
              ].filter(Boolean).join(' · ')}
            >
              ⚠ Partial
            </span>
          )}
        </div>

        {/* SPACER */}
        <div />
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

// ── Telemetry Relay Status — slim single-row ──────────────────────────────────
// Shows whether this node is relaying telemetry to wicklee.dev (paired) or
// operating in Sovereign Mode with no outbound data (unpaired / disconnected).
const TelemetryRelayStatus: React.FC<{ pairingInfo: PairingInfo | null | undefined }> = ({ pairingInfo }) => {
  const isRelaying = pairingInfo?.status === 'connected';
  const isPending  = pairingInfo?.status === 'pending';
  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
      <Radio className={`w-3.5 h-3.5 shrink-0 ${isRelaying ? 'text-green-400' : isPending ? 'text-amber-400 animate-pulse' : 'text-gray-500'}`} />
      {isRelaying ? (
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
          Relaying to <span className="text-green-400 font-semibold">wicklee.dev ✓</span>
          {pairingInfo?.node_id && <span className="text-gray-600 font-telin"> · {pairingInfo.node_id}</span>}
        </p>
      ) : isPending ? (
        <p className="text-xs font-medium text-amber-400">Pairing in progress…</p>
      ) : (
        <p className="text-xs font-medium text-gray-500 dark:text-gray-500">
          Sovereign Mode — no outbound telemetry
          <a
            href="https://wicklee.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="ml-2 text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            Connect →
          </a>
        </p>
      )}
    </div>
  );
};

// ── Harvester Health — agent build localhost view ─────────────────────────────
// Shows the status of each metric harvester: NVML, RAPL, IOKit/AGX, Ollama,
// vLLM, and Thermal. Each entry shows Active / Not detected based on live metrics.
const HarvesterHealth: React.FC<{ metrics: SentinelMetrics | null }> = ({ metrics: m }) => {
  const chip = (m?.chip_name ?? m?.gpu_name ?? '').toLowerCase();
  const isApple  = m?.cpu_power_w != null && (chip.includes('apple') || /\bm[1-4]\b/.test(chip));
  const isNvidia = m?.nvidia_vram_total_mb != null;
  const isLinux  = m?.nvidia_power_draw_w != null || (!isApple && m?.cpu_power_w != null);

  type HEntry = { label: string; ok: boolean | null; detail?: string; detailMono?: boolean };
  const entries: HEntry[] = [
    {
      label: 'NVML (NVIDIA GPU)',
      ok: m == null ? null : isNvidia,
      detail: isNvidia ? 'Active' : 'Not applicable',
    },
    {
      label: 'RAPL (Linux CPU power)',
      ok: m == null ? null : isLinux && m.cpu_power_w != null,
      detail: isLinux && m?.cpu_power_w != null ? 'Active' : isNvidia ? 'Not applicable' : 'Unavailable · sudo wicklee --install-service',
      detailMono: !(isLinux && m?.cpu_power_w != null) && !isNvidia,
    },
    {
      label: 'IOKit / AGX (Apple)',
      ok: m == null ? null : isApple,
      detail: isApple ? 'Active' : 'Not applicable',
    },
    {
      label: 'Ollama',
      ok: m == null ? null : m.ollama_running === true,
      detail: m?.ollama_running ? `Connected · ${m.ollama_active_model ?? 'idle'}` : 'Not detected',
    },
    {
      label: 'vLLM',
      ok: m == null ? null : m.vllm_running === true,
      detail: m?.vllm_running ? `Connected · ${m.vllm_model_name ?? 'running'}` : 'Not detected',
    },
    {
      label: 'Thermal',
      ok: m == null ? null : m.thermal_state != null,
      detail: m?.thermal_state ?? (isNvidia ? 'GPU temp via NVML' : 'Unavailable'),
    },
  ];

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden">
      <div className="px-5 py-2.5 border-b border-gray-100 dark:border-gray-800 flex items-center gap-2">
        <Activity className="w-3.5 h-3.5 text-gray-400" />
        <h3 className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-widest">Harvester Health</h3>
      </div>
      <div className="grid grid-cols-2 divide-x divide-gray-100 dark:divide-gray-800">
        {entries.map(({ label, ok, detail, detailMono }) => (
          <div key={label} className="flex items-start gap-2.5 px-4 py-1.5">
            {ok == null ? (
              <span className="w-2 h-2 rounded-full bg-gray-500 shrink-0 mt-1" />
            ) : ok ? (
              <CheckCircle size={13} className="text-green-400 shrink-0 mt-0.5" />
            ) : (
              <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center mt-0.5">
                <span className="text-[10px] text-gray-500">—</span>
              </span>
            )}
            <div className="min-w-0">
              <p className="text-[11px] font-medium text-gray-700 dark:text-gray-300 leading-tight">{label}</p>
              <p className={`text-[10px] leading-tight mt-0.5 truncate ${detailMono ? 'font-mono' : 'font-telin'} ${ok ? 'text-green-400' : 'text-gray-500 dark:text-gray-600'}`}
                 title={detail ?? (ok == null ? 'awaiting data' : ok ? 'Active' : 'Not detected')}>
                {detail ?? (ok == null ? 'awaiting data' : ok ? 'Active' : 'Not detected')}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ── NodesListProps ────────────────────────────────────────────────────────────

interface NodesListProps {
  nodes:                 NodeAgent[];
  getNodeSettings?:      (nodeId: string) => NodeEffectiveSettings;
  onNavigateToSettings?: () => void;
  pairingInfo?:          PairingInfo | null;
  /** Clerk / session token factory — present in hosted (non-local) builds. */
  getToken?:             () => Promise<string | null>;
  /** Cloud base URL for management API calls. */
  cloudUrl?:             string;
  /** Called after one or more nodes are successfully removed so the parent
   *  can refresh its fleet list and free up the node slot count. */
  onNodesRemoved?:       (removedIds: string[]) => void;
}

// ── Main component ────────────────────────────────────────────────────────────

const NodesList: React.FC<NodesListProps> = ({
  nodes, getNodeSettings, onNavigateToSettings, pairingInfo,
  getToken, cloudUrl, onNodesRemoved,
}) => {
  const {
    allNodeMetrics: cloudMetrics,
    lastSeenMsMap: cloudLastSeen,
    connected: cloudConnected,
  } = useFleetStream();

  // Local-only state
  const [localMetrics, setLocalMetrics] = useState<SentinelMetrics | null>(null);
  const [localConnected, setLocalConnected] = useState(false);

  const [search, setSearch]               = useState('');
  const [sortKey, setSortKey]             = useState<SortKey>('registered');
  const [sortOpen, setSortOpen]           = useState(false);
  const [statusFilter, setStatusFilter]   = useState<StatusFilter>('all');
  const [showFlaggedOnly, setShowFlaggedOnly] = useState(false);
  const [selectedNodes, setSelectedNodes] = useState<Set<string>>(new Set());
  // Two-step confirmation: first click arms, second click fires.
  const [disconnectConfirming, setDisconnectConfirming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const confirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const esRef    = useRef<EventSource | null>(null);
  const sortRef  = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Unified references
  const allMetrics = isLocalHost
    ? (localMetrics ? { [localMetrics.node_id ?? 'local']: localMetrics } : {})
    : cloudMetrics;
  const lastSeenMap = cloudLastSeen;
  const connected = isLocalHost ? localConnected : cloudConnected;

  // Single source of truth for all node counts.
  // Must be called before any early returns (Rules of Hooks).
  const counts = useFleetCounts(nodes);

  // ── SSE (local only) ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!isLocalHost) return;
    let retryTimer: ReturnType<typeof setTimeout>;
    const connect = () => {
      const es = new EventSource('/api/metrics');
      esRef.current = es;
      es.onmessage = ev => {
        try { setLocalMetrics(JSON.parse(ev.data) as SentinelMetrics); setLocalConnected(true); }
        catch { /* ignore */ }
      };
      es.onerror = () => {
        setLocalConnected(false); es.close(); esRef.current = null;
        retryTimer = setTimeout(connect, 3000);
      };
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

  const handleBulkDisconnect = useCallback(async () => {
    // First click arms the confirmation state.
    if (!disconnectConfirming) {
      setDisconnectError(null);
      setDisconnectConfirming(true);
      // Clear any previous timeout, then auto-cancel after 6s if not confirmed.
      if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = setTimeout(() => setDisconnectConfirming(false), 6000);
      return;
    }
    // Second click fires.
    // cloudUrl may be '' (empty string) in same-origin proxy mode — that's valid.
    // Use == null to allow empty string while still blocking undefined/null.
    if (!getToken || cloudUrl == null || disconnecting) return;
    if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
    setDisconnecting(true);
    setDisconnectConfirming(false);
    try {
      const token = await getToken();
      const ids   = [...selectedNodes];
      const results = await Promise.allSettled(
        ids.map(id =>
          fetch(`${cloudUrl}/api/nodes/${encodeURIComponent(id)}`, {
            method:  'DELETE',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          })
        )
      );
      // Only treat 204 No Content (or any 2xx) as genuine success.
      // 404 is NOT treated as success — a 404 can mean the backend route
      // doesn't exist yet, not that the node was already removed.
      const removed = ids.filter((_, i) => {
        const r = results[i];
        return r.status === 'fulfilled' && r.value.ok;
      });
      const failCount = ids.length - removed.length;
      if (removed.length > 0) {
        // Clear ALL selections after a successful delete, not just the removed
        // ones — prevents stale selections from being caught in the next confirm.
        setSelectedNodes(new Set());
        onNodesRemoved?.(removed);
      }
      if (failCount > 0) {
        // Surface the HTTP status of the first failure so it's diagnosable.
        const firstFail = results.find(r =>
          r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok)
        );
        const statusHint = firstFail?.status === 'fulfilled'
          ? ` (${firstFail.value.status})`
          : '';
        setDisconnectError(
          `${failCount} node${failCount !== 1 ? 's' : ''} could not be removed${statusHint}. Try again in a moment.`
        );
      }
    } catch {
      setDisconnectError('Request failed. Check your connection and try again.');
    } finally {
      setDisconnecting(false);
    }
  }, [disconnectConfirming, disconnecting, getToken, cloudUrl, selectedNodes, onNodesRemoved]);

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
        {/* ── Harvester Health ────────────────────────────────────────────────── */}
        <HarvesterHealth metrics={m} />

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
        <div className="border border-gray-200 dark:border-gray-800 rounded-2xl overflow-x-auto bg-white dark:bg-gray-900">
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

        {/* ── Telemetry Relay Status ──────────────────────────────────────────── */}
        <TelemetryRelayStatus pairingInfo={pairingInfo} />

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
    const isOnline = metrics !== null && (ls == null || Date.now() - ls <= NODE_REACHABLE_MS);
    const perm     = derivePermissions(metrics);
    const ollamaOk = metrics?.ollama_running === true;
    const offlineGt10 = !isOnline && ls != null && Date.now() - ls > 10 * 60 * 1000;
    const isFlagged = perm !== 'full' || !ollamaOk || offlineGt10;
    return { node, metrics, lastSeenMs: ls, isOnline, isFlagged, idx };
  });

  // onlineCount / offlineCount removed — all display counts now derive from
  // useFleetCounts (counts.online, counts.total) for a single source of truth.
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
            {counts.online} Paired  ·  0 Local
          </p>
          {(counts.total - counts.online) > 0
            ? <p className="text-[10px] text-amber-500 mt-1">
                {counts.total - counts.online} node{(counts.total - counts.online) !== 1 ? 's' : ''} offline
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
          const count  = f === 'all' ? counts.total : f === 'online' ? counts.online : (counts.total - counts.online);
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
      <div className="border border-gray-200 dark:border-gray-800 rounded-2xl overflow-x-auto bg-white dark:bg-gray-900">
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
          {counts.online} node{counts.online !== 1 ? 's' : ''} online
        </span>
        {' '}· {counts.total} total
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
          <button
            onClick={handleBulkDisconnect}
            disabled={disconnecting || !getToken}
            className={`text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              disconnectConfirming
                ? 'text-red-300 font-semibold animate-pulse'
                : 'text-red-400 hover:text-red-300'
            }`}
            title={!getToken ? 'Sign in to remove nodes' : disconnectConfirming ? 'Click again to confirm removal' : `Remove ${selectedNodes.size} node${selectedNodes.size !== 1 ? 's' : ''} from fleet`}
          >
            {disconnecting
              ? 'Removing…'
              : disconnectConfirming
              ? `Confirm remove ${selectedNodes.size} node${selectedNodes.size !== 1 ? 's' : ''}?`
              : 'Disconnect'}
          </button>
          <div className="w-px h-4 bg-gray-700 shrink-0" />
          <button
            onClick={() => { setSelectedNodes(new Set()); setDisconnectError(null); }}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Error toast — appears below the bulk bar when a disconnect fails */}
      {disconnectError && (
        <div className="fixed bottom-[72px] left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 bg-red-950 border border-red-800/60 rounded-xl shadow-xl animate-in fade-in slide-in-from-bottom-2 duration-200">
          <span className="text-xs text-red-300">{disconnectError}</span>
          <button
            onClick={() => setDisconnectError(null)}
            className="text-red-500 hover:text-red-300 transition-colors ml-1"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

    </div>
  );
};

export default NodesList;
