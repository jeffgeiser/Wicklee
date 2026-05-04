#!/usr/bin/env node
/**
 * sync-perplexity.mjs — keep public/perplexity_baseline.json in lockstep
 * with cloud/data/perplexity_baseline.json.
 *
 * Why two copies:
 * The cloud Rust binary embeds the file at compile time via
 *   include_str!("../data/perplexity_baseline.json")
 * which has to live inside the cloud Docker build context (cloud/).
 * The browser fetches it as a static asset from public/. Same content,
 * two locations.
 *
 * This script copies cloud/data/ → public/ (canonical → mirror) and
 * exits non-zero if the canonical is missing. Runs as `prebuild` in
 * package.json so every `npm run build` keeps them in sync. Run it
 * manually after editing the canonical:
 *
 *   node scripts/sync-perplexity.mjs
 *
 * To verify they match without copying (CI guard):
 *
 *   node scripts/sync-perplexity.mjs --check
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SRC = resolve(REPO_ROOT, 'cloud/data/perplexity_baseline.json');
const DST = resolve(REPO_ROOT, 'public/perplexity_baseline.json');

const checkOnly = process.argv.includes('--check');

let canonical;
try {
  canonical = await readFile(SRC, 'utf8');
} catch (e) {
  console.error(`[sync-perplexity] canonical missing: ${SRC}`);
  console.error(`[sync-perplexity] ${e.message}`);
  process.exit(1);
}

let mirror = null;
try {
  mirror = await readFile(DST, 'utf8');
} catch {
  // missing mirror is fine in copy mode; in check mode it's a divergence
}

if (checkOnly) {
  if (mirror !== canonical) {
    console.error('[sync-perplexity] DIVERGENCE: cloud/data/ and public/ are out of sync.');
    console.error('[sync-perplexity] Run `node scripts/sync-perplexity.mjs` to fix.');
    process.exit(2);
  }
  console.log('[sync-perplexity] OK — cloud/data and public/ match.');
  process.exit(0);
}

if (mirror === canonical) {
  // No-op, exit silently — nothing changed.
  process.exit(0);
}

await mkdir(dirname(DST), { recursive: true });
await writeFile(DST, canonical);
console.log(`[sync-perplexity] wrote ${DST.replace(REPO_ROOT + '/', '')} (${canonical.length} bytes)`);
