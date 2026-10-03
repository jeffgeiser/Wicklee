/**
 * Fixed bottom banner for the demo build — names the synthetic fleet and
 * carries the install one-liner. The only demo-specific chrome.
 */

import React, { useState } from 'react';

const INSTALL = 'curl -fsSL https://wicklee.dev/install.sh | bash';

const DemoBanner: React.FC = () => {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(INSTALL).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="fixed bottom-0 inset-x-0 z-50 bg-indigo-950/95 backdrop-blur border-t border-indigo-500/40 px-4 py-2.5 flex items-center justify-center gap-3 flex-wrap">
      <span className="text-[11px] text-indigo-200">
        <strong className="text-white">Synthetic demo fleet</strong> — six imaginary nodes, real product. Watch mini-m2 throttle and edge-4060 drop.
      </span>
      <button
        onClick={copy}
        className="text-[11px] font-mono px-3 py-1 rounded-lg bg-gray-900 border border-indigo-500/40 text-indigo-100 hover:border-indigo-400 transition-colors"
        title="Copy install command"
      >
        {copied ? '✓ copied' : INSTALL}
      </button>
      <a
        href="https://wicklee.dev"
        className="text-[11px] font-semibold text-indigo-300 hover:text-white transition-colors"
      >
        wicklee.dev →
      </a>
    </div>
  );
};

export default DemoBanner;
