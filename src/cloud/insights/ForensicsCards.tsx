/**
 * ForensicsCards — the Team-tier cards on the Insights → Forensics tab
 * (insights 8, 9, 11, 12, 13) plus the Enterprise Sovereignty Audit (14).
 *
 * These replaced hardcoded "Collecting history…" placeholders. History comes
 * from the cloud endpoints already used by the Performance charts (both are
 * open to Team at the 7d range), fetched once for all cards by
 * useForensicsHistory and refreshed every 5 minutes. The analysis itself is in
 * utils/forensics.ts.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { TrendingDown, Database, Activity, Globe, Layers, Shield } from 'lucide-react';
import { CLOUD_URL } from '../../utils/cloudUrl';
import { CONTACT_EMAIL, mailto } from '../../site/utils/contact';
import {
  efficiencyRegressions, memoryForecasts, coldStarts, thermalDiversity,
  inferenceDensity, fmtDuration,
  type WesHistoryNode, type MetricsHistoryNode,
} from '../../utils/forensics';

// ── Data ──────────────────────────────────────────────────────────────────────

export interface ForensicsHistory {
  wes7d: WesHistoryNode[] | null;
  metrics24h: MetricsHistoryNode[] | null;
  metrics7d: MetricsHistoryNode[] | null;
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
}

const REFRESH_MS = 5 * 60_000;

/**
 * Fetches the three history series the Forensics cards need. `getToken` is
 * absent in the local agent dashboard, where there is no cloud history.
 */
export function useForensicsHistory(
  getToken: (() => Promise<string | null>) | undefined,
  enabled: boolean,
): ForensicsHistory {
  const [state, setState] = useState<ForensicsHistory>({
    wes7d: null, metrics24h: null, metrics7d: null, loading: false, error: null, fetchedAt: null,
  });

  // Latest getToken without making it a dependency: the demo build passes an
  // inline arrow (new identity every render), which would refetch every frame.
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const hasToken = !!getToken;

  const load = useCallback(async (signal: AbortSignal) => {
    const getTok = getTokenRef.current;
    if (!getTok) return;
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const token = await getTok();
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      const get = async (path: string) => {
        const res = await fetch(`${CLOUD_URL}${path}`, { headers, signal });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        return (await res.json()).nodes ?? [];
      };
      const [wes7d, metrics24h, metrics7d] = await Promise.all([
        get('/api/fleet/wes-history?range=7d'),
        get('/api/fleet/metrics-history?range=24h'),
        get('/api/fleet/metrics-history?range=7d'),
      ]);
      setState({ wes7d, metrics24h, metrics7d, loading: false, error: null, fetchedAt: Date.now() });
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'AbortError') return;
      setState(s => ({ ...s, loading: false, error: e instanceof Error ? e.message : 'Failed to load history' }));
    }
  }, []);

  useEffect(() => {
    if (!enabled || !hasToken) return;
    const ctrl = new AbortController();
    load(ctrl.signal);
    const id = setInterval(() => load(ctrl.signal), REFRESH_MS);
    return () => { ctrl.abort(); clearInterval(id); };
  }, [enabled, hasToken, load]);

  return state;
}

// ── Shared chrome ─────────────────────────────────────────────────────────────

const Card: React.FC<{ title: string; icon: React.ReactNode; badge?: string; children: React.ReactNode }> = ({
  title, icon, badge = 'Team', children,
}) => (
  <div className="bg-gray-800 border border-gray-700 rounded-2xl p-4 flex flex-col gap-3">
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-gray-400 shrink-0">{icon}</span>
        <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 truncate">{title}</span>
      </div>
      <span className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded border shrink-0 text-violet-400 bg-violet-500/10 border-violet-500/25">
        {badge}
      </span>
    </div>
    {children}
  </div>
);

const Muted: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-xs text-gray-500">{children}</p>
);

const Row: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="flex items-baseline justify-between gap-2 text-xs">
    <span className="font-mono text-gray-400 truncate">{label}</span>
    <span className="shrink-0">{value}</span>
  </div>
);

/**
 * Loading / error / no-cloud states shared by every card. Returns null when
 * the data is ready and the card should render its own body.
 */
function statusBody(h: ForensicsHistory, hasCloud: boolean, series: unknown): React.ReactNode | null {
  if (!hasCloud) return <Muted>History-based forensics run in the cloud dashboard at wicklee.dev.</Muted>;
  if (series == null && h.error) return <Muted>Couldn’t load history ({h.error}).</Muted>;
  if (series == null) return <Muted>Loading history…</Muted>;
  return null;
}

interface CardProps { history: ForensicsHistory; hasCloud: boolean }

// ── 8 · Efficiency Regression ─────────────────────────────────────────────────

/** "+4%", "-12%", "0%" (Math.round, unlike toFixed, never yields "-0"). */
const fmtDelta = (pct: number) => {
  const r = Math.round(pct) || 0;
  return `${r > 0 ? '+' : ''}${r}%`;
};

export const EfficiencyRegressionCard: React.FC<CardProps> = ({ history, hasCloud }) => {
  const status = statusBody(history, hasCloud, history.wes7d);
  const rows = history.wes7d ? efficiencyRegressions(history.wes7d, Date.now()) : [];
  return (
    <Card title="Efficiency Regression" icon={<TrendingDown className="w-3.5 h-3.5" />}>
      {status ?? (rows.length === 0 ? (
        <Muted>Needs inference on at least one node in the last 24 h and 6 h of earlier history to compare against.</Muted>
      ) : (
        <div className="space-y-1.5">
          <p className="text-[10px] text-gray-500 uppercase tracking-widest">WES · last 24 h vs. prior 6 days</p>
          {rows.slice(0, 4).map(r => (
            <Row key={r.node_id} label={r.hostname} value={
              <>
                <span className="text-gray-400">{r.baselineWes.toFixed(1)} → {r.recentWes.toFixed(1)}</span>
                <span className={`ml-2 font-telin font-bold ${r.deltaPct <= -15 ? 'text-red-400' : r.deltaPct <= -5 ? 'text-amber-400' : 'text-green-400'}`}>
                  {fmtDelta(r.deltaPct)}
                </span>
              </>
            } />
          ))}
          {rows[0].deltaPct <= -15 && (
            <p className="text-[11px] text-red-300/80">
              {rows[0].hostname} is {Math.abs(rows[0].deltaPct).toFixed(0)}% less efficient than its baseline. Check thermals, the loaded model and quantization.
            </p>
          )}
        </div>
      ))}
    </Card>
  );
};

// ── 9 · Memory Forecast ───────────────────────────────────────────────────────

export const MemoryForecastCard: React.FC<CardProps> = ({ history, hasCloud }) => {
  const status = statusBody(history, hasCloud, history.metrics24h);
  const rows = history.metrics24h ? memoryForecasts(history.metrics24h, Date.now()) : [];
  return (
    <Card title="Memory Forecast" icon={<Database className="w-3.5 h-3.5" />}>
      {status ?? (rows.length === 0 ? (
        <Muted>Needs memory-pressure samples from the last 2 hours.</Muted>
      ) : (
        <div className="space-y-1.5">
          <p className="text-[10px] text-gray-500 uppercase tracking-widest">Time to 95% · 2 h trend</p>
          {rows.slice(0, 4).map(r => (
            <Row key={r.node_id} label={r.hostname} value={
              <>
                <span className="text-gray-400">{r.currentPct.toFixed(0)}%</span>
                <span className={`ml-2 font-telin font-bold ${
                  r.etaMs == null ? 'text-green-400' : r.etaMs < 15 * 60_000 ? 'text-red-400' : r.etaMs < 2 * 3_600_000 ? 'text-amber-400' : 'text-gray-300'
                }`}>
                  {r.etaMs == null ? 'stable' : `~${fmtDuration(r.etaMs)}`}
                </span>
              </>
            } />
          ))}
        </div>
      ))}
    </Card>
  );
};

// ── 11 · Hardware Cold Start ──────────────────────────────────────────────────

export const ColdStartCard: React.FC<CardProps> = ({ history, hasCloud }) => {
  const status = statusBody(history, hasCloud, history.metrics24h);
  const rows = history.metrics24h ? coldStarts(history.metrics24h) : [];
  const total = rows.reduce((a, r) => a + r.spikes, 0);
  return (
    <Card title="Hardware Cold Start" icon={<Activity className="w-3.5 h-3.5" />}>
      {status ?? (rows.length === 0 ? (
        <Muted>Needs time-to-first-token samples from the last 24 h (they come from proxied or probed requests).</Muted>
      ) : (
        <div className="space-y-1.5">
          <p className="text-[10px] text-gray-500 uppercase tracking-widest">TTFT spikes · last 24 h</p>
          <p className="text-xs text-gray-300">
            <span className={`font-telin text-xl font-bold ${total > 0 ? 'text-amber-400' : 'text-green-400'}`}>{total}</span>
            <span className="ml-2 text-gray-500">likely model loads (TTFT ≥ 3× median)</span>
          </p>
          {rows.slice(0, 3).map(r => (
            <Row key={r.node_id} label={r.hostname} value={
              <span className="text-gray-400">
                {r.spikes} · median {Math.round(r.medianTtftMs)} ms · worst {(r.worstTtftMs / 1000).toFixed(1)} s
              </span>
            } />
          ))}
        </div>
      ))}
    </Card>
  );
};

// ── 12 · Fleet Thermal Diversity ──────────────────────────────────────────────

const RISK_STYLE = { low: 'text-green-400', elevated: 'text-amber-400', high: 'text-red-400' } as const;

export const ThermalDiversityCard: React.FC<CardProps> = ({ history, hasCloud }) => {
  const status = statusBody(history, hasCloud, history.wes7d);
  const d = history.wes7d ? thermalDiversity(history.wes7d) : null;
  return (
    <Card title="Fleet Thermal Diversity" icon={<Globe className="w-3.5 h-3.5" />}>
      {status ?? (d == null ? (
        <Muted>Needs thermal history from at least two nodes.</Muted>
      ) : (
        <div className="space-y-1.5">
          <p className="text-[10px] text-gray-500 uppercase tracking-widest">Cascade risk · 7 days</p>
          <p className="text-xs">
            <span className={`font-telin text-xl font-bold capitalize ${RISK_STYLE[d.risk]}`}>{d.risk}</span>
            <span className="ml-2 text-gray-500">
              {d.correlatedBuckets === 0
                ? 'no two nodes were hot at the same time'
                : `${d.correlatedBuckets} half-hours with 2+ nodes Serious or worse together`}
            </span>
          </p>
          {d.perNode.slice(0, 3).map(n => (
            <Row key={n.node_id} label={n.hostname} value={
              <span className="text-gray-400">{n.warmPct.toFixed(0)}% of time Fair or hotter</span>
            } />
          ))}
        </div>
      ))}
    </Card>
  );
};

// ── 13 · Inference Density (Historical) ───────────────────────────────────────

const fmtHour = (h: number) => `${String(h).padStart(2, '0')}:00`;

export const InferenceDensityCard: React.FC<CardProps> = ({ history, hasCloud }) => {
  const status = statusBody(history, hasCloud, history.metrics7d);
  const d = history.metrics7d ? inferenceDensity(history.metrics7d) : null;
  return (
    <Card title="Inference Density (Historical)" icon={<Layers className="w-3.5 h-3.5" />}>
      {status ?? (d == null ? (
        <Muted>No inference recorded in the last 7 days.</Muted>
      ) : (
        <div className="space-y-2">
          <p className="text-[10px] text-gray-500 uppercase tracking-widest">Fleet tok/s by hour · 7 days</p>
          <div className="flex items-end gap-px h-12" aria-label="Average fleet tokens per second by hour of day">
            {d.byHour.map((v, h) => (
              <div
                key={h}
                title={`${fmtHour(h)} · ${v == null ? 'no data' : `${v.toFixed(1)} tok/s`}`}
                className={`flex-1 rounded-sm ${h === d.peakHour ? 'bg-violet-400' : 'bg-violet-500/40'}`}
                style={{ height: `${v == null ? 2 : Math.max(4, (v / d.peakTokS) * 100)}%` }}
              />
            ))}
          </div>
          <p className="text-xs text-gray-400">
            Peak {fmtHour(d.peakHour)} at <span className="text-gray-200 font-semibold">{d.peakTokS.toFixed(1)} tok/s</span>
            {d.avgDutyPct != null && <> · fleet busy {d.avgDutyPct.toFixed(0)}% of the time</>}
          </p>
        </div>
      ))}
    </Card>
  );
};

// ── 14 · Sovereignty Audit (Enterprise) ───────────────────────────────────────

/**
 * The signed audit report is produced on request for Enterprise accounts;
 * there is no self-serve generator yet. Say so plainly instead of showing a
 * lock to the people who already have the plan.
 */
export const SovereigntyAuditCard: React.FC = () => (
  <Card title="Sovereignty Audit" icon={<Shield className="w-3.5 h-3.5" />} badge="Enterprise">
    <Muted>
      A signed compliance report of every telemetry destination, pairing event and outbound connection.
      It’s prepared on request for Enterprise accounts.
    </Muted>
    <a
      href={mailto(CONTACT_EMAIL, 'Sovereignty audit request')}
      className="text-xs font-semibold text-amber-400 hover:text-amber-300"
    >
      Request your audit report →
    </a>
  </Card>
);
