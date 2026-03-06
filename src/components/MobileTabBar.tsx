import React from 'react';
import { LayoutGrid, Server, ShieldCheck, Settings } from 'lucide-react';
import { DashboardTab } from '../types';

interface MobileTabBarProps {
  activeTab: DashboardTab;
  setActiveTab: (tab: DashboardTab) => void;
}

const tabs = [
  { id: DashboardTab.OVERVIEW,     icon: LayoutGrid,  label: 'Fleet'    },
  { id: DashboardTab.NODES,        icon: Server,       label: 'Nodes'    },
  { id: DashboardTab.SECURITY,     icon: ShieldCheck,  label: 'Security' },
  { id: DashboardTab.PREFERENCES,  icon: Settings,     label: 'Settings' },
];

const MobileTabBar: React.FC<MobileTabBarProps> = ({ activeTab, setActiveTab }) => (
  <nav className="md:hidden fixed bottom-0 inset-x-0 z-50 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 flex items-center justify-around h-16 safe-area-inset-bottom">
    {tabs.map(({ id, icon: Icon, label }) => {
      const isActive = activeTab === id;
      return (
        <button
          key={id}
          onClick={() => setActiveTab(id)}
          className={`flex flex-col items-center justify-center gap-1 flex-1 h-full transition-colors ${
            isActive
              ? 'text-blue-600 dark:text-blue-400'
              : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'
          }`}
          aria-label={label}
          aria-current={isActive ? 'page' : undefined}
        >
          <Icon className="w-5 h-5" />
          <span className={`text-[10px] font-medium ${isActive ? 'text-blue-600 dark:text-blue-400' : ''}`}>
            {label}
          </span>
        </button>
      );
    })}
  </nav>
);

export default MobileTabBar;
