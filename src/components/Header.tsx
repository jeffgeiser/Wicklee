import React from 'react';
import { Cloud, CloudLightning } from 'lucide-react';
import { ConnectionState, DashboardTab, PairingInfo, Tenant, User as UserType } from '../types';
import Logo from './Logo';

interface HeaderProps {
  activeTab: DashboardTab;
  tenants: Tenant[];
  currentTenant: Tenant;
  onTenantChange: (tenant: Tenant) => void;
  currentUser: UserType;
  onLogout?: () => void;
  setActiveTab?: (tab: DashboardTab) => void;
  theme?: 'light' | 'dark';
  onToggleTheme?: () => void;
  pairingInfo?: PairingInfo | null;
  onOpenPairing?: () => void;
  isLocalHost?: boolean;
  connectionState?: ConnectionState;
}

const Header: React.FC<HeaderProps> = ({ activeTab, pairingInfo, onOpenPairing, theme, connectionState = 'disconnected' }) => {
  const titles: Record<string, string> = {
    [DashboardTab.SCAFFOLDING]:  'Fleet Scaffolding',
    [DashboardTab.TEAM]:         'Team & Memberships',
    [DashboardTab.PROFILE]:      'User Profile',
    [DashboardTab.SECURITY]:     'Account Security',
    [DashboardTab.API_KEYS]:     'Manage API Keys',
    [DashboardTab.PREFERENCES]:  'System Preferences',
    [DashboardTab.PRICING]:      'Fleet Pricing',
    [DashboardTab.AI_PROVIDERS]: 'AI Key Vault',
  };

  return (
    // ── z-40: sticky header paints above the fixed nav rail (z-30) at root ──
    // <main> carries no z-index so creates no stacking context; the sticky
    // z-index is therefore evaluated at the root level where z-40 > z-30.
    // The logo lives here — in the content-area header — and is never inside
    // the nav rail. Nav expand/collapse cannot obscure it.
    <header className="h-16 border-b border-gray-200 dark:border-gray-800 bg-white/80 dark:bg-gray-900/20 backdrop-blur-md px-6 flex items-center justify-between sticky top-0 z-40 transition-colors">
      {/* Left: logo + page title */}
      <div className="flex items-center gap-4">
        <Logo className="text-xl" connectionState={connectionState} theme={theme} />
        {titles[activeTab] && (
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white whitespace-nowrap">
            {titles[activeTab]}
          </h2>
        )}
      </div>

      <div className="flex items-center gap-6">
        <div className="flex items-center gap-4">
          {/* Fleet Connect button */}
          {pairingInfo?.status === 'connected' ? (
            <button
              onClick={onOpenPairing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/10 border border-green-500/20 hover:bg-green-500/20 transition-colors"
              title={`${pairingInfo.node_id} — Fleet Connected`}
            >
              <CloudLightning className="w-4 h-4 text-green-400" />
              <span className="text-[11px] font-telin text-green-400 hidden sm:inline">{pairingInfo.node_id}</span>
            </button>
          ) : pairingInfo?.status === 'pending' ? (
            <button
              onClick={onOpenPairing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 hover:bg-amber-500/20 transition-colors relative"
              title="Pairing in progress"
            >
              <span className="animate-ping absolute inset-0 rounded-lg bg-amber-400/10" />
              <Cloud className="w-4 h-4 text-amber-400 relative" />
              <span className="text-[11px] font-telin text-amber-400 relative hidden sm:inline">Pairing…</span>
            </button>
          ) : (
            <button
              onClick={onOpenPairing}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-all shadow-lg shadow-indigo-500/20"
            >
              <Cloud className="w-4 h-4" />
              <span className="hidden sm:inline">Pair a Node</span>
            </button>
          )}

          {/* Bell — hidden until notification system is built */}
        </div>
      </div>
    </header>
  );
};

export default Header;
