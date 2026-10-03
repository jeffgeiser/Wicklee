/**
 * Model governance settings section (Enterprise).
 *
 * An allow-list of models per tenant, optionally scoped to a node tag, plus the
 * violations the telemetry path has recorded.
 *
 * The important behaviour to convey in the UI: governance is active only for
 * scopes that have at least one entry. An empty list is NOT "everything
 * blocked" — it means nothing is governed. That distinction is easy to get
 * backwards when looking at an empty table, so it is stated explicitly rather
 * than implied.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, Lock, Plus, Trash2, AlertTriangle } from 'lucide-react';
import { CLOUD_URL } from '../../utils/cloudUrl';

interface Props {
  subscriptionTier: string;
  getToken?: () => Promise<string | null>;
  onNavigateToPricing?: () => void;
}

interface PolicyEntry {
  id: string;
  model: string;
  tag: string | null;
  note: string | null;
  created_at: number;
}

interface Violation {
  id: number;
  node_id: string;
  model: string;
  scope: string | null;
  ts_ms: number;
}

const ModelGovernanceSection: React.FC<Props> = ({ subscriptionTier, getToken, onNavigateToPricing }) => {
  const isEnterprise = ['business', 'enterprise'].includes(subscriptionTier);

  const [entries, setEntries]       = useState<PolicyEntry[]>([]);
  const [violations, setViolations] = useState<Violation[]>([]);
  const [active, setActive]         = useState(false);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [busy, setBusy]             = useState(false);

  const [newModel, setNewModel] = useState('');
  const [newTag, setNewTag]     = useState('');

  const load = useCallback(async () => {
    if (!isEnterprise || !getToken) return;
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const headers = { Authorization: `Bearer ${token}` };
      const [pRes, vRes] = await Promise.all([
        fetch(`${CLOUD_URL}/api/model-policy`, { headers }),
        fetch(`${CLOUD_URL}/api/model-policy/violations?limit=25`, { headers }),
      ]);
      if (pRes.ok) {
        const j = await pRes.json() as { active: boolean; entries: PolicyEntry[] };
        setEntries(j.entries ?? []);
        setActive(!!j.active);
      }
      if (vRes.ok) {
        const j = await vRes.json() as { violations: Violation[] };
        setViolations(j.violations ?? []);
      }
    } catch {
      setError('Could not load model policy');
    } finally {
      setLoading(false);
    }
  }, [isEnterprise, getToken]);

  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    if (!getToken || !newModel.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const token = await getToken();
      const r = await fetch(`${CLOUD_URL}/api/model-policy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: newModel.trim(),
          tag: newTag.trim() ? newTag.trim() : undefined,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({})) as { error?: string };
        setError(j.error ?? `Could not add entry (${r.status})`);
      } else {
        setNewModel('');
        setNewTag('');
        await load();
      }
    } catch {
      setError('Could not add entry');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!getToken || busy) return;
    setBusy(true);
    setError(null);
    try {
      const token = await getToken();
      const r = await fetch(`${CLOUD_URL}/api/model-policy/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({})) as { error?: string };
        setError(j.error ?? `Could not remove entry (${r.status})`);
      } else {
        await load();
      }
    } catch {
      setError('Could not remove entry');
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <div className="px-6 py-4 border-b border-gray-700 flex items-center gap-3">
      <div className="p-1.5 rounded-lg bg-teal-500/10 flex items-center justify-center">
        <ShieldCheck className="w-3.5 h-3.5 text-teal-400" />
      </div>
      <div>
        <h3 className="text-sm font-semibold text-gray-200">Model governance</h3>
        <p className="text-[10px] text-gray-500">Approved models per fleet or tag</p>
      </div>
    </div>
  );

  if (!isEnterprise) {
    return (
      <div className="bg-gray-800 border border-gray-700 rounded-2xl">
        {header}
        <div className="px-6 py-6 space-y-4">
          <div className="rounded-xl bg-teal-500/5 border border-teal-500/20 px-5 py-4 flex items-start gap-3">
            <Lock size={14} className="text-teal-400 mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="text-xs font-semibold text-gray-200">Model governance — Enterprise</p>
              <p className="text-[11px] text-gray-500 leading-relaxed">
                Declare which models are approved, fleet-wide or per tag, and get
                flagged the moment an unapproved one loads on a production node.
                For teams that have to evidence which models ran where.
              </p>
            </div>
          </div>
          <button
            onClick={() => onNavigateToPricing?.()}
            className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white transition-colors"
          >
            Talk to us about Enterprise
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-2xl">
      {header}
      <div className="px-6 py-6 space-y-5">

        {/* Status — an empty list means UNGOVERNED, not "all blocked". */}
        <div className={`rounded-xl px-5 py-3 border ${
          active ? 'bg-teal-500/5 border-teal-500/20' : 'bg-gray-700/30 border-gray-700'
        }`}>
          <p className="text-[11px] leading-relaxed text-gray-400">
            {active ? (
              <>
                <strong className="text-teal-300 font-semibold">Active.</strong> A node is
                governed when a fleet-wide entry exists, or when it carries a tag an entry
                scopes to. Its approved set is the union of both.
              </>
            ) : (
              <>
                <strong className="text-gray-300 font-semibold">Not governing anything.</strong> With
                no entries, no model is ever flagged. Add an entry to start governing that
                scope — a tag scopes it to matching nodes only, leaving everything else alone.
              </>
            )}
          </p>
        </div>

        {error && (
          <p className="text-[11px] text-rose-400">{error}</p>
        )}

        {/* Add entry */}
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={newModel}
            onChange={e => setNewModel(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void add(); }}
            placeholder="llama3.1:8b  (or llama3.1:8b* to allow quants)"
            className="flex-1 px-3 py-2 rounded-xl bg-gray-900 border border-gray-700 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-teal-500/50"
          />
          <input
            value={newTag}
            onChange={e => setNewTag(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void add(); }}
            placeholder="tag (blank = fleet-wide)"
            className="sm:w-56 px-3 py-2 rounded-xl bg-gray-900 border border-gray-700 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-teal-500/50"
          />
          <button
            onClick={() => void add()}
            disabled={busy || !newModel.trim()}
            className="px-4 py-2 rounded-xl bg-teal-600 hover:bg-teal-500 disabled:bg-gray-700 disabled:text-gray-500 text-xs font-semibold text-white transition-colors flex items-center justify-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            Allow
          </button>
        </div>

        {/* Allow-list */}
        {loading && entries.length === 0 ? (
          <p className="text-[11px] text-gray-500">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="text-[11px] text-gray-500">No approved models declared.</p>
        ) : (
          <div className="space-y-1.5">
            {entries.map(e => (
              <div key={e.id} className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-lg bg-gray-900/60 border border-gray-700">
                <div className="min-w-0">
                  <p className="text-xs font-mono text-gray-200 truncate">{e.model}</p>
                  <p className="text-[10px] text-gray-500">
                    {e.tag ? <>scope: <span className="text-gray-400">{e.tag}</span></> : 'fleet-wide'}
                  </p>
                </div>
                <button
                  onClick={() => void remove(e.id)}
                  disabled={busy}
                  title="Remove"
                  className="p-1.5 rounded-lg text-gray-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Violations */}
        {violations.length > 0 && (
          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              Recent violations
            </p>
            <div className="space-y-1.5">
              {violations.map(v => (
                <div key={v.id} className="flex items-start gap-2.5 px-4 py-2.5 rounded-lg bg-amber-500/5 border border-amber-500/20">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs text-gray-200">
                      <span className="font-mono">{v.model}</span>
                      <span className="text-gray-500"> on </span>
                      <span className="font-mono text-gray-400">{v.node_id}</span>
                    </p>
                    <p className="text-[10px] text-gray-500">
                      {new Date(v.ts_ms).toLocaleString()}
                      {v.scope && <> · scope: {v.scope}</>}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <p className="text-[10px] text-gray-600 leading-relaxed">
          Violations are recorded once per model per node — a node sitting on an
          unapproved model does not re-flag every second, and returning to an approved
          model resets it. Policy changes are Admin-only and recorded in the audit log;
          violations themselves are detected by the telemetry path with no acting user,
          so they live here and in the node event feed rather than in the audit trail.
        </p>
      </div>
    </div>
  );
};

export default ModelGovernanceSection;
