/**
 * Copy-to-clipboard buttons — one shared copy of each variant.
 *
 *   CopyButton        icon-only. `variant="plain"` (default) inherits text
 *                     colour from `className`; `variant="compact"` is the
 *                     smaller padded icon used on the model-discovery cards.
 *   RowCopyButton     "Copy pull" chip on discovery table rows. Stops click
 *                     propagation so it never toggles the row's expand state.
 *   LabeledCopyButton monospace label + icon chip (observation card actions).
 *
 * All three share copyToClipboard(): the async Clipboard API, falling back to
 * a hidden-textarea execCommand for non-secure contexts. The "copied" state
 * only shows once the copy has actually happened.
 */

import React, { useState, useCallback } from 'react';
import { Copy, Check } from 'lucide-react';

const COPIED_RESET_MS = 2000;

function copyWithTextarea(text: string): boolean {
  try {
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the textarea fallback */ }
  return copyWithTextarea(text);
}

/** Copies `text` and flips `copied` to true for COPIED_RESET_MS. */
function useCopy(text: string, resetMs = COPIED_RESET_MS) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void copyToClipboard(text).then(ok => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), resetMs);
    });
  }, [text, resetMs]);
  return { copied, copy };
}

export const CopyButton: React.FC<{
  text: string;
  className?: string;
  title?: string;
  variant?: 'plain' | 'compact';
}> = ({ text, className = '', title = 'Copy', variant = 'plain' }) => {
  const { copied, copy } = useCopy(text);
  if (variant === 'compact') {
    return (
      <button type="button" onClick={copy} title={title} className={`p-1 rounded transition-colors hover:bg-gray-700/60 ${className}`}>
        {copied
          ? <Check className="w-3 h-3 text-emerald-400" />
          : <Copy className="w-3 h-3 text-gray-500 hover:text-gray-300" />}
      </button>
    );
  }
  return (
    <button type="button" onClick={copy} title={title} aria-label={title} className={`transition-colors ${className}`}>
      {copied
        ? <Check className="w-3.5 h-3.5 text-green-400" />
        : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
};

export const RowCopyButton: React.FC<{ text: string; title?: string }> = ({ text, title }) => {
  const { copied, copy } = useCopy(text, 1500);
  const handle = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    copy();
  };
  return (
    <button
      onClick={handle}
      title={title ?? 'Copy pull command'}
      className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border transition-colors ${
        copied
          ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
          : 'bg-gray-800/60 border-gray-700/60 text-gray-400 hover:text-cyan-300 hover:border-cyan-500/30'
      }`}
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      <span>{copied ? 'Copied!' : 'Copy pull'}</span>
    </button>
  );
};

export const LabeledCopyButton: React.FC<{ text: string; label: string }> = ({ text, label }) => {
  const { copied, copy } = useCopy(text);
  return (
    <button
      onClick={copy}
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-700
                 border border-gray-700 hover:border-gray-600 transition-colors group"
    >
      <code className="text-[10px] font-mono text-gray-300 group-hover:text-white truncate max-w-[180px]">
        {label}
      </code>
      {copied
        ? <Check  className="w-3 h-3 text-green-400 shrink-0" />
        : <Copy   className="w-3 h-3 text-gray-500 group-hover:text-gray-300 shrink-0" />
      }
    </button>
  );
};
