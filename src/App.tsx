import React, { useState, useEffect, useCallback, useRef } from 'react';
import { version } from '../package.json';
import { WifiOff, RefreshCw } from 'lucide-react';
import { DashboardTab, FleetNode, NodeAgent, PairingInfo, Tenant, User as UserType, SubscriptionTier, ObservabilityNavParams } from './types';
import { NODE_REACHABLE_MS, fmtAgo } from './utils/time';
import { FleetStreamProvider, useFleetStream } from './contexts/FleetStreamContext';
import { CLOUD_URL } from './utils/cloudUrl';
import { hasClerkSessionHint } from './cloud/utils/clerkHint';
import { perfMark } from './utils/perfMark';
import { IS_AGENT, IS_LOCAL_HOST as isLocalHost, SITE_URL } from './utils/buildTarget';
import { roleFromOrgMembership } from './utils/role';
import { isProOrAbove } from './utils/tier';
import Sidebar from './components/Sidebar';
import MobileTabBar from './components/MobileTabBar';
import Header from './components/Header';
const Absent = (() => null) as never;
const Overview = React.lazy(() => import('./components/Overview'));
const ModelsPage = React.lazy(() => import('./components/ModelsPage'));
const NodesList = React.lazy(() => import('./components/NodesList'));
const TracesView = React.lazy(() => import('./components/TracesView'));
const AIInsights = React.lazy(() => import('./components/AIInsights'));
const TeamManagement = IS_AGENT ? Absent : React.lazy(() => import('./cloud/TeamManagement'));
import LandingPage from './site/LandingPage';
const SignInPage = IS_AGENT ? Absent : React.lazy(() => import('./cloud/SignInPage'));
const SignUpPage = IS_AGENT ? Absent : React.lazy(() => import('./cloud/SignUpPage'));
const APIKeysView = IS_AGENT ? Absent : React.lazy(() => import('./cloud/APIKeysView'));
const SettingsView = React.lazy(() => import('./components/SettingsView'));
import { useSettings } from './hooks/useSettings';
const MetricsPage        = React.lazy(() => import('./pages/MetricsPage'));
const DocsPage           = IS_AGENT ? Absent : React.lazy(() => import('./site/DocsPage'));
const LegalPage          = IS_AGENT ? Absent : React.lazy(() => import('./site/LegalPage'));
const TrustPage          = IS_AGENT ? Absent : React.lazy(() => import('./site/TrustPage'));
import PairingModal from './components/PairingModal';
const AddNodeModal = IS_AGENT ? Absent : React.lazy(() => import('./cloud/AddNodeModal'));
import { usePermissions } from './hooks/usePermissions';
const BlogListing        = IS_AGENT ? Absent : React.lazy(() => import('./site/BlogListing'));
const BlogPost           = IS_AGENT ? Absent : React.lazy(() => import('./site/BlogPost'));

/** Shown while a lazy marketing page's chunk is in flight. Deliberately not
 *  null: on the prerendered routes React has already cleared the static
 *  block by the time this renders, and a blank page reads as broken. */
const PageFallback: React.FC = () => (
  <div className="min-h-screen bg-gray-900 flex items-center justify-center" aria-busy="true" aria-live="polite">
    <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
  </div>
);
const lazyPage = (el: React.ReactElement) => (
  <React.Suspense fallback={<PageFallback />}>{el}</React.Suspense>
);
import { X } from 'lucide-react';
import { STATIC_PAGE_META, setPageMeta, normalizePath } from './utils/pageMeta';

const MOCK_TENANTS: Tenant[] = [
  { id: 'tnt-01', name: 'Wicklee Dev Ops' },
  { id: 'tnt-02', name: 'Acme AI Research' }
];

const LOCAL_USER: UserType = {
  id: 'local',
  email: '',
  fullName: '',
  role: 'Owner',
  isPro: false,
};


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
  /** Clerk membership role in the active org (e.g. 'org:admin'); null for solo users. */
  orgRole?: string | null;
}

const AppCore: React.FC<AppCoreProps> = ({ isSignedIn, isLoaded, getToken, user, orgId = null, orgRole = null }) => {

  const [currentPath, setCurrentPath] = useState(() => window.location.pathname);
  const [activeTab, setActiveTab] = useState<DashboardTab>(DashboardTab.OVERVIEW);
  useEffect(() => { perfMark('wk:app-mounted'); }, []);
  const [observabilityNav, setObservabilityNav] = useState<ObservabilityNavParams | undefined>(undefined);
  /**
   * Deep-link target for cross-tab navigation into Insights.
   * Shape: { tab: 'triage' | 'performance' | 'forensics'; scrollTo?: string }
   * Set when a user clicks something on Overview that should land on a
   * specific Insights sub-tab + scroll to a specific anchor (e.g. the
   * Model Fit summary strip → Insights → Performance → ModelFitAnalysis).
   * Consumed by AIInsights on mount, then cleared.
   */
  const [insightsDeepLink, setInsightsDeepLink] = useState<{ tab: 'triage' | 'performance' | 'forensics'; scrollTo?: string } | undefined>(undefined);
  const [nodes, setNodes] = useState<NodeAgent[]>([]);
  const [nodesLoading, setNodesLoading] = useState(!isLocalHost);
  const [currentTenant, setCurrentTenant] = useState<Tenant>(MOCK_TENANTS[0]);
  const clerkTier = (user?.publicMetadata?.tier as SubscriptionTier | undefined) ?? 'community';
  const currentUser: UserType = isLocalHost
    ? LOCAL_USER
    : {
        id: user?.id ?? 'local',
        email: user?.primaryEmailAddress?.emailAddress ?? '',
        fullName: user?.fullName ?? '',
        role: roleFromOrgMembership(orgId, orgRole),
        isPro: isProOrAbove(clerkTier),
        tier: clerkTier,
      };
  const [pairingInfo, setPairingInfo] = useState<PairingInfo | null>(null);
  const [isPairingModalOpen, setIsPairingModalOpen] = useState(false);
  const [isAddNodeModalOpen, setIsAddNodeModalOpen] = useState(false);
  const theme = 'dark' as const;
  const { settings, savedToast, getNodeSettings, updateFleet, setNodeOverride, clearAllOverridesForField, clearAllNodeOverrides } = useSettings();

  const navigate = useCallback((path: string) => {
    if (IS_AGENT && path !== '/' && !path.startsWith('/metrics')) {
      window.open(`${SITE_URL}${path}`, '_blank', 'noopener');
      return;
    }
    window.history.pushState(null, '', path);
    setCurrentPath(window.location.pathname);
  }, []);

  useEffect(() => {
    const onPopState = () => setCurrentPath(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const meta = STATIC_PAGE_META[normalizePath(currentPath)];
    if (meta) setPageMeta(meta);
  }, [currentPath]);

  useEffect(() => {
    if (!isSignedIn && !isLocalHost) return;
    void import('./utils/perplexity').then(m => m.loadPerplexityBaseline());
  }, [isSignedIn]);


  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const fleetFetchSeqRef = useRef(0);

  const handleNodeAdded = useCallback(async () => {
    const seq = ++fleetFetchSeqRef.current;
    try {
      const token = isLocalHost ? null : await getTokenRef.current();
      const r = await fetch(`${CLOUD_URL}/api/fleet`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (r.ok) {
        const data = await r.json();
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
        if (seq === fleetFetchSeqRef.current) setNodes(mappedNodes);
      }
    } catch {
    } finally {
      if (seq === fleetFetchSeqRef.current) setNodesLoading(false);
    }
  }, []);

  const prevFleetScopeRef = useRef(`${isSignedIn}:${orgId}`);
  useEffect(() => {
    if (isLocalHost) return;
    const scope = `${isSignedIn}:${orgId}`;
    if (prevFleetScopeRef.current !== scope) {
      prevFleetScopeRef.current = scope;
      fleetFetchSeqRef.current++;
      setNodes([]);
      setNodesLoading(isSignedIn);
    }
    if (!isSignedIn) return;
    handleNodeAdded();
  }, [isSignedIn, orgId, handleNodeAdded]);

  useEffect(() => {
    if (!isLocalHost || !pairingInfo?.node_id) return;
    const nid = pairingInfo.node_id;
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
  }, [pairingInfo?.node_id]);

  const handleNodesSnapshot = useCallback((snapshot: FleetNode[]) => {
    setNodes(prev => {
      const byId = new Map(snapshot.map(n => [n.node_id, n]));
      let changed = false;
      const next = prev.map(node => {
        const match = byId.get(node.id);
        if (!match) return node;
        const updates: Partial<typeof node> = {};
        const resolvedHostname = match.display_name ?? match.metrics?.hostname ?? node.id;
        if (resolvedHostname !== node.hostname) {
          updates.hostname = resolvedHostname;
        }
        if (match.restricted !== undefined && match.restricted !== node.restricted) {
          updates.restricted = match.restricted;
        }
        if (Object.keys(updates).length === 0) return node;
        changed = true;
        return { ...node, ...updates };
      });
      return changed ? next : prev;
    });
  }, []);

  const permissions = usePermissions(currentUser);
  const fetchPairingStatus = useCallback(async () => {
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


  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  const isLoggedIn = isLocalHost || !!isSignedIn;


  const handleTabChange = (tab: DashboardTab) => {
    setActiveTab(tab);
  };

  const toggleTheme = () => {};

  if (
    currentPath === '/metrics-reference' || currentPath === '/metrics-reference/' ||
    currentPath === '/metrics' || currentPath === '/metrics/'
  ) {
    return lazyPage(<MetricsPage onNavigate={navigate} />);
  }

  if (!IS_AGENT) {
    if (currentPath === '/sign-in' || currentPath.startsWith('/sign-in/')) {
      return <React.Suspense fallback={null}><SignInPage onNavigate={navigate} /></React.Suspense>;
    }
    if (currentPath === '/sign-up' || currentPath.startsWith('/sign-up/')) {
      return <React.Suspense fallback={null}><SignUpPage onNavigate={navigate} /></React.Suspense>;
    }

    if (currentPath === '/docs' || currentPath === '/docs/') {
      return lazyPage(<DocsPage onNavigate={navigate} />);
    }

    if (currentPath === '/trust' || currentPath === '/trust/') {
      return lazyPage(<TrustPage onNavigate={navigate} />);
    }

    if (currentPath === '/terms' || currentPath === '/terms/') {
      return lazyPage(<LegalPage onNavigate={navigate} initialTab="terms" />);
    }
    if (currentPath === '/privacy' || currentPath === '/privacy/') {
      return lazyPage(<LegalPage onNavigate={navigate} initialTab="privacy" />);
    }
    if (currentPath === '/refund' || currentPath === '/refund/') {
      return lazyPage(<LegalPage onNavigate={navigate} initialTab="refund" />);
    }

    if (currentPath === '/blog' || currentPath === '/blog/') {
      return lazyPage(
        <BlogListing onNavigate={navigate} />,
      );
    }
    const blogPostMatch = currentPath.match(/^\/blog\/([^/]+?)\/?$/);
    if (blogPostMatch) {
      return lazyPage(
        <BlogPost slug={blogPostMatch[1]} onNavigate={navigate} />,
      );
    }
  }

  if (!isLocalHost && !isLoaded && hasClerkSessionHint(document.cookie)) return null;

  if (!IS_AGENT && !isLoggedIn) {
    return (
      <LandingPage onNavigate={navigate} />
    );
  }

  const renderContent = () => {
    switch (activeTab) {
      case DashboardTab.OVERVIEW:
        return <Overview nodes={nodes} nodesLoading={nodesLoading} pairingInfo={pairingInfo} onOpenPairing={() => setIsPairingModalOpen(true)} onAddNode={() => setIsAddNodeModalOpen(true)} getNodeSettings={getNodeSettings} fleetKwhRate={settings.fleet.kwhRate} onNavigateToObservability={(params?: ObservabilityNavParams) => { setObservabilityNav(params); setActiveTab(DashboardTab.TRACES); }} onNavigateToInsights={(tab, scrollTo) => { setInsightsDeepLink({ tab, scrollTo }); setActiveTab(DashboardTab.AI_INSIGHTS); }} />;
      case DashboardTab.MODELS:
        return <ModelsPage isLocalHost={isLocalHost} getToken={isLocalHost ? undefined : getToken} nodes={nodes} onNavigateToInsightsPerformance={permissions.canRunAIAnalysis ? () => { setInsightsDeepLink({ tab: 'performance' }); setActiveTab(DashboardTab.AI_INSIGHTS); } : undefined} />;
      case DashboardTab.NODES:
        return <NodesList nodes={nodes} getNodeSettings={getNodeSettings} onNavigateToSettings={() => setActiveTab(DashboardTab.SETTINGS)} pairingInfo={pairingInfo} getToken={isLocalHost ? undefined : getToken} cloudUrl={isLocalHost ? undefined : CLOUD_URL} onNodesRemoved={handleNodeAdded} />;
      case DashboardTab.TRACES:
        return <TracesView nodes={nodes} tenantId={currentTenant.id} pairingInfo={pairingInfo} getToken={isLocalHost ? undefined : getToken} subscriptionTier={permissions.subscriptionTier} getNodeSettings={getNodeSettings} navParams={observabilityNav} onNavConsumed={() => setObservabilityNav(undefined)} />;
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
            deepLink={insightsDeepLink}
            onDeepLinkConsumed={() => setInsightsDeepLink(undefined)}
            onNavigateToModels={() => setActiveTab(DashboardTab.MODELS)}
          />
        ) : (
          <div className="text-center py-20 text-gray-500">Unauthorized Access</div>
        );
      case DashboardTab.TEAM:
        return !IS_AGENT && permissions.canManageTeam ? <TeamManagement tenantId={currentTenant.id} currentUser={currentUser} orgId={orgId} /> : <div className="text-center py-20 text-gray-500">Unauthorized Access</div>;
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
          onNavigateToManagement={() => setActiveTab(DashboardTab.NODES)}
          onNavigateToApiKeys={() => setActiveTab(DashboardTab.API_KEYS)}
          pairingInfo={pairingInfo}
          getToken={getToken}
          subscriptionTier={clerkTier}
          isLocalHost={isLocalHost}
        />;
      case DashboardTab.API_KEYS:
        return IS_AGENT ? null : <React.Suspense fallback={null}><APIKeysView /></React.Suspense>;
      default:
        return <Overview nodes={nodes} nodesLoading={nodesLoading} pairingInfo={pairingInfo} onOpenPairing={() => setIsPairingModalOpen(true)} onAddNode={() => setIsAddNodeModalOpen(true)} getNodeSettings={getNodeSettings} fleetKwhRate={settings.fleet.kwhRate} />;
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
        pairingInfo={pairingInfo}
        permissions={permissions}
        settings={settings}
        savedToast={savedToast}
        getNodeSettings={getNodeSettings}
        updateFleet={updateFleet}
        setNodeOverride={setNodeOverride}
        clearAllOverridesForField={clearAllOverridesForField}
        clearAllNodeOverrides={clearAllNodeOverrides}
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

interface AppProps {
  /** Cloud builds only: the Clerk-hooks bridge from cloud/CloudApp. */
  cloudApp?: React.FC<{ AppCore: React.FC<AppCoreProps> }>;
}

const App: React.FC<AppProps> = ({ cloudApp: CloudApp }) => {
  if (IS_AGENT || !CloudApp) {
    return <AppCore isSignedIn={false} isLoaded={true} getToken={() => Promise.resolve(null)} user={null} />;
  }
  return <CloudApp AppCore={AppCore} />;
};

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
  pairingInfo: PairingInfo | null;
  permissions: ReturnType<typeof usePermissions>;
  settings: ReturnType<typeof useSettings>['settings'];
  savedToast: boolean;
  getNodeSettings: ReturnType<typeof useSettings>['getNodeSettings'];
  updateFleet: ReturnType<typeof useSettings>['updateFleet'];
  setNodeOverride: ReturnType<typeof useSettings>['setNodeOverride'];
  clearAllOverridesForField: ReturnType<typeof useSettings>['clearAllOverridesForField'];
  clearAllNodeOverrides: ReturnType<typeof useSettings>['clearAllNodeOverrides'];
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

  const [localAgentVersionDirect, setLocalAgentVersionDirect] = useState<string | undefined>();
  useEffect(() => {
    if (!isLocalHost) return;
    fetch('/api/metrics/snapshot')
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
    theme, toggleTheme, pairingInfo,
    isPairingModalOpen, setIsPairingModalOpen,
    isAddNodeModalOpen, setIsAddNodeModalOpen, handleNodeAdded,
    generatePairingCode, disconnectFleet, renderContent, navigate,
  } = props;

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 font-sans transition-colors duration-300">
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
        isLocalHost={isLocalHost}
        pairingInfo={pairingInfo}
        onOpenPairing={() => setIsPairingModalOpen(true)}
        onNavigate={navigate}
      />

      <MobileTabBar activeTab={activeTab} setActiveTab={handleTabChange} />
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
            <React.Suspense fallback={null}>
              <div key={activeTab}>{renderContent()}</div>
            </React.Suspense>
          </div>
        </div>

        <footer className="h-8 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 flex items-center justify-between text-xs text-gray-500 transition-colors">
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
                    ? alive ? '● online' : `● offline · last seen ${fmtAgo(ls)}`
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
          </div>
        </footer>
      </main>
    </div>
  );
};

export default App;
