import fs from 'fs';
import path from 'path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// ── Blog index generator ──────────────────────────────────────────────────────
// Reads every *.md in public/blog/, extracts the `date` frontmatter field for
// sorting, and writes public/blog/index.json (newest first).
//
// Runs at buildStart (vite build) and configureServer (vite dev), so the
// manifest is always in sync. Publishing a new post = drop the .md file and
// commit — no manual registry edits required.

const BLOG_DIR = path.resolve(__dirname, 'public/blog');

function generateBlogIndex() {
  let files: string[];
  try {
    files = fs.readdirSync(BLOG_DIR).filter(f => f.endsWith('.md'));
  } catch {
    return; // directory doesn't exist yet — skip silently
  }

  type Entry = { slug: string; dateMs: number };
  const entries: Entry[] = [];

  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
    try {
      const raw = fs.readFileSync(path.join(BLOG_DIR, file), 'utf-8');
      // Pull `date: YYYY-MM-DD` (or ISO) from YAML frontmatter block
      const m = raw.match(/^---[\s\S]*?\ndate:\s*(\S+)/m);
      let dateMs = 0;
      if (m) {
        const d = new Date(m[1]);
        if (!isNaN(d.getTime())) dateMs = d.getTime();
      }
      entries.push({ slug, dateMs });
    } catch {
      entries.push({ slug, dateMs: 0 });
    }
  }

  // Newest first; undated posts sort last
  entries.sort((a, b) => {
    if (!a.dateMs && !b.dateMs) return 0;
    if (!a.dateMs) return 1;
    if (!b.dateMs) return -1;
    return b.dateMs - a.dateMs;
  });

  const manifest = {
    _agent_note:
      'Machine-readable blog manifest. GET /blog/index.json to enumerate all published posts. ' +
      'Each slug maps to /blog/{slug}.md — standard markdown with optional YAML frontmatter ' +
      '(title, date, description, tags). Auto-generated at build/dev time from public/blog/*.md — ' +
      'do not edit manually.',
    posts: entries.map(e => e.slug),
  };

  fs.writeFileSync(
    path.join(BLOG_DIR, 'index.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );

  console.log(`[blog-index] ${entries.length} post(s) → public/blog/index.json`);
}

const blogIndexPlugin = (): Plugin => ({
  name: 'blog-index',
  // Runs during both `vite build` and `vite dev`
  buildStart() { generateBlogIndex(); },
  configureServer() { generateBlogIndex(); },
});

// ─────────────────────────────────────────────────────────────────────────────

export default defineConfig(() => {
  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
      // Dev-mode proxy: forwards /api and /ws to the local Sentinel on 7700
      // so `npm run dev` works alongside `cargo run` without CORS issues.
      proxy: {
        // Auth routes go to the cloud backend (port 8080 locally).
        // Must be listed before the generic /api rule so Vite matches it first.
        '/api/auth': { target: 'http://localhost:8080', changeOrigin: true },
        '/api': 'http://localhost:7700',
        '/ws':  { target: 'ws://localhost:7700', ws: true },
      },
    },
    build: {
      // Output directly into the agent crate so RustEmbed picks it up at
      // compile time via #[folder = "frontend/dist"].
      outDir: 'agent/frontend/dist',
      emptyOutDir: true,
      // Dashboard embeds Recharts + React; single-chunk is fine for a local
      // binary where there's no CDN or HTTP/2 multiplexing benefit to splitting.
      chunkSizeWarningLimit: 1000,
    },
    plugins: [blogIndexPlugin(), tailwindcss(), react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
  };
});
