import React, { useState, useEffect } from 'react';
import Logo from './Logo';
import {
  parseFrontmatter, slugToTitle, stripMarkdown, formatDate,
} from '../utils/parseFrontmatter';

interface PostCard {
  slug: string;
  title: string;
  date?: string;
  description?: string;
  tags?: string[];
  dateMs: number;
}

interface BlogListingProps {
  onNavigate: (path: string) => void;
  onSignIn: () => void;
  onSignUp: () => void;
}

const BlogListing: React.FC<BlogListingProps> = ({ onNavigate, onSignIn, onSignUp }) => {
  const [posts, setPosts] = useState<PostCard[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    document.title = 'Blog — Wicklee';
    return () => { document.title = 'Wicklee — Local AI inference, finally observable.'; };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const fetchAll = async () => {
      // Fetch the manifest — /blog/index.json is the single source of truth.
      // To publish a new post: add slug to index.json + drop the .md in /public/blog/.
      let slugs: string[] = [];
      try {
        const idx = await fetch('/blog/index.json');
        if (idx.ok) {
          const data = await idx.json();
          slugs = Array.isArray(data.posts) ? data.posts : [];
        }
      } catch {
        slugs = [];
      }

      const results: PostCard[] = [];

      for (const slug of slugs) {
        try {
          const res = await fetch(`/blog/${slug}.md`);
          if (!res.ok) continue;
          const raw = await res.text();
          const { frontmatter, content } = parseFrontmatter(raw);

          // Title fallback: de-slug filename
          const title = frontmatter.title?.trim() || slugToTitle(slug);

          // Description fallback: first ~150 chars of body, stripped
          let description = frontmatter.description?.trim() || undefined;
          if (!description) {
            const stripped = stripMarkdown(content);
            if (stripped.length > 0) {
              if (stripped.length <= 150) {
                description = stripped;
              } else {
                const cut = stripped.slice(0, 150);
                const lastSpace = cut.lastIndexOf(' ');
                description = cut.slice(0, lastSpace > 0 ? lastSpace : 150) + '…';
              }
            }
          }

          // Date — parse for sorting; 0 means sort last
          let dateMs = 0;
          if (frontmatter.date) {
            const d = new Date(frontmatter.date);
            if (!isNaN(d.getTime())) dateMs = d.getTime();
          }

          results.push({
            slug,
            title,
            date: frontmatter.date,
            description,
            tags: frontmatter.tags?.length ? frontmatter.tags : undefined,
            dateMs,
          });
        } catch {
          // Skip unreadable posts silently
        }
      }

      // Newest first; missing dates sort last
      results.sort((a, b) => {
        if (!a.dateMs && !b.dateMs) return 0;
        if (!a.dateMs) return 1;
        if (!b.dateMs) return -1;
        return b.dateMs - a.dateMs;
      });

      if (!cancelled) {
        setPosts(results);
        setLoading(false);
      }
    };

    fetchAll();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 selection:bg-blue-600 selection:text-white">
      {/* Background decor */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-600/10 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[30%] h-[30%] bg-cyan-400/10 blur-[120px] rounded-full" />
      </div>

      {/* Nav */}
      <nav className="max-w-7xl mx-auto px-4 sm:px-8 py-5 sm:py-8 flex items-center justify-between relative z-10">
        <button onClick={() => onNavigate('/')} className="cursor-pointer">
          <Logo className="text-3xl" active={true} />
        </button>
        <div className="flex items-center gap-4 sm:gap-8">
          <a href="#" className="hidden sm:block text-sm font-medium text-gray-400 hover:text-white transition-colors">Documentation</a>
          <button
            onClick={() => onNavigate('/blog')}
            className="hidden sm:block text-sm font-medium text-white transition-colors"
          >
            Blog
          </button>
          <a
            href="https://github.com/jeffgeiser/Wicklee"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:block text-sm font-medium text-gray-400 hover:text-white transition-colors"
          >
            GitHub
          </a>
          <button
            onClick={onSignIn}
            className="px-4 sm:px-6 py-2 border border-gray-700 hover:border-gray-500 text-white text-sm font-bold rounded-xl transition-all"
          >
            Sign In
          </button>
          <button
            onClick={onSignUp}
            className="px-4 sm:px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold rounded-xl transition-all shadow-lg shadow-blue-500/20"
          >
            Get Started
          </button>
        </div>
      </nav>

      {/* Content */}
      <main className="max-w-3xl mx-auto px-4 sm:px-8 py-12 pb-32 relative z-10">
        <div className="mb-12">
          <h1 className="text-4xl sm:text-5xl font-extrabold text-white tracking-tight mb-4">Blog</h1>
          <p className="text-lg text-gray-400 leading-relaxed max-w-xl">
            Thinking out loud about local AI inference, fleet operations, and the metrics that matter.
          </p>
        </div>

        {loading ? (
          <div className="space-y-6">
            {[1, 2].map(i => (
              <div key={i} className="animate-pulse bg-gray-900 border border-gray-800 rounded-2xl p-6">
                <div className="h-5 bg-gray-800 rounded w-2/3 mb-3" />
                <div className="h-3 bg-gray-800 rounded w-1/4 mb-4" />
                <div className="h-3 bg-gray-800 rounded w-full mb-2" />
                <div className="h-3 bg-gray-800 rounded w-4/5" />
              </div>
            ))}
          </div>
        ) : posts.length === 0 ? (
          <div className="text-center py-20 text-gray-500">
            First post coming soon — subscribe to be notified.
          </div>
        ) : (
          <div className="space-y-6">
            {posts.map(post => (
              <article
                key={post.slug}
                className="bg-gray-900 border border-gray-800 rounded-2xl p-6 hover:border-blue-500/30 transition-all group cursor-pointer"
                onClick={() => onNavigate(`/blog/${post.slug}`)}
              >
                <h2 className="text-xl font-bold text-white mb-2 group-hover:text-blue-400 transition-colors">
                  {post.title}
                </h2>
                {post.date && (
                  <p className="text-sm text-gray-500 mb-3">{formatDate(post.date)}</p>
                )}
                {post.description && (
                  <p className="text-gray-400 text-sm leading-relaxed mb-4">{post.description}</p>
                )}
                {post.tags && post.tags.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {post.tags.map(tag => (
                      <span
                        key={tag}
                        className="px-2 py-0.5 bg-blue-500/10 border border-blue-500/20 rounded-full text-xs text-blue-400"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </main>
    </div>
  );
};

export default BlogListing;
