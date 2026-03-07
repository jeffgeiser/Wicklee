import React, { useState, useEffect, useRef, useCallback } from 'react';
import { LayoutGrid, Server, Activity, Terminal, BrainCircuit, ShieldCheck, Thermometer, Cpu, Wifi, WifiOff } from 'lucide-react';
import { DashboardTab, NodeAgent, PairingInfo, Tenant, User as UserType } from './types';
import Sidebar from './components/Sidebar';
import MobileTabBar from './components/MobileTabBar';
import Header from './components/Header';
import Overview from './components/Overview';
import NodesList from './components/NodesList';
import TracesView from './components/TracesView';
import ScaffoldingView from './components/ScaffoldingView';
import AIInsights from './components/AIInsights';
import TeamManagement from './components/TeamManagement';
import LandingPage from './components/LandingPage';
import AuthModal from './components/AuthModal';
import ProfileView from './components/ProfileView';
import SecurityView from './components/SecurityView';
import APIKeysView from './components/APIKeysView';
import PreferencesView from './components/PreferencesView';
import SustainabilityView from './components/SustainabilityView';
import PricingPage from './components/PricingPage';
import AIProvidersView from './components/AIProvidersView';
import PairingModal from './components/PairingModal';
import AddNodeModal from './components/AddNodeModal';
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

const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// Cloud backend URL — env var takes precedence; falls back to the known Railway service.
// Always absolute so fetch() doesn't resolve against the static host origin.
const CLOUD_URL = (() => {
  const v = import.meta.env.VITE_CLOUD_URL ?? '';
  if (!v) return 'https://vibrant-fulfillment-production-62c0.up.railway.app';
  return v.startsWith('http') ? v : `https://${v}`;
})();

const App: React.FC = () => {
  const [isLoggedIn, setIsLoggedIn] = useState(isLocalHost);
  const [authModalMode, setAuthModalMode] = useState<'signin' | 'signup' | null>(null);
  const [activeTab, setActiveTab] = useState<DashboardTab>(DashboardTab.OVERVIEW);
  const [nodes, setNodes] = useState<NodeAgent[]>(isLocalHost ? MOCK_NODES_INITIAL : []);
  const [isConnected, setIsConnected] = useState(false);
  const [currentTenant, setCurrentTenant] = useState<Tenant>(MOCK_TENANTS[0]);
  const [currentUser, setCurrentUser] = useState<UserType>(MOCK_CURRENT_USER);
  const [byokMode, setByokMode] = useState(false);
  const [userApiKey, setUserApiKey] = useState('');
  const [isUpgradeModalOpen, setIsUpgradeModalOpen] = useState(false);
  const [pairingInfo, setPairingInfo] = useState<PairingInfo | null>(null);
  const [isPairingModalOpen, setIsPairingModalOpen] = useState(false);
  const [isAddNodeModalOpen, setIsAddNodeModalOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    return (localStorage.getItem('theme') as 'light' | 'dark') || 'dark';
  });
  const socketRef = useRef<WebSocket | null>(null);

  // Restore session from localStorage on mount (hosted only — localhost skips auth entirely)
  useEffect(() => {
    if (isLocalHost) return;
    const token = localStorage.getItem('wk_auth_token');
    if (!token) return;

    fetch(`${CLOUD_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (!r.ok) { localStorage.removeItem('wk_auth_token'); return; }
        const data = await r.json();
        setCurrentUser({ id: data.id, email: data.email, fullName: data.fullName, role: data.role, isPro: data.isPro ?? false });
        setIsLoggedIn(true);
      })
      .catch(() => localStorage.removeItem('wk_auth_token'));
  }, []);

  const handleAuthSuccess = (user: UserType, token: string) => {
    localStorage.setItem('wk_auth_token', token);
    setCurrentUser(user);
    setAuthModalMode(null);
    setIsLoggedIn(true);
  };

  const handleLocalMode = () => {
    setCurrentUser(MOCK_CURRENT_USER);
    setAuthModalMode(null);
    setIsLoggedIn(true);
  };

  // Called after a node is successfully paired via AddNodeModal; fetch updated fleet list.
  const handleNodeAdded = useCallback(async () => {
    try {
      const token = localStorage.getItem('wk_auth_token');
      const r = await fetch(`${CLOUD_URL}/api/fleet`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (r.ok) {
        const data = await r.json();
        // Map cloud NodeSummary → frontend NodeAgent shape
        setNodes((data.nodes ?? []).map((n: any) => ({
          id: n.node_id,
          hostname: n.node_id,
          ip: n.fleet_url,
          status: 'online' as const,
          gpuTemp: n.metrics?.nvidia_gpu_temp_c ?? 0,
          vramUsed: (n.metrics?.nvidia_vram_used_mb ?? 0) / 1024,
          vramTotal: (n.metrics?.nvidia_vram_total_mb ?? 0) / 1024,
          powerUsage: n.metrics?.nvidia_power_draw_w ?? 0,
          requestsPerSecond: 0,
          activeInterceptors: [],
          uptime: '—',
          sentinelActive: false,
        })));
      }
    } catch {}
  }, []);

  const permissions = usePermissions(currentUser);
  const isLocalMode = !pairingInfo || pairingInfo.status !== 'connected';

  const fetchPairingStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/pair/status');
      if (r.ok) setPairingInfo(await r.json());
    } catch {}
  }, []);

  const generatePairingCode = useCallback(async () => {
    try {
      const r = await fetch('/api/pair/generate', { method: 'POST' });
      if (r.ok) setPairingInfo(await r.json());
    } catch {}
  }, []);

  const disconnectFleet = useCallback(async () => {
    try {
      const r = await fetch('/api/pair/disconnect', { method: 'POST' });
      if (r.ok) setPairingInfo(await r.json());
    } catch {}
  }, []);

  useEffect(() => {
    fetchPairingStatus();
    if (pairingInfo?.status !== 'pending') return;
    const id = setInterval(fetchPairingStatus, 4000);
    return () => clearInterval(id);
  }, [pairingInfo?.status, fetchPairingStatus]);

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
      // Use wss:// when served over HTTPS (required by browsers for mixed-content).
      const wsHost = window.location.host || 'localhost:7700';
      const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const wsUrl = `${wsProto}://${wsHost}/ws?tenant_id=${currentTenant.id}&user_id=${currentUser.id}`;
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
    localStorage.removeItem('wk_auth_token');
    setCurrentUser(MOCK_CURRENT_USER);
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
    return (
      <>
        <LandingPage
          onSignIn={() => setAuthModalMode('signin')}
          onSignUp={() => setAuthModalMode('signup')}
          onLocalMode={handleLocalMode}
        />
        {authModalMode && (
          <AuthModal
            mode={authModalMode}
            onSuccess={handleAuthSuccess}
            onClose={() => setAuthModalMode(null)}
            onLocalMode={handleLocalMode}
          />
        )}
      </>
    );
  }

  const renderContent = () => {
    switch (activeTab) {
      case DashboardTab.OVERVIEW:
        return <Overview nodes={nodes} isPro={currentUser.isPro} pairingInfo={pairingInfo} onOpenPairing={() => setIsPairingModalOpen(true)} onAddNode={() => setIsAddNodeModalOpen(true)} />;
      case DashboardTab.NODES:
        return (
          <NodesList
            nodes={nodes}
            isPro={currentUser.isPro}
            onUpgradeClick={isLocalMode ? undefined : () => setIsUpgradeModalOpen(true)}
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
        return permissions.canManageTeam ? <TeamManagement tenantId={currentTenant.id} currentUser={currentUser} /> : <div className="text-center py-20 text-gray-500">Unauthorized Access</div>;
      case DashboardTab.SUSTAINABILITY:
        return <SustainabilityView nodes={nodes} />;
      case DashboardTab.PROFILE:
        return <ProfileView currentUser={currentUser} />;
      case DashboardTab.SECURITY:
        return <SecurityView byokMode={byokMode} setByokMode={setByokMode} userApiKey={userApiKey} setUserApiKey={setUserApiKey} pairingInfo={pairingInfo} onOpenPairing={() => setIsPairingModalOpen(true)} onGenerateCode={generatePairingCode} onDisconnect={disconnectFleet} />;
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
        return <Overview nodes={nodes} pairingInfo={pairingInfo} onOpenPairing={() => setIsPairingModalOpen(true)} onAddNode={() => setIsAddNodeModalOpen(true)} />;
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 font-sans transition-colors duration-300">
      <UpgradeModal
        isOpen={isUpgradeModalOpen}
        onClose={() => setIsUpgradeModalOpen(false)}
        onUpgrade={handleUpgrade}
      />
      <PairingModal
        isOpen={isPairingModalOpen}
        onClose={() => setIsPairingModalOpen(false)}
        pairingInfo={pairingInfo}
        onGenerate={generatePairingCode}
        onDisconnect={disconnectFleet}
      />
      <AddNodeModal
        isOpen={isAddNodeModalOpen}
        onClose={() => setIsAddNodeModalOpen(false)}
        onNodeAdded={handleNodeAdded}
        cloudUrl={CLOUD_URL}
      />
      <Sidebar
        activeTab={activeTab}
        setActiveTab={handleTabChange}
        currentUser={currentUser}
        onUserChange={setCurrentUser}
        onLogout={handleLogout}
        isConnected={isConnected}
        isLocalMode={isLocalMode}
        pairingInfo={pairingInfo}
        onOpenPairing={() => setIsPairingModalOpen(true)}
      />
      
      <MobileTabBar activeTab={activeTab} setActiveTab={handleTabChange} />
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
          pairingInfo={pairingInfo}
          onOpenPairing={isLocalHost ? () => setIsPairingModalOpen(true) : () => setIsAddNodeModalOpen(true)}
        />
        
        <div className="flex-1 overflow-y-auto p-4 md:p-6 pb-20 md:pb-6 scroll-smooth">
          <div className="max-w-7xl mx-auto space-y-6">
            {!isConnected && activeTab !== DashboardTab.SCAFFOLDING && (
              <div className="w-full bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-6 animate-pulse">
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