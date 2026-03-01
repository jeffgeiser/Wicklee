import React from 'react';
import { User, Shield, UserPlus, Mail, MoreHorizontal } from 'lucide-react';
import { User as UserType, UserRole } from '../types';

interface TeamManagementProps {
  tenantId: string;
}

const MOCK_TEAM: UserType[] = [
  { id: 'usr-01', email: 'sarah@wicklee.io', fullName: 'Sarah Chen', role: 'Owner' },
  { id: 'usr-02', email: 'marcus@wicklee.io', fullName: 'Marcus Thorne', role: 'Collaborator' },
  { id: 'usr-03', email: 'leo@wicklee.io', fullName: 'Leo Varis', role: 'Collaborator' },
  { id: 'usr-04', email: 'audit@wicklee.io', fullName: 'External Audit', role: 'Viewer' },
];

const TeamManagement: React.FC<TeamManagementProps> = ({ tenantId }) => {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xl font-bold text-gray-900 dark:text-white">Team Members</h3>
          <p className="text-sm text-gray-500 mt-1">Manage permissions and identities for {tenantId}</p>
        </div>
        <button className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold transition-all shadow-lg shadow-blue-500/20">
          <UserPlus className="w-4 h-4" />
          Invite Member
        </button>
      </div>

      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden shadow-sm dark:shadow-none transition-colors">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-950/50 text-[10px] text-gray-500 uppercase tracking-widest font-bold border-b border-gray-200 dark:border-gray-800">
              <th className="px-6 py-4 text-center w-20">Identity</th>
              <th className="px-6 py-4">User Details</th>
              <th className="px-6 py-4">Role / Permissions</th>
              <th className="px-6 py-4">Status</th>
              <th className="px-6 py-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {MOCK_TEAM.map((member) => (
              <tr key={member.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors group">
                <td className="px-6 py-4">
                  <div className="w-10 h-10 rounded-xl bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 flex items-center justify-center text-gray-400 font-bold mx-auto">
                    {member.fullName.charAt(0)}
                  </div>
                </td>
                <td className="px-6 py-4">
                  <div className="flex flex-col">
                    <span className="text-sm font-semibold text-gray-900 dark:text-gray-200">{member.fullName}</span>
                    <span className="text-xs text-gray-500 flex items-center gap-1">
                      <Mail className="w-3 h-3" /> {member.email}
                    </span>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    <Shield className={`w-3.5 h-3.5 ${
                      member.role === 'Owner' ? 'text-blue-600 dark:text-blue-400' :
                      member.role === 'Collaborator' ? 'text-cyan-500 dark:text-cyan-400' :
                      'text-gray-500'
                    }`} />
                    <span className={`text-xs font-bold tracking-wide uppercase ${
                      member.role === 'Owner' ? 'text-blue-600 dark:text-blue-400' :
                      member.role === 'Collaborator' ? 'text-cyan-500 dark:text-cyan-400' :
                      'text-gray-500'
                    }`}>
                      {member.role}
                    </span>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-500/10 text-green-600 dark:text-green-500 border border-green-500/20">
                    Active
                  </span>
                </td>
                <td className="px-6 py-4 text-right">
                  <button className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg text-gray-500 transition-colors">
                    <MoreHorizontal className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default TeamManagement;