import React from 'react';
import { Leaf, Zap, Wind, BarChart3, TrendingDown } from 'lucide-react';
import { NodeAgent } from '../types';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

interface SustainabilityViewProps {
  nodes: NodeAgent[];
}

const MOCK_CARBON_DATA = Array.from({ length: 12 }).map((_, i) => ({
  month: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][i],
  carbon: Math.floor(Math.random() * 100) + 50,
  offset: Math.floor(Math.random() * 30) + 10,
}));

const SustainabilityView: React.FC<SustainabilityViewProps> = ({ nodes }) => {
  const totalWattage = nodes.reduce((acc, n) => acc + (n.powerUsage ?? 0), 0);
  const idleWattage = nodes.reduce((acc, n) => acc + (n.requestsPerSecond < 0.1 ? (n.powerUsage ?? 0) : (n.powerUsage ?? 0) * 0.2), 0);
  const carbonImpact = (totalWattage * 0.0004).toFixed(2); // Mock kg CO2 per hour

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-2xl p-6">
          <div className="flex items-center gap-3 mb-4">
            <Leaf className="w-5 h-5 text-emerald-500" />
            <h3 className="font-bold text-emerald-500 uppercase tracking-widest text-xs">Carbon Footprint</h3>
          </div>
          <p className="text-3xl font-bold text-gray-900 dark:text-white">{carbonImpact} <span className="text-sm font-normal text-gray-500">kg CO2/hr</span></p>
          <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-2 flex items-center gap-1">
            <TrendingDown className="w-3 h-3" /> 12% reduction from last week
          </p>
        </div>

        <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-6">
          <div className="flex items-center gap-3 mb-4">
            <Zap className="w-5 h-5 text-amber-500" />
            <h3 className="font-bold text-amber-500 uppercase tracking-widest text-xs">Idle Power Waste</h3>
          </div>
          <p className="text-3xl font-bold text-gray-900 dark:text-white">{idleWattage.toFixed(0)} <span className="text-sm font-normal text-gray-500">Watts</span></p>
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
            3 nodes currently in low-utilization state
          </p>
        </div>

        <div className="bg-blue-600/10 border border-blue-600/20 rounded-2xl p-6">
          <div className="flex items-center gap-3 mb-4">
            <Wind className="w-5 h-5 text-blue-600" />
            <h3 className="font-bold text-blue-600 uppercase tracking-widest text-xs">Renewable Mix</h3>
          </div>
          <p className="text-3xl font-bold text-gray-900 dark:text-white">64%</p>
          <p className="text-xs text-blue-600 dark:text-blue-400 mt-2">
            Sourced from local solar/wind microgrid
          </p>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-6">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h3 className="text-lg font-bold text-gray-900 dark:text-white">Fleet Sustainability Trends</h3>
            <p className="text-sm text-gray-500">Monthly carbon impact vs. offset initiatives</p>
          </div>
          <div className="flex gap-4">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-blue-600"></div>
              <span className="text-xs text-gray-500">Carbon Impact</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-cyan-400"></div>
              <span className="text-xs text-gray-500">Offsets</span>
            </div>
          </div>
        </div>
        <div className="h-80 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={MOCK_CARBON_DATA}>
              <defs>
                <linearGradient id="colorCarbon" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#1c64f2" stopOpacity={0.3}/>
                  <stop offset="95%" stopColor="#1c64f2" stopOpacity={0}/>
                </linearGradient>
                <linearGradient id="colorOffset" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#22d3ee" stopOpacity={0.3}/>
                  <stop offset="95%" stopColor="#22d3ee" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#374151" opacity={0.1} />
              <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#9ca3af' }} />
              <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#9ca3af' }} />
              <Tooltip 
                contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '12px' }}
                itemStyle={{ fontSize: '12px' }}
              />
              <Area type="monotone" dataKey="carbon" stroke="#1c64f2" fillOpacity={1} fill="url(#colorCarbon)" strokeWidth={2} />
              <Area type="monotone" dataKey="offset" stroke="#22d3ee" fillOpacity={1} fill="url(#colorOffset)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
};

export default SustainabilityView;
