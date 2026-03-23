import React from 'react';
import { Cpu, Database, Zap, Activity, MemoryStick, Wind, Thermometer, BotMessageSquare, AlertTriangle } from 'lucide-react';
import { SentinelMetrics } from '../types';
import { computeWES, formatWES, wesColorClass, THERMAL_PENALTY } from '../utils/wes';
import { WES_TOOLTIP, INFERENCE_VRAM_THRESHOLD_MB } from '../utils/efficiency';
import { getNodePowerW, hasPowerData } from '../utils/power';

export const thermalColour = (state: string | null) => {
  switch (state?.toLowerCase()) {
    case 'normal':   return 'text-green-400';
    case 'elevated': return 'text-yellow-400';
    case 'fair':     return 'text-yellow-400';
    case 'high':     return 'text-orange-400';
    case 'serious':  return 'text-orange-400';
    case 'critical': return 'text-red-500';
    default:         return 'text-gray-400';
  }
};

/** Derives a thermal label from an NVIDIA GPU temp when macOS thermal_state is unavailable. */
export const derivedNvidiaThermal = (temp: number | null): { label: string; colour: string } | null => {
  if (temp == null) return null;
  if (temp < 70)   return { label: 'Normal',   colour: 'text-green-400' };
  if (temp < 83)   return { label: 'Fair',     colour: 'text-yellow-400' };
  if (temp < 90)   return { label: 'Serious',  colour: 'text-orange-400' };
  return               { label: 'Critical', colour: 'text-red-500' };
};

// ── Kept for collapsed row summaries in Overview and NodesList ─────────────────
export const SentinelCard: React.FC<{
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  accent: string;
}> = ({ label, value, sub, icon: Icon, accent }) => (
  <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4 flex items-center gap-3 min-w-0">
    <div className={`shrink-0 flex items-center justify-center w-8 h-8 rounded-lg ${accent}/10`}>
      <Icon size={16} className={accent.replace('bg-', 'text-')} />
    </div>
    <div className="min-w-0">
      <p className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wider font-medium truncate">{label}</p>
      <p className="text-base font-bold text-gray-900 dark:text-white leading-tight truncate">{value}</p>
      {sub && <p className="text-[10px] text-gray-400 dark:text-gray-500 truncate">{sub}</p>}
    </div>
  </div>
);

// ── Internal: borderless vital stat for the top rail ──────────────────────────
// title prop surfaces footnotes as a tooltip on the label (avoids per-card repetition)
const VitalStat: React.FC<{ label: string; value: string; valueCls?: string; title?: string }> = ({ label, value, valueCls, title }) => (
  <div className="min-w-0">
    <p className="text-[9px] text-gray-400 dark:text-gray-500 uppercase tracking-widest font-semibold leading-none mb-1" title={title}>{label}</p>
    <p className={`text-lg font-bold font-telin leading-none ${valueCls ?? 'text-gray-900 dark:text-white'}`}>{value}</p>
  </div>
);

// ── Internal: compact tile for hardware cluster columns ────────────────────────
const HudTile: React.FC<{ label: string; value: string; sub?: string; dim?: boolean }> = ({ label, value, sub, dim = false }) => (
  <div className="border border-gray-100 dark:border-gray-800 rounded-lg px-3 py-2.5 bg-gray-100 dark:bg-gray-800 min-h-[52px] flex flex-col justify-center">
    <p className="text-[9px] text-gray-400 dark:text-gray-500 uppercase tracking-widest font-semibold leading-none mb-1">{label}</p>
    <p className={`text-sm font-bold font-telin leading-tight ${dim ? 'text-gray-400 dark:text-gray-600' : 'text-gray-900 dark:text-gray-100'}`}>{value}</p>
    {sub && <p className="text-[9px] text-gray-400 dark:text-gray-500 font-telin mt-0.5 leading-tight">{sub}</p>}
  </div>
);

// ── Column header label ────────────────────────────────────────────────────────
const ClusterLabel: React.FC<{ label: string }> = ({ label }) => (
  <p className="text-[9px] text-gray-400 dark:text-gray-500 uppercase tracking-widest font-semibold mb-2">{label}</p>
);

export const HardwareDetailPanel: React.FC<{
  metrics: SentinelMetrics;
  /** Effective PUE for this node (from settings). Used in WES display only. */
  pue?: number;
}> = ({ metrics: m, pue = 1.0 }) => {
  const nvThermal    = m.thermal_state == null ? derivedNvidiaThermal(m.nvidia_gpu_temp_c ?? null) : null;
  const thermalLabel = m.thermal_state ?? nvThermal?.label ?? null;
  const thermalClass = m.thermal_state != null ? thermalColour(m.thermal_state) : (nvThermal?.colour ?? 'text-gray-400');
  const thermalTitle = nvThermal != null ? 'GPU Thermal' : 'Thermal';

  const cpuPct    = `${m.cpu_usage_percent.toFixed(1)}%`;
  const memUsed   = `${(m.used_memory_mb / 1024).toFixed(1)} GB`;
  const memTotal  = m.total_memory_mb ? `of ${(m.total_memory_mb / 1024).toFixed(0)} GB` : undefined;
  const memAvail  = `${(m.available_memory_mb / 1024).toFixed(1)} GB`;
  const coreCount = `${m.cpu_core_count} cores`;

  const cpuPowerStr   = m.cpu_power_w != null ? `${m.cpu_power_w.toFixed(1)} W` : null;
  const gpuUtilStr    = m.gpu_utilization_percent != null ? `${m.gpu_utilization_percent.toFixed(0)}%` : null;
  const memPressStr   = m.memory_pressure_percent != null ? `${m.memory_pressure_percent.toFixed(0)}%` : null;
  const nvidiaGpuStr  = m.nvidia_gpu_utilization_percent != null ? `${m.nvidia_gpu_utilization_percent.toFixed(0)}%` : null;
  const chip          = (m.chip_name ?? m.gpu_name ?? '').toLowerCase();
  const isAppleSilicon = chip.includes('apple') || /\bm[1-4]\b/.test(chip) || m.memory_pressure_percent != null;

  const nvidiaVramStr = m.nvidia_vram_used_mb != null && (m.nvidia_vram_total_mb ?? 0) >= INFERENCE_VRAM_THRESHOLD_MB
    ? `${(m.nvidia_vram_used_mb / 1024).toFixed(1)} GB` : null;
  const nvidiaVramTotal = m.nvidia_vram_total_mb != null ? `of ${(m.nvidia_vram_total_mb / 1024).toFixed(0)} GB` : null;
  const nvidiaTempStr   = m.nvidia_gpu_temp_c   != null ? `${m.nvidia_gpu_temp_c}°C` : null;
  const nvidiaPowerStr  = m.nvidia_power_draw_w != null ? `${m.nvidia_power_draw_w.toFixed(1)} W` : null;

  const effectiveGpuStr = nvidiaGpuStr ?? gpuUtilStr;

  const memUtilStr    = m.total_memory_mb > 0 ? `${Math.round((m.used_memory_mb / m.total_memory_mb) * 100)}%` : null;
  const effectiveMemStr   = memPressStr ?? memUtilStr;
  const effectiveMemLabel = memPressStr != null ? 'Mem Pressure' : 'Mem Util';

  // Ollama wattage + WES
  const ollamaTps   = m.ollama_tokens_per_second;
  const totalPowerW = getNodePowerW(m) ?? 0;
  const hasPower    = hasPowerData(m);
  const wPer1kStr   = ollamaTps != null && ollamaTps > 0 && hasPower
    ? `${((totalPowerW / ollamaTps) * 1000).toFixed(0)} W/1k` : null;
  const wattsStr    = hasPower ? `${totalPowerW.toFixed(1)} W` : null;

  // WES computation — uses per-node PUE
  const wes          = computeWES(ollamaTps, hasPower ? totalPowerW : null, m.thermal_state, pue);
  const wesFormatted = formatWES(wes);
  const wesColor     = wesColorClass(wes);

  const thermalPenaltyValue = m.thermal_state != null
    ? (THERMAL_PENALTY[m.thermal_state.toLowerCase()] ?? 1.0)
    : 1.0;
  const showThermalPenalty = thermalPenaltyValue !== 1.0;
  const showThermalWarning = m.thermal_state != null &&
    ['fair', 'serious', 'critical'].includes(m.thermal_state.toLowerCase());
  // Asterisk case: thermal completely unknown (Linux pre-3B), but WES is otherwise computable
  const thermalDataMissing = m.thermal_state == null && nvThermal == null;
  const showAsterisk       = thermalDataMissing && wes != null;

  const wesLabelTooltip = pue > 1.0
    ? `${WES_TOOLTIP} PUE ${pue.toFixed(1)} applied for this node's location.`
    : WES_TOOLTIP;
  const thermalWarningTooltip = m.thermal_state
    ? `Thermal penalty applied: ${thermalPenaltyValue}× (${m.thermal_state}). WES is reduced because this node is thermally throttling.`
    : '';
  const asteriskTooltip = '* Thermal penalty not applied — thermal state not yet available on this platform (coming Phase 3B)';

  const wesNullTooltip = (() => {
    if (ollamaTps == null || ollamaTps <= 0)
      return 'WES unavailable — Ollama not running or not yet probed';
    if (!hasPower) {
      const chip = (m.chip_name ?? '').toLowerCase();
      const isApple = chip.includes('apple') || /\bm[1-4]\b/.test(chip);
      if (isApple) return 'WES unavailable — CPU power requires sudo. Run: sudo wicklee';
      return 'WES unavailable — GPU power not detected';
    }
    return 'WES unavailable';
  })();

  return (
    <div className="space-y-3">

      {/* ── Inference Band ─────────────────────────────────────────────────── */}
      {m.ollama_running ? (
        <div className="border border-gray-100 dark:border-gray-800 rounded-xl overflow-hidden">

          {/* Model identity row — WES badge inline on right */}
          <div className="flex items-center gap-3 px-4 pt-3 pb-2.5 border-b border-gray-100 dark:border-gray-800 flex-wrap">
            <BotMessageSquare size={11} className="text-indigo-400 shrink-0" />
            <span className="text-xs font-semibold text-indigo-400 uppercase tracking-widest leading-none">Ollama</span>
            {m.ollama_active_model ? (
              <>
                <span className="text-xs text-gray-400 dark:text-gray-600 select-none">·</span>
                <p className="text-xs font-telin text-gray-700 dark:text-gray-300 truncate leading-tight">{m.ollama_active_model}</p>
                <div className="flex items-center gap-1.5 flex-wrap ml-auto shrink-0">
                  <span
                    className={`text-xs font-semibold font-telin px-2 py-0.5 rounded cursor-default ${wesColor}`}
                    title={wes == null ? wesNullTooltip : wesLabelTooltip}
                  >
                    WES {wesFormatted}{showAsterisk ? '*' : ''}
                    {showThermalWarning && <AlertTriangle size={8} className="inline ml-0.5 text-amber-400" title={thermalWarningTooltip} />}
                  </span>
                  {m.ollama_quantization && (
                    <>
                      <span className="text-xs text-gray-600 dark:text-gray-500 select-none">·</span>
                      <span className="text-xs font-telin text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded">
                        {m.ollama_quantization}
                      </span>
                    </>
                  )}
                  {m.ollama_model_size_gb != null && (
                    <>
                      <span className="text-xs text-gray-600 dark:text-gray-500 select-none">·</span>
                      <span className="text-xs font-telin text-gray-500">{m.ollama_model_size_gb.toFixed(1)} GB</span>
                    </>
                  )}
                </div>
              </>
            ) : (
              <div className="flex items-center gap-1.5 ml-auto shrink-0">
                <span
                  className={`text-xs font-semibold font-telin px-2 py-0.5 rounded cursor-default ${wesColor}`}
                  title={wesNullTooltip}
                >
                  WES {wesFormatted}
                </span>
                <span className="text-xs text-gray-400 dark:text-gray-600 select-none">·</span>
                <p className="text-xs font-telin text-gray-500">no model loaded</p>
              </div>
            )}
          </div>

          {/* Inputs row — primary metric display: tok/s · Watts · Thermal */}
          <div className="px-4 py-3 grid grid-cols-3 gap-4">
            <div>
              <p className="text-[9px] text-gray-400 dark:text-gray-500 uppercase tracking-widest font-semibold mb-1">tok/s</p>
              <p className={`text-sm font-bold font-telin leading-tight ${ollamaTps != null ? 'text-green-400' : 'text-gray-500 dark:text-gray-600'}`}>
                {ollamaTps != null ? ollamaTps.toFixed(1) : '—'}
              </p>
            </div>
            <div>
              <p className="text-[9px] text-gray-400 dark:text-gray-500 uppercase tracking-widest font-semibold mb-1">Watts</p>
              <p className={`text-sm font-bold font-telin leading-tight ${wattsStr ? 'text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-600'}`}>
                {wattsStr ?? '—'}
              </p>
              {wPer1kStr && (
                <p className="text-[9px] text-gray-500 font-telin leading-none mt-0.5">{wPer1kStr}</p>
              )}
            </div>
            <div>
              <p className="text-[9px] text-gray-400 dark:text-gray-500 uppercase tracking-widest font-semibold mb-1">Thermal</p>
              <p className={`text-sm font-bold leading-tight ${thermalClass}`}>{thermalLabel ?? '—'}</p>
              {showThermalPenalty && (
                <p className="text-[9px] text-gray-500 font-telin leading-none mt-0.5">({thermalPenaltyValue}×)</p>
              )}
              {showAsterisk && (
                <p className="text-[9px] text-gray-500 leading-none mt-0.5" title={asteriskTooltip}>pending*</p>
              )}
            </div>
          </div>

        </div>
      ) : (
        /* ── Idle inference band — intentional empty state, same position as active ── */
        <div className="border border-dashed border-gray-200 dark:border-gray-700/60 rounded-xl px-4 min-h-[68px] flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <BotMessageSquare size={12} className="text-gray-500 shrink-0" />
            <p className="text-[11px] text-gray-500">No inference runtime detected</p>
          </div>
          <a
            href="https://ollama.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-[10px] font-semibold text-gray-500 hover:text-indigo-400 border border-gray-300 dark:border-gray-700 hover:border-indigo-500/50 rounded-lg px-2.5 py-1 transition-colors"
          >
            ollama.ai ↗
          </a>
        </div>
      )}

      {/* ── Live metric clusters ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-6">

        {/* COMPUTE — live power + static core count */}
        <div>
          <ClusterLabel label="Compute" />
          <div className="space-y-2">
            <HudTile
              label="CPU Power"
              value={cpuPowerStr ?? '—'}
              sub={
                cpuPowerStr && m.ecpu_power_w != null && m.pcpu_power_w != null
                  ? `E ${m.ecpu_power_w.toFixed(1)}W · P ${m.pcpu_power_w.toFixed(1)}W`
                  : !cpuPowerStr ? 'requires elevated permissions' : undefined
              }
              dim={!cpuPowerStr}
            />
            <HudTile label="Core Count" value={coreCount} />
          </div>
        </div>

        {/* MEMORY — live usage */}
        <div>
          <ClusterLabel label="Memory" />
          <div className="space-y-2">
            <HudTile label="Used"      value={memUsed} />
            <HudTile label="Available" value={memAvail} />
            {(memPressStr ?? memUtilStr) && (
              <HudTile
                label={memPressStr ? 'Pressure' : 'Util'}
                value={(memPressStr ?? memUtilStr)!}
              />
            )}
          </div>
        </div>

        {/* GRAPHICS — live metrics */}
        <div>
          <ClusterLabel label="Graphics" />
          <div className="space-y-2">
            <HudTile
              label="GPU Util"
              value={effectiveGpuStr ?? '—'}
              dim={!effectiveGpuStr}
            />
            {nvidiaVramStr
              ? <HudTile label="VRAM Used" value={nvidiaVramStr} sub={nvidiaVramTotal ?? undefined} />
              : isAppleSilicon && <HudTile label="VRAM" value="—" sub="Unified Memory" dim />
            }
            {nvidiaTempStr  && <HudTile label="GPU Temp"    value={nvidiaTempStr} />}
            {nvidiaPowerStr && <HudTile label="Board Power" value={nvidiaPowerStr} />}
          </div>
        </div>

      </div>

    </div>
  );
};
