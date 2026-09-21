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

// Clerk is loaded with a dynamic import(), never a static one, so its module
// init never runs in agent builds — the same rule App.tsx follows for
// CloudApp / SignInPage.
//
// This used to be a `require('@clerk/clerk-react')` inside try/catch. In a
// Vite ESM bundle `require` is not defined in the browser, so the call threw,
// the catch swallowed it, ClerkOrgProfile stayed null, and the cloud branch
// below was never taken: the org-management UI never rendered on wicklee.dev
// and Team-tier users always saw the "available on the cloud dashboard"
// fallback — on the cloud dashboard. Surfaced by the September lint pass
// (no-require-imports).
//
// Shape matters for bundle size. IS_AGENT / IS_DEMO fold to literals at build
// time, so the ternary folds too and the import() is gone from those bundles.
// A bare `const X = React.lazy(() => import(...))` is NOT enough: Rollup keeps
// the call as a possible side effect even when X is unreferenced, and
// OrganizationProfile's ~22 kB landed in the agent chunk that already carries
// @clerk/clerk-react for the sign-in pages. Measured both ways.
const ClerkOrgProfile = (IS_AGENT || IS_DEMO)
  ? null
  : React.lazy(() =>
      import('@clerk/clerk-react').then(m => ({ default: m.OrganizationProfile })),
    );

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
          <React.Suspense fallback={null}>
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
          </React.Suspense>
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
