import React from 'react';
import { ConnectionState, DashboardTab, Tenant, User as UserType } from '../types';
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
  isLocalHost?: boolean;
  connectionState?: ConnectionState;
}

const Header: React.FC<HeaderProps> = ({ theme, connectionState = 'disconnected' }) => {
  return (
    <header className="h-16 border-b border-gray-200 dark:border-gray-700 bg-white/80 dark:bg-gray-800/20 backdrop-blur-md px-6 flex items-center justify-between sticky top-0 z-40 transition-colors">
      <div className="flex items-center gap-4">
        <Logo className="text-xl" connectionState={connectionState} theme={theme} />
      </div>

    </header>
  );
};

export default Header;
