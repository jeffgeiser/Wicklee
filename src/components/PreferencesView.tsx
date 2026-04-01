import React from 'react';
import { Settings, Moon, Bell, Globe, Layout, Cpu, Sun } from 'lucide-react';
import { Tenant } from '../types';

interface PreferencesViewProps {
  currentTenant: Tenant;
  theme?: 'light' | 'dark';
  setTheme?: (theme: 'light' | 'dark') => void;
}

const PreferencesView: React.FC<PreferencesViewProps> = ({ currentTenant, theme, setTheme }) => {
  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in duration-500">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Preferences</h1>
        <p className="text-gray-500">Customize your Wicklee experience and system notifications.</p>
      </div>

      <div className="grid grid-cols-1 gap-6">
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl divide-y divide-gray-100 dark:divide-gray-800 shadow-sm dark:shadow-none transition-colors">
          <div className="p-6 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="p-2 bg-gray-100 dark:bg-gray-800 rounded-lg text-blue-600 dark:text-blue-400 transition-colors">
                {theme === 'dark' ? <Moon className="w-5 h-5" /> : <Sun className="w-5 h-5" />}
              </div>
              <div>
                <h4 className="text-sm font-bold font-telin text-gray-900 dark:text-gray-200">Interface Theme</h4>
                <p className="text-xs text-gray-500">Control how Wicklee looks on your screen.</p>
              </div>
            </div>
            <select 
              value={theme}
              onChange={(e) => setTheme?.(e.target.value as 'light' | 'dark')}
              className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-xs text-gray-900 dark:text-gray-300 rounded-lg px-3 py-1.5 outline-none transition-colors cursor-pointer"
            >
              <option value="dark">Dark Mode</option>
              <option value="light">Light Mode</option>
            </select>
          </div>

          <div className="p-6 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="p-2 bg-gray-100 dark:bg-gray-800 rounded-lg text-blue-600 dark:text-blue-400">
                <Bell className="w-5 h-5" />
              </div>
              <div>
                <h4 className="text-sm font-bold font-telin text-gray-900 dark:text-gray-200">Thermal Alerts</h4>
                <p className="text-xs text-gray-500">Notify when node temperature exceeds 80°C.</p>
              </div>
            </div>
            <div className="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" className="sr-only peer" defaultChecked />
              <div className="w-11 h-6 bg-gray-200 dark:bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 dark:after:border-gray-800 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
            </div>
          </div>

          <div className="p-6 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="p-2 bg-gray-100 dark:bg-gray-800 rounded-lg text-blue-600 dark:text-blue-400">
                <Layout className="w-5 h-5" />
              </div>
              <div>
                <h4 className="text-sm font-bold font-telin text-gray-900 dark:text-gray-200">Default Workspace</h4>
                <p className="text-xs text-gray-500">The tenant loaded initially on login.</p>
              </div>
            </div>
            <span className="text-xs font-telin text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 px-3 py-1 rounded-lg border border-gray-200 dark:border-gray-700 transition-colors">
              {currentTenant.name}
            </span>
          </div>

          <div className="p-6 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="p-2 bg-gray-100 dark:bg-gray-800 rounded-lg text-blue-600 dark:text-blue-400">
                <Cpu className="w-5 h-5" />
              </div>
              <div>
                <h4 className="text-sm font-bold font-telin text-gray-900 dark:text-gray-200">High-Resolution Scraping</h4>
                <p className="text-xs text-gray-500">Enable 500ms telemetry updates (Higher bandwidth).</p>
              </div>
            </div>
            <div className="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" className="sr-only peer" />
              <div className="w-11 h-6 bg-gray-200 dark:bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:translate-x-full peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 dark:after:border-gray-800 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3">
          <button className="px-6 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 text-sm font-bold rounded-xl transition-all border border-gray-200 dark:border-transparent">
            Reset Defaults
          </button>
          <button className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold rounded-xl transition-all shadow-lg shadow-blue-500/20">
            Save Preferences
          </button>
        </div>
      </div>
    </div>
  );
};

export default PreferencesView;