/**
 * benchmarkReport — reproducible, citable WES benchmark snapshots.
 *
 * A BenchmarkReport captures the full WES v2 reading for a node at a point in
 * time in a format suitable for publishing in research posts, GitHub issues, or
 * the arXiv comment thread. Fields are version-stamped so benchmarks remain
 * comparable across Wicklee releases.
 *
 * Two source paths:
 *   • Live snapshot  — built from a SentinelMetrics frame (full field coverage)
 *   • History point  — built from a WES history API point (WES/thermal fields only)
 */

import { computeRawWES, computeWES, thermalCostPct, thermalSourceLabel } from './wes';
import type { SentinelMetrics } from '../types';

// ── Constants ─────────────────────────────────────────────────────────────────

export const WICKLEE_VERSION = 'v0.4.33';

// ── Report type ───────────────────────────────────────────────────────────────

export interface BenchmarkReport {
  // Provenance
  generatedAt:    string;   // ISO 8601
  wickleeVersion: string;

  // Node identity
  nodeId:   string;
  hostname: string | null;
  hardware: string | null;  // gpu_name → chip_name → null
  os:       string | null;

  // Inference runtime
  runtime:      'ollama' | 'vllm' | 'unknown';
  model:        string | null;
  quantization: string | null;

  // Raw performance readings
  tokensPerSec: number | null;
  watts:        number | null;

  // WES computed values
  rawWes:         number | null;
  penalizedWes:   number | null;
  thermalCostPct: number;   // 0 when no thermal gap

  // Thermal metadata
  thermalState:  string | null;
  thermalSource: string | null;
  wesVersion:    number;

  // Optional: which history window this came from (history-path only)
  historyRange?: string;
  historyTsMs?:  number;
}

// ── Factory: live SentinelMetrics ─────────────────────────────────────────────

export function buildReportFromLive(node: SentinelMetrics): BenchmarkReport {
  const tps    = node.ollama_tokens_per_second ?? node.vllm_tokens_per_sec ?? null;
  const watts  = node.cpu_power_w ?? node.nvidia_power_draw_w ?? null;
  const rawWes = computeRawWES(tps, watts);
  const penWes = computeWES(tps, watts, node.thermal_state);
  const tcPct  = thermalCostPct(rawWes, penWes);

  const runtime: BenchmarkReport['runtime'] =
    node.vllm_running  ? 'vllm'  :
    node.ollama_running ? 'ollama' : 'unknown';

  const model = node.vllm_model_name ?? node.ollama_active_model ?? null;

  return {
    generatedAt:    new Date().toISOString(),
    wickleeVersion: WICKLEE_VERSION,
    nodeId:         node.node_id,
    hostname:       node.hostname ?? null,
    hardware:       node.gpu_name ?? node.chip_name ?? null,
    os:             node.os ?? null,
    runtime,
    model,
    quantization:   node.ollama_quantization ?? null,
    tokensPerSec:   tps,
    watts,
    rawWes,
    penalizedWes:   penWes,
    thermalCostPct: tcPct,
    thermalState:   node.thermal_state ?? null,
    thermalSource:  node.thermal_source ?? null,
    wesVersion:     node.wes_version ?? 2,
  };
}

// ── Factory: history point ────────────────────────────────────────────────────

export function buildReportFromHistory(opts: {
  nodeId:       string;
  hostname:     string;
  rawWes:       number | null;
  penalizedWes: number | null;
  thermalState: string;
  tsMs:         number;
  range:        string;
}): BenchmarkReport {
  const tcPct = thermalCostPct(opts.rawWes, opts.penalizedWes);
  return {
    generatedAt:    new Date().toISOString(),
    wickleeVersion: WICKLEE_VERSION,
    nodeId:         opts.nodeId,
    hostname:       opts.hostname,
    hardware:       null,
    os:             null,
    runtime:        'unknown',
    model:          null,
    quantization:   null,
    tokensPerSec:   null,
    watts:          null,
    rawWes:         opts.rawWes,
    penalizedWes:   opts.penalizedWes,
    thermalCostPct: tcPct,
    thermalState:   opts.thermalState,
    thermalSource:  null,
    wesVersion:     2,
    historyRange:   opts.range,
    historyTsMs:    opts.tsMs,
  };
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmt(v: number | null, decimals = 3, unit = ''): string {
  if (v == null) return '—';
  return `${v.toFixed(decimals)}${unit}`;
}

function fmtThermal(state: string | null, source: string | null): string {
  const s = state ?? 'Unknown';
  const src = source ? ` (${thermalSourceLabel(source)})` : '';
  return `${s}${src}`;
}

/**
 * Render the report as a clean, pasteable Markdown block.
 * Designed to drop directly into a blog post, GitHub issue, or arXiv comment.
 */
export function formatReportMarkdown(r: BenchmarkReport): string {
  const lines: string[] = [];

  lines.push('# Wicklee Benchmark Report');
  lines.push('');
  lines.push(`Generated:       ${r.generatedAt}`);
  lines.push(`Wicklee:         ${r.wickleeVersion}`);
  if (r.historyRange && r.historyTsMs) {
    lines.push(`History window:  ${r.historyRange.toUpperCase()} (point at ${new Date(r.historyTsMs).toISOString()})`);
  }
  lines.push('');

  lines.push('## Node');
  lines.push(`Node ID:         ${r.nodeId}`);
  if (r.hostname)  lines.push(`Hostname:        ${r.hostname}`);
  if (r.hardware)  lines.push(`Hardware:        ${r.hardware}`);
  if (r.os)        lines.push(`OS:              ${r.os}`);
  lines.push('');

  if (r.runtime !== 'unknown' || r.model) {
    lines.push('## Inference');
    if (r.runtime !== 'unknown') lines.push(`Runtime:         ${r.runtime === 'ollama' ? 'Ollama' : 'vLLM'}`);
    if (r.model)        lines.push(`Model:           ${r.model}`);
    if (r.quantization) lines.push(`Quantization:    ${r.quantization}`);
    if (r.tokensPerSec != null) lines.push(`Tokens/sec:      ${r.tokensPerSec.toFixed(1)}`);
    if (r.watts != null)        lines.push(`Board power:     ${r.watts.toFixed(1)} W`);
    lines.push('');
  }

  lines.push('## WES Score');
  lines.push(`Raw WES:         ${fmt(r.rawWes)}  (hardware ceiling — no thermal penalty)`);
  lines.push(`Penalized WES:   ${fmt(r.penalizedWes)}  (operational score)`);
  lines.push(`Thermal Cost:    ${r.thermalCostPct}%${r.thermalCostPct > 0 ? ' efficiency lost to thermal throttle' : ' (no thermal overhead)'}`);
  lines.push(`Thermal State:   ${fmtThermal(r.thermalState, r.thermalSource)}`);
  lines.push(`WES Version:     ${r.wesVersion}`);
  lines.push('');
  lines.push('---');
  lines.push(`*Generated by Wicklee ${r.wickleeVersion} · https://wicklee.dev*`);

  return lines.join('\n');
}

/**
 * Machine-readable JSON — same data, indented.
 */
export function formatReportJSON(r: BenchmarkReport): string {
  return JSON.stringify(r, null, 2);
}

// ── Download helper ───────────────────────────────────────────────────────────

export function downloadReport(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Build a safe filename for the report.
 * e.g.  wicklee-benchmark-WK-C133-2026-03-15.md
 */
export function reportFilename(r: BenchmarkReport, ext: 'md' | 'json'): string {
  const node = (r.hostname ?? r.nodeId).replace(/[^a-zA-Z0-9-_]/g, '-');
  const date = r.generatedAt.slice(0, 10);
  return `wicklee-benchmark-${node}-${date}.${ext}`;
}
