import React from 'react';
import { Terminal, Wifi, WifiOff, Thermometer } from 'lucide-react';
import { FleetEvent } from '../types';

interface EventFeedProps {
  events: FleetEvent[];
}

const fmtAgo = (ts: number): string => {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

const EventFeed: React.FC<EventFeedProps> = ({ events }) => (
  <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl flex flex-col h-full overflow-hidden shadow-sm dark:shadow-none">
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

    <div className="flex-1 overflow-y-auto p-3 space-y-1">
      {events.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full py-10 text-center">
          <Terminal className="w-8 h-8 text-gray-300 dark:text-gray-700 mb-3" />
          <p className="text-sm text-gray-500 font-medium">No activity yet</p>
          <p className="text-xs text-gray-400 dark:text-gray-600 mt-1">Fleet events will appear here</p>
        </div>
      ) : (
        events.map(ev => {
          const icon = ev.type === 'node_online'
            ? <Wifi       className="w-3.5 h-3.5 text-green-400 shrink-0 mt-0.5" />
            : ev.type === 'node_offline'
            ? <WifiOff    className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
            : <Thermometer className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />;

          const label = ev.type === 'node_online'  ? 'came online'
            : ev.type === 'node_offline' ? 'went offline'
            : (ev.detail?.includes(' → ') ? `thermal: ${ev.detail}` : `thermal became ${ev.detail}`);

          const cls = ev.type === 'node_online'  ? 'text-green-400'
            : ev.type === 'node_offline' ? 'text-red-400'
            : 'text-amber-400';

          return (
            <div key={ev.id} className="flex items-start gap-2.5 px-2 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
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
        })
      )}
    </div>
  </div>
);

export default EventFeed;
