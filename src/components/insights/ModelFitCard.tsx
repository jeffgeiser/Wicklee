/**
 * ModelFitCard
 *
 * Displays the Model-to-Hardware Fit Score for a single node.
 * Shown automatically when Ollama has an active model loaded — no user action required.
 *
 * Used in:
 *   1. AIInsights (localhost:7700) — single card at the top when a model is loaded
 *   2. AIInsights (wicklee.dev)    — one card per node with a model loaded (fleet view)
 */

import React from 'react';
import { Wrench, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import type { SentinelMetrics } from '../../types';
import type { FitResult, FitScore } from '../../utils/modelFit';

// ── Score configuration ────────────────────────────────────────────────────────

interface ScoreConfig {
  badgeCls: string;       // badge pill classes
  iconCls:  string;       // icon + label color
  label:    string;       // display label
  icon:     React.ElementType;
}

const SCORE_CONFIG: Record<FitScore, ScoreConfig> = {
  good: {
    badgeCls: 'bg-green-500/10 text-green-400 border border-green-500/20',
    iconCls:  'text-green-400',
    label:    'Good fit',
    icon:     CheckCircle2,
  },
  fair: {
    badgeCls: 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
    iconCls:  'text-amber-400',
    label:    'Fair fit',
    icon:     AlertTriangle,
  },
  poor: {
    badgeCls: 'bg-red-500/10 text-red-400 border border-red-500/20',
    iconCls:  'text-red-400',
    label:    'Poor fit',
    icon:     XCircle,
  },
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface ModelFitCardProps {
  result: FitResult;
  node:   SentinelMetrics;
  /** Fleet mode (wicklee.dev): show node ID + hostname as a header band above the card. */
  showNodeHeader?: boolean;
  /**
   * When true, the outer bg/border/rounded wrapper is omitted so the card
   * content composes cleanly inside InsightCard without double-nesting.
   */
  bare?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

const ModelFitCard: React.FC<ModelFitCardProps> = ({ result, node, showNodeHeader = false, bare = false }) => {
  const cfg       = SCORE_CONFIG[result.score];
  const ScoreIcon = cfg.icon;

  // Hardware identity for subtitle
  const hardwareName = result.isNvidia
    ? (node.gpu_name  ?? 'NVIDIA GPU')
    : (node.chip_name ?? node.gpu_name ?? 'Unknown hardware');
  const memType  = result.isNvidia ? 'VRAM' : 'unified';
  const modelName = node.ollama_active_model ?? 'Unknown model';

  // Memory bar — three segments as % of totalGb
  const usedGb      = result.totalGb - result.headroomGb;
  const otherUsedGb = Math.max(0, usedGb - result.modelSizeGb);
  const modelBarPct = Math.min((result.modelSizeGb / result.totalGb) * 100, 100);
  const usedBarPct  = Math.min((otherUsedGb       / result.totalGb) * 100, 100 - modelBarPct);
  // Free segment fills whatever remains (via flex, no explicit width needed)

  // Inner content block — shared between bare and standard renders
  const innerContent = (
    <>
      {/* ── Fleet mode header: node ID + hostname ─────────────────────────── */}
      {showNodeHeader && (
        <div className="px-5 py-2.5 border-b border-gray-800 bg-gray-800/40 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-telin font-semibold text-gray-300 truncate leading-none">
              {node.node_id}
            </p>
            {node.hostname && node.hostname !== node.node_id && (
              <p className="text-[10px] text-gray-500 truncate leading-none mt-0.5">{node.hostname}</p>
            )}
          </div>
          <span className="flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-green-400 opacity-60" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
          </span>
        </div>
      )}

      <div className="p-5 space-y-4">

        {/* ── Header: section label + score badge ───────────────────────────── */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Wrench className="w-3.5 h-3.5 text-gray-500 shrink-0" />
            <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-500 leading-none">
              Model Fit
            </p>
          </div>
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold leading-none ${cfg.badgeCls}`}>
            <ScoreIcon className="w-2.5 h-2.5" />
            {cfg.label}
          </span>
        </div>

        {/* ── Model + hardware identity ──────────────────────────────────────── */}
        <div>
          <p className="text-sm font-medium text-gray-100 leading-snug">
            <span>{modelName}</span>
            <span className="text-gray-500 mx-1.5 font-normal">on</span>
            <span className="text-gray-300">{hardwareName}</span>
          </p>
          <p className="text-[11px] text-gray-500 mt-0.5">
            <span className="font-telin">{result.totalGb.toFixed(1)}</span>
            {' '}GB {memType} memory
          </p>
        </div>

        {/* ── Score result + reason ──────────────────────────────────────────── */}
        <div className="flex items-start gap-2.5">
          <ScoreIcon className={`w-4 h-4 shrink-0 mt-px ${cfg.iconCls}`} />
          <div className="min-w-0">
            <p className={`text-sm font-semibold leading-none ${cfg.iconCls}`}>{cfg.label}</p>
            <p className="text-xs text-gray-400 mt-1 leading-relaxed">{result.reason}</p>
          </div>
        </div>

        {/* ── Memory bar + legend ────────────────────────────────────────────── */}
        <div className="space-y-2.5">

          {/* Segmented bar:  ██ model (indigo) · ▒▒ used (gray) · ░░ free (dark) */}
          <div
            className="h-2 w-full bg-gray-800 rounded-full overflow-hidden flex"
            title={`Model: ${result.modelSizeGb.toFixed(1)} GB · Used: ${usedGb.toFixed(1)} GB · Free: ${result.headroomGb.toFixed(1)} GB`}
          >
            {/* Segment 1: model loaded (indigo/purple) */}
            <div
              className="h-full bg-indigo-500/80 transition-all duration-300"
              style={{ width: `${modelBarPct}%` }}
            />
            {/* Segment 2: other used memory (gray) */}
            {usedBarPct > 0.5 && (
              <div
                className="h-full bg-gray-500/50 transition-all duration-300"
                style={{ width: `${usedBarPct}%` }}
              />
            )}
            {/* Segment 3: free headroom — fills remaining width via bg-gray-800 base */}
          </div>

          {/* Legend row */}
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-sm bg-indigo-500/80 shrink-0" />
              <span className="text-[10px] text-gray-500">
                Model: <span className="font-telin text-gray-300">{result.modelSizeGb.toFixed(1)}</span>
                <span className="text-gray-600"> GB</span>
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-sm bg-gray-500/50 shrink-0" />
              <span className="text-[10px] text-gray-500">
                Used: <span className="font-telin text-gray-300">{usedGb.toFixed(1)}</span>
                <span className="text-gray-600"> GB</span>
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-sm bg-gray-700 border border-gray-600 shrink-0" />
              <span className="text-[10px] text-gray-500">
                Free: <span className="font-telin text-gray-300">{result.headroomGb.toFixed(1)}</span>
                <span className="text-gray-600"> GB</span>
              </span>
            </div>
          </div>

        </div>

      </div>
    </>
  );

  // bare=true: skip the outer card shell — InsightCard provides the wrapper
  if (bare) return innerContent;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      {innerContent}
    </div>
  );
};

export default ModelFitCard;
