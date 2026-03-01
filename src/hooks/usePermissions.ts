
import { User, UserRole } from '../types';

export const usePermissions = (user: User | null) => {
  const hasRole = (roles: UserRole[]) => {
    if (!user) return false;
    return roles.includes(user.role);
  };

  return {
    isOwner: user?.role === 'Owner',
    isCollaborator: user?.role === 'Collaborator',
    isViewer: user?.role === 'Viewer',
    canManageFleet: hasRole(['Owner', 'Collaborator']),
    canViewScaffolding: hasRole(['Owner', 'Collaborator']),
    canRunAIAnalysis: hasRole(['Owner', 'Collaborator']),
    canManageTeam: hasRole(['Owner']),
  };
};
