import React from 'react';
import { Users } from 'lucide-react';

/**
 * TeamManagement — Clerk Organization management for shared fleet access.
 *
 * On the cloud build, OrganizationProfile is loaded from @clerk/clerk-react
 * and handles member list, invitations, roles, and removal — no custom backend needed.
 * On the agent/localhost build, this renders a static message (Clerk not available).
 */

// Dynamic import: OrganizationProfile is only available in cloud builds with Clerk.
// We lazy-import to avoid breaking agent builds that don't have @clerk/clerk-react.
let ClerkOrgProfile: React.FC<{ appearance?: object }> | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const clerk = require('@clerk/clerk-react');
  ClerkOrgProfile = clerk.OrganizationProfile;
} catch {
  // Clerk not available (agent build) — will render fallback below
}

interface TeamManagementProps {
  tenantId: string;
  currentUser: { id: string; email: string; fullName: string; role: string };
}

const TeamManagement: React.FC<TeamManagementProps> = () => {
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
          <ClerkOrgProfile
            appearance={{
              baseTheme: undefined,
              elements: {
                rootBox: 'w-full',
                cardBox: 'shadow-none border-0 bg-transparent',
                navbar: 'bg-gray-900',
                pageScrollBox: 'bg-gray-800',
              },
            }}
          />
        </div>
      </div>
    );
  }

  // Fallback for localhost/agent builds
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
