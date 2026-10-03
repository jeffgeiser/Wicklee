/**
 * Demo-mode fetch shim. Intercepts every /api/* request (CLOUD_URL-prefixed
 * or same-origin relative) and serves deterministic fixtures so no dashboard
 * tab looks broken — a demo with dead panels is worse than no demo.
 *
 * Reads (GET) get plausible synthetic data derived from the same generator
 * that drives the live stream; writes get a friendly 403 "read-only demo"
 * that the settings panels surface verbatim.
 */

import { CLOUD_URL } from '../utils/cloudUrl';
import { DEMO_NODES, demoFrame, demoSeries } from './demoFleet';

const READ_ONLY = { error: 'Read-only demo — install Wicklee to configure your own fleet.' };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const RANGE_HOURS: Record<string, number> = { '1h': 1, '24h': 24, '7d': 168, '30d': 720, '90d': 2160 };

function historyStep(hours: number): number {
  if (hours <= 1) return 1;        // 1-min buckets
  if (hours <= 24) return 5;
  if (hours <= 168) return 30;
  return 120;
}

const now = () => Date.now();

// ── Fixture builders ──────────────────────────────────────────────────────────

function fleetSnapshot() {
  return demoFrame(now());
}

function wesHistory(range: string) {
  const hours = RANGE_HOURS[range] ?? 24;
  const step = historyStep(hours);
  return {
    nodes: DEMO_NODES.map(def => ({
      node_id: def.node_id,
      hostname: def.hostname,
      points: demoSeries(def, hours, step, now()).map(p => {
        const penalty = p.thermal === 'Fair' ? 1.25 : 1.0;
        const raw = p.tok / p.watts * 10;
        return {
          ts_ms: p.ts_ms,
          raw_wes: raw,
          penalized_wes: raw / penalty,
          thermal_state: p.thermal,
        };
      }),
    })),
  };
}

function metricsHistory(range: string) {
  const hours = RANGE_HOURS[range] ?? 24;
  const step = historyStep(hours);
  return {
    nodes: DEMO_NODES.map(def => ({
      node_id: def.node_id,
      hostname: def.hostname,
      points: demoSeries(def, hours, step, now()).map(p => ({
        ts_ms: p.ts_ms,
        tok_s: p.tok,
        tok_s_p95: p.tok * 1.18,
        watts: p.watts,
        gpu_pct: p.gpu,
        mem_pct: p.mem,
        ttft_ms: 180 + (p.thermal === 'Fair' ? 160 : 0),
        e2e_latency_ms: 2100 + (p.thermal === 'Fair' ? 900 : 0),
      })),
    })),
  };
}

function observations() {
  const t = now();
  return {
    observations: [
      {
        id: 'demo-obs-1', node_id: DEMO_NODES[4].node_id, alert_type: 'thermal_drain',
        severity: 'warning', state: 'open', title: 'Thermal Performance Drain',
        detail: 'Thermal state elevated for 78% of the last 5 minutes. Throughput averages 8.1 tok/s under thermal pressure vs 14.3 tok/s at Normal — a 43% performance drain.',
        context_json: null, fired_at_ms: t - 6 * 60_000, resolved_at_ms: null, ack_at_ms: null,
      },
      {
        id: 'demo-obs-2', node_id: DEMO_NODES[1].node_id, alert_type: 'phantom_load',
        severity: 'warning', state: 'acknowledged', title: 'Phantom Load Detected',
        detail: 'Model "qwen2.5:32b" is loaded in VRAM drawing 96W with zero inference activity for the last 5 minutes — pure idle cost of $0.37/day.',
        context_json: null, fired_at_ms: t - 47 * 60_000, resolved_at_ms: null, ack_at_ms: t - 30 * 60_000,
      },
      {
        id: 'demo-obs-3', node_id: DEMO_NODES[5].node_id, alert_type: 'node_offline',
        severity: 'critical', state: 'resolved', title: 'Node Offline',
        detail: 'edge-4060 stopped reporting telemetry. Back online after 4 minutes.',
        context_json: null, fired_at_ms: t - 3 * 3600_000, resolved_at_ms: t - 3 * 3600_000 + 4 * 60_000, ack_at_ms: null,
      },
    ],
  };
}

function eventsHistory() {
  const t = now();
  return {
    events: [
      { ts_ms: t - 4 * 60_000,  node_id: DEMO_NODES[2].node_id, level: 'info', event_type: 'model_swap',     message: 'qwen2.5:32b → mistral:7b' },
      { ts_ms: t - 11 * 60_000, node_id: DEMO_NODES[4].node_id, level: 'warn', event_type: 'thermal_change', message: 'Normal → Fair' },
      { ts_ms: t - 26 * 60_000, node_id: DEMO_NODES[5].node_id, level: 'info', event_type: 'node_online',    message: 'Node back online — telemetry resumed' },
      { ts_ms: t - 30 * 60_000, node_id: DEMO_NODES[5].node_id, level: 'warn', event_type: 'node_offline',   message: 'Node stopped reporting telemetry' },
    ],
  };
}

function slos() {
  const t = now();
  return {
    slos: [
      { id: 'demo-slo-1', name: 'Prod inference latency', tag: 'env:prod', node_id: null,
        metric: 'ttft_p95_ms', threshold: 500, target_pct: 99, enabled: true, created_at: t - 20 * 86400_000,
        windows_30d: 7912, bad_30d: 31, compliance_pct: 99.61, burn_pct: 39.2,
        latest: { ts: t - 120_000, sli: 312.4, ok: true } },
      { id: 'demo-slo-2', name: 'Staging throughput floor', tag: 'env:staging', node_id: null,
        metric: 'tok_s_p50', threshold: 12, target_pct: 95, enabled: true, created_at: t - 12 * 86400_000,
        windows_30d: 3420, bad_30d: 168, compliance_pct: 95.09, burn_pct: 98.2,
        latest: { ts: t - 120_000, sli: 9.8, ok: false } },
    ],
  };
}

function chargeback() {
  const row = (key: string, kwh: number, tokM: number, hours: number) => ({
    key, energy_kwh: kwh, cost_usd: kwh * 0.16, tokens_m: tokM,
    usd_per_mtok: tokM > 0 ? (kwh * 0.16) / tokM : null, hours_covered: hours,
  });
  return {
    days: 30, kwh_rate: 0.16,
    totals: row('total', 214.6, 4183.2, 4210),
    by_tag: [
      row('env:prod', 187.2, 3890.4, 2880),
      row('gpu', 121.4, 2410.8, 1440),
      row('env:staging', 27.4, 292.8, 1330),
      row('(untagged)', 0, 0, 0),
    ],
    by_model: [
      row('llama3.1:70b', 96.1, 1890.2, 720),
      row('qwen2.5:32b', 78.3, 1410.6, 1400),
      row('llama3.1:8b', 22.8, 640.1, 710),
      row('mistral:7b', 12.2, 201.4, 900),
      row('phi3:mini', 5.2, 40.9, 480),
    ],
    by_node: DEMO_NODES.slice(0, 5).map((d, i) => row(d.node_id, [96, 61, 38, 12, 6][i], [1890, 1200, 820, 210, 62][i], 720)),
    daily: Array.from({ length: 30 }, (_, i) => {
      const d = new Date(now() - (29 - i) * 86400_000);
      return row(d.toISOString().slice(0, 10), 6.4 + (i % 7) * 0.5, 130 + (i % 7) * 9, 140);
    }),
  };
}

function auditLog() {
  const t = now();
  const e = (id: number, mins: number, email: string, action: string, target: string, details: Record<string, unknown> = {}) =>
    ({ id, ts: t - mins * 60_000, user_id: 'demo-user', org_id: 'demo-org', actor_email: email, action, target, details });
  return {
    entries: [
      e(107, 14,  'ops@demo.wicklee.dev',   'fleet_config.applied',  'env:prod', { desired_profile: 'production_fleet', nodes_affected: 4 }),
      e(106, 62,  'ops@demo.wicklee.dev',   'alert_silence.created', 'demo-silence', { tag: 'env:staging', reason: 'GPU driver upgrade' }),
      e(105, 190, 'admin@demo.wicklee.dev', 'api_key.created',       'demo-key', { name: 'CI pipeline', scope: 'org' }),
      e(104, 260, 'admin@demo.wicklee.dev', 'webhook.created',       'demo-hook', { event_type: 'thermal_state_changed', url: 'https://hooks.demo/wicklee' }),
      e(103, 300, 'ops@demo.wicklee.dev',   'node.updated',          DEMO_NODES[4].node_id, { tags: 'env:staging, apple' }),
      e(102, 2000, 'admin@demo.wicklee.dev','slo.created',           'demo-slo-1', { name: 'Prod inference latency', metric: 'ttft_p95_ms' }),
      e(101, 2600, 'admin@demo.wicklee.dev','node.paired',           DEMO_NODES[0].node_id, {}),
    ],
    next_before: null,
  };
}

function silences() {
  const t = now();
  return {
    silences: [
      { id: 'demo-silence', node_id: null, tag: 'env:staging', event_type: null,
        reason: 'GPU driver upgrade', starts_at: t - 40 * 60_000, ends_at: t + 80 * 60_000,
        created_at: t - 62 * 60_000, active: true },
    ],
  };
}

function modelComparison() {
  return {
    models: [
      { model: 'llama3.1:70b', tok_s_avg: 208.4, avg_watts: 538.2, wes_avg: 3.6, ttft_ms_avg: 240, cost_usd: 96.1, hours_active: 690, sample_count: 8300 },
      { model: 'qwen2.5:32b',  tok_s_avg: 91.7,  avg_watts: 322.5, wes_avg: 2.8, ttft_ms_avg: 210, cost_usd: 78.3, hours_active: 1380, sample_count: 16500 },
      { model: 'llama3.1:8b',  tok_s_avg: 42.1,  avg_watts: 38.4,  wes_avg: 10.9, ttft_ms_avg: 160, cost_usd: 22.8, hours_active: 700, sample_count: 8400 },
      { model: 'mistral:7b',   tok_s_avg: 33.8,  avg_watts: 128.9, wes_avg: 2.6, ttft_ms_avg: 190, cost_usd: 12.2, hours_active: 880, sample_count: 10600 },
      { model: 'phi3:mini',    tok_s_avg: 13.4,  avg_watts: 21.7,  wes_avg: 6.1, ttft_ms_avg: 140, cost_usd: 5.2, hours_active: 470, sample_count: 5700 },
    ],
  };
}

function modelSwitches() {
  const t = now();
  return {
    switches: [
      { node_id: DEMO_NODES[2].node_id, from_model: 'qwen2.5:32b', to_model: 'mistral:7b', ts_ms: t - 4 * 60_000,  gap_ms: 9200 },
      { node_id: DEMO_NODES[2].node_id, from_model: 'mistral:7b', to_model: 'qwen2.5:32b', ts_ms: t - 94 * 60_000, gap_ms: 11400 },
      { node_id: DEMO_NODES[0].node_id, from_model: 'llama3.1:8b', to_model: 'qwen2.5:14b', ts_ms: t - 3 * 3600_000, gap_ms: 8100 },
    ],
    total_switches: 3,
    total_overhead_min: 0.5,
  };
}

// ── Router ────────────────────────────────────────────────────────────────────

function route(pathname: string, search: URLSearchParams, method: string): Response | null {
  if (method !== 'GET') {
    // Acknowledge/resolve/dismiss and every settings write → friendly read-only.
    return json(READ_ONLY, 403);
  }

  if (pathname === '/api/auth/stream-token') return json({ stream_token: 'demo' });
  if (pathname === '/api/fleet')             return json(fleetSnapshot());
  if (pathname === '/api/fleet/wes-history')     return json(wesHistory(search.get('range') ?? '24h'));
  if (pathname === '/api/fleet/metrics-history') return json(metricsHistory(search.get('range') ?? '24h'));
  if (pathname === '/api/fleet/observations')    return json(observations());
  if (pathname === '/api/fleet/events/history')  return json(eventsHistory());
  if (pathname === '/api/slo')                   return json(slos());
  if (pathname === '/api/v1/fleet/chargeback')   return json(chargeback());
  if (pathname === '/api/audit-log')             return json(auditLog());
  if (pathname === '/api/audit-log/drain')       return json({ configured: false });
  if (pathname === '/api/alerts/channels')       return json({ channels: [
    { id: 'demo-chan', channel_type: 'slack', name: 'ops-alerts', config_json: '{}', verified: true, created_at: now() - 40 * 86400_000 },
  ] });
  if (pathname === '/api/alerts/rules')          return json({ rules: [
    { id: 'demo-rule', node_id: null, event_type: 'thermal_critical', threshold_value: null,
      urgency: 'immediate', channel_id: 'demo-chan', enabled: true, created_at: now() - 40 * 86400_000, tag: 'env:prod' },
  ] });
  if (pathname === '/api/alerts/silences')       return json(silences());
  if (pathname === '/api/v1/webhooks')           return json({ subscriptions: [
    { id: 'demo-hook', url: 'https://hooks.demo/wicklee', event_type: 'thermal_state_changed',
      node_id: null, tag: 'env:prod', threshold: null, cooldown_s: 60, enabled: true, last_fired_ms: now() - 11 * 60_000 },
  ] });
  if (pathname === '/api/v1/keys')               return json({ keys: [
    { key_id: 'demo-key', name: 'CI pipeline', created_at: now() - 30 * 86400_000, last_used_ms: now() - 3600_000, scope: 'org' },
  ] });
  if (pathname === '/api/v1/fleet/model-comparison') return json(modelComparison());
  if (pathname === '/api/v1/fleet/model-switches')   return json(modelSwitches());
  if (pathname === '/api/v1/fleet/cost-by-model')    return json({
    range_hours: 24, kwh_rate: 0.16, total_cost_usd: 7.14,
    models: modelComparison().models.map(m => ({ model: m.model, hours_active: m.hours_active / 30, avg_watts: m.avg_watts, cost_usd: m.cost_usd / 30, tok_s_avg: m.tok_s_avg })),
  });
  if (pathname === '/api/v1/thermal-budget') return json({
    node_id: search.get('node_id') ?? DEMO_NODES[4].node_id, samples_analyzed: 1834, transitions_detected: 9,
    confidence: 'high', sustainable_tps: 13.8, sustainable_watts: 20.5, push_threshold_tps: 17.2,
    push_threshold_watts: 27.0, time_to_fair_min: 7.5, fair_penalized_tps: 13.7,
    advice: 'Sustainable rate: 14 tok/s indefinitely at Normal thermal. Pushing to 17 tok/s triggers Fair thermal within ~8 min, dropping effective throughput to 14 tok/s. Net over 1 hour: pushing yields 2% fewer tokens than holding the sustainable rate.',
  });
  if (pathname === '/api/otel/config')     return json({ enabled: false, endpoint: null });
  if (pathname === '/api/fleet/duty')      return json({ nodes: [] });
  if (pathname === '/api/billing/config')  return json(READ_ONLY, 403);
  if (pathname === '/api/agent/version')   return json({ version: '0.11.0' });

  // Anything else under /api → graceful "not in the demo".
  return json({ error: 'Not part of the demo' }, 404);
}

/** Install the shim. Call once, before the app renders. */
export function installDemoFetch(): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      // Normalize: strip CLOUD_URL prefix or resolve relative against origin.
      const url = raw.startsWith(CLOUD_URL)
        ? new URL(raw)
        : new URL(raw, window.location.origin);
      if (url.pathname.startsWith('/api/')) {
        const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET')).toUpperCase();
        const res = route(url.pathname, url.searchParams, method);
        if (res) return Promise.resolve(res);
      }
    } catch { /* fall through to the real fetch */ }
    return realFetch(input as RequestInfo, init);
  }) as typeof window.fetch;
}
