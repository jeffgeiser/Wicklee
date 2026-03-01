import React from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts';
import { Thermometer, Cpu, Database, Zap, ArrowUpRight, ArrowDownRight, Info } from 'lucide-react';
import { NodeAgent } from '../types';
import EventFeed from './EventFeed';

interface OverviewProps {
  nodes: NodeAgent[];
  isPro?: boolean;
}

const MOCK_HISTORY = Array.from({ length: 20 }).map((_, i) => ({
  time: `${i}:00`,
  requests: Math.floor(Math.random() * 50) + 10,
  latency: Math.floor(Math.random() * 100) + 200,
}));

const StatCard: React.FC<{ title: React.ReactNode; value: React.ReactNode; icon: React.ElementType; trend?: string; color: string }> = ({ title, value, icon: Icon, trend, color }) => (
  <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 hover:border-gray-300 dark:hover:border-gray-700 transition-all shadow-sm dark:shadow-none">
    <div className="flex items-start justify-between">
      <div className={`p-2 rounded-xl bg-opacity-10 ${color}`}>
        <Icon className={`w-5 h-5 ${color.replace('bg-', 'text-')}`} />
      </div>
      {trend && (
        <span className={`flex items-center text-xs font-medium ${trend.startsWith('+') ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
          {trend.startsWith('+') ? <ArrowUpRight className="w-3 h-3 mr-1" /> : <ArrowDownRight className="w-3 h-3 mr-1" />}
          {trend}
        </span>
      )}
    </div>
    <div className="mt-4">
      <h4 className="text-gray-500 dark:text-gray-400 text-xs font-medium uppercase tracking-wider">{title}</h4>
      <div className="mt-1">{value}</div>
    </div>
  </div>
);

const Overview: React.FC<OverviewProps> = ({ nodes, isPro }) => {
  const activeNodes = isPro ? nodes : nodes.slice(0, 1);
  const totalRPS = activeNodes.reduce((acc, n) => acc + n.requestsPerSecond, 0);
  const avgTemp = (activeNodes.reduce((acc, n) => acc + n.gpuTemp, 0) / activeNodes.length).toFixed(1);
  const totalVRAM = activeNodes.reduce((acc, n) => acc + n.vramUsed, 0).toFixed(1);
  const totalWattage = activeNodes.reduce((acc, n) => acc + n.powerUsage, 0);
  
  const hasTDP = activeNodes.every(n => n.tdp !== undefined);
  
  // Wattage per 1k tokens
  // Assuming 1 req = 500 tokens. Total tokens/s = totalRPS * 500
  // Formula: (totalWattage / (totalRPS * 500)) * 1000
  const wattagePer1kTokens = totalRPS > 0 
    ? ((totalWattage / (totalRPS * 500)) * 1000).toFixed(1)
    : "0.0";

  // Mock calculation: $ per 1k tokens
  // Assuming 1 req = 500 tokens. Total tokens/s = totalRPS * 500
  // Cost = (totalWattage / 1000) * (1/3600) * $0.15 per kWh
  const costPer1kTokens = totalRPS > 0 
    ? ((totalWattage / (totalRPS * 500)) * 0.00015).toFixed(6)
    : "0.000000";

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 [&>*]:min-w-0">
        <StatCard title="Throughput" value={<p className="text-2xl font-bold text-gray-900 dark:text-white">{totalRPS.toFixed(1)} req/s</p>} icon={Zap} trend="+12.4%" color="bg-amber-500" />
        <StatCard title="Avg Temperature" value={<p className="text-2xl font-bold text-gray-900 dark:text-white">{avgTemp}°C</p>} icon={Thermometer} trend="-2.1%" color="bg-red-500" />
        <StatCard title="Total VRAM Usage" value={<p className="text-2xl font-bold text-gray-900 dark:text-white">{totalVRAM} GB</p>} icon={Database} trend="+4.3%" color="bg-blue-600" />
        <StatCard 
          title={
            <div className="flex items-center gap-1.5">
              <span>Wattage / 1k tkn</span>
              <div className="group relative">
                <Info className="w-3 h-3 text-gray-400 cursor-help" />
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 p-2 bg-gray-900 text-[10px] text-gray-300 rounded-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 shadow-xl border border-white/10">
                  Calculated from GPU TDP × utilization ÷ tokens generated. Set your GPU TDP in Settings to calibrate this number.
                </div>
              </div>
            </div>
          } 
          value={
            hasTDP ? (
              <div>
                <p className="text-2xl font-bold text-gray-900 dark:text-white">{wattagePer1kTokens}W</p>
                <p className="text-[10px] text-gray-500 font-medium">per 1,000 tokens</p>
              </div>
            ) : (
              <button className="text-left group">
                <p className="text-[11px] font-bold text-blue-600 dark:text-blue-400 group-hover:underline leading-tight">
                  Configure GPU TDP to see cost metrics →
                </p>
              </button>
            )
          } 
          icon={Zap} 
          trend="-3.2%" 
          color="bg-emerald-500" 
        />
        <StatCard 
          title="Cost per 1k Tokens" 
          value={
            <div>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">${costPer1kTokens}</p>
              <p className="text-[10px] text-gray-500 font-medium">per 1k tokens</p>
            </div>
          } 
          icon={Zap} 
          trend="-8.2%" 
          color="bg-cyan-400" 
        />
        <StatCard title="Fleet Nodes" value={<p className="text-2xl font-bold text-gray-900 dark:text-white">{nodes.length.toString()}</p>} icon={Cpu} color="bg-green-500" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-6 shadow-sm dark:shadow-none">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-6">
            <h3 className="font-semibold text-gray-800 dark:text-gray-200">System Performance History</h3>
            <select className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-xs rounded-lg px-2 py-1 outline-none text-gray-600 dark:text-gray-400">
              <option>Last 24 Hours</option>
              <option>Last 7 Days</option>
            </select>
          </div>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={MOCK_HISTORY}>
                <defs>
                  <linearGradient id="colorReq" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#1c64f2" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#22d3ee" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-gray-200 dark:text-gray-800" vertical={false} />
                <XAxis dataKey="time" stroke="#9ca3af" fontSize={10} axisLine={false} tickLine={false} />
                <YAxis stroke="#9ca3af" fontSize={10} axisLine={false} tickLine={false} />
                <Tooltip 
                  contentStyle={{ backgroundColor: 'var(--tooltip-bg, #fff)', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '12px' }}
                  itemStyle={{ color: '#1c64f2' }}
                />
                <Area type="monotone" dataKey="requests" stroke="#1c64f2" fillOpacity={1} fill="url(#colorReq)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="lg:col-span-1 h-full min-h-[400px]">
          <EventFeed nodes={activeNodes} />
        </div>
      </div>
    </div>
  );
};

export default Overview;