import React from 'react';
import { LayoutGrid, Server, Activity, Terminal, BrainCircuit, Users, RefreshCw, LogOut, Leaf, Key, CreditCard } from 'lucide-react';
import Logo from './Logo';
import { DashboardTab, User, UserRole } from '../types';
import { usePermissions } from '../hooks/usePermissions';

interface SidebarProps {
  activeTab: DashboardTab;
  setActiveTab: (tab: DashboardTab) => void;
  currentUser: User;
  onUserChange: (user: User) => void;
  onLogout: () => void;
  isConnected?: boolean;
}

const Sidebar: React.FC<SidebarProps> = ({ activeTab, setActiveTab, currentUser, onUserChange, onLogout, isConnected = false }) => {
  const permissions = usePermissions(currentUser);

  const items = [
    { id: DashboardTab.OVERVIEW, icon: LayoutGrid, label: 'Fleet Overview', show: true },
    { id: DashboardTab.NODES, icon: Server, label: 'Node Registry', show: true },
    { id: DashboardTab.TRACES, icon: Activity, label: 'Observability', show: true },
    { id: DashboardTab.SCAFFOLDING, icon: Terminal, label: 'Scaffolding', show: currentUser.isPro && permissions.canViewScaffolding },
    { id: DashboardTab.AI_INSIGHTS, icon: BrainCircuit, label: 'Local Intelligence', show: permissions.canRunAIAnalysis },
    { id: DashboardTab.AI_PROVIDERS, icon: Key, label: 'AI Key Vault', show: currentUser.isPro },
    { id: DashboardTab.TEAM, icon: Users, label: 'Team Management', show: currentUser.isPro && permissions.canManageTeam },
    { id: DashboardTab.SUSTAINABILITY, icon: Leaf, label: 'Sustainability', show: true },
  ];

  const handleRoleToggle = (role: UserRole) => {
    onUserChange({ ...currentUser, role });
    if (activeTab === DashboardTab.TEAM && role !== 'Owner') {
      setActiveTab(DashboardTab.OVERVIEW);
    }
  };

  return (
    <aside className="w-64 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900/50 flex flex-col transition-colors">
      <div className="p-6">
        <Logo className="text-xl" active={isConnected} />
        <p className="mt-1 text-[10px] text-gray-400 dark:text-gray-500 uppercase tracking-widest font-semibold px-0.5">
          Community Edition
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

      <div className="p-4 border-t border-gray-200 dark:border-gray-800 space-y-4">
        <button 
          onClick={onLogout}
          className="w-full flex items-center gap-3 px-4 py-2 text-sm font-medium text-gray-500 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/5 rounded-lg transition-all border border-transparent hover:border-red-200 dark:hover:border-red-500/20"
        >
          <LogOut className="w-4 h-4" />
          Sign Out
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;