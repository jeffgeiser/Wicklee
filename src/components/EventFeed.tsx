import React, { useState, useEffect } from 'react';
import { Terminal, Zap, ShieldAlert, Activity } from 'lucide-react';
import { NodeAgent } from '../types';

interface EventEntry {
  id: string;
  timestamp: string;
  type: 'node' | 'sentinel';
  nodeName?: string;
  model?: string;
  rps?: number;
  temp?: number;
  status?: 'healthy' | 'warm' | 'critical';
  message?: string;
}

interface EventFeedProps {
  nodes: NodeAgent[];
}

const EventFeed: React.FC<EventFeedProps> = ({ nodes }) => {
  const [events, setEvents] = useState<EventEntry[]>([]);

  useEffect(() => {
    // Initial events
    const initialEvents: EventEntry[] = [
      {
        id: '1',
        timestamp: new Date(Date.now() - 1000 * 60 * 5).toLocaleTimeString(),
        type: 'sentinel',
        message: '⚡ Sentinel: rerouted traffic from Node-3 (89°C) → Node-1 (67°C)'
      },
      {
        id: '2',
        timestamp: new Date(Date.now() - 1000 * 60 * 10).toLocaleTimeString(),
        type: 'node',
        nodeName: 'Node-1',
        model: 'Llama-3-70B',
        rps: 4.2,
        temp: 67,
        status: 'healthy'
      },
      {
        id: '3',
        timestamp: new Date(Date.now() - 1000 * 60 * 15).toLocaleTimeString(),
        type: 'node',
        nodeName: 'Node-3',
        model: 'Mistral-Large',
        rps: 0.0,
        temp: 89,
        status: 'critical'
      }
    ];
    setEvents(initialEvents);

    // Simulate live updates
    const interval = setInterval(() => {
      const randomNode = nodes[Math.floor(Math.random() * nodes.length)];
      const temp = Math.floor(Math.random() * 30) + 60;
      const status = temp > 85 ? 'critical' : temp > 75 ? 'warm' : 'healthy';
      
      const newEvent: EventEntry = {
        id: Math.random().toString(36).substr(2, 9),
        timestamp: new Date().toLocaleTimeString(),
        type: 'node',
        nodeName: randomNode.hostname,
        model: 'Llama-3-8B',
        rps: parseFloat((Math.random() * 5 + 1).toFixed(1)),
        temp: temp,
        status: status
      };

      setEvents(prev => [newEvent, ...prev].slice(0, 50));
    }, 5000);

    return () => clearInterval(interval);
  }, [nodes]);

  const getStatusColor = (status?: string) => {
    switch (status) {
      case 'critical': return 'text-red-500';
      case 'warm': return 'text-amber-500';
      case 'healthy': return 'text-green-500';
      default: return 'text-gray-400';
    }
  };

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl flex flex-col h-full overflow-hidden shadow-sm dark:shadow-none">
      <div className="p-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between bg-gray-50/50 dark:bg-gray-800/20">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          <h3 className="font-semibold text-sm text-gray-800 dark:text-gray-200">Live Activity</h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex h-2 w-2 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
          </span>
          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Streaming</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto font-mono text-[11px] p-2 space-y-1 scrollbar-thin scrollbar-thumb-gray-200 dark:scrollbar-thumb-gray-800">
        {events.map((event) => (
          <div key={event.id} className="py-1 px-2 rounded hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors border-b border-gray-50 dark:border-gray-800/30 last:border-0">
            <span className="text-gray-400 mr-2">[{event.timestamp}]</span>
            {event.type === 'sentinel' ? (
              <span className="text-blue-500 font-bold">{event.message}</span>
            ) : (
              <div className="inline-flex flex-wrap gap-x-3 items-center">
                <span className="text-gray-300 dark:text-gray-600">NODE:</span>
                <span className="text-gray-900 dark:text-gray-200 font-bold">{event.nodeName}</span>
                <span className="text-gray-300 dark:text-gray-600">MODEL:</span>
                <span className="text-blue-600 dark:text-blue-400">{event.model}</span>
                <span className="text-gray-300 dark:text-gray-600">RPS:</span>
                <span className="text-gray-900 dark:text-gray-200">{event.rps}</span>
                <span className="text-gray-300 dark:text-gray-600">TEMP:</span>
                <span className={`${getStatusColor(event.status)} font-bold`}>{event.temp}°C</span>
                <span className="text-gray-300 dark:text-gray-600">STATUS:</span>
                <span className={`${getStatusColor(event.status)} uppercase font-bold`}>{event.status}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default EventFeed;
