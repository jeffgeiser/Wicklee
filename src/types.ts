
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
  // NVIDIA GPU fields (null on non-NVIDIA)
  nvidia_gpu_utilization_percent: number | null;
  nvidia_vram_used_mb:            number | null;
  nvidia_vram_total_mb:           number | null;
  nvidia_gpu_temp_c:              number | null;
  nvidia_power_draw_w:            number | null;
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
    | 'fit_score_changed';
  nodeId: string;
  hostname?: string;
  /** Human-readable transition detail, e.g. "Normal → Serious" or "phi3:mini → llama3:8b" */
  detail?: string;
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
}

/** Values exposed by FleetStreamContext to consumers via useFleetStream(). */
export interface FleetStreamState {
  /** Latest metrics per node_id. */
  allNodeMetrics: Record<string, SentinelMetrics>;
  /** Per-node last_seen_ms from the SSE stream. */
  lastSeenMsMap: Record<string, number>;
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
