/**
 * thermal.ts — colour + label helpers for thermal state display.
 *
 * Moved here from components/NodeHardwarePanel.tsx when that file was
 * deleted: its two card components (SentinelCard, HardwareDetailPanel) had
 * no importers left, and these two helpers were the only exports still used.
 */

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
