/**
 * useMetricHistory — rolling 24-hour per-node metric history.
 *
 * Design goals:
 *  - One sample per 30s per node (matches Ollama probe interval).
 *  - localStorage persistence: survives page refreshes, enables pattern
 *    engine to reason across sessions without a DuckDB query.
 *  - Max 2,880 samples/node (24h × 120 samples/hr). Old entries evicted
 *    automatically.
 *  - Downsampling: if push() is called more frequently than SAMPLE_INTERVAL_MS
 *    the call is ignored — the existing sample for that window is kept.
 *  - Self-contained: no React state, no re-renders. Returns a stable ref
 *    with imperative push/getHistory methods so callers can write to history
 *    in useEffect without causing render loops.
 */

import { useRef, useCallback } from 'react';
import { getNodePowerW } from '../utils/power';

// ── Constants ──────────────────────────────────────────────────────────────────

export const SAMPLE_INTERVAL_MS  = 30_000;   // downsample: 1 sample per 30s
export const MAX_SAMPLES_PER_NODE = 2_880;   // 24h × 2 per minute × 60min
export const STORAGE_KEY          = 'wk_metric_history_v1';

// ── Types ──────────────────────────────────────────────────────────────────────

/** One downsampled data point stored per node per 30-second window. */
export interface MetricSample {
  /** Bucket start time: Math.floor(ts / SAMPLE_INTERVAL_MS) * SAMPLE_INTERVAL_MS */
  ts_ms:             number;
  thermal_state:     string | null;
  /** Combined penalty (WES v2 penalty_avg; falls back to derived value if absent). */
  penalty_avg:       number | null;
  wes_score:         number | null;
  tok_s:             number | null;
  watts:             number | null;
  mem_pressure_pct:  number | null;
  gpu_util_pct:      number | null;
  /** Total VRAM used (MB) above the 1024 MB inference threshold. */
  vram_used_mb:      number | null;
  /** VRAM capacity (MB) for qualifying GPU. */
  vram_total_mb:     number | null;
  /** Swap write rate (MB/s) from agent. Null on unsupported platforms or old agents. */
  swap_write_mb_s:    number | null;
  /** CPU/GPU clock throttle percentage. 0 = full speed, 100 = fully throttled. */
  clock_throttle_pct: number | null;
  /** Current PCIe link width in lanes (1/4/8/16). NVIDIA only; null on other platforms. */
  pcie_link_width:     number | null;
  /** Max PCIe link width the GPU + slot support. Pattern L: fires when current < max. */
  pcie_link_max_width: number | null;
  /** vLLM KV cache utilization 0–100%. Pattern M: fires when > 90% sustained. */
  vllm_cache_usage_perc:  number | null;
  /** NVIDIA GPU temperature in Celsius. Pattern N: fires > 85°C sustained or > 90°C instant. */
  nvidia_gpu_temp_c:      number | null;
  /** Loaded Ollama model size in GB. Pattern O: fires when > 90% of VRAM capacity. */
  ollama_model_size_gb:   number | null;
  /** Apple Silicon GPU VRAM budget (MB). Pattern O: VRAM capacity on Apple Silicon nodes. */
  gpu_wired_limit_mb:     number | null;
}

// Map<node_id, MetricSample[]> — stored as JSON in localStorage
type HistoryStore = Record<string, MetricSample[]>;

// ── localStorage helpers ───────────────────────────────────────────────────────

function loadStore(): HistoryStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as HistoryStore) : {};
  } catch {
    return {};
  }
}

function saveStore(store: HistoryStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // QuotaExceededError — trim oldest half and retry
    try {
      const trimmed: HistoryStore = {};
      for (const [nodeId, samples] of Object.entries(store)) {
        trimmed[nodeId] = samples.slice(Math.floor(samples.length / 2));
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      // Give up gracefully — history just won't persist this cycle
    }
  }
}

// ── Derived helpers ────────────────────────────────────────────────────────────

const INFERENCE_VRAM_THRESHOLD_MB = 1024;

/** Pull a MetricSample snapshot from a SentinelMetrics-like object. */
export function metricsToSample(
  m: {
    timestamp_ms:                   number;
    thermal_state?:                 string | null;
    penalty_avg?:                   number | null;
    memory_pressure_percent?:       number | null;
    gpu_utilization_percent?:       number | null;
    apple_soc_power_w?:             number | null;
    cpu_power_w?:                   number | null;
    apple_gpu_power_w?:             number | null;
    nvidia_power_draw_w?:           number | null;
    nvidia_gpu_utilization_percent?: number | null;
    nvidia_vram_used_mb?:           number | null;
    nvidia_vram_total_mb?:          number | null;
    swap_write_mb_s?:               number | null;
    clock_throttle_pct?:            number | null;
    pcie_link_width?:               number | null;
    pcie_link_max_width?:           number | null;
    ollama_tokens_per_second?:      number | null;
    vllm_tokens_per_sec?:           number | null;
    vllm_cache_usage_perc?:         number | null;
    nvidia_gpu_temp_c?:             number | null;
    ollama_model_size_gb?:          number | null;
    gpu_wired_limit_mb?:            number | null;
    // WES score is not in SentinelMetrics directly — computed downstream
    _wes_score?:                    number | null;
  },
  wesScore: number | null = null,
): MetricSample {
  const bucket = Math.floor(m.timestamp_ms / SAMPLE_INTERVAL_MS) * SAMPLE_INTERVAL_MS;

  const vramUsed  = (m.nvidia_vram_used_mb  ?? 0) >= INFERENCE_VRAM_THRESHOLD_MB
    ? m.nvidia_vram_used_mb
    : null;
  const vramTotal = (m.nvidia_vram_total_mb ?? 0) >= INFERENCE_VRAM_THRESHOLD_MB
    ? m.nvidia_vram_total_mb
    : null;

  const watts = getNodePowerW(m) ?? null;
  const gpuUtil = m.nvidia_gpu_utilization_percent ?? m.gpu_utilization_percent ?? null;
  const tokS    = m.ollama_tokens_per_second ?? m.vllm_tokens_per_sec ?? null;

  return {
    ts_ms:            bucket,
    thermal_state:    m.thermal_state ?? null,
    penalty_avg:      m.penalty_avg   ?? null,
    wes_score:        wesScore,
    tok_s:            tokS,
    watts:            watts === 0 ? null : watts,
    mem_pressure_pct: m.memory_pressure_percent ?? null,
    gpu_util_pct:     gpuUtil,
    vram_used_mb:     vramUsed,
    vram_total_mb:    vramTotal,
    swap_write_mb_s:    m.swap_write_mb_s    ?? null,
    clock_throttle_pct: m.clock_throttle_pct ?? null,
    pcie_link_width:      m.pcie_link_width      ?? null,
    pcie_link_max_width:  m.pcie_link_max_width  ?? null,
    vllm_cache_usage_perc:  m.vllm_cache_usage_perc  ?? null,
    nvidia_gpu_temp_c:      m.nvidia_gpu_temp_c      ?? null,
    ollama_model_size_gb:   m.ollama_model_size_gb   ?? null,
    gpu_wired_limit_mb:     (m.gpu_wired_limit_mb != null && m.gpu_wired_limit_mb > 0)
                              ? m.gpu_wired_limit_mb : null,
  };
}

// ── Hook ───────────────────────────────────────────────────────────────────────

export interface MetricHistoryHandle {
  /**
   * Push a new sample for a node.
   * Deduplication: if the bucket for this ts_ms already exists, call is ignored.
   * Eviction: oldest entries beyond MAX_SAMPLES_PER_NODE are dropped.
   * Persistence: store is written to localStorage after every accepted push.
   */
  push: (nodeId: string, sample: MetricSample) => void;

  /**
   * Return all samples for a node, oldest first.
   * Returns [] if no history exists for the node.
   */
  getHistory: (nodeId: string) => MetricSample[];

  /**
   * Return the last N samples for a node (most recent N), oldest first.
   */
  getRecent: (nodeId: string, n: number) => MetricSample[];

  /**
   * Return samples within a time window [fromMs, toMs], inclusive.
   */
  getWindow: (nodeId: string, fromMs: number, toMs: number) => MetricSample[];

  /**
   * Drop all history older than maxAgeMs from now.
   * Call periodically (e.g. on component mount) to evict stale localStorage data.
   */
  prune: (maxAgeMs?: number) => void;

  /** Clear all history (dev/test utility). */
  clear: () => void;
}

/**
 * useMetricHistory — stable handle to the per-node metric history store.
 *
 * The handle is stable (same object reference for the component lifetime).
 * Pushing a sample does NOT trigger a re-render — callers that want to
 * react to new history should use their own state/effect pattern, or read
 * history directly via getHistory() inside the pattern engine evaluator.
 */
export function useMetricHistory(): MetricHistoryHandle {
  const storeRef = useRef<HistoryStore>(loadStore());

  const push = useCallback((nodeId: string, sample: MetricSample) => {
    const store = storeRef.current;
    const samples = store[nodeId] ?? [];

    // Dedup by bucket
    if (samples.length > 0 && samples[samples.length - 1].ts_ms === sample.ts_ms) {
      return;
    }

    // Append + evict
    const updated = samples.length >= MAX_SAMPLES_PER_NODE
      ? [...samples.slice(1), sample]
      : [...samples, sample];

    storeRef.current = { ...store, [nodeId]: updated };
    saveStore(storeRef.current);
  }, []);

  const getHistory = useCallback((nodeId: string): MetricSample[] => {
    return storeRef.current[nodeId] ?? [];
  }, []);

  const getRecent = useCallback((nodeId: string, n: number): MetricSample[] => {
    const all = storeRef.current[nodeId] ?? [];
    return n >= all.length ? all : all.slice(all.length - n);
  }, []);

  const getWindow = useCallback(
    (nodeId: string, fromMs: number, toMs: number): MetricSample[] => {
      return (storeRef.current[nodeId] ?? []).filter(
        s => s.ts_ms >= fromMs && s.ts_ms <= toMs,
      );
    },
    [],
  );

  const prune = useCallback((maxAgeMs = 24 * 60 * 60 * 1000) => {
    const cutoff = Date.now() - maxAgeMs;
    const store  = storeRef.current;
    let changed  = false;
    const pruned: HistoryStore = {};
    for (const [nodeId, samples] of Object.entries(store) as [string, MetricSample[]][]) {
      const kept = samples.filter(s => s.ts_ms >= cutoff);
      pruned[nodeId] = kept;
      if (kept.length !== samples.length) changed = true;
    }
    if (changed) {
      storeRef.current = pruned;
      saveStore(pruned);
    }
  }, []);

  const clear = useCallback(() => {
    storeRef.current = {};
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }, []);

  return { push, getHistory, getRecent, getWindow, prune, clear };
}
