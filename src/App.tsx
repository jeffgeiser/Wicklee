import React, { useState, useEffect, useRef } from 'react';
import { LayoutGrid, Server, Activity, Terminal, BrainCircuit, ShieldCheck, Thermometer, Cpu, Wifi, WifiOff } from 'lucide-react';
import { DashboardTab, NodeAgent, Tenant, User as UserType } from './types';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import Overview from './components/Overview';
import NodesList from './components/NodesList';
import TracesView from './components/TracesView';
import ScaffoldingView from './components/ScaffoldingView';
import AIInsights from './components/AIInsights';
import TeamManagement from './components/TeamManagement';
import LandingPage from './components/LandingPage';
import ProfileView from './components/ProfileView';
import SecurityView from './components/SecurityView';
import APIKeysView from './components/APIKeysView';
import PreferencesView from './components/PreferencesView';
import SustainabilityView from './components/SustainabilityView';
import PricingPage from './components/PricingPage';
import AIProvidersView from './components/AIProvidersView';
import { usePermissions } from './hooks/usePermissions';
import { X, Sparkles, Zap, Shield, Globe } from 'lucide-react';

const UpgradeModal: React.FC<{ isOpen: boolean; onClose: () => void; onUpgrade: () => void }> = ({ isOpen, onClose, onUpgrade }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-300">
      <div className="bg-zinc-950 border border-zinc-800 w-full max-w-lg rounded-[32px] overflow-hidden shadow-2xl shadow-blue-500/10 animate-in zoom-in-95 duration-300">
        <div className="relative p-8 text-center space-y-6">
          <button onClick={onClose} className="absolute top-6 right-6 p-2 text-gray-500 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>

          <div className="w-16 h-16 bg-blue-600/20 rounded-2xl border border-blue-500/30 flex items-center justify-center mx-auto">
            <Sparkles className="w-8 h-8 text-blue-400" />
          </div>

          <div className="space-y-2">
            <h2 className="text-2xl font-bold text-white">Unlock Fleet Orchestration</h2>
            <p className="text-gray-400 text-sm">
              Upgrade to Wicklee Pro to access advanced telemetry, autonomous failover, and sovereign AI insights.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 text-left">
            {[
              { icon: Zap, title: 'Sentinel Auto-Failover', desc: 'Autonomous node recovery & routing.' },
              { icon: Shield, title: 'Advanced Observability', desc: 'Full DuckDB trace history & analytics.' },
              { icon: Globe, title: 'Sustainability Engine', desc: 'Real-time carbon & thermal tracking.' }
            ].map((item, i) => (
              <div key={i} className="flex items-start gap-4 p-4 bg-zinc-900/50 border border-zinc-800 rounded-2xl">
                <div className="p-2 bg-blue-600/10 rounded-lg">
                  <item.icon className="w-4 h-4 text-blue-400" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-white uppercase tracking-wider">{item.title}</h4>
                  <p className="text-[10px] text-gray-500">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="pt-4 space-y-3">
            <button 
              onClick={onUpgrade}
              className="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-2xl transition-all shadow-lg shadow-blue-500/20"
            >
              Upgrade to Pro — $39/mo
            </button>
            <button onClick={onClose} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
              Maybe later
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const MOCK_NODES_INITIAL: NodeAgent[] = [
  {
    id: 'node-01',
    hostname: 'wicklee-worker-01',
    ip: '192.168.1.42',
    status: 'online',
    gpuTemp: 68,
    vramUsed: 12.4,
    vramTotal: 24,
    powerUsage: 245,
    tdp: 250,
    requestsPerSecond: 4.2,
    activeInterceptors: ['pii-redactor', 'logging'],
    uptime: '14d 2h',
    sentinelActive: true
  },
  {
    id: 'node-02',
    hostname: 'wicklee-worker-02',
    ip: '192.168.1.45',
    status: 'online',
    gpuTemp: 82, // High temp to trigger sentinel UI
    vramUsed: 4.1,
    vramTotal: 80,
    powerUsage: 110,
    requestsPerSecond: 1.8,
    activeInterceptors: ['logging'],
    uptime: '3d 12h',
    sentinelActive: true
  }
];

const MOCK_TENANTS: Tenant[] = [
  { id: 'tnt-01', name: 'Wicklee Dev Ops' },
  { id: 'tnt-02', name: 'Acme AI Research' }
];

const MOCK_CURRENT_USER: UserType = {
  id: 'usr-01',
  email: 'admin@wicklee.io',
  fullName: 'Sarah Chen',
  role: 'Owner',
  isPro: false
};

const App: React.FC = () => {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [activeTab, setActiveTab] = useState<DashboardTab>(DashboardTab.OVERVIEW);
  const [nodes, setNodes] = useState<NodeAgent[]>(MOCK_NODES_INITIAL);
  const [isConnected, setIsConnected] = useState(false);
  const [currentTenant, setCurrentTenant] = useState<Tenant>(MOCK_TENANTS[0]);
  const [currentUser, setCurrentUser] = useState<UserType>(MOCK_CURRENT_USER);
  const [byokMode, setByokMode] = useState(false);
  const [userApiKey, setUserApiKey] = useState('');
  const [isUpgradeModalOpen, setIsUpgradeModalOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    return (localStorage.getItem('theme') as 'light' | 'dark') || 'dark';
  });
  const socketRef = useRef<WebSocket | null>(null);

  const permissions = usePermissions(currentUser);

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    if (!isLoggedIn) return;

    const connectWS = () => {
      // Use the current host so the embedded binary (port 7700) connects to
      // itself, and the Railway deploy connects to its own origin automatically.
      const wsHost = window.location.host || 'localhost:7700';
      const wsUrl = `ws://${wsHost}/ws?tenant_id=${currentTenant.id}&user_id=${currentUser.id}`;
      console.log(`Connecting to Wicklee Backend for tenant ${currentTenant.name}...`);
      
      const socket = new WebSocket(wsUrl);
      socketRef.current = socket;

      socket.onopen = () => {
        setIsConnected(true);
        console.log('Connected to Wicklee Orchestrator');
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.nodes) {
            setNodes(prev => prev.map(node => {
              const update = data.nodes.find((n: any) => n.id === node.id);
              return update ? { ...node, ...update } : node;
            }));
          }
        } catch (err) {
          console.error('Failed to parse WebSocket message', err);
        }
      };

      socket.onclose = () => {
        setIsConnected(false);
        console.log('Disconnected from Wicklee Orchestrator. Retrying in 5s...');
        setTimeout(connectWS, 5000);
      };

      socket.onerror = (err) => {
        console.error('WebSocket error:', err);
        socket.close();
      };
    };

    connectWS();

    return () => {
      socketRef.current?.close();
    };
  }, [currentTenant.id, currentUser.id, isLoggedIn]);

  const handleLogout = () => {
    setIsLoggedIn(false);
  };

  const handleUpgrade = () => {
    setCurrentUser(prev => ({ ...prev, isPro: true }));
    setIsUpgradeModalOpen(false);
  };

  const handleToggleSentinel = (nodeId: string) => {
    setNodes(prev => prev.map(node => 
      node.id === nodeId ? { ...node, sentinelActive: !node.sentinelActive } : node
    ));
  };

  const handleTabChange = (tab: DashboardTab) => {
    setActiveTab(tab);
  };

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  if (!isLoggedIn) {
    return <LandingPage onLogin={() => setIsLoggedIn(true)} />;
  }

  const renderContent = () => {
    switch (activeTab) {
      case DashboardTab.OVERVIEW:
        return <Overview nodes={nodes} isPro={currentUser.isPro} />;
      case DashboardTab.NODES:
        return (
          <NodesList 
            nodes={nodes} 
            isPro={currentUser.isPro} 
            onUpgradeClick={() => setIsUpgradeModalOpen(true)}
            onToggleSentinel={handleToggleSentinel}
          />
        );
      case DashboardTab.TRACES:
        return <TracesView nodes={nodes} tenantId={currentTenant.id} />;
      case DashboardTab.SCAFFOLDING:
        return permissions.canViewScaffolding ? <ScaffoldingView /> : <div className="text-center py-20 text-gray-500">Unauthorized Access</div>;
      case DashboardTab.AI_INSIGHTS:
        return permissions.canRunAIAnalysis ? (
          <AIInsights 
            nodes={nodes} 
            userApiKey={byokMode ? userApiKey : undefined} 
            onNavigateToSecurity={() => setActiveTab(DashboardTab.SECURITY)}
          />
        ) : (
          <div className="text-center py-20 text-gray-500">Unauthorized Access</div>
        );
      case DashboardTab.TEAM:
        return permissions.canManageTeam ? <TeamManagement tenantId={currentTenant.id} /> : <div className="text-center py-20 text-gray-500">Unauthorized Access</div>;
      case DashboardTab.SUSTAINABILITY:
        return <SustainabilityView nodes={nodes} />;
      case DashboardTab.PROFILE:
        return <ProfileView currentUser={currentUser} />;
      case DashboardTab.SECURITY:
        return <SecurityView byokMode={byokMode} setByokMode={setByokMode} userApiKey={userApiKey} setUserApiKey={setUserApiKey} />;
      case DashboardTab.API_KEYS:
        return <APIKeysView />;
      case DashboardTab.PREFERENCES:
        return <PreferencesView currentTenant={currentTenant} theme={theme} setTheme={setTheme} />;
      case DashboardTab.PRICING:
        return <PricingPage />;
      case DashboardTab.AI_PROVIDERS:
        return <AIProvidersView />;
      case DashboardTab.BILLING:
        return <PricingPage />;
      default:
        return <Overview nodes={nodes} />;
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 font-sans transition-colors duration-300">
      <UpgradeModal 
        isOpen={isUpgradeModalOpen} 
        onClose={() => setIsUpgradeModalOpen(false)} 
        onUpgrade={handleUpgrade} 
      />
      <Sidebar 
        activeTab={activeTab} 
        setActiveTab={handleTabChange} 
        currentUser={currentUser} 
        onUserChange={setCurrentUser} 
        onLogout={handleLogout}
        isConnected={isConnected}
      />
      
      <main className="flex-1 flex flex-col overflow-hidden">
        <Header 
          activeTab={activeTab} 
          tenants={MOCK_TENANTS} 
          currentTenant={currentTenant} 
          onTenantChange={setCurrentTenant}
          currentUser={currentUser}
          onLogout={handleLogout}
          setActiveTab={setActiveTab}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
        
        <div className="flex-1 overflow-y-auto p-6 scroll-smooth">
          <div className="max-w-7xl mx-auto space-y-6">
            {!isConnected && activeTab !== DashboardTab.SCAFFOLDING && (
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex items-center justify-between mb-6 animate-pulse">
                <div className="flex items-center gap-3">
                  <WifiOff className="w-5 h-5 text-amber-500" />
                  <div>
                    <h3 className="text-sm font-semibold text-amber-600 dark:text-amber-200">Disconnected from Local Agent</h3>
                    <p className="text-xs text-amber-600/80 dark:text-amber-500/80">Dashboard is showing cached/mock data. Please start the Wicklee Rust backend.</p>
                  </div>
                </div>
                <button 
                  onClick={() => setActiveTab(DashboardTab.SCAFFOLDING)}
                  className="px-3 py-1 bg-amber-500/10 dark:bg-amber-500/20 hover:bg-amber-500/20 dark:hover:bg-amber-500/30 text-amber-600 dark:text-amber-200 text-xs font-bold rounded-lg transition-all"
                >
                  View Setup Guide
                </button>
              </div>
            )}
            {renderContent()}
          </div>
        </div>

        <footer className="h-8 border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 flex items-center justify-between text-xs text-gray-500 transition-colors">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                {isConnected && (
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                )}
                <span className={`relative inline-flex rounded-full h-2 w-2 ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}></span>
              </span>
              Orchestrator: {isConnected ? 'Active' : 'Offline'}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <span className="mono">v0.4.1-alpha</span>
            <span className="flex items-center gap-1">
              <Activity className="w-3 h-3" />
              Latency: {isConnected ? '12ms' : '--'}
            </span>
          </div>
        </footer>
      </main>
    </div>
  );
};

export default App;