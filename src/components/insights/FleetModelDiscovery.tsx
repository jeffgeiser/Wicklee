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
 *
 * Node filter: selecting a specific node re-sorts and filters results to show
 * what fits that machine, with a per-node pull command highlighted.
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

const NodePill: React.FC<{ node: NodeFit; highlighted?: boolean }> = ({ node, highlighted }) => {
  const c = fitColors(node.fit_score);
  const label = node.hostname ?? node.node_id.slice(0, 8);
  return (
    <span
      title={`${label}: ${node.fit_label} (${node.best_quant}, ${(node.file_size_mb / 1024).toFixed(1)} GB)`}
      className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border ${c.badge} whitespace-nowrap transition-opacity ${highlighted === false ? 'opacity-30' : ''}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot} shrink-0`} />
      {label}
    </span>
  );
};

// ── Fleet model row ───────────────────────────────────────────────────────────

const FleetModelRow: React.FC<{
  model:          FleetModel;
  getToken:       () => Promise<string | null>;
  focusNodeId:    string | null;
}> = ({ model, focusNodeId }) => {
  const [open, setOpen] = useState(false);

  // When a node is focused, score and sort from that node's perspective.
  const focusedNode = focusNodeId
    ? model.nodes.find(n => n.node_id === focusNodeId) ?? null
    : null;

  const effectiveScore = focusedNode?.fit_score ?? model.fleet_best_score;
  const best = fitColors(effectiveScore);
  const fittingNodes = model.nodes.filter(n => n.fit_score >= 40);

  // Best node for the pull command — focused node first, then highest scorer.
  const pullNode = focusedNode ?? model.nodes[0];

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

        {/* Fleet fit summary: node pills (dim non-focus nodes when filtering) */}
        <div className="flex items-center gap-1 flex-wrap justify-end max-w-[45%] hidden sm:flex">
          {model.nodes.slice(0, 4).map(n => (
            <NodePill
              key={n.node_id}
              node={n}
              highlighted={focusNodeId == null ? undefined : n.node_id === focusNodeId}
            />
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
              const isFocused = focusNodeId === node.node_id;
              return (
                <div
                  key={node.node_id}
                  className={`flex items-center gap-2 py-2 border-t border-gray-800/20 first:border-t-0 transition-opacity ${focusNodeId && !isFocused ? 'opacity-40' : ''}`}
                >
                  <Server className="w-3 h-3 text-gray-600 shrink-0" />
                  <span className={`text-[11px] w-24 shrink-0 truncate ${isFocused ? 'text-gray-200 font-semibold' : 'text-gray-400'}`} title={displayName}>
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

          {/* Pull command — focused node or best node */}
          {pullNode && pullNode.pull_cmd && pullNode.fit_score >= 40 && (
            <div className="space-y-1 pt-1">
              <div className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">
                {focusedNode ? `${focusedNode.hostname ?? focusedNode.node_id}` : 'Best node'} · {pullNode.hostname ?? pullNode.node_id} · {pullNode.best_quant}
              </div>
              <div className="flex items-center gap-1.5 bg-gray-950/60 border border-gray-800/60 rounded-lg px-2.5 py-1.5">
                <code className="text-[11px] text-cyan-300 font-mono flex-1 truncate">
                  {pullNode.pull_cmd}
                </code>
                <CopyButton text={pullNode.pull_cmd} />
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
  const [pendingSearch, setPending]   = useState('');
  const [data, setData]               = useState<FleetDiscoveryResponse | null>(null);
  // Cache of the "all nodes" baseline so switching back doesn't re-fetch.
  const baseDataRef                   = useRef<FleetDiscoveryResponse | null>(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [focusNodeId, setFocusNode]   = useState<string | null>(null);
  const debounceRef                   = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable list of online nodes (from most recent all-nodes response).
  const [onlineNodes, setOnlineNodes] = useState<Pick<NodeFit, 'node_id' | 'hostname'>[]>([]);

  const fetchModels = useCallback(async (query?: string, nodeId?: string | null) => {
    const token = await getToken();
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '20' });
      if (query)  params.set('search', query);
      if (nodeId) params.set('node_id', nodeId);
      const resp = await fetch(`/api/fleet/model-candidates?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error(`${resp.status}`);
      const json: FleetDiscoveryResponse = await resp.json();
      setData(json);
      // Keep a stable node list from the all-nodes response (not per-node filtered).
      if (!nodeId) {
        const nodes = json.models[0]?.nodes ?? [];
        setOnlineNodes(nodes);
        baseDataRef.current = json;
      }
    } catch (e: any) {
      setError((e as Error).message ?? 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  // Load trending on mount — retry up to 5× with 600ms backoff.
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

  // Re-fetch when node focus changes — server ranks results for the selected node.
  useEffect(() => {
    if (focusNodeId === null) {
      // Restore cached baseline instead of re-fetching.
      if (baseDataRef.current) setData(baseDataRef.current);
      else fetchModels(pendingSearch || undefined, null);
    } else {
      fetchModels(pendingSearch || undefined, focusNodeId);
    }
  }, [focusNodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-retry when catalog is still loading (hf_reachable === false).
  useEffect(() => {
    if (!data || data.hf_reachable !== false || loading) return;
    const id = setTimeout(() => fetchModels(undefined, focusNodeId ?? undefined), 30_000);
    return () => clearTimeout(id);
  }, [data, loading, fetchModels, focusNodeId]);

  const handleChange = (val: string) => {
    setPending(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchModels(val || undefined, focusNodeId ?? undefined), 600);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    fetchModels(pendingSearch || undefined, focusNodeId ?? undefined);
  };

  // Server already filtered and ranked per-node when focusNodeId is set.
  const displayModels = data?.models ?? [];

  const focusNodeLabel = focusNodeId
    ? (onlineNodes.find(n => n.node_id === focusNodeId)?.hostname ?? focusNodeId)
    : null;

  const fitCount = focusNodeId
    ? displayModels.filter(m => {
        const n = m.nodes.find(x => x.node_id === focusNodeId);
        return (n?.fit_score ?? 0) >= 60;
      }).length
    : data?.models.filter(m => m.fleet_best_score >= 60).length ?? 0;

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Package className="w-4 h-4 text-cyan-400" />
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
            Fleet Model Discovery
          </span>
          {data && !loading && (
            <span
              title={focusNodeId
                ? `Models where ${focusNodeLabel} scores ≥60 — VRAM headroom · thermal margin · power efficiency`
                : 'Models where at least one fleet node scores ≥60 — VRAM headroom (40 pts) · thermal margin (20 pts) · WES history (20 pts) · power efficiency (20 pts)'}
              className="text-[10px] text-cyan-400 bg-cyan-500/10 px-2 py-0.5 rounded-full border border-cyan-500/15 font-medium cursor-default"
            >
              {fitCount} fit {focusNodeLabel ?? 'your fleet'}
            </span>
          )}
        </div>
        {data && (
          <span className="text-[10px] text-gray-600">
            {data.online_nodes} node{data.online_nodes !== 1 ? 's' : ''} online
          </span>
        )}
      </div>

      {/* Node filter pills */}
      {onlineNodes.length > 1 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[9px] text-gray-700 uppercase tracking-widest mr-0.5">Filter:</span>
          <button
            onClick={() => setFocusNode(null)}
            className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
              focusNodeId == null
                ? 'bg-gray-700 border-gray-600 text-gray-200'
                : 'bg-transparent border-gray-800 text-gray-600 hover:text-gray-400 hover:border-gray-700'
            }`}
          >
            All nodes
          </button>
          {onlineNodes.map(n => (
            <button
              key={n.node_id}
              onClick={() => setFocusNode(prev => prev === n.node_id ? null : n.node_id)}
              className={`text-[10px] font-mono px-2 py-0.5 rounded-full border transition-colors ${
                focusNodeId === n.node_id
                  ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                  : 'bg-transparent border-gray-800 text-gray-600 hover:text-gray-400 hover:border-gray-700'
              }`}
            >
              {n.hostname ?? n.node_id}
            </button>
          ))}
        </div>
      )}

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
          {focusNodeId && focusNodeLabel && (
            <span className="text-cyan-600 ml-1">· filtered for {focusNodeLabel}</span>
          )}
        </div>
      )}

      {/* No nodes online warning */}
      {data && data.online_nodes === 0 && (
        <div className="flex items-center gap-2 py-3 px-3 bg-yellow-500/5 border border-yellow-500/15 rounded-lg text-xs text-yellow-500/80">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          No nodes are currently online. Connect at least one node to score models against your hardware.
        </div>
      )}

      {/* Model catalog not yet populated */}
      {data && data.hf_reachable === false && !loading && (
        <div className="flex items-start gap-2 py-3 px-3 bg-orange-500/5 border border-orange-500/15 rounded-lg text-xs text-orange-400/80">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
          <div>
            <span className="font-medium">Model catalog is still loading.</span>
            <span className="text-gray-600 ml-1">The server fetches GGUF metadata from HuggingFace at startup — this takes about 30 seconds. Try searching by name below, or check back in a moment.</span>
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

      {/* Empty */}
      {data && displayModels.length === 0 && !loading && data.hf_reachable !== false && (
        <p className="text-xs text-gray-600 py-6 text-center">
          {focusNodeId
            ? `No models scored for ${focusNodeLabel}. Try a different search or select a different node.`
            : `No GGUF models found${pendingSearch ? ` for "${pendingSearch}"` : ''}. Try a different search term.`}
        </p>
      )}

      {/* Results */}
      {displayModels.length > 0 && (
        <div className="space-y-1">
          {displayModels.map(model => (
            <FleetModelRow
              key={model.model_id}
              model={model}
              getToken={getToken}
              focusNodeId={focusNodeId}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default FleetModelDiscovery;
