import React, { useState, useEffect, useRef, useCallback } from 'react';
import { version } from '../package.json';
import { LayoutGrid, Server, Activity, Terminal, BrainCircuit, ShieldCheck, Thermometer, Cpu, Wifi, WifiOff, RefreshCw } from 'lucide-react';
// NOTE: @clerk/clerk-react is NOT imported here. It's lazy-loaded via
// CloudApp.tsx to prevent Clerk's module init from running in agent builds.
import { ConnectionState, DashboardTab, FleetNode, NodeAgent, PairingInfo, Tenant, User as UserType, SubscriptionTier, ObservabilityNavParams } from './types';
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
// SignInPage/SignUpPage import @clerk/clerk-react — lazy-load to keep Clerk
// out of the agent bundle.
const SignInPage = React.lazy(() => import('./components/SignInPage'));
const SignUpPage = React.lazy(() => import('./components/SignUpPage'));
import ProfileView from './components/ProfileView';
import SecurityView from './components/SecurityView';
const APIKeysView = React.lazy(() => import('./components/APIKeysView'));
import PreferencesView from './components/PreferencesView';
import SettingsView from './components/SettingsView';
import { useSettings } from './hooks/useSettings';
import PricingPage from './components/PricingPage';
import MetricsPage from './pages/MetricsPage';
import DocsPage from './pages/DocsPage';
import LegalPage from './pages/LegalPage';
import AIProvidersView from './components/AIProvidersView';
import PairingModal from './components/PairingModal';
const AddNodeModal = React.lazy(() => import('./components/AddNodeModal'));
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
            <h2 className="text-2xl font-bold text-white">Unlock Wicklee Pro</h2>
            <p className="text-gray-400 text-sm">
              Upgrade to Wicklee Pro to connect unlimited nodes and unlock Accelerator-tier patterns across your entire fleet.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 text-left">
            {[
              { icon: Zap, title: 'Unlimited Fleet Nodes', desc: 'Connect 4+ nodes — no restrictions on active fleet size.' },
              { icon: Shield, title: 'Full Alert Wiring', desc: 'Slack + email alerts for all pattern engine events.' },
              { icon: Globe, title: 'API Access (600 req/min)', desc: 'Build automation on live fleet telemetry via REST API.' }
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
              Upgrade to Pro
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
//
// Three modes:
//   unset / ''  → direct backend URL (dev, agent builds)
//   '/'         → empty string = same-origin; nginx proxies /api/* to backend
//   'https://…' → explicit absolute URL
//
// In the Railway frontend service set VITE_CLOUD_URL=/ to enable the nginx
// reverse proxy so all API calls flow through wicklee.dev/api/* instead of
// crossing origins (eliminates CORS, hides the backend URL from the client).
const CLOUD_URL = (() => {
  const v = (import.meta.env.VITE_CLOUD_URL as string) ?? '';
  if (!v) return 'https://wicklee.dev';
  if (v === '/') return '';   // same-origin proxy mode — nginx handles routing
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
  /** Clerk organization ID when user has an active org (Team+ shared fleet). Null for solo users. */
  orgId?: string | null;
}

const AppCore: React.FC<AppCoreProps> = ({ isSignedIn, isLoaded, getToken, user, orgId = null }) => {

  const [currentPath, setCurrentPath] = useState(() => window.location.pathname);
  const [activeTab, setActiveTab] = useState<DashboardTab>(DashboardTab.OVERVIEW);
  const [observabilityNav, setObservabilityNav] = useState<ObservabilityNavParams | undefined>(undefined);
  const [nodes, setNodes] = useState<NodeAgent[]>([]);
  // True until the first /api/fleet fetch settles (or Clerk hasn't loaded yet).
  // Prevents EmptyFleetState from flashing on page refresh while auth resolves.
  const [nodesLoading, setNodesLoading] = useState(!isLocalHost);
  const [currentTenant, setCurrentTenant] = useState<Tenant>(MOCK_TENANTS[0]);
  // Build currentUser from Clerk user data (or LOCAL_USER for localhost).
  // tier is read from Clerk publicMetadata.tier — set this in the Clerk
  // Dashboard (Users → select user → Metadata → Public) to gate features.
  // Valid values: "community" | "pro" | "team" | "enterprise"
  const clerkTier = (user?.publicMetadata?.tier as SubscriptionTier | undefined) ?? 'community';
  const currentUser: UserType = isLocalHost
    ? LOCAL_USER
    : {
        id: user?.id ?? 'local',
        email: user?.primaryEmailAddress?.emailAddress ?? '',
        fullName: user?.fullName ?? '',
        role: 'Owner',
        isPro: clerkTier !== 'community',
        tier: clerkTier,
      };
  const [byokMode, setByokMode] = useState(false);
  const [userApiKey, setUserApiKey] = useState('');
  const [isUpgradeModalOpen, setIsUpgradeModalOpen] = useState(false);
  const [pairingInfo, setPairingInfo] = useState<PairingInfo | null>(null);
  const [isPairingModalOpen, setIsPairingModalOpen] = useState(false);
  const [isAddNodeModalOpen, setIsAddNodeModalOpen] = useState(false);
  // Dark mode only — "Hardware-Centric Dark" design language.
  const theme: 'dark' = 'dark';
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
          restricted: n.restricted ?? false,
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

  // Bootstrap local node on localhost — pairingInfo provides the node_id, and
  // /api/metrics provides hostname + hardware data.  Without this, nodes[] stays
  // empty and per-node Settings (idle watts, overrides) are never shown.
  useEffect(() => {
    if (!isLocalHost || !pairingInfo?.node_id) return;
    const nid = pairingInfo.node_id;
    // Avoid duplicate if already populated (e.g. from a subsequent WS frame).
    setNodes(prev => {
      if (prev.some(n => n.id === nid)) return prev;
      return [{
        id: nid,
        hostname: nid,
        ip: nid,
        status: 'online' as const,
        gpuTemp: null,
        vramUsed: null,
        vramTotal: null,
        powerUsage: null,
        requestsPerSecond: 0,
        activeInterceptors: [],
        uptime: '—',
        sentinelActive: false,
        restricted: false,
      }];
    });
  }, [isLocalHost, pairingInfo?.node_id]);

  // Callback for FleetStreamProvider — patches node hostnames and restricted flag when real metrics arrive.
  const handleNodesSnapshot = useCallback((snapshot: FleetNode[]) => {
    setNodes(prev => prev.map(node => {
      const match = snapshot.find(n => n.node_id === node.id);
      if (!match) return node;
      const updates: Partial<typeof node> = {};
      // Prefer display_name (Pro+ custom name) > metrics.hostname > node_id
      const resolvedHostname = match.display_name ?? match.metrics?.hostname ?? node.id;
      if (resolvedHostname !== node.hostname) {
        updates.hostname = resolvedHostname;
      }
      if (match.restricted !== undefined && match.restricted !== node.restricted) {
        updates.restricted = match.restricted;
      }
      return Object.keys(updates).length > 0 ? { ...node, ...updates } : node;
    }));
  }, []);

  const permissions = usePermissions(currentUser);
  // Build-time flag: true when compiled for the local agent binary (VITE_BUILD_TARGET=agent).
  // This is the sole source of truth for Cockpit vs Mission Control mode — never derived
  // from runtime auth state or pairing status.
  const isLocalMode = (import.meta.env.VITE_BUILD_TARGET as string) === 'agent';

  const fetchPairingStatus = useCallback(async () => {
    // /api/pair/status only exists on the agent (localhost:7700).
    // On wicklee.dev this endpoint 404s — skip entirely.
    if (!isLocalHost) return;
    try {
      const r = await fetch('/api/pair/status');
      if (r.ok) setPairingInfo(await r.json());
    } catch {}
  }, []);

  const generatePairingCode = useCallback(async () => {
    if (!isLocalHost) return;
    try {
      const r = await fetch('/api/pair/generate', { method: 'POST' });
      if (r.ok) setPairingInfo(await r.json());
    } catch {}
  }, []);

  const disconnectFleet = useCallback(async () => {
    if (!isLocalHost) return;
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


  // Always force dark mode class on the document
  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  const isLoggedIn = isLocalHost || !!isSignedIn;


  const handleCheckoutTier = useCallback(async (tier: 'pro' | 'team') => {
    try {
      const token = await getToken();
      const r = await fetch(`${CLOUD_URL}/api/billing/config`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return;
      const config = await r.json() as {
        environment: 'sandbox' | 'production';
        client_token: string;
        prices: { pro: string; team: string };
        custom_data: { user_id: string };
        customer_email: string | null;
      };

      const Paddle = window.Paddle;
      if (!Paddle) {
        console.error('[billing] Paddle.js not loaded');
        return;
      }

      // Initialize Paddle with client token (idempotent).
      // Environment must be set separately — it's not a valid Initialize() option.
      Paddle.Environment.set(config.environment);
      Paddle.Initialize({ token: config.client_token });

      const priceId = tier === 'team' ? config.prices.team : config.prices.pro;
      Paddle.Checkout.open({
        items: [{ priceId, quantity: tier === 'team' ? 3 : 1 }],
        customData: config.custom_data,
        customer: currentUser.email ? { email: currentUser.email } : undefined,
        settings: {
          displayMode: 'overlay',
          theme: 'dark',
          successUrl: `${window.location.origin}/dashboard?upgraded=1`,
        },
      });
    } catch (e) {
      console.error('[billing] checkout failed:', e);
    }
  }, [getToken]);

  const handleUpgrade = useCallback(async () => {
    setIsUpgradeModalOpen(false);
    await handleCheckoutTier('pro');
  }, [handleCheckoutTier]);

  const handleToggleSentinel = (nodeId: string) => {
    setNodes(prev => prev.map(node => 
      node.id === nodeId ? { ...node, sentinelActive: !node.sentinelActive } : node
    ));
  };

  const handleTabChange = (tab: DashboardTab) => {
    setActiveTab(tab);
  };

  const toggleTheme = () => {}; // Dark mode only — no-op

  // Clerk sign-in / sign-up routes
  if (currentPath === '/sign-in' || currentPath.startsWith('/sign-in/')) {
    return <React.Suspense fallback={null}><SignInPage onNavigate={navigate} /></React.Suspense>;
  }
  if (currentPath === '/sign-up' || currentPath.startsWith('/sign-up/')) {
    return <React.Suspense fallback={null}><SignUpPage onNavigate={navigate} /></React.Suspense>;
  }

  // Metrics reference route — public, no auth required
  if (currentPath === '/metrics') {
    return <MetricsPage onNavigate={navigate} />;
  }

  // Documentation route — public, no auth required (trailing slash tolerant)
  if (currentPath === '/docs' || currentPath === '/docs/') {
    return <DocsPage onNavigate={navigate} />;
  }

  // Legal routes — public, no auth required
  if (currentPath === '/terms' || currentPath === '/terms/') {
    return <LegalPage onNavigate={navigate} initialTab="terms" />;
  }
  if (currentPath === '/privacy' || currentPath === '/privacy/') {
    return <LegalPage onNavigate={navigate} initialTab="privacy" />;
  }
  if (currentPath === '/refund' || currentPath === '/refund/') {
    return <LegalPage onNavigate={navigate} initialTab="refund" />;
  }

  // Pricing route — public, accessible logged in or out
  if (currentPath === '/pricing' || currentPath === '/pricing/') {
    return (
      <PricingPage
        currentTier={permissions.subscriptionTier}
        isLoggedIn={isLoggedIn}
        onNavigate={navigate}
        onCheckout={handleCheckoutTier}
        onSignIn={() => navigate('/sign-in')}
        onSignUp={() => navigate('/sign-up')}
      />
    );
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
        return <Overview nodes={nodes} nodesLoading={nodesLoading} isPro={currentUser.isPro} pairingInfo={pairingInfo} onOpenPairing={() => setIsPairingModalOpen(true)} onAddNode={() => setIsAddNodeModalOpen(true)} onUpgrade={() => setIsUpgradeModalOpen(true)} getNodeSettings={getNodeSettings} fleetKwhRate={settings.fleet.kwhRate} getToken={isLocalHost ? undefined : getToken} onNavigateToObservability={(params?: ObservabilityNavParams) => { setObservabilityNav(params); setActiveTab(DashboardTab.TRACES); }} />;
      case DashboardTab.NODES:
        return <NodesList nodes={nodes} getNodeSettings={getNodeSettings} onNavigateToSettings={() => setActiveTab(DashboardTab.SETTINGS)} pairingInfo={pairingInfo} getToken={isLocalHost ? undefined : getToken} cloudUrl={isLocalHost ? undefined : CLOUD_URL} onNodesRemoved={handleNodeAdded} />;
      case DashboardTab.TRACES:
        return <TracesView nodes={nodes} tenantId={currentTenant.id} pairingInfo={pairingInfo} getToken={isLocalHost ? undefined : getToken} subscriptionTier={permissions.subscriptionTier} getNodeSettings={getNodeSettings} navParams={observabilityNav} onNavConsumed={() => setObservabilityNav(undefined)} />;
      case DashboardTab.SCAFFOLDING:
        return permissions.canViewScaffolding ? <ScaffoldingView /> : <div className="text-center py-20 text-gray-500">Unauthorized Access</div>;
      case DashboardTab.AI_INSIGHTS:
        return permissions.canRunAIAnalysis ? (
          <AIInsights
            nodes={nodes}
            insightsTier={permissions.insightsTier}
            canViewInsight={permissions.canViewInsight}
            getToken={getToken}
            historyDays={permissions.historyDays}
            subscriptionTier={permissions.subscriptionTier}
            onNavigateToObservability={(params?: ObservabilityNavParams) => {
              setObservabilityNav(params);
              setActiveTab(DashboardTab.TRACES);
            }}
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
          onThemeChange={() => {}} // Dark mode only
          onNavigateToManagement={() => setActiveTab(DashboardTab.NODES)}
          onNavigateToApiKeys={() => setActiveTab(DashboardTab.API_KEYS)}
          onNavigateToPricing={() => navigate('/pricing')}
          pairingInfo={pairingInfo}
          getToken={getToken}
          subscriptionTier={clerkTier}
          isLocalHost={isLocalHost}
        />;
      case DashboardTab.PROFILE:
        return <ProfileView currentUser={currentUser} />;
      case DashboardTab.SECURITY:
        return <SecurityView byokMode={byokMode} setByokMode={setByokMode} userApiKey={userApiKey} setUserApiKey={setUserApiKey} pairingInfo={pairingInfo} onOpenPairing={() => setIsPairingModalOpen(true)} onGenerateCode={generatePairingCode} onDisconnect={disconnectFleet} />;
      case DashboardTab.API_KEYS:
        return <React.Suspense fallback={null}><APIKeysView /></React.Suspense>;
      case DashboardTab.PREFERENCES:
        return <PreferencesView currentTenant={currentTenant} theme={theme} />;
      case DashboardTab.PRICING:
        return <PricingPage currentTier={permissions.subscriptionTier} isLoggedIn={isLoggedIn} onNavigate={navigate} onCheckout={handleCheckoutTier} embedded />;
      case DashboardTab.AI_PROVIDERS:
        return <AIProvidersView />;
      case DashboardTab.BILLING:
        return <PricingPage currentTier={permissions.subscriptionTier} isLoggedIn={isLoggedIn} onNavigate={navigate} onCheckout={handleCheckoutTier} embedded />;
      default:
        return <Overview nodes={nodes} nodesLoading={nodesLoading} pairingInfo={pairingInfo} onOpenPairing={() => setIsPairingModalOpen(true)} onAddNode={() => setIsAddNodeModalOpen(true)} onUpgrade={() => setIsUpgradeModalOpen(true)} getNodeSettings={getNodeSettings} fleetKwhRate={settings.fleet.kwhRate} />;
    }
  };

  return (
    <FleetStreamProvider
      isSignedIn={!!isSignedIn}
      getToken={getToken}
      orgId={orgId}
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
        navigate={navigate}
      />
    </FleetStreamProvider>
  );
};

// Lazy-loaded Clerk bridge — keeps @clerk/clerk-react out of the agent bundle.
const LazyCloudApp = React.lazy(() => import('./components/CloudApp'));

// Exported root component.
// Agent builds: skip Clerk hooks entirely and render with local-mode defaults.
// Cloud builds: delegate to CloudApp which calls hooks within ClerkProvider.
const App: React.FC = () =>
  IS_AGENT
    ? <AppCore isSignedIn={false} isLoaded={true} getToken={() => Promise.resolve(null)} user={null} />
    : <React.Suspense fallback={null}><LazyCloudApp AppCore={AppCore} /></React.Suspense>;

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
  navigate: (path: string) => void;
}

const DashboardShell: React.FC<DashboardShellProps> = (props) => {
  const { connectionState, lastTelemetryMs, lastSeenMsMap, allNodeMetrics } = useFleetStream();

  // On localhost, FleetStreamContext doesn't populate allNodeMetrics (the WS
  // lives in Overview.tsx). Fetch agent_version directly via a one-shot API call.
  const [localAgentVersionDirect, setLocalAgentVersionDirect] = useState<string | undefined>();
  useEffect(() => {
    if (!isLocalHost) return;
    fetch('/api/metrics')
      .then(r => r.ok ? r.json() : null)
      .then((d: Record<string, unknown> | null) => {
        if (d && typeof d.agent_version === 'string') {
          setLocalAgentVersionDirect(d.agent_version);
        }
      })
      .catch(() => {});
  }, []);

  const localAgentVersion = isLocalHost
    ? localAgentVersionDirect
    : Object.values(allNodeMetrics)[0]?.agent_version;
  const [versionBannerDismissed, setVersionBannerDismissed] = useState(false);
  const showVersionBanner = isLocalHost
    && !versionBannerDismissed
    && localAgentVersion != null
    && localAgentVersion !== version;
  const {
    nodes, activeTab, handleTabChange, setActiveTab,
    currentUser, currentTenant, setCurrentTenant,
    theme, toggleTheme, isLocalMode, pairingInfo,
    isUpgradeModalOpen, setIsUpgradeModalOpen, handleUpgrade,
    isPairingModalOpen, setIsPairingModalOpen,
    isAddNodeModalOpen, setIsAddNodeModalOpen, handleNodeAdded,
    generatePairingCode, disconnectFleet, renderContent, navigate,
  } = props;

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 font-sans transition-colors duration-300">
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
      <React.Suspense fallback={null}>
        <AddNodeModal
          isOpen={isAddNodeModalOpen}
          onClose={() => setIsAddNodeModalOpen(false)}
          onNodeAdded={handleNodeAdded}
          cloudUrl={CLOUD_URL}
        />
      </React.Suspense>
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
        onNavigate={navigate}
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

        {/* Version mismatch banner — appears when browser has a cached UI older than the running agent */}
        {showVersionBanner && (
          <div className="flex items-center gap-3 px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/25 text-amber-300 text-xs">
            <RefreshCw className="w-3.5 h-3.5 shrink-0 text-amber-400" />
            <span className="flex-1">
              UI out of date — browser is running <span className="font-mono">v{version}</span> but the agent is <span className="font-mono">v{localAgentVersion}</span>. Hard-reload to get the latest interface.
            </span>
            <button
              onClick={() => window.location.reload()}
              className="px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 font-mono transition-colors"
            >
              Reload
            </button>
            <button onClick={() => setVersionBannerDismissed(true)} className="text-amber-500/60 hover:text-amber-400 transition-colors ml-1">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

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
            <div key={activeTab}>{renderContent()}</div>
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
            {/* Version display removed — was unreliable across cloud/agent builds */}
          </div>
        </footer>
      </main>
    </div>
  );
};

export default App;