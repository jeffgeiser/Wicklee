#!/usr/bin/env node
/**
 * generate-static-pages.mjs — build-time static HTML for the content routes.
 *
 * Runs as `postbuild` (after `vite build`). The SPA serves every route from
 * one index.html shell, which works for users and for Google (which renders
 * JS) but leaves non-JS crawlers — including the AI crawlers robots.txt
 * explicitly welcomes — and social link unfurlers (Slack/X/LinkedIn) looking
 * at an empty <div> with the landing page's metadata.
 *
 * This script emits real HTML for the routes whose content already lives in
 * markdown (the same sources the React pages fetch and render with marked):
 *
 *   dist/blog/index.html          — post listing
 *   dist/blog/{slug}/index.html   — each post, full article + BlogPosting JSON-LD
 *   dist/docs/index.html          — public/docs.md
 *   dist/metrics/index.html       — public/metrics.md
 *
 * and injects the landing page's real hero/feature content + SoftwareApplication
 * JSON-LD into dist/index.html, so the homepage isn't an empty #root to
 * crawlers, AI assistants, and link unfurlers.
 *
 * Each page is the built SPA shell with swapped metadata and the article HTML
 * pre-injected into #root — so crawlers get content, while a real browser
 * loads the bundle and React takes over (rendering the same markdown).
 *
 * nginx needs no changes: `try_files $uri $uri/ /index.html` already prefers
 * the emitted directory indexes over the SPA fallback.
 *
 * NOT a framework migration on purpose: the dashboard (95% of the app) has
 * zero SEO value. If the marketing surface ever grows substantially, revisit
 * with Astro for the public pages.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { marked } from 'marked';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DIST      = resolve(REPO_ROOT, 'agent/frontend/dist');
const BLOG_DIR  = resolve(REPO_ROOT, 'public/blog');

const ORIGIN    = 'https://wicklee.dev';
const SITE_NAME = 'Wicklee';

// ── Helpers ───────────────────────────────────────────────────────────────────

const esc = (s) => s
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/** Minimal frontmatter parse: title / date / description from a leading --- block. */
function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: {}, content: raw };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { fm, content: raw.slice(m[0].length) };
}

function slugToTitle(slug) {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Swap the shell's metadata for a page's own. Operates on the known tags the
 * source index.html carries — if a tag is missing the swap is a no-op, so a
 * verification step below asserts the critical ones landed.
 */
function applyMeta(shell, { title, description, path, ogType }) {
  const url = `${ORIGIN}${path}`;
  let html = shell
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/,         `$1${esc(description)}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/,        `$1${esc(title)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/,  `$1${esc(description)}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/,       `$1${esc(title)}$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${esc(description)}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/,          `$1${url}$2`)
    .replace(/(<meta property="og:type" content=")[^"]*(")/,         `$1${ogType ?? 'website'}$2`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/,               `$1${url}$2`);
  for (const probe of [`<title>${esc(title)}</title>`, `href="${url}"`]) {
    if (!html.includes(probe)) {
      throw new Error(`meta swap failed for ${path}: ${probe} not present — did index.html's head change shape?`);
    }
  }
  return html;
}

/**
 * Preload the lazily-imported page chunk a generated route will need. The
 * marketing pages became separate chunks (App.tsx React.lazy) to keep the
 * entry small; a prerendered route knows which one it is, so the fetch can
 * start with the HTML instead of after the entry executes. Best-effort.
 */
let pageChunks = null;
async function preloadPageChunk(html, prefix) {
  pageChunks ??= (await readdir(join(DIST, 'assets'))).filter(f => f.endsWith('.js'));
  const hits = pageChunks.filter(f => f.startsWith(prefix + '-'));
  if (hits.length !== 1) return html;
  return html.replace('</head>', `<link rel="modulepreload" crossorigin href="/assets/${hits[0]}">\n</head>`);
}

/** Inject JSON-LD + content into the shell's #root. */
function injectContent(html, { jsonLd, bodyHtml, wrapStyle }) {
  if (jsonLd) {
    // JSON-LD is data, not executable script — CSP script-src doesn't apply,
    // and crawlers read it from the raw HTML.
    html = html.replace('</head>', `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>\n</head>`);
  }
  if (bodyHtml) {
    const rootTag = '<div id="root" role="application" aria-label="Wicklee">';
    if (!html.includes(rootTag)) throw new Error('#root div not found in built index.html');

    // Content lives inside #root so React's createRoot().render() clears it once
    // the bundle loads. That is also why it used to FLASH: the block paints
    // immediately, the ~1.6 MB bundle lands a beat later, and the user sees a
    // narrower, nav-less version of the page shift away.
    //
    // The block has to keep doing two jobs, which rules out a plain display:none:
    //
    //   - Raw-HTML consumers (link unfurlers, LLM fetchers, curl, non-rendering
    //     crawlers) must find real content in the source. They don't run CSS or
    //     JS, so whatever we do here is invisible to them.
    //   - It is the graceful fallback when the bundle fails or the network
    //     stalls. Hiding it unconditionally turns a slow load into a blank page.
    //
    // public/prerender.js hides it on parse and puts it back after 4s if React
    // never mounted. A CSS delayed-reveal was tried first and rejected: it
    // depends on the document animation clock, which is suspended in some
    // environments, and where animations don't run the content would never
    // appear at all. See the header comment in public/prerender.js.
    // Fail loudly if the script isn't in the build. A 404 here degrades safely
    // (the block just stays visible, i.e. today's flash), so it would otherwise
    // slip through review as "works fine" while the fix is silently dead.
    if (!existsSync(join(DIST, 'prerender.js'))) {
      throw new Error('dist/prerender.js missing — the injected <script src="/prerender.js"> would 404 and the flash fix would be inert');
    }

    const style = wrapStyle ?? 'max-width:48rem;margin:0 auto;padding:3rem 1.5rem';
    html = html.replace(rootTag,
      `${rootTag}<div id="wk-prerender" class="blog-content" style="${style}">${bodyHtml}</div>` +
      '<script src="/prerender.js"></script>');
  }
  return html;
}

/**
 * Static HTML for the landing page (`/`).
 *
 * The homepage is the page dropped into HN/Reddit threads and read by AI
 * assistants / link unfurlers / non-JS crawlers — so it must carry real,
 * human-readable content in the raw HTML, not an empty #root that only fills
 * in after the JS bundle runs. React hydrates over this on load.
 *
 * Copy is mirrored verbatim from src/site/LandingPage.tsx (hero,
 * feature cards, section headers) — keep the two in sync; this is a marketing
 * surface that changes rarely. No claims here that aren't on the live page.
 */
function landingBodyHtml() {
  const steps = [
    ['Find — wicklee inspect', 'Named findings with the evidence behind every line: a model reloading at the runtime’s 4096 default after running larger, models clearing each other before their keep-alives expire, part of a model sitting outside accelerator memory, a model that has lost ground against its own measured baseline. A rule that could not run says so, with the reason.'],
    ['Fix — wicklee ready MODEL', 'Before a job starts rather than after it fails: ready now, requires loading, may require eviction, or cannot determine — with the memory headroom, where the footprint figure came from, and what a load would displace.'],
    ['Verify — wicklee verify FINDING', 'Re-runs the finding’s own test and prints both runs: medians, ranges, what differed. A verdict needs non-overlapping ranges, three receipts a side and medians at least 5% apart — otherwise it says no measurable change, and why.'],
  ];
  const stepHtml = steps.map(([t2, d]) =>
    `<li style="margin-bottom:1rem"><strong style="color:#f9fafb">${esc(t2)}</strong> — ${esc(d)}</li>`
  ).join('\n');

  return `
<main>
  <p style="font-size:0.8rem;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;color:#22d3ee;margin:0 0 0.75rem">Inference evidence and readiness intelligence</p>
  <h1 style="font-size:2rem;font-weight:800;color:#f9fafb;line-height:1.15">Stop guessing why your local AI is slow.</h1>
  <p style="font-size:1.05rem;color:#9ca3af;line-height:1.6;margin:1rem 0 1rem">
    Wicklee finds what is wrong with inference on your own hardware, tells you what will run
    right now without displacing what is already loaded, and measures whether a change actually
    helped. One binary, over localhost. No account.
  </p>
  <p style="margin:0 0 2rem">
    <code style="background:#1f2937;border:1px solid #374151;border-radius:0.375rem;padding:0.5rem 0.75rem;color:#f9fafb;font-family:ui-monospace,monospace;font-size:0.875rem">curl -fsSL https://wicklee.dev/install.sh | bash</code>
  </p>
  <h2 style="font-size:1.4rem;font-weight:700;color:#f9fafb;margin-top:2.5rem">Find it, fix it, prove the fix worked</h2>
  <ul style="list-style:none;padding:0;color:#9ca3af;line-height:1.6">
${stepHtml}
  </ul>
  <h2 style="font-size:1.4rem;font-weight:700;color:#f9fafb;margin-top:2.5rem">Every line says what kind of claim it is</h2>
  <p style="color:#9ca3af;line-height:1.6">
    OBSERVED is a transition, sample or receipt Wicklee recorded, and never states a cause.
    INFERRED is a likely explanation, always hedged, and only ever on top of something observed.
    VERIFIED means exact per-request measurements, with a median and a range. The labels are
    enforced where statements are built, so a finding whose statements are all inference is never
    shown. Anything that could not be checked is listed with the reason, which is why an empty
    result means every rule ran and found nothing rather than silence.
  </p>
  <h2 style="font-size:1.4rem;font-weight:700;color:#f9fafb;margin-top:2.5rem">What it will not do</h2>
  <p style="color:#9ca3af;line-height:1.6">
    The receipt route refuses any payload carrying prompt, response, messages or context, with a
    400 naming the field, rather than storing the body minus them. Only fingerprint and verify
    send inference requests, both ask first and both are local-only. Wicklee is not in the request
    path by default, and it does not route or schedule — it publishes evidence and leaves the
    decision to whatever is making it.
  </p>
  <h2 style="font-size:1.4rem;font-weight:700;color:#f9fafb;margin-top:2.5rem">Known wrong, and published</h2>
  <p style="color:#9ca3af;line-height:1.6">
    On a 16 GB M4, six ordered pairs of models with the first in use: readiness said the second
    would fit without displacing anything every time, and the runtime evicted the resident model
    in five of six. The decisive pair coexists in one load order and evicts in the other, so no
    safety margin reproduces it, and nothing was patched. Those answers carry
    coexistence: "unverified" until it is measured on more than one machine. Method and raw
    transcripts are in the repository.
  </p>
  <p style="margin-top:2.5rem">
    <a href="/docs" style="color:#60a5fa">Documentation</a> ·
    <a href="/blog" style="color:#60a5fa">Blog</a> ·
    <a href="https://github.com/jeffgeiser/Wicklee" style="color:#60a5fa">GitHub</a> ·
    <a href="/metrics-reference" style="color:#60a5fa">Metrics reference</a> ·
    <a href="/trust" style="color:#60a5fa">Trust &amp; security</a>
  </p>
</main>`.trim();
}

async function emit(routePath, html) {
  const dir = join(DIST, ...routePath.split('/').filter(Boolean));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), html);
  console.log(`[static-pages] ${routePath} → ${join(dir, 'index.html').replace(REPO_ROOT + '/', '')}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

let shell = await readFile(join(DIST, 'index.html'), 'utf8');

// 1. Landing page: add SoftwareApplication JSON-LD in place.
{
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE_NAME,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Linux, Windows',
    description: 'Evidence-based diagnostics, model readiness and performance verification for self-hosted AI inference. Find what is wrong, see what will run now without displacing a loaded model, and measure whether a change helped — one binary over localhost, for Ollama, vLLM and llama.cpp.',
    url: ORIGIN,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  };
  await writeFile(join(DIST, 'index.html'), injectContent(shell, {
    jsonLd,
    bodyHtml: landingBodyHtml(),
    wrapStyle: 'max-width:60rem;margin:0 auto;padding:3rem 1.5rem',
  }));
  console.log('[static-pages] / → JSON-LD + landing content injected into dist/index.html');
}

// 2. Blog posts.
const postFiles = (await readdir(BLOG_DIR)).filter(f => f.endsWith('.md'));
const posts = [];
for (const file of postFiles) {
  const slug = file.replace(/\.md$/, '');
  const raw  = await readFile(join(BLOG_DIR, file), 'utf8');
  const { fm, content } = parseFrontmatter(raw);
  const title       = fm.title || slugToTitle(slug);
  const description = fm.description || title;
  const date        = fm.date || null;
  posts.push({ slug, title, description, date });

  const article = await marked(content);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: title,
    description,
    ...(date ? { datePublished: date } : {}),
    author: { '@type': 'Organization', name: SITE_NAME, url: ORIGIN },
    publisher: { '@type': 'Organization', name: SITE_NAME, url: ORIGIN },
    mainEntityOfPage: `${ORIGIN}/blog/${slug}`,
  };
  let html = applyMeta(shell, {
    title: `${title} — ${SITE_NAME}`,
    description,
    path: `/blog/${slug}`,
    ogType: 'article',
  });
  // Posts conventionally open with their own `# h1` — only inject one when
  // the rendered article doesn't already start with it.
  const heading = /^\s*<h1/.test(article) ? '' : `<h1>${esc(title)}</h1>\n`;
  html = injectContent(html, { jsonLd, bodyHtml: `<article>${heading}${article}</article>` });
  html = await preloadPageChunk(html, 'BlogPost');
  await emit(`/blog/${slug}`, html);
}

// 3. Blog listing.
{
  posts.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  const list = posts.map(p =>
    `<li><a href="/blog/${p.slug}">${esc(p.title)}</a>${p.date ? ` <time datetime="${p.date}">${p.date}</time>` : ''}<p>${esc(p.description)}</p></li>`,
  ).join('\n');
  let html = applyMeta(shell, {
    title: `Blog — ${SITE_NAME}`,
    description: 'Engineering notes on local AI inference observability: efficiency scoring, ' +
                 'thermal throttling, quantization, and hardware-aware diagnostics.',
    path: '/blog',
  });
  html = injectContent(html, { bodyHtml: `<h1>Wicklee Blog</h1>\n<ul>\n${list}\n</ul>` });
  html = await preloadPageChunk(html, 'BlogListing');
  await emit('/blog', html);
}

// 4. Docs reference (markdown source the React page also renders).
//    /metrics is NOT prerendered; the reference page lives at /metrics-reference.
for (const page of [
  {
    src: 'public/docs.md',
    path: '/docs',
    title: `Documentation — ${SITE_NAME}`,
    description: 'Install the Wicklee agent, run inspect, ready and verify, and read the methodology behind ' +
                 'WES, Model Fit, Context Runway, and the 18 hardware observation patterns.',
  },
]) {
  const raw = await readFile(resolve(REPO_ROOT, page.src), 'utf8');
  const { content } = parseFrontmatter(raw);
  const body = await marked(content);
  let html = applyMeta(shell, page);
  html = injectContent(html, {
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'TechArticle',
      headline: page.title,
      description: page.description,
      mainEntityOfPage: `${ORIGIN}${page.path}`,
      publisher: { '@type': 'Organization', name: SITE_NAME, url: ORIGIN },
    },
    bodyHtml: `<article>${body}</article>`,
  });
  html = await preloadPageChunk(html, 'DocsPage');
  await emit(page.path, html);
}

console.log(`[static-pages] done — ${posts.length} post(s) + listing + docs + landing content.`);
