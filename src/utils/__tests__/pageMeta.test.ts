/**
 * The site title lives in three places that cannot import each other:
 *
 *   - index.html          <title>, og:title, twitter:title (static, pre-bundle)
 *   - pageMeta.ts         DEFAULT_TITLE (what the SPA sets on route change)
 *   - BlogListing.tsx     restores the default on unmount — now imports it
 *
 * index.html is plain HTML and can't import the constant, so this test is the
 * link between them. Without it the two drift silently and only the version in
 * index.html is ever seen by Google or a Slack unfurl — which is exactly how
 * "Local AI inference" survived a copy sweep that changed every visible string
 * on the page.
 *
 * Also guards the public tier names: the pricing page sells Community / Team /
 * Enterprise, and a retired tier ("Pro", "Business") appearing in a public
 * offer is a promise we can no longer honour. Those names stay legal in
 * types.ts, where they identify grandfathered subscriptions.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_TITLE, DEFAULT_DESCRIPTION, STATIC_PAGE_META } from '../pageMeta';

const indexHtml = readFileSync(resolve(__dirname, '../../../index.html'), 'utf-8');

/** Decode the few entities `esc()` emits, so comparison is against real text. */
const unesc = (s: string) =>
  s.replaceAll('&quot;', '"').replaceAll('&#39;', "'")
   .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

const pick = (re: RegExp): string => {
  const m = indexHtml.match(re);
  if (!m) throw new Error(`index.html tag not found: ${re} — did the head change shape?`);
  return unesc(m[1]);
};

describe('index.html mirrors pageMeta', () => {
  it('<title> matches DEFAULT_TITLE', () => {
    expect(pick(/<title>([^<]*)<\/title>/)).toBe(DEFAULT_TITLE);
  });

  it('og:title matches DEFAULT_TITLE', () => {
    expect(pick(/<meta property="og:title" content="([^"]*)"/)).toBe(DEFAULT_TITLE);
  });

  it('twitter:title matches DEFAULT_TITLE', () => {
    expect(pick(/<meta name="twitter:title" content="([^"]*)"/)).toBe(DEFAULT_TITLE);
  });

  it('description matches DEFAULT_DESCRIPTION', () => {
    expect(pick(/<meta name="description" content="([^"]*)"/)).toBe(DEFAULT_DESCRIPTION);
  });
});

describe('public copy sells only live tiers', () => {
  const RETIRED = ['Pro tier', 'Business tier', 'Business free', 'Pro free'];

  it('no retired tier is named in page metadata', () => {
    for (const [path, meta] of Object.entries(STATIC_PAGE_META)) {
      for (const bad of RETIRED) {
        expect(`${meta.title} ${meta.description}`).not.toContain(bad);
      }
      expect(path).toBeTruthy();
    }
  });

  it('no retired tier is named in index.html', () => {
    for (const bad of RETIRED) expect(indexHtml).not.toContain(bad);
  });
});
