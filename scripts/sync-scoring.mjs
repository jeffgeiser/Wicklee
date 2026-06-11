#!/usr/bin/env node
/**
 * sync-scoring.mjs — keep agent/src/scoring.rs and cloud/src/scoring.rs in
 * lockstep with the canonical shared/scoring.rs.
 *
 * Why three copies:
 * A cargo path dependency can't be used because the cloud's Railway Docker
 * build context is `cloud/` only — `../shared` is invisible to its deploys.
 * Both binaries therefore carry a byte-identical mirror of the module. Same
 * pattern as sync-perplexity.mjs.
 *
 * Edit ONLY shared/scoring.rs, then run:
 *
 *   node scripts/sync-scoring.mjs
 *
 * To verify the mirrors match without copying (CI guard):
 *
 *   node scripts/sync-scoring.mjs --check
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SRC = resolve(REPO_ROOT, 'shared/scoring.rs');
const MIRRORS = [
  resolve(REPO_ROOT, 'agent/src/scoring.rs'),
  resolve(REPO_ROOT, 'cloud/src/scoring.rs'),
];

const checkOnly = process.argv.includes('--check');

let canonical;
try {
  canonical = await readFile(SRC, 'utf8');
} catch (e) {
  console.error(`[sync-scoring] canonical missing: ${SRC}`);
  console.error(`[sync-scoring] ${e.message}`);
  process.exit(1);
}

let divergent = false;
for (const dst of MIRRORS) {
  let mirror = null;
  try {
    mirror = await readFile(dst, 'utf8');
  } catch {
    // missing mirror is fine in copy mode; in check mode it's a divergence
  }

  if (mirror === canonical) continue;

  if (checkOnly) {
    console.error(`[sync-scoring] DIVERGED: ${dst}`);
    console.error('[sync-scoring] edit shared/scoring.rs and run: node scripts/sync-scoring.mjs');
    divergent = true;
  } else {
    await writeFile(dst, canonical);
    console.log(`[sync-scoring] wrote ${dst}`);
  }
}

if (checkOnly) {
  if (divergent) process.exit(1);
  console.log('[sync-scoring] OK — agent and cloud mirrors match shared/scoring.rs.');
} else {
  console.log('[sync-scoring] done.');
}
