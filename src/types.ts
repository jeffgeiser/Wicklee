
export interface NodeAgent {
  id: string;
  hostname: string;
  ip: string;
  status: 'online' | 'offline' | 'degraded';
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
  /** Sampled tok/s from 1-token /api/generate probe every 30s. Null until first probe completes. */
  ollama_tokens_per_second?: number | null;
  /** Compile-time OS from agent — "macOS" | "Linux" | "Windows". Absent on older agents. */
  os?: string | null;
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
    | 'error';
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

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  isPro?: boolean;
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
  /** Detected fleet events (online/offline/thermal), newest first, max 50. */
  fleetEvents: FleetEvent[];
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
  SUSTAINABILITY = 'sustainability',
  PROFILE = 'profile',
  SECURITY = 'security',
  API_KEYS = 'api_keys',
  PREFERENCES = 'preferences',
  PRICING = 'pricing',
  AI_PROVIDERS = 'ai_providers',
  BILLING = 'billing',
  SETTINGS = 'settings',
}
