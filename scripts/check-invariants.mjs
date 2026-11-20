#!/usr/bin/env node
/**
 * check-invariants.mjs — turn the invariants CLAUDE.md states in prose into
 * checks that fail the build.
 *
 * Each invariant here was previously guarded only by a written instruction, and
 * at least one had already drifted when this script was written: an inline copy
 * of the WES colour ladder in Overview.tsx rendered grey below 1 where the
 * frozen scale says red.
 *
 *   node scripts/check-invariants.mjs
 */

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const fail = (check, msg) => failures.push({ check, msg });

const read = (p) => readFile(resolve(ROOT, p), 'utf8');
const readOptional = (p) => readFile(resolve(ROOT, p), 'utf8').catch(() => null);
const skipped = [];

async function walk(dir, exts) {
  const out = [];
  for (const e of await readdir(resolve(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      out.push(...(await walk(p, exts)));
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(p);
    }
  }
  return out;
}

// ── 1. The WES colour ladder lives in exactly one place ──────────────────────
//
// CLAUDE.md freezes the scale and lists the files that render it. The scale is
// implemented by wesColorClass(); anything that rebuilds the emerald → green →
// yellow → red ladder inline is a second implementation that can drift, and one
// did. Markup that merely *shows* each colour as a legend is allowed, listed
// explicitly below with the reason.
const LADDER_ALLOWED = new Set([
  // A legend documenting the scale to the reader. Renders each colour as a
  // swatch; carries no thresholds of its own.
  'src/site/DocsPage.tsx',
  // The implementation.
  'src/utils/wes.ts',
]);

async function checkWesLadder() {
  const files = await walk('src', ['.ts', '.tsx']);
  for (const f of files) {
    if (LADDER_ALLOWED.has(f)) continue;
    const src = await read(f);
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      // The WES ladder is four bands, and the light-green middle band is what
      // makes it identifiable: emerald → green-300 → yellow → red. Three-band
      // severity ramps (TTFT, latency, cost) share the emerald/yellow/red
      // vocabulary with their own thresholds and are not this scale.
      if (!line.includes('green-3')) return;
      const bands = ['emerald-4', 'green-3', 'yellow-4', 'red-4'].filter((b) => line.includes(b));
      if (bands.length >= 3 && /[?:]/.test(line)) {
        fail('wes-ladder',
          `${f}:${i + 1} rebuilds the WES colour ladder inline — call wesColorClass() instead`);
      }
    });
  }
}

// ── 2. The WES thresholds in wes.ts are the frozen ones ──────────────────────
async function checkWesThresholds() {
  const src = await read('src/utils/wes.ts');
  const fn = src.match(/export function wesColorClass[\s\S]*?\n}/);
  if (!fn) {
    fail('wes-thresholds', 'wesColorClass() not found in src/utils/wes.ts');
    return;
  }
  const want = [
    [/score\s*>\s*10\b/, 'score > 10 → emerald'],
    [/score\s*>=\s*3\b/, 'score >= 3 → green'],
    [/score\s*>=\s*1\b/, 'score >= 1 → yellow'],
  ];
  for (const [re, label] of want) {
    if (!re.test(fn[0])) {
      fail('wes-thresholds', `wesColorClass() no longer carries the frozen boundary: ${label}`);
    }
  }
  if (!/return 'text-red/.test(fn[0])) {
    fail('wes-thresholds',
      'wesColorClass() must fall through to red below 1 — a grey fallback reads as "no data"');
  }
}

// ── 3. MetricsPayload stays in sync with the frontend type ───────────────────
//
// A field the agent sends and SentinelMetrics lacks is dropped silently by the
// dashboard. Checked here so it fails the build instead.
const rustFields = (body) =>
  new Set([...body.matchAll(/^\s*(?:pub(?:\(crate\))?\s+)?([a-z_][a-z0-9_]*)\s*:/gm)].map((m) => m[1]));

async function findStruct(dir, name) {
  for (const f of await walk(dir, ['.rs'])) {
    const src = await read(f);
    const m = src.match(new RegExp(`struct\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
    if (m) return { file: f, fields: rustFields(m[1]) };
  }
  return null;
}

async function checkPayloadSync() {
  const agent = await findStruct('agent/src', 'MetricsPayload');
  if (!agent) {
    fail('payload-sync', 'could not locate struct MetricsPayload in agent/src');
    return;
  }

  const ts = await read('src/types.ts');
  const iface = ts.match(/interface\s+SentinelMetrics\s*\{([\s\S]*?)\n\}/);
  if (!iface) {
    fail('payload-sync', 'interface SentinelMetrics not found in src/types.ts');
    return;
  }
  const front = new Set(
    [...iface[1].matchAll(/^\s*([a-z_][a-z0-9_]*)\??\s*:/gm)].map((m) => m[1]),
  );

  for (const f of agent.fields) {
    if (!front.has(f)) {
      fail('payload-sync',
        `${f} is sent by the agent but missing from SentinelMetrics in src/types.ts`);
    }
  }

  // CLAUDE.md names the file that holds the serializer. It pointed at
  // agent/src/main.rs for months after the struct moved to metrics.rs.
  //
  // The guide is gitignored (.gitignore:61), so it exists on a developer's
  // machine and never in CI. This part therefore only ever runs locally —
  // which is the argument for checks over prose in miniature: the check is in
  // the repository and runs for everyone, the guide is on one machine.
  const guide = await readOptional('CLAUDE.md');
  if (guide === null) {
    skipped.push('payload-sync: CLAUDE.md is gitignored and absent here, so its file pointer was not checked');
    return;
  }
  const named = relative(ROOT, resolve(ROOT, agent.file));
  if (!guide.includes(named)) {
    fail('payload-sync',
      `CLAUDE.md does not mention ${named}, which is where struct MetricsPayload now lives`);
  }
}

// ── run ──────────────────────────────────────────────────────────────────────
await checkWesLadder();
await checkWesThresholds();
await checkPayloadSync();

if (failures.length) {
  console.error(`[check-invariants] ${failures.length} failure(s):\n`);
  for (const { check, msg } of failures) console.error(`  [${check}] ${msg}`);
  console.error('');
  process.exit(1);
}
for (const s of skipped) console.log(`[check-invariants] skipped — ${s}`);
console.log('[check-invariants] OK — WES ladder, WES thresholds, MetricsPayload sync.');
