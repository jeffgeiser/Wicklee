import React, { useState, useRef, useEffect } from 'react';
import { LayoutGrid, Server, Activity, Terminal, Cpu, Users, LogOut, Key, Settings, BookOpen, Newspaper, Github, User as UserIcon, UserCog } from 'lucide-react';
import { useClerk } from '@clerk/clerk-react';
import { ConnectionState, DashboardTab, User, UserRole } from '../types';
import { usePermissions } from '../hooks/usePermissions';

// Build-time flag: true when compiled for the local agent binary (VITE_BUILD_TARGET=agent).
// In agent builds, ClerkProvider is absent — this gates all useClerk() calls.
const IS_AGENT = (import.meta.env.VITE_BUILD_TARGET as string) === 'agent';

interface SidebarProps {
  activeTab: DashboardTab;
  setActiveTab: (tab: DashboardTab) => void;
  currentUser: User;
  onUserChange: (user: User) => void;
  connectionState?: ConnectionState;
  theme?: 'light' | 'dark';
  isLocalMode?: boolean;
  isLocalHost?: boolean;
  onNavigate?: (path: string) => void;
}

// ── Clerk-dependent account actions — rendered ONLY in non-agent (cloud) builds ─
// Isolated here so useClerk() is called inside a component that is conditionally
// mounted, satisfying React's hooks-in-same-order rule while keeping ClerkProvider
// absent from the agent binary's render tree.
const ClerkAccountActions: React.FC<{
  onClose: () => void;
  onNavigateSettings: () => void;
}> = ({ onClose, onNavigateSettings: _nav }) => {
  const { signOut, openUserProfile } = useClerk();
  return (
    <div className="mt-1.5 pt-1.5 border-t border-gray-100 dark:border-gray-800/50 space-y-0.5">
      <button
        onClick={() => { onClose(); openUserProfile(); }}
        className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-white transition-colors flex items-center gap-2"
      >
        <UserCog className="w-4 h-4 text-blue-600 dark:text-blue-400" />
        Manage Account
      </button>
      <button
        onClick={() => { onClose(); signOut({ redirectUrl: '/' }); }}
        className="w-full text-left px-3 py-2 rounded-lg text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors flex items-center gap-2"
      >
        <LogOut className="w-4 h-4" />
        Sign out
      </button>
    </div>
  );
};

const Sidebar: React.FC<SidebarProps> = ({ activeTab, setActiveTab, currentUser, onUserChange: _onUserChange, connectionState: _connectionState = 'disconnected', theme: _theme, isLocalMode = true, isLocalHost = false, onNavigate }) => {
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
    { id: DashboardTab.OVERVIEW,     icon: LayoutGrid, label: 'Intelligence', show: true },
    { id: DashboardTab.AI_INSIGHTS,  icon: Cpu,        label: 'Insights',        show: permissions.canRunAIAnalysis },
    { id: DashboardTab.NODES,        icon: Server,     label: 'Management',      show: true },
    { id: DashboardTab.TRACES,       icon: Activity,   label: 'Observability',   show: true },
    { id: DashboardTab.SCAFFOLDING,  icon: Terminal,   label: 'Scaffolding',     show: currentUser.isPro && permissions.canViewScaffolding },
    { id: DashboardTab.AI_PROVIDERS, icon: Key,        label: 'AI Key Vault',    show: currentUser.isPro && !isLocalMode },
    { id: DashboardTab.TEAM,         icon: Users,      label: 'Team Management', show: currentUser.isPro && permissions.canManageTeam && !isLocalMode },
  ];

  return (
    // ── Nav rail ──────────────────────────────────────────────────────────────
    // Collapsed (default): 64px icon rail, fixed position so it never pushes content.
    // Expanded (hover):    transitions to 256px, overlays the content area.
    // group/nav drives label opacity so text appears only when expanded.
    <aside
      onMouseLeave={() => setIsAvatarMenuOpen(false)}
      className={[
        'hidden md:flex fixed left-0 top-0 bottom-0 z-30 flex-col',
        'w-16 hover:w-64',
        'transition-[width] duration-200 ease-out',
        'overflow-hidden',
        'border-r border-gray-200 dark:border-gray-800',
        'bg-white dark:bg-gray-900',
        'group/nav',
      ].join(' ')}>

      {/* Nav items — pt-16 clears the sticky header zone (header height = 64px = 4rem) */}
      <nav className="flex-1 px-3 space-y-1 pt-16 pb-4 overflow-hidden">
        {items.filter(i => i.show).map((item) => (
          <button
            key={item.id}
            onClick={() => setActiveTab(item.id)}
            className={`w-full flex items-center gap-3 px-6 py-2.5 rounded-lg text-sm font-medium transition-all ${
              activeTab === item.id
                ? 'bg-blue-600/10 text-blue-600 dark:text-blue-400 border border-blue-600/20'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800/50 border border-transparent'
            }`}
          >
            <item.icon className="w-4 h-4 shrink-0" />
            <span className="flex-1 text-left whitespace-nowrap opacity-0 group-hover/nav:opacity-100 transition-opacity duration-100">
              {item.label}
            </span>
          </button>
        ))}
      </nav>

      <div className="p-4 border-t border-gray-200 dark:border-gray-800 space-y-1">
        {/* Avatar / profile — dropdown opens upward; only reachable when nav is expanded.
            Collapsed state: avatar centered in the rail (justify-center, no gap/px).
            Expanded state:  left-aligned with gap + px-3 padding (group-hover/nav variants). */}
        <div className="relative" ref={avatarMenuRef}>
          <button
            onClick={() => setIsAvatarMenuOpen(v => !v)}
            className="w-full flex items-center justify-center group-hover/nav:justify-start group-hover/nav:gap-3 group-hover/nav:px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800/50 transition-colors"
          >
            <div className="h-8 w-8 rounded-lg bg-gray-200 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 flex items-center justify-center shrink-0 overflow-hidden">
              <UserIcon className="w-4 h-4 text-gray-600 dark:text-gray-300" />
            </div>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap max-w-0 overflow-hidden group-hover/nav:max-w-full text-left opacity-0 group-hover/nav:opacity-100 transition-opacity duration-100">
              {currentUser.fullName}
            </span>
          </button>

          {/* Upward dropdown */}
          {isAvatarMenuOpen && (
            <div className="absolute bottom-full left-0 mb-2 w-[240px] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl shadow-2xl z-50 p-1.5 animate-in fade-in slide-in-from-bottom-2 duration-200">
              {/* User info */}
              <div className="px-3 py-3 mb-1 border-b border-gray-100 dark:border-gray-800/50 flex items-center gap-3">
                <div className="h-8 w-8 rounded-lg bg-gray-200 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 flex items-center justify-center shrink-0">
                  <UserIcon className="w-4 h-4 text-gray-600 dark:text-gray-300" />
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
                <button
                  onClick={() => {
                    // In localhost (agent) mode, always open the canonical cloud docs
                    // in a new tab — users see the latest published version, not the
                    // docs embedded in whichever binary version they have installed.
                    if (isLocalHost) {
                      window.open('https://wicklee.dev/docs', '_blank', 'noopener,noreferrer');
                    } else {
                      onNavigate?.('/docs');
                    }
                    setIsAvatarMenuOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-white transition-colors flex items-center gap-2"
                >
                  <BookOpen className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                  Documentation
                </button>
                <button
                  onClick={() => { onNavigate?.('/blog'); setIsAvatarMenuOpen(false); }}
                  className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-white transition-colors flex items-center gap-2"
                >
                  <Newspaper className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                  Blog
                </button>
                <a
                  href="https://github.com/jeffgeiser/Wicklee#readme"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setIsAvatarMenuOpen(false)}
                  className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-white transition-colors flex items-center gap-2"
                >
                  <Github className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                  GitHub
                </a>
              </div>

              {/* Manage Account + Sign out — cloud build only (ClerkProvider present) */}
              {!IS_AGENT && !isLocalHost && (
                <ClerkAccountActions
                  onClose={() => setIsAvatarMenuOpen(false)}
                  onNavigateSettings={() => { setActiveTab(DashboardTab.SETTINGS); setIsAvatarMenuOpen(false); }}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
