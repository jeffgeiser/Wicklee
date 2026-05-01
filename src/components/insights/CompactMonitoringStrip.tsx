/**
 * CompactMonitoringStrip — 4-across health grid replacing stacked AlertDormantRow.
 *
 * Shows Thermal, Power, Memory, Thermal Cost as compact cells with colored dots.
 * Green dot = nominal/monitoring. Cell hidden when its latch is active (full alert card shown instead).
 */

import React from 'react';

interface MonitoringItem {
  key:     string;
  icon:    React.ReactNode;
  label:   string;
  reading: string | null;
}

interface CompactMonitoringStripProps {
  items: MonitoringItem[];
}

const CompactMonitoringStrip: React.FC<CompactMonitoringStripProps> = ({ items }) => {
  if (items.length === 0) return null;

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-2xl px-3 py-2.5">
      <div className="grid grid-cols-4 gap-2">
        {items.map(item => (
          <div key={item.key} className="flex items-center gap-2 min-w-0">
            <span className="relative flex h-1.5 w-1.5 shrink-0">
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500/80" />
            </span>
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-gray-600 shrink-0">{item.icon}</span>
              <span className="text-[9px] font-semibold uppercase tracking-wider text-gray-600 truncate">
                {item.label}
              </span>
            </div>
            {item.reading && (
              <span className="text-[9px] font-mono text-gray-500 shrink-0 ml-auto">
                {item.reading}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default CompactMonitoringStrip;
