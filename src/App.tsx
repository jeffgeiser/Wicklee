import React, { useState, useEffect, useRef, useCallback } from 'react';
import { version } from '../package.json';
import { LayoutGrid, Server, Activity, Terminal, BrainCircuit, ShieldCheck, Thermometer, Cpu, Wifi, WifiOff } from 'lucide-react';
import { useAuth, useUser } from '@clerk/clerk-react';
import { ConnectionState, DashboardTab, FleetNode, NodeAgent, PairingInfo, Tenant, User as UserType } from './types';
import { NODE_REACHABLE_MS, fmtAgo as fmtNodeAgo } from './utils/time';
import { FleetStreamProvider, useFleetStream } from './contexts/FleetStreamContext';
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
import SignInPage from './components/SignInPage';
import SignUpPage from './components/SignUpPage';
import ProfileView from './components/ProfileView';
import SecurityView from './components/SecurityView';
import APIKeysView from './components/APIKeysView';
import PreferencesView from './components/PreferencesView';
import SettingsView from './components/SettingsView';
import { useSettings } from './hooks/useSettings';
import PricingPage from './components/PricingPage';
import AIProvidersView from './components/AIProvidersView';
import PairingModal from './components/PairingModal';
import AddNodeModal from './components/AddNodeModal';
import { usePermissions } from './hooks/usePermissions';
import BlogListing from './components/BlogListing';
import BlogPost from './components/BlogPost';
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

// Localhost uses an anonymous user — no account required.
const LOCAL_USER: UserType = {
  id: 'local',
  email: '',
  fullName: '',
  role: 'Owner',
  isPro: false,
};

const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// Cloud backend URL — env var takes precedence; falls back to the known Railway service.
// Always absolute so fetch() doesn't resolve against the static host origin.
const CLOUD_URL = (() => {
  const v = import.meta.env.VITE_CLOUD_URL ?? '';
  if (!v) return 'https://vibrant-fulfillment-production-62c0.up.railway.app';
  return v.startsWith('http') ? v : `https://${v}`;
})();

// Build-time flag: true in the agent binary where ClerkProvider is absent.
// Hoisted to module scope so it's available to both AppCore and the export shim.
const IS_AGENT = (import.meta.env.VITE_BUILD_TARGET as string) === 'agent';

interface AppCoreProps {
  isSignedIn: boolean | undefined;
  isLoaded: boolean;
  getToken: () => Promise<string | null>;
  user: {
    id?: string;
    primaryEmailAddress?: { emailAddress?: string | null } | null;
    fullName?: string | null;
  } | null;
}

const AppCore: React.FC<AppCoreProps> = ({ isSignedIn, isLoaded, getToken, user }) => {

  const [currentPath, setCurrentPath] = useState(() => window.location.pathname);
  const [activeTab, setActiveTab] = useState<DashboardTab>(DashboardTab.OVERVIEW);
  const [nodes, setNodes] = useState<NodeAgent[]>(isLocalHost ? MOCK_NODES_INITIAL : []);
  // True until the first /api/fleet fetch settles (or Clerk hasn't loaded yet).
  // Prevents EmptyFleetState from flashing on page refresh while auth resolves.
  const [nodesLoading, setNodesLoading] = useState(!isLocalHost);
  const [currentTenant, setCurrentTenant] = useState<Tenant>(MOCK_TENANTS[0]);
  // Build currentUser from Clerk user data (or LOCAL_USER for localhost)
  const currentUser: UserType = isLocalHost
    ? LOCAL_USER
    : {
        id: user?.id ?? 'local',
        email: user?.primaryEmailAddress?.emailAddress ?? '',
        fullName: user?.fullName ?? '',
        role: 'Owner',
        isPro: false,
      };
  const [byokMode, setByokMode] = useState(false);
  const [userApiKey, setUserApiKey] = useState('');
  const [isUpgradeModalOpen, setIsUpgradeModalOpen] = useState(false);
  const [pairingInfo, setPairingInfo] = useState<PairingInfo | null>(null);
  const [isPairingModalOpen, setIsPairingModalOpen] = useState(false);
  const [isAddNodeModalOpen, setIsAddNodeModalOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    return (localStorage.getItem('theme') as 'light' | 'dark') || 'dark';
  });
  const { settings, savedToast, getNodeSettings, updateFleet, setNodeOverride, clearAllOverridesForField, clearAllNodeOverrides } = useSettings();

  const navigate = useCallback((path: string) => {
    window.history.pushState(null, '', path);
    setCurrentPath(path);
  }, []);

  useEffect(() => {
    const onPopState = () => setCurrentPath(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);


  // Called after a node is successfully paired via AddNodeModal; fetch updated fleet list.
  const handleNodeAdded = useCallback(async () => {
    try {
      const token = isLocalHost ? null : await getToken();
      const r = await fetch(`${CLOUD_URL}/api/fleet`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (r.ok) {
        const data = await r.json();
        // Map cloud NodeSummary → frontend NodeAgent shape
        const mappedNodes = (data.nodes ?? []).map((n: any) => ({
          id: n.node_id as string,
          hostname: n.metrics?.hostname ?? n.node_id,
          ip: n.metrics?.hostname ?? n.node_id,
          status: 'online' as const,
          gpuTemp: n.metrics?.nvidia_gpu_temp_c ?? null,
          vramUsed: n.metrics?.nvidia_vram_used_mb != null ? n.metrics.nvidia_vram_used_mb / 1024 : null,
          vramTotal: n.metrics?.nvidia_vram_total_mb != null ? n.metrics.nvidia_vram_total_mb / 1024 : null,
          powerUsage: n.metrics?.nvidia_power_draw_w ?? null,
          requestsPerSecond: 0,
          activeInterceptors: [],
          uptime: '—',
          sentinelActive: false,
        }));
        setNodes(mappedNodes);
      }
    } catch {
      // Fetch failed — still mark loading done so empty state can render if truly zero nodes.
    } finally {
      setNodesLoading(false);
    }
  }, []);

  // Fetch paired nodes from cloud on sign-in (hosted only).
  useEffect(() => {
    if (isLocalHost || !isSignedIn) return;
    handleNodeAdded();
  }, [isSignedIn, handleNodeAdded]);

  // Callback for FleetStreamProvider — patches node hostnames when real metrics arrive.
  const handleNodesSnapshot = useCallback((snapshot: FleetNode[]) => {
    if (snapshot.some(n => n.metrics)) {
      setNodes(prev => prev.map(node => {
        const match = snapshot.find(n => n.node_id === node.id);
        if (match?.metrics?.hostname && node.hostname === node.id) {
          return { ...node, hostname: match.metrics.hostname };
        }
        return node;
      }));
    }
  }, []);

  const permissions = usePermissions(currentUser);
  // Build-time flag: true when compiled for the local agent binary (VITE_BUILD_TARGET=agent).
  // This is the sole source of truth for Cockpit vs Mission Control mode — never derived
  // from runtime auth state or pairing status.
  const isLocalMode = (import.meta.env.VITE_BUILD_TARGET as string) === 'agent';

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

  const isLoggedIn = isLocalHost || !!isSignedIn;


  const handleUpgrade = () => {
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

  // Clerk sign-in / sign-up routes
  if (currentPath === '/sign-in' || currentPath.startsWith('/sign-in/')) {
    return <SignInPage onNavigate={navigate} />;
  }
  if (currentPath === '/sign-up' || currentPath.startsWith('/sign-up/')) {
    return <SignUpPage onNavigate={navigate} />;
  }

  // Blog routes — public, no auth required
  if (currentPath === '/blog' || currentPath === '/blog/') {
    return (
      <BlogListing
        onNavigate={navigate}
        onSignIn={() => navigate('/sign-in')}
        onSignUp={() => navigate('/sign-up')}
      />
    );
  }
  const blogPostMatch = currentPath.match(/^\/blog\/([^/]+)$/);
  if (blogPostMatch) {
    return (
      <BlogPost
        slug={blogPostMatch[1]}
        onNavigate={navigate}
        onSignIn={() => navigate('/sign-in')}
        onSignUp={() => navigate('/sign-up')}
      />
    );
  }

  // Wait for Clerk to determine auth state (prevents flash)
  if (!isLocalHost && !isLoaded) return null;

  if (!isLoggedIn) {
    return (
      <LandingPage
        onSignIn={() => navigate('/sign-in')}
        onSignUp={() => navigate('/sign-up')}
        onNavigate={navigate}
      />
    );
  }

  const renderContent = () => {
    switch (activeTab) {
      case DashboardTab.OVERVIEW:
        return <Overview nodes={nodes} nodesLoading={nodesLoading} isPro={currentUser.isPro} pairingInfo={pairingInfo} onOpenPairing={() => setIsPairingModalOpen(true)} onAddNode={() => setIsAddNodeModalOpen(true)} getNodeSettings={getNodeSettings} fleetKwhRate={settings.fleet.kwhRate} />;
      case DashboardTab.NODES:
        return <NodesList nodes={nodes} getNodeSettings={getNodeSettings} onNavigateToSettings={() => setActiveTab(DashboardTab.SETTINGS)} pairingInfo={pairingInfo} />;
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
      case DashboardTab.SETTINGS:
        return <SettingsView
          nodes={nodes}
          settings={settings}
          savedToast={savedToast}
          getNodeSettings={getNodeSettings}
          updateFleet={updateFleet}
          setNodeOverride={setNodeOverride}
          clearAllOverridesForField={clearAllOverridesForField}
          clearAllNodeOverrides={clearAllNodeOverrides}
          theme={theme}
          onThemeChange={(t) => {
            const effective = t === 'system'
              ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
              : t;
            setTheme(effective);
          }}
          onNavigateToManagement={() => setActiveTab(DashboardTab.NODES)}
          pairingInfo={pairingInfo}
        />;
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
        return <Overview nodes={nodes} nodesLoading={nodesLoading} pairingInfo={pairingInfo} onOpenPairing={() => setIsPairingModalOpen(true)} onAddNode={() => setIsAddNodeModalOpen(true)} getNodeSettings={getNodeSettings} fleetKwhRate={settings.fleet.kwhRate} />;
    }
  };

  return (
    <FleetStreamProvider
      isSignedIn={!!isSignedIn}
      getToken={getToken}
      onNodesSnapshot={handleNodesSnapshot}
    >
      <DashboardShell
        nodes={nodes}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        handleTabChange={handleTabChange}
        currentUser={currentUser}
        currentTenant={currentTenant}
        setCurrentTenant={setCurrentTenant}
        theme={theme}
        toggleTheme={toggleTheme}
        isLocalMode={isLocalMode}
        pairingInfo={pairingInfo}
        permissions={permissions}
        settings={settings}
        savedToast={savedToast}
        getNodeSettings={getNodeSettings}
        updateFleet={updateFleet}
        setNodeOverride={setNodeOverride}
        clearAllOverridesForField={clearAllOverridesForField}
        clearAllNodeOverrides={clearAllNodeOverrides}
        byokMode={byokMode}
        setByokMode={setByokMode}
        userApiKey={userApiKey}
        setUserApiKey={setUserApiKey}
        isUpgradeModalOpen={isUpgradeModalOpen}
        setIsUpgradeModalOpen={setIsUpgradeModalOpen}
        handleUpgrade={handleUpgrade}
        isPairingModalOpen={isPairingModalOpen}
        setIsPairingModalOpen={setIsPairingModalOpen}
        isAddNodeModalOpen={isAddNodeModalOpen}
        setIsAddNodeModalOpen={setIsAddNodeModalOpen}
        handleNodeAdded={handleNodeAdded}
        generatePairingCode={generatePairingCode}
        disconnectFleet={disconnectFleet}
        renderContent={renderContent}
      />
    </FleetStreamProvider>
  );
};

// Thin cloud-build bridge — calls Clerk hooks inside ClerkProvider context.
// Isolated into its own component so useAuth/useUser are never invoked in
// the agent binary where ClerkProvider is absent from the render tree.
const CloudApp: React.FC = () => {
  const { isSignedIn, isLoaded, getToken } = useAuth();
  const { user } = useUser();
  return <AppCore isSignedIn={isSignedIn} isLoaded={isLoaded} getToken={getToken} user={user} />;
};

// Exported root component.
// Agent builds: skip Clerk hooks entirely and render with local-mode defaults.
// Cloud builds: delegate to CloudApp which calls hooks within ClerkProvider.
const App: React.FC = () =>
  IS_AGENT
    ? <AppCore isSignedIn={false} isLoaded={true} getToken={() => Promise.resolve(null)} user={null} />
    : <CloudApp />;

// ── DashboardShell ────────────────────────────────────────────────────────────
// Inner component that lives inside FleetStreamProvider so it can call useFleetStream().
// Renders the sidebar, header, content area (with stale-node banner), and footer.

interface DashboardShellProps {
  nodes: NodeAgent[];
  activeTab: DashboardTab;
  setActiveTab: (t: DashboardTab) => void;
  handleTabChange: (t: DashboardTab) => void;
  currentUser: UserType;
  currentTenant: Tenant;
  setCurrentTenant: (t: Tenant) => void;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  isLocalMode: boolean;
  pairingInfo: PairingInfo | null;
  permissions: ReturnType<typeof usePermissions>;
  settings: ReturnType<typeof useSettings>['settings'];
  savedToast: boolean;
  getNodeSettings: ReturnType<typeof useSettings>['getNodeSettings'];
  updateFleet: ReturnType<typeof useSettings>['updateFleet'];
  setNodeOverride: ReturnType<typeof useSettings>['setNodeOverride'];
  clearAllOverridesForField: ReturnType<typeof useSettings>['clearAllOverridesForField'];
  clearAllNodeOverrides: ReturnType<typeof useSettings>['clearAllNodeOverrides'];
  byokMode: boolean;
  setByokMode: (v: boolean) => void;
  userApiKey: string;
  setUserApiKey: (v: string) => void;
  isUpgradeModalOpen: boolean;
  setIsUpgradeModalOpen: (v: boolean) => void;
  handleUpgrade: () => void;
  isPairingModalOpen: boolean;
  setIsPairingModalOpen: (v: boolean) => void;
  isAddNodeModalOpen: boolean;
  setIsAddNodeModalOpen: (v: boolean) => void;
  handleNodeAdded: () => void;
  generatePairingCode: () => void;
  disconnectFleet: () => void;
  renderContent: () => React.ReactNode;
}

const DashboardShell: React.FC<DashboardShellProps> = (props) => {
  const { connectionState, lastTelemetryMs, lastSeenMsMap } = useFleetStream();
  const {
    nodes, activeTab, handleTabChange, setActiveTab,
    currentUser, currentTenant, setCurrentTenant,
    theme, toggleTheme, isLocalMode, pairingInfo,
    isUpgradeModalOpen, setIsUpgradeModalOpen, handleUpgrade,
    isPairingModalOpen, setIsPairingModalOpen,
    isAddNodeModalOpen, setIsAddNodeModalOpen, handleNodeAdded,
    generatePairingCode, disconnectFleet, renderContent,
  } = props;

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
        onUserChange={() => {}}
        connectionState={connectionState}
        theme={theme}
        isLocalMode={isLocalMode}
        isLocalHost={isLocalHost}
        pairingInfo={pairingInfo}
        onOpenPairing={() => setIsPairingModalOpen(true)}
      />

      <MobileTabBar activeTab={activeTab} setActiveTab={handleTabChange} />
      {/* md:ml-16 — offset for collapsed sidebar rail (w-16 = 64px, fixed position) */}
      <main className="flex-1 flex flex-col overflow-hidden md:ml-16">
        <Header
          activeTab={activeTab}
          tenants={MOCK_TENANTS}
          currentTenant={currentTenant}
          onTenantChange={setCurrentTenant}
          currentUser={currentUser}
          onLogout={() => {}}
          setActiveTab={setActiveTab}
          theme={theme}
          onToggleTheme={toggleTheme}
          connectionState={connectionState}
          pairingInfo={pairingInfo}
          onOpenPairing={isLocalHost ? () => setIsPairingModalOpen(true) : () => setIsAddNodeModalOpen(true)}
          isLocalHost={isLocalHost}
        />

        <div className="flex-1 overflow-y-auto p-4 md:p-6 pb-20 md:pb-6 scroll-smooth">
          <div className="max-w-7xl mx-auto space-y-6">

            {/* Hosted: show stale-node warning if paired node hasn't sent telemetry in >30s */}
            {!isLocalHost && nodes.length > 0 && lastTelemetryMs !== null && (Date.now() - lastTelemetryMs > 30_000) && (
              <div className="w-full bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex items-center gap-3 mb-6">
                <WifiOff className="w-5 h-5 text-amber-500 shrink-0" />
                <div>
                  <h3 className="text-sm font-semibold text-amber-600 dark:text-amber-200">
                    Node {nodes[0].hostname} appears offline
                  </h3>
                  <p className="text-xs text-amber-600/80 dark:text-amber-500/80">
                    Last seen {new Date(lastTelemetryMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} — make sure the Wicklee agent is running on this machine.
                  </p>
                </div>
              </div>
            )}
            {renderContent()}
          </div>
        </div>

        <footer className="h-8 border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 flex items-center justify-between text-xs text-gray-500 transition-colors">
          <div className="flex items-center gap-4">
            {isLocalHost ? (
              <span className="flex items-center gap-1.5">
                <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span>
                Local
              </span>
            ) : (
              (() => {
                const ftNow = Date.now();
                const total = nodes.length;
                const online = nodes.filter(n => {
                  const ls = lastSeenMsMap[n.id];
                  return ls != null && ftNow - ls <= NODE_REACHABLE_MS;
                }).length;
                const dotColor = total === 0 ? 'bg-gray-500'
                  : online === total ? 'bg-green-500'
                  : online > 0       ? 'bg-amber-500'
                  : 'bg-red-500';
                const textColor = total === 0 ? ''
                  : online === total ? 'text-green-600 dark:text-green-400'
                  : online > 0       ? 'text-amber-500 dark:text-amber-400'
                  : 'text-red-600 dark:text-red-400';
                const tooltip = nodes.map(n => {
                  const ls = lastSeenMsMap[n.id];
                  const alive = ls != null && ftNow - ls <= NODE_REACHABLE_MS;
                  const label = ls != null
                    ? alive ? '● online' : `● offline · last seen ${fmtNodeAgo(ls)}`
                    : '● pending';
                  return `${n.hostname !== n.id ? n.hostname : n.id}  ${label}`;
                }).join('\n');
                return (
                  <span className="flex items-center gap-1.5" title={tooltip || undefined}>
                    <span className="relative flex h-2 w-2">
                      {online === total && total > 0 && (
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                      )}
                      <span className={`relative inline-flex rounded-full h-2 w-2 ${dotColor}`}></span>
                    </span>
                    <span className={textColor}>Fleet: {online} / {total} online</span>
                  </span>
                );
              })()
            )}
          </div>
          <div className="flex items-center gap-4">
            {/* VITE_AGENT_VERSION is injected by the Rust build script from Cargo.toml
                (e.g. VITE_AGENT_VERSION=0.5.1 npm run build). Falls back to package.json
                version for the cloud/dev build. */}
            <span className="mono">v{(import.meta.env.VITE_AGENT_VERSION as string | undefined) ?? version}</span>
          </div>
        </footer>
      </main>
    </div>
  );
};

export default App;