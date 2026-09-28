/**
 * Helpers shared by the two Model Discovery cards — ModelDiscoveryCard
 * (single node, Cockpit) and FleetModelDiscovery (fleet, Mission Control).
 *
 * Where the cards intentionally differ, the variation is a parameter:
 *   fitColors(score, wontFit)   — 'dim' (fleet) or 'red' (single node) for a
 *                                 zero score; every other tier is identical.
 *   projConfidenceBody(p, scope) — copy says "this fleet" vs "this node".
 */

import type { TpsProjection } from '../../utils/modelHistory';
import type { DiscoveryHoverRow } from './DiscoveryHoverCard';

// ── Fit score ─────────────────────────────────────────────────────────────────

export interface FitColors { dot: string; badge: string; bar: string; text: string }

export function fitColors(score: number, wontFit: 'dim' | 'red'): FitColors {
  if (score >= 80) return { dot: 'bg-emerald-500', badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20', bar: 'bg-emerald-500', text: 'text-emerald-400' };
  if (score >= 60) return { dot: 'bg-green-500',   badge: 'bg-green-500/15 text-green-400 border-green-500/20',       bar: 'bg-green-500',   text: 'text-green-400' };
  if (score >= 40) return { dot: 'bg-yellow-500',  badge: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/20',    bar: 'bg-yellow-500',  text: 'text-yellow-400' };
  if (score > 0)   return { dot: 'bg-orange-500',  badge: 'bg-orange-500/15 text-orange-400 border-orange-500/20',    bar: 'bg-orange-500',  text: 'text-orange-400' };
  return wontFit === 'dim'
    ? { dot: 'bg-red-900', badge: 'bg-red-900/20 text-red-500 border-red-900/30', bar: 'bg-red-900', text: 'text-red-500' }
    : { dot: 'bg-red-500', badge: 'bg-red-500/15 text-red-400 border-red-500/20', bar: 'bg-red-500', text: 'text-red-400' };
}

/** Word label for a fit score, e.g. the "Excellent fit on 3 nodes" line. */
export function fitGradeLabel(score: number): string {
  if (score >= 80) return 'Excellent';
  if (score >= 60) return 'Good';
  if (score >= 40) return 'Tight';
  if (score > 0)   return 'Marginal';
  return "Won't Fit";
}

// ── Model id formatting ───────────────────────────────────────────────────────

export function fmtDl(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`;
  return `${n}`;
}

export function shortModelName(model_id: string): string {
  return model_id.split('/').pop() ?? model_id;
}

export function uploaderName(model_id: string): string | null {
  const parts = model_id.split('/');
  return parts.length > 1 ? parts[0] : null;
}

// ── Projection-tier helpers ───────────────────────────────────────────────────

/** Single-word label for a projection's confidence tier. */
export function projConfidenceLabel(c: TpsProjection['confidence']): string {
  switch (c) {
    case 'cohort':      return 'measured';
    case 'sample':      return 'measured (1 sample)';
    case 'bandwidth':   return 'scaled estimate';
    case 'theoretical': return 'spec estimate';
  }
}

/** One-line body explaining how this projection was produced. */
export function projConfidenceBody(p: TpsProjection, scope: 'fleet' | 'node'): string {
  switch (p.confidence) {
    case 'cohort':
      return `Average across ${p.count} similar-size models that have actually run on this ${scope}. Highest fidelity.`;
    case 'sample':
      return `Single similar-size measurement on this ${scope}, shown as a point estimate ±10%.`;
    case 'bandwidth':
      return `Scaled from your ${scope}'s measured throughput on a different-size model. Inference is memory-bandwidth-bound: tok/s ∝ 1/size.`;
    case 'theoretical':
      return scope === 'fleet'
        ? `Estimated from this node's chip memory bandwidth and the model's file size. No telemetry needed — refines once a model runs.`
        : `Estimated from this chip's published memory bandwidth and the model's file size. No telemetry needed — refines once you run a model.`;
  }
}

/** Structured rows summarising the projection range + method. */
export function projConfidenceRows(p: TpsProjection): DiscoveryHoverRow[] {
  return [
    { label: 'Range',  value: `${p.min} – ${p.max} tok/s` },
    { label: 'Source', value: projConfidenceLabel(p.confidence), accent: p.confidence === 'theoretical' ? 'amber' : 'cyan' },
    ...(p.count > 0 ? [{ label: 'Samples', value: `${p.count}` } as DiscoveryHoverRow] : []),
  ];
}
