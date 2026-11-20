import React, { useState, useEffect, useCallback } from 'react';
import { version } from '../package.json';
import { RefreshCw, X } from 'lucide-react';
import { DashboardTab, FleetNode, NodeAgent, Tenant, User as UserType, ObservabilityNavParams } from './types';
import { FleetStreamProvider, useFleetStream } from './contexts/FleetStreamContext';
import { perfMark } from './utils/perfMark';
import { IS_AGENT, SITE_URL } from './utils/buildTarget';
import Sidebar from './components/Sidebar';
import MobileTabBar from './components/MobileTabBar';
import Header from './components/Header';
import LandingPage from './site/LandingPage';
import { useSettings } from './hooks/useSettings';
import { STATIC_PAGE_META, setPageMeta, normalizePath } from './utils/pageMeta';

const Absent = (() => null) as never;
const Overview     = IS_AGENT ? React.lazy(() => import('./components/Overview'))     : Absent;
const ModelsPage   = IS_AGENT ? React.lazy(() => import('./components/ModelsPage'))   : Absent;
const NodesList    = IS_AGENT ? React.lazy(() => import('./components/NodesList'))    : Absent;
const TracesView   = IS_AGENT ? React.lazy(() => import('./components/TracesView'))   : Absent;
const AIInsights   = IS_AGENT ? React.lazy(() => import('./components/AIInsights'))   : Absent;
const SettingsView = IS_AGENT ? React.lazy(() => import('./components/SettingsView')) : Absent;
const MetricsPage  = React.lazy(() => import('./pages/MetricsPage'));
const DocsPage     = IS_AGENT ? Absent : React.lazy(() => import('./site/DocsPage'));
const LegalPage    = IS_AGENT ? Absent : React.lazy(() => import('./site/LegalPage'));
const TrustPage    = IS_AGENT ? Absent : React.lazy(() => import('./site/TrustPage'));
const BlogListing  = IS_AGENT ? Absent : React.lazy(() => import('./site/BlogListing'));
const BlogPost     = IS_AGENT ? Absent : React.lazy(() => import('./site/BlogPost'));

/** Shown while a lazy page's chunk is in flight. Deliberately not null: on the
 *  prerendered routes React has already cleared the static block by the time
 *  this renders, and a blank page reads as broken. */
const PageFallback: React.FC = () => (
  <div className="min-h-screen bg-gray-900 flex items-center justify-center" aria-busy="true" aria-live="polite">
    <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
  </div>
);
const lazyPage = (el: React.ReactElement) => (
  <React.Suspense fallback={<PageFallback />}>{el}</React.Suspense>
);

const LOCAL_TENANTS: Tenant[] = [{ id: 'local', name: 'This machine' }];

const LOCAL_USER: UserType = {
  id: 'local',
  email: '',
  fullName: '',
  role: 'Owner',
};

/** Path state shared by both builds: the current pathname plus a client-side navigate. */
function useNavigation() {
  const [currentPath, setCurrentPath] = useState(() => window.location.pathname);

  const navigate = useCallback((path: string) => {
    // The agent build serves the dashboard only; every other page lives on the public site.
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

  return { currentPath, navigate };
}

/** The public website: static pages only. */
const SiteApp: React.FC = () => {
  const { currentPath, navigate } = useNavigation();

  if (currentPath === '/metrics-reference' || currentPath === '/metrics-reference/' ||
      currentPath === '/metrics' || currentPath === '/metrics/') {
    return lazyPage(<MetricsPage onNavigate={navigate} />);
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
  if (currentPath === '/blog' || currentPath === '/blog/') {
    return lazyPage(<BlogListing onNavigate={navigate} />);
  }
  const blogPostMatch = currentPath.match(/^\/blog\/([^/]+?)\/?$/);
  if (blogPostMatch) {
    return lazyPage(<BlogPost slug={blogPostMatch[1]} onNavigate={navigate} />);
  }
  return <LandingPage onNavigate={navigate} />;
};

/** The local dashboard. Rendered only in the agent build (`npm run build:agent`). */
const Dashboard: React.FC = () => {
  const { currentPath, navigate } = useNavigation();
  const [activeTab, setActiveTab] = useState<DashboardTab>(DashboardTab.OVERVIEW);
  useEffect(() => { perfMark('wk:app-mounted'); }, []);
  const [observabilityNav, setObservabilityNav] = useState<ObservabilityNavParams | undefined>(undefined);
  /**
   * Deep-link target for cross-tab navigation into Insights.
   * Set when a user clicks something on Overview that should land on a
   * specific Insights sub-tab + scroll to a specific anchor (e.g. the
   * Model Fit summary strip → Insights → Performance → ModelFitAnalysis).
   * Consumed by AIInsights on mount, then cleared.
   */
  const [insightsDeepLink, setInsightsDeepLink] = useState<{ tab: 'triage' | 'performance'; scrollTo?: string } | undefined>(undefined);
  const [nodes, setNodes] = useState<NodeAgent[]>([]);
  const theme = 'dark' as const;
  const { settings, savedToast, getNodeSettings, updateFleet, setNodeOverride, clearAllOverridesForField, clearAllNodeOverrides } = useSettings();

  useEffect(() => {
    void import('./utils/perplexity').then(m => m.loadPerplexityBaseline());
  }, []);

  // Seed the node list with this machine, identified by the agent.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/health')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { node_id?: string } | null) => {
        const nid = d?.node_id;
        if (cancelled || !nid) return;
        setNodes(prev => prev.some(n => n.id === nid) ? prev : [{
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
        }]);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const handleNodesSnapshot = useCallback((snapshot: FleetNode[]) => {
    setNodes(prev => {
      const byId = new Map(snapshot.map(n => [n.node_id, n]));
      let changed = false;
      const next = prev.map(node => {
        const match = byId.get(node.id);
        if (!match) return node;
        const resolvedHostname = match.display_name ?? match.metrics?.hostname ?? node.id;
        if (resolvedHostname === node.hostname) return node;
        changed = true;
        return { ...node, hostname: resolvedHostname };
      });
      return changed ? next : prev;
    });
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  if (
    currentPath === '/metrics-reference' || currentPath === '/metrics-reference/' ||
    currentPath === '/metrics' || currentPath === '/metrics/'
  ) {
    return lazyPage(<MetricsPage onNavigate={navigate} />);
  }

  const renderContent = () => {
    switch (activeTab) {
      case DashboardTab.MODELS:
        return <ModelsPage nodes={nodes} onNavigateToInsightsPerformance={() => { setInsightsDeepLink({ tab: 'performance' }); setActiveTab(DashboardTab.AI_INSIGHTS); }} />;
      case DashboardTab.NODES:
        return <NodesList nodes={nodes} getNodeSettings={getNodeSettings} onNavigateToSettings={() => setActiveTab(DashboardTab.SETTINGS)} />;
      case DashboardTab.TRACES:
        return <TracesView nodes={nodes} tenantId={LOCAL_TENANTS[0].id} getNodeSettings={getNodeSettings} navParams={observabilityNav} onNavConsumed={() => setObservabilityNav(undefined)} />;
      case DashboardTab.AI_INSIGHTS:
        return (
          <AIInsights
            nodes={nodes}
            onNavigateToObservability={(params?: ObservabilityNavParams) => {
              setObservabilityNav(params);
              setActiveTab(DashboardTab.TRACES);
            }}
            deepLink={insightsDeepLink}
            onDeepLinkConsumed={() => setInsightsDeepLink(undefined)}
            onNavigateToModels={() => setActiveTab(DashboardTab.MODELS)}
          />
        );
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
        />;
      case DashboardTab.OVERVIEW:
      default:
        return <Overview nodes={nodes} getNodeSettings={getNodeSettings} fleetKwhRate={settings.fleet.kwhRate} onNavigateToObservability={(params?: ObservabilityNavParams) => { setObservabilityNav(params); setActiveTab(DashboardTab.TRACES); }} onNavigateToInsights={(tab, scrollTo) => { setInsightsDeepLink({ tab, scrollTo }); setActiveTab(DashboardTab.AI_INSIGHTS); }} />;
    }
  };

  return (
    <FleetStreamProvider onNodesSnapshot={handleNodesSnapshot}>
      <DashboardShell
        nodes={nodes}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        currentUser={LOCAL_USER}
        theme={theme}
        renderContent={renderContent}
        navigate={navigate}
      />
    </FleetStreamProvider>
  );
};

const App: React.FC = () => (IS_AGENT ? <Dashboard /> : <SiteApp />);

interface DashboardShellProps {
  nodes: NodeAgent[];
  activeTab: DashboardTab;
  setActiveTab: (t: DashboardTab) => void;
  currentUser: UserType;
  theme: 'light' | 'dark';
  renderContent: () => React.ReactNode;
  navigate: (path: string) => void;
}

const DashboardShell: React.FC<DashboardShellProps> = (props) => {
  const { connectionState } = useFleetStream();
  const { activeTab, setActiveTab, currentUser, theme, renderContent, navigate } = props;

  const [localAgentVersion, setLocalAgentVersion] = useState<string | undefined>();
  useEffect(() => {
    fetch('/api/metrics/snapshot')
      .then(r => r.ok ? r.json() : null)
      .then((d: Record<string, unknown> | null) => {
        if (d && typeof d.agent_version === 'string') {
          setLocalAgentVersion(d.agent_version);
        }
      })
      .catch(() => {});
  }, []);

  const [versionBannerDismissed, setVersionBannerDismissed] = useState(false);
  const showVersionBanner = !versionBannerDismissed
    && localAgentVersion != null
    && localAgentVersion !== version;

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 font-sans transition-colors duration-300">
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        currentUser={currentUser}
        onUserChange={() => {}}
        connectionState={connectionState}
        theme={theme}
        isLocalHost
        onNavigate={navigate}
      />

      <MobileTabBar activeTab={activeTab} setActiveTab={setActiveTab} />
      <main className="flex-1 flex flex-col overflow-hidden md:ml-16">
        <Header
          activeTab={activeTab}
          tenants={LOCAL_TENANTS}
          currentTenant={LOCAL_TENANTS[0]}
          onTenantChange={() => {}}
          currentUser={currentUser}
          onLogout={() => {}}
          setActiveTab={setActiveTab}
          theme={theme}
          onToggleTheme={() => {}}
          connectionState={connectionState}
          isLocalHost
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
            <React.Suspense fallback={null}>
              <div key={activeTab}>{renderContent()}</div>
            </React.Suspense>
          </div>
        </div>

        <footer className="h-8 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 flex items-center justify-between text-xs text-gray-500 transition-colors">
          <span className="flex items-center gap-1.5">
            <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span>
            Local
          </span>
        </footer>
      </main>
    </div>
  );
};

export default App;
