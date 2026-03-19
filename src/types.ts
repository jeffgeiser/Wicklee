
export interface NodeAgent {
  id: string;
  hostname: string;
  ip: string;
  status: 'online' | 'offline' | 'degraded' | 'unreachable' | 'idle';
  gpuTemp: number | null;
  vramUsed: number | null;
  vramTotal: number | null;
  powerUsage: number | null;
  tdp?: number; // Thermal Design Power in Watts
  requestsPerSecond: number;
  activeInterceptors: string[];
  uptime: string;
  sentinelActive?: boolean;
  restricted?: boolean;
}

// Live telemetry payload — mirrors MetricsPayload in agent/src/main.rs
export interface SentinelMetrics {
  node_id: string;
  hostname?: string;
  /** GPU model name — NVIDIA: nvmlDeviceGetName; Apple: system_profiler chip description */
  gpu_name?: string;
  /** CPU/chip name for non-GPU nodes — Linux: /proc/cpuinfo model name */
  chip_name?: string | null;
  cpu_usage_percent: number;
  total_memory_mb: number;
  used_memory_mb: number;
  available_memory_mb: number;
  cpu_core_count: number;
  timestamp_ms: number;
  // Apple Silicon deep-metal (null when unavailable)
  cpu_power_w:             number | null;
  ecpu_power_w:            number | null;
  pcpu_power_w:            number | null;
  gpu_utilization_percent: number | null;
  memory_pressure_percent: number | null;
  thermal_state:           string | null;
  /**
   * GPU wired memory budget (MB) from `sysctl iogpu.wired_limit_mb`.
   * Apple Silicon only — typically ~75% of physical RAM. Null everywhere else.
   * Use this (not total_memory_mb) as the GPU capacity ceiling on M-series nodes.
   */
  gpu_wired_limit_mb?: number | null;
  // NVIDIA GPU fields (null on non-NVIDIA)
  nvidia_gpu_utilization_percent: number | null;
  nvidia_vram_used_mb:            number | null;
  nvidia_vram_total_mb:           number | null;
  nvidia_gpu_temp_c:              number | null;
  nvidia_power_draw_w:            number | null;
  // ── NVIDIA Accelerator Tier stubs (Phase 5) ──────────────────────────────
  /**
   * True when VRAM and system RAM share a unified pool (GB10 Grace Blackwell).
   * False on all discrete GPU nodes (RTX, H100, B200).
   * Null on Apple Silicon (uses gpu_wired_limit_mb instead).
   */
  vram_is_unified?: boolean | null;
  /**
   * 'active' = fan-cooled. 'passive' = conduction-only (DGX Spark).
   * Pattern A (Thermal Drain) uses a lower trigger threshold on passive nodes —
   * no fan curve means no recovery headroom.
   */
  cooling_type?: 'active' | 'passive' | null;
  /**
   * WES normalization tier. Prevents cross-tier score comparisons from being
   * meaningless. workstation = RTX/M-series, server = EPYC+A-series,
   * accelerator = H100/B200/GB10.
   */
  wes_tier?: 'workstation' | 'server' | 'accelerator' | null;
  /**
   * Number of physical GPUs on this host. >1 = multi-GPU node (DGX H100/B200).
   * Fleet Status groups rows under a host header when gpu_count > 1.
   */
  gpu_count?: number | null;
  /**
   * Shared host identifier for multi-GPU nodes. All GPUs on a DGX report the
   * same host_id. Fleet Status uses this to group sub-GPU rows under one header.
   * Null on single-GPU nodes.
   */
  host_id?: string | null;
  /**
   * NVLink-bonded peer node ID. Set when NVML reports an active NVLink
   * connection to another Wicklee node. Pattern E (Fleet Load Imbalance) skips
   * the independence assumption for bonded pairs. VRAM aggregation treats
   * bonded pairs as a single logical unit, not two independent nodes.
   */
  nvlink_peer_node_id?: string | null;
  /**
   * Inter-node NVLink bandwidth utilization (GB/s). Null on non-NVLink hardware.
   * Populated via nvmlDeviceGetNvLinkUtilizationCounter when nvlink_peer_node_id
   * is set.
   */
  nvlink_bandwidth_gbps?: number | null;
  /**
   * MIG (Multi-Instance GPU) slices active on this node. Present only when the
   * device is MIG-partitioned (Hopper / Blackwell datacenter class). Each slice
   * renders as a virtual sub-row in Fleet Status with independent WES and VRAM.
   */
  mig_instances?: MIGInstance[] | null;
  // Ollama runtime (absent/false when not running)
  ollama_running?:           boolean;
  ollama_active_model?:      string | null;
  ollama_model_size_gb?:     number | null;
  ollama_quantization?:      string | null;
  /** Sampled tok/s from 20-token /api/generate probe every 30s. Null until first probe completes. */
  ollama_tokens_per_second?: number | null;
  /**
   * True when a request completed within the last 35s (one probe interval).
   * Derived from /api/ps expires_at resets. False until first reset observed.
   * Null/absent when agent has not yet seen any expires_at change since start.
   */
  ollama_inference_active?: boolean | null;
  /** True when the Wicklee transparent proxy is active on :11434.
   * When true, tok/s comes from done-packet eval_count/eval_duration (exact),
   * not the 30-second synthetic probe. Frontend shows "live" not "live estimate". */
  ollama_proxy_active?: boolean | null;
  // vLLM runtime (absent/false when not running)
  vllm_running?:          boolean;
  vllm_model_name?:       string | null;
  /** Avg generation throughput from vLLM Prometheus /metrics. Null until first probe. */
  vllm_tokens_per_sec?:   number | null;
  /** KV cache utilisation 0–100%. Agent multiplies vLLM's 0–1 value by 100. */
  vllm_cache_usage_perc?: number | null;
  vllm_requests_running?: number | null;
  /** Compile-time OS from agent — "macOS" | "Linux" | "Windows". Absent on older agents. */
  os?: string | null;
  /** Compile-time CPU architecture — "x86_64" | "aarch64". Absent on older agents. */
  arch?: string | null;
  // WES v2 — agent-computed thermal telemetry (absent on older agents)
  /** Average thermal penalty applied over the sample window (e.g. 1.75 for Serious). */
  penalty_avg?:    number | null;
  /** Peak thermal penalty seen in the sample window. */
  penalty_peak?:   number | null;
  /** Source of thermal data: 'nvml' | 'iokit' | 'sysfs' | 'unavailable'. */
  thermal_source?: string | null;
  /** Number of samples in the current WES window. */
  sample_count?:   number | null;
  /** Agent WES computation version (2 = v2 with penalty fields). */
  wes_version?:    number;
  /**
   * Swap device write rate (MB/s).
   * Linux: derived from /proc/vmstat pswpout counter delta.
   * macOS: derived from vm_stat Swapouts counter delta.
   * Null / absent on Windows and agents < v0.4.4.
   */
  swap_write_mb_s?: number | null;
  /**
   * GPU clock throttle percentage: 0 = running at full rated speed, 100 = fully throttled.
   * NVIDIA: derived from nvmlDeviceGetClockInfo(GRAPHICS) / nvmlDeviceGetMaxClockInfo(GRAPHICS).
   * AMD/Linux: derived from scaling_cur_freq / cpuinfo_max_freq (clock_ratio path only).
   * Absent on macOS, Windows, non-AMD Linux without cpufreq, and musl builds.
   * 0% is healthy; higher values mean the GPU/CPU clock is below its rated maximum.
   */
  clock_throttle_pct?: number | null;
}

/**
 * A single MIG (Multi-Instance GPU) slice on an NVIDIA Hopper or Blackwell device.
 * Reported when the device is MIG-partitioned. Each slice surfaces as a virtual
 * sub-row in Fleet Status — independent WES, VRAM, and thermal attribution.
 */
export interface MIGInstance {
  /** MIG profile name, e.g. "3g.40gb" or "1g.10gb" */
  profile:       string;
  vram_used_mb:  number;
  vram_total_mb: number;
  gpu_util_pct:  number | null;
  /** Fractional power draw attributed to this slice (board_power / num_slices). Estimated. */
  power_draw_w:  number | null;
}

export interface FleetEvent {
  id: string;
  ts: number; // Date.now() timestamp
  type:
    | 'node_online'
    | 'node_offline'
    | 'thermal_change'
    | 'throttle_start'
    | 'throttle_resolved'
    | 'model_swap'
    | 'power_anomaly'
    | 'error'
    | 'model_eviction_predicted'
    | 'keep_warm_taken'
    | 'thermal_degradation_confirmed'
    | 'fit_score_changed'
    // ── Pattern engine lifecycle events (Sprint 4) ─────────────────────────
    /** Pattern crossed moderate/high confidence — suppressed for ONSET_SUPPRESSION_MS (15m). */
    | 'pattern_onset'
    /** Pattern absent for OBS_HOLD_MS (10m) — hardware stress confirmed resolved. */
    | 'pattern_resolved'
    /** Operator dismissed the card (1h resurface). */
    | 'pattern_dismissed'
    // ── Sprint 6 ──────────────────────────────────────────────────────────
    /** Operator clicked "Never show again" — writes to metrics.db audit trail. */
    | 'pattern_dismissed_permanent';
  nodeId: string;
  hostname?: string;
  /** Human-readable transition detail, e.g. "Normal → Serious" or "phi3:mini → llama3:8b" */
  detail?: string;
  // ── Pattern-specific payload (only present on pattern_* event types) ─────
  /** Stable pattern identifier, e.g. 'thermal_drain'. Matches DetectedInsight.patternId. */
  patternId?:   string;
  /** Machine-readable action classification — same value as DetectedInsight.action_id. */
  action_id?:   string;
  /** The hook string at the time of the event, e.g. "-4.2 tok/s (31% below Normal)". */
  hook?:        string;
  /**
   * WES score captured at the exact moment pattern_onset fires.
   * Null when WES is unavailable. Used by InsightsBriefingCard to show
   * "Efficiency lost: 181.5 → 142.0" without re-calculation.
   */
  wes_at_onset?: number | null;
}

export interface TraceRecord {
  id: string;
  timestamp: string;
  nodeId: string;
  model: string;
  latency: number;
  ttft: number; // Time to First Token
  tpot: number; // Time Per Output Token
  status: number;
}

export type UserRole = 'Owner' | 'Collaborator' | 'Viewer';

/**
 * Subscription tier stored in Clerk publicMetadata.tier.
 * Community = free, Pro = $9/mo, Team = $29/mo, Enterprise = $199/mo.
 */
export type SubscriptionTier = 'community' | 'pro' | 'team' | 'enterprise';

/**
 * Insights capability level derived from SubscriptionTier.
 * Controls which insight cards render vs. show locked shells.
 *   live_session  = Community  (real-time only, no history)
 *   persistent    = Pro        (7-day history, persistent cards)
 *   trend         = Team       (90-day history, trend analysis)
 *   predictive    = Enterprise (custom scope, compliance artifacts)
 */
export type InsightsTier = 'live_session' | 'persistent' | 'trend' | 'predictive';

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  isPro?: boolean;
  /** Subscription tier from Clerk publicMetadata.tier — defaults to 'community' */
  tier?: SubscriptionTier;
}

export interface Tenant {
  id: string;
  name: string;
}

export type FleetPairingStatus = 'unpaired' | 'pending' | 'connected';

/** Ambient status of the live telemetry connection, used to drive logo + status dot animations. */
export type ConnectionState = 'connected' | 'degraded' | 'idle' | 'disconnected';

export interface PairingInfo {
  status: FleetPairingStatus;
  node_id: string;
  code?: string | null;
  expires_at?: number | null;
  fleet_url?: string | null;
}

/** Shape of a single node in the fleet SSE stream frame. */
export interface FleetNode {
  node_id: string;
  last_seen_ms: number;
  metrics: SentinelMetrics | null;
  restricted?: boolean;
}

/** Values exposed by FleetStreamContext to consumers via useFleetStream(). */
export interface FleetStreamState {
  /** Latest metrics per node_id. */
  allNodeMetrics: Record<string, SentinelMetrics>;
  /** Per-node last_seen_ms from the SSE stream. */
  lastSeenMsMap: Record<string, number>;
  /** Set of node_ids that are restricted (beyond the free tier limit). */
  restrictedNodeIds: ReadonlySet<string>;
  /**
   * Session-scoped per-node peak tok/s high-water mark.
   * Resets on model swap so the baseline stays relevant to the loaded model.
   * Used by consumers to estimate total hardware throughput when the Ollama
   * probe is depressed (background inference) or null (inference lockup).
   */
  peakTpsMap: Record<string, number>;
  /** Detected fleet events (online/offline/thermal), newest first, max 50. */
  fleetEvents: FleetEvent[];
  /** Append a new event to the front of the fleet event list. */
  addFleetEvent: (event: FleetEvent) => void;
  /** Whether the EventSource is currently connected. */
  connected: boolean;
  /** Transport type — 'sse' once connected, null before first open. */
  transport: 'sse' | null;
  /** Timestamp (Date.now()) of the last SSE frame that contained metrics. */
  lastTelemetryMs: number | null;
  /** Derived ambient connection state for logo/sidebar animations. */
  connectionState: ConnectionState;
}

export enum DashboardTab {
  OVERVIEW = 'overview',
  NODES = 'nodes',
  TRACES = 'traces',
  SCAFFOLDING = 'scaffolding',
  AI_INSIGHTS = 'ai_insights',
  TEAM = 'team',
  PROFILE = 'profile',
  SECURITY = 'security',
  API_KEYS = 'api_keys',
  PREFERENCES = 'preferences',
  PRICING = 'pricing',
  AI_PROVIDERS = 'ai_providers',
  BILLING = 'billing',
  SETTINGS = 'settings',
}

// ── Agent API v1 ──────────────────────────────────────────────────────────────

/** API key metadata returned by GET /api/v1/keys.
 *  The raw key value is never included — it is returned once at creation only. */
export interface ApiKey {
  key_id:       string;
  name:         string;
  created_at:   number;        // unix ms
  last_used_ms: number | null;
}

/** Response body for POST /api/v1/keys — raw key shown once, then gone. */
export interface CreateApiKeyResponse {
  key_id:     string;
  key:        string;          // raw wk_live_... — copy immediately
  name:       string;
  created_at: number;          // unix ms
}

// ── Local metric history (agent /api/history) ─────────────────────────────────
// Mirrors store::HistorySample and store::HistoryResponse in agent/src/store.rs.
// null values are omitted from the JSON by the agent (serde skip_serializing_if).

/** One time-series sample from the agent DuckDB store. */
export interface HistorySample {
  ts_ms:          number;
  model?:         string | null;
  /** Raw 1-Hz tok/s (raw tier only). */
  tps?:           number | null;
  /** 1-min / 1-hr aggregate average tok/s. */
  tps_avg?:       number | null;
  tps_max?:       number | null;
  tps_p95?:       number | null;
  cpu_usage_pct?: number | null;
  gpu_util_pct?:  number | null;
  /** GPU power draw in watts (Apple Silicon cpu_power_w, NVIDIA power_draw_w). */
  gpu_power_w?:   number | null;
  vram_used_mb?:  number | null;
  thermal_state?: string | null;
  /** Swap write rate MB/s — raw tier only. Null on aggregated tiers (1min, 1hr). */
  swap_write_mb_s?: number | null;
  /** GPU clock throttle % — raw tier only. 0 = full speed. Null on aggregated tiers. */
  clock_throttle_pct?: number | null;
}

/** Response envelope from GET /api/history. */
export interface HistoryResponse {
  node_id:    string;
  resolution: 'raw' | '1min' | '1hr';
  from_ms:    number;
  to_ms:      number;
  samples:    HistorySample[];
}

// ── Tier badge display config ─────────────────────────────────────────────────
// Used by InsightsLockedCard, UpgradePrompt, and feature-lock overlays.
// Single source of truth for label text and Tailwind color tokens per tier.

export const TIER_BADGE: Record<SubscriptionTier, { label: string; color: string }> = {
  community:  { label: 'Community',  color: 'text-gray-400  bg-gray-500/10  border-gray-500/20'  },
  pro:        { label: 'Pro',        color: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20' },
  team:       { label: 'Team',       color: 'text-blue-400  bg-blue-500/10  border-blue-500/20'  },
  enterprise: { label: 'Enterprise', color: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
};
