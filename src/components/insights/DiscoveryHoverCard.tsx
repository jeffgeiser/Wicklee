/**
 * DiscoveryHoverCard — rich hover tooltip matching the site's MetricTooltip
 * pattern but without the per-metric deep link. Used in the Discovery panel
 * to explain projected tok/s, cost-per-M, and column headers in detail.
 *
 * Design follows MetricTooltip.tsx exactly:
 *   - gray-800 background, rounded-xl, shadow-2xl
 *   - 400ms hover delay (matches site)
 *   - touch-device exclusion (no tooltips on phones)
 *   - 240px wide, positioned below trigger
 *
 * Differences from MetricTooltip:
 *   - No required metricId / deep link — tooltips here describe in-place
 *     derivations, not links to a metric reference page
 *   - Generic `rows` shape (label / value / optional color) instead of
 *     fixed threshold-style ranges
 *   - Optional footer for the "set your kWh rate in Settings" CTA when
 *     cost is suppressed
 */
import React, { useState, useRef } from 'react';

export interface DiscoveryHoverRow {
  label: string;
  value: string;
  /** Optional accent — defaults to gray. Use sparingly to highlight one row. */
  accent?: 'cyan' | 'emerald' | 'amber' | 'red' | 'gray';
}

export interface DiscoveryHoverCardProps {
  /** Bold heading shown at the top. */
  heading: string;
  /** One-line description in muted text. Keep under ~110 chars. */
  body: string;
  /** Optional structured rows under the body. */
  rows?: DiscoveryHoverRow[];
  /** Optional footer — small, italic, gray-500. For CTAs like "set your kWh rate". */
  footer?: React.ReactNode;
  /** Trigger element. */
  children: React.ReactNode;
}

const ACCENT_CLASS: Record<NonNullable<DiscoveryHoverRow['accent']>, string> = {
  cyan:    'text-cyan-400',
  emerald: 'text-emerald-400',
  amber:   'text-amber-400',
  red:     'text-red-400',
  gray:    'text-gray-300',
};

const DiscoveryHoverCard: React.FC<DiscoveryHoverCardProps> = ({
  heading, body, rows, footer, children,
}) => {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnter = () => {
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

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {visible && (
        <div
          role="tooltip"
          className={[
            'absolute top-full left-0 mt-1.5 z-50',
            'w-64 bg-gray-800 border border-gray-700/50 rounded-xl',
            'shadow-2xl shadow-black/50 p-3',
            'pointer-events-none',
          ].join(' ')}
        >
          <p className="text-xs font-semibold text-gray-100 font-sans leading-snug mb-1">
            {heading}
          </p>
          <p className="text-[11px] text-gray-400 font-sans leading-snug mb-2.5">
            {body}
          </p>
          {rows && rows.length > 0 && (
            <div className="space-y-1 mb-1">
              {rows.map((r, i) => (
                <div key={i} className="flex items-baseline justify-between gap-2 text-[10px] leading-tight">
                  <span className="text-gray-500 font-sans">{r.label}</span>
                  <span className={`font-mono ${ACCENT_CLASS[r.accent ?? 'gray']} text-right`}>
                    {r.value}
                  </span>
                </div>
              ))}
            </div>
          )}
          {footer && (
            <p className="mt-2 pt-2 border-t border-gray-700/40 text-[10px] text-gray-500 italic leading-snug">
              {footer}
            </p>
          )}
        </div>
      )}
    </span>
  );
};

export default DiscoveryHoverCard;
