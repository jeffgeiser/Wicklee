/**
 * Model performance history — fetches /api/model-comparison and exposes
 * a projection helper for "given a candidate variant's file size + quant,
 * what tok/s range have we observed on similar models?"
 *
 * Used by ModelDiscoveryCard (localhost) and FleetModelDiscovery (cloud)
 * to add an "≈ 28-35 tok/s (based on 5 similar models)" hint per variant.
 */

import { useEffect, useState } from 'react';
import { estimateModelFileSizeMb, quantFamily } from './quantQuality';

export interface ComparisonRow {
  model: string;
  hours_active: number;
  avg_tok_s: number | null;
  avg_watts: number | null;
  wes: number | null;
  avg_ttft_ms: number | null;
  cost_per_hour: number | null;
  total_cost: number | null;
  sample_count: number;
}

/**
 * Fetch model-comparison history once and cache for the lifetime of the
 * page. Returns null while loading, then an array (possibly empty).
 *
 * @param isLocalHost  Determines endpoint: localhost agent vs. cloud fleet.
 * @param getToken     Required when isLocalHost === false.
 */
export function useModelComparisonHistory(
  isLocalHost: boolean,
  getToken?: () => Promise<string | null>,
): ComparisonRow[] | null {
  const [rows, setRows] = useState<ComparisonRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchData = async () => {
      try {
        const url = isLocalHost
          ? '/api/model-comparison?hours=168'
          : '/api/v1/fleet/model-comparison?hours=168';
        const headers: Record<string, string> = {};
        if (!isLocalHost) {
          if (!getToken) { if (!cancelled) setRows([]); return; }
          const token = await getToken();
          if (!token) { if (!cancelled) setRows([]); return; }
          headers['Authorization'] = `Bearer ${token}`;
        }
        const res = await fetch(url, { headers });
        if (!res.ok) { if (!cancelled) setRows([]); return; }
        const ct = res.headers.get('content-type') ?? '';
        if (!ct.includes('application/json')) { if (!cancelled) setRows([]); return; }
        const data = await res.json();
        if (!cancelled) setRows(data.models ?? []);
      } catch {
        if (!cancelled) setRows([]);
      }
    };
    fetchData();
    return () => { cancelled = true; };
  }, [isLocalHost, getToken]);

  return rows;
}

export interface TpsProjection {
  /** Lower bound. For 'cohort'/'sample' = min observed. For 'bandwidth' = scaled value with ±10% spread. */
  min: number;
  /** Upper bound. */
  max: number;
  /** Number of historical models the projection is derived from. */
  count: number;
  /**
   * Confidence tier — drives UI tooltip phrasing:
   *   'cohort'    — 2+ observations in same size class + same quant family (highest fidelity)
   *   'sample'    — 1+ observations in same size class (modest fidelity)
   *   'bandwidth' — scaled from any-size observation via memory-bandwidth heuristic (lowest fidelity but always works)
   */
  confidence: 'cohort' | 'sample' | 'bandwidth';
}

/**
 * Project a tok/s range for a candidate variant.
 *
 * Three-tier fallback:
 *   1. Same-size cohort (≥2 observations within ±40% file size, same quant family)
 *      → empirical min/max range (highest fidelity)
 *   2. Same-size sample (1 observation within ±40%)
 *      → use that single sample's tok/s as a point estimate ±10% spread
 *   3. Bandwidth heuristic (any observation, any size)
 *      → tok/s scales inversely with model size (LLM inference is memory-
 *        bandwidth-bound at batch=1). Pick the closest-size historical
 *        observation and scale: projected = baseline × baseline_size / candidate_size.
 *        Always works as long as the fleet has any single historical model.
 *
 * Returns null only when there's literally no usable historical data.
 *
 * The previous implementation required ≥2 same-cohort models which meant
 * a 4-model fleet history showed projections for 0 candidates if no two
 * models happened to share a size class. The bandwidth fallback fixes that
 * — any single observation unlocks projections for every candidate.
 */
export function projectTpsForVariant(
  history: ComparisonRow[],
  variantFileSizeMb: number,
  variantQuant: string,
): TpsProjection | null {
  if (!history.length || variantFileSizeMb <= 0) return null;
  const targetFamily = quantFamily(variantQuant);
  const lo = variantFileSizeMb * 0.6;
  const hi = variantFileSizeMb * 1.4;

  type Sized = { row: ComparisonRow; sizeMb: number };
  const sized: Sized[] = [];
  for (const row of history) {
    if (row.avg_tok_s == null || row.avg_tok_s <= 0) continue;
    const sizeMb = estimateModelFileSizeMb(row.model);
    if (sizeMb == null) continue;
    sized.push({ row, sizeMb });
  }
  if (sized.length === 0) return null;

  // Tier 1+2: same-size matches (within ±40%)
  const sameSize = sized.filter(s => s.sizeMb >= lo && s.sizeMb <= hi);
  if (sameSize.length > 0) {
    // Tier 1: prefer same quant family with ≥2 observations
    if (targetFamily) {
      const sameFam = sameSize.filter(s => quantFamily(extractQuant(s.row.model) ?? '') === targetFamily);
      if (sameFam.length >= 2) {
        const tps = sameFam.map(c => c.row.avg_tok_s as number);
        return { min: Math.min(...tps), max: Math.max(...tps), count: sameFam.length, confidence: 'cohort' };
      }
    }
    // Still in same-size — return range from all same-size matches (any quant)
    if (sameSize.length >= 2) {
      const tps = sameSize.map(c => c.row.avg_tok_s as number);
      return { min: Math.min(...tps), max: Math.max(...tps), count: sameSize.length, confidence: 'cohort' };
    }
    // Tier 2: single same-size sample → point estimate ±10%
    const single = sameSize[0].row.avg_tok_s as number;
    return { min: Math.round(single * 0.9), max: Math.round(single * 1.1), count: 1, confidence: 'sample' };
  }

  // Tier 3: bandwidth-scaling fallback. Use the closest-size historical
  // observation and scale linearly by inverse size ratio. The assumption:
  // LLM inference at batch=1 is memory-bandwidth-bound, so tok/s ∝ 1/size
  // on the same hardware. This is the same physics quantSweet.ts uses for
  // its quant-recommendation projections — borrowing the technique here so
  // Discovery shows useful numbers from day one rather than waiting for
  // cohorts to form organically.
  sized.sort((a, b) => Math.abs(a.sizeMb - variantFileSizeMb) - Math.abs(b.sizeMb - variantFileSizeMb));
  const baseline = sized[0];
  const baselineTps = baseline.row.avg_tok_s as number;
  const projected = baselineTps * (baseline.sizeMb / variantFileSizeMb);
  // ±15% spread acknowledges the bandwidth heuristic's inherent imprecision
  // (model architecture variations, varying quant overhead) without being so
  // wide it becomes useless guidance.
  return {
    min: Math.round(projected * 0.85),
    max: Math.round(projected * 1.15),
    count: sized.length,
    confidence: 'bandwidth',
  };
}

/** Extract an explicit quant tag from a model name, if present. */
function extractQuant(modelName: string): string | null {
  const m = modelName.toUpperCase().match(/Q\d(?:_K_[MS]|_[01])?|F16|F32|BF16|IQ\d_[A-Z]+/);
  return m ? m[0] : null;
}
