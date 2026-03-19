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
  | 'schedule_offpeak'     // defer workload to off-peak window
  | 'switch_quantization'  // reduce model precision to lower memory bandwidth demand
  | 'check_power_limits';  // lift BIOS/driver/OS power cap constraining clock speed

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
   * Step-by-step resolution instructions, ordered by recommended execution
   * sequence.  Each entry is a complete standalone instruction (command,
   * config change, or physical action) that the operator can act on immediately.
   *
   * Rendered as a numbered list in the UI.
   * Exposed in /api/v1/insights/latest for automation consumers.
   */
  resolution_steps: string[];
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

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg      = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
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
    resolution_steps: [
      `Confirm current thermal state: \`curl http://localhost:7700/api/health | jq .thermal_state\``,
      altNode
        ? `Immediately route new requests to ${altNode.hostname}: \`GET /api/v1/route/best\``
        : `Reduce concurrent inference to relieve thermal load: set \`OLLAMA_NUM_PARALLEL=1\` and restart Ollama`,
      `Improve physical airflow: ensure at least 10 cm clearance on all vents, clean dust filters, and verify fan curves are not capped`,
      `Check ambient temperature — GPU workload performance degrades above 25°C ambient; datacenter target is 18–22°C`,
      `If ${currentState} state persists beyond 15 min, reduce TDP limit: \`sudo powermetrics --samplers gpu_power\` (Apple) or \`sudo nvidia-smi -pl <watt_limit>\` (NVIDIA) to cap below sustain threshold`,
    ],
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
    resolution_steps: [
      `List all loaded models: \`ollama ps\``,
      `Unload the idle model: \`ollama stop $(ollama ps | awk 'NR>1 {print $1}')\``,
      `Confirm VRAM is freed: \`curl http://localhost:7700/api/health | jq '{vram_used:.nvidia_vram_used_mb}'\``,
      `Prevent recurrence: set \`OLLAMA_KEEP_ALIVE=5m\` in your Ollama environment — models auto-unload after 5 min idle`,
      `For tighter control, set per-request keep-alive: add \`"keep_alive": "5m"\` to your \`/api/generate\` request body`,
    ],
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
    resolution_steps: [
      `Monitor WES trajectory every 30 s: \`watch -n 30 "curl -s http://localhost:7700/api/health | jq .wes_score"\``,
      altNode
        ? `Pre-emptively route new requests to ${altNode.hostname} now — don't wait for thermal state change: \`GET /api/v1/route/best\``
        : `Reduce active inference load immediately: lower \`OLLAMA_NUM_PARALLEL\` to 1 to slow the WES decline`,
      `Check if any background processes (backups, updates, builds) started recently and pause them`,
      `If WES drops below 50 within the next 5 min, treat as Pattern A (Thermal Drain) — enact physical cooling steps`,
      `After stabilization, review Wicklee history to correlate the drop with specific request types or model loads`,
    ],
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
    resolution_steps: [
      `Confirm the decoupling: \`curl http://localhost:7700/api/health | jq '{gpu_util:.nvidia_gpu_utilization_percent,cpu_w:.cpu_power_w,tok_s:.ollama_tokens_per_second}'\``,
      `Check how many layers are CPU-offloaded: in Ollama, \`OLLAMA_NUM_GPU\` env var controls GPU layer count — set to max (e.g. 99) to push all layers to GPU`,
      `If model uses Q2_K quantization, switch to Q4_K_M: \`ollama pull <model>:q4_K_M && ollama rm <model>:q2_K\` — Q4_K_M offloads fully and GPU-utilizes better`,
      `For vLLM: increase \`--max-num-seqs\` and \`--max-num-batched-tokens\` to create larger batches that saturate GPU SIMD lanes`,
      `Verify context window is not excessively long — KV cache fills CPU memory when context > VRAM capacity; trim max_tokens in your application`,
    ],
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
    resolution_steps: [
      `Query fleet-wide WES snapshot: \`GET /api/v1/fleet/wes\``,
      `Update your load balancer to send new requests exclusively to ${altNode.hostname} until ${hostname} recovers`,
      `If using Nginx upstream, temporarily set \`weight=0\` for ${hostname} and \`weight=10\` for ${altNode.hostname}`,
      isThermallySressed
        ? `Investigate thermal root cause on ${hostname}: check airflow, dust, and ambient temperature — allow 15 min cooldown before re-enabling`
        : `Monitor ${hostname}'s WES over the next 10 min — if it stabilizes above 60, re-enable in the rotation`,
      `Set up a cron or webhook to auto-rebalance when \`GET /api/v1/route/best\` returns ${hostname} as the top pick again`,
    ],
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
    resolution_steps: [
      `Immediately check which models are loaded: \`ollama ps\` — note memory footprint of each`,
      `Unload the largest or least-recently-used model: \`ollama stop <model-name>\``,
      `Close any memory-heavy background processes: browsers, IDEs, Docker containers sharing unified memory`,
      `Verify pressure is decreasing: \`watch -n 5 "curl -s http://localhost:7700/api/health | jq .memory_pressure_percent"\``,
      `Prevent recurrence: set \`OLLAMA_MAX_LOADED_MODELS=1\` to prevent multiple models loading simultaneously`,
    ],
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

// ── Pattern G: Bandwidth Saturation ──────────────────────────────────────────
//
// What: GPU compute utilization is anomalously LOW despite active inference
// and high memory occupancy. The memory bus is the bottleneck — the GPU cores
// are idle waiting for model weight data to arrive from VRAM, not compute-bound.
//
// The "Model Suitability" insight (Pattern H in design docs): identifies when
// the software weight exceeds the hardware's physical bandwidth ceiling.
//
// This is architecturally distinct from:
//   - Pattern A (Thermal Drain): thermal_state is elevated
//   - Pattern D (Power-GPU Decoupling): CPU-bound or large-context issue
//   - Pattern C (WES Velocity Drop): early-warning declining trend
//
// Trigger (all conditions sustained for 5 min):
//   - gpu_util_pct < 45%          — compute cores are waiting, not working
//   - VRAM pressure > 80%         — NVIDIA; or mem_pressure > 70% on Apple Silicon
//   - tok_s > 0                   — inference IS active (not phantom load)
//   - thermal_state = Normal      — thermal is NOT the root cause
//   - WES drop vs session peak > 35% — confirms real degradation, not baseline variance
//
// Platform: fires on NVIDIA (VRAM data) and Apple Silicon (mem_pressure proxy).
// Tier: pro — requires GPU utilization history.

const PATTERN_G_ID            = 'bandwidth_saturation';
const PATTERN_G_MIN_WINDOW_MS = 5 * 60 * 1000;
const PATTERN_G_MIN_SAMPLES   = Math.ceil(PATTERN_G_MIN_WINDOW_MS / SAMPLE_INTERVAL_MS); // 10
const PATTERN_G_GPU_LOW_PCT   = 45;   // below this = memory-bound, not compute-bound
const PATTERN_G_VRAM_HIGH_PCT = 80;   // VRAM occupancy threshold (NVIDIA)
const PATTERN_G_MEM_HIGH_PCT  = 70;   // unified memory pressure proxy (Apple Silicon)
const PATTERN_G_WES_DROP_PCT  = 35;   // minimum drop from session peak to fire

function evaluatePatternG(
  nodeId:       string,
  hostname:     string,
  history:      MetricSample[],
  fleetContext: FleetNodeSummary[],
  now:          number,
): DetectedInsight | null {
  if (history.length < PATTERN_G_MIN_SAMPLES) return null;

  const recent = history.slice(-PATTERN_G_MIN_SAMPLES);

  // Must have gpu_util_pct data — meaningless without it
  const gpuSamples = recent.filter(s => s.gpu_util_pct != null);
  if (gpuSamples.length < Math.ceil(PATTERN_G_MIN_SAMPLES * 0.7)) return null;

  const avgGpuUtil = mean(nonNull(recent.map(s => s.gpu_util_pct)));
  const avgTokS    = mean(nonNull(recent.map(s => s.tok_s)));

  // Inference must be actively producing tokens
  if (avgTokS < 0.5) return null;

  // GPU compute must be low — the cores are waiting, not working
  if (avgGpuUtil >= PATTERN_G_GPU_LOW_PCT) return null;

  // Thermals must be Normal — this is not a thermal issue
  const hotSamples = recent.filter(
    s => s.thermal_state != null && s.thermal_state !== 'Normal',
  );
  if (hotSamples.length > Math.ceil(PATTERN_G_MIN_SAMPLES * 0.3)) return null;

  // Memory pressure: VRAM path (NVIDIA) or unified memory path (Apple Silicon)
  const vramSamples = recent.filter(
    s => s.vram_used_mb != null && s.vram_total_mb != null && s.vram_total_mb! > 0,
  );
  let memPressureOk = false;
  let vramPctDisplay = 0;
  let memLabel = 'VRAM';

  if (vramSamples.length >= Math.ceil(PATTERN_G_MIN_SAMPLES * 0.5)) {
    // NVIDIA path — use VRAM pressure
    const avgVramPct = mean(
      vramSamples.map(s => (s.vram_used_mb! / s.vram_total_mb!) * 100),
    );
    if (avgVramPct >= PATTERN_G_VRAM_HIGH_PCT) {
      memPressureOk  = true;
      vramPctDisplay = avgVramPct;
      memLabel       = 'VRAM';
    }
  } else {
    // Apple Silicon path — use memory pressure as proxy
    const memPressureSamples = nonNull(recent.map(s => s.mem_pressure_pct));
    if (memPressureSamples.length >= Math.ceil(PATTERN_G_MIN_SAMPLES * 0.5)) {
      const avgMemPressure = mean(memPressureSamples);
      if (avgMemPressure >= PATTERN_G_MEM_HIGH_PCT) {
        memPressureOk  = true;
        vramPctDisplay = avgMemPressure;
        memLabel       = 'memory';
      }
    }
  }

  if (!memPressureOk) return null;

  // WES drop: compare recent average vs session-peak WES
  const allWesValues    = nonNull(history.map(s => s.wes_score));
  const recentWesValues = nonNull(recent.map(s => s.wes_score));

  if (allWesValues.length < 5) return null;
  if (recentWesValues.length < Math.ceil(PATTERN_G_MIN_SAMPLES * 0.5)) return null;

  const peakWes   = Math.max(...allWesValues);
  const recentWes = mean(recentWesValues);
  const wesDrop   = peakWes > 0 ? ((peakWes - recentWes) / peakWes) * 100 : 0;

  // Require a minimum drop to confirm real degradation vs variance
  if (wesDrop < PATTERN_G_WES_DROP_PCT) return null;

  const observedMs = recent.length * SAMPLE_INTERVAL_MS;
  const ratio      = Math.min(observedMs / PATTERN_G_MIN_WINDOW_MS, 1);

  // Node-availability gate for rerouting recommendation
  const altNode = bestAlternativeNode(nodeId, fleetContext);

  const quantNote =
    `Reduce quantization (e.g. Q8 → Q4) to cut ${memLabel} bandwidth demand by ~50%, ` +
    `or switch to a lower parameter count model to recover throughput.`;

  let recommendation: string;
  let action_id: ActionId;

  if (altNode) {
    recommendation =
      `Shift active inference to ${altNode.hostname} ` +
      `(WES ${altNode.currentWes?.toFixed(0) ?? '?'}) while ${hostname} is ${memLabel}-bus bound. ` +
      quantNote;
    action_id = 'rebalance_workload';
  } else {
    recommendation =
      quantNote +
      ` On the hardware side, a higher-bandwidth node (H100 SXM5, M4 Ultra) would ` +
      `increase ${memLabel} throughput and recover the WES gap.`;
    action_id = 'switch_quantization';
  }

  return {
    patternId:       PATTERN_G_ID,
    nodeId,
    hostname,
    title:           'Bandwidth Saturation',
    hook:            `${avgGpuUtil.toFixed(0)}% GPU · ${vramPctDisplay.toFixed(0)}% ${memLabel} · −${wesDrop.toFixed(0)}% WES`,
    body:            `${hostname} is generating ${avgTokS.toFixed(1)} tok/s at only ` +
                     `${avgGpuUtil.toFixed(0)}% GPU utilization with ${vramPctDisplay.toFixed(0)}% ${memLabel} ` +
                     `occupied (${Math.round(observedMs / 60000)} min window). ` +
                     `Thermals are Normal — the GPU cores are idle waiting for model weight ` +
                     `data from ${memLabel}, not blocked by compute or temperature. ` +
                     `WES has dropped ${wesDrop.toFixed(0)}% from its session peak ` +
                     `(${recentWes.toFixed(0)} vs ${peakWes.toFixed(0)}). ` +
                     `This is the ${memLabel} bandwidth ceiling: model weights saturate ` +
                     `the bus faster than the GPU can consume them.`,
    recommendation,
    resolution_steps: [
      `Confirm the bottleneck: \`curl http://localhost:7700/api/health | jq '{gpu_util:.nvidia_gpu_utilization_percent,vram_used:.nvidia_vram_used_mb,vram_total:.nvidia_vram_total_mb}'\` — expect low GPU util, high VRAM fill`,
      `Switch the active model to a lower quantization to halve ${memLabel} bandwidth demand: \`ollama pull <model>:q4_K_M && ollama stop <model>:q8_0\``,
      `If already on Q4, try Q3_K_M or Q2_K — the quality trade-off is worth the bandwidth recovery when the bus is saturated`,
      altNode
        ? `Route concurrent inference to ${altNode.hostname} while ${hostname} is ${memLabel}-bound — it has available bandwidth headroom`
        : `Consider a hardware upgrade to a node with higher ${memLabel} bandwidth (H100 SXM5: 3.35 TB/s vs PCIe: 2 TB/s) for sustained bandwidth ceiling relief`,
      `Reduce context window size in your requests — longer contexts increase KV cache weight streaming; halving context can free 20–40% bandwidth`,
    ],
    action_id,
    requiredMs:      PATTERN_G_MIN_WINDOW_MS,
    observedMs,
    confidence:      toConfidence(ratio),
    confidenceRatio: ratio,
    tier:            'pro',
    actions: [
      {
        label:    `Check GPU util vs ${memLabel}`,
        copyText: `curl http://localhost:7700/api/health | jq '{gpu_util:.nvidia_gpu_utilization_percent,vram_used:.nvidia_vram_used_mb,vram_total:.nvidia_vram_total_mb}'`,
      },
      {
        label:    'Pull Q4 variant',
        copyText: `ollama pull $(ollama list | awk 'NR>1{print $1}' | head -1 | sed 's|:.*|:q4_K_M|')`,
      },
    ],
    firstFiredMs:       now,
    best_node_id:       altNode?.nodeId       ?? null,
    best_node_hostname: altNode?.hostname      ?? null,
  };
}

// ── Pattern H: Power Jitter ───────────────────────────────────────────────────
//
// What: Power draw is highly variable across inference windows — the coefficient
// of variation (stddev / mean) of watts exceeds 20% sustained for 5 minutes.
//
// Two root causes surfaced by the same metric:
//   1. Thundering Herd: the load balancer delivers requests in bursts, so the
//      GPU cycles between full saturation and near-idle. Identified when tok/s
//      variance is also elevated. Fix: smooth dispatch / reduce batch size.
//   2. PSU / VRM Stress: at sustained high power, voltage ripple under dynamic
//      load is a leading indicator of power supply degradation. PSUs and VRMs
//      wear faster when the load swings sharply than under constant draw.
//
// Differentiator vs vLLM / Ollama built-in metrics:
//   Standard tools track average power. Only Wicklee tracks "cleanliness"
//   of power — the standard deviation over inference windows.
//
// Note: uses 30s MetricSample history (not raw 1 Hz). Captures inter-window
// variance (batch-level load swings), not intra-window spikes. Still a strong
// signal — a GPU cycling in 30-second on/off pulses is actively stressing the PSU.
//
// Trigger (sustained 5 min):
//   - mean(watts) > 30W              — meaningful inference load, not idle drift
//   - tok_s > 0                      — inference is active
//   - stddev(watts) / mean(watts) > 0.20 — coefficient of variation
//
// Community tier: hardware-agnostic, zero-privilege, immediately actionable.

const PATTERN_H_ID            = 'power_jitter';
const PATTERN_H_MIN_WINDOW_MS = 5 * 60 * 1000;
const PATTERN_H_MIN_SAMPLES   = Math.ceil(PATTERN_H_MIN_WINDOW_MS / SAMPLE_INTERVAL_MS); // 10
const PATTERN_H_MIN_WATTS     = 30;    // below this = idle variance, not inference stress
const PATTERN_H_COV_THRESHOLD = 0.20;  // coefficient of variation threshold

function evaluatePatternH(
  nodeId:   string,
  hostname: string,
  history:  MetricSample[],
  now:      number,
): DetectedInsight | null {
  if (history.length < PATTERN_H_MIN_SAMPLES) return null;

  const recent = history.slice(-PATTERN_H_MIN_SAMPLES);

  // Need dense watts coverage
  const wattsSamples = nonNull(recent.map(s => s.watts));
  if (wattsSamples.length < Math.ceil(PATTERN_H_MIN_SAMPLES * 0.7)) return null;

  const avgWatts = mean(wattsSamples);
  if (avgWatts < PATTERN_H_MIN_WATTS) return null;

  // Inference must be producing tokens — not idle variance
  const tokSSamples = nonNull(recent.map(s => s.tok_s));
  const avgTokS     = tokSSamples.length > 0 ? mean(tokSSamples) : 0;
  if (avgTokS < 0.5) return null;

  // Core condition: high coefficient of variation in power
  const sd  = stddev(wattsSamples);
  const cov = sd / avgWatts;
  if (cov < PATTERN_H_COV_THRESHOLD) return null;

  const observedMs = recent.length * SAMPLE_INTERVAL_MS;
  const ratio      = Math.min(observedMs / PATTERN_H_MIN_WINDOW_MS, 1);

  // Thundering herd indicator: tok/s variance elevated alongside power variance
  const tokSCov          = tokSSamples.length >= 3 ? stddev(tokSSamples) / (mean(tokSSamples) || 1) : 0;
  const isThunderingHerd = tokSCov > 0.25;

  const recommendation = isThunderingHerd
    ? `Power variance (${(cov * 100).toFixed(0)}% CoV) is coupled with throughput variance — ` +
      `consistent with thundering herd load. Reduce concurrent request batch size or introduce ` +
      `a request queue with smoothed dispatch to stabilize power draw and reduce PSU/VRM stress.`
    : `Power draw variance (${(cov * 100).toFixed(0)}% CoV at ${avgWatts.toFixed(0)}W average) ` +
      `indicates the GPU is cycling between saturation and near-idle. Check load balancer dispatch ` +
      `pattern for bursty traffic. At ${avgWatts.toFixed(0)}W average, sustained dynamic load ` +
      `swing accelerates PSU/VRM wear — verify supply headroom if this persists.`;

  return {
    patternId:       PATTERN_H_ID,
    nodeId,
    hostname,
    title:           'Power Jitter',
    hook:            `±${sd.toFixed(0)}W · ${(cov * 100).toFixed(0)}% CoV${isThunderingHerd ? ' · thundering herd' : ''}`,
    body:            `${hostname}'s power draw has a ${(cov * 100).toFixed(0)}% coefficient of ` +
                     `variation (±${sd.toFixed(0)}W around ${avgWatts.toFixed(0)}W average) over ` +
                     `the last ${Math.round(observedMs / 60000)} min. ` +
                     `${isThunderingHerd
                       ? 'Throughput variance is also elevated — the GPU is cycling between ' +
                         'full saturation and near-idle in sync with bursty request batches. '
                       : ''}` +
                     `Stable inference has predictable power draw. High variance is a leading ` +
                     `indicator of PSU/VRM stress — power supplies degrade faster under dynamic ` +
                     `load swings than under constant draw, even at the same average wattage.`,
    recommendation,
    resolution_steps: isThunderingHerd ? [
      `Confirm bursty dispatch: check your load balancer or client request pattern — are requests arriving in synchronized waves?`,
      `Add a request queue (Redis, BullMQ, or similar) with FIFO dispatch to smooth bursty traffic into uniform batches`,
      `Reduce \`OLLAMA_NUM_PARALLEL\` to 1–2 to prevent the GPU from context-switching between too many concurrent requests`,
      `Implement exponential backoff with jitter on the client side to desynchronize concurrent callers`,
      `Monitor power CoV after the change: target < 15% CoV to confirm the fix worked`,
    ] : [
      `Verify current power headroom: check PSU rated wattage vs peak draw — PSU should have ≥20% headroom above peak`,
      `Check VRM/motherboard temperatures if sensors available — sustained VRM temps >85°C under dynamic load require active cooling`,
      `Reduce inference concurrency to lower peak-to-trough swing: set \`OLLAMA_NUM_PARALLEL=1\``,
      `Check for bursty workload patterns in your application — add client-side request smoothing if requests arrive in synchronized batches`,
      `If power jitter persists at steady load, consider PSU capacity upgrade or dedicated GPU power supply for high-wattage GPUs (>300W TDP)`,
    ],
    action_id:       'reduce_batch_size',
    requiredMs:      PATTERN_H_MIN_WINDOW_MS,
    observedMs,
    confidence:      toConfidence(ratio),
    confidenceRatio: ratio,
    tier:            'community',
    actions: [
      {
        label:    'Check live power draw',
        copyText: `curl http://localhost:7700/api/health | jq '{cpu_w:.cpu_power_w,nvidia_w:.nvidia_power_draw_w}'`,
      },
      {
        label:    'Check loaded models',
        copyText: `curl http://localhost:11434/api/ps | jq '.models[] | {model:.name,size_vram:.size_vram}'`,
      },
    ],
    firstFiredMs:       now,
    best_node_id:       null,    // Pattern H: local action — load smoothing, no rerouting
    best_node_hostname: null,
  };
}

// ── Pattern I: Efficiency Penalty Drag ────────────────────────────────────────
//
// What: The WES penalty_avg field measures the fraction of peak efficiency being
// lost to software-level overhead (context length, batch saturation, tokeniser
// overhead, KV cache fragmentation, etc.) even when thermals are Normal and GPU
// is active.  When this penalty persists at > 30% for 5+ minutes with NO thermal
// or memory cause, the root is almost always workload configuration — not hardware.
//
// This pattern is unique in exploiting penalty_avg: none of A–H uses it directly.
// It catches the "invisible tax" class of performance losses:
//   - Context windows larger than the model's efficient attention range
//   - Batch sizes too small to saturate the GPU's SIMD pipeline
//   - KV cache fragmentation from mixed-length concurrent requests
//   - MoE models with expert routing overhead on single-GPU setups
//
// Trigger (sustained 5 min):
//   - penalty_avg > 0.30            — > 30% of WES being eaten by penalty
//   - thermal_state === 'Normal'    — not a thermal issue
//   - gpu_util_pct > 30%            — GPU is active (not idle or decoupled)
//   - tok_s > 0                     — inference is running
//   - mem_pressure_pct < 75% AND vram headroom > 20% — not memory-bound
//
// Pro tier: requires understanding of WES internals.

const PATTERN_I_ID             = 'efficiency_drag';
const PATTERN_I_MIN_WINDOW_MS  = 5 * 60 * 1000;
const PATTERN_I_MIN_SAMPLES    = Math.ceil(PATTERN_I_MIN_WINDOW_MS / SAMPLE_INTERVAL_MS); // 10
const PATTERN_I_PENALTY_THRESH = 0.30;   // 30% penalty_avg threshold
const PATTERN_I_MIN_GPU_UTIL   = 30;     // GPU must be working (not decoupled)
const PATTERN_I_MEM_SAFE_PCT   = 75;     // memory pressure must be below this
const PATTERN_I_VRAM_SAFE_PCT  = 80;     // VRAM utilisation must be below this

function evaluatePatternI(
  nodeId:   string,
  hostname: string,
  history:  MetricSample[],
  now:      number,
): DetectedInsight | null {
  if (history.length < PATTERN_I_MIN_SAMPLES) return null;

  const recent = history.slice(-PATTERN_I_MIN_SAMPLES);

  // Requires dense penalty_avg coverage — metric only present in WES v2+ agents
  const penaltySamples = nonNull(recent.map(s => s.penalty_avg));
  if (penaltySamples.length < Math.ceil(PATTERN_I_MIN_SAMPLES * 0.7)) return null;

  const avgPenalty = mean(penaltySamples);
  if (avgPenalty < PATTERN_I_PENALTY_THRESH) return null;

  // Inference must be active
  const tokSSamples = nonNull(recent.map(s => s.tok_s));
  const avgTokS     = tokSSamples.length > 0 ? mean(tokSSamples) : 0;
  if (avgTokS < 0.5) return null;

  // Thermals must be Normal — not a thermal penalty
  const hotSamples = recent.filter(
    s => s.thermal_state != null && s.thermal_state !== 'Normal',
  );
  if (hotSamples.length > Math.ceil(PATTERN_I_MIN_SAMPLES * 0.3)) return null;

  // GPU must be working — not Pattern D (decoupled)
  const gpuSamples = nonNull(recent.map(s => s.gpu_util_pct));
  if (gpuSamples.length >= Math.ceil(PATTERN_I_MIN_SAMPLES * 0.5)) {
    const avgGpu = mean(gpuSamples);
    if (avgGpu < PATTERN_I_MIN_GPU_UTIL) return null;  // Pattern D territory
  }

  // Not memory-bound — not Pattern F or G
  const memPressure = nonNull(recent.map(s => s.mem_pressure_pct));
  if (memPressure.length > 0 && mean(memPressure) >= PATTERN_I_MEM_SAFE_PCT) return null;

  const vramSamples = recent.filter(s => s.vram_used_mb != null && s.vram_total_mb != null && s.vram_total_mb! > 0);
  if (vramSamples.length >= Math.ceil(PATTERN_I_MIN_SAMPLES * 0.5)) {
    const avgVramPct = mean(vramSamples.map(s => (s.vram_used_mb! / s.vram_total_mb!) * 100));
    if (avgVramPct >= PATTERN_I_VRAM_SAFE_PCT) return null;  // Pattern G territory
  }

  const penaltyPct   = (avgPenalty * 100).toFixed(0);
  const observedMs   = recent.length * SAMPLE_INTERVAL_MS;
  const ratio        = Math.min(observedMs / PATTERN_I_MIN_WINDOW_MS, 1);

  // WES impact: if we had no penalty, WES would be higher
  const recentWes     = nonNull(recent.map(s => s.wes_score));
  const avgWes        = recentWes.length > 0 ? mean(recentWes) : null;
  const impliedMaxWes = avgWes != null ? (avgWes / (1 - avgPenalty)).toFixed(0) : null;

  return {
    patternId:       PATTERN_I_ID,
    nodeId,
    hostname,
    title:           'Efficiency Penalty Drag',
    hook:            `${penaltyPct}% WES penalty · ${avgTokS.toFixed(1)} tok/s headroom being lost`,
    body:            `${hostname} is sustaining a ${penaltyPct}% WES efficiency penalty over the ` +
                     `last ${Math.round(observedMs / 60000)} min despite Normal thermals, ` +
                     `active GPU utilization, and no memory saturation. ` +
                     `The WES penalty_avg field captures overhead not caused by heat or bandwidth — ` +
                     `context window size, batch fragmentation, KV cache pressure, or expert routing ` +
                     `overhead in MoE models. ` +
                     `${impliedMaxWes != null && avgWes != null
                       ? `Without this penalty, WES would be ~${impliedMaxWes} (current: ${avgWes.toFixed(0)}).`
                       : ''}`,
    recommendation:  `This penalty is recoverable through workload configuration. ` +
                     `Reduce maximum context window in your application to the shortest that meets quality needs, ` +
                     `and increase batch concurrency slightly to better saturate the GPU pipeline. ` +
                     `If using a MoE model (e.g. Mixtral), ensure all experts are VRAM-resident.`,
    resolution_steps: [
      `Check current penalty value: \`curl http://localhost:7700/api/health | jq .penalty_avg\` — confirm it's consistently above 0.30`,
      `Reduce context window: in your application, lower \`max_tokens\` or \`num_ctx\` to 2048–4096; most inference use-cases don't need 8k+`,
      `Increase batch size slightly: set \`OLLAMA_NUM_PARALLEL=2\` (or 4 if VRAM allows) — more concurrent requests help fill GPU pipeline bubbles`,
      `If running a MoE model (Mixtral, Qwen-MoE): verify all expert weights are VRAM-resident with \`ollama ps\`; add \`--num-gpu 99\` flag`,
      `For vLLM: enable \`--enable-chunked-prefill\` and tune \`--max-num-batched-tokens\` to reduce KV cache fragmentation from variable-length requests`,
    ],
    action_id:       'reduce_batch_size',
    requiredMs:      PATTERN_I_MIN_WINDOW_MS,
    observedMs,
    confidence:      toConfidence(ratio),
    confidenceRatio: ratio,
    tier:            'pro',
    actions: [
      {
        label:    'Check penalty_avg',
        copyText: `curl http://localhost:7700/api/health | jq '{penalty:.penalty_avg,wes:.wes_score,tok_s:.ollama_tokens_per_second}'`,
      },
      {
        label:    'Tune Ollama context',
        copyText: `OLLAMA_NUM_CTX=2048 OLLAMA_NUM_PARALLEL=2 ollama serve`,
      },
    ],
    firstFiredMs:       now,
    best_node_id:       null,   // Pattern I: local config action only
    best_node_hostname: null,
  };
}

// ── Pattern J: Swap I/O Pressure ─────────────────────────────────────────────
//
// What: Sustained swap-write activity during active inference confirms the node
// is paging model weights or KV cache to disk — the worst-case latency spike
// outside of thermal throttling.  Pattern F (Memory Pressure Trajectory)
// PREDICTS this is coming; Pattern J CONFIRMS it is happening right now.
//
// Unlike Pattern F (pure Apple Silicon / unified memory), Pattern J fires on
// any platform where the agent provides swap_write_mb_s — Linux and macOS.
//
// Trigger (all conditions sustained for 5 min):
//   - swap_write_mb_s > 2.0   — active swap write activity
//   - tok_s > 0               — inference is running while swapping
//
// Tier: community — visible to all users. No complex metric required.

const PATTERN_J_ID             = 'swap_io_pressure';
const PATTERN_J_MIN_WINDOW_MS  = 5 * 60 * 1000;
const PATTERN_J_MIN_SAMPLES    = Math.ceil(PATTERN_J_MIN_WINDOW_MS / SAMPLE_INTERVAL_MS); // 10
const PATTERN_J_SWAP_THRESH    = 2.0;   // MB/s — minimum to fire
const PATTERN_J_STORM_THRESH   = 10.0;  // MB/s — "swap storm" escalation level

function evaluatePatternJ(
  nodeId:   string,
  hostname: string,
  history:  MetricSample[],
  now:      number,
): DetectedInsight | null {
  if (history.length < PATTERN_J_MIN_SAMPLES) return null;

  const recent = history.slice(-PATTERN_J_MIN_SAMPLES);

  // Requires swap_write_mb_s data — only present on Linux / macOS agents v0.4.4+
  const swapSamples = nonNull(recent.map(s => s.swap_write_mb_s));
  if (swapSamples.length < Math.ceil(PATTERN_J_MIN_SAMPLES * 0.7)) return null;

  const avgSwapMbs = mean(swapSamples);
  if (avgSwapMbs < PATTERN_J_SWAP_THRESH) return null;

  // Inference must be active during the swap storm
  const tokSSamples = nonNull(recent.map(s => s.tok_s));
  const avgTokS     = tokSSamples.length > 0 ? mean(tokSSamples) : 0;
  if (avgTokS < 0.5) return null;

  const isStorm    = avgSwapMbs >= PATTERN_J_STORM_THRESH;
  const swapLabel  = avgSwapMbs.toFixed(1);
  const observedMs = recent.length * SAMPLE_INTERVAL_MS;
  const ratio      = Math.min(observedMs / PATTERN_J_MIN_WINDOW_MS, 1);

  return {
    patternId:       PATTERN_J_ID,
    nodeId,
    hostname,
    title:           isStorm ? 'Swap Storm During Inference' : 'Swap I/O During Inference',
    hook:            `${swapLabel} MB/s swap write · ${avgTokS.toFixed(1)} tok/s degraded`,
    body:            `${hostname} is writing ${swapLabel} MB/s to swap while inference is active. ` +
                     `The OS is evicting memory to disk — model weights, KV cache, or activation ` +
                     `buffers are competing for RAM and losing. This causes severe inference stalls ` +
                     `(multi-second first-token latency) as the model layer data is paged back in on demand. ` +
                     `${isStorm
                       ? `At ${swapLabel} MB/s this is a full swap storm — inference throughput is severely compromised.`
                       : `Even at moderate swap rates, inference latency spikes are typically 5–20× above baseline.`}`,
    recommendation:  `Immediately unload the largest loaded model to relieve memory pressure and stop the swap cycle. ` +
                     `Run \`ollama ps\` to identify all resident models; unload any that are not actively serving requests. ` +
                     `If all models are in use, route new requests to a fleet node with available memory headroom.`,
    resolution_steps: [
      `Immediately check swap activity: \`cat /proc/vmstat | grep pswpout\` (Linux) or \`vm_stat | grep Swapouts\` (macOS) — confirm it's rising`,
      `List all loaded models and their VRAM/RAM footprint: \`ollama ps\` — identify the largest or least-recently-used model`,
      `Unload the largest idle model: \`ollama stop <model-name>\` — this should arrest the swap writes within 10–30 seconds`,
      `Verify swap activity drops: \`watch -n 3 "curl -s http://localhost:7700/api/health | jq .swap_write_mb_s"\``,
      `Prevent recurrence: set \`OLLAMA_MAX_LOADED_MODELS=1\` and consider adding RAM or routing large-context requests to a node with more memory`,
    ],
    action_id:       'evict_idle_models',
    requiredMs:      PATTERN_J_MIN_WINDOW_MS,
    observedMs,
    confidence:      toConfidence(ratio),
    confidenceRatio: ratio,
    tier:            'community',
    actions: [
      {
        label:    'Unload idle model',
        copyText: `ollama stop $(ollama ps | awk 'NR>1 {print $1}' | head -1)`,
      },
      {
        label:    'Check swap rate',
        copyText: `curl http://localhost:7700/api/health | jq .swap_write_mb_s`,
      },
    ],
    firstFiredMs:       now,
    best_node_id:       null,   // Pattern J: local action — evict model to stop swap
    best_node_hostname: null,
  };
}

// ── Pattern K: Clock Drift ────────────────────────────────────────────────────
//
// What: CPU/GPU clock is throttled below rated speed despite Normal thermal state.
// This is "silent" throttling caused by power limits, BIOS frequency caps, or
// driver-imposed clock floors — not heat. Pattern A fires when the machine is
// hot; Pattern K fires when thermals look fine but the silicon is still running
// below spec.
//
// Why it matters: inference throughput is almost linear with clock speed at
// the compute-bound phase. A 20% clock reduction → ~20% fewer tok/s with no
// other visible warning in the dashboard. Operators typically blame the model
// or network when the real cause is a misconfigured TDP cap or a BIOS
// power-saving policy left on a workstation-class build.
//
// Trigger (all conditions sustained for 5 min):
//   - clock_throttle_pct > 15%   — running below 85% of rated max clock
//   - tok_s > 0                   — inference is active during the throttle
//   - thermal_state === 'Normal'  — not explained by heat (avoids double-fire with A)
//
// Source: AMD: scaling_cur_freq / cpuinfo_max_freq.
//         NVIDIA: nvmlDeviceGetClockInfo(Graphics) / nvmlDeviceGetMaxClockInfo(Graphics).
// Inverse: 0% = full speed, 100% = fully throttled (higher = worse).
//
// Tier: community — clock_throttle_pct is collected on all platforms v0.4.30+.

const PATTERN_K_ID            = 'clock_drift';
const PATTERN_K_MIN_WINDOW_MS = 5 * 60 * 1000;
const PATTERN_K_MIN_SAMPLES   = Math.ceil(PATTERN_K_MIN_WINDOW_MS / SAMPLE_INTERVAL_MS); // 10
const PATTERN_K_THROTTLE_SOFT = 15;   // % — warning threshold
const PATTERN_K_THROTTLE_HARD = 35;   // % — severe escalation

function evaluatePatternK(
  nodeId:   string,
  hostname: string,
  history:  MetricSample[],
  now:      number,
): DetectedInsight | null {
  if (history.length < PATTERN_K_MIN_SAMPLES) return null;

  const recent = history.slice(-PATTERN_K_MIN_SAMPLES);

  // clock_throttle_pct only present on agents >= v0.4.30
  const clockSamples = nonNull(recent.map(s => s.clock_throttle_pct));
  if (clockSamples.length < Math.ceil(PATTERN_K_MIN_SAMPLES * 0.7)) return null;

  const avgThrottle = mean(clockSamples);
  if (avgThrottle < PATTERN_K_THROTTLE_SOFT) return null;

  // Inference must be running — idle throttling is expected and harmless
  const tokSSamples = nonNull(recent.map(s => s.tok_s));
  const avgTokS     = tokSSamples.length > 0 ? mean(tokSSamples) : 0;
  if (avgTokS < 0.5) return null;

  // Thermal state must be Normal — Pattern A covers the hot-and-throttled case
  const hotSamples = recent.filter(
    s => s.thermal_state != null && s.thermal_state !== 'Normal',
  );
  if (hotSamples.length > Math.ceil(PATTERN_K_MIN_SAMPLES * 0.3)) return null;

  const isSevere     = avgThrottle >= PATTERN_K_THROTTLE_HARD;
  const throttlePct  = avgThrottle.toFixed(0);
  const speedPct     = (100 - avgThrottle).toFixed(0);
  const observedMs   = recent.length * SAMPLE_INTERVAL_MS;
  const ratio        = Math.min(observedMs / PATTERN_K_MIN_WINDOW_MS, 1);

  // Estimate tok/s headroom: if running at X% speed, full-speed would yield tok/s / (X/100)
  const impliedFullTokS = avgThrottle > 0
    ? (avgTokS / ((100 - avgThrottle) / 100)).toFixed(1)
    : null;

  return {
    patternId:       PATTERN_K_ID,
    nodeId,
    hostname,
    title:           isSevere ? 'Severe Clock Throttle During Inference' : 'Clock Drift During Inference',
    hook:            `${throttlePct}% throttled · running at ${speedPct}% of rated clock · ${avgTokS.toFixed(1)} tok/s`,
    body:            `${hostname} is sustaining ${throttlePct}% clock throttling while inference is active, ` +
                     `despite Normal thermal state. The CPU/GPU is running at ${speedPct}% of its rated ` +
                     `maximum frequency — not because of heat, but due to a power limit, BIOS frequency cap, ` +
                     `or OS power-saving governor. ` +
                     `${impliedFullTokS != null
                       ? `At full clock speed, throughput would be approximately ${impliedFullTokS} tok/s (current: ${avgTokS.toFixed(1)} tok/s).`
                       : `Inference throughput is directly proportional to clock speed — restoring full frequency will recover the lost throughput immediately.`} ` +
                     `${isSevere
                       ? `At ${throttlePct}% throttle this is severe — the hardware is significantly underperforming its specification.`
                       : `Even moderate clock reduction compounds across long inference runs and multi-turn conversations.`}`,
    recommendation:  `Check and lift the power limit or clock cap constraining this node. ` +
                     `On Linux, set the CPU governor to \`performance\` and verify GPU TDP limits in nvidia-smi or rocm-smi. ` +
                     `On Apple Silicon, ensure the system is on AC power with Performance mode enabled in Energy settings.`,
    resolution_steps: [
      `Verify current clock throttle: \`curl http://localhost:7700/api/health | jq .clock_throttle_pct\` — confirm it's consistently above 15%`,
      `Linux CPU governor: \`cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor\` — if it shows \`powersave\`, switch with \`sudo cpupower frequency-set -g performance\``,
      `NVIDIA power limit: \`nvidia-smi -q -d CLOCK | grep -A4 "Clocks Throttle"\` — identify the throttle reason; lift TDP with \`sudo nvidia-smi --power-limit=<tdp_watts>\``,
      `AMD GPU (ROCm): \`rocm-smi --showclkfrq\` — verify GPU clock matches boost clock; check \`--showpowerprofile\` for power-save mode`,
      `Apple Silicon: open System Settings → Battery → Options → set "Limit CPU speed" to Off; ensure plugged into AC power`,
      `BIOS/firmware: check for "Power Limit" or "PROCHOT" settings — on workstation builds these often default to conservative values for quiet cooling`,
    ],
    action_id:       'check_power_limits',
    requiredMs:      PATTERN_K_MIN_WINDOW_MS,
    observedMs,
    confidence:      toConfidence(ratio),
    confidenceRatio: ratio,
    tier:            'community',
    actions: [
      {
        label:    'Check throttle reason (NVIDIA)',
        copyText: `nvidia-smi -q -d CLOCK | grep -A8 "Clocks Throttle Reasons"`,
      },
      {
        label:    'Set performance governor (Linux)',
        copyText: `sudo cpupower frequency-set -g performance && cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor`,
      },
    ],
    firstFiredMs:       now,
    best_node_id:       null,   // Pattern K: local fix — no routing target
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

  const g = evaluatePatternG(nodeId, hostname, history, fleetContext, now);
  if (g) results.push(g);

  const h = evaluatePatternH(nodeId, hostname, history, now);
  if (h) results.push(h);

  const i = evaluatePatternI(nodeId, hostname, history, now);
  if (i) results.push(i);

  const j = evaluatePatternJ(nodeId, hostname, history, now);
  if (j) results.push(j);

  const k = evaluatePatternK(nodeId, hostname, history, now);
  if (k) results.push(k);

  return results;
}
