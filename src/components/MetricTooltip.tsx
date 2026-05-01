import React, { useState, useRef } from 'react';
import { ArrowRight } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

type DotColor = 'blue' | 'emerald' | 'green' | 'amber' | 'yellow' | 'orange' | 'red' | 'gray';

export interface TooltipRange {
  threshold: string;
  color: DotColor;
  label: string;
}

export interface MetricTooltipProps {
  /** Matches the `id` attribute on the MetricCard in MetricsPage, used for deep links. */
  metricId: string;
  /** Short display name shown as the tooltip heading. */
  name: string;
  /** Single-line description shown in the tooltip body. */
  oneLiner: string;
  /** Up to 3 range entries. Any extras are silently ignored. */
  ranges?: TooltipRange[];
  /** Additional class applied to the outer wrapper div (e.g. responsive visibility). */
  wrapperClassName?: string;
  children: React.ReactNode;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const Dot: React.FC<{ color: DotColor }> = ({ color }) => {
  const cls: Record<DotColor, string> = {
    blue:    'bg-blue-500',
    emerald: 'bg-emerald-400',
    green:   'bg-green-300',
    amber:   'bg-amber-400',
    yellow:  'bg-yellow-400',
    orange:  'bg-orange-400',
    red:     'bg-red-500',
    gray:    'bg-gray-500',
  };
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 mt-[3px] ${cls[color]}`}
      aria-hidden="true"
    />
  );
};

// ── Component ─────────────────────────────────────────────────────────────────

const MetricTooltip: React.FC<MetricTooltipProps> = ({
  metricId,
  name,
  oneLiner,
  ranges,
  wrapperClassName = '',
  children,
}) => {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnter = () => {
    // Never show on touch-only devices
    if (!window.matchMedia('(hover: hover)').matches) return;
    timerRef.current = setTimeout(() => setVisible(true), 400);
  };

  const handleMouseLeave = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setVisible(false);
  };

  const trimmedRanges = ranges?.slice(0, 3);

  return (
    <div
      className={`relative ${wrapperClassName}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}

      {visible && (
        <div
          className={[
            'absolute top-full left-0 mt-1.5 z-50',
            'w-60 bg-gray-800 border border-gray-700/50 rounded-xl',
            'shadow-2xl shadow-black/50 p-3',
            'pointer-events-none',
          ].join(' ')}
          role="tooltip"
        >
          {/* Name */}
          <p className="text-xs font-semibold text-gray-100 font-sans leading-snug mb-1">
            {name}
          </p>

          {/* One-liner */}
          <p className="text-[11px] text-gray-400 font-sans leading-snug mb-2.5">
            {oneLiner}
          </p>

          {/* Compact ranges */}
          {trimmedRanges && trimmedRanges.length > 0 && (
            <div className="space-y-1.5 mb-2.5">
              {trimmedRanges.map((r, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <Dot color={r.color} />
                  <span className="font-telin text-[10px] text-gray-300 w-14 shrink-0 leading-tight">
                    {r.threshold}
                  </span>
                  <span className="font-sans text-[10px] text-gray-500 leading-tight">
                    {r.label}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Deep link — re-enable pointer events for the link only */}
          <a
            href={`/metrics#${metricId}`}
            className="pointer-events-auto inline-flex items-center gap-1 text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors"
            onClick={e => e.stopPropagation()}
          >
            Full reference
            <ArrowRight size={9} />
          </a>
        </div>
      )}
    </div>
  );
};

export default MetricTooltip;
