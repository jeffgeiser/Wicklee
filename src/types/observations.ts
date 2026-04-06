/**
 * observations.ts — Shared type definitions for the observation / insight system.
 *
 * Canonical home for types consumed by:
 *   - AIInsights.tsx (observation rendering)
 *   - useLocalObservations.ts (agent REST → DetectedInsight mapping)
 *   - ObservationCard.tsx / AccordionObservationCard.tsx (card props)
 *   - insightLifecycle.ts (onset/resolved event tracking)
 *
 * Previously lived in patternEngine.ts — extracted here so the types survive
 * deletion of the client-side pattern engine (Phase 7E).
 */

// ── ActionId — machine-readable action classification ─────────────────────────
//
// Stable string keys used by:
//   - GET /api/v1/insights/latest
//   - Automation scripts polling the agent endpoint
//   - Pattern dismissal audit trail
//
// Never rename — these are external API contract values.

export type ActionId =
  | 'evict_idle_models'    // ollama stop / unload VRAM
  | 'reduce_batch_size'    // lower concurrent request batch
  | 'check_thermal_zone'   // physical intervention — airflow / ambient
  | 'investigate_phantom'  // diagnose idle-but-loaded model
  | 'schedule_offpeak'     // defer workload to off-peak window
  | 'switch_quantization'  // reduce model precision to lower memory bandwidth demand
  | 'check_power_limits';  // lift BIOS/driver/OS power cap constraining clock speed

// ── FleetNodeSummary — peer context for cross-node recommendations ─────────────

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
   */
  recommendation: string;
  /**
   * Step-by-step resolution instructions, ordered by recommended execution
   * sequence.  Each entry is a complete standalone instruction.
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
   * Null for patterns that recommend local action.
   */
  best_node_id:       string | null;
  best_node_hostname: string | null;
}
