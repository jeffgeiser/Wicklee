import React from 'react';
import { Cpu, Database, Zap, Activity, MemoryStick, Wind, Thermometer, BotMessageSquare } from 'lucide-react';
import { SentinelMetrics } from '../types';

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
    <p className={`text-lg font-bold leading-none ${valueCls ?? 'text-gray-900 dark:text-white'}`}>{value}</p>
  </div>
);

// ── Internal: compact tile for hardware cluster columns ────────────────────────
const HudTile: React.FC<{ label: string; value: string; sub?: string; dim?: boolean }> = ({ label, value, sub, dim = false }) => (
  <div className="border border-gray-100 dark:border-gray-800 rounded-lg px-3 py-2.5 bg-gray-100 dark:bg-gray-800 min-h-[52px] flex flex-col justify-center">
    <p className="text-[9px] text-gray-400 dark:text-gray-500 uppercase tracking-widest font-semibold leading-none mb-1">{label}</p>
    <p className={`text-sm font-bold leading-tight ${dim ? 'text-gray-400 dark:text-gray-600' : 'text-gray-900 dark:text-gray-100'}`}>{value}</p>
    {sub && <p className="text-[9px] text-gray-400 dark:text-gray-500 font-mono mt-0.5 leading-tight">{sub}</p>}
  </div>
);

// ── Column header label ────────────────────────────────────────────────────────
const ClusterLabel: React.FC<{ label: string }> = ({ label }) => (
  <p className="text-[9px] text-gray-400 dark:text-gray-500 uppercase tracking-widest font-semibold mb-2">{label}</p>
);

export const HardwareDetailPanel: React.FC<{ metrics: SentinelMetrics }> = ({ metrics: m }) => {
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
  const nvidiaVramStr = m.nvidia_vram_used_mb != null && m.nvidia_vram_total_mb != null
    ? `${(m.nvidia_vram_used_mb / 1024).toFixed(1)} GB` : null;
  const nvidiaVramTotal = m.nvidia_vram_total_mb != null ? `of ${(m.nvidia_vram_total_mb / 1024).toFixed(0)} GB` : null;
  const nvidiaTempStr   = m.nvidia_gpu_temp_c   != null ? `${m.nvidia_gpu_temp_c}°C` : null;
  const nvidiaPowerStr  = m.nvidia_power_draw_w != null ? `${m.nvidia_power_draw_w.toFixed(1)} W` : null;

  const effectiveGpuStr = nvidiaGpuStr ?? gpuUtilStr;

  const memUtilStr    = m.total_memory_mb > 0 ? `${Math.round((m.used_memory_mb / m.total_memory_mb) * 100)}%` : null;
  const effectiveMemStr   = memPressStr ?? memUtilStr;
  const effectiveMemLabel = memPressStr != null ? 'Mem Pressure' : 'Mem Util';

  // Ollama wattage
  const ollamaTps    = m.ollama_tokens_per_second;
  const totalPowerW  = (m.cpu_power_w ?? 0) + (m.nvidia_power_draw_w ?? 0);
  const hasPower     = m.cpu_power_w != null || m.nvidia_power_draw_w != null;
  const wPer1kStr    = ollamaTps != null && ollamaTps > 0 && hasPower
    ? `${((totalPowerW / ollamaTps) * 1000).toFixed(0)} W/1k` : null;

  return (
    <div className="space-y-4">

      {/* ── Vital Rail — borderless primary metrics ───────────────────────── */}
      <div className="flex items-start gap-8 pb-4 border-b border-gray-100 dark:border-gray-800/60 flex-wrap">
        <VitalStat label="CPU"          value={cpuPct} />
        <VitalStat label="GPU"          value={effectiveGpuStr ?? '—'} />
        <VitalStat
          label={effectiveMemLabel}
          value={effectiveMemStr ?? '—'}
          title={memPressStr == null && memUtilStr != null ? 'Approximate utilization ratio (used ÷ total RAM) — not true memory pressure' : undefined}
        />
        <VitalStat label={thermalTitle} value={thermalLabel ?? '—'} valueCls={thermalClass} />
        <VitalStat label="Cores"        value={`${m.cpu_core_count}`} />
      </div>

      {/* ── Inference Band — sits above hardware grid, aligned to column gutter ── */}
      {m.ollama_running ? (
        <div className="grid grid-cols-3 gap-6 border border-gray-100 dark:border-gray-800 rounded-xl px-4 py-3 items-start">

          {/* Col 1 — model identity (secondary labels) */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <BotMessageSquare size={11} className="text-indigo-400 shrink-0" />
              <span className="text-[9px] font-semibold text-indigo-400 uppercase tracking-widest leading-none">Ollama</span>
            </div>
            {m.ollama_active_model ? (
              <>
                <p className="text-xs font-mono text-gray-500 dark:text-gray-400 truncate leading-tight">{m.ollama_active_model}</p>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {m.ollama_quantization && (
                    <span className="text-[9px] font-mono text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded">
                      {m.ollama_quantization}
                    </span>
                  )}
                  {m.ollama_model_size_gb != null && (
                    <span className="text-[10px] text-gray-500">{m.ollama_model_size_gb.toFixed(1)} GB</span>
                  )}
                </div>
              </>
            ) : (
              <p className="text-xs text-gray-500">no model loaded</p>
            )}
          </div>

          {/* Col 2 — Throughput (large, aligns with MEMORY column below) */}
          <div>
            <p className="text-[9px] text-gray-400 dark:text-gray-500 uppercase tracking-widest font-semibold leading-none mb-1.5">Throughput</p>
            <p className={`text-2xl font-bold leading-none ${ollamaTps != null ? 'text-green-400' : 'text-gray-500 dark:text-gray-600'}`}>
              {ollamaTps != null ? ollamaTps.toFixed(1) : '—'}
              <span className="text-sm font-normal text-gray-500 ml-1.5">tok/s</span>
            </p>
          </div>

          {/* Col 3 — Efficiency (large, aligns with GRAPHICS column below) */}
          <div>
            <p className="text-[9px] text-gray-400 dark:text-gray-500 uppercase tracking-widest font-semibold leading-none mb-1.5">Efficiency</p>
            <p className={`text-2xl font-bold leading-none ${wPer1kStr ? 'text-amber-400' : 'text-gray-500 dark:text-gray-600'}`}>
              {wPer1kStr ? wPer1kStr.replace(' W/1k', '') : '—'}
              <span className="text-sm font-normal text-gray-500 ml-1.5">W/1k</span>
            </p>
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

      {/* ── Hardware Clusters ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-6">

        {/* COMPUTE */}
        <div>
          <ClusterLabel label="Compute" />
          <div className="space-y-2">
            <HudTile label="CPU Cores" value={coreCount} />
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
          </div>
        </div>

        {/* MEMORY */}
        <div>
          <ClusterLabel label="Memory" />
          <div className="space-y-2">
            <HudTile label="Used"      value={memUsed}  sub={memTotal} />
            <HudTile label="Available" value={memAvail} />
            {(memPressStr ?? memUtilStr) && (
              <HudTile
                label={memPressStr ? 'Pressure' : 'Util'}
                value={(memPressStr ?? memUtilStr)!}
              />
            )}
          </div>
        </div>

        {/* GRAPHICS */}
        <div>
          <ClusterLabel label="Graphics" />
          <div className="space-y-2">
            <HudTile
              label="GPU Util"
              value={effectiveGpuStr ?? '—'}
              dim={!effectiveGpuStr}
            />
            {nvidiaVramStr && (
              <HudTile label="VRAM" value={nvidiaVramStr} sub={nvidiaVramTotal ?? undefined} />
            )}
            {nvidiaTempStr  && <HudTile label="GPU Temp"    value={nvidiaTempStr} />}
            {nvidiaPowerStr && <HudTile label="Board Power" value={nvidiaPowerStr} />}
          </div>
        </div>

      </div>


    </div>
  );
};
