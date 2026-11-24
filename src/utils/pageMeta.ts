/**
 * Per-route document metadata — title, description, canonical, OpenGraph.
 *
 * Every public route swaps these client-side on navigation (Google renders
 * JS, so this fixes duplicate titles/snippets in the index), and the
 * build-time prerender (scripts/generate-static-pages.mjs) bakes the same
 * values into static HTML for the content routes so non-JS crawlers and
 * link unfurlers (Slack/X/LinkedIn) see them too.
 *
 * Keep STATIC_PAGE_META in sync with the route table in App.tsx and the
 * sitemap plugin in vite.config.ts.
 */

const SITE_ORIGIN = 'https://wicklee.dev';
const SITE_NAME   = 'Wicklee';

/** Social/link-preview card (1200×630). Regenerate via scripts/gen-og-image.mjs. */
const OG_IMAGE_URL = `${SITE_ORIGIN}/og-image.png`;

export const DEFAULT_TITLE       = 'Wicklee — stop guessing why your local AI is slow.';
export const DEFAULT_DESCRIPTION =
  'A local agent that tells your agents, and you, what is wrong with self-hosted AI inference, ' +
  'what will run now without displacing a loaded model, and whether a change helped. ' +
  'Over MCP, HTTP and the CLI. One binary, for Ollama, vLLM and llama.cpp.';

export interface PageMeta {
  title:       string;
  description: string;
  /** Path used for the canonical URL + og:url, e.g. "/blog/some-post". */
  path:        string;
  /** OpenGraph type — "article" for blog posts, "website" otherwise. */
  ogType?:     'website' | 'article';
}

function upsertMeta(selector: string, attrName: string, attrValue: string, content: string) {
  let el = document.head.querySelector(selector) as HTMLMetaElement | null;
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attrName, attrValue);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

/** Apply a page's metadata to the live document. Idempotent. */
export function setPageMeta(meta: PageMeta): void {
  const url = `${SITE_ORIGIN}${meta.path}`;

  document.title = meta.title;

  upsertMeta('meta[name="description"]',         'name',     'description',         meta.description);
  upsertMeta('meta[property="og:title"]',        'property', 'og:title',            meta.title);
  upsertMeta('meta[property="og:description"]',  'property', 'og:description',      meta.description);
  upsertMeta('meta[property="og:url"]',          'property', 'og:url',              url);
  upsertMeta('meta[property="og:type"]',         'property', 'og:type',             meta.ogType ?? 'website');
  upsertMeta('meta[property="og:site_name"]',    'property', 'og:site_name',        SITE_NAME);
  upsertMeta('meta[property="og:image"]',        'property', 'og:image',            OG_IMAGE_URL);
  upsertMeta('meta[name="twitter:card"]',        'name',     'twitter:card',        'summary_large_image');
  upsertMeta('meta[name="twitter:title"]',       'name',     'twitter:title',       meta.title);
  upsertMeta('meta[name="twitter:description"]', 'name',     'twitter:description', meta.description);
  upsertMeta('meta[name="twitter:image"]',       'name',     'twitter:image',       OG_IMAGE_URL);

  let canonical = document.head.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
  if (!canonical) {
    canonical = document.createElement('link');
    canonical.setAttribute('rel', 'canonical');
    document.head.appendChild(canonical);
  }
  canonical.setAttribute('href', url);
}

/**
 * Metadata for the static public routes. Blog posts resolve theirs from
 * frontmatter in BlogPost.tsx; dashboard tabs all live under "/" and keep
 * the landing metadata.
 */
export const STATIC_PAGE_META: Record<string, PageMeta> = {
  '/': {
    title:       DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    path:        '/',
  },
  '/docs': {
    title:       'Documentation — Wicklee',
    description: 'Install the Wicklee agent, run inspect, ready and verify, and read the methodology behind ' +
                 'WES, Model Fit, Context Runway, and the 18 hardware observation patterns.',
    path:        '/docs',
  },
  '/metrics-reference': {
    title:       'Metrics Reference — Wicklee',
    description: 'Every metric Wicklee reports, defined: WES, thermal penalties, Model Fit, ' +
                 'tok/s probes, memory pressure, and the formulas behind them.',
    path:        '/metrics-reference',
  },
  '/metrics': {
    title:       'Metrics Reference — Wicklee',
    description: 'Every metric Wicklee reports, defined: WES, thermal penalties, Model Fit, ' +
                 'tok/s probes, memory pressure, and the formulas behind them.',
    path:        '/metrics-reference',
  },
  '/blog': {
    title:       'Blog — Wicklee',
    description: 'Engineering notes on local AI inference observability: efficiency scoring, ' +
                 'thermal throttling, quantization, and hardware-aware diagnostics.',
    path:        '/blog',
  },
  '/trust': {
    title:       'Trust & Security — Wicklee',
    description: 'What the agent reads, what it stores, and what it never does: it makes no ' +
                 'outbound connection, and prompts and responses are never read.',
    path:        '/trust',
  },
  '/terms': {
    title:       'Terms of Service — Wicklee',
    description: 'Wicklee terms of service.',
    path:        '/terms',
  },
  '/privacy': {
    title:       'Privacy Policy — Wicklee',
    description: 'Wicklee privacy policy.',
    path:        '/privacy',
  },
};

/** Normalize a location path for STATIC_PAGE_META lookup ("/docs/" → "/docs"). */
export function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}
