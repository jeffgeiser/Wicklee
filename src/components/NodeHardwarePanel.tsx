import React from 'react';
import { Cpu, Database, Zap, Activity, MemoryStick, Wind, Thermometer } from 'lucide-react';
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

export const HardwareDetailPanel: React.FC<{ metrics: SentinelMetrics }> = ({ metrics: m }) => {
  // Thermal: use macOS thermal_state if available; fall back to NVIDIA-derived label
  const nvThermal   = m.thermal_state == null ? derivedNvidiaThermal(m.nvidia_gpu_temp_c ?? null) : null;
  const thermalLabel = m.thermal_state ?? nvThermal?.label ?? null;
  const thermalClass = m.thermal_state != null ? thermalColour(m.thermal_state) : (nvThermal?.colour ?? 'text-gray-400');
  const thermalTitle = nvThermal != null ? 'GPU Thermal' : 'Thermal State';

  const cpuPct    = `${m.cpu_usage_percent.toFixed(1)}%`;
  const memUsed   = `${(m.used_memory_mb / 1024).toFixed(1)} GB`;
  const memTotal  = m.total_memory_mb ? `of ${(m.total_memory_mb / 1024).toFixed(0)} GB` : undefined;
  const memAvail  = `${(m.available_memory_mb / 1024).toFixed(1)} GB`;
  const coreCount = `${m.cpu_core_count} cores`;

  const cpuPowerStr      = m.cpu_power_w    != null ? `${m.cpu_power_w.toFixed(1)} W` : null;
  const gpuUtilStr       = m.gpu_utilization_percent != null ? `${m.gpu_utilization_percent.toFixed(0)}%` : null;
  const memPressStr      = m.memory_pressure_percent != null ? `${m.memory_pressure_percent.toFixed(0)}%` : null;
  const nvidiaGpuStr     = m.nvidia_gpu_utilization_percent != null ? `${m.nvidia_gpu_utilization_percent.toFixed(0)}%` : null;
  const nvidiaVramStr    = m.nvidia_vram_used_mb != null && m.nvidia_vram_total_mb != null
    ? `${(m.nvidia_vram_used_mb / 1024).toFixed(1)} GB` : null;
  const nvidiaVramTotal  = m.nvidia_vram_total_mb != null ? `${(m.nvidia_vram_total_mb / 1024).toFixed(0)} GB` : null;
  const nvidiaTempStr    = m.nvidia_gpu_temp_c   != null ? `${m.nvidia_gpu_temp_c}°C` : null;
  const nvidiaPowerStr   = m.nvidia_power_draw_w != null ? `${m.nvidia_power_draw_w.toFixed(1)} W` : null;

  // GPU util: prefer NVIDIA (discrete GPU), fall back to Apple AGX
  const effectiveGpuStr = nvidiaGpuStr ?? gpuUtilStr;

  // Mem pressure (macOS) or memory utilisation fallback for Linux/Windows.
  // Fallback shows X%* so the user knows it's utilisation, not pressure.
  const memUtilStr = m.total_memory_mb > 0
    ? `${Math.round((m.used_memory_mb / m.total_memory_mb) * 100)}%*`
    : null;
  const effectiveMemStr   = memPressStr ?? memUtilStr;
  const effectiveMemLabel = memPressStr != null ? 'Mem Pressure' : 'Mem Util*';

  return (
    <div className="space-y-3">
      {/* Core metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <SentinelCard label="CPU Usage"     value={cpuPct}    icon={Cpu}         accent="bg-indigo-500" />
        <SentinelCard label="Memory Used"   value={memUsed}   sub={memTotal}     icon={MemoryStick}    accent="bg-blue-500" />
        <SentinelCard label="Mem Available" value={memAvail}  icon={Database}    accent="bg-sky-500" />
        <SentinelCard label="CPU Cores"     value={coreCount} icon={Cpu}         accent="bg-violet-500" />
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4 flex items-center gap-3 min-w-0">
          <div className="shrink-0 flex items-center justify-center w-8 h-8 rounded-lg bg-orange-500/10">
            <Thermometer size={16} className="text-orange-400" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wider font-medium">{thermalTitle}</p>
            <p className={`text-base font-bold leading-tight ${thermalClass}`}>
              {thermalLabel ?? '—'}
            </p>
            {nvThermal && m.nvidia_gpu_temp_c != null && (
              <p className="text-[10px] text-gray-400 font-mono">{m.nvidia_gpu_temp_c}°C</p>
            )}
          </div>
        </div>
      </div>

      {/* Platform metrics — always rendered; null values show — */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {/* CPU Power — always shown; null means no elevated perms */}
        {cpuPowerStr ? (
          <SentinelCard
            label="CPU Power" value={cpuPowerStr}
            sub={m.ecpu_power_w != null && m.pcpu_power_w != null
              ? `E ${m.ecpu_power_w.toFixed(1)}W  P ${m.pcpu_power_w.toFixed(1)}W`
              : undefined}
            icon={Zap} accent="bg-amber-500"
          />
        ) : (
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4 flex items-center gap-3 min-w-0">
            <div className="shrink-0 flex items-center justify-center w-8 h-8 rounded-lg bg-amber-500/10">
              <Zap size={16} className="text-amber-500 opacity-40" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wider font-medium">CPU Power</p>
              <p className="text-[11px] font-semibold text-gray-400 leading-tight">—</p>
              <p className="text-[9px] text-gray-500 font-mono leading-tight mt-0.5">requires elevated permissions</p>
            </div>
          </div>
        )}

        {/* GPU Utilization — NVIDIA takes priority over Apple AGX; — if neither */}
        <SentinelCard
          label="GPU Utilization"
          value={effectiveGpuStr ?? '—'}
          icon={Activity}
          accent="bg-purple-500"
        />

        {/* Mem Pressure (macOS) or Mem Util fallback (Linux/Windows) */}
        <SentinelCard
          label={effectiveMemLabel}
          value={effectiveMemStr ?? '—'}
          icon={Wind}
          accent={memPressStr != null ? 'bg-rose-500' : 'bg-sky-500'}
        />

        {/* NVIDIA extras — only rendered when data is present */}
        {nvidiaVramStr && (
          <SentinelCard label="VRAM Used" value={nvidiaVramStr}
            sub={nvidiaVramTotal ? `of ${nvidiaVramTotal}` : undefined}
            icon={Database} accent="bg-emerald-500"
          />
        )}
        {nvidiaTempStr  && <SentinelCard label="GPU Temp"    value={nvidiaTempStr}  icon={Thermometer} accent="bg-orange-500" />}
        {nvidiaPowerStr && <SentinelCard label="Board Power" value={nvidiaPowerStr} icon={Zap}         accent="bg-yellow-500" />}
      </div>
    </div>
  );
};
