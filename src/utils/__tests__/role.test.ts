import { describe, it, expect } from 'vitest';
import { roleFromOrgMembership } from '../role';

describe('roleFromOrgMembership', () => {
  it('treats a solo account as Owner', () => {
    expect(roleFromOrgMembership(null, null)).toBe('Owner');
  });
  it('maps Clerk org roles', () => {
    expect(roleFromOrgMembership('org_1', 'org:admin')).toBe('Owner');
    expect(roleFromOrgMembership('org_1', 'org:member')).toBe('Collaborator');
    expect(roleFromOrgMembership('org_1', 'org:viewer')).toBe('Viewer');
  });
  it('never grants Owner to an org member whose role has not loaded', () => {
    expect(roleFromOrgMembership('org_1', undefined)).toBe('Collaborator');
  });
});
