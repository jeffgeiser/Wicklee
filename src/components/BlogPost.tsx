import React, { useState, useEffect } from 'react';
import { marked } from 'marked';
import Logo from './Logo';
import { parseFrontmatter, slugToTitle, formatDate } from '../utils/parseFrontmatter';

interface BlogPostProps {
  slug: string;
  onNavigate: (path: string) => void;
  onSignIn: () => void;
  onSignUp: () => void;
}

const BlogPost: React.FC<BlogPostProps> = ({ slug, onNavigate, onSignIn, onSignUp }) => {
  const [html, setHtml] = useState('');
  const [title, setTitle] = useState('');
  const [date, setDate] = useState<string | undefined>();
  const [tags, setTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const fetchPost = async () => {
      try {
        const res = await fetch(`/blog/${slug}.md`);
        if (!res.ok) {
          if (!cancelled) setNotFound(true);
          return;
        }
        const raw = await res.text();
        const { frontmatter, content } = parseFrontmatter(raw);

        const resolvedTitle = frontmatter.title?.trim() || slugToTitle(slug);
        const resolvedDate = frontmatter.date;
        const resolvedTags = frontmatter.tags?.length ? frontmatter.tags : [];
        const description = frontmatter.description?.trim() || '';

        if (!cancelled) {
          setTitle(resolvedTitle);
          setDate(resolvedDate);
          setTags(resolvedTags);

          // Update page title + SEO meta
          document.title = `${resolvedTitle} — Wicklee`;

          const setMeta = (sel: string, attr: string, val: string) => {
            let el = document.head.querySelector(sel) as HTMLMetaElement | null;
            if (!el) {
              el = document.createElement('meta');
              const parts = sel.match(/\[(.+?)="(.+?)"\]/);
              if (parts) el.setAttribute(parts[1], parts[2]);
              document.head.appendChild(el);
            }
            el.setAttribute(attr, val);
          };

          setMeta('meta[name="description"]', 'content', description || resolvedTitle);
          setMeta('meta[property="og:title"]', 'content', resolvedTitle);
          setMeta('meta[property="og:description"]', 'content', description || resolvedTitle);
          setMeta('meta[name="twitter:title"]', 'content', resolvedTitle);
          setMeta('meta[name="twitter:description"]', 'content', description || resolvedTitle);

          let canonical = document.head.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
          if (!canonical) {
            canonical = document.createElement('link');
            canonical.setAttribute('rel', 'canonical');
            document.head.appendChild(canonical);
          }
          canonical.setAttribute('href', `https://wicklee.dev/blog/${slug}`);

          const rendered = await marked(content);
          setHtml(rendered);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setNotFound(true);
      }
    };

    fetchPost();

    return () => {
      cancelled = true;
      // Restore defaults on unmount
      document.title = 'Wicklee — Local AI inference, finally observable.';
      const canonical = document.head.querySelector('link[rel="canonical"]');
      if (canonical) canonical.remove();
    };
  }, [slug]);

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
          <Logo className="text-3xl" connectionState="connected" />
        </button>
        <div className="flex items-center gap-4 sm:gap-8">
          <button onClick={() => onNavigate('/docs')} className="hidden sm:block text-sm font-medium text-gray-400 hover:text-white transition-colors">Documentation</button>
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
        {/* Back link */}
        <button
          onClick={() => onNavigate('/blog')}
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-300 transition-colors mb-10"
        >
          ← Blog
        </button>

        {loading && !notFound && (
          <div className="animate-pulse space-y-4">
            <div className="h-9 bg-gray-800 rounded w-3/4" />
            <div className="h-4 bg-gray-800 rounded w-1/4" />
            <div className="mt-8 space-y-3">
              <div className="h-4 bg-gray-800 rounded w-full" />
              <div className="h-4 bg-gray-800 rounded w-5/6" />
              <div className="h-4 bg-gray-800 rounded w-4/5" />
            </div>
          </div>
        )}

        {notFound && (
          <div className="text-center py-20">
            <p className="text-2xl font-bold text-white mb-3">Post not found</p>
            <p className="text-gray-500 mb-8">This post may have moved or been removed.</p>
            <button
              onClick={() => onNavigate('/blog')}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold rounded-xl transition-all"
            >
              Back to Blog
            </button>
          </div>
        )}

        {!loading && !notFound && (
          <>
            <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight mb-4 leading-tight">
              {title}
            </h1>

            <div className="flex flex-wrap items-center gap-3 mb-8">
              {date && (
                <span className="text-sm text-gray-500">{formatDate(date)}</span>
              )}
              {tags.length > 0 && (
                <>
                  {date && <span className="text-gray-700">·</span>}
                  <div className="flex flex-wrap gap-2">
                    {tags.map(tag => (
                      <span
                        key={tag}
                        className="px-2 py-0.5 bg-blue-500/10 border border-blue-500/20 rounded-full text-xs text-blue-400"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>

            <hr className="border-gray-800 mb-10" />

            <div
              className="blog-content"
              dangerouslySetInnerHTML={{ __html: html }}
            />

            <hr className="border-gray-800 mt-16 mb-8" />

            <p className="text-sm text-gray-600">
              Written by Jeff Geiser · Wicklee
            </p>
          </>
        )}
      </main>
    </div>
  );
};

export default BlogPost;
