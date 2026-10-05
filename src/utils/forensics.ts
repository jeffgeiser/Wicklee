/**
 * Forensics analysis — pure functions behind the Team-tier Forensics cards
 * on the Insights tab. Inputs are the per-node series returned by the cloud
 * history endpoints:
 *
 *   GET /api/fleet/wes-history?range=7d       → WesHistoryNode[]
 *   GET /api/fleet/metrics-history?range=24h  → MetricsHistoryNode[]
 *   GET /api/fleet/metrics-history?range=7d   → MetricsHistoryNode[]
 *
 * Every function returns null (or an empty list) when there is not enough
 * history to say anything honest, so the cards can show a "needs more
 * history" state instead of a made-up number.
 */

export interface WesHistoryPoint {
  ts_ms: number;
  raw_wes?: number | null;
  penalized_wes?: number | null;
  thermal_state?: string | null;
}

export interface WesHistoryNode {
  node_id: string;
  hostname: string;
  points: WesHistoryPoint[];
}

export interface MetricsHistoryPoint {
  ts_ms: number;
  tok_s?: number | null;
  mem_pct?: number | null;
  duty_pct?: number | null;
  ttft_ms?: number | null;
}

export interface MetricsHistoryNode {
  node_id: string;
  hostname: string;
  points: MetricsHistoryPoint[];
}

const HOUR_MS = 3_600_000;
const DAY_MS  = 24 * HOUR_MS;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ── 8 · Efficiency Regression ────────────────────────────────────────────────

export interface EfficiencyRegression {
  node_id: string;
  hostname: string;
  /** Median WES over the last 24 hours. */
  recentWes: number;
  /** Median WES over the 6 days before that. */
  baselineWes: number;
  /** (recent − baseline) / baseline × 100. Negative = regression. */
  deltaPct: number;
}

/** Minimum samples (30-min buckets at 7d range) on each side of the split. */
const MIN_RECENT_BUCKETS   = 4;   // 2 h in the last 24 h
const MIN_BASELINE_BUCKETS = 12;  // 6 h in the prior 6 days

/**
 * Last-24h median WES vs. the prior-6-day median, per node, worst first.
 * Medians rather than means so a single idle or warm-up bucket can't swing it.
 */
export function efficiencyRegressions(nodes: WesHistoryNode[], nowMs: number): EfficiencyRegression[] {
  const split = nowMs - DAY_MS;
  const out: EfficiencyRegression[] = [];
  for (const n of nodes) {
    const recent: number[] = [];
    const baseline: number[] = [];
    for (const p of n.points) {
      const w = p.penalized_wes;
      if (!isNum(w) || w <= 0) continue;
      (p.ts_ms >= split ? recent : baseline).push(w);
    }
    if (recent.length < MIN_RECENT_BUCKETS || baseline.length < MIN_BASELINE_BUCKETS) continue;
    const r = median(recent)!;
    const b = median(baseline)!;
    out.push({
      node_id: n.node_id,
      hostname: n.hostname,
      recentWes: r,
      baselineWes: b,
      deltaPct: ((r - b) / b) * 100,
    });
  }
  return out.sort((a, b) => a.deltaPct - b.deltaPct);
}

// ── 9 · Memory Forecast ──────────────────────────────────────────────────────

export interface MemoryForecast {
  node_id: string;
  hostname: string;
  currentPct: number;
  /** Least-squares slope over the fit window, in percentage points per hour. */
  slopePctPerHour: number;
  /** Time until `thresholdPct` at the current slope; null when flat or falling. */
  etaMs: number | null;
}

const FORECAST_WINDOW_MS = 2 * HOUR_MS;
const MIN_FORECAST_POINTS = 6;
/** Slopes below this are noise, not a trend. */
const MIN_SLOPE_PCT_PER_HOUR = 0.5;

/**
 * Linear fit of memory pressure over the last 2 hours, per node. Sorted with
 * the soonest exhaustion first, then by current pressure.
 */
export function memoryForecasts(
  nodes: MetricsHistoryNode[],
  nowMs: number,
  thresholdPct = 95,
): MemoryForecast[] {
  const from = nowMs - FORECAST_WINDOW_MS;
  const out: MemoryForecast[] = [];
  for (const n of nodes) {
    const pts = n.points.filter(p => p.ts_ms >= from && isNum(p.mem_pct)) as Array<MetricsHistoryPoint & { mem_pct: number }>;
    if (pts.length < MIN_FORECAST_POINTS) continue;
    const xs = pts.map(p => (p.ts_ms - from) / HOUR_MS);
    const ys = pts.map(p => p.mem_pct);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0, den = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      den += (xs[i] - mx) ** 2;
    }
    const slope = den > 0 ? num / den : 0;
    const current = ys[ys.length - 1];
    const etaMs = slope >= MIN_SLOPE_PCT_PER_HOUR && current < thresholdPct
      ? ((thresholdPct - current) / slope) * HOUR_MS
      : null;
    out.push({ node_id: n.node_id, hostname: n.hostname, currentPct: current, slopePctPerHour: slope, etaMs });
  }
  return out.sort((a, b) => {
    if (a.etaMs != null && b.etaMs != null) return a.etaMs - b.etaMs;
    if (a.etaMs != null) return -1;
    if (b.etaMs != null) return 1;
    return b.currentPct - a.currentPct;
  });
}

// ── 11 · Hardware Cold Start ─────────────────────────────────────────────────

export interface ColdStartSummary {
  node_id: string;
  hostname: string;
  /** Buckets whose TTFT was ≥ 3× the node's median and ≥ 1 s. */
  spikes: number;
  medianTtftMs: number;
  worstTtftMs: number;
  lastSpikeMs: number | null;
}

const MIN_TTFT_POINTS = 6;
const SPIKE_FACTOR = 3;
const SPIKE_FLOOR_MS = 1000;

/**
 * TTFT spikes over the last 24 h — the signature of a model being loaded
 * from disk on the first request. Buckets are 5-minute averages, so a single
 * cold load is diluted; the counts are a floor, not an exact tally.
 */
export function coldStarts(nodes: MetricsHistoryNode[]): ColdStartSummary[] {
  const out: ColdStartSummary[] = [];
  for (const n of nodes) {
    const pts = n.points.filter(p => isNum(p.ttft_ms) && p.ttft_ms > 0) as Array<MetricsHistoryPoint & { ttft_ms: number }>;
    if (pts.length < MIN_TTFT_POINTS) continue;
    const med = median(pts.map(p => p.ttft_ms))!;
    const cutoff = Math.max(med * SPIKE_FACTOR, SPIKE_FLOOR_MS);
    let spikes = 0, worst = 0, last: number | null = null;
    for (const p of pts) {
      worst = Math.max(worst, p.ttft_ms);
      if (p.ttft_ms >= cutoff) {
        spikes++;
        last = last == null ? p.ts_ms : Math.max(last, p.ts_ms);
      }
    }
    out.push({ node_id: n.node_id, hostname: n.hostname, spikes, medianTtftMs: med, worstTtftMs: worst, lastSpikeMs: last });
  }
  return out.sort((a, b) => b.spikes - a.spikes || b.worstTtftMs - a.worstTtftMs);
}

// ── 12 · Fleet Thermal Diversity ─────────────────────────────────────────────

export interface ThermalDiversity {
  /** Nodes with at least one thermal sample in the window. */
  nodeCount: number;
  /** Per node, the share of samples spent at Fair or worse (0–100). */
  perNode: Array<{ node_id: string; hostname: string; warmPct: number }>;
  /** Time buckets where 2+ nodes were Serious/Critical at once. */
  correlatedBuckets: number;
  /** Buckets with thermal samples from 2+ nodes. */
  sharedBuckets: number;
  risk: 'low' | 'elevated' | 'high';
}

const HOT = new Set(['serious', 'critical']);
const WARM = new Set(['fair', 'serious', 'critical']);

/**
 * Whether thermal stress across the fleet is independent (low cascade risk)
 * or correlated — several nodes heating up together, as on a shared rack or
 * HVAC zone, so losing one node pushes load onto others that are also hot.
 */
export function thermalDiversity(nodes: WesHistoryNode[]): ThermalDiversity | null {
  const byBucket = new Map<number, { seen: number; hot: number }>();
  const perNode: ThermalDiversity['perNode'] = [];
  for (const n of nodes) {
    let total = 0, warm = 0;
    for (const p of n.points) {
      const s = p.thermal_state?.toLowerCase();
      if (!s) continue;
      total++;
      if (WARM.has(s)) warm++;
      const b = byBucket.get(p.ts_ms) ?? { seen: 0, hot: 0 };
      b.seen++;
      if (HOT.has(s)) b.hot++;
      byBucket.set(p.ts_ms, b);
    }
    if (total > 0) perNode.push({ node_id: n.node_id, hostname: n.hostname, warmPct: (warm / total) * 100 });
  }
  if (perNode.length < 2) return null;
  let correlated = 0, shared = 0;
  for (const b of byBucket.values()) {
    if (b.seen >= 2) shared++;
    if (b.hot >= 2) correlated++;
  }
  const corrPct = shared > 0 ? (correlated / shared) * 100 : 0;
  const risk: ThermalDiversity['risk'] = corrPct >= 5 ? 'high' : correlated > 0 ? 'elevated' : 'low';
  perNode.sort((a, b) => b.warmPct - a.warmPct);
  return { nodeCount: perNode.length, perNode, correlatedBuckets: correlated, sharedBuckets: shared, risk };
}

// ── 13 · Inference Density (Historical) ──────────────────────────────────────

export interface InferenceDensity {
  /** Average fleet tok/s for each local hour of day (index 0–23); null = no data. */
  byHour: Array<number | null>;
  peakHour: number;
  peakTokS: number;
  /** Average share of time the fleet was actively generating (0–100). */
  avgDutyPct: number | null;
}

/**
 * Fleet throughput by hour of day over the 7-day window: sum tok/s across
 * nodes per bucket, then average buckets by the viewer's local hour.
 */
export function inferenceDensity(
  nodes: MetricsHistoryNode[],
  hourOf: (ms: number) => number = ms => new Date(ms).getHours(),
): InferenceDensity | null {
  const fleet = new Map<number, number>();
  const duty: number[] = [];
  for (const n of nodes) {
    for (const p of n.points) {
      if (isNum(p.tok_s)) fleet.set(p.ts_ms, (fleet.get(p.ts_ms) ?? 0) + p.tok_s);
      if (isNum(p.duty_pct)) duty.push(p.duty_pct);
    }
  }
  if (fleet.size === 0) return null;
  const sums = new Array<number>(24).fill(0);
  const counts = new Array<number>(24).fill(0);
  for (const [ts, tok] of fleet) {
    const h = hourOf(ts);
    sums[h] += tok;
    counts[h]++;
  }
  const byHour = sums.map((s, h) => (counts[h] ? s / counts[h] : null));
  let peakHour = 0, peakTokS = -1;
  byHour.forEach((v, h) => { if (v != null && v > peakTokS) { peakTokS = v; peakHour = h; } });
  if (peakTokS <= 0) return null;
  return {
    byHour,
    peakHour,
    peakTokS,
    avgDutyPct: duty.length ? duty.reduce((a, b) => a + b, 0) / duty.length : null,
  };
}

/** "2h 15m", "45m", "3d 4h". */
export function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(m, 1)}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}
