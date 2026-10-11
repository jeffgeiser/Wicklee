/**
 * The demo build serves every /api call from fixtures; anything unrouted
 * returns 404 and the card shows "Server returned 404". Idle Waste, Capacity
 * Planner, Migration Advisor and Model Discovery shipped that way. Pin every
 * GET the demo dashboard makes on load so a new cloud card can't regress it.
 */

import { describe, it, expect } from 'vitest';
import { route } from '../demoApi';

const DASHBOARD_GETS = [
  '/api/fleet',
  '/api/fleet/wes-history?range=7d',
  '/api/fleet/metrics-history?range=24h',
  '/api/fleet/observations',
  '/api/fleet/events/history',
  '/api/fleet/duty',
  '/api/fleet/model-candidates?limit=200',
  '/api/slo',
  '/api/digest',
  '/api/v1/fleet/chargeback?days=30',
  '/api/v1/fleet/idle-waste?days=30',
  '/api/v1/fleet/capacity',
  '/api/v1/fleet/migration-advisor',
  '/api/v1/fleet/model-comparison',
  '/api/v1/fleet/model-switches',
  '/api/v1/fleet/cost-by-model',
  '/api/v1/thermal-budget',
];

describe('demo fetch shim', () => {
  it.each(DASHBOARD_GETS)('serves %s', async (path) => {
    const u = new URL(path, 'https://demo.invalid');
    const res = route(u.pathname, u.searchParams, 'GET');
    expect(res?.status).toBe(200);
    await expect(res!.json()).resolves.toBeTruthy();
  });

  it('answers writes as read-only, not 404', () => {
    expect(route('/api/digest', new URLSearchParams(), 'PUT')?.status).toBe(403);
  });

  it('capacity scenarios close the gap to the requested target', async () => {
    const body = await route('/api/v1/fleet/capacity', new URLSearchParams('target_tok_s=900'), 'GET')!.json();
    expect(body.target_tok_s).toBe(900);
    expect(body.target_met).toBe(false);
    for (const s of body.scenarios) {
      expect(body.fleet.sustained_tok_s + s.est_added_tok_s).toBeGreaterThanOrEqual(900 - 0.1);
    }
  });
});
