import React from 'react';
import { Users } from 'lucide-react';
import { IS_AGENT, IS_DEMO } from '../utils/buildTarget';

/**
 * TeamManagement — Clerk Organization management for shared fleet access.
 *
 * On the cloud build, OrganizationProfile is loaded from @clerk/clerk-react
 * and handles member list, invitations, roles, and removal — no custom backend needed.
 * On the agent/localhost build, this renders a static message (Clerk not available).
 */

const ClerkOrgProfile = (IS_AGENT || IS_DEMO)
  ? null
  : React.lazy(() =>
      import('@clerk/clerk-react').then(m => ({ default: m.OrganizationProfile })),
    );
const ClerkCreateOrg = (IS_AGENT || IS_DEMO)
  ? null
  : React.lazy(() =>
      import('@clerk/clerk-react').then(m => ({ default: m.CreateOrganization })),
    );

interface TeamManagementProps {
  tenantId: string;
  currentUser: { id: string; email: string; fullName: string; role: string };
  /** Active Clerk organization id (null = personal workspace). */
  orgId?: string | null;
}

const clerkAppearance = {
  baseTheme: undefined,
  elements: {
    rootBox: 'w-full',
    cardBox: 'shadow-none border-0 bg-transparent',
    navbar: 'bg-gray-900',
    pageScrollBox: 'bg-gray-800',
  },
};

const TeamManagement: React.FC<TeamManagementProps> = ({ orgId }) => {
  if (ClerkCreateOrg && !orgId) {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-xl font-bold text-white">Team Management</h3>
          <p className="text-sm text-gray-500 mt-1">
            Create an organization to invite teammates. Nodes you pair while the organization is active belong to it, and every member shares the same fleet dashboard.
          </p>
        </div>
        <div className="rounded-2xl overflow-hidden border border-gray-700 bg-gray-800 p-2">
          <React.Suspense fallback={null}>
            <ClerkCreateOrg appearance={clerkAppearance} />
          </React.Suspense>
        </div>
      </div>
    );
  }

  if (ClerkOrgProfile) {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-xl font-bold text-white">Team Management</h3>
          <p className="text-sm text-gray-500 mt-1">
            Manage your organization members, invitations, and roles. All members share the same fleet dashboard.
          </p>
        </div>
        <div className="rounded-2xl overflow-hidden border border-gray-700 bg-gray-800">
          <React.Suspense fallback={null}>
            <ClerkOrgProfile appearance={clerkAppearance} />
          </React.Suspense>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Users className="w-12 h-12 text-gray-600 mb-4" />
      <h3 className="text-lg font-bold text-white mb-2">Team Management</h3>
      <p className="text-sm text-gray-500 max-w-md">
        Team management is available on the cloud dashboard at wicklee.dev.
        Create a Clerk organization to invite team members and share your fleet dashboard.
      </p>
    </div>
  );
};

export default TeamManagement;
