import React, { useState, useEffect, useRef } from 'react';
import {
  BrainCircuit, Loader2, Sparkles, AlertCircle,
  CheckCircle2, Lock,
} from 'lucide-react';
import { NodeAgent, SentinelMetrics } from '../types';
import { useFleetStream } from '../contexts/FleetStreamContext';
import { computeModelFitScore } from '../utils/modelFit';
import { useSettings } from '../hooks/useSettings';

// Tier 1 cards
import ThermalDegradationCard from './insights/tier1/ThermalDegradationCard';
import MemoryExhaustionCard   from './insights/tier1/MemoryExhaustionCard';
import PowerAnomalyCard       from './insights/tier1/PowerAnomalyCard';

// Tier 2 cards
import ModelFitInsightCard from './insights/tier2/ModelFitInsightCard';
import ModelEvictionCard   from './insights/tier2/ModelEvictionCard';
import IdleResourceCard    from './insights/tier2/IdleResourceCard';

// ── Constants ─────────────────────────────────────────────────────────────────

const isLocalHost =
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1';

// ── Section header ────────────────────────────────────────────────────────────

const SectionHeader: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-4">
    {children}
  </p>
);

// ── Empty alerts state ────────────────────────────────────────────────────────

const EmptyAlerts: React.FC<{ fleet?: boolean; nodeCount?: number }> = ({
  fleet = false,
  nodeCount = 0,
}) => (
  <div className="flex items-start gap-3 p-4 bg-green-500/5 border border-green-500/10 rounded-2xl">
    <CheckCircle2 className="w-4 h-4 text-green-500/60 shrink-0 mt-0.5" />
    <div>
      <p className="text-sm text-green-500/80 font-medium">
        {fleet ? '✓ Fleet nominal' : '✓ All systems nominal'}
      </p>
      <p className="text-xs text-gray-600 mt-0.5">
        {fleet
          ? `No active alerts across ${nodeCount} node${nodeCount === 1 ? '' : 's'}.`
          : 'No active alerts — Wicklee is monitoring your node continuously.'}
      </p>
    </div>
  </div>
);

// ── Fleet Intelligence placeholders (Phase 3A) ────────────────────────────────

const FleetIntelligencePlaceholder: React.FC<{ label: string }> = ({ label }) => (
  <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex items-center gap-3">
    <Lock className="w-4 h-4 text-gray-700 shrink-0" />
    <div>
      <p className="text-sm font-medium text-gray-600">{label}</p>
      <p className="text-[10px] text-gray-700 mt-0.5 uppercase tracking-widest">Phase 3A</p>
    </div>
  </div>
);

// ── Main component ─────────────────────────────────────────────────────────────

const AIInsights: React.FC<{
  nodes: NodeAgent[];
  userApiKey?: string;
  onNavigateToSecurity?: () => void;
}> = ({ nodes, userApiKey, onNavigateToSecurity }) => {

  // ── Hooks — all unconditional, per Rules of Hooks ──────────────────────────

  const [loading, setLoading]             = useState(false);
  const [insight, setInsight]             = useState<string | null>(null);
  const [localSentinel, setLocalSentinel] = useState<SentinelMetrics | null>(null);

  // Power baseline: rolling average of first 10 watt readings (localhost only)
  const wattReadingsRef = useRef<number[]>([]);
  const [sessionBaselineWatts, setSessionBaselineWatts] = useState<number | null>(null);

  // Eviction: last timestamp when tok/s > 0 was seen
  const [lastActiveTsMs, setLastActiveTsMs] = useState<number>(() => Date.now());

  // Idle: first SSE message timestamp + whether any tok/s activity ever occurred
  const firstMessageTsRef = useRef<number | null>(null);
  const hadActivityRef    = useRef<boolean>(false);
  const [hadAnyActivity, setHadAnyActivity] = useState(false);

  // Fleet (cloud) mode: live metrics from FleetStreamContext.
  // allNodeMetrics is {} on localhost — FleetStreamContext skips when isLocalHost.
  const { allNodeMetrics } = useFleetStream();

  // Settings for kWh rate and PUE (IdleResourceCard)
  const { getNodeSettings } = useSettings();

  // SSE connection — Cockpit (localhost:7700) only
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!isLocalHost) return;

    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      const es = new EventSource('/api/metrics');
      esRef.current = es;

      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as SentinelMetrics;
          setLocalSentinel(data);

          // Capture first message timestamp for session uptime
          if (firstMessageTsRef.current === null) {
            firstMessageTsRef.current = Date.now();
          }

          // Power baseline — accumulate first 10 readings then freeze
          const watts = data.cpu_power_w ?? data.nvidia_power_draw_w;
          if (watts != null && wattReadingsRef.current.length < 10) {
            wattReadingsRef.current = [...wattReadingsRef.current, watts];
            if (wattReadingsRef.current.length === 10) {
              const avg = wattReadingsRef.current.reduce((a, b) => a + b, 0) / 10;
              setSessionBaselineWatts(avg);
            }
          }

          // Track tok/s activity for eviction and idle conditions
          const toks = data.ollama_tokens_per_second ?? 0;
          if (toks > 0) {
            setLastActiveTsMs(Date.now());
            if (!hadActivityRef.current) {
              hadActivityRef.current = true;
              setHadAnyActivity(true);
            }
          }
        } catch {
          /* malformed frame — discard */
        }
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

  // ── Ollama analysis ────────────────────────────────────────────────────────

  const analyzeFleet = async () => {
    setLoading(true);
    try {
      const ollamaEndpoint = userApiKey;
      if (!ollamaEndpoint) {
        throw new Error(
          'Local Ollama instance not connected. Please configure your endpoint in Security settings.',
        );
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
      setInsight(data.response || 'Failed to generate insights.');
    } catch (error) {
      console.error(error);
      setInsight(
        'Error communicating with local model. Please ensure Ollama is running and reachable.',
      );
    } finally {
      setLoading(false);
    }
  };

  // ── Render: Cockpit (localhost:7700) ───────────────────────────────────────

  if (isLocalHost) {
    const m = localSentinel;

    // ── Tier 1 conditions ──────────────────────────────────────────────────

    const thermalLower = m?.thermal_state?.toLowerCase() ?? '';
    const tier1Thermal = thermalLower === 'serious' || thermalLower === 'critical';

    // Memory exhaustion: headroom < 10% AND model loaded
    const isNvidiaLocal  = (m?.nvidia_vram_total_mb ?? 0) > 0;
    const totalMbLocal   = isNvidiaLocal ? (m?.nvidia_vram_total_mb ?? 0) : (m?.total_memory_mb ?? 0);
    const usedMbLocal: number | null = isNvidiaLocal
      ? (m?.nvidia_vram_used_mb ?? null)
      : (m != null ? m.total_memory_mb - m.available_memory_mb : null);
    const headroomPctLocal = (usedMbLocal != null && totalMbLocal > 0)
      ? ((totalMbLocal - usedMbLocal) / totalMbLocal) * 100
      : 100;
    const tier1Memory = m != null && m.ollama_model_size_gb != null && headroomPctLocal < 10;

    // Power anomaly
    const localWatts   = m?.cpu_power_w ?? m?.nvidia_power_draw_w ?? null;
    const localGpuUtil = m?.gpu_utilization_percent ?? m?.nvidia_gpu_utilization_percent ?? null;
    const tier1Power   = localWatts != null && (
      (sessionBaselineWatts != null && localWatts > sessionBaselineWatts * 2) ||
      (localWatts > 50 && localGpuUtil != null && localGpuUtil < 20)
    );

    const anyTier1 = tier1Thermal || tier1Memory || tier1Power;

    // ── Tier 2 conditions + session dismiss state ──────────────────────────

    const fitResult          = m ? computeModelFitScore(m) : null;
    const tier2FitActive     = fitResult != null;

    const tier2EvictionActive =
      m?.ollama_running === true &&
      m?.ollama_active_model != null &&
      (Date.now() - lastActiveTsMs) >= (5 * 60 * 1_000);

    const sessionMs       = firstMessageTsRef.current ? Date.now() - firstMessageTsRef.current : 0;
    const tier2IdleActive = !hadAnyActivity && sessionMs >= 60 * 60 * 1_000 && m != null;

    // Read dismiss state from sessionStorage (updated each SSE-triggered re-render)
    const nodeId              = m?.node_id ?? 'local';
    const isFitDismissed      = sessionStorage.getItem(`insight-dismissed:model-fit:${nodeId}`)      === 'true';
    const isEvictionDismissed = sessionStorage.getItem(`insight-dismissed:model-eviction:${nodeId}`) === 'true';
    const isIdleDismissed     = sessionStorage.getItem(`insight-dismissed:idle-resource:${nodeId}`)  === 'true';

    const anyTier2Visible =
      (tier2FitActive      && !isFitDismissed)      ||
      (tier2EvictionActive && !isEvictionDismissed) ||
      (tier2IdleActive     && !isIdleDismissed);

    const nodeSettings = getNodeSettings(nodeId);

    return (
      <div className="space-y-8">

        {/* ── Section 1: Active Alerts ──────────────────────────────────────── */}
        <section>
          <SectionHeader>Active Alerts</SectionHeader>
          <div className="space-y-3">
            {tier1Thermal && m && <ThermalDegradationCard node={m} />}
            {tier1Memory  && m && <MemoryExhaustionCard   node={m} />}
            {tier1Power   && m && (
              <PowerAnomalyCard node={m} baselineWatts={sessionBaselineWatts} />
            )}
            {!anyTier1 && <EmptyAlerts />}
          </div>
        </section>

        {/* ── Section 2: Insights ───────────────────────────────────────────── */}
        {anyTier2Visible && (
          <section>
            <SectionHeader>Insights</SectionHeader>
            <div className="space-y-3">
              {tier2FitActive      && m && <ModelFitInsightCard node={m} />}
              {tier2EvictionActive && m && (
                <ModelEvictionCard node={m} lastActiveTsMs={lastActiveTsMs} />
              )}
              {tier2IdleActive && m && (
                <IdleResourceCard
                  node={m}
                  sessionStartMs={firstMessageTsRef.current!}
                  hadAnyActivity={hadAnyActivity}
                  kwhRate={nodeSettings.kwhRate}
                  pue={nodeSettings.pue}
                />
              )}
            </div>
          </section>
        )}

        {/* ── Section 3: Local AI Analysis ──────────────────────────────────── */}
        <section>
          <SectionHeader>Local AI Analysis</SectionHeader>
          <div className="space-y-4">

            {!userApiKey && (
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <AlertCircle className="w-5 h-5 text-amber-500 shrink-0" />
                  <p className="text-sm text-amber-600 dark:text-amber-200">
                    Connect a local Ollama instance to enable fleet intelligence.
                    Recommended model: phi3:mini or qwen2.5:1.5b
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

            <div className="bg-gradient-to-br from-blue-600/20 to-cyan-400/20 border border-blue-500/20 rounded-2xl p-8 flex flex-col items-center text-center">
              <div className="w-16 h-16 rounded-2xl bg-blue-600 flex items-center justify-center shadow-xl shadow-blue-500/40 mb-6">
                <BrainCircuit className="w-8 h-8 text-white" />
              </div>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
                Local Intelligence
              </h2>
              <p className="text-gray-600 dark:text-gray-400 max-w-lg mb-8">
                Powered by your local Ollama model — your fleet data never leaves
                your network. Wicklee analyzes your fleet using a model running on
                your own hardware. No data is sent to external APIs.
              </p>
              <button
                onClick={analyzeFleet}
                disabled={loading}
                className="px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-200 dark:disabled:bg-gray-800 disabled:text-gray-500 text-white font-semibold rounded-xl transition-all shadow-lg shadow-blue-500/20 flex items-center gap-2"
              >
                {loading
                  ? <Loader2 className="w-5 h-5 animate-spin" />
                  : <Sparkles className="w-5 h-5" />}
                {loading ? 'Analyzing Telemetry...' : 'Analyze My Fleet'}
              </button>
            </div>

            {insight && (
              <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-6 prose prose-invert max-w-none shadow-sm dark:shadow-2xl transition-colors text-gray-700 dark:text-gray-300">
                <div className="flex items-center gap-2 mb-4 text-blue-600 dark:text-cyan-400 text-sm font-bold uppercase tracking-widest">
                  <Sparkles className="w-4 h-4" />
                  Local Model Analysis Output
                </div>
                <div className="whitespace-pre-wrap leading-relaxed">{insight}</div>
              </div>
            )}

            {!insight && !loading && (
              <div className="flex flex-col items-center justify-center py-12 text-gray-400 dark:text-gray-600">
                <AlertCircle className="w-8 h-8 mb-2 opacity-20" />
                <p className="text-sm">No analysis has been run for the current session.</p>
              </div>
            )}

          </div>
        </section>

      </div>
    );
  }

  // ── Render: Mission Control (wicklee.dev) ─────────────────────────────────

  const allNodes  = Object.values(allNodeMetrics);
  const nodeCount = allNodes.length;

  // Fleet Tier 1 conditions
  const fleetThermalNodes = allNodes.filter(m => {
    const s = m.thermal_state?.toLowerCase() ?? '';
    return s === 'serious' || s === 'critical';
  });

  const fleetMemExhNodes = allNodes.filter(m => {
    if (!m.ollama_model_size_gb) return false;
    const isNv    = (m.nvidia_vram_total_mb ?? 0) > 0;
    const totalMb = isNv ? m.nvidia_vram_total_mb! : m.total_memory_mb;
    const usedMb  = isNv ? m.nvidia_vram_used_mb : m.total_memory_mb - m.available_memory_mb;
    if (usedMb == null || totalMb <= 0) return false;
    return ((totalMb - usedMb) / totalMb) * 100 < 10;
  });

  const fleetPowerNodes = allNodes.filter(m => {
    const w   = m.cpu_power_w ?? m.nvidia_power_draw_w ?? null;
    const gpu = m.gpu_utilization_percent ?? m.nvidia_gpu_utilization_percent ?? null;
    return w != null && w > 50 && gpu != null && gpu < 20;
  });

  const anyFleetTier1 =
    fleetThermalNodes.length > 0 ||
    fleetMemExhNodes.length  > 0 ||
    fleetPowerNodes.length   > 0;

  // Fleet Tier 2 (Model Fit per node)
  const fleetFitNodes = allNodes.filter(m => computeModelFitScore(m) != null);

  return (
    <div className="space-y-8">

      {/* ── Section 1: Active Alerts ────────────────────────────────────────── */}
      <section>
        <SectionHeader>Active Alerts</SectionHeader>
        <div className="space-y-3">
          {fleetThermalNodes.map(m => (
            <ThermalDegradationCard key={m.node_id} node={m} showNodeHeader />
          ))}
          {fleetMemExhNodes.map(m => (
            <MemoryExhaustionCard key={m.node_id} node={m} showNodeHeader />
          ))}
          {fleetPowerNodes.map(m => (
            <PowerAnomalyCard key={m.node_id} node={m} baselineWatts={null} showNodeHeader />
          ))}
          {!anyFleetTier1 && <EmptyAlerts fleet nodeCount={nodeCount} />}
        </div>
      </section>

      {/* ── Section 2: Per-Node Insights ────────────────────────────────────── */}
      {fleetFitNodes.length > 0 && (
        <section>
          <SectionHeader>Insights</SectionHeader>
          <div className="space-y-3">
            {fleetFitNodes.map(m => (
              <ModelFitInsightCard key={m.node_id} node={m} showNodeHeader />
            ))}
          </div>
        </section>
      )}

      {/* ── Section 3: Fleet Intelligence ───────────────────────────────────── */}
      <section>
        <SectionHeader>Fleet Intelligence</SectionHeader>
        <div className="space-y-3">
          <FleetIntelligencePlaceholder label="Fleet WES Leaderboard" />
          <FleetIntelligencePlaceholder label="Fleet Thermal Diversity Score" />
          <FleetIntelligencePlaceholder label="Idle Fleet Cost" />
        </div>
        <p className="text-xs text-gray-700 mt-4 text-center">
          Fleet intelligence cards launch in Phase 3A.
        </p>
      </section>

    </div>
  );
};

export default AIInsights;
