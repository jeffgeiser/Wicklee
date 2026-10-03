/**
 * SLO settings section (Team+).
 *
 * Define service-level objectives over the fleet's sampled telemetry —
 * "p95 TTFT ≤ 500ms for 99% of 5-minute windows over 30 days" — scoped to
 * the whole fleet, a tag (env:prod), or a single node. The cloud evaluates
 * one time-slice verdict per SLO every 5 minutes and alerts the creator's
 * notification channels when the error budget crosses 50/90/100% burn.
 *
 * Backed by:
 *   POST   /api/slo   { name, metric, threshold, target_pct, tag?, node_id? }
 *   GET    /api/slo   → { slos: [{ ...def, compliance_pct, burn_pct, latest }] }
 *   DELETE /api/slo/:id
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Target, Plus, Trash2, Lock, AlertTriangle } from 'lucide-react';
import { CLOUD_URL } from '../../utils/cloudUrl';

interface SloStatus {
  id:             string;
  name:           string;
  tag:            string | null;
  node_id:        string | null;
  metric:         string;
  threshold:      number;
  target_pct:     number;
  enabled:        boolean;
  windows_30d:    number;
  bad_30d:        number;
  compliance_pct: number;
  burn_pct:       number;
  latest:         { ts: number; sli: number | null; ok: boolean | null } | null;
}

interface NodeOption {
  node_id:  string;
  hostname: string | null;
}

interface Props {
  subscriptionTier: string;
  getToken?: () => Promise<string | null>;
  nodes: NodeOption[];
  onNavigateToPricing?: () => void;
}

const METRICS: { value: string; label: string; unit: string; dir: '≤' | '≥'; placeholder: string }[] = [
  { value: 'ttft_p95_ms', label: 'p95 TTFT',        unit: 'ms',    dir: '≤', placeholder: '500' },
  { value: 'tok_s_p50',   label: 'Median tok/s',    unit: 'tok/s', dir: '≥', placeholder: '20' },
  { value: 'wes_p50',     label: 'Median WES',      unit: 'WES',   dir: '≥', placeholder: '8' },
];

const metricMeta = (m: string) => METRICS.find(x => x.value === m) ?? METRICS[0];

function burnColor(burn: number): string {
  if (burn >= 100) return 'bg-rose-500';
  if (burn >= 90)  return 'bg-amber-500';
  if (burn >= 50)  return 'bg-yellow-500';
  return 'bg-emerald-500';
}

const SLOSection: React.FC<Props> = ({ subscriptionTier, getToken, nodes, onNavigateToPricing }) => {
  const isTeamOrAbove = ['team', 'business', 'enterprise'].includes(subscriptionTier);

  const [slos,    setSlos]    = useState<SloStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Form state
  const [fName,      setFName]      = useState('');
  const [fMetric,    setFMetric]    = useState('ttft_p95_ms');
  const [fThreshold, setFThreshold] = useState('');
  const [fTarget,    setFTarget]    = useState('99');
  const [fTag,       setFTag]       = useState('');
  const [fNodeId,    setFNodeId]    = useState('');
  const [saving,     setSaving]     = useState(false);

  const fetchSlos = useCallback(async () => {
    if (!isTeamOrAbove || !getToken) return;
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${CLOUD_URL}/api/slo`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) { setError(`Server returned ${res.status}`); return; }
      const data = await res.json();
      setSlos(data.slos ?? []);
    } catch {
      setError('Failed to load SLOs');
    } finally {
      setLoading(false);
    }
  }, [isTeamOrAbove, getToken]);

  useEffect(() => { fetchSlos(); }, [fetchSlos]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!getToken || saving) return;
    setSaving(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${CLOUD_URL}/api/slo`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          name:       fName.trim(),
          metric:     fMetric,
          threshold:  parseFloat(fThreshold),
          target_pct: parseFloat(fTarget),
          tag:        fTag.trim() || null,
          node_id:    fNodeId || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error ?? `Server returned ${res.status}`);
        return;
      }
      setFName(''); setFThreshold(''); setFTag(''); setFNodeId('');
      setShowForm(false);
      fetchSlos();
    } catch {
      setError('Failed to create SLO');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!getToken) return;
    if (!confirm('Delete this SLO and its 30-day window history?')) return;
    try {
      const token = await getToken();
      const res = await fetch(`${CLOUD_URL}/api/slo/${id}`, {
        method:  'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error ?? `Delete failed: ${res.status}`);
        return;
      }
      setSlos(prev => prev.filter(s => s.id !== id));
    } catch {
      setError('Failed to delete SLO');
    }
  };

  // ── Locked state ───────────────────────────────────────────────────────────
  if (!isTeamOrAbove) {
    return (
      <div className="bg-gray-800 border border-gray-700 rounded-2xl">
        <div className="px-6 py-4 border-b border-gray-700 flex items-center gap-3">
          <div className="p-1.5 rounded-lg bg-emerald-500/10 flex items-center justify-center">
            <Target className="w-3.5 h-3.5 text-emerald-400" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-200">SLOs & Error Budgets</h3>
            <p className="text-[10px] text-gray-500">Latency, throughput, and efficiency objectives with burn alerts</p>
          </div>
        </div>
        <div className="px-6 py-6 space-y-4">
          <div className="rounded-xl bg-emerald-500/5 border border-emerald-500/20 px-5 py-4 flex items-start gap-3">
            <Lock size={14} className="text-emerald-400 mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="text-xs font-semibold text-gray-200">SLOs — Team+</p>
              <p className="text-[11px] text-gray-500 leading-relaxed">
                Declare "p95 TTFT ≤ 500ms for 99% of the month" per environment, tag, or node. Wicklee evaluates a verdict every 5 minutes, tracks the rolling 30-day error budget, and alerts your channels at 50/90/100% burn — the sentence your platform review needs.
              </p>
            </div>
          </div>
          <button
            onClick={() => onNavigateToPricing?.()}
            className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white transition-colors"
          >
            Upgrade to Team
          </button>
        </div>
      </div>
    );
  }

  const fm = metricMeta(fMetric);

  // ── Active state ───────────────────────────────────────────────────────────
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-2xl">
      <div className="px-6 py-4 border-b border-gray-700 flex items-center gap-3">
        <div className="p-1.5 rounded-lg bg-emerald-500/10 flex items-center justify-center">
          <Target className="w-3.5 h-3.5 text-emerald-400" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-gray-200">SLOs & Error Budgets</h3>
          <p className="text-[10px] text-gray-500">One verdict per 5-min window · rolling 30-day budget · burn alerts at 50/90/100%</p>
        </div>
        <button
          onClick={() => setShowForm(s => !s)}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-colors flex items-center gap-1.5"
        >
          <Plus size={12} />
          Add
        </button>
      </div>

      {error && (
        <div className="px-6 py-3 flex items-center gap-2 bg-rose-500/5 border-b border-rose-500/20">
          <AlertTriangle size={12} className="text-rose-400 shrink-0" />
          <p className="text-xs text-rose-400">{error}</p>
        </div>
      )}

      {showForm && (
        <form onSubmit={handleCreate} className="px-6 py-5 space-y-3 border-b border-gray-700">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-widest text-gray-500 mb-1 block">Name</label>
              <input
                type="text" required maxLength={64}
                value={fName} onChange={e => setFName(e.target.value)}
                placeholder="Prod inference latency"
                className="w-full px-3 py-2 text-xs bg-gray-900 border border-gray-700 rounded-lg text-gray-200 placeholder-gray-600 focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest text-gray-500 mb-1 block">Objective</label>
              <select
                value={fMetric} onChange={e => setFMetric(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-gray-900 border border-gray-700 rounded-lg text-gray-200 focus:border-emerald-500 focus:outline-none"
              >
                {METRICS.map(m => <option key={m.value} value={m.value}>{m.label} {m.dir} threshold</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest text-gray-500 mb-1 block">Threshold ({fm.unit})</label>
              <input
                type="number" required min="0.1" step="any"
                value={fThreshold} onChange={e => setFThreshold(e.target.value)}
                placeholder={fm.placeholder}
                className="w-full px-3 py-2 text-xs bg-gray-900 border border-gray-700 rounded-lg text-gray-200 placeholder-gray-600 focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest text-gray-500 mb-1 block">Target</label>
              <select
                value={fTarget} onChange={e => setFTarget(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-gray-900 border border-gray-700 rounded-lg text-gray-200 focus:border-emerald-500 focus:outline-none"
              >
                <option value="95">95% of windows</option>
                <option value="99">99% of windows</option>
                <option value="99.5">99.5% of windows</option>
                <option value="99.9">99.9% of windows</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest text-gray-500 mb-1 block">Tag scope (optional)</label>
              <input
                type="text"
                value={fTag} onChange={e => setFTag(e.target.value)}
                placeholder="env:prod"
                className="w-full px-3 py-2 text-xs bg-gray-900 border border-gray-700 rounded-lg text-gray-200 placeholder-gray-600 focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest text-gray-500 mb-1 block">Node scope (optional)</label>
              <select
                value={fNodeId} onChange={e => setFNodeId(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-gray-900 border border-gray-700 rounded-lg text-gray-200 focus:border-emerald-500 focus:outline-none"
              >
                <option value="">Whole fleet</option>
                {nodes.map(n => <option key={n.node_id} value={n.node_id}>{n.hostname || n.node_id}</option>)}
              </select>
            </div>
          </div>
          <button
            type="submit"
            disabled={saving || !fName.trim() || !fThreshold}
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-xs font-semibold text-white transition-colors"
          >
            {saving ? 'Creating…' : 'Create SLO'}
          </button>
        </form>
      )}

      <div className="px-6 py-4 space-y-3">
        {loading && slos.length === 0 ? (
          <p className="text-xs text-gray-600 py-2">Loading…</p>
        ) : slos.length === 0 ? (
          <p className="text-xs text-gray-600 py-2">
            No SLOs yet. Declare one — e.g. p95 TTFT ≤ 500ms for 99% of windows on <span className="font-mono">env:prod</span> — and Wicklee starts measuring within 5 minutes.
          </p>
        ) : (
          slos.map(s => {
            const m = metricMeta(s.metric);
            const burn = Math.min(s.burn_pct, 100);
            return (
              <div key={s.id} className="bg-gray-900 border border-gray-700 rounded-lg p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-gray-200 truncate">{s.name}</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">
                      {m.label} {m.dir} {s.threshold} {m.unit} · {s.target_pct}% target
                      {s.tag && <> · tag <span className="font-mono text-gray-400">{s.tag}</span></>}
                      {s.node_id && <> · node <span className="font-mono text-gray-400">{s.node_id}</span></>}
                      {!s.tag && !s.node_id && <> · whole fleet</>}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-right">
                      <p className={`text-sm font-bold tabular-nums ${s.compliance_pct >= s.target_pct ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {s.compliance_pct.toFixed(s.compliance_pct >= 99.95 ? 2 : 1)}%
                      </p>
                      <p className="text-[9px] text-gray-600">30d compliance</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDelete(s.id)}
                      className="text-[10px] p-1.5 rounded border border-gray-700 text-rose-400 hover:border-rose-500/50 hover:bg-rose-500/10 transition-colors"
                      title="Delete SLO"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
                {/* Error budget bar */}
                <div>
                  <div className="flex items-center justify-between text-[9px] text-gray-600 mb-1">
                    <span>Error budget burn</span>
                    <span className={s.burn_pct >= 90 ? 'text-rose-400 font-semibold' : ''}>
                      {s.burn_pct.toFixed(0)}% ({s.bad_30d} bad / {s.windows_30d} windows)
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-gray-800 overflow-hidden">
                    <div className={`h-full rounded-full ${burnColor(s.burn_pct)}`} style={{ width: `${burn}%` }} />
                  </div>
                </div>
                {s.latest && (
                  <p className="text-[10px] text-gray-600">
                    Latest window: {s.latest.sli != null
                      ? <>{s.latest.sli.toFixed(1)} {m.unit} {s.latest.ok ? <span className="text-emerald-400">✓</span> : <span className="text-rose-400">✗</span>}</>
                      : 'no data (not counted against budget)'}
                    {' · '}{new Date(s.latest.ts).toLocaleTimeString()}
                  </p>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="px-6 py-3 border-t border-gray-700 text-[10px] text-gray-600 leading-relaxed">
        SLIs are computed from sampled fleet telemetry (1 Hz hardware samples), not per-request traces — per-request percentiles live on each node's SLA Monitor. Windows with no inference activity aren't counted against the budget. Burn alerts go to the SLO creator's notification channels.
      </div>
    </div>
  );
};

export default SLOSection;
