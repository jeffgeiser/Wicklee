import React, { useState, useRef, useEffect } from 'react';
import { Search, Bell, Settings, User, ChevronDown, Building2, LogOut, Key, UserCircle, Shield, Moon, Sun, BrainCircuit, CreditCard } from 'lucide-react';
import { DashboardTab, Tenant, User as UserType } from '../types';

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
}

const Header: React.FC<HeaderProps> = ({ activeTab, tenants, currentTenant, onTenantChange, currentUser, onLogout, setActiveTab, theme, onToggleTheme }) => {
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);

  const titles: Record<string, string> = {
    [DashboardTab.OVERVIEW]: 'Fleet Dashboard',
    [DashboardTab.NODES]: 'Connected Agents',
    [DashboardTab.TRACES]: 'Inference Traces',
    [DashboardTab.SCAFFOLDING]: 'Fleet Scaffolding',
    [DashboardTab.AI_INSIGHTS]: 'Local Intelligence',
    [DashboardTab.TEAM]: 'Team & Memberships',
    [DashboardTab.PROFILE]: 'User Profile',
    [DashboardTab.SECURITY]: 'Account Security',
    [DashboardTab.API_KEYS]: 'Manage API Keys',
    [DashboardTab.PREFERENCES]: 'System Preferences',
    [DashboardTab.PRICING]: 'Fleet Pricing',
    [DashboardTab.AI_PROVIDERS]: 'AI Key Vault',
  };

  const roleColors: Record<string, string> = {
    Owner: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
    Collaborator: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/20',
    Viewer: 'bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/20',
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(event.target as Node)) {
        setIsProfileOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleTabSelect = (tab: DashboardTab) => {
    setActiveTab?.(tab);
    setIsProfileOpen(false);
  };

  return (
    <header className="h-16 border-b border-gray-200 dark:border-gray-800 bg-white/80 dark:bg-gray-900/20 backdrop-blur-md px-8 flex items-center justify-between sticky top-0 z-10 transition-colors">
      <div className="flex items-center gap-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white min-w-[160px]">{titles[activeTab]}</h2>
      </div>

      <div className="flex items-center gap-6">
        <div className="relative group hidden md:block">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 group-focus-within:text-blue-600 transition-colors" />
          <input
            type="text"
            placeholder="Search fleet..."
            className="bg-gray-100 dark:bg-gray-800 border-none rounded-full pl-9 pr-4 py-1.5 text-sm w-64 focus:ring-1 focus:ring-blue-600 transition-all outline-none text-gray-900 dark:text-white"
          />
        </div>

        <div className="flex items-center gap-4">
          <button 
            onClick={onToggleTheme}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400 transition-colors"
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>

          <button className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400 transition-colors relative">
            <Bell className="w-5 h-5" />
            <span className="absolute top-2 right-2.5 w-1.5 h-1.5 bg-red-500 rounded-full border border-white dark:border-gray-950"></span>
          </button>

          <div className="relative" ref={profileRef}>
            <button 
              onClick={() => setIsProfileOpen(!isProfileOpen)}
              className="flex items-center gap-3 p-1 bg-gray-50 dark:bg-gray-800/30 hover:bg-gray-100 dark:hover:bg-gray-800/50 border border-gray-200 dark:border-gray-800 rounded-xl transition-all"
            >
              <div className="h-8 w-8 rounded-lg bg-gray-200 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 flex items-center justify-center overflow-hidden cursor-pointer">
                <User className="w-5 h-5 text-gray-600 dark:text-gray-300" />
              </div>
            </button>

            {isProfileOpen && (
              <div className="absolute top-full right-0 mt-2 w-64 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl shadow-2xl z-50 p-1.5 animate-in fade-in slide-in-from-top-2 duration-200">
                <div className="px-3 py-3 mb-1 border-b border-gray-100 dark:border-gray-800/50">
                  <p className="text-xs font-bold text-gray-900 dark:text-gray-200">{currentUser.fullName}</p>
                  <p className="text-[10px] text-gray-500">{currentUser.email}</p>
                </div>
                
                <div className="space-y-0.5">
                  <button 
                    onClick={() => handleTabSelect(DashboardTab.PROFILE)}
                    className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-white transition-colors flex items-center gap-2"
                  >
                    <UserCircle className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    View Profile
                  </button>
                  <button 
                    onClick={() => handleTabSelect(DashboardTab.SECURITY)}
                    className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-white transition-colors flex items-center gap-2"
                  >
                    <Shield className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    Account Security
                  </button>
                  <button 
                    onClick={() => handleTabSelect(DashboardTab.API_KEYS)}
                    className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-white transition-colors flex items-center gap-2"
                  >
                    <Key className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    API Keys
                  </button>
                  <button 
                    onClick={() => handleTabSelect(DashboardTab.AI_PROVIDERS)}
                    className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-white transition-colors flex items-center gap-2"
                  >
                    <BrainCircuit className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    AI Providers
                  </button>
                  <button 
                    onClick={() => handleTabSelect(DashboardTab.PREFERENCES)}
                    className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-white transition-colors flex items-center gap-2"
                  >
                    <Settings className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    Preferences
                  </button>
                  <button 
                    onClick={() => handleTabSelect(DashboardTab.BILLING)}
                    className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-white transition-colors flex items-center gap-2"
                  >
                    <CreditCard className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    Billing & Subscription
                  </button>
                </div>

                <div className="mt-1.5 pt-1.5 border-t border-gray-100 dark:border-gray-800/50">
                  <button 
                    onClick={() => {
                      setIsProfileOpen(false);
                      onLogout?.();
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors flex items-center gap-2"
                  >
                    <LogOut className="w-4 h-4" />
                    Sign Out
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};

export default Header;