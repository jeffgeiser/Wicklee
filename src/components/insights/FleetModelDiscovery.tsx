/**
 * FleetModelDiscovery — cloud fleet model discovery panel.
 *
 * Fetches GGUF models from HuggingFace via /api/fleet/model-candidates,
 * which scores each model against every online fleet node's hardware profile.
 *
 * For each model the user can see:
 *   - Which nodes can run it and at what quality (Excellent/Good/Tight/Marginal/Won't Fit)
 *   - The best-fit quantization variant per node
 *   - The Ollama pull command, ready to copy
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Search, Package, ExternalLink, Copy, Check, ChevronDown, ChevronRight, Server, Loader2, AlertCircle } from 'lucide-react';

interface NodeFit {
  node_id:      string;
  hostname:     string | null;
  mem_budget_gb: number;
  thermal:      string;
  fit_score:    number;
  fit_label:    string;
  best_quant:   string;
  file_size_mb: number;
  pull_cmd:     string;
}

interface FleetModel {
  model_id:          string;
  downloads:         number;
  fleet_best_score:  number;
  nodes:             NodeFit[];
}

interface FleetDiscoveryResponse {
  is_live_search: boolean;
  online_nodes:   number;
  hf_reachable:   boolean;
  models:         FleetModel[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fitColors(score: number) {
  if (score >= 80) return { dot: 'bg-emerald-500', badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20', bar: 'bg-emerald-500' };
  if (score >= 60) return { dot: 'bg-green-500',   badge: 'bg-green-500/15 text-green-400 border-green-500/20',       bar: 'bg-green-500' };
  if (score >= 40) return { dot: 'bg-yellow-500',  badge: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/20',    bar: 'bg-yellow-500' };
  if (score > 0)   return { dot: 'bg-orange-500',  badge: 'bg-orange-500/15 text-orange-400 border-orange-500/20',    bar: 'bg-orange-500' };
  return             { dot: 'bg-red-900',    badge: 'bg-red-900/20 text-red-500 border-red-900/30',           bar: 'bg-red-900' };
}

function fmtDl(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`;
  return `${n}`;
}

function shortName(model_id: string): string {
  return model_id.split('/').pop() ?? model_id;
}

// ── Copy button ───────────────────────────────────────────────────────────────

const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);
  const handle = () => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <button onClick={handle} title="Copy" className="p-1 rounded hover:bg-gray-700/60 transition-colors">
      {copied
        ? <Check className="w-3 h-3 text-emerald-400" />
        : <Copy className="w-3 h-3 text-gray-500 hover:text-gray-300" />}
    </button>
  );
};

// ── Node fit pill ─────────────────────────────────────────────────────────────

const NodePill: React.FC<{ node: NodeFit }> = ({ node }) => {
  const c = fitColors(node.fit_score);
  const label = node.hostname ?? node.node_id.slice(0, 8);
  return (
    <span
      title={`${label}: ${node.fit_label} (${node.best_quant}, ${(node.file_size_mb / 1024).toFixed(1)} GB)`}
      className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border ${c.badge} whitespace-nowrap`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot} shrink-0`} />
      {label}
    </span>
  );
};

// ── Fleet model row ───────────────────────────────────────────────────────────

const FleetModelRow: React.FC<{ model: FleetModel; getToken: () => Promise<string | null> }> = ({ model }) => {
  const [open, setOpen] = useState(false);
  const best = fitColors(model.fleet_best_score);
  const fittingNodes = model.nodes.filter(n => n.fit_score >= 40);
  const bestNode = model.nodes[0]; // already sorted best-first

  return (
    <div className="border border-gray-800/60 rounded-xl overflow-hidden">
      {/* Summary row */}
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-gray-800/20 transition-colors text-left"
      >
        <div className={`w-2 h-2 rounded-full ${best.dot} shrink-0`} />

        <span className="text-xs text-gray-300 font-mono truncate flex-1 min-w-0">
          {shortName(model.model_id)}
        </span>

        {/* Fleet fit summary: node pills */}
        <div className="flex items-center gap-1 flex-wrap justify-end max-w-[45%] hidden sm:flex">
          {model.nodes.slice(0, 4).map(n => (
            <NodePill key={n.node_id} node={n} />
          ))}
          {model.nodes.length > 4 && (
            <span className="text-[10px] text-gray-600">+{model.nodes.length - 4}</span>
          )}
        </div>

        {/* Summary: X/Y nodes fit */}
        <span
          title="Nodes with fit score ≥40 (Tight or better). Green = Excellent/Good (≥60). Yellow = Tight (40–59). Orange = Marginal (1–39). Red = Won't Fit."
          className="text-[10px] text-gray-600 whitespace-nowrap shrink-0 cursor-default"
        >
          {fittingNodes.length}/{model.nodes.length} nodes fit
        </span>

        {/* Downloads */}
        <span className="text-[10px] text-gray-700 tabular-nums shrink-0">
          {fmtDl(model.downloads)}↓
        </span>

        {open
          ? <ChevronDown className="w-3 h-3 text-gray-600 shrink-0" />
          : <ChevronRight className="w-3 h-3 text-gray-600 shrink-0" />}
      </button>

      {/* Expanded: per-node breakdown */}
      {open && (
        <div className="px-3 pb-3 border-t border-gray-800/40 space-y-3 pt-3">
          {/* HF link */}
          <a
            href={`https://huggingface.co/${model.model_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-[10px] text-cyan-500 hover:text-cyan-400 transition-colors"
          >
            <ExternalLink className="w-2.5 h-2.5" />
            {model.model_id}
          </a>

          {/* Per-node table */}
          <div className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">
            Per-node fit
          </div>
          <div className="space-y-0">
            {model.nodes.map(node => {
              const nc = fitColors(node.fit_score);
              const displayName = node.hostname ?? node.node_id;
              return (
                <div key={node.node_id} className="flex items-center gap-2 py-2 border-t border-gray-800/20 first:border-t-0">
                  <Server className="w-3 h-3 text-gray-600 shrink-0" />
                  <span className="text-[11px] text-gray-400 w-24 shrink-0 truncate" title={displayName}>
                    {displayName}
                  </span>
                  <span className={`text-[10px] font-medium px-1.5 py-px rounded border ${nc.badge} shrink-0`}>
                    {node.fit_label}
                  </span>
                  <span className="text-[10px] text-gray-500 font-mono shrink-0">
                    {node.best_quant}
                  </span>
                  <span className="text-[10px] text-gray-600 shrink-0">
                    {(node.file_size_mb / 1024).toFixed(1)} GB
                  </span>
                  <span className="text-[10px] text-gray-700 shrink-0 hidden md:inline">
                    {node.mem_budget_gb} GB pool
                  </span>
                  {/* Pull command inline */}
                  {node.pull_cmd && node.fit_score >= 40 && (
                    <div className="flex items-center gap-1 ml-auto">
                      <code className="text-[10px] text-cyan-400/70 font-mono truncate max-w-[200px] hidden lg:inline">
                        {node.pull_cmd}
                      </code>
                      <CopyButton text={node.pull_cmd} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Best-node pull command featured */}
          {bestNode && bestNode.pull_cmd && bestNode.fit_score >= 40 && (
            <div className="space-y-1 pt-1">
              <div className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">
                Best node · {bestNode.hostname ?? bestNode.node_id} · {bestNode.best_quant}
              </div>
              <div className="flex items-center gap-1.5 bg-gray-950/60 border border-gray-800/60 rounded-lg px-2.5 py-1.5">
                <code className="text-[11px] text-cyan-300 font-mono flex-1 truncate">
                  {bestNode.pull_cmd}
                </code>
                <CopyButton text={bestNode.pull_cmd} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  getToken: () => Promise<string | null>;
}

const FleetModelDiscovery: React.FC<Props> = ({ getToken }) => {
  const [pendingSearch, setPending] = useState('');
  const [data, setData]             = useState<FleetDiscoveryResponse | null>(null);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const debounceRef                 = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchModels = useCallback(async (query?: string) => {
    const token = await getToken();
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '20' });
      if (query) params.set('search', query);
      const resp = await fetch(`/api/fleet/model-candidates?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error(`${resp.status}`);
      setData(await resp.json());
    } catch (e: any) {
      setError(e.message ?? 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  // Load trending on mount — retry up to 5× with 600ms backoff to handle
  // Clerk JWT not yet resolved when component first mounts.
  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    const tryFetch = async () => {
      if (cancelled) return;
      const token = await getToken();
      if (token) {
        fetchModels();
      } else if (attempt < 5) {
        attempt++;
        setTimeout(tryFetch, 600);
      }
    };
    tryFetch();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleChange = (val: string) => {
    setPending(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchModels(val || undefined), 600);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    fetchModels(pendingSearch || undefined);
  };

  const fittingModels = data?.models.filter(m => m.fleet_best_score >= 60).length ?? 0;

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Package className="w-4 h-4 text-cyan-400" />
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
            Fleet Model Discovery
          </span>
          {data && !loading && (
            <span
              title="Models where at least one fleet node scores ≥60 — VRAM headroom (40 pts) · thermal margin (20 pts) · WES history (20 pts) · power efficiency (20 pts)"
              className="text-[10px] text-cyan-400 bg-cyan-500/10 px-2 py-0.5 rounded-full border border-cyan-500/15 font-medium cursor-default"
            >
              {fittingModels} fit your fleet
            </span>
          )}
        </div>
        {data && (
          <span className="text-[10px] text-gray-600">
            {data.online_nodes} node{data.online_nodes !== 1 ? 's' : ''} online
          </span>
        )}
      </div>

      {/* Search */}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <div className="flex-1 relative">
          {loading
            ? <Loader2 className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-cyan-500 animate-spin" />
            : <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-600" />
          }
          <input
            type="text"
            value={pendingSearch}
            onChange={e => handleChange(e.target.value)}
            placeholder="Search HuggingFace GGUF across your fleet (e.g. llama, qwen, mistral)…"
            className="w-full pl-8 pr-3 py-2 bg-gray-800/60 border border-gray-700/50 rounded-lg text-xs text-gray-300 placeholder:text-gray-600 focus:outline-none focus:border-cyan-500/40"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="px-3 py-2 bg-gray-800 border border-gray-700/50 rounded-lg text-xs text-gray-400 hover:text-cyan-400 hover:border-cyan-500/30 transition-colors disabled:opacity-40"
        >
          Search
        </button>
      </form>

      {/* Source label */}
      {data && (
        <div className="text-[10px] text-gray-700">
          {data.is_live_search
            ? `Live HuggingFace search · each model scored against ${data.online_nodes} online node${data.online_nodes !== 1 ? 's' : ''}`
            : `Trending GGUF by downloads · scored across your ${data.online_nodes} online node${data.online_nodes !== 1 ? 's' : ''}`}
        </div>
      )}

      {/* No nodes online warning */}
      {data && data.online_nodes === 0 && (
        <div className="flex items-center gap-2 py-3 px-3 bg-yellow-500/5 border border-yellow-500/15 rounded-lg text-xs text-yellow-500/80">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          No nodes are currently online. Connect at least one node to score models against your hardware.
        </div>
      )}

      {/* HuggingFace unreachable warning */}
      {data && data.hf_reachable === false && !loading && (
        <div className="flex items-start gap-2 py-3 px-3 bg-orange-500/5 border border-orange-500/15 rounded-lg text-xs text-orange-400/80">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
          <div>
            <span className="font-medium">HuggingFace is unreachable from the cloud server.</span>
            <span className="text-gray-600 ml-1">This can happen due to a temporary network issue or rate limiting. Try searching manually or check back in a minute.</span>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="text-xs text-red-400 py-1">Failed to load: {error}</p>
      )}

      {/* Initial loading */}
      {loading && !data && (
        <div className="flex items-center justify-center py-10 gap-2 text-xs text-gray-600">
          <Loader2 className="w-4 h-4 animate-spin text-cyan-500/60" />
          {pendingSearch ? 'Searching HuggingFace…' : 'Loading trending models…'}
        </div>
      )}

      {/* Empty — only show "no results" when HF was actually reachable */}
      {data && data.models.length === 0 && !loading && data.hf_reachable !== false && (
        <p className="text-xs text-gray-600 py-6 text-center">
          No GGUF models found{pendingSearch ? ` for "${pendingSearch}"` : ''}. Try a different search term.
        </p>
      )}

      {/* Results */}
      {data && data.models.length > 0 && (
        <div className="space-y-1">
          {data.models.map(model => (
            <FleetModelRow key={model.model_id} model={model} getToken={getToken} />
          ))}
        </div>
      )}
    </div>
  );
};

export default FleetModelDiscovery;
