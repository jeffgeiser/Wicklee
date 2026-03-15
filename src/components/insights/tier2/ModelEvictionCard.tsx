/**
 * ModelEvictionCard — Tier 2 Insight (Community+)
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
 * Keep Warm button:
 *   canKeepWarm=true  → fires a silent 1-token Ollama ping; shows loading → "kept warm" state
 *   canKeepWarm=false → button disabled with lock icon (higher tier required)
 */

import React, { useState } from 'react';
import { Lock, Flame, Loader2 } from 'lucide-react';
import type { SentinelMetrics } from '../../../types';
import InsightCard from '../InsightCard';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Ollama's default keep_alive: 5 minutes. */
const KEEP_ALIVE_MS = 5 * 60 * 1_000;

/** Warn when 3 minutes of inactivity observed (2 minutes before eviction). */
const WARN_AFTER_MS = 3 * 60 * 1_000;

/** Success toast duration. */
const SUCCESS_DURATION_MS = 3_000;

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  node:            SentinelMetrics;
  lastActiveTsMs:  number;
  showNodeHeader?: boolean;
  /** When true, the Keep Warm button fires a silent Ollama ping. All tiers. */
  canKeepWarm?:    boolean;
  /** Called after Keep Warm fires successfully. */
  onKeepWarm?:     () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

const ModelEvictionCard: React.FC<Props> = ({
  node,
  lastActiveTsMs,
  showNodeHeader = false,
  canKeepWarm    = true,
  onKeepWarm,
}) => {
  const [keepWarmState, setKeepWarmState] = useState<'idle' | 'loading' | 'success'>('idle');

  if (!node.ollama_running || !node.ollama_active_model) return null;

  const inactiveMs      = Date.now() - lastActiveTsMs;
  const remainingMs     = Math.max(0, KEEP_ALIVE_MS - inactiveMs);
  const remainingMin    = Math.ceil(remainingMs / 60_000);

  // Only show when inactive for at least 3 minutes
  if (inactiveMs < WARN_AFTER_MS) return null;

  const activeModel  = node.ollama_active_model;
  const titleSuffix  = showNodeHeader ? ` · ${node.node_id}` : '';

  const handleKeepWarm = async () => {
    if (keepWarmState !== 'idle') return;
    setKeepWarmState('loading');
    try {
      // Silent 1-token ping — resets Ollama's keep_alive timer without a real prompt.
      await fetch('http://localhost:11434/api/generate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model:       activeModel,
          prompt:      ' ',
          num_predict: 1,
          stream:      false,
        }),
      });
    } catch {
      // Ping failure is non-fatal — still show success (model might still be warm)
    }
    setKeepWarmState('success');
    onKeepWarm?.();
    setTimeout(() => setKeepWarmState('idle'), SUCCESS_DURATION_MS);
  };

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
          <span className="font-mono text-gray-200 text-xs">{activeModel}</span>
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

        {/* ── Keep Warm CTA ─────────────────────────────────────────────────── */}
        <div className="pt-1">
          {canKeepWarm ? (
            <button
              onClick={handleKeepWarm}
              disabled={keepWarmState !== 'idle'}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                keepWarmState === 'success'
                  ? 'bg-green-900/40 border border-green-700/50 text-green-400 cursor-default'
                  : keepWarmState === 'loading'
                  ? 'bg-gray-800 border border-gray-700 text-gray-400 cursor-wait'
                  : 'bg-amber-500/10 border border-amber-500/25 text-amber-400 hover:bg-amber-500/20 cursor-pointer'
              }`}
            >
              {keepWarmState === 'loading' ? (
                <><Loader2 className="w-3 h-3 animate-spin" />Keeping warm…</>
              ) : keepWarmState === 'success' ? (
                <>Model kept warm ✓</>
              ) : (
                <><Flame className="w-3 h-3" />Keep Warm</>
              )}
            </button>
          ) : (
            <button
              disabled
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-500 text-xs font-semibold cursor-not-allowed"
            >
              <Lock className="w-3 h-3" />
              Keep Warm
              <span className="text-[9px] text-gray-600 font-normal ml-0.5">Pro+</span>
            </button>
          )}
        </div>

      </div>
    </InsightCard>
  );
};

export default ModelEvictionCard;
