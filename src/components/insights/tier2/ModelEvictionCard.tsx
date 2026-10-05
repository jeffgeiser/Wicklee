/**
 * ModelEvictionCard — Tier 2 Insight (Community+)
 *
 * Fires when an Ollama model has been idle (inference_state !== 'live') for
 * ≥ 3 minutes.  Uses real inference-state transitions tracked in AIInsights,
 * not session-relative tok/s timestamps — so it fires correctly even when the
 * page was just opened on an already-idle node.
 *
 * Props:
 *   idleSinceMs  — timestamp (ms) when the node last entered idle state.
 *                  Pass null when the node is actively inferring (card hides).
 *
 * Note: eviction is Ollama-specific.  vLLM and llama.cpp servers hold models
 * in memory permanently, so this card is gated on ollama_active_model.
 *
 * Keep Warm button fires a silent 1-token ping to reset Ollama's keep_alive.
 */

import React, { useState } from 'react';
import { Flame, Loader2 } from 'lucide-react';
import type { SentinelMetrics } from '../../../types';
import InsightCard from '../InsightCard';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Ollama's default keep_alive: 5 minutes. */
const KEEP_ALIVE_MS = 5 * 60 * 1_000;

/** Warn when 3 minutes of inactivity observed (2 minutes before eviction). */
const WARN_AFTER_MS = 3 * 60 * 1_000;

/** Success / failure toast duration. */
const SUCCESS_DURATION_MS = 3_000;

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  node:            SentinelMetrics;
  /**
   * Timestamp (ms) when this node's inference_state last transitioned to idle.
   * null = node is actively inferring → card will not render.
   */
  idleSinceMs:     number | null;
  showNodeHeader?: boolean;
  /**
   * True only where the browser can reach this node's Ollama directly — the
   * local agent dashboard. From the cloud fleet view the request would go to
   * the viewer's own machine, not the remote node.
   */
  canKeepWarm?:    boolean;
  onKeepWarm?:     () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

const ModelEvictionCard: React.FC<Props> = ({
  node,
  idleSinceMs,
  showNodeHeader = false,
  canKeepWarm    = true,
  onKeepWarm,
}) => {
  const [keepWarmState, setKeepWarmState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');

  // Must have an Ollama model loaded and be in idle state
  if (!node.ollama_running || !node.ollama_active_model) return null;
  if (idleSinceMs == null) return null;

  const inactiveMs   = Date.now() - idleSinceMs;
  const remainingMs  = Math.max(0, KEEP_ALIVE_MS - inactiveMs);
  const remainingMin = Math.ceil(remainingMs / 60_000);

  // Only show when inactive for at least 3 minutes
  if (inactiveMs < WARN_AFTER_MS) return null;

  const activeModel  = node.ollama_active_model;
  const titleSuffix  = showNodeHeader ? ` · ${node.hostname ?? node.node_id}` : '';

  const handleKeepWarm = async () => {
    if (keepWarmState !== 'idle') return;
    setKeepWarmState('loading');
    let ok = false;
    try {
      const res = await fetch('http://localhost:11434/api/generate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model:       activeModel,
          prompt:      ' ',
          num_predict: 1,
          stream:      false,
        }),
      });
      ok = res.ok;
    } catch {
      // Ollama unreachable — reported below, never shown as success.
    }
    setKeepWarmState(ok ? 'success' : 'error');
    if (ok) onKeepWarm?.();
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
            {remainingMs > 0
              ? <>unloads in <span className="font-telin text-amber-400">~{remainingMin} {remainingMin === 1 ? 'minute' : 'minutes'}</span></>
              : <span className="text-red-400">eviction may have occurred</span>
            }
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
                  : keepWarmState === 'error'
                  ? 'bg-red-900/30 border border-red-700/40 text-red-400 cursor-default'
                  : keepWarmState === 'loading'
                  ? 'bg-gray-700 border border-gray-700 text-gray-400 cursor-wait'
                  : 'bg-amber-500/10 border border-amber-500/25 text-amber-400 hover:bg-amber-500/20 cursor-pointer'
              }`}
            >
              {keepWarmState === 'loading' ? (
                <><Loader2 className="w-3 h-3 animate-spin" />Keeping warm…</>
              ) : keepWarmState === 'success' ? (
                <>Model kept warm ✓</>
              ) : keepWarmState === 'error' ? (
                <>Couldn’t reach Ollama</>
              ) : (
                <><Flame className="w-3 h-3" />Keep Warm</>
              )}
            </button>
          ) : (
            <p className="text-[11px] text-gray-500">
              To keep it loaded, send a request to the node, or use Keep Warm in
              that node’s local dashboard (localhost:7700).
            </p>
          )}
        </div>

      </div>
    </InsightCard>
  );
};

export default ModelEvictionCard;
