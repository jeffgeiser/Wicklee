import React, { useState, useEffect, useRef } from 'react';
import { BrainCircuit, Loader2, Sparkles, AlertCircle, MonitorSmartphone, Cpu } from 'lucide-react';
import { NodeAgent, SentinelMetrics } from '../types';
import { useFleetStream } from '../contexts/FleetStreamContext';
import { computeModelFitScore } from '../utils/modelFit';
import ModelFitCard from './insights/ModelFitCard';

const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// Build-time flag: true when compiled for the local agent binary (VITE_BUILD_TARGET=agent).
// In local (Cockpit) mode this page operates in "Emergency Mode":
//   Priority order for future insight cards:
//     1. Model-to-Hardware Fit Score  ← SHIPPED
//     2. Unified Memory Exhaustion Warning
//     3. Thermal Degradation Correlation
//     4. Power Anomaly Detection
//     5. Model Eviction Prediction
//   Fleet-economics insights (WES Leaderboard, Cost Efficiency, Idle Fleet Cost) are hidden.
//   All cost values use getNodeSettings() — never hardcoded kWh rates.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _isLocalMode = (import.meta.env.VITE_BUILD_TARGET as string) === 'agent';

// ── No-model placeholder ──────────────────────────────────────────────────────

const NoModelPlaceholder: React.FC<{ fleet?: boolean }> = ({ fleet = false }) => (
  <div className="flex items-center gap-3 p-5 bg-gray-900 border border-gray-800 border-dashed rounded-2xl text-gray-500">
    <Cpu className="w-4 h-4 shrink-0 opacity-40" />
    <p className="text-sm">
      {fleet
        ? 'No models currently loaded across your fleet — fit scores appear when Ollama has an active model.'
        : 'No model loaded — fit score will appear when Ollama has an active model.'}
    </p>
  </div>
);

// ── Main component ─────────────────────────────────────────────────────────────

const AIInsights: React.FC<{
  nodes: NodeAgent[],
  userApiKey?: string,
  onNavigateToSecurity?: () => void
}> = ({ nodes, userApiKey, onNavigateToSecurity }) => {

  // ── Hooks (unconditional, per Rules of Hooks) ─────────────────────────────

  const [loading, setLoading] = useState(false);
  const [insight, setInsight] = useState<string | null>(null);

  // Local Cockpit mode: live single-node SentinelMetrics from the agent's SSE/WS stream.
  // Only populated when isLocalHost — the effect guard returns early on cloud.
  const [localSentinel, setLocalSentinel] = useState<SentinelMetrics | null>(null);
  const esRef = useRef<EventSource | null>(null);

  // Fleet (cloud) mode: live metrics from FleetStreamContext.
  // allNodeMetrics is empty ({}) on localhost because the SSE effect inside
  // FleetStreamContext skips when isLocalHost — that's intentional.
  const { allNodeMetrics } = useFleetStream();

  // Local SSE connection — agent Cockpit only (localhost:7700).
  // Mirrors the SSE fallback in Overview.tsx. This connects directly to the agent's
  // /api/metrics endpoint; the cloud SSE in FleetStreamContext is not used here.
  useEffect(() => {
    if (!isLocalHost) return;

    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      const es = new EventSource('/api/metrics');
      esRef.current = es;
      es.onmessage = (ev) => {
        try { setLocalSentinel(JSON.parse(ev.data) as SentinelMetrics); }
        catch { /* malformed frame — discard */ }
      };
      es.onerror = () => {
        es.close();
        esRef.current = null;
        retry = setTimeout(connect, 3_000);
      };
    };

    connect();

    return () => {
      clearTimeout(retry);
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  const analyzeFleet = async () => {
    setLoading(true);
    try {
      const ollamaEndpoint = userApiKey;
      if (!ollamaEndpoint) {
        throw new Error("Local Ollama instance not connected. Please configure your endpoint in Security settings.");
      }

      const prompt = `Analyze this AI fleet data and provide a concise strategic optimization report.
Fleet Snapshot:
${JSON.stringify(nodes, null, 2)}

Requirements:
1. Identify critical nodes based on Thermal (over 75C) or VRAM (over 90% usage).
2. Suggest if load balancing should be shifted.
3. Recommend specific WASM interceptors to improve efficiency.

Format the output as a Markdown report with a "Strategic Optimization" header.`;

      const response = await fetch(`${ollamaEndpoint}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'phi3:mini', prompt, stream: false }),
      });

      if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
      const data = await response.json();
      setInsight(data.response || "Failed to generate insights.");
    } catch (error) {
      console.error(error);
      setInsight("Error communicating with local model. Please ensure Ollama is running and reachable.");
    } finally {
      setLoading(false);
    }
  };

  // ── Render: Cockpit (localhost:7700) ──────────────────────────────────────

  if (isLocalHost) {
    const fitResult = localSentinel ? computeModelFitScore(localSentinel) : null;

    return (
      <div className="space-y-6">

        {/* ── Model Fit Score — first card, always-on when model loaded ───── */}
        {fitResult && localSentinel
          ? <ModelFitCard result={fitResult} node={localSentinel} />
          : <NoModelPlaceholder />
        }

        {/* ── Ollama analysis — configuration warning ─────────────────────── */}
        {!userApiKey && (
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-amber-500 shrink-0" />
              <p className="text-sm text-amber-600 dark:text-amber-200">
                Connect a local Ollama instance to enable fleet intelligence. Recommended model: phi3:mini or qwen2.5:1.5b
              </p>
            </div>
            <button
              onClick={onNavigateToSecurity}
              className="text-xs font-bold text-amber-600 dark:text-amber-200 hover:underline shrink-0 ml-4"
            >
              Configure Local Model →
            </button>
          </div>
        )}

        {/* ── Ollama analysis — CTA card ───────────────────────────────────── */}
        <div className="bg-gradient-to-br from-blue-600/20 to-cyan-400/20 border border-blue-500/20 rounded-2xl p-8 flex flex-col items-center text-center">
          <div className="w-16 h-16 rounded-2xl bg-blue-600 flex items-center justify-center shadow-xl shadow-blue-500/40 mb-6">
            <BrainCircuit className="w-8 h-8 text-white" />
          </div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Local Intelligence</h2>
          <p className="text-gray-600 dark:text-gray-400 max-w-lg mb-8">
            Powered by your local Ollama model — your fleet data never leaves your network. Wicklee analyzes your fleet using a model running on your own hardware. No data is sent to external APIs.
          </p>
          <button
            onClick={analyzeFleet}
            disabled={loading}
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-200 dark:disabled:bg-gray-800 disabled:text-gray-500 text-white font-semibold rounded-xl transition-all shadow-lg shadow-blue-500/20 flex items-center gap-2"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Sparkles className="w-5 h-5" />}
            {loading ? 'Analyzing Telemetry...' : 'Analyze My Fleet'}
          </button>
        </div>

        {/* ── Ollama analysis output ───────────────────────────────────────── */}
        {insight && (
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-6 prose prose-invert max-w-none shadow-sm dark:shadow-2xl transition-colors text-gray-700 dark:text-gray-300">
            <div className="flex items-center gap-2 mb-4 text-blue-600 dark:text-cyan-400 text-sm font-bold uppercase tracking-widest">
              <Sparkles className="w-4 h-4" />
              Local Model Analysis Output
            </div>
            <div className="whitespace-pre-wrap leading-relaxed">
              {insight}
            </div>
          </div>
        )}

        {!insight && !loading && (
          <div className="flex flex-col items-center justify-center py-12 text-gray-400 dark:text-gray-600">
            <AlertCircle className="w-8 h-8 mb-2 opacity-20" />
            <p className="text-sm">No analysis has been run for the current session.</p>
          </div>
        )}

      </div>
    );
  }

  // ── Render: Mission Control (wicklee.dev) — fleet Model Fit cards ─────────
  //
  // Model Fit is a pure frontend computation — no Ollama required, works on cloud.
  // One card per node that has a model loaded, stacked vertically.
  // The Ollama analysis section is shown below as a contextual note (runs locally only).

  const nodesWithFit = Object.entries(allNodeMetrics)
    .map(([, m]) => ({ m, result: computeModelFitScore(m) }))
    .filter((entry): entry is { m: SentinelMetrics; result: NonNullable<ReturnType<typeof computeModelFitScore>> } =>
      entry.result != null,
    );

  return (
    <div className="space-y-6">

      {/* ── Per-node Model Fit cards ─────────────────────────────────────── */}
      {nodesWithFit.length > 0
        ? nodesWithFit.map(({ m, result }) => (
            <ModelFitCard
              key={m.node_id}
              result={result}
              node={m}
              showNodeHeader
            />
          ))
        : <NoModelPlaceholder fleet />
      }

      {/* ── Ollama analysis: contextual note for cloud users ─────────────── */}
      <div className="flex flex-col items-center justify-center py-16 text-center max-w-lg mx-auto gap-6">
        <div className="w-14 h-14 bg-gray-800/50 border border-white/5 rounded-2xl flex items-center justify-center">
          <MonitorSmartphone className="w-7 h-7 text-gray-500" />
        </div>
        <div className="space-y-2">
          <h3 className="text-base font-bold text-white">Ollama analysis runs on your node</h3>
          <p className="text-sm text-gray-400 leading-relaxed">
            Fleet analysis uses your local Ollama instance — no inference data leaves your machine.
            Open the local dashboard on your node to run intelligence reports.
          </p>
        </div>
        <div className="w-full bg-gray-900 border border-gray-800 rounded-xl p-4 text-left space-y-1">
          <p className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">Open on your node</p>
          <code className="text-sm text-indigo-400 font-mono">http://localhost:7700</code>
        </div>
        <p className="text-xs text-gray-600">
          Requires the Wicklee agent and Ollama to be running on the same machine.
        </p>
      </div>

    </div>
  );
};

export default AIInsights;
