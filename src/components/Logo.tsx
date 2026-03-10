import React from 'react';
import { ConnectionState } from '../types';

interface LogoProps {
  className?: string;
  /** Ambient connection state drives pulse colour, speed, and presence. */
  connectionState?: ConnectionState;
  /** In light mode the wordmark renders black; orb colours are unaffected. */
  theme?: 'light' | 'dark';
}

const STATE_CONFIG: Record<ConnectionState, {
  color: string;
  glowColor: string;
  glowRgba: string;
  duration: string;
  scale: string;
  opacity: string;
  pulse: boolean;
  tooltip?: string;
}> = {
  connected:    { color: 'bg-cyan-400',   glowColor: 'bg-cyan-400/20',   glowRgba: '34,211,238',  duration: '2s', scale: '2.8', opacity: '0.8', pulse: true },
  degraded:     { color: 'bg-amber-400',  glowColor: 'bg-amber-400/20',  glowRgba: '251,191,36',  duration: '4s', scale: '2.5', opacity: '0.7', pulse: true,  tooltip: 'Fleet nodes are stale' },
  idle:         { color: 'bg-cyan-400',   glowColor: 'bg-cyan-400/10',   glowRgba: '34,211,238',  duration: '6s', scale: '2.0', opacity: '0.3', pulse: true },
  disconnected: { color: 'bg-cyan-400',   glowColor: 'bg-cyan-400/10',   glowRgba: '34,211,238',  duration: '2s', scale: '1',   opacity: '0',   pulse: false, tooltip: 'Fleet connection lost' },
};

const Logo: React.FC<LogoProps> = ({ className = "", connectionState = 'disconnected', theme }) => {
  const cfg = STATE_CONFIG[connectionState];
  const active = connectionState !== 'disconnected';
  // Wordmark text colour: black in light mode, white in dark/default.
  // Orb dot and pulse rings are intentionally unaffected by theme.
  const textCls = theme === 'light' ? 'text-black' : 'text-white';

  return (
    <div className={`flex items-center font-bold tracking-tight select-none ${className}`} title={cfg.tooltip}>
      <span className={textCls}>W</span>
      <span className={`relative inline-block ${textCls}`}>
        ı
        <div className="absolute top-[15%] left-1/2 -translate-x-1/2 flex items-center justify-center">
          {/* Core dot */}
          <div
            className={`w-[0.32em] h-[0.32em] ${cfg.color} rounded-full z-10 transition-all duration-500 ${active ? 'scale-110' : ''}`}
            style={{
              boxShadow: active
                ? `0 0 8px 2px rgba(${cfg.glowRgba},0.8), 0 0 15px rgba(${cfg.glowRgba},0.4)`
                : `0 0 4px 1px rgba(${cfg.glowRgba},0.3)`,
            }}
          />

          {/* Pulse rings — present for all states except disconnected */}
          {cfg.pulse && (
            <>
              <div
                className={`absolute w-[0.32em] h-[0.32em] ${cfg.color} rounded-full wk-logo-pulse`}
                style={{ '--wk-pulse-duration': cfg.duration, '--wk-pulse-scale': cfg.scale, '--wk-pulse-opacity': cfg.opacity, animationDelay: '0s' } as React.CSSProperties}
              />
              <div
                className={`absolute w-[0.32em] h-[0.32em] ${cfg.color} rounded-full wk-logo-pulse`}
                style={{ '--wk-pulse-duration': cfg.duration, '--wk-pulse-scale': cfg.scale, '--wk-pulse-opacity': cfg.opacity, animationDelay: `calc(${cfg.duration} * 0.4)` } as React.CSSProperties}
              />
            </>
          )}

          {/* Outer glow */}
          <div
            className={`absolute w-[0.8em] h-[0.8em] ${cfg.glowColor} rounded-full blur-md transition-all duration-500 ${active ? 'opacity-100 scale-150' : 'opacity-30'}`}
          />
        </div>
      </span>
      <span className={textCls}>cklee</span>

      <style>{`
        @keyframes wk-pulse {
          0%   { transform: scale(1); opacity: var(--wk-pulse-opacity, 0.8); }
          100% { transform: scale(var(--wk-pulse-scale, 2.8)); opacity: 0; }
        }
        .wk-logo-pulse {
          animation: wk-pulse var(--wk-pulse-duration, 2s) cubic-bezier(0,0,0.2,1) infinite;
        }
      `}</style>
    </div>
  );
};

export default Logo;
