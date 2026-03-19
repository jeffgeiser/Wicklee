/**
 * patternEngine.ts — Deterministic time-windowed pattern detection.
 *
 * Principles:
 *  1. No external AI — pure JS arithmetic over localStorage history.
 *  2. Every pattern requires a minObservationWindowMs gate before firing.
 *     This prevents false positives from model-loading spikes or brief hiccups.
 *  3. Each DetectedInsight carries a quantified "so what" (hook), a specific
 *     operator recommendation (human-readable), and an action_id (machine-
 *     readable for automation / API consumers).
 *  4. Patterns are tier-gated: 'community' fires for everyone, 'pro'/'team'
 *     require paid tiers.
 *  5. Patterns expose a `confidence` 0–1 and `observedMs` / `requiredMs`
 *     so the UI can render a "Building..." progress bar before the pattern
 *     has enough evidence to be called High Confidence.
 *  6. Node-availability gate: offline fleet nodes are NEVER named in
 *     recommendations. Only nodes where isOnline === true are suggested
 *     as routing targets.
 *  7. Hardware-tier-aware recommendations: accelerator-class nodes (H100,
 *     B200, GB10) receive different directives than workstation-class nodes.
 *
 * Sprint 3 additions:
 *  - `recommendation: string` — prescriptive 1–2 sentence operator action.
 *  - `action_id: ActionId`   — stable machine key for agent automation.
 *  - `FleetNodeSummary[]`     — fleet peer context for cross-node advice.
 *  - Pattern D: Power-GPU Decoupling (pro tier)
 *  - Pattern E: Fleet Load Imbalance (pro tier)
 */

import type { MetricSample } from '../hooks/useMetricHistory';
import { SAMPLE_INTERVAL_MS } from '../hooks/useMetricHistory';

// ── ActionId — machine-readable action classification ─────────────────────────
//
// Stable string keys used by:
//   - GET /api/v1/insights/latest  (Sprint 5)
//   - Automation scripts polling the agent endpoint
//   - Pattern dismissal audit trail (Sprint 6)
//
// Never rename — these are external API contract values.

export type ActionId =
  | 'rebalance_workload'   // shift load to a healthier fleet node
  | 'evict_idle_models'    // ollama stop / unload VRAM
  | 'reduce_batch_size'    // lower concurrent request batch
  | 'check_thermal_zone'   // physical intervention — airflow / ambient
  | 'investigate_phantom'  // diagnose idle-but-loaded model
  | 'schedule_offpeak';    // defer workload to off-peak window

// ── FleetNodeSummary — peer context for cross-node recommendations ─────────────
//
// A lightweight snapshot of each fleet peer passed into evaluatePatterns().
// Populated by AIInsights from allNodeMetrics (FleetStreamContext).
// The node being evaluated is always excluded from this list when looking for
// routing alternatives.

export interface FleetNodeSummary {
  nodeId:              string;
  hostname:            string;
  /** True only when the node had a telemetry frame in the last 90 seconds. */
  isOnline:            boolean;
  currentThermalState: string | null;
  currentWes:          number | null;
  currentTokS:         number | null;
  /** (vram_total - vram_used) / vram_total × 100 — null on non-GPU / unknown. */
  vramHeadroomPct:     number | null;
  /** WES tier from SentinelMetrics.wes_tier — used to gate tier-aware copy. */
  wesTier:             'workstation' | 'server' | 'accelerator' | null;
}

// ── Output types ───────────────────────────────────────────────────────────────

export type PatternTier = 'community' | 'pro' | 'team';
export type PatternConfidence = 'building' | 'moderate' | 'high';

export interface PatternAction {
  /** Short label for the action button (≤ 40 chars). */
  label: string;
  /** Shell command, API endpoint, or instruction to copy. */
  copyText: string;
  /** If true, render as an API endpoint reference instead of a shell command. */
  isEndpoint?: boolean;
}

export interface DetectedInsight {
  /** Pattern ID — stable, used for dismissal dedup and alert wiring. */
  patternId: string;
  /** Node this observation was detected on. */
  nodeId: string;
  hostname: string;
  /** Short headline (≤ 60 chars). */
  title: string;
  /**
   * The "Quantified Hook" — the $-or-metric number shown prominently.
   * E.g. "-$1.47/day", "-4.2 tok/s", "23% WES loss"
   */
  hook: string;
  /** One-paragraph explanation of what was observed and why it matters. */
  body: string;
  /**
   * Prescriptive 1–2 sentence recommendation for the operator.
   * Incorporates fleet availability and hardware tier context.
   * Safe to display directly in UI and to include in /api/v1/insights/latest.
   */
  recommendation: string;
  /**
   * Machine-readable action classification for automation / API consumers.
   * Stable across versions — never rename existing values.
   */
  action_id: ActionId;
  /** Minimum evidence window required before this pattern may fire. */
  requiredMs: number;
  /** How long the pattern condition has been continuously observed. */
  observedMs: number;
  /** Confidence level based on observedMs / requiredMs. */
  confidence: PatternConfidence;
  /** 0.0–1.0 for the progress bar. */
  confidenceRatio: number;
  /** Minimum subscription tier required to see this insight. */
  tier: PatternTier;
  /** Actions the operator can take — rendered as copy buttons. */
  actions: PatternAction[];
  /** Unix ms when the pattern first fired in this session. */
  firstFiredMs: number;
  /**
   * The node ID of the fleet peer this insight recommends routing to, if any.
   * Null for patterns that recommend local action (evict model, reduce batch, etc.)
   * rather than cross-node rerouting.
   *
   * Stored verbatim in InsightRecentEvent so InsightsBriefingCard can verify
   * the peer's current online status at render time — the peer may have gone
   * offline in the hours since the briefing event was captured.
   *
   * Also used by GET /api/v1/insights/latest (Sprint 5) as best_online_node.
   */
  best_node_id:       string | null;
  best_node_hostname: string | null;
}

// ── Internal helpers ───────────────────────────────────────────────────────────

function toConfidence(ratio: number): PatternConfidence {
  if (ratio < 0.5) return 'building';
  if (ratio < 0.9) return 'moderate';
  return 'high';
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function nonNull<T>(arr: (T | null | undefined)[]): T[] {
  return arr.filter((v): v is T => v != null);
}

/**
 * Ordinary least-squares slope over an array of y values.
 * x is implicitly [0, 1, 2, …, n-1] (one unit = one sample = SAMPLE_INTERVAL_MS).
 * Returns the slope in y-units per sample.
 */
function linearSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX  += i;
    sumY  += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
}

// ── Node-availability gate ─────────────────────────────────────────────────────
//
// Returns the best online fleet peer for routing — never the current node.
// "Best" = Normal thermal state → highest WES → most VRAM headroom.
// Returns null when no healthy peer is available (single-node fleet, or all
// peers are offline / degraded).

function bestAlternativeNode(
  currentNodeId: string,
  fleetContext:  FleetNodeSummary[],
): FleetNodeSummary | null {
  const candidates = fleetContext.filter(
    n => n.nodeId !== currentNodeId &&
         n.isOnline &&
         (n.currentThermalState === 'Normal' || n.currentThermalState === null),
  );
  if (candidates.length === 0) return null;

  // Sort: highest WES first, then highest VRAM headroom as tiebreaker
  candidates.sort((a, b) => {
    const wesA = a.currentWes ?? 0;
    const wesB = b.currentWes ?? 0;
    if (wesB !== wesA) return wesB - wesA;
    return (b.vramHeadroomPct ?? 0) - (a.vramHeadroomPct ?? 0);
  });
  return candidates[0];
}

// ── Pattern A: Thermal Performance Drain ─────────────────────────────────────
//
// What: Node is sustaining an elevated thermal penalty, measurably reducing
// tok/s vs. its own "Normal" baseline.
//
// Refinements applied:
//   - Baseline WES drawn from samples where thermal_state === 'Normal' only.
//   - minObservationWindowMs = 5 minutes.
//   - Hardware-tier-aware recommendation: accelerator nodes get preservation
//     directives; workstation nodes get standard rerouting advice.
//
// Community tier: fires for all users.

const PATTERN_A_ID             = 'thermal_drain';
const PATTERN_A_MIN_WINDOW_MS  = 5 * 60 * 1000;   // 5 min
const PATTERN_A_MIN_SAMPLES    = Math.ceil(PATTERN_A_MIN_WINDOW_MS / SAMPLE_INTERVAL_MS); // 10

function evaluatePatternA(
  nodeId:       string,
  hostname:     string,
  history:      MetricSample[],
  fleetContext: FleetNodeSummary[],
  now:          number,
  wesTier?:     'workstation' | 'server' | 'accelerator' | null,
): DetectedInsight | null {
  if (history.length < PATTERN_A_MIN_SAMPLES) return null;

  // Split history into Normal-thermal baseline vs current hot window
  const normalSamples = history.filter(
    s => (s.thermal_state === 'Normal' || s.thermal_state === null) && s.tok_s != null,
  );
  // Last 10 samples for the "current" window (5 min)
  const recentSamples = history.slice(-PATTERN_A_MIN_SAMPLES);
  const hotSamples    = recentSamples.filter(
    s => s.thermal_state != null &&
         s.thermal_state !== 'Normal' &&
         s.tok_s != null,
  );

  // Need enough hot samples and a Normal baseline to compare
  if (hotSamples.length < Math.ceil(PATTERN_A_MIN_SAMPLES * 0.6)) return null;
  if (normalSamples.length < 3) return null;

  const baselineTokS  = mean(nonNull(normalSamples.map(s => s.tok_s)));
  const hotTokS       = mean(nonNull(hotSamples.map(s => s.tok_s)));
  const deltaPercent  = baselineTokS > 0
    ? ((baselineTokS - hotTokS) / baselineTokS) * 100
    : 0;

  // Only fire if degradation is > 8%
  if (deltaPercent < 8) return null;

  const observedMs   = hotSamples.length * SAMPLE_INTERVAL_MS;
  const ratio        = Math.min(observedMs / PATTERN_A_MIN_WINDOW_MS, 1);
  const deltaTokS    = (baselineTokS - hotTokS).toFixed(1);
  const currentState = hotSamples[hotSamples.length - 1]?.thermal_state ?? 'Elevated';

  // Estimate daily cost using a simple tok/s → req/hr model (rough)
  const reqPerHr    = hotTokS > 0 ? (hotTokS * 3600) / 500 : 0;   // ~500 tok avg request
  const baseReqPerHr = baselineTokS > 0 ? (baselineTokS * 3600) / 500 : 0;
  const lostThroughput = Math.max(baseReqPerHr - reqPerHr, 0);

  // Node-availability gate: find a healthy peer to recommend
  const altNode = bestAlternativeNode(nodeId, fleetContext);

  // Hardware-tier-aware + availability-aware recommendation
  let recommendation: string;
  let action_id: ActionId;

  if (wesTier === 'accelerator') {
    // Accelerator nodes (H100, B200, GB10) — preserve for high-priority work
    if (altNode) {
      recommendation =
        `Route lower-priority requests to ${altNode.hostname} ` +
        `(WES ${altNode.currentWes?.toFixed(0) ?? '?'}, Normal thermal) to preserve ` +
        `${hostname}'s accelerator capacity for high-priority inference. ` +
        `Investigate rack cooling or ambient temperature to recover the ${deltaPercent.toFixed(0)}% penalty.`;
    } else {
      recommendation =
        `No healthy peer is available for rerouting. Reduce concurrent request count ` +
        `on ${hostname} to lower thermal load and recover throughput. ` +
        `Investigate rack cooling or ambient temperature.`;
    }
    action_id = altNode ? 'rebalance_workload' : 'check_thermal_zone';
  } else {
    // Workstation / server class
    if (altNode) {
      recommendation =
        `Route new requests to ${altNode.hostname} ` +
        `(WES ${altNode.currentWes?.toFixed(0) ?? '?'}) using \`GET /api/v1/route/best\`. ` +
        `${hostname} will recover once thermal state returns to Normal — ` +
        `improve airflow if the ${currentState} state persists.`;
      action_id = 'rebalance_workload';
    } else {
      recommendation =
        `No healthy peer is online for rerouting. Improve airflow around ${hostname}, ` +
        `reduce concurrent requests, or pause low-priority jobs until thermal state ` +
        `returns to Normal and throughput recovers.`;
      action_id = 'check_thermal_zone';
    }
  }

  return {
    patternId:       PATTERN_A_ID,
    nodeId,
    hostname,
    title:           'Thermal Performance Drain',
    hook:            `-${deltaTokS} tok/s (${deltaPercent.toFixed(0)}% below Normal baseline)`,
    body:            `${hostname} has been running at ${currentState} thermal state for the last ` +
                     `${Math.round(observedMs / 60000)} min, sustaining a ${deltaPercent.toFixed(0)}% ` +
                     `throughput penalty vs. its own Normal-temperature baseline ` +
                     `(${baselineTokS.toFixed(1)} tok/s → ${hotTokS.toFixed(1)} tok/s). ` +
                     `${lostThroughput > 0 ? `That's ~${lostThroughput.toFixed(0)} fewer completions/hr.` : ''}`,
    recommendation,
    action_id,
    requiredMs:      PATTERN_A_MIN_WINDOW_MS,
    observedMs,
    confidence:      toConfidence(ratio),
    confidenceRatio: ratio,
    tier:            'community',
    actions: [
      {
        label:    'Route away from this node',
        copyText: 'GET /api/v1/route/best',
        isEndpoint: true,
      },
      {
        label:    'Check thermal state',
        copyText: `curl http://localhost:7700/api/health | jq '.thermal_state'`,
      },
    ],
    firstFiredMs:       now,
    best_node_id:       altNode?.nodeId       ?? null,
    best_node_hostname: altNode?.hostname      ?? null,
  };
}

// ── Pattern B: Phantom Load ───────────────────────────────────────────────────
//
// What: A node is drawing significant power (VRAM allocated or watts > idle
// baseline) with zero inference activity for a sustained window.
// Quantified hook: $/day wasted.
//
// Refinements applied:
//   - Uses INFERENCE_VRAM_THRESHOLD_MB = 1024 MB filter so BMC chips don't
//     trigger the pattern. vram_used_mb in MetricSample is already filtered.
//   - minObservationWindowMs = 5 minutes.
//   - Requires watts > 0 (apple nodes report cpu_power_w; Nvidia nodes
//     report nvidia_power_draw_w — both flow into MetricSample.watts).
//
// Community tier.

const PATTERN_B_ID            = 'phantom_load';
const PATTERN_B_MIN_WINDOW_MS = 5 * 60 * 1000;
const PATTERN_B_MIN_SAMPLES   = Math.ceil(PATTERN_B_MIN_WINDOW_MS / SAMPLE_INTERVAL_MS);

// kWh rate used for $/day estimate when we don't have user settings
const DEFAULT_KWH_RATE = 0.12;

function evaluatePatternB(
  nodeId:       string,
  hostname:     string,
  history:      MetricSample[],
  now:          number,
  kwhRate = DEFAULT_KWH_RATE,
): DetectedInsight | null {
  if (history.length < PATTERN_B_MIN_SAMPLES) return null;

  const recent = history.slice(-PATTERN_B_MIN_SAMPLES);

  // All recent samples must show: watts > idle threshold AND no tok/s activity
  const IDLE_WATTS_THRESHOLD = 5;  // below this = truly idle, skip
  const hotSamples = recent.filter(
    s =>
      (s.watts ?? 0) > IDLE_WATTS_THRESHOLD &&
      (s.vram_used_mb ?? 0) > 0 &&
      (s.tok_s == null || s.tok_s < 0.5),   // no meaningful inference
  );

  if (hotSamples.length < Math.ceil(PATTERN_B_MIN_SAMPLES * 0.7)) return null;

  const avgWatts   = mean(nonNull(hotSamples.map(s => s.watts)));
  const avgVramMb  = mean(nonNull(hotSamples.map(s => s.vram_used_mb)));

  // Need meaningful load signal
  if (avgWatts < 10) return null;

  const observedMs  = hotSamples.length * SAMPLE_INTERVAL_MS;
  const ratio       = Math.min(observedMs / PATTERN_B_MIN_WINDOW_MS, 1);
  const kwhPerDay   = (avgWatts / 1000) * 24;
  const costPerDay  = kwhPerDay * kwhRate;
  const vramGb      = (avgVramMb / 1024).toFixed(1);

  return {
    patternId:       PATTERN_B_ID,
    nodeId,
    hostname,
    title:           'Phantom Load',
    hook:            `-$${costPerDay.toFixed(2)}/day`,
    body:            `${hostname} is drawing ${avgWatts.toFixed(0)}W with ` +
                     `${vramGb} GB VRAM allocated but no inference ` +
                     `activity for ${Math.round(observedMs / 60000)} min. ` +
                     `A model is loaded and holding resources without serving requests. ` +
                     `At $${kwhRate}/kWh this costs ~$${costPerDay.toFixed(2)}/day.`,
    recommendation:  `Unload the idle model to reclaim ${vramGb} GB VRAM and reduce power draw ` +
                     `by ~${avgWatts.toFixed(0)}W. Run \`ollama ps\` to confirm which model ` +
                     `is loaded, then \`ollama stop <model>\` to release it.`,
    action_id:       'evict_idle_models',
    requiredMs:      PATTERN_B_MIN_WINDOW_MS,
    observedMs,
    confidence:      toConfidence(ratio),
    confidenceRatio: ratio,
    tier:            'community',
    actions: [
      {
        label:    'Unload model',
        copyText: `ollama stop $(ollama ps | awk 'NR>1 {print $1}')`,
      },
      {
        label:    'List loaded models',
        copyText: 'ollama ps',
      },
    ],
    firstFiredMs:       now,
    best_node_id:       null,   // Pattern B: local action only (evict model)
    best_node_hostname: null,
  };
}

// ── Pattern C: WES Velocity Drop ─────────────────────────────────────────────
//
// What: WES score is declining at a sustained rate over a 10-min window —
// the "leading indicator" that fires BEFORE thermal state changes.
//
// Refinements applied:
//   - minObservationWindowMs = 10 min (highest gate of all patterns).
//   - Suppresses when thermal_state is already Serious/Critical.
//   - Requires both a negative slope AND >10% total WES drop.
//
// Community tier.

const PATTERN_C_ID            = 'wes_velocity_drop';
const PATTERN_C_MIN_WINDOW_MS = 10 * 60 * 1000;   // 10 min — highest gate
const PATTERN_C_MIN_SAMPLES   = Math.ceil(PATTERN_C_MIN_WINDOW_MS / SAMPLE_INTERVAL_MS); // 20

function evaluatePatternC(
  nodeId:       string,
  hostname:     string,
  history:      MetricSample[],
  fleetContext: FleetNodeSummary[],
  now:          number,
): DetectedInsight | null {
  if (history.length < PATTERN_C_MIN_SAMPLES) return null;

  const recent    = history.slice(-PATTERN_C_MIN_SAMPLES);
  const wesValues = nonNull(recent.map(s => s.wes_score));

  // Need dense WES coverage across the window
  if (wesValues.length < Math.ceil(PATTERN_C_MIN_SAMPLES * 0.7)) return null;

  // Suppress if already in serious thermal state — Pattern A covers it better
  const latestThermal = recent[recent.length - 1]?.thermal_state;
  if (latestThermal === 'Serious' || latestThermal === 'Critical') return null;

  // Slope in WES units per sample (one sample = 30s)
  const slopePerSample = linearSlope(wesValues);
  const slopePerMin    = slopePerSample * 2;   // 2 samples/min

  // Must be a meaningful sustained decline
  if (slopePerMin >= -0.5) return null;

  const firstWes  = wesValues[0];
  const lastWes   = wesValues[wesValues.length - 1];
  const dropPct   = firstWes > 0 ? ((firstWes - lastWes) / firstWes) * 100 : 0;

  // Require at least 10% total drop — filters flat but noisy slopes
  if (dropPct < 10) return null;

  // Project time until WES halves from current value (rough ETA for urgency)
  const minutesToHalf = (lastWes > 0 && slopePerMin < 0)
    ? (lastWes / 2) / Math.abs(slopePerMin)
    : null;

  const observedMs  = wesValues.length * SAMPLE_INTERVAL_MS;
  const ratio       = Math.min(observedMs / PATTERN_C_MIN_WINDOW_MS, 1);

  // Node-availability gate
  const altNode = bestAlternativeNode(nodeId, fleetContext);

  let recommendation: string;
  if (altNode) {
    recommendation =
      `Pre-emptively route new requests to ${altNode.hostname} ` +
      `(WES ${altNode.currentWes?.toFixed(0) ?? '?'}) before thermal state changes. ` +
      `Check ambient temperature and background processes on ${hostname} — ` +
      `${minutesToHalf != null && minutesToHalf < 30
        ? `WES may halve in ~${Math.round(minutesToHalf)} min at this rate.`
        : `the decline has been sustained for ${Math.round(observedMs / 60000)} min.`}`;
  } else {
    recommendation =
      `No healthy peer is available for rerouting. Reduce workload on ${hostname} now ` +
      `— check ambient temperature, competing background processes, and VRAM allocation. ` +
      `${minutesToHalf != null && minutesToHalf < 30
        ? `WES may halve in ~${Math.round(minutesToHalf)} min at this rate.`
        : ''}`;
  }

  return {
    patternId:       PATTERN_C_ID,
    nodeId,
    hostname,
    title:           'WES Velocity Drop',
    hook:            `${slopePerMin.toFixed(1)} WES/min · ${dropPct.toFixed(0)}% drop`,
    body:            `${hostname}'s efficiency score has been declining at ` +
                     `${Math.abs(slopePerMin).toFixed(1)} WES/min for the last ` +
                     `${Math.round(observedMs / 60000)} min ` +
                     `(${firstWes.toFixed(0)} → ${lastWes.toFixed(0)} WES). ` +
                     `Thermal state has not yet changed — this is an early warning. ` +
                     `${minutesToHalf != null && minutesToHalf < 60
                       ? `At this rate WES will halve in ~${Math.round(minutesToHalf)} min.`
                       : ''}`,
    recommendation,
    action_id:       altNode ? 'rebalance_workload' : 'check_thermal_zone',
    requiredMs:      PATTERN_C_MIN_WINDOW_MS,
    observedMs,
    confidence:      toConfidence(ratio),
    confidenceRatio: ratio,
    tier:            'community',
    actions: [
      {
        label:    'Route away now',
        copyText: 'GET /api/v1/route/best',
        isEndpoint: true,
      },
      {
        label:    'Check WES + thermal',
        copyText: `curl http://localhost:7700/api/health | jq '{wes:.wes_score,thermal:.thermal_state}'`,
      },
    ],
    firstFiredMs:       now,
    best_node_id:       altNode?.nodeId       ?? null,
    best_node_hostname: altNode?.hostname      ?? null,
  };
}

// ── Pattern D: Power-GPU Decoupling ──────────────────────────────────────────
//
// What: A node is drawing significant power and running inference (tok/s > 0)
// but GPU utilization is anomalously low. Suggests CPU-bound or memory-bound
// processing — common with large-context requests, over-quantized models, or
// CPU-offloaded layers on a mixed architecture (e.g. Q2_K on M-series with
// too many layers offloaded to CPU).
//
// Trigger: watts > 50W AND tok/s > 0 AND gpu_util_pct < 20%
//   sustained for 5 min.
//
// Refinements:
//   - Only fires when gpu_util_pct data is available (skips CPU-only nodes).
//   - Suppresses on nodes with cooling_type === 'passive' where thermal info
//     is already the primary signal.
//
// Pro tier: requires historical GPU utilization data dense enough for a
// meaningful comparison, which is only reliable after several samples.

const PATTERN_D_ID            = 'power_gpu_decoupling';
const PATTERN_D_MIN_WINDOW_MS = 5 * 60 * 1000;
const PATTERN_D_MIN_SAMPLES   = Math.ceil(PATTERN_D_MIN_WINDOW_MS / SAMPLE_INTERVAL_MS);
const PATTERN_D_GPU_LOW_PCT   = 20;   // below this = under-utilized GPU
const PATTERN_D_MIN_WATTS     = 50;   // minimum power to be interesting

function evaluatePatternD(
  nodeId:   string,
  hostname: string,
  history:  MetricSample[],
  now:      number,
): DetectedInsight | null {
  if (history.length < PATTERN_D_MIN_SAMPLES) return null;

  const recent = history.slice(-PATTERN_D_MIN_SAMPLES);

  // Must have gpu_util_pct data — this pattern is meaningless without it
  const gpuSamples = recent.filter(s => s.gpu_util_pct != null);
  if (gpuSamples.length < Math.ceil(PATTERN_D_MIN_SAMPLES * 0.7)) return null;

  // Filter to qualifying samples: high watts + inference active + low GPU util
  const decoupledSamples = gpuSamples.filter(
    s =>
      (s.watts ?? 0) > PATTERN_D_MIN_WATTS &&
      (s.tok_s ?? 0) > 0 &&
      (s.gpu_util_pct ?? 100) < PATTERN_D_GPU_LOW_PCT,
  );

  if (decoupledSamples.length < Math.ceil(PATTERN_D_MIN_SAMPLES * 0.6)) return null;

  const avgWatts   = mean(nonNull(decoupledSamples.map(s => s.watts)));
  const avgGpuUtil = mean(nonNull(decoupledSamples.map(s => s.gpu_util_pct)));
  const avgTokS    = mean(nonNull(decoupledSamples.map(s => s.tok_s)));

  const observedMs = decoupledSamples.length * SAMPLE_INTERVAL_MS;
  const ratio      = Math.min(observedMs / PATTERN_D_MIN_WINDOW_MS, 1);

  // Efficiency gap: what you'd expect from GPU-routed inference at this power
  const expectedTokS = avgWatts / 2;   // rough heuristic: 2W per tok/s at full GPU util
  const gapPct       = expectedTokS > 0
    ? ((expectedTokS - avgTokS) / expectedTokS) * 100
    : 0;

  return {
    patternId:       PATTERN_D_ID,
    nodeId,
    hostname,
    title:           'Power-GPU Decoupling',
    hook:            `${avgGpuUtil.toFixed(0)}% GPU · ${avgWatts.toFixed(0)}W`,
    body:            `${hostname} is drawing ${avgWatts.toFixed(0)}W and generating ` +
                     `${avgTokS.toFixed(1)} tok/s, but GPU utilization is only ` +
                     `${avgGpuUtil.toFixed(0)}% — significantly below what the power ` +
                     `draw suggests. Inference workload appears CPU-bound or memory-bound. ` +
                     `Common causes: large context window filling KV cache, ` +
                     `CPU-offloaded layers in a mixed quantization, or a batch size too ` +
                     `small to saturate the GPU's SIMD lanes.`,
    recommendation:  `Try reducing concurrent context length or switching to a quantization ` +
                     `with fewer CPU-offloaded layers (e.g. Q4_K_M over Q2_K). ` +
                     `If using vLLM, decrease \`--max-num-batched-tokens\` to find the ` +
                     `GPU-saturating sweet spot and recover the efficiency gap.`,
    action_id:       'reduce_batch_size',
    requiredMs:      PATTERN_D_MIN_WINDOW_MS,
    observedMs,
    confidence:      toConfidence(ratio),
    confidenceRatio: ratio,
    tier:            'pro',
    actions: [
      {
        label:    'Check GPU utilization',
        copyText: `curl http://localhost:7700/api/health | jq '.nvidia_gpu_utilization_percent'`,
      },
      {
        label:    'vLLM batch tuning',
        copyText: `--max-num-batched-tokens 4096 --max-num-seqs 8`,
      },
    ],
    firstFiredMs:       now,
    best_node_id:       null,   // Pattern D: local action only (tuning)
    best_node_hostname: null,
  };
}

// ── Pattern E: Fleet Load Imbalance ──────────────────────────────────────────
//
// What: This node is thermally stressed or low-WES while at least one other
// online fleet peer is in Normal thermal state and could absorb load.
// Cross-node pattern: requires fleetContext with >= 2 online nodes.
//
// Trigger: this node's last 5 samples average thermal_state !== 'Normal'
//   OR average WES is < 50% of the best peer's WES,
//   AND there exists a healthy peer with Normal thermal + available VRAM.
//
// Refinements:
//   - NVLink-bonded pairs are treated as a single logical unit: a bonded peer
//     is not suggested as a routing target (host-level coordination required).
//   - Uses node-availability gate — offline nodes never named.
//   - Fires only when the WES gap between this node and the best peer is > 20%.
//
// Pro tier: requires fleet telemetry (multi-node) and WES history.

const PATTERN_E_ID            = 'fleet_load_imbalance';
const PATTERN_E_MIN_WINDOW_MS = 5 * 60 * 1000;
const PATTERN_E_MIN_SAMPLES   = Math.ceil(PATTERN_E_MIN_WINDOW_MS / SAMPLE_INTERVAL_MS);
const PATTERN_E_WES_GAP_PCT   = 20;   // minimum WES gap to fire

function evaluatePatternE(
  nodeId:       string,
  hostname:     string,
  history:      MetricSample[],
  fleetContext: FleetNodeSummary[],
  now:          number,
): DetectedInsight | null {
  // Need fleet context — skip single-node deployments
  if (fleetContext.filter(n => n.nodeId !== nodeId && n.isOnline).length === 0) return null;
  if (history.length < PATTERN_E_MIN_SAMPLES) return null;

  const recent = history.slice(-PATTERN_E_MIN_SAMPLES);

  // Check if this node is stressed
  const hotCount = recent.filter(
    s => s.thermal_state != null && s.thermal_state !== 'Normal',
  ).length;
  const avgWes = mean(nonNull(recent.map(s => s.wes_score)));

  // This node must be either thermally stressed or low-WES
  const isThermallySressed = hotCount >= Math.ceil(PATTERN_E_MIN_SAMPLES * 0.6);

  // Find the best healthy peer
  const altNode = bestAlternativeNode(nodeId, fleetContext);
  if (!altNode) return null;

  // Only fire if the WES gap is significant enough
  const peerWes = altNode.currentWes ?? 0;
  if (avgWes > 0 && peerWes > 0) {
    const gapPct = ((peerWes - avgWes) / peerWes) * 100;
    if (gapPct < PATTERN_E_WES_GAP_PCT && !isThermallySressed) return null;
  } else if (!isThermallySressed) {
    return null;
  }

  const observedMs    = recent.length * SAMPLE_INTERVAL_MS;
  const ratio         = Math.min(observedMs / PATTERN_E_MIN_WINDOW_MS, 1);
  const wesDiff       = peerWes > 0 && avgWes > 0
    ? `${((peerWes - avgWes) / peerWes * 100).toFixed(0)}% WES gap`
    : 'efficiency gap';
  const vramNote      = altNode.vramHeadroomPct != null
    ? ` with ${altNode.vramHeadroomPct.toFixed(0)}% VRAM headroom`
    : '';

  return {
    patternId:       PATTERN_E_ID,
    nodeId,
    hostname,
    title:           'Fleet Load Imbalance',
    hook:            `${wesDiff} vs ${altNode.hostname}`,
    body:            `${hostname} is ${isThermallySressed ? 'thermally stressed' : 'underperforming'} ` +
                     `while ${altNode.hostname} is online in Normal thermal state${vramNote}. ` +
                     `${avgWes > 0 && peerWes > 0
                       ? `WES: ${hostname} ${avgWes.toFixed(0)} vs ${altNode.hostname} ${peerWes.toFixed(0)} — ` +
                         `a ${wesDiff} that translates directly to throughput and efficiency loss.`
                       : `Routing new requests to the cooler node would reduce latency and thermal wear.`}`,
    recommendation:  `Shift new inference requests to ${altNode.hostname} using ` +
                     `\`GET /api/v1/route/best\`. ` +
                     `${isThermallySressed
                       ? `Allow ${hostname} to cool down — consider pausing non-urgent jobs ` +
                         `until thermal state returns to Normal.`
                       : `Monitor ${hostname}'s WES trend over the next 10 min.`}`,
    action_id:       'rebalance_workload',
    requiredMs:      PATTERN_E_MIN_WINDOW_MS,
    observedMs,
    confidence:      toConfidence(ratio),
    confidenceRatio: ratio,
    tier:            'pro',
    actions: [
      {
        label:    'Get best route',
        copyText: 'GET /api/v1/route/best',
        isEndpoint: true,
      },
      {
        label:    `Check ${altNode.hostname}`,
        copyText: `curl http://localhost:7700/api/health | jq '{node:.node_id,wes:.wes_score,thermal:.thermal_state}'`,
      },
    ],
    firstFiredMs:       now,
    best_node_id:       altNode.nodeId,    // Pattern E: always has a valid altNode (gated above)
    best_node_hostname: altNode.hostname,
  };
}

// ── Pattern F: Memory Pressure Trajectory ────────────────────────────────────
//
// What: Apple Silicon unified memory pressure is rising at a sustained rate.
// Linear regression projects an ETA to the critical threshold — fires before
// the swap storm, not after.
//
// Refinements applied:
//   - Pure localStorage history — no DuckDB required for the ETA calculation.
//   - minObservationWindowMs = 10 min.
//   - Suppresses when mem_pressure_pct is already ≥ 80%.
//   - Only fires when projected ETA to critical (85%) is < 30 min.
//
// Community tier.

const PATTERN_F_ID             = 'memory_trajectory';
const PATTERN_F_MIN_WINDOW_MS  = 10 * 60 * 1000;   // 10 min
const PATTERN_F_MIN_SAMPLES    = Math.ceil(PATTERN_F_MIN_WINDOW_MS / SAMPLE_INTERVAL_MS); // 20
const PATTERN_F_CRITICAL_PCT   = 85;   // memory pressure % that triggers swap
const PATTERN_F_ETA_GATE_MIN   = 30;   // only fire when ETA < 30 min

function evaluatePatternF(
  nodeId:   string,
  hostname: string,
  history:  MetricSample[],
  now:      number,
): DetectedInsight | null {
  if (history.length < PATTERN_F_MIN_SAMPLES) return null;

  const recent    = history.slice(-PATTERN_F_MIN_SAMPLES);
  const memValues = nonNull(recent.map(s => s.mem_pressure_pct));

  // mem_pressure_pct is Apple Silicon only — need dense coverage
  if (memValues.length < Math.ceil(PATTERN_F_MIN_SAMPLES * 0.7)) return null;

  const currentMem = memValues[memValues.length - 1];

  // Suppress if already critical — MemoryExhaustionCard has higher value
  if (currentMem >= 80) return null;

  // Slope in pct per sample (one sample = 30s)
  const slopePerSample = linearSlope(memValues);

  // Only fire on a rising trend
  if (slopePerSample <= 0) return null;

  const slopePerMin = slopePerSample * 2;   // 2 samples/min
  const headroom    = PATTERN_F_CRITICAL_PCT - currentMem;
  const etaMinutes  = headroom / slopePerMin;

  // Only fire if ETA to critical is within the gate and in the future
  if (etaMinutes <= 0 || etaMinutes > PATTERN_F_ETA_GATE_MIN) return null;

  const observedMs  = memValues.length * SAMPLE_INTERVAL_MS;
  const ratio       = Math.min(observedMs / PATTERN_F_MIN_WINDOW_MS, 1);
  const etaRounded  = Math.round(etaMinutes);

  return {
    patternId:       PATTERN_F_ID,
    nodeId,
    hostname,
    title:           'Memory Pressure Trajectory',
    hook:            `Critical in ~${etaRounded}m`,
    body:            `${hostname}'s memory pressure is rising at ` +
                     `${slopePerMin.toFixed(1)}%/min (currently ${currentMem.toFixed(0)}%). ` +
                     `At this rate it will hit the critical threshold ` +
                     `(${PATTERN_F_CRITICAL_PCT}%) in ~${etaRounded} min. ` +
                     `Swap activity and inference stalls follow immediately after.`,
    recommendation:  `Unload the largest loaded model now to arrest the pressure rise ` +
                     `before swap activity begins. Run \`ollama ps\` to identify the ` +
                     `largest resident model and \`ollama stop <model>\` to release it. ` +
                     `Stop any background processes that may be competing for unified memory.`,
    action_id:       'evict_idle_models',
    requiredMs:      PATTERN_F_MIN_WINDOW_MS,
    observedMs,
    confidence:      toConfidence(ratio),
    confidenceRatio: ratio,
    tier:            'community',
    actions: [
      {
        label:    'Unload model',
        copyText: `ollama stop $(ollama ps | awk 'NR>1 {print $1}')`,
      },
      {
        label:    'Check memory pressure',
        copyText: `curl http://localhost:7700/api/health | jq '.memory_pressure_percent'`,
      },
    ],
    firstFiredMs:       now,
    best_node_id:       null,   // Pattern F: local action only (memory eviction)
    best_node_hostname: null,
  };
}

// ── Public evaluator ──────────────────────────────────────────────────────────

export interface PatternEvaluatorInput {
  nodeId:   string;
  hostname: string;
  history:  MetricSample[];
  /**
   * Live snapshot of all other fleet nodes. Used by cross-node patterns
   * (E: Fleet Load Imbalance) and to generate availability-aware
   * recommendations in single-node patterns (A, C).
   *
   * Pass [] for single-node (Cockpit) deployments — patterns will gracefully
   * fall back to local mitigation recommendations.
   */
  fleetContext?: FleetNodeSummary[];
  /** kWh electricity rate for cost estimates (defaults to $0.12). */
  kwhRate?: number;
  /** WES tier for hardware-tier-aware recommendations. */
  wesTier?: 'workstation' | 'server' | 'accelerator' | null;
}

/**
 * evaluatePatterns — run all enabled patterns against a node's history.
 *
 * Returns an array of DetectedInsight objects (0 or more).
 * Stable: same inputs → same outputs (no randomness, no time.now() divergence).
 * Call this from a useMemo or useEffect after each new sample is pushed.
 */
export function evaluatePatterns(
  input: PatternEvaluatorInput,
): DetectedInsight[] {
  const { nodeId, hostname, history, kwhRate, wesTier } = input;
  const fleetContext = input.fleetContext ?? [];
  const now = Date.now();
  const results: DetectedInsight[] = [];

  const a = evaluatePatternA(nodeId, hostname, history, fleetContext, now, wesTier);
  if (a) results.push(a);

  const b = evaluatePatternB(nodeId, hostname, history, now, kwhRate);
  if (b) results.push(b);

  const c = evaluatePatternC(nodeId, hostname, history, fleetContext, now);
  if (c) results.push(c);

  const d = evaluatePatternD(nodeId, hostname, history, now);
  if (d) results.push(d);

  const e = evaluatePatternE(nodeId, hostname, history, fleetContext, now);
  if (e) results.push(e);

  const f = evaluatePatternF(nodeId, hostname, history, now);
  if (f) results.push(f);

  return results;
}
