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
  /** Lower bound (min observed tok/s in the matching cohort). */
  min: number;
  /** Upper bound (max observed tok/s in the matching cohort). */
  max: number;
  /** Number of historical models in the cohort. Always >= 2 when returned. */
  count: number;
}

/**
 * Project a tok/s range for a candidate variant based on the user's
 * historical performance on similar-sized models.
 *
 * Returns null if fewer than 2 historical models match (no guessing
 * from N=1, per spec).
 *
 * Matching:
 *   1. Historical model's estimated file size within ±40% of candidate's
 *   2. Prefer same quant family (Q4↔Q4, Q5/Q6↔Q5/Q6, Q8/F16↔Q8/F16);
 *      fall back to any quant if the same-family cohort is too small.
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
    if (sizeMb < lo || sizeMb > hi) continue;
    sized.push({ row, sizeMb });
  }
  if (sized.length === 0) return null;

  // Prefer same quant family; fall back to any.
  let cohort = sized;
  if (targetFamily) {
    const sameFam = sized.filter(s => quantFamily(extractQuant(s.row.model) ?? '') === targetFamily);
    if (sameFam.length >= 2) cohort = sameFam;
  }
  if (cohort.length < 2) return null;

  const tps = cohort.map(c => c.row.avg_tok_s as number);
  return {
    min: Math.min(...tps),
    max: Math.max(...tps),
    count: cohort.length,
  };
}

/** Extract an explicit quant tag from a model name, if present. */
function extractQuant(modelName: string): string | null {
  const m = modelName.toUpperCase().match(/Q\d(?:_K_[MS]|_[01])?|F16|F32|BF16|IQ\d_[A-Z]+/);
  return m ? m[0] : null;
}
