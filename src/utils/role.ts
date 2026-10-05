/**
 * Dashboard role from the Clerk organization membership.
 *
 * Every signed-in cloud user used to be hardcoded to Owner, so org members
 * saw Owner-only UI (Team Management). Clerk still enforces membership
 * changes itself; this only decides what the dashboard shows.
 */

import type { UserRole } from '../types';

/**
 * - No active organization → Owner (a solo account owns its own fleet).
 * - `org:admin` → Owner.
 * - `org:viewer` (custom role) → Viewer.
 * - `org:member` or any other role → Collaborator.
 */
export function roleFromOrgMembership(orgId: string | null | undefined, orgRole: string | null | undefined): UserRole {
  if (!orgId) return 'Owner';
  if (orgRole === 'org:admin') return 'Owner';
  if (orgRole === 'org:viewer') return 'Viewer';
  return 'Collaborator';
}
