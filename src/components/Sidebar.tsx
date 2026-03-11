import React, { useState, useRef, useEffect } from 'react';
import { LayoutGrid, Server, Activity, Terminal, Cpu, Users, LogOut, Leaf, Key, Cloud, CloudLightning, Settings, HelpCircle, FileText, User as UserIcon, UserCog } from 'lucide-react';
import { useClerk } from '@clerk/clerk-react';
import Logo from './Logo';
import { ConnectionState, DashboardTab, User, UserRole, PairingInfo } from '../types';
import { usePermissions } from '../hooks/usePermissions';

interface SidebarProps {
  activeTab: DashboardTab;
  setActiveTab: (tab: DashboardTab) => void;
  currentUser: User;
  onUserChange: (user: User) => void;
  connectionState?: ConnectionState;
  theme?: 'light' | 'dark';
  isLocalMode?: boolean;
  isLocalHost?: boolean;
  pairingInfo?: PairingInfo | null;
  onOpenPairing?: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({ activeTab, setActiveTab, currentUser, onUserChange, connectionState = 'disconnected', theme, isLocalMode = true, isLocalHost = false, pairingInfo, onOpenPairing }) => {
  const { signOut, openUserProfile } = useClerk();
  const permissions = usePermissions(currentUser);
  const [isAvatarMenuOpen, setIsAvatarMenuOpen] = useState(false);
  const avatarMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (avatarMenuRef.current && !avatarMenuRef.current.contains(e.target as Node)) {
        setIsAvatarMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const items = [
    { id: DashboardTab.OVERVIEW, icon: LayoutGrid, label: 'Intelligence', show: true },
    { id: DashboardTab.NODES, icon: Server, label: 'Management', show: true },
    { id: DashboardTab.TRACES, icon: Activity, label: 'Observability', show: true },
    { id: DashboardTab.SCAFFOLDING, icon: Terminal, label: 'Scaffolding', show: currentUser.isPro && permissions.canViewScaffolding },
    { id: DashboardTab.AI_INSIGHTS, icon: Cpu, label: 'Insights', show: permissions.canRunAIAnalysis },
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
        <Logo className="text-xl" connectionState={connectionState} theme={theme} />
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

      <div className="p-4 border-t border-gray-200 dark:border-gray-800 space-y-1">
        {/* Fleet Connect pill — localhost only */}
        {isLocalHost && (() => {
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
              className={`w-full px-4 py-3 rounded-xl border text-left transition-all mb-2 ${borderClass}`}
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
                <p className="mt-0.5 text-[10px] font-telin text-gray-500 pl-6 truncate">{nodeId}</p>
              )}
              {!isConnectedFleet && !isPending && (
                <p className="mt-0.5 text-[10px] text-indigo-400 pl-6">Connect →</p>
              )}
            </button>
          );
        })()}

        {/* Avatar / profile — dropdown opens upward */}
        <div className="relative" ref={avatarMenuRef}>
          <button
            onClick={() => setIsAvatarMenuOpen(v => !v)}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800/50 transition-colors"
          >
            <div className="h-8 w-8 rounded-lg bg-gray-200 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 flex items-center justify-center shrink-0 overflow-hidden">
              <UserIcon className="w-5 h-5 text-gray-600 dark:text-gray-300" />
            </div>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate flex-1 text-left">
              {currentUser.fullName}
            </span>
          </button>

          {/* Upward dropdown */}
          {isAvatarMenuOpen && (
            <div className="absolute bottom-full left-0 mb-2 w-[240px] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl shadow-2xl z-50 p-1.5 animate-in fade-in slide-in-from-bottom-2 duration-200">
              {/* User info */}
              <div className="px-3 py-3 mb-1 border-b border-gray-100 dark:border-gray-800/50 flex items-center gap-3">
                <div className="h-8 w-8 rounded-lg bg-gray-200 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 flex items-center justify-center shrink-0">
                  <UserIcon className="w-5 h-5 text-gray-600 dark:text-gray-300" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-bold text-gray-900 dark:text-gray-200 truncate">{currentUser.fullName}</p>
                  <p className="text-[10px] text-gray-500 truncate">{currentUser.email}</p>
                  <span className="inline-flex items-center px-1.5 py-0.5 mt-0.5 rounded text-[9px] font-medium bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500">
                    Free Plan
                  </span>
                </div>
              </div>

              {/* Menu items */}
              <div className="space-y-0.5">
                <button
                  onClick={() => { setActiveTab(DashboardTab.SETTINGS); setIsAvatarMenuOpen(false); }}
                  className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-white transition-colors flex items-center gap-2"
                >
                  <Settings className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                  Settings
                </button>
                <a
                  href="https://github.com/jeffgeiser/Wicklee#readme"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setIsAvatarMenuOpen(false)}
                  className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-white transition-colors flex items-center gap-2"
                >
                  <HelpCircle className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                  Documentation
                </a>
                <a
                  href="https://github.com/jeffgeiser/Wicklee/releases"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setIsAvatarMenuOpen(false)}
                  className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-white transition-colors flex items-center gap-2"
                >
                  <FileText className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                  Release notes
                </a>
              </div>

              {/* Manage Account + Sign out (hosted only) */}
              {!isLocalHost && (
                <div className="mt-1.5 pt-1.5 border-t border-gray-100 dark:border-gray-800/50 space-y-0.5">
                  <button
                    onClick={() => { setIsAvatarMenuOpen(false); openUserProfile(); }}
                    className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-white transition-colors flex items-center gap-2"
                  >
                    <UserCog className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    Manage Account
                  </button>
                  <button
                    onClick={() => { setIsAvatarMenuOpen(false); signOut({ redirectUrl: '/' }); }}
                    className="w-full text-left px-3 py-2 rounded-lg text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors flex items-center gap-2"
                  >
                    <LogOut className="w-4 h-4" />
                    Sign out
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;