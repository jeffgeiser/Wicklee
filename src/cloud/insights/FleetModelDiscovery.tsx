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

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Search, Package, ExternalLink, ChevronDown, ChevronRight, Server, Loader2, AlertCircle } from 'lucide-react';
import { ELECTRICITY_RATE_USD_PER_KWH } from '../../utils/efficiency';
import { CLOUD_URL } from '../../utils/cloudUrl';
import {
  quantQualityHint,
  recommendedQuant,
  vramAtContext,
  fitLabelAtContext,
  parseParameterCountB,
  CONTEXT_LENGTH_OPTIONS,
  DEFAULT_CONTEXT_LENGTH,
  contextLengthLabel,
} from '../../utils/quantQuality';
import { useModelComparisonHistory, projectTpsForVariant, type ComparisonRow } from '../../utils/modelHistory';
import { inferCategory, categoryDescription, ALL_CATEGORIES, type ModelCategory } from '../../utils/modelCategory';
import { useSettings } from '../../hooks/useSettings';
import DiscoveryHoverCard from '../../components/insights/DiscoveryHoverCard';
import { RowCopyButton, CopyButton } from '../../components/shared/CopyButton';
import {
  fitColors, fitGradeLabel, fmtDl, shortModelName, uploaderName,
  projConfidenceLabel, projConfidenceBody, projConfidenceRows,
} from '../../components/insights/discoveryHelpers';

/** Sort modes for the Discovery results list. Default = 'fit' (current behavior). */
type SortMode = 'fit' | 'popularity' | 'speed' | 'cost' | 'size_asc' | 'size_desc';

interface NodeFit {
  node_id:      string;
  hostname:     string | null;
  mem_budget_gb: number;
  thermal:      string;
  /** Apple/NVIDIA chip identifier (e.g. "Apple M4 Pro", "NVIDIA RTX 4090").
   *  Enables the theoretical tok/s fallback via chipBandwidth.ts when the
   *  fleet has no telemetry for this candidate's size class yet. Optional
   *  to remain backward-compatible with older agents that pre-date this
   *  field. */
  chip_name?:   string | null;
  fit_score:    number;
  fit_label:    string;
  best_quant:   string;
  file_size_mb: number;
  pull_cmd:     string;
}

interface FleetModel {
  model_id:          string;
  downloads:         number;
  /** HuggingFace likes — current bookmark interest (complements downloads). */
  likes?:            number;
  fleet_best_score:  number;
  nodes:             NodeFit[];
}

interface FleetDiscoveryResponse {
  is_live_search: boolean;
  online_nodes:   number;
  hf_reachable:   boolean;
  models:         FleetModel[];
}

/**
 * Visual fit-bars — one colored bar per node in the fleet, color-coded
 * by that node's fit score. Width is uniform so the strip is a quick
 * at-a-glance fleet compatibility heatmap.
 */
const FitBars: React.FC<{ nodes: NodeFit[]; getScore: (n: NodeFit) => number }> = ({ nodes, getScore }) => (
  <span className="inline-flex items-center gap-0.5">
    {nodes.map(n => {
      const c = fitColors(getScore(n), 'dim');
      return (
        <span
          key={n.node_id}
          title={`${n.hostname ?? n.node_id}: ${fitGradeLabel(getScore(n))}`}
          className={`inline-block w-1.5 h-3 rounded-sm ${c.bar}`}
        />
      );
    })}
  </span>
);

const FleetModelRow: React.FC<{
  model:          FleetModel;
  getToken:       () => Promise<string | null>;
  focusNodeId:    string | null;
  history:        ComparisonRow[] | null;
  /** True when ANY row in the visible set has projections — drives whether the
   * speed/cost grid column appears at all. With no fleet-wide history yet
   * (typical for fresh installs or post-schema-migration), the column would
   * just render em-dash for every row. Hiding it lets identity/fit/popularity
   * use the freed width and the page-level "Run a few models" callout speaks
   * for the missing projections instead. */
  hasFleetHistory: boolean;
  contextLength:  number;
  kwhRate:        number;
  /** Phase 3: show the cost-per-M column only when the user has actually
   *  configured their power rate in Settings. Tok/s is unconditional now
   *  (theoretical fallback covers the no-history case). */
  showCost:       boolean;
}> = ({ model, focusNodeId, history, hasFleetHistory, contextLength, kwhRate, showCost }) => {
  const [open, setOpen] = useState(false);
  const maxFileSizeMb = model.nodes.reduce((m, n) => Math.max(m, n.file_size_mb), 0);
  const recQuant = recommendedQuant(maxFileSizeMb);
  const hasRecQuant = model.nodes.some(n => n.best_quant?.toUpperCase() === recQuant.toUpperCase());
  const paramsB = parseParameterCountB(model.model_id) ?? 7;
  const isDefaultCtx = contextLength === DEFAULT_CONTEXT_LENGTH;
  const avgWatts = (() => {
    if (!history || !history.length) return null;
    const w = history.filter(r => r.avg_watts != null && r.avg_watts > 0);
    if (!w.length) return null;
    return w.reduce((s, r) => s + (r.avg_watts as number), 0) / w.length;
  })();

  const focusedNode = focusNodeId
    ? model.nodes.find(n => n.node_id === focusNodeId) ?? null
    : null;

  const nodeScoresAtCtx = useMemo<Map<string, { score: number; label: string }>>(() => {
    const map = new Map<string, { score: number; label: string }>();
    for (const n of model.nodes) {
      if (isDefaultCtx) {
        map.set(n.node_id, { score: n.fit_score, label: n.fit_label });
      } else {
        const vramReq = vramAtContext(n.file_size_mb, paramsB, contextLength);
        const fit = fitLabelAtContext(vramReq, n.mem_budget_gb * 1024);
        map.set(n.node_id, { score: fit.score, label: fit.label });
      }
    }
    return map;
  }, [model.nodes, isDefaultCtx, contextLength, paramsB]);

  const effectiveScore = focusedNode
    ? (nodeScoresAtCtx.get(focusedNode.node_id)?.score ?? focusedNode.fit_score)
    : Math.max(...Array.from(nodeScoresAtCtx.values()).map((v: { score: number; label: string }) => v.score), 0);
  const best = fitColors(effectiveScore, 'dim');

  const fittingNodes = focusNodeId
    ? model.nodes.filter(n => n.node_id === focusNodeId && (nodeScoresAtCtx.get(n.node_id)?.score ?? 0) >= 40)
    : model.nodes.filter(n => (nodeScoresAtCtx.get(n.node_id)?.score ?? 0) >= 40);
  const fitSummary = focusNodeId
    ? (fittingNodes.length > 0 ? 'fits this node' : "won't fit")
    : `${fittingNodes.length}/${model.nodes.length} nodes fit`;

  const pullNode = focusedNode ?? model.nodes[0];

  const recQuantFileSizeMb = (() => {
    const recNode = model.nodes.find(n => n.best_quant?.toUpperCase() === recQuant.toUpperCase());
    if (recNode) return recNode.file_size_mb;
    if (!model.nodes.length) return 0;
    return Math.min(...model.nodes.map(n => n.file_size_mb));
  })();
  const recQuantToShow = (() => {
    const recNode = model.nodes.find(n => n.best_quant?.toUpperCase() === recQuant.toUpperCase());
    return recNode ? recNode.best_quant : (pullNode?.best_quant ?? recQuant);
  })();

  const projForRow = pullNode
    ? projectTpsForVariant(history ?? [], pullNode.file_size_mb, pullNode.best_quant, pullNode.chip_name ?? null)
    : null;
  let costPerMRow: number | null = null;
  if (projForRow && avgWatts != null) {
    const tpsAvg = (projForRow.min + projForRow.max) / 2;
    if (tpsAvg > 0) {
      costPerMRow = (avgWatts / 1000) * (1_000_000 / tpsAvg / 3600) * kwhRate;
    }
  }

  const uploader = uploaderName(model.model_id);
  const bestPullCmd = pullNode?.pull_cmd ?? '';

  return (
    <div className="border border-gray-700/60 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className={[
          'w-full grid gap-2 items-center px-3 py-2 hover:bg-gray-700/20 transition-colors text-left',
          hasFleetHistory
            ? 'grid-cols-[minmax(0,3fr)_minmax(0,1.1fr)_auto] lg:grid-cols-[minmax(0,3fr)_minmax(0,0.9fr)_minmax(0,1.1fr)_minmax(0,0.9fr)_auto] xl:grid-cols-[minmax(0,3fr)_minmax(0,0.9fr)_minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,0.5fr)_auto]'
            : 'grid-cols-[minmax(0,3fr)_minmax(0,1.1fr)_auto] lg:grid-cols-[minmax(0,3.4fr)_minmax(0,0.9fr)_minmax(0,1.3fr)_minmax(0,0.5fr)_auto] xl:grid-cols-[minmax(0,3.4fr)_minmax(0,0.9fr)_minmax(0,1.3fr)_minmax(0,0.5fr)_auto]',
        ].join(' ')}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-2 h-2 rounded-full ${best.dot} shrink-0`} />
          <div className="min-w-0 flex-1">
            <div
              className="text-xs text-gray-200 font-mono truncate"
              title={shortModelName(model.model_id)}
            >
              {shortModelName(model.model_id)}
            </div>
            {uploader && (
              <div className="text-[10px] text-gray-600 truncate" title={uploader}>
                {uploader}
              </div>
            )}
          </div>
        </div>

        <div
          className="text-[10px] font-mono tabular-nums hidden md:block min-w-0"
          title={quantQualityHint(recQuantToShow)}
        >
          {recQuantFileSizeMb > 0 ? (
            <>
              <span className="text-gray-300">{recQuantToShow}</span>
              <span className="text-gray-600"> · {(recQuantFileSizeMb / 1024).toFixed(1)} GB</span>
            </>
          ) : (
            <span className="text-gray-700">—</span>
          )}
        </div>

        <div
          className="flex items-center gap-1.5 text-[10px] min-w-0"
          title={focusNodeId
            ? `Fit on ${focusedNode?.hostname ?? focusNodeId}`
            : `Highest fit grade across ${model.nodes.length} fleet node${model.nodes.length === 1 ? '' : 's'}`}
        >
          <FitBars
            nodes={model.nodes}
            getScore={n => nodeScoresAtCtx.get(n.node_id)?.score ?? n.fit_score}
          />
          <span className={`${best.badge.split(' ').find(c => c.startsWith('text-')) ?? 'text-gray-400'} truncate`}>
            {fitGradeLabel(effectiveScore)}
          </span>
          <span className="text-gray-600 tabular-nums whitespace-nowrap">
            {focusNodeId
              ? fitSummary
              : `${fittingNodes.length}/${model.nodes.length}`}
          </span>
        </div>

        {(hasFleetHistory || projForRow) && (
          <div className="text-[10px] tabular-nums hidden lg:flex items-center gap-2 min-w-0">
            {projForRow ? (
              <DiscoveryHoverCard
                heading={`≈${((projForRow.min + projForRow.max) / 2).toFixed(0)} tok/s · ${projConfidenceLabel(projForRow.confidence)}`}
                body={projConfidenceBody(projForRow, 'fleet')}
                rows={projConfidenceRows(projForRow)}
              >
                <span className={projForRow.confidence === 'theoretical' ? 'text-gray-500 italic' : 'text-gray-400'}>
                  ≈{((projForRow.min + projForRow.max) / 2).toFixed(0)} t/s
                </span>
              </DiscoveryHoverCard>
            ) : null}
            {showCost && costPerMRow != null ? (
              <DiscoveryHoverCard
                heading="Cost per million tokens"
                body="Estimated electricity cost to generate 1M tokens at this row's projected tok/s and the fleet's average power draw."
                rows={[
                  { label: 'Power rate', value: `$${kwhRate.toFixed(3)}/kWh` },
                  { label: 'Avg watts',  value: avgWatts != null ? `${avgWatts.toFixed(0)} W (measured)` : '—' },
                  { label: 'Formula',    value: 'watts × $/kWh ÷ (tok/s × 3600) × 1M' },
                ]}
              >
                <span className="text-gray-500">
                  ${costPerMRow < 0.01 ? costPerMRow.toFixed(4) : costPerMRow.toFixed(3)}/M
                </span>
              </DiscoveryHoverCard>
            ) : null}
            {!projForRow && costPerMRow == null && (
              <span
                className="text-gray-700"
                title="Projection unavailable for this row (no telemetry and chip not in our bandwidth lookup)."
              >
                —
              </span>
            )}
          </div>
        )}

        <div className="text-[10px] tabular-nums hidden xl:flex items-center gap-2 min-w-0 justify-end">
          <span className="text-gray-700" title="HuggingFace downloads (all time)">
            {fmtDl(model.downloads)}↓
          </span>
          {model.likes != null && model.likes > 0 && (
            <span className="text-rose-400/50" title="HuggingFace likes">
              {fmtDl(model.likes)}♥
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {bestPullCmd && (effectiveScore >= 40) && (
            <RowCopyButton
              text={bestPullCmd}
              title={`Copy pull command for ${recQuantToShow} on ${pullNode?.hostname ?? pullNode?.node_id ?? 'best-fitting node'}`}
            />
          )}
          {open
            ? <ChevronDown className="w-3 h-3 text-gray-600" />
            : <ChevronRight className="w-3 h-3 text-gray-600" />}
        </div>
      </button>

      {open && (
        <div className="px-3 pb-3 border-t border-gray-700/40 space-y-3 pt-3">
          <a
            href={`https://huggingface.co/${model.model_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-[10px] text-cyan-500 hover:text-cyan-400 transition-colors"
          >
            <ExternalLink className="w-2.5 h-2.5" />
            {model.model_id}
          </a>

          <div className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">
            Per-node fit
          </div>
          <div className="space-y-0">
            {model.nodes.map(node => {
              let vramMb = node.file_size_mb;
              let displayLabel = node.fit_label;
              let displayScore = node.fit_score;
              if (!isDefaultCtx) {
                const budgetMb = node.mem_budget_gb * 1024;
                vramMb = vramAtContext(node.file_size_mb, paramsB, contextLength);
                const fit = fitLabelAtContext(vramMb, budgetMb);
                displayLabel = fit.label;
                displayScore = fit.score;
              }
              const nc = fitColors(displayScore, 'dim');
              const displayName = node.hostname ?? node.node_id;
              const isFocused = focusNodeId === node.node_id;
              const isRecommended = hasRecQuant && node.best_quant?.toUpperCase() === recQuant.toUpperCase();
              const proj = projectTpsForVariant(history ?? [], node.file_size_mb, node.best_quant, node.chip_name ?? null);
              let costPerM: number | null = null;
              if (proj && avgWatts != null) {
                const tpsAvg = (proj.min + proj.max) / 2;
                if (tpsAvg > 0) {
                  costPerM = (avgWatts / 1000) * (1_000_000 / tpsAvg / 3600) * kwhRate;
                }
              }
              return (
                <div
                  key={node.node_id}
                  className={`flex items-center gap-2 py-2 border-t border-gray-700/20 first:border-t-0 transition-opacity ${focusNodeId && !isFocused ? 'opacity-40' : ''}`}
                >
                  <Server className="w-3 h-3 text-gray-600 shrink-0" />
                  <span className={`text-[11px] w-24 shrink-0 truncate ${isFocused ? 'text-gray-200 font-semibold' : 'text-gray-400'}`} title={displayName}>
                    {displayName}
                  </span>
                  <span className={`text-[10px] font-medium px-1.5 py-px rounded border ${nc.badge} shrink-0`}>
                    {displayLabel}
                  </span>
                  <span
                    className="text-[10px] text-gray-500 font-mono shrink-0 cursor-help"
                    title={quantQualityHint(node.best_quant)}
                  >
                    {node.best_quant}
                  </span>
                  {isRecommended && (
                    <span
                      title="Recommended quant for this size class — typical sweet spot of quality vs. file size."
                      className="text-[9px] font-semibold px-1.5 py-px rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 shrink-0 cursor-default uppercase tracking-wider"
                    >
                      Rec
                    </span>
                  )}
                  <span
                    className="text-[10px] text-gray-600 shrink-0"
                    title={isDefaultCtx ? undefined : `VRAM at ${contextLengthLabel(contextLength)} ctx: ${(vramMb / 1024).toFixed(2)} GB (model + KV cache + overhead)`}
                  >
                    {isDefaultCtx
                      ? `${(node.file_size_mb / 1024).toFixed(1)} GB`
                      : `${(vramMb / 1024).toFixed(1)} GB @ ${contextLengthLabel(contextLength)}`}
                  </span>
                  <span className="text-[10px] text-gray-700 shrink-0 hidden md:inline">
                    {node.mem_budget_gb} GB pool
                  </span>
                  {proj && (
                    <span
                      className="text-[10px] text-gray-500 shrink-0 hidden md:inline"
                      title={`Projected from ${proj.count} similar-size model${proj.count === 1 ? '' : 's'} from fleet history (last 7 days).`}
                    >
                      ≈ {proj.min.toFixed(0)}-{proj.max.toFixed(0)} tok/s
                    </span>
                  )}
                  {costPerM != null && (
                    <span
                      className="text-[10px] text-gray-600 shrink-0 hidden md:inline"
                      title={`Estimated electricity cost at ${kwhRate.toFixed(3)} $/kWh, using projected tok/s and ${avgWatts!.toFixed(0)} W avg from fleet telemetry.`}
                    >
                      ≈ ${costPerM < 0.01 ? costPerM.toFixed(4) : costPerM.toFixed(3)} / M
                    </span>
                  )}
                  {node.pull_cmd && node.fit_score >= 40 && (
                    <div className="flex items-center gap-1 ml-auto">
                      <code className="text-[10px] text-cyan-400/70 font-mono truncate max-w-[200px] hidden lg:inline">
                        {node.pull_cmd}
                      </code>
                      <CopyButton text={node.pull_cmd} variant="compact" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {pullNode && pullNode.pull_cmd && pullNode.fit_score >= 40 && (
            <div className="space-y-1 pt-1">
              <div className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">
                {focusedNode ? `${focusedNode.hostname ?? focusedNode.node_id}` : 'Best node'} · {pullNode.hostname ?? pullNode.node_id} · {pullNode.best_quant}
              </div>
              <div className="flex items-center gap-1.5 bg-gray-900/60 border border-gray-700/60 rounded-lg px-2.5 py-1.5">
                <code className="text-[11px] text-cyan-300 font-mono flex-1 truncate">
                  {pullNode.pull_cmd}
                </code>
                <CopyButton text={pullNode.pull_cmd} variant="compact" />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

interface Props {
  getToken: () => Promise<string | null>;
}

const FleetModelDiscovery: React.FC<Props> = ({ getToken }) => {
  const [pendingSearch, setPending]   = useState('');
  const [data, setData]               = useState<FleetDiscoveryResponse | null>(null);
  const baseDataRef                   = useRef<FleetDiscoveryResponse | null>(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [focusNodeId, setFocusNode]   = useState<string | null>(null);
  const debounceRef                   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [onlineNodes, setOnlineNodes] = useState<Pick<NodeFit, 'node_id' | 'hostname'>[]>([]);
  const history                       = useModelComparisonHistory(false, getToken);
  const [contextLength, setContextLength] = useState<number>(DEFAULT_CONTEXT_LENGTH);
  const [fitMode, setFitMode] = useState<'any' | 'all'>('any');
  const [category, setCategory] = useState<ModelCategory | 'All'>('All');
  const [sortMode, setSortMode] = useState<SortMode>('fit');
  const { settings, isKwhRateConfigured } = useSettings();
  const kwhRate                        = settings.fleet.kwhRate || ELECTRICITY_RATE_USD_PER_KWH;
  const historyCount                   = history?.length ?? 0;

  const fetchModels = useCallback(async (query?: string, nodeId?: string | null) => {
    const token = await getToken();
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (query)  params.set('search', query);
      if (nodeId) params.set('node_id', nodeId);
      const resp = await fetch(`${CLOUD_URL}/api/fleet/model-candidates?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error(`${resp.status}`);
      const json: FleetDiscoveryResponse = await resp.json();
      setData(json);
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

  useEffect(() => {
    if (focusNodeId === null) {
      if (baseDataRef.current) setData(baseDataRef.current);
      else fetchModels(pendingSearch || undefined, null);
    } else {
      fetchModels(pendingSearch || undefined, focusNodeId);
    }
  }, [focusNodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!data || data.hf_reachable !== false || loading) return;
    const id = setTimeout(() => fetchModels(undefined, focusNodeId ?? undefined), 30_000);
    return () => clearTimeout(id);
  }, [data, loading, fetchModels, focusNodeId]);

  const handleChange = (val: string) => {
    setPending(val);
    setContextLength(DEFAULT_CONTEXT_LENGTH);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchModels(val || undefined, focusNodeId ?? undefined), 600);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    fetchModels(pendingSearch || undefined, focusNodeId ?? undefined);
  };

  const fitFilteredModels = useMemo(() => {
    const all = data?.models ?? [];
    if (focusNodeId || onlineNodes.length <= 1) return all;
    const isDefault = contextLength === DEFAULT_CONTEXT_LENGTH;
    return all.filter(m => {
      const paramsB = parseParameterCountB(m.model_id) ?? 7;
      const scores = m.nodes.map(n => {
        if (isDefault) return n.fit_score;
        const vramReq = vramAtContext(n.file_size_mb, paramsB, contextLength);
        return fitLabelAtContext(vramReq, n.mem_budget_gb * 1024).score;
      });
      if (scores.length === 0) return false;
      return fitMode === 'all'
        ? scores.every(s => s >= 40)
        : scores.some(s => s >= 40);
    });
  }, [data, focusNodeId, onlineNodes.length, fitMode, contextLength]);

  const categoryCounts = useMemo<Record<ModelCategory | 'All', number>>(() => {
    const counts: Record<ModelCategory | 'All', number> = {
      All: fitFilteredModels.length,
      General: 0, Code: 0, Reasoning: 0, Vision: 0, Embedding: 0, Audio: 0,
    };
    for (const m of fitFilteredModels) {
      const c = inferCategory(m.model_id);
      counts[c]++;
    }
    return counts;
  }, [fitFilteredModels]);

  const displayModels = useMemo(() => {
    if (category === 'All') return fitFilteredModels;
    return fitFilteredModels.filter(m => inferCategory(m.model_id) === category);
  }, [fitFilteredModels, category]);

  const focusNodeLabel = focusNodeId
    ? (onlineNodes.find(n => n.node_id === focusNodeId)?.hostname ?? focusNodeId)
    : null;

  const fitCount = useMemo(() => {
    return displayModels.filter(m => {
      const paramsB = parseParameterCountB(m.model_id) ?? 7;
      const nodes = focusNodeId
        ? m.nodes.filter(n => n.node_id === focusNodeId)
        : m.nodes;
      const isDefault = contextLength === DEFAULT_CONTEXT_LENGTH;
      const scores = nodes.map(n => {
        if (isDefault) return n.fit_score;
        const vramReq = vramAtContext(n.file_size_mb, paramsB, contextLength);
        return fitLabelAtContext(vramReq, n.mem_budget_gb * 1024).score;
      });
      if (!scores.length) return false;
      const agg = focusNodeId || fitMode === 'any'
        ? Math.max(...scores)
        : Math.min(...scores);
      return agg >= 60;
    }).length;
  }, [displayModels, focusNodeId, contextLength, fitMode]);

  return (
    <div className="space-y-3">
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
                : onlineNodes.length > 1
                  ? 'Models every online node can run — intersection of fleet VRAM budgets. Select a single node to see its full compatible catalog.'
                  : 'Models this node scores ≥60 — VRAM headroom (40 pts) · thermal margin (20 pts) · WES history (20 pts) · power efficiency (20 pts)'}
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

      {onlineNodes.length > 1 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[9px] text-gray-700 uppercase tracking-widest mr-0.5">View:</span>
          <button
            onClick={() => { setFocusNode(null); setFitMode('any'); }}
            title="Show models any one of your fleet nodes can run (broadest catalog)."
            className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
              focusNodeId == null && fitMode === 'any'
                ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                : 'bg-transparent border-gray-700 text-gray-600 hover:text-gray-400 hover:border-gray-700'
            }`}
          >
            Any fleet node {focusNodeId == null && fitMode === 'any' ? '✓' : ''}
          </button>
          <button
            onClick={() => { setFocusNode(null); setFitMode('all'); }}
            title="Show only models EVERY node in your fleet can run (intersection — safe for fleet-wide deployment)."
            className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
              focusNodeId == null && fitMode === 'all'
                ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                : 'bg-transparent border-gray-700 text-gray-600 hover:text-gray-400 hover:border-gray-700'
            }`}
          >
            Every fleet node {focusNodeId == null && fitMode === 'all' ? '✓' : ''}
          </button>
          <span className="text-gray-800">·</span>
          {onlineNodes.map(n => (
            <button
              key={n.node_id}
              onClick={() => setFocusNode(prev => prev === n.node_id ? null : n.node_id)}
              title={`Show only models that fit ${n.hostname ?? n.node_id}.`}
              className={`text-[10px] font-mono px-2 py-0.5 rounded-full border transition-colors ${
                focusNodeId === n.node_id
                  ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                  : 'bg-transparent border-gray-700 text-gray-600 hover:text-gray-400 hover:border-gray-700'
              }`}
            >
              {n.hostname ?? n.node_id}
            </button>
          ))}
        </div>
      )}

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
            className="w-full pl-8 pr-3 py-2 bg-gray-700/60 border border-gray-700/50 rounded-lg text-xs text-gray-300 placeholder:text-gray-600 focus:outline-none focus:border-cyan-500/40"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="px-3 py-2 bg-gray-700 border border-gray-700/50 rounded-lg text-xs text-gray-400 hover:text-cyan-400 hover:border-cyan-500/30 transition-colors disabled:opacity-40"
        >
          Search
        </button>
      </form>

      <div className="flex items-start gap-x-6 gap-y-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-gray-600 uppercase tracking-widest">Context length:</span>
          {CONTEXT_LENGTH_OPTIONS.map(ctx => (
            <button
              key={ctx}
              onClick={() => setContextLength(ctx)}
              title={`Recalculate VRAM and fit assuming ${contextLengthLabel(ctx)} token context window`}
              className={`text-[10px] font-mono px-2 py-0.5 rounded-full border transition-colors ${
                contextLength === ctx
                  ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                  : 'bg-transparent border-gray-700 text-gray-600 hover:text-gray-400 hover:border-gray-700'
              }`}
            >
              {contextLengthLabel(ctx)}
            </button>
          ))}
        </div>

        <div className="hidden lg:block w-px self-stretch bg-gray-700/40" aria-hidden="true" />

        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-gray-600 uppercase tracking-widest mr-0.5">Sort:</span>
          {([
            { key: 'fit',        label: 'Fit',        hint: 'Highest fit score first (default).' },
            { key: 'popularity', label: 'Popularity', hint: 'Most-downloaded on HuggingFace first.' },
            { key: 'speed',      label: 'Speed',      hint: 'Projected tok/s — fastest first. Requires fleet history.' },
            { key: 'cost',       label: 'Cost',       hint: 'Cheapest tokens per dollar first. Requires fleet history.' },
            { key: 'size_asc',   label: 'Size ↑',     hint: 'Smallest model first.' },
            { key: 'size_desc',  label: 'Size ↓',     hint: 'Largest model first.' },
          ] as { key: SortMode; label: string; hint: string }[]).map(s => {
            const needsHistory = s.key === 'speed' || s.key === 'cost';
            const disabled = needsHistory && historyCount === 0;
            return (
              <button
                key={s.key}
                onClick={() => !disabled && setSortMode(s.key)}
                disabled={disabled}
                title={s.hint + (disabled ? ' Unavailable until you run a model — projections need ≥1 measurement.' : '')}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                  sortMode === s.key
                    ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                    : disabled
                      ? 'bg-transparent border-gray-800 text-gray-700 cursor-not-allowed opacity-50'
                      : 'bg-transparent border-gray-700 text-gray-600 hover:text-gray-400 hover:border-gray-700'
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] text-gray-600 uppercase tracking-widest mr-0.5">Category:</span>
        <button
          onClick={() => setCategory('All')}
          title="Show all categories"
          className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
            category === 'All'
              ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
              : 'bg-transparent border-gray-700 text-gray-600 hover:text-gray-400 hover:border-gray-700'
          }`}
        >
          All <span className="text-gray-600 font-mono">{categoryCounts.All}</span>
        </button>
        {ALL_CATEGORIES.map(cat => {
          const count = categoryCounts[cat];
          const disabled = count === 0;
          return (
            <button
              key={cat}
              onClick={() => !disabled && setCategory(cat)}
              disabled={disabled}
              title={categoryDescription(cat) + (disabled ? ' — no matches in current view.' : '')}
              className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                category === cat
                  ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                  : disabled
                    ? 'bg-transparent border-gray-800 text-gray-700 cursor-not-allowed opacity-50'
                    : 'bg-transparent border-gray-700 text-gray-600 hover:text-gray-400 hover:border-gray-700'
              }`}
            >
              {cat} <span className="text-gray-600 font-mono">{count}</span>
            </button>
          );
        })}
      </div>

      {data && (
        <div className="text-[10px] text-gray-700">
          {data.is_live_search
            ? `Live HuggingFace search · scored against ${data.online_nodes} online node${data.online_nodes !== 1 ? 's' : ''}`
            : !pendingSearch
              ? <span><span className="text-gray-400 font-semibold">Recommended for your fleet</span> — sorted by fit, then popularity</span>
              : `Trending GGUF by downloads · scored across your ${data.online_nodes} online node${data.online_nodes !== 1 ? 's' : ''}`}
          {focusNodeId && focusNodeLabel
            ? <span className="text-cyan-600 ml-1">· showing {focusNodeLabel} compatible models</span>
            : onlineNodes.length > 1
              ? <span className="ml-1">· showing models {fitMode === 'all' ? 'every node can run' : 'at least one node can run'}</span>
              : null}
        </div>
      )}

      {data && data.online_nodes === 0 && (
        <div className="flex items-center gap-2 py-3 px-3 bg-yellow-500/5 border border-yellow-500/15 rounded-lg text-xs text-yellow-500/80">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          No nodes are currently online. Connect at least one node to score models against your hardware.
        </div>
      )}

      {data && data.hf_reachable === false && !loading && (
        <div className="flex items-start gap-2 py-3 px-3 bg-orange-500/5 border border-orange-500/15 rounded-lg text-xs text-orange-400/80">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
          <div>
            <span className="font-medium">Model catalog is still loading.</span>
            <span className="text-gray-600 ml-1">The server fetches GGUF metadata from HuggingFace at startup — this takes about 30 seconds. Try searching by name below, or check back in a moment.</span>
          </div>
        </div>
      )}

      {error && (
        <p className="text-xs text-red-400 py-1">Failed to load: {error}</p>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center py-10 gap-2 text-xs text-gray-600">
          <Loader2 className="w-4 h-4 animate-spin text-cyan-500/60" />
          {pendingSearch ? 'Searching HuggingFace…' : 'Loading trending models…'}
        </div>
      )}

      {data && displayModels.length === 0 && !loading && data.hf_reachable !== false && (
        <p className="text-xs text-gray-600 py-6 text-center">
          {focusNodeId
            ? `No models scored for ${focusNodeLabel}. Try a different search or select a different node.`
            : `No GGUF models found${pendingSearch ? ` for "${pendingSearch}"` : ''}. Try a different search term.`}
        </p>
      )}

      {displayModels.length > 0 && (
        <div className="space-y-1">
          {(() => {
            const list = [...displayModels];
            if (!pendingSearch) {
              const avgWatts = history && history.length
                ? (() => {
                    const w = history.filter(r => r.avg_watts != null && r.avg_watts > 0);
                    return w.length
                      ? w.reduce((s, r) => s + (r.avg_watts as number), 0) / w.length
                      : null;
                  })()
                : null;

              const fitOf = (m: FleetModel) => focusNodeId
                ? (m.nodes.find(n => n.node_id === focusNodeId)?.fit_score ?? 0)
                : m.fleet_best_score;
              const pullNodeOf = (m: FleetModel) => focusNodeId
                ? (m.nodes.find(n => n.node_id === focusNodeId) ?? m.nodes[0])
                : m.nodes[0];
              const projOf = (m: FleetModel) => {
                const n = pullNodeOf(m);
                if (!n) return null;
                return projectTpsForVariant(history ?? [], n.file_size_mb, n.best_quant, n.chip_name ?? null);
              };
              const sizeOf = (m: FleetModel) => pullNodeOf(m)?.file_size_mb ?? 0;
              list.sort((a, b) => {
                switch (sortMode) {
                  case 'popularity':
                    return (b.downloads ?? 0) - (a.downloads ?? 0);
                  case 'size_asc':
                    return sizeOf(a) - sizeOf(b);
                  case 'size_desc':
                    return sizeOf(b) - sizeOf(a);
                  case 'speed': {
                    const pa = projOf(a), pb = projOf(b);
                    const ta = pa ? (pa.min + pa.max) / 2 : -1;
                    const tb = pb ? (pb.min + pb.max) / 2 : -1;
                    if (tb !== ta) return tb - ta;
                    return fitOf(b) - fitOf(a);
                  }
                  case 'cost': {
                    const pa = projOf(a), pb = projOf(b);
                    const costOf = (proj: ReturnType<typeof projOf>) => {
                      if (!proj || avgWatts == null) return Number.POSITIVE_INFINITY;
                      const tps = (proj.min + proj.max) / 2;
                      if (tps <= 0) return Number.POSITIVE_INFINITY;
                      return (avgWatts / 1000) * (1_000_000 / tps / 3600) * kwhRate;
                    };
                    const ca = costOf(pa), cb = costOf(pb);
                    if (ca !== cb) return ca - cb;
                    return fitOf(b) - fitOf(a);
                  }
                  case 'fit':
                  default: {
                    const aFit = fitOf(a), bFit = fitOf(b);
                    if (bFit !== aFit) return bFit - aFit;
                    return (b.downloads ?? 0) - (a.downloads ?? 0);
                  }
                }
              });
            }
            return list.map(model => (
              <FleetModelRow
                key={model.model_id}
                model={model}
                getToken={getToken}
                focusNodeId={focusNodeId}
                history={history}
                hasFleetHistory={historyCount > 0}
                contextLength={contextLength}
                kwhRate={kwhRate}
                showCost={isKwhRateConfigured}
              />
            ));
          })()}
        </div>
      )}
    </div>
  );
};

export default FleetModelDiscovery;
