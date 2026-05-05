/**
 * Threshold Webhooks Settings section (Pro+).
 *
 * Lets users register/list/delete webhook subscriptions that receive
 * push notifications on state transitions (thermal_state_changed,
 * inference_state_changed) or threshold crossings (wes_below, wes_above).
 *
 * Backed by:
 *   POST   /api/v1/webhooks
 *   GET    /api/v1/webhooks
 *   DELETE /api/v1/webhooks/:id
 *   POST   /api/v1/webhooks/:id/test
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Webhook, Plus, Trash2, Check, AlertTriangle, Lock, Send, Copy } from 'lucide-react';

const CLOUD_URL = (() => {
  const v = (import.meta.env.VITE_CLOUD_URL as string) ?? '';
  if (!v) return 'https://vibrant-fulfillment-production-62c0.up.railway.app';
  if (v === '/') return '';
  return v.startsWith('http') ? v : `https://${v}`;
})();

interface WebhookSub {
  id:            string;
  url:           string;
  event_type:    string;
  node_id:       string | null;
  threshold:     number | null;
  cooldown_s:    number;
  enabled:       boolean;
  last_fired_ms: number | null;
  /** Only populated immediately after creation. */
  secret?:       string;
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

const EVENT_TYPES: { value: string; label: string; needsThreshold: boolean }[] = [
  { value: 'thermal_state_changed',   label: 'Thermal state changed',   needsThreshold: false },
  { value: 'inference_state_changed', label: 'Inference state changed', needsThreshold: false },
  { value: 'wes_below',               label: 'WES drops below',         needsThreshold: true  },
  { value: 'wes_above',               label: 'WES crosses above',       needsThreshold: true  },
];

const WebhooksSection: React.FC<Props> = ({ subscriptionTier, getToken, nodes, onNavigateToPricing }) => {
  const isProOrAbove = ['pro', 'team', 'business', 'enterprise'].includes(subscriptionTier);

  const [subs,    setSubs]    = useState<WebhookSub[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Form state
  const [formUrl,        setFormUrl]        = useState('');
  const [formEvent,      setFormEvent]      = useState('thermal_state_changed');
  const [formNodeId,     setFormNodeId]     = useState<string>('');
  const [formThreshold,  setFormThreshold]  = useState<string>('1.0');
  const [formCooldown,   setFormCooldown]   = useState<string>('60');
  const [submitting,     setSubmitting]     = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<{ id: string; secret: string } | null>(null);
  const [testStatus, setTestStatus] = useState<Record<string, string>>({});

  const fetchSubs = useCallback(async () => {
    if (!isProOrAbove || !getToken) return;
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${CLOUD_URL}/api/v1/webhooks`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        setError(`Server returned ${res.status}`);
        return;
      }
      const data = await res.json();
      setSubs(data.subscriptions ?? []);
    } catch {
      setError('Failed to load webhooks');
    } finally {
      setLoading(false);
    }
  }, [isProOrAbove, getToken]);

  useEffect(() => { fetchSubs(); }, [fetchSubs]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!getToken) return;
    setSubmitting(true);
    setError(null);
    try {
      const token = await getToken();
      const evMeta = EVENT_TYPES.find(e => e.value === formEvent)!;
      const body: Record<string, unknown> = {
        url:        formUrl,
        event_type: formEvent,
        cooldown_s: parseInt(formCooldown, 10) || 60,
      };
      if (formNodeId)            body.node_id   = formNodeId;
      if (evMeta.needsThreshold) body.threshold = parseFloat(formThreshold);

      const res = await fetch(`${CLOUD_URL}/api/v1/webhooks`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error ?? `Server returned ${res.status}`);
        return;
      }
      const created: WebhookSub = await res.json();
      setRevealedSecret({ id: created.id, secret: created.secret ?? '' });
      setSubs(prev => [created, ...prev]);
      // Reset form
      setFormUrl('');
      setFormThreshold('1.0');
      setShowForm(false);
    } catch {
      setError('Failed to create webhook');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!getToken) return;
    if (!confirm('Delete this webhook subscription? Cannot be undone.')) return;
    try {
      const token = await getToken();
      const res = await fetch(`${CLOUD_URL}/api/v1/webhooks/${id}`, {
        method:  'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        setError(`Delete failed: ${res.status}`);
        return;
      }
      setSubs(prev => prev.filter(s => s.id !== id));
    } catch {
      setError('Failed to delete webhook');
    }
  };

  const handleTest = async (id: string) => {
    if (!getToken) return;
    setTestStatus(prev => ({ ...prev, [id]: 'sending…' }));
    try {
      const token = await getToken();
      const res = await fetch(`${CLOUD_URL}/api/v1/webhooks/${id}/test`, {
        method:  'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.delivered) {
        setTestStatus(prev => ({ ...prev, [id]: `✓ HTTP ${data.status}` }));
      } else {
        setTestStatus(prev => ({ ...prev, [id]: data.error ?? `HTTP ${res.status}` }));
      }
      setTimeout(() => setTestStatus(prev => { const { [id]: _, ...rest } = prev; return rest; }), 5000);
    } catch {
      setTestStatus(prev => ({ ...prev, [id]: 'send failed' }));
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
  };

  // ── Rendering ────────────────────────────────────────────────────────────

  if (!isProOrAbove) {
    return (
      <div className="bg-gray-800 border border-gray-700 rounded-2xl">
        <div className="px-6 py-4 border-b border-gray-700 flex items-center gap-3">
          <div className="p-1.5 rounded-lg bg-violet-500/10 flex items-center justify-center">
            <Webhook className="w-3.5 h-3.5 text-violet-400" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-200">Threshold Webhooks</h3>
            <p className="text-[10px] text-gray-500">Push notifications for state transitions and threshold crossings</p>
          </div>
        </div>
        <div className="px-6 py-6 space-y-4">
          <div className="rounded-xl bg-violet-500/5 border border-violet-500/20 px-5 py-4 flex items-start gap-3">
            <Lock size={14} className="text-violet-400 mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="text-xs font-semibold text-gray-200">Threshold Webhooks — Pro+</p>
              <p className="text-[11px] text-gray-500 leading-relaxed">
                Replace polling with sub-second push notifications. Subscribe to thermal/inference state transitions and WES threshold crossings; Wicklee POSTs an HMAC-signed payload to your URL the moment a condition triggers. Essential for NRO and agent-automation loops.
              </p>
            </div>
          </div>
          <button
            onClick={() => onNavigateToPricing?.()}
            className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white transition-colors"
          >
            Upgrade to Pro
          </button>
        </div>
      </div>
    );
  }

  const eventMeta = EVENT_TYPES.find(e => e.value === formEvent)!;

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-2xl">
      <div className="px-6 py-4 border-b border-gray-700 flex items-center gap-3">
        <div className="p-1.5 rounded-lg bg-violet-500/10 flex items-center justify-center">
          <Webhook className="w-3.5 h-3.5 text-violet-400" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-gray-200">Threshold Webhooks</h3>
          <p className="text-[10px] text-gray-500">Push notifications for state transitions and threshold crossings — HMAC-signed</p>
        </div>
        <button
          onClick={() => setShowForm(s => !s)}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white transition-colors flex items-center gap-1.5"
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

      {/* Reveal-once secret callout */}
      {revealedSecret && (
        <div className="px-6 py-4 bg-cyan-500/5 border-b border-cyan-500/20">
          <p className="text-xs font-semibold text-cyan-300 mb-2">⚠️ Save this secret — it won't be shown again</p>
          <p className="text-[10px] text-gray-500 mb-2">
            Use this to verify the <code className="text-gray-400 font-mono">X-Wicklee-Signature</code> HMAC-SHA256 header on incoming webhook calls.
          </p>
          <div className="flex items-center gap-2 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2">
            <code className="flex-1 text-[11px] text-gray-200 font-mono break-all">{revealedSecret.secret}</code>
            <button
              type="button"
              onClick={() => copyToClipboard(revealedSecret.secret)}
              className="text-gray-400 hover:text-gray-200"
              title="Copy"
            >
              <Copy size={12} />
            </button>
          </div>
          <button
            onClick={() => setRevealedSecret(null)}
            className="mt-2 text-[10px] text-cyan-300 hover:text-cyan-200"
          >
            I've saved it — dismiss
          </button>
        </div>
      )}

      {/* Form */}
      {showForm && (
        <form onSubmit={handleCreate} className="px-6 py-5 space-y-3 border-b border-gray-700">
          <div>
            <label className="text-[10px] uppercase tracking-widest text-gray-500 mb-1 block">Webhook URL</label>
            <input
              type="url"
              required
              value={formUrl}
              onChange={e => setFormUrl(e.target.value)}
              placeholder="https://your-server.example.com/wicklee-hook"
              className="w-full px-3 py-2 text-xs bg-gray-900 border border-gray-700 rounded-lg text-gray-200 placeholder-gray-600 focus:border-violet-500 focus:outline-none"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-widest text-gray-500 mb-1 block">Event type</label>
              <select
                value={formEvent}
                onChange={e => setFormEvent(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-gray-900 border border-gray-700 rounded-lg text-gray-200 focus:border-violet-500 focus:outline-none"
              >
                {EVENT_TYPES.map(et => (
                  <option key={et.value} value={et.value}>{et.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest text-gray-500 mb-1 block">Scope</label>
              <select
                value={formNodeId}
                onChange={e => setFormNodeId(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-gray-900 border border-gray-700 rounded-lg text-gray-200 focus:border-violet-500 focus:outline-none"
              >
                <option value="">All nodes</option>
                {nodes.map(n => (
                  <option key={n.node_id} value={n.node_id}>
                    {n.hostname || n.node_id}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {eventMeta.needsThreshold && (
            <div>
              <label className="text-[10px] uppercase tracking-widest text-gray-500 mb-1 block">
                Threshold (WES — fires when crossing {formEvent === 'wes_below' ? 'below' : 'above'})
              </label>
              <input
                type="number"
                step="0.1"
                value={formThreshold}
                onChange={e => setFormThreshold(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-gray-900 border border-gray-700 rounded-lg text-gray-200 focus:border-violet-500 focus:outline-none"
              />
            </div>
          )}
          <div>
            <label className="text-[10px] uppercase tracking-widest text-gray-500 mb-1 block">Cooldown (seconds, min 10)</label>
            <input
              type="number"
              min={10}
              value={formCooldown}
              onChange={e => setFormCooldown(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-gray-900 border border-gray-700 rounded-lg text-gray-200 focus:border-violet-500 focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:bg-gray-700 disabled:text-gray-500 text-xs font-semibold text-white transition-colors flex items-center gap-1.5"
            >
              {submitting ? 'Creating…' : <><Check size={12} /> Create</>}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-xs font-semibold text-gray-300 transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Subscription list */}
      <div className="px-6 py-4 space-y-2">
        {loading && subs.length === 0 ? (
          <p className="text-xs text-gray-600 py-2">Loading…</p>
        ) : subs.length === 0 ? (
          <p className="text-xs text-gray-600 py-2">No webhook subscriptions yet. Add one to start receiving push notifications.</p>
        ) : (
          subs.map(sub => {
            const evLabel = EVENT_TYPES.find(e => e.value === sub.event_type)?.label ?? sub.event_type;
            const lastFired = sub.last_fired_ms
              ? new Date(sub.last_fired_ms).toLocaleString()
              : 'never';
            const status = testStatus[sub.id];
            return (
              <div key={sub.id} className="bg-gray-900 border border-gray-700 rounded-lg p-3 space-y-1.5">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-gray-200 truncate" title={sub.url}>{sub.url}</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">
                      {evLabel}
                      {sub.threshold != null && <> · threshold <span className="font-mono text-gray-400">{sub.threshold}</span></>}
                      {sub.node_id && <> · node <span className="font-mono text-gray-400">{sub.node_id}</span></>}
                      {!sub.node_id && <> · all nodes</>}
                      {' · cooldown '}<span className="font-mono text-gray-400">{sub.cooldown_s}s</span>
                    </p>
                    <p className="text-[10px] text-gray-600 mt-0.5">Last fired: {lastFired}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleTest(sub.id)}
                      className="text-[10px] px-2 py-1 rounded border border-gray-700 text-cyan-400 hover:border-cyan-500/50 hover:bg-cyan-500/10 transition-colors flex items-center gap-1"
                      title="Send a test payload"
                    >
                      <Send size={10} />
                      Test
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(sub.id)}
                      className="text-[10px] px-2 py-1 rounded border border-gray-700 text-rose-400 hover:border-rose-500/50 hover:bg-rose-500/10 transition-colors flex items-center gap-1"
                      title="Delete subscription"
                    >
                      <Trash2 size={10} />
                      Delete
                    </button>
                  </div>
                </div>
                {status && (
                  <p className={`text-[10px] font-mono ${status.startsWith('✓') ? 'text-emerald-400' : 'text-amber-400'}`}>
                    Test: {status}
                  </p>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Spec footer */}
      <div className="px-6 py-3 border-t border-gray-700 text-[10px] text-gray-600 leading-relaxed">
        <strong className="text-gray-500">Payload spec:</strong> POST with JSON body. Header <code className="text-gray-400 font-mono">X-Wicklee-Signature: sha256=&lt;hex&gt;</code> = HMAC-SHA256 of body using your subscription secret. Verify on receipt to confirm authenticity. 5-second timeout, no retries — keep your handler fast.
      </div>
    </div>
  );
};

export default WebhooksSection;
