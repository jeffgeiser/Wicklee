import React from 'react';
import { User as UserIcon, Mail, Shield, Calendar, MapPin, Globe } from 'lucide-react';
import { User as UserType } from '../types';

interface ProfileViewProps {
  currentUser: UserType;
}

const ProfileView: React.FC<ProfileViewProps> = ({ currentUser }) => {
  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in duration-500">
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-[32px] p-8 overflow-hidden relative shadow-sm dark:shadow-none transition-colors">
        <div className="absolute top-0 right-0 w-64 h-64 bg-blue-600/10 blur-[80px] rounded-full -mr-20 -mt-20"></div>
        
        <div className="flex flex-col md:flex-row items-center gap-8 relative z-10">
          <div className="w-32 h-32 rounded-3xl bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 flex items-center justify-center text-gray-400 text-4xl font-bold shadow-2xl">
            {currentUser.fullName.charAt(0)}
          </div>
          <div className="flex-1 text-center md:text-left space-y-2">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{currentUser.fullName}</h1>
            <div className="flex flex-wrap items-center justify-center md:justify-start gap-4 text-sm text-gray-500">
              <span className="flex items-center gap-1.5"><Mail className="w-4 h-4" /> {currentUser.email}</span>
              <span className="flex items-center gap-1.5"><Shield className="w-4 h-4" /> {currentUser.role}</span>
              <span className="flex items-center gap-1.5"><MapPin className="w-4 h-4" /> San Francisco, CA</span>
            </div>
            <p className="text-gray-600 dark:text-gray-400 text-sm max-w-xl">
              Principal Systems Engineer at Wicklee. Focused on distributed inference scaling and thermal-aware orchestration for low-latency AI applications.
            </p>
          </div>
          <button className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold rounded-xl transition-all shadow-lg shadow-blue-500/20">
            Edit Profile
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-6 space-y-6 shadow-sm dark:shadow-none transition-colors">
          <h3 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <UserIcon className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            Identity Details
          </h3>
          <div className="space-y-4">
            {[
              { label: 'Display Name', value: currentUser.fullName },
              { label: 'Email Address', value: currentUser.email },
              { label: 'Organization Role', value: currentUser.role },
              { label: 'Language', value: 'English (US)' },
              { label: 'Timezone', value: 'Pacific Standard Time (PST)' }
            ].map(item => (
              <div key={item.label} className="flex justify-between items-center py-2 border-b border-gray-100 dark:border-gray-800/50">
                <span className="text-sm text-gray-500">{item.label}</span>
                <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">{item.value}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-6 space-y-6 shadow-sm dark:shadow-none transition-colors">
          <h3 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Globe className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            Activity Snapshot
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-gray-50 dark:bg-gray-800/30 p-4 rounded-xl border border-gray-100 dark:border-gray-800">
              <p className="text-xs text-gray-500 uppercase font-bold tracking-wider mb-1">Joined</p>
              <p className="text-lg font-bold text-gray-900 dark:text-white">Jan 2024</p>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800/30 p-4 rounded-xl border border-gray-100 dark:border-gray-800">
              <p className="text-xs text-gray-500 uppercase font-bold tracking-wider mb-1">Fleet Access</p>
              <p className="text-lg font-bold text-gray-900 dark:text-white">4 Clusters</p>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800/30 p-4 rounded-xl border border-gray-100 dark:border-gray-800">
              <p className="text-xs text-gray-500 uppercase font-bold tracking-wider mb-1">Deployments</p>
              <p className="text-lg font-bold text-gray-900 dark:text-white">128 Total</p>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800/30 p-4 rounded-xl border border-gray-100 dark:border-gray-800">
              <p className="text-xs text-gray-500 uppercase font-bold tracking-wider mb-1">Last Active</p>
              <p className="text-lg font-bold text-gray-900 dark:text-white">2m ago</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProfileView;