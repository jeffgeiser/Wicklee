import React, { useState } from 'react';
import { MoreVertical, Shield, Power, Activity, AlertTriangle, ArrowRight, Server } from 'lucide-react';
import { NodeAgent } from '../types';

interface NodesListProps {
  nodes: NodeAgent[];
  isPro?: boolean;
  onUpgradeClick?: () => void;
  onToggleSentinel?: (nodeId: string) => void;
}

const NodesList: React.FC<NodesListProps> = ({ nodes, isPro, onUpgradeClick, onToggleSentinel }) => {
  const [redlines, setRedlines] = useState<Record<string, number>>(
    Object.fromEntries(nodes.map(n => [n.id, 85]))
  );

  const handleRedlineChange = (id: string, val: string) => {
    const num = parseInt(val);
    if (!isNaN(num)) {
      setRedlines(prev => ({ ...prev, [id]: num }));
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4">
        {nodes.map((node) => {
          const redline = redlines[node.id] || 85;
          const isOverRedline = node.gpuTemp != null && node.gpuTemp >= redline;
          const isRerouting = isOverRedline && node.sentinelActive;

          return (
            <div 
              key={node.id} 
              className={`bg-[#030712]/80 backdrop-blur-xl border rounded-[24px] p-6 transition-all duration-500 relative overflow-hidden ${
                node.sentinelActive ? 'border-blue-500/30 shadow-[0_0_25px_rgba(59,130,246,0.15)]' : 'border-white/5'
              } ${isRerouting ? 'ring-1 ring-red-500/30' : ''}`}
            >
              {/* Pulsing Glow for Active Sentinel */}
              {node.sentinelActive && (
                <div className="absolute inset-0 bg-blue-600/5 animate-pulse pointer-events-none shadow-[inset_0_0_40px_rgba(59,130,246,0.1)]"></div>
              )}

              <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
                {/* Node Info */}
                <div className="flex items-center gap-4">
                  <div className={`p-3 rounded-xl ${isRerouting ? 'bg-red-500/10' : 'bg-gray-100 dark:bg-gray-800'}`}>
                    <Server className={`w-6 h-6 ${isRerouting ? 'text-red-500' : 'text-gray-500'}`} />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-white">{node.id}</h3>
                    {node.hostname !== node.id && (
                      <p className="text-[10px] text-gray-500 font-mono tracking-tight">{node.hostname}</p>
                    )}
                  </div>
                </div>

                {/* Status & Sentinel */}
                <div className="flex flex-wrap items-center gap-6">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] text-gray-500 uppercase font-bold tracking-widest">Status</span>
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${
                      isRerouting ? 'bg-red-500/10 text-red-600 border-red-500/20 animate-pulse' :
                      node.status === 'online' ? 'bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20' :
                      'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${
                        isRerouting ? 'bg-red-500' :
                        node.status === 'online' ? 'bg-green-500 dark:bg-green-400' : 'bg-amber-500'
                      }`}></span>
                      {isRerouting ? 'Rerouting' : node.status}
                    </span>
                  </div>

                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] text-gray-500 uppercase font-bold tracking-widest">Hardware</span>
                    <div className="flex items-center gap-4">
                      <div className="text-xs">
                        <span className="text-gray-500">VRAM: </span>
                        <span className="text-white font-mono">
                          {node.vramUsed != null ? `${node.vramUsed.toFixed(1)}GB` : '—'}
                        </span>
                      </div>
                      <div className="text-xs flex items-center gap-1">
                        <span className="text-gray-500">Temp: </span>
                        <span className={`font-mono font-bold ${isOverRedline ? 'text-red-500 animate-bounce' : 'text-gray-200'}`}>
                          {node.gpuTemp != null ? `${node.gpuTemp.toFixed(1)}°C` : '—'}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-gray-500 uppercase font-bold tracking-widest">Sentinel Protection</span>
                      </div>
                      <div className="flex items-center gap-1 bg-white/5 px-2 py-1 rounded-lg border border-white/10 focus-within:border-blue-500/50 focus-within:shadow-[0_0_8px_rgba(59,130,246,0.3)] transition-all">
                        <span className="text-[10px] text-gray-500">Redline:</span>
                        <input 
                          type="number" 
                          value={redline}
                          onChange={(e) => handleRedlineChange(node.id, e.target.value)}
                          className="w-8 bg-transparent text-[10px] font-mono font-bold text-blue-400 focus:outline-none text-center"
                        />
                        <span className="text-[10px] text-gray-500">°C</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <button 
                        onClick={() => onToggleSentinel?.(node.id)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-all focus:outline-none ${node.sentinelActive ? 'bg-blue-600 shadow-lg shadow-blue-500/30' : 'bg-gray-200 dark:bg-gray-700'} cursor-pointer`}
                      >
                        <Shield className={`absolute left-1.5 w-3 h-3 transition-all ${node.sentinelActive ? 'text-white opacity-100' : 'text-gray-400 opacity-50'}`} />
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${node.sentinelActive ? 'translate-x-6' : 'translate-x-1'}`} />
                      </button>
                      <span className={`text-[10px] font-bold uppercase tracking-tighter ${node.sentinelActive ? 'text-cyan-400' : 'text-gray-500'}`}>
                        {node.sentinelActive ? 'Active' : 'Disabled'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Throughput & Actions */}
                <div className="flex items-center gap-6">
                  <div className="flex flex-col items-end gap-1">
                    <span className="text-[10px] text-gray-500 uppercase font-bold tracking-widest">Throughput</span>
                    <div className="flex items-center gap-2">
                      <Activity className="w-4 h-4 text-blue-400" />
                      <span className="text-sm font-mono font-bold text-white">{node.requestsPerSecond.toFixed(1)} RPS</span>
                    </div>
                  </div>
                  <button className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl text-gray-400 transition-colors">
                    <MoreVertical className="w-5 h-5" />
                  </button>
                </div>
              </div>

              {/* Rerouting Animation Overlay */}
              {isRerouting && (
                <div className="mt-4 pt-4 border-t border-red-500/10 flex items-center justify-center gap-8 animate-in slide-in-from-bottom-2">
                  <div className="flex items-center gap-2 text-red-500 text-[10px] font-bold uppercase tracking-widest">
                    <AlertTriangle className="w-3 h-3" />
                    Thermal Redline Exceeded
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="h-1 w-24 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden relative">
                      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-cyan-400 to-transparent w-1/2 animate-reroute"></div>
                    </div>
                    <div className="flex items-center gap-2 text-cyan-400 text-[10px] font-bold uppercase tracking-widest">
                      Rerouting Traffic
                      <ArrowRight className="w-3 h-3 animate-pulse" />
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!isPro && (
        <button 
          onClick={onUpgradeClick}
          className="w-full group relative flex flex-col items-center justify-center gap-3 p-8 bg-transparent border-2 border-dashed border-white/5 hover:border-blue-500/30 rounded-[24px] transition-all duration-300"
        >
          <div className="w-10 h-10 bg-white/5 group-hover:bg-blue-600/20 rounded-full flex items-center justify-center border border-white/10 group-hover:border-blue-500/30 transition-all">
            <span className="text-xl text-gray-400 group-hover:text-blue-400 transition-colors">+</span>
          </div>
          <div className="text-center">
            <p className="text-sm font-bold text-gray-400 group-hover:text-white transition-colors">Add another node</p>
            <p className="text-[10px] text-gray-600 group-hover:text-gray-400 transition-colors">Upgrade to Team tier for multi-node orchestration</p>
          </div>
        </button>
      )}

      <style>{`
        @keyframes reroute {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(200%); }
        }
        .animate-reroute {
          animation: reroute 1.5s infinite linear;
        }
      `}</style>
    </div>
  );
};

export default NodesList;
