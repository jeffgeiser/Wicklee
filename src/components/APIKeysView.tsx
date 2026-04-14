import React, { useState, useEffect, useCallback } from 'react';
import { Key, Plus, Trash2, Copy, Check, X, Terminal, ChevronRight } from 'lucide-react';
import { useAuth } from '@clerk/clerk-react';
import type { ApiKey, CreateApiKeyResponse } from '../types';

// ── Cloud URL (mirrors App.tsx pattern) ──────────────────────────────────────
// For API calls — may be empty string in same-origin proxy mode.
const CLOUD_URL = (() => {
  const v = import.meta.env.VITE_CLOUD_URL ?? '';
  if (!v) return 'https://wicklee.dev';
  if (v === '/') return '';
  return v.startsWith('http') ? v : `https://${v}`;
})();

// For display in the Quick Reference — always the public URL.
const DISPLAY_URL = 'https://wicklee.dev';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function fmtRelative(ms: number | null): string {
  if (!ms) return 'Never';
  const diff = Date.now() - ms;
  if (diff < 60_000)       return 'Just now';
  if (diff < 3_600_000)    return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000)   return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ── Subcomponents ─────────────────────────────────────────────────────────────

const CopyButton: React.FC<{ text: string; className?: string }> = ({ text, className = '' }) => {
  const [done, setDone] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setDone(true);
    setTimeout(() => setDone(false), 2000);
  };
  return (
    <button onClick={copy} className={`transition-colors ${className}`} title="Copy">
      {done
        ? <Check className="w-3.5 h-3.5 text-green-400" />
        : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
};

// ── One-time key reveal modal ─────────────────────────────────────────────────

const KeyRevealModal: React.FC<{
  result: CreateApiKeyResponse;
  onClose: () => void;
}> = ({ result, onClose }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(result.key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-amber-500/30 rounded-2xl p-8 max-w-lg w-full shadow-2xl space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-white">API Key Created</h3>
            <p className="text-xs text-gray-500 mt-0.5">{result.name}</p>
          </div>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-300 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex items-start gap-3">
          <Key className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-300 leading-relaxed">
            <strong>Store this key immediately.</strong> It will not be shown again — if lost, you'll need to revoke it and create a new one.
          </p>
        </div>
        <div>
          <label className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-2 block">
            Your API Key
          </label>
          <div className="bg-gray-950 border border-gray-800 rounded-xl p-4 flex items-center gap-3">
            <code className="font-mono text-sm text-indigo-300 flex-1 break-all">{result.key}</code>
            <button
              onClick={handleCopy}
              className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-xs font-semibold text-white transition-colors"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
        <button
          onClick={onClose}
          className="w-full py-2.5 border border-gray-700 hover:border-gray-500 text-gray-300 hover:text-white rounded-xl text-sm font-semibold transition-all"
        >
          Done — I've saved my key
        </button>
      </div>
    </div>
  );
};

// ── Create Key Modal ──────────────────────────────────────────────────────────

const CreateKeyModal: React.FC<{
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
  loading: boolean;
  error: string | null;
}> = ({ onSubmit, onClose, loading, error }) => {
  const [name, setName] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) onSubmit(name.trim());
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 max-w-md w-full shadow-2xl space-y-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-white">New API Key</h3>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-300 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-2 block">
              Key Name
            </label>
            <input
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. GitHub Actions CI"
              className="w-full bg-gray-950 border border-gray-700 focus:border-indigo-500 text-white text-sm rounded-xl px-4 py-3 outline-none transition-colors placeholder:text-gray-600"
            />
            <p className="text-xs text-gray-600 mt-1.5">A label to identify where this key is used.</p>
          </div>
          {error && (
            <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 border border-gray-700 hover:border-gray-500 text-gray-300 rounded-xl text-sm font-semibold transition-all"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || loading}
              className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl text-sm font-semibold transition-all"
            >
              {loading ? 'Creating…' : 'Create Key'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

const APIKeysView: React.FC = () => {
  const { getToken, isSignedIn } = useAuth();

  const [keys, setKeys]               = useState<ApiKey[]>([]);
  const [loading, setLoading]         = useState(true);
  const [fetchError, setFetchError]   = useState<string | null>(null);

  const [showCreate, setShowCreate]   = useState(false);
  const [creating, setCreating]       = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newKey, setNewKey]           = useState<CreateApiKeyResponse | null>(null);

  // Two-click delete confirm
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting]           = useState<string | null>(null);

  const [copiedSnippet, setCopiedSnippet] = useState(false);

  // ── Auth helper ────────────────────────────────────────────────────────────

  const authHeaders = useCallback(async (): Promise<HeadersInit | null> => {
    if (!isSignedIn) return null;
    const token = await getToken();
    if (!token) return null;
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }, [getToken, isSignedIn]);

  // ── Fetch keys ─────────────────────────────────────────────────────────────

  const loadKeys = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const headers = await authHeaders();
      if (!headers) { setFetchError('Not authenticated'); setLoading(false); return; }
      const r = await fetch(`${CLOUD_URL}/api/v1/keys`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setKeys(data.keys ?? []);
    } catch (err: any) {
      console.error('[api-keys] fetch failed:', err);
      setFetchError(err?.message?.includes('401') ? 'Session expired. Sign out and sign back in.'
        : err?.message?.includes('403') ? 'API key management requires a fleet account.'
        : 'Could not load API keys. Check your connection and try refreshing.');
    }
    setLoading(false);
  }, [authHeaders]);

  useEffect(() => { loadKeys(); }, [loadKeys]);

  // ── Create key ─────────────────────────────────────────────────────────────

  const handleCreate = async (name: string) => {
    setCreating(true);
    setCreateError(null);
    try {
      const headers = await authHeaders();
      if (!headers) { setCreateError('Not authenticated'); setCreating(false); return; }
      const r = await fetch(`${CLOUD_URL}/api/v1/keys`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? `HTTP ${r.status}`);
      }
      const data: CreateApiKeyResponse = await r.json();
      setNewKey(data);
      setShowCreate(false);
      await loadKeys();
    } catch (e: unknown) {
      setCreateError(e instanceof Error ? e.message : 'Failed to create key');
    }
    setCreating(false);
  };

  // ── Delete key ─────────────────────────────────────────────────────────────

  const handleDelete = async (keyId: string) => {
    if (confirmDelete !== keyId) { setConfirmDelete(keyId); return; }
    setDeleting(keyId);
    try {
      const headers = await authHeaders();
      if (!headers) return;
      await fetch(`${CLOUD_URL}/api/v1/keys/${keyId}`, { method: 'DELETE', headers });
      setKeys(prev => prev.filter(k => k.key_id !== keyId));
    } catch {
      // silent — key stays in list on network error
    }
    setDeleting(null);
    setConfirmDelete(null);
  };

  // ── curl snippet ───────────────────────────────────────────────────────────

  const curlSnippet = `curl ${DISPLAY_URL}/api/v1/fleet \\\n  -H "X-API-Key: wk_live_YOUR_KEY_HERE"`;

  const handleCopySnippet = () => {
    navigator.clipboard.writeText(curlSnippet);
    setCopiedSnippet(true);
    setTimeout(() => setCopiedSnippet(false), 2000);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {showCreate && (
        <CreateKeyModal
          onSubmit={handleCreate}
          onClose={() => { setShowCreate(false); setCreateError(null); }}
          loading={creating}
          error={createError}
        />
      )}
      {newKey && (
        <KeyRevealModal result={newKey} onClose={() => setNewKey(null)} />
      )}

      <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in duration-500">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold text-white">API Keys</h1>
            <p className="text-gray-500 text-sm">
              Machine-readable access to your fleet — for automation, CI/CD, and custom tooling.
            </p>
          </div>
          <button
            onClick={() => { setShowCreate(true); setCreateError(null); }}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-sm font-semibold transition-all shadow-lg shadow-indigo-500/20"
          >
            <Plus className="w-4 h-4" />
            Create New Key
          </button>
        </div>

        {/* Keys table */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-gray-950/50 text-[10px] text-gray-500 uppercase tracking-widest font-bold border-b border-gray-800">
                <th className="px-6 py-4">Key Name</th>
                <th className="px-6 py-4">Token</th>
                <th className="px-6 py-4">Created / Last Used</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {loading && (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-gray-600 text-sm">
                    Loading keys…
                  </td>
                </tr>
              )}
              {!loading && fetchError && (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-red-400 text-sm">
                    {fetchError}
                  </td>
                </tr>
              )}
              {!loading && !fetchError && keys.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-6 py-10 text-center">
                    <p className="text-gray-500 text-sm">No API keys yet.</p>
                    <button
                      onClick={() => setShowCreate(true)}
                      className="mt-3 text-xs text-indigo-400 hover:text-indigo-300 transition-colors flex items-center gap-1 mx-auto"
                    >
                      <Plus className="w-3.5 h-3.5" /> Create your first key
                    </button>
                  </td>
                </tr>
              )}
              {!loading && keys.map(k => (
                <tr
                  key={k.key_id}
                  className="hover:bg-gray-800/30 transition-colors group"
                  onMouseLeave={() => { if (confirmDelete === k.key_id) setConfirmDelete(null); }}
                >
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="p-1.5 bg-gray-800 rounded-lg text-indigo-400">
                        <Key className="w-4 h-4" />
                      </div>
                      <span className="text-sm font-semibold text-gray-200">{k.name}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2 font-mono text-xs text-gray-500">
                      <span>wk_live_••••••••</span>
                      <CopyButton text={k.key_id} className="text-gray-600 hover:text-gray-300" />
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex flex-col text-xs">
                      <span className="text-gray-300">{fmtDate(k.created_at)}</span>
                      <span className="text-gray-500">Used {fmtRelative(k.last_used_ms)}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-right">
                    {confirmDelete === k.key_id ? (
                      <button
                        onClick={() => handleDelete(k.key_id)}
                        disabled={deleting === k.key_id}
                        className="text-xs px-3 py-1.5 bg-red-600/80 hover:bg-red-600 text-white rounded-lg font-semibold transition-colors disabled:opacity-50"
                      >
                        {deleting === k.key_id ? 'Deleting…' : 'Confirm?'}
                      </button>
                    ) : (
                      <button
                        onClick={() => handleDelete(k.key_id)}
                        className="p-2 text-gray-600 hover:text-red-400 transition-colors"
                        title="Delete key"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Quick Reference */}
        <div className="bg-gray-900/50 border border-gray-800 rounded-2xl p-6 space-y-6">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-gray-800 rounded-lg">
              <Terminal className="w-4 h-4 text-indigo-400" />
            </div>
            <h3 className="text-sm font-bold text-gray-200 uppercase tracking-wide">Quick Reference</h3>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            {/* Auth */}
            <div className="space-y-3">
              <h4 className="text-xs text-gray-500 uppercase tracking-widest font-bold">Authentication</h4>
              <div className="space-y-2">
                <div>
                  <p className="text-[10px] text-gray-600 mb-1">Base URL</p>
                  <div className="flex items-center gap-2 bg-gray-950 rounded-lg px-3 py-2">
                    <code className="font-mono text-xs text-gray-300 flex-1 truncate">{DISPLAY_URL}</code>
                    <CopyButton text={DISPLAY_URL} className="text-gray-600 hover:text-gray-400" />
                  </div>
                </div>
                <div>
                  <p className="text-[10px] text-gray-600 mb-1">Request Header</p>
                  <div className="flex items-center gap-2 bg-gray-950 rounded-lg px-3 py-2">
                    <code className="font-mono text-xs text-indigo-300 flex-1">X-API-Key: wk_live_…</code>
                    <CopyButton text="X-API-Key: YOUR_KEY_HERE" className="text-gray-600 hover:text-gray-400" />
                  </div>
                </div>
              </div>
            </div>

            {/* Endpoints */}
            <div className="space-y-3">
              <h4 className="text-xs text-gray-500 uppercase tracking-widest font-bold">Data Endpoints</h4>
              <div className="space-y-1.5">
                {([
                  ['/api/v1/fleet',       'All nodes — metrics + WES'],
                  ['/api/v1/fleet/wes',   'WES efficiency scores only'],
                  ['/api/v1/nodes/:id',   'Single node detail'],
                  ['/api/v1/route/best',  'Routing recommendation'],
                ] as const).map(([path, desc]) => (
                  <div key={path} className="flex items-center gap-2 py-1">
                    <span className="text-[9px] font-bold text-green-400 bg-green-500/10 rounded px-1.5 py-0.5 shrink-0">
                      GET
                    </span>
                    <code className="font-mono text-xs text-gray-300 flex-1">{path}</code>
                    <span className="text-xs text-gray-600 hidden lg:flex items-center gap-1">
                      <ChevronRight className="w-3 h-3 text-gray-700" />
                      {desc}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* curl snippet */}
          <div>
            <h4 className="text-xs text-gray-500 uppercase tracking-widest font-bold mb-2">Example</h4>
            <div className="bg-gray-950 border border-gray-800 rounded-xl p-4 flex items-start justify-between gap-4">
              <pre className="font-mono text-xs text-gray-300 leading-relaxed overflow-x-auto flex-1 whitespace-pre">
{`curl ${DISPLAY_URL}/api/v1/fleet \\
  -H "X-API-Key: wk_live_YOUR_KEY_HERE"`}
              </pre>
              <button
                onClick={handleCopySnippet}
                className="shrink-0 text-gray-600 hover:text-gray-300 transition-colors mt-0.5"
                title="Copy snippet"
              >
                {copiedSnippet
                  ? <Check className="w-4 h-4 text-green-400" />
                  : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>

        {/* Security Warning */}
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-6 flex items-start gap-4">
          <div className="p-2 bg-amber-500/10 rounded-lg">
            <Key className="w-5 h-5 text-amber-500" />
          </div>
          <div className="space-y-1">
            <h4 className="text-sm font-bold text-amber-200 uppercase tracking-wide">Security Warning</h4>
            <p className="text-xs text-amber-500/80 leading-relaxed">
              API Keys have broad access to your fleet orchestrator. Never share them or commit them to source control.
              Use environment variables to inject them into your workloads.
            </p>
          </div>
        </div>

      </div>
    </>
  );
};

export default APIKeysView;
