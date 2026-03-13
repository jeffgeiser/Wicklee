/**
 * ModelEvictionCard — Tier 2 Insight
 *
 * Condition (simplified proxy until /api/ps inactivity tracking is added):
 *   ollama_running === true
 *   AND ollama_active_model != null
 *   AND no tok/s activity observed for ≥ 5 minutes this session
 *
 * `lastActiveTsMs` is tracked in AIInsights.tsx — updated whenever tok/s > 0
 * is seen in an SSE frame.
 *
 * Dismissable per session.
 *
 * Keep Warm button shown as disabled (Phase 4B).
 */

import React from 'react';
import { Lock } from 'lucide-react';
import type { SentinelMetrics } from '../../../types';
import InsightCard from '../InsightCard';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Ollama's default keep_alive: 5 minutes. */
const KEEP_ALIVE_MS = 5 * 60 * 1_000;

/** Warn when 3 minutes of inactivity observed (2 minutes before eviction). */
const WARN_AFTER_MS = 3 * 60 * 1_000;

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  node:            SentinelMetrics;
  lastActiveTsMs:  number;
  showNodeHeader?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

const ModelEvictionCard: React.FC<Props> = ({ node, lastActiveTsMs, showNodeHeader = false }) => {
  if (!node.ollama_running || !node.ollama_active_model) return null;

  const inactiveMs      = Date.now() - lastActiveTsMs;
  const remainingMs     = Math.max(0, KEEP_ALIVE_MS - inactiveMs);
  const remainingMin    = Math.ceil(remainingMs / 60_000);

  // Only show when inactive for at least 3 minutes
  if (inactiveMs < WARN_AFTER_MS) return null;

  const titleSuffix = showNodeHeader ? ` · ${node.node_id}` : '';

  return (
    <InsightCard
      id="model-eviction"
      nodeId={node.node_id}
      tier={2}
      severity="amber"
      title={`Model Eviction Warning${titleSuffix}`}
    >
      <div className="px-5 py-4 space-y-3">

        {/* ── Model + time remaining ───────────────────────────────────────── */}
        <div className="flex items-center gap-2 text-sm flex-wrap">
          <span className="font-mono text-gray-200 text-xs">{node.ollama_active_model}</span>
          <span className="text-gray-500">·</span>
          <span className="text-gray-400">
            unloads in{' '}
            <span className="font-telin text-amber-400">
              ~{remainingMin} {remainingMin === 1 ? 'minute' : 'minutes'}
            </span>
          </span>
        </div>

        {/* ── Description ──────────────────────────────────────────────────── */}
        <p className="text-sm text-gray-400 leading-relaxed">
          Ollama will unload this model due to inactivity. The next inference
          request will pay the cold start penalty.
        </p>

        {/* ── Keep Warm CTA — locked (Phase 4B) ───────────────────────────── */}
        <div className="pt-1">
          <button
            disabled
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-500 text-xs font-semibold cursor-not-allowed"
          >
            <Lock className="w-3 h-3" />
            Keep Warm
            <span className="text-[9px] text-gray-600 font-normal ml-0.5">Phase 4B</span>
          </button>
        </div>

      </div>
    </InsightCard>
  );
};

export default ModelEvictionCard;
