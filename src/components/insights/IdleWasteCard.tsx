/**
 * IdleWasteCard — Idle-waste & right-sizing report (Team+, cloud only).
 * Readiness Program item 10.
 *
 * "Fleet burned $X idle last 30d; these N changes recover $Y." Phantom load
 * = a model held in memory while the node is NOT inferring. Fed by
 * GET /api/v1/fleet/idle-waste; the footer manages the weekly Resend digest
 * (GET/PUT /api/digest).
 */

import React, { useState, useEffect, useCallback } from 'react';
import { PowerOff, Lock, AlertTriangle, Mail } from 'lucide-react';
import { SubscriptionTier } from '../../types';
import { CLOUD_URL } from '../../utils/cloudUrl';

interface IdleAction {
  kind: 'unload_idle_model' | 'consolidate';
  node_id: string;
  model?: string;
  idle_hours?: number;
  duty_pct?: number;
  recovers_usd_month?: number;
  detail: string;
}

interface IdleWasteReport {
  days: number;
  kwh_rate: number;
  totals: {
    phantom_kwh: number;
    phantom_cost_usd: number;
    baseline_idle_cost_usd: number;
    active_cost_usd: number;
    idle_pct_of_energy: number;
    projected_monthly_recovery_usd: number;
  };
  by_node: { node_id: string; idle_hours: number; duty_pct: number; phantom_cost_usd: number }[];
  actions: IdleAction[];
}

interface Props {
  getToken: () => Promise<string | null>;
  subscriptionTier: SubscriptionTier;
  onNavigateToPricing?: () => void;
}

const WINDOWS = [7, 30, 90] as const;

const IdleWasteCard: React.FC<Props> = ({ getToken, subscriptionTier, onNavigateToPricing }) => {
  const isTeamOrAbove = ['team', 'business', 'enterprise'].includes(subscriptionTier);

  const [days, setDays] = useState<number>(30);
  const [report, setReport] = useState<IdleWasteReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Weekly digest settings (footer)
  const [digestEmail, setDigestEmail] = useState('');
  const [digestEnabled, setDigestEnabled] = useState(false);
  const [digestSaving, setDigestSaving] = useState(false);
  const [digestError, setDigestError] = useState<string | null>(null);

  const authHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const token = await getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, [getToken]);

  const fetchReport = useCallback(async () => {
    if (!isTeamOrAbove) return;
    setError(null);
    try {
      const res = await fetch(`${CLOUD_URL}/api/v1/fleet/idle-waste?days=${days}`, {
        headers: await authHeaders(),
      });
      if (!res.ok) { setError(`Server returned ${res.status}`); return; }
      setReport(await res.json());
    } catch {
      setError('Failed to load idle-waste report');
    }
  }, [isTeamOrAbove, authHeaders, days]);

  const fetchDigest = useCallback(async () => {
    if (!isTeamOrAbove) return;
    try {
      const res = await fetch(`${CLOUD_URL}/api/digest`, { headers: await authHeaders() });
      if (!res.ok) return;
      const d = await res.json();
      setDigestEmail(d.email ?? '');
      setDigestEnabled(d.enabled ?? false);
    } catch { /* non-fatal */ }
  }, [isTeamOrAbove, authHeaders]);

  useEffect(() => { fetchReport(); }, [fetchReport]);
  useEffect(() => { fetchDigest(); }, [fetchDigest]);

  const saveDigest = async (enabled: boolean) => {
    setDigestSaving(true);
    setDigestError(null);
    try {
      const res = await fetch(`${CLOUD_URL}/api/digest`, {
        method: 'PUT',
        headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: digestEmail.trim(), enabled }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setDigestError(body.error ?? `Server returned ${res.status}`);
      } else {
        setDigestEnabled(enabled);
      }
    } catch {
      setDigestError('Failed to save digest settings');
    } finally {
      setDigestSaving(false);
    }
  };

  if (!isTeamOrAbove) {
    return (
      <div className="bg-gray-800 border border-gray-700 rounded-2xl p-5">
        <div className="flex items-center gap-2.5 mb-3">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-rose-500/10">
            <PowerOff size={11} className="text-rose-400" />
          </span>
          <h3 className="text-sm font-bold text-white">Idle Waste</h3>
        </div>
        <div className="rounded-xl bg-rose-500/5 border border-rose-500/20 px-4 py-3 flex items-start gap-3">
          <Lock size={13} className="text-rose-400 mt-0.5 shrink-0" />
          <p className="text-[11px] text-gray-500 leading-relaxed">
            <strong className="text-gray-300">Team+:</strong> "your fleet burned $X on idle loaded models last 30d — these changes recover $Y/mo." Phantom-load cost with per-node recovery actions and a weekly email digest.
          </p>
        </div>
        <button
          onClick={() => onNavigateToPricing?.()}
          className="mt-3 w-full py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white transition-colors"
        >
          Upgrade to Team
        </button>
      </div>
    );
  }

  const t = report?.totals;
  const hasData = t != null && (t.phantom_cost_usd + t.baseline_idle_cost_usd + t.active_cost_usd) > 0;

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-2xl p-5 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-rose-500/10">
            <PowerOff size={11} className="text-rose-400" />
          </span>
          <h3 className="text-sm font-bold text-white">Idle Waste</h3>
          <span className="text-[10px] text-gray-600 uppercase tracking-widest">right-sizing report</span>
        </div>
        <div className="flex items-center gap-1">
          {WINDOWS.map(w => (
            <button
              key={w}
              onClick={() => setDays(w)}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                days === w ? 'bg-rose-500/20 text-rose-300' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {w}D
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-400 flex items-center gap-1.5"><AlertTriangle className="w-3 h-3" />{error}</p>
      )}

      {report && !hasData && !error && (
        <p className="text-xs text-gray-600 py-2">No observed energy in this window yet.</p>
      )}

      {report && hasData && t && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-gray-900 border border-gray-700 rounded-lg p-2.5">
              <div className="text-[9px] uppercase tracking-widest text-gray-600">Burned idle</div>
              <div className="text-lg font-mono text-rose-300">${t.phantom_cost_usd.toFixed(2)}</div>
              <div className="text-[9px] text-gray-600 font-mono">loaded models · {report.days}d</div>
            </div>
            <div className="bg-gray-900 border border-gray-700 rounded-lg p-2.5">
              <div className="text-[9px] uppercase tracking-widest text-gray-600">Idle energy share</div>
              <div className="text-lg font-mono text-amber-300">{t.idle_pct_of_energy.toFixed(0)}%</div>
              <div className="text-[9px] text-gray-600 font-mono">of fleet energy</div>
            </div>
            <div className="bg-gray-900 border border-gray-700 rounded-lg p-2.5">
              <div className="text-[9px] uppercase tracking-widest text-gray-600">Recoverable</div>
              <div className="text-lg font-mono text-emerald-400">${t.projected_monthly_recovery_usd.toFixed(2)}</div>
              <div className="text-[9px] text-gray-600 font-mono">per month · {report.actions.length} action{report.actions.length !== 1 ? 's' : ''}</div>
            </div>
          </div>

          {report.actions.length === 0 ? (
            <p className="text-xs text-gray-600">No recovery actions — loaded models are pulling their weight.</p>
          ) : (
            <div className="space-y-1.5">
              {report.actions.map((a, i) => (
                <div key={i} className="flex items-start gap-2 rounded-lg bg-gray-900/60 border border-gray-700 px-3 py-2">
                  <span className={`shrink-0 mt-0.5 text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded border ${
                    a.kind === 'unload_idle_model'
                      ? 'text-rose-300 bg-rose-500/10 border-rose-500/25'
                      : 'text-cyan-300 bg-cyan-500/10 border-cyan-500/25'
                  }`}>
                    {a.kind === 'unload_idle_model' ? 'unload' : 'consolidate'}
                  </span>
                  <p className="text-[11px] text-gray-400 leading-relaxed">{a.detail}</p>
                  {a.recovers_usd_month != null && (
                    <span className="ml-auto shrink-0 text-xs font-mono text-emerald-400">${a.recovers_usd_month.toFixed(2)}/mo</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Weekly digest footer */}
      <div className="border-t border-gray-700 pt-3 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Mail size={12} className="text-gray-500 shrink-0" />
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">Weekly digest</span>
          <input
            type="email"
            value={digestEmail}
            onChange={e => setDigestEmail(e.target.value)}
            placeholder="ops@example.com"
            disabled={digestEnabled}
            className="flex-1 min-w-[160px] h-7 px-2 bg-gray-900 border border-gray-700 rounded-lg text-[11px] text-gray-300 placeholder:text-gray-600 focus:outline-none focus:border-rose-500/50 disabled:opacity-50"
          />
          <button
            onClick={() => saveDigest(!digestEnabled)}
            disabled={digestSaving || (!digestEnabled && !digestEmail.trim())}
            className={`px-3 py-1 rounded-lg text-[11px] font-semibold transition-colors disabled:opacity-40 ${
              digestEnabled
                ? 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                : 'bg-rose-600 hover:bg-rose-500 text-white'
            }`}
          >
            {digestSaving ? 'Saving…' : digestEnabled ? 'Disable' : 'Enable'}
          </button>
        </div>
        {digestError && <p className="text-[10px] text-red-400">{digestError}</p>}
        <p className="text-[10px] text-gray-600">
          One email per week via Resend: idle burn, energy share, and the top recovery actions. {digestEnabled ? 'Active.' : ''}
        </p>
      </div>
    </div>
  );
};

export default IdleWasteCard;
