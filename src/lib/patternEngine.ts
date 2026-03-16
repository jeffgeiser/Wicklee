/**
 * patternEngine.ts — Deterministic time-windowed pattern detection.
 *
 * Principles:
 *  1. No external AI — pure JS arithmetic over localStorage history.
 *  2. Every pattern requires a minObservationWindowMs gate before firing.
 *     This prevents false positives from model-loading spikes or brief hiccups.
 *  3. Each DetectedInsight carries a quantified "so what" (hook) and a
 *     specific operator action — not just "something looks wrong".
 *  4. Patterns are tier-gated: 'community' fires for everyone, 'pro'/'team'
 *     require paid tiers.
 *  5. Patterns expose a `confidence` 0–1 and `observedMs` / `requiredMs`
 *     so the UI can render a "Building..." progress bar before the pattern
 *     has enough evidence to be called High Confidence.
 */

import type { MetricSample } from '../hooks/useMetricHistory';
import { SAMPLE_INTERVAL_MS } from '../hooks/useMetricHistory';

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
   * The "Quantified Hook" — the $-or-metric number shown prominently in the card header.
   * E.g. "-$1.47/day", "-4.2 tok/s", "23% WES loss"
   */
  hook: string;
  /** One-paragraph explanation of what was observed and why it matters. */
  body: string;
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

// ── Pattern A: Thermal Performance Drain ─────────────────────────────────────
//
// What: Node is sustaining an elevated thermal penalty, measurably reducing
// tok/s vs. its own "Normal" baseline.
//
// Refinement applied:
//   - Baseline WES drawn from samples where thermal_state === 'Normal' only.
//     This makes the delta meaningful (not "hot vs. slightly less hot").
//   - minObservationWindowMs = 5 minutes.
//
// Community tier: fires for all users.

const PATTERN_A_ID             = 'thermal_drain';
const PATTERN_A_MIN_WINDOW_MS  = 5 * 60 * 1000;   // 5 min
const PATTERN_A_MIN_SAMPLES    = Math.ceil(PATTERN_A_MIN_WINDOW_MS / SAMPLE_INTERVAL_MS); // 10

function evaluatePatternA(
  nodeId: string,
  hostname: string,
  history: MetricSample[],
  now: number,
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
                     `${lostThroughput > 0 ? `That's ~${lostThroughput.toFixed(0)} fewer completions/hr.` : ''}` +
                     ` Consider improving airflow or routing new requests to a cooler node.`,
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
    firstFiredMs: now,
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
  nodeId: string,
  hostname: string,
  history: MetricSample[],
  now: number,
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

  return {
    patternId:       PATTERN_B_ID,
    nodeId,
    hostname,
    title:           'Phantom Load',
    hook:            `-$${costPerDay.toFixed(2)}/day`,
    body:            `${hostname} is drawing ${avgWatts.toFixed(0)}W with ` +
                     `${(avgVramMb / 1024).toFixed(1)} GB VRAM allocated but no inference ` +
                     `activity for ${Math.round(observedMs / 60000)} min. ` +
                     `A model is loaded and holding resources without serving requests. ` +
                     `At $${kwhRate}/kWh this costs ~$${costPerDay.toFixed(2)}/day. ` +
                     `Unload the idle model to reclaim VRAM and reduce power draw.`,
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
    firstFiredMs: now,
  };
}

// ── Public evaluator ──────────────────────────────────────────────────────────

export interface PatternEvaluatorInput {
  nodeId:   string;
  hostname: string;
  history:  MetricSample[];
  /** kWh electricity rate for cost estimates (defaults to $0.12). */
  kwhRate?: number;
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
  const { nodeId, hostname, history, kwhRate } = input;
  const now = Date.now();
  const results: DetectedInsight[] = [];

  const a = evaluatePatternA(nodeId, hostname, history, now);
  if (a) results.push(a);

  const b = evaluatePatternB(nodeId, hostname, history, now, kwhRate);
  if (b) results.push(b);

  return results;
}
