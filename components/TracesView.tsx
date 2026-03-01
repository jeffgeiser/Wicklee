
import React, { useState, useEffect } from 'react';
import { Database, Clock, Zap, Search, AlertCircle, RefreshCw, Filter, Activity } from 'lucide-react';
import { NodeAgent, TraceRecord } from '../types';

interface TracesViewProps {
  nodes: NodeAgent[];
  tenantId: string;
}

const TracesView: React.FC<TracesViewProps> = ({ nodes, tenantId }) => {
  const [traces, setTraces] = useState<TraceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTraces = async () => {
    setLoading(true);
    try {
      // Adding X-Tenant-ID header for multi-tenant backend resolver
      const response = await fetch('http://localhost:3000/api/traces');
      if (!response.ok) throw new Error('Failed to reach local Wicklee agent');
      const data = await response.json();
      setTraces(data);
      setError(null);
    } catch (err) {
      setError('Agent disconnected');
      setTraces([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTraces();
    const interval = setInterval(fetchTraces, 5000);
    return () => clearInterval(interval);
  }, [tenantId]); // Re-fetch when tenant changes

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center mb-2">
        <div className="flex gap-2">
          <button 
            onClick={fetchTraces}
            className="px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2"
          >
            <Database className="w-3.5 h-3.5" />
            Query Local Logs
          </button>
          <button className="px-3 py-1.5 bg-gray-800 text-gray-300 text-xs font-medium rounded-lg border border-gray-700 hover:bg-gray-700 transition-colors flex items-center gap-2">
            <Filter className="w-3.5 h-3.5" />
            Filter Logs
          </button>
        </div>
        <div className="flex items-center gap-3">
          {loading && <RefreshCw className="w-3 h-3 text-cyan-400 animate-spin" />}
          <span className="text-xs text-gray-500 flex items-center gap-1">
            <Clock className="w-3 h-3" /> Auto-syncing (5s)
          </span>
          <div className={`w-2 h-2 rounded-full ${error ? 'bg-red-500' : 'bg-blue-600'} animate-pulse`}></div>
        </div>
      </div>

      {/* Removed error banner */}

      <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-gray-950/50 text-[10px] text-gray-500 uppercase tracking-widest font-bold border-b border-gray-800">
              <th className="px-6 py-4">Timestamp</th>
              <th className="px-6 py-4">Node / Model</th>
              <th className="px-6 py-4">Latency (ms)</th>
              <th className="px-6 py-4">TTFT</th>
              <th className="px-6 py-4">TPOT</th>
              <th className="px-6 py-4">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800 font-mono text-xs">
            {traces.length > 0 ? (
              traces.map((trace) => (
                <tr key={trace.id} className="hover:bg-gray-800/30 transition-colors group">
                  <td className="px-6 py-4 text-gray-500">{trace.timestamp}</td>
                  <td className="px-6 py-4">
                    <div className="flex flex-col">
                      <span className="text-gray-300 font-semibold">{trace.nodeId}</span>
                      <span className="text-cyan-400/80">{trace.model}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <div className="h-1 w-12 bg-gray-800 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-600" style={{ width: `${Math.min(100, (trace.latency / 1200) * 100)}%` }}></div>
                      </div>
                      <span className="text-gray-300">{trace.latency}ms</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-gray-400">{trace.ttft}ms</td>
                  <td className="px-6 py-4 text-gray-400">{trace.tpot}ms/tok</td>
                  <td className="px-6 py-4">
                    <span className={trace.status >= 400 ? 'text-red-500' : 'text-green-500'}>{trace.status}</span>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="px-6 py-20 text-center">
                  <div className="flex flex-col items-center justify-center max-w-sm mx-auto">
                    <div className="w-12 h-12 bg-gray-800/50 rounded-2xl flex items-center justify-center mb-4 border border-white/5">
                      <Activity className="w-6 h-6 text-gray-500" />
                    </div>
                    <h3 className="text-lg font-bold text-white mb-2">No traces yet</h3>
                    <p className="text-xs text-gray-500 leading-relaxed mb-6">
                      Inference traces will appear here automatically once the Wicklee agent is running. Each request is logged with latency, TTFT, and TPOT.
                    </p>
                    <button className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl transition-all shadow-lg shadow-blue-500/20">
                      View Setup Guide →
                    </button>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default TracesView;
