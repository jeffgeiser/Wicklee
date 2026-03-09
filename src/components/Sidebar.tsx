import React from 'react';
import { LayoutGrid, Server, Activity, Terminal, BrainCircuit, Users, RefreshCw, LogOut, Leaf, Key, CreditCard, Cloud, CloudLightning } from 'lucide-react';
import Logo from './Logo';
import { DashboardTab, User, UserRole, PairingInfo } from '../types';
import { usePermissions } from '../hooks/usePermissions';

interface SidebarProps {
  activeTab: DashboardTab;
  setActiveTab: (tab: DashboardTab) => void;
  currentUser: User;
  onUserChange: (user: User) => void;
  onLogout: () => void;
  isConnected?: boolean;
  isLocalMode?: boolean;
  isLocalHost?: boolean;
  pairingInfo?: PairingInfo | null;
  onOpenPairing?: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({ activeTab, setActiveTab, currentUser, onUserChange, onLogout, isConnected = false, isLocalMode = true, isLocalHost = false, pairingInfo, onOpenPairing }) => {
  const permissions = usePermissions(currentUser);

  const items = [
    { id: DashboardTab.OVERVIEW, icon: LayoutGrid, label: 'Fleet Overview', show: true },
    { id: DashboardTab.NODES, icon: Server, label: 'Node Registry', show: true },
    { id: DashboardTab.TRACES, icon: Activity, label: 'Observability', show: true },
    { id: DashboardTab.SCAFFOLDING, icon: Terminal, label: 'Scaffolding', show: currentUser.isPro && permissions.canViewScaffolding },
    { id: DashboardTab.AI_INSIGHTS, icon: BrainCircuit, label: 'Local Intelligence', show: permissions.canRunAIAnalysis },
    { id: DashboardTab.AI_PROVIDERS, icon: Key, label: 'AI Key Vault', show: currentUser.isPro && !isLocalMode },
    { id: DashboardTab.TEAM, icon: Users, label: 'Team Management', show: currentUser.isPro && permissions.canManageTeam && !isLocalMode },
    { id: DashboardTab.SUSTAINABILITY, icon: Leaf, label: 'Sustainability', show: true },
  ];

  const handleRoleToggle = (role: UserRole) => {
    onUserChange({ ...currentUser, role });
    if (activeTab === DashboardTab.TEAM && role !== 'Owner') {
      setActiveTab(DashboardTab.OVERVIEW);
    }
  };

  return (
    <aside className="hidden md:flex md:w-64 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900/50 flex-col transition-colors">
      <div className="p-6">
        <Logo className="text-xl" active={isConnected} />
        <p className="mt-1 text-[10px] text-gray-400 dark:text-gray-500 uppercase tracking-widest font-semibold px-0.5">
          Community Edition
        </p>
        <p className="mt-0.5 text-[10px] text-gray-400 dark:text-gray-600 px-0.5">
          Free · up to 3 nodes
        </p>
      </div>

      <nav className="flex-1 px-3 space-y-1">
        {items.filter(i => i.show).map((item) => (
          <button
            key={item.id}
            onClick={() => setActiveTab(item.id)}
            className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
              activeTab === item.id
                ? 'bg-blue-600/10 text-blue-600 dark:text-blue-400 border border-blue-600/20'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800/50 border border-transparent'
            }`}
          >
            <item.icon className="w-4 h-4" />
            <span className="flex-1 text-left">{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="p-4 border-t border-gray-200 dark:border-gray-800 space-y-3">
        {isLocalHost ? (() => {
          const status = pairingInfo?.status;
          const nodeId = pairingInfo?.node_id;
          const isPending = status === 'pending';
          const isConnectedFleet = status === 'connected';

          const borderClass = isConnectedFleet
            ? 'border-green-500/30 hover:border-green-500/50'
            : isPending
            ? 'border-amber-500/30 hover:border-amber-500/50'
            : 'border-gray-700/50 hover:border-gray-600/50';

          return (
            <button
              onClick={onOpenPairing}
              className={`w-full px-4 py-3 rounded-xl border text-left transition-all ${borderClass}`}
            >
              <div className="flex items-center gap-2">
                {isConnectedFleet ? (
                  <CloudLightning className="w-4 h-4 text-green-400 shrink-0" />
                ) : (
                  <Cloud className={`w-4 h-4 shrink-0 ${isPending ? 'text-amber-400 animate-pulse' : 'text-gray-500'}`} />
                )}
                <span className={`text-xs font-semibold ${isConnectedFleet ? 'text-green-400' : isPending ? 'text-amber-400' : 'text-gray-400'}`}>
                  {isConnectedFleet ? 'Fleet Connected' : isPending ? 'Pairing…' : 'Sovereign Mode'}
                </span>
              </div>
              {nodeId && (
                <p className="mt-0.5 text-[10px] font-mono text-gray-500 pl-6 truncate">{nodeId}</p>
              )}
              {!isConnectedFleet && !isPending && (
                <p className="mt-0.5 text-[10px] text-indigo-400 pl-6">Connect →</p>
              )}
            </button>
          );
        })() : (
          <a
            href="https://github.com/jeffgeiser/Wicklee#readme"
            target="_blank"
            rel="noopener noreferrer"
            className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-500 hover:text-gray-300 transition-colors"
          >
            <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
            </svg>
            Documentation →
          </a>
        )}
        {!isLocalHost && (
          <button
            onClick={onLogout}
            className="w-full flex items-center gap-3 px-4 py-2 text-sm font-medium text-gray-500 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/5 rounded-lg transition-all border border-transparent hover:border-red-200 dark:hover:border-red-500/20"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        )}
      </div>
    </aside>
  );
};

export default Sidebar;