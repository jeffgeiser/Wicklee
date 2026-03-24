import React, { useState } from 'react';
import { Terminal, Wifi, WifiOff, Thermometer, Zap, RefreshCw, AlertCircle, Check, Clock, Flame, Target, Activity } from 'lucide-react';
import { FleetEvent } from '../types';

interface EventFeedProps {
  events: FleetEvent[];
}

const DEFAULT_VISIBLE = 5;

const fmtAgo = (ts: number): string => {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

interface EventMeta {
  icon: React.ReactElement;
  label: string;
  cls: string;
}

function eventMeta(ev: FleetEvent): EventMeta {
  switch (ev.type) {
    case 'node_online':
      return {
        icon: <Wifi className="w-3.5 h-3.5 text-green-400 shrink-0 mt-0.5" />,
        label: 'came online',
        cls: 'text-green-400',
      };
    case 'node_offline':
      return {
        icon: <WifiOff className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />,
        label: 'went offline',
        cls: 'text-red-400',
      };
    case 'thermal_change':
      return {
        icon: <Thermometer className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />,
        label: ev.detail?.includes(' → ')
          ? `thermal: ${ev.detail}`
          : `thermal became ${ev.detail ?? '?'}`,
        cls: 'text-amber-400',
      };
    case 'throttle_start':
      return {
        icon: <Thermometer className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />,
        label: ev.detail ? `throttling: ${ev.detail}` : 'throttling started',
        cls: 'text-red-400',
      };
    case 'throttle_resolved':
      return {
        icon: <Check className="w-3.5 h-3.5 text-green-400 shrink-0 mt-0.5" />,
        label: 'throttle resolved',
        cls: 'text-green-400',
      };
    case 'model_swap':
      return {
        icon: <RefreshCw className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" />,
        label: ev.detail ? `model: ${ev.detail}` : 'model changed',
        cls: 'text-blue-400',
      };
    case 'power_anomaly':
      return {
        icon: <Zap className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />,
        label: ev.detail ? `power: ${ev.detail}` : 'power anomaly',
        cls: 'text-amber-400',
      };
    case 'error':
      return {
        icon: <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />,
        label: ev.detail ?? 'error',
        cls: 'text-red-400',
      };
    case 'model_eviction_predicted':
      return {
        icon: <Clock className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />,
        label: ev.detail ? `eviction: ${ev.detail}` : 'model eviction predicted',
        cls: 'text-amber-400',
      };
    case 'keep_warm_taken':
      return {
        icon: <Flame className="w-3.5 h-3.5 text-green-400 shrink-0 mt-0.5" />,
        label: ev.detail ? `kept warm: ${ev.detail}` : 'keep warm applied',
        cls: 'text-green-400',
      };
    case 'thermal_degradation_confirmed':
      return {
        icon: <Thermometer className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />,
        label: ev.detail ? `thermal: ${ev.detail}` : 'thermal degradation confirmed',
        cls: 'text-red-400',
      };
    case 'fit_score_changed':
      return {
        icon: <Target className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" />,
        label: ev.detail ? `fit: ${ev.detail}` : 'fit score changed',
        cls: 'text-blue-400',
      };
    default:
      return {
        icon: <Activity className="w-3.5 h-3.5 text-gray-400 shrink-0 mt-0.5" />,
        label: ev.detail ?? (ev.type as string),
        cls: 'text-gray-400',
      };
  }
}

const EventFeed: React.FC<EventFeedProps> = ({ events }) => {
  const [expanded, setExpanded] = useState(false);

  const visible = expanded ? events : events.slice(0, DEFAULT_VISIBLE);
  const hiddenCount = events.length - DEFAULT_VISIBLE;

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl flex flex-col h-full overflow-hidden shadow-sm dark:shadow-none">
      {/* Header */}
      <div className="p-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between bg-gray-50/50 dark:bg-gray-800/20">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          <h3 className="font-semibold text-sm text-gray-800 dark:text-gray-200">Live Activity</h3>
        </div>
        {events.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="flex h-2 w-2 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
            </span>
            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Live</span>
          </div>
        )}
      </div>

      {/* Event list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full py-10 text-center">
            <Terminal className="w-8 h-8 text-gray-300 dark:text-gray-700 mb-3" />
            <p className="text-sm text-gray-500 font-medium">No activity yet</p>
            <p className="text-xs text-gray-400 dark:text-gray-600 mt-1">Node events will appear here</p>
          </div>
        ) : (
          <>
            {visible.map(ev => {
              const { icon, label, cls } = eventMeta(ev);
              return (
                <div
                  key={ev.id}
                  className="flex items-start gap-2.5 px-2 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                >
                  {icon}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="font-telin text-xs font-bold text-gray-900 dark:text-gray-200 truncate">
                        {ev.hostname ?? ev.nodeId}
                      </span>
                      <span className={`text-xs font-medium ${cls}`}>{label}</span>
                    </div>
                    <p className="text-[10px] text-gray-400 font-telin mt-0.5">{fmtAgo(ev.ts)}</p>
                  </div>
                </div>
              );
            })}

            {/* Expand / collapse */}
            {!expanded && hiddenCount > 0 && (
              <button
                onClick={() => setExpanded(true)}
                className="w-full text-center text-[11px] text-gray-400 hover:text-gray-300 dark:text-gray-500 dark:hover:text-gray-400 py-1.5 transition-colors"
              >
                + {hiddenCount} more event{hiddenCount !== 1 ? 's' : ''}
              </button>
            )}
            {expanded && hiddenCount > 0 && (
              <button
                onClick={() => setExpanded(false)}
                className="w-full text-center text-[11px] text-gray-400 hover:text-gray-300 dark:text-gray-500 dark:hover:text-gray-400 py-1.5 transition-colors"
              >
                Show less
              </button>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 border-t border-gray-100 dark:border-gray-800 bg-gray-50/30 dark:bg-gray-800/10 shrink-0">
        <p className="text-[10px] text-gray-400 dark:text-gray-600">
          Full event history in Observability →
        </p>
      </div>
    </div>
  );
};

export default EventFeed;
