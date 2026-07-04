/**
 * Audit Log Settings section (Business+).
 *
 * Immutable, append-only trail of sensitive fleet operations — node
 * add/remove/update, alert rule & channel creation, webhook creation,
 * and API-key / stream-token lifecycle. Org members see the whole org
 * trail (tenant-scoped server-side). Read-only: there is no edit/delete
 * path anywhere in the stack.
 *
 * Backed by:
 *   GET /api/audit-log?limit=&before=&action=
 *     → { entries: AuditEntry[], next_before: number | null }
 */

import React, { useState, useEffect, useCallback } from 'react';
import { ScrollText, Lock, AlertTriangle, RefreshCw, Download, Send, Trash2, Copy } from 'lucide-react';
import { CLOUD_URL } from '../../utils/cloudUrl';

interface AuditEntry {
  id:          number;
  ts:          number;
  user_id:     string;
  org_id:      string | null;
  actor_email: string;
  action:      string;
  target:      string;
  details:     Record<string, unknown>;
}

interface Props {
  subscriptionTier: string;
  getToken?: () => Promise<string | null>;
  onNavigateToPricing?: () => void;
}

interface DrainStatus {
  configured:       boolean;
  url?:             string;
  enabled?:         boolean;
  failures?:        number;
  last_delivery_ms?: number | null;
}

const PAGE_SIZE = 50;

/** Human labels for the actions the backend records. Unknown actions fall
 *  back to the raw slug so the trail never hides an event it can't name. */
const ACTION_LABELS: Record<string, string> = {
  'node.paired':           'Node paired',
  'node.removed':          'Node removed',
  'node.updated':          'Node updated',
  'alert_rule.created':    'Alert rule created',
  'alert_channel.created': 'Alert channel created',
  'webhook.created':       'Webhook created',
  'api_key.created':       'API key created',
  'api_key.deleted':       'API key deleted',
  'stream_tokens.revoked': 'Stream tokens revoked',
};

const ACTION_FILTERS: { value: string; label: string }[] = [
  { value: '',                       label: 'All actions' },
  { value: 'node.paired',            label: 'Node paired' },
  { value: 'node.removed',           label: 'Node removed' },
  { value: 'node.updated',           label: 'Node updated' },
  { value: 'alert_rule.created',     label: 'Alert rule created' },
  { value: 'alert_channel.created',  label: 'Alert channel created' },
  { value: 'webhook.created',        label: 'Webhook created' },
  { value: 'api_key.created',        label: 'API key created' },
  { value: 'api_key.deleted',        label: 'API key deleted' },
  { value: 'stream_tokens.revoked',  label: 'Stream tokens revoked' },
];

/** Colour the action chip by domain so the table scans quickly. */
function actionCls(action: string): string {
  if (action.startsWith('api_key') || action.startsWith('stream_tokens'))
    return 'bg-rose-500/10 text-rose-300 border-rose-500/20';
  if (action.startsWith('node'))
    return 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20';
  if (action.startsWith('alert') || action.startsWith('webhook'))
    return 'bg-violet-500/10 text-violet-300 border-violet-500/20';
  return 'bg-gray-700 text-gray-300 border-gray-600';
}

function detailsSummary(details: Record<string, unknown>): string {
  const keys = Object.keys(details || {});
  if (keys.length === 0) return '';
  return keys
    .map(k => `${k}: ${typeof details[k] === 'object' ? JSON.stringify(details[k]) : String(details[k])}`)
    .join(' · ');
}

const AuditLogSection: React.FC<Props> = ({ subscriptionTier, getToken, onNavigateToPricing }) => {
  const isBusinessOrAbove = ['business', 'enterprise'].includes(subscriptionTier);

  const [entries,    setEntries]    = useState<AuditEntry[]>([]);
  const [loading,    setLoading]    = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [filter,     setFilter]     = useState('');
  const [exporting,  setExporting]  = useState(false);

  // SIEM drain state
  const [drain,       setDrain]       = useState<DrainStatus | null>(null);
  const [drainUrl,    setDrainUrl]    = useState('');
  const [drainSecret, setDrainSecret] = useState<string | null>(null);
  const [drainBusy,   setDrainBusy]   = useState(false);
  const [showDrainForm, setShowDrainForm] = useState(false);

  const fetchPage = useCallback(async (before: number | null, append: boolean) => {
    if (!isBusinessOrAbove || !getToken) return;
    append ? setLoadingMore(true) : setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (before != null) qs.set('before', String(before));
      if (filter)         qs.set('action', filter);
      const res = await fetch(`${CLOUD_URL}/api/audit-log?${qs.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        setError(res.status === 403
          ? 'Audit logging requires Business tier or above.'
          : `Server returned ${res.status}`);
        return;
      }
      const data = await res.json();
      const rows: AuditEntry[] = data.entries ?? [];
      setEntries(prev => append ? [...prev, ...rows] : rows);
      // Only offer "load more" when the page came back full.
      setNextBefore(rows.length === PAGE_SIZE ? (data.next_before ?? null) : null);
    } catch {
      setError('Failed to load audit log');
    } finally {
      append ? setLoadingMore(false) : setLoading(false);
    }
  }, [isBusinessOrAbove, getToken, filter]);

  // Reload from the top whenever the filter changes (or on mount).
  useEffect(() => { fetchPage(null, false); }, [fetchPage]);

  const fetchDrain = useCallback(async () => {
    if (!isBusinessOrAbove || !getToken) return;
    try {
      const token = await getToken();
      const res = await fetch(`${CLOUD_URL}/api/audit-log/drain`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) setDrain(await res.json());
    } catch { /* status panel is best-effort */ }
  }, [isBusinessOrAbove, getToken]);

  useEffect(() => { fetchDrain(); }, [fetchDrain]);

  const handleExport = async (format: 'csv' | 'json') => {
    if (!getToken || exporting) return;
    setExporting(true);
    setError(null);
    try {
      const token = await getToken();
      const qs = new URLSearchParams({ format });
      if (filter) qs.set('action', filter);
      const res = await fetch(`${CLOUD_URL}/api/audit-log/export?${qs.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error ?? `Export failed: ${res.status}`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `wicklee-audit-${Date.now()}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('Export failed');
    } finally {
      setExporting(false);
    }
  };

  const saveDrain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!getToken || drainBusy) return;
    setDrainBusy(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${CLOUD_URL}/api/audit-log/drain`, {
        method:  'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ url: drainUrl }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? `Save failed: ${res.status}`);
        return;
      }
      setDrainSecret(data.secret ?? null);
      setShowDrainForm(false);
      setDrainUrl('');
      fetchDrain();
    } catch {
      setError('Failed to save drain');
    } finally {
      setDrainBusy(false);
    }
  };

  const deleteDrain = async () => {
    if (!getToken || drainBusy) return;
    if (!confirm('Remove the SIEM drain? New audit events will no longer be streamed.')) return;
    setDrainBusy(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${CLOUD_URL}/api/audit-log/drain`, {
        method:  'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok && res.status !== 404) {
        const err = await res.json().catch(() => ({}));
        setError(err.error ?? `Delete failed: ${res.status}`);
        return;
      }
      setDrain({ configured: false });
      setDrainSecret(null);
    } catch {
      setError('Failed to delete drain');
    } finally {
      setDrainBusy(false);
    }
  };

  // ── Locked state ───────────────────────────────────────────────────────────
  if (!isBusinessOrAbove) {
    return (
      <div className="bg-gray-800 border border-gray-700 rounded-2xl">
        <div className="px-6 py-4 border-b border-gray-700 flex items-center gap-3">
          <div className="p-1.5 rounded-lg bg-amber-500/10 flex items-center justify-center">
            <ScrollText className="w-3.5 h-3.5 text-amber-400" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-200">Audit Log</h3>
            <p className="text-[10px] text-gray-500">Immutable trail of sensitive fleet operations</p>
          </div>
        </div>
        <div className="px-6 py-6 space-y-4">
          <div className="rounded-xl bg-amber-500/5 border border-amber-500/20 px-5 py-4 flex items-start gap-3">
            <Lock size={14} className="text-amber-400 mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="text-xs font-semibold text-gray-200">Audit Log — Business+</p>
              <p className="text-[11px] text-gray-500 leading-relaxed">
                An append-only record of who did what, when — node add/remove/rename, alert &amp; webhook configuration, and API-key lifecycle. Org members share one org-wide trail. Required for SOC 2 / ISO change-management evidence.
              </p>
            </div>
          </div>
          <button
            onClick={() => onNavigateToPricing?.()}
            className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white transition-colors"
          >
            Upgrade to Business
          </button>
        </div>
      </div>
    );
  }

  // ── Active state ───────────────────────────────────────────────────────────
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-2xl">
      <div className="px-6 py-4 border-b border-gray-700 flex items-center gap-3">
        <div className="p-1.5 rounded-lg bg-amber-500/10 flex items-center justify-center">
          <ScrollText className="w-3.5 h-3.5 text-amber-400" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-gray-200">Audit Log</h3>
          <p className="text-[10px] text-gray-500">Immutable, append-only trail of sensitive fleet operations</p>
        </div>
        <select
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="text-[11px] px-2 py-1.5 rounded-lg bg-gray-900 border border-gray-700 text-gray-300 focus:border-amber-500 focus:outline-none"
        >
          {ACTION_FILTERS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        <button
          onClick={() => handleExport('csv')}
          disabled={exporting}
          className="text-[10px] px-2 py-1.5 rounded-lg border border-gray-700 text-gray-300 hover:border-amber-500/50 hover:bg-amber-500/10 disabled:opacity-40 transition-colors flex items-center gap-1"
          title="Download the full trail as CSV (respects the action filter)"
        >
          <Download size={11} /> CSV
        </button>
        <button
          onClick={() => handleExport('json')}
          disabled={exporting}
          className="text-[10px] px-2 py-1.5 rounded-lg border border-gray-700 text-gray-300 hover:border-amber-500/50 hover:bg-amber-500/10 disabled:opacity-40 transition-colors flex items-center gap-1"
          title="Download the full trail as JSON (respects the action filter)"
        >
          <Download size={11} /> JSON
        </button>
        <button
          onClick={() => fetchPage(null, false)}
          disabled={loading}
          className="text-gray-400 hover:text-gray-200 disabled:opacity-40 p-1.5"
          title="Refresh"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && (
        <div className="px-6 py-3 flex items-center gap-2 bg-rose-500/5 border-b border-rose-500/20">
          <AlertTriangle size={12} className="text-rose-400 shrink-0" />
          <p className="text-xs text-rose-400">{error}</p>
        </div>
      )}

      <div className="px-6 py-4">
        {loading && entries.length === 0 ? (
          <p className="text-xs text-gray-600 py-2">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="text-xs text-gray-600 py-2">
            No audit events recorded yet. Sensitive operations — pairing or removing a node, creating an alert or webhook, minting or revoking a key — appear here as they happen.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-[10px] uppercase tracking-widest text-gray-500 border-b border-gray-700">
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">Actor</th>
                  <th className="py-2 pr-3 font-medium">Action</th>
                  <th className="py-2 pr-3 font-medium">Target</th>
                  <th className="py-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(e => (
                  <tr key={e.id} className="border-b border-gray-800/60 align-top">
                    <td className="py-2 pr-3 text-[11px] text-gray-400 whitespace-nowrap">
                      {new Date(e.ts).toLocaleString()}
                    </td>
                    <td className="py-2 pr-3 text-[11px] text-gray-300 max-w-[160px] truncate" title={e.actor_email || e.user_id}>
                      {e.actor_email || e.user_id}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <span className={`text-[10px] font-medium px-2 py-0.5 rounded border ${actionCls(e.action)}`}>
                        {ACTION_LABELS[e.action] ?? e.action}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-[11px] text-gray-400 font-mono max-w-[160px] truncate" title={e.target}>
                      {e.target || '—'}
                    </td>
                    <td className="py-2 text-[10px] text-gray-500 break-words max-w-[220px]">
                      {detailsSummary(e.details) || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {nextBefore != null && (
          <button
            onClick={() => fetchPage(nextBefore, true)}
            disabled={loadingMore}
            className="mt-3 w-full py-2 rounded-lg border border-gray-700 hover:border-gray-600 text-xs font-semibold text-gray-300 disabled:opacity-40 transition-colors"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>

      {/* ── SIEM drain ── */}
      <div className="px-6 py-4 border-t border-gray-700 space-y-3">
        <div className="flex items-center gap-2">
          <Send size={12} className="text-amber-400 shrink-0" />
          <p className="text-xs font-semibold text-gray-200 flex-1">SIEM drain</p>
          {drain?.configured ? (
            <button
              onClick={deleteDrain}
              disabled={drainBusy}
              className="text-[10px] px-2 py-1 rounded border border-gray-700 text-rose-400 hover:border-rose-500/50 hover:bg-rose-500/10 disabled:opacity-40 transition-colors flex items-center gap-1"
            >
              <Trash2 size={10} /> Remove
            </button>
          ) : (
            <button
              onClick={() => setShowDrainForm(s => !s)}
              className="text-[10px] px-2 py-1 rounded border border-gray-700 text-amber-300 hover:border-amber-500/50 hover:bg-amber-500/10 transition-colors"
            >
              Configure
            </button>
          )}
        </div>
        <p className="text-[10px] text-gray-600 leading-relaxed">
          Streams new audit events to your endpoint (Splunk HEC proxy, Datadog intake, any HTTPS receiver) as JSON batches within ~1 minute, HMAC-SHA256 signed via <code className="text-gray-500 font-mono">X-Wicklee-Signature</code>. History backfill is the export buttons above. Admin-only to configure.
        </p>

        {drainSecret && (
          <div className="rounded-lg bg-cyan-500/5 border border-cyan-500/20 px-3 py-2.5 space-y-1.5">
            <p className="text-[11px] font-semibold text-cyan-300">⚠️ Save this signing secret — it won't be shown again</p>
            <div className="flex items-center gap-2 bg-gray-900 border border-gray-700 rounded px-2 py-1.5">
              <code className="flex-1 text-[10px] text-gray-200 font-mono break-all">{drainSecret}</code>
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(drainSecret).catch(() => {})}
                className="text-gray-400 hover:text-gray-200"
                title="Copy"
              >
                <Copy size={11} />
              </button>
            </div>
            <button onClick={() => setDrainSecret(null)} className="text-[10px] text-cyan-300 hover:text-cyan-200">
              I've saved it — dismiss
            </button>
          </div>
        )}

        {drain?.configured && (
          <div className="rounded-lg bg-gray-900 border border-gray-700 px-3 py-2 text-[10px] text-gray-500 space-y-0.5">
            <p className="text-[11px] text-gray-300 font-mono truncate" title={drain.url}>{drain.url}</p>
            <p>
              {drain.enabled
                ? <span className="text-emerald-400">● active</span>
                : <span className="text-rose-400">● auto-disabled after 20 consecutive failures — re-save to re-enable</span>}
              {' · '}last delivery: {drain.last_delivery_ms ? new Date(drain.last_delivery_ms).toLocaleString() : 'none yet'}
              {(drain.failures ?? 0) > 0 && <> · <span className="text-amber-400">{drain.failures} consecutive failure{drain.failures === 1 ? '' : 's'}</span></>}
            </p>
          </div>
        )}

        {(showDrainForm || (drain?.configured && !drain.enabled)) && (
          <form onSubmit={saveDrain} className="flex items-center gap-2">
            <input
              type="url"
              required
              value={drainUrl}
              onChange={e => setDrainUrl(e.target.value)}
              placeholder="https://siem.example.com/wicklee-audit"
              className="flex-1 px-3 py-2 text-xs bg-gray-900 border border-gray-700 rounded-lg text-gray-200 placeholder-gray-600 focus:border-amber-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={drainBusy}
              className="px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-gray-500 text-xs font-semibold text-white transition-colors"
            >
              {drainBusy ? 'Saving…' : 'Save'}
            </button>
          </form>
        )}
      </div>

      <div className="px-6 py-3 border-t border-gray-700 text-[10px] text-gray-600 leading-relaxed">
        <strong className="text-gray-500">Append-only:</strong> entries are never edited or deleted. Events are recorded for every tier; only Business+ can read them here. Org members share one org-wide trail. Retention: at least 365 days on Business; unlimited on Enterprise.
      </div>
    </div>
  );
};

export default AuditLogSection;
