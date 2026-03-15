/**
 * BenchmarkReportModal — reproducible, citable WES snapshot.
 *
 * Displays the formatted benchmark report with:
 *   - Markdown preview in a monospace code block
 *   - Copy Markdown button (clipboard)
 *   - Download .md button
 *   - Download .json button (machine-readable)
 *   - Tab toggle: Markdown ↔ JSON
 */

import React, { useState } from 'react';
import { X, Copy, Check, Download, FileJson } from 'lucide-react';
import type { BenchmarkReport } from '../utils/benchmarkReport';
import {
  formatReportMarkdown,
  formatReportJSON,
  downloadReport,
  reportFilename,
} from '../utils/benchmarkReport';

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  report: BenchmarkReport;
  onClose: () => void;
}

// ── Copy button ───────────────────────────────────────────────────────────────

const CopyBtn: React.FC<{ text: string; label: string }> = ({ text, label }) => {
  const [copied, setCopied] = useState(false);
  const handle = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };
  return (
    <button
      onClick={handle}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700/60 text-xs font-medium text-gray-300 hover:text-white transition-colors"
    >
      {copied
        ? <Check className="w-3.5 h-3.5 text-green-400" />
        : <Copy className="w-3.5 h-3.5" />}
      {copied ? 'Copied!' : label}
    </button>
  );
};

// ── Component ─────────────────────────────────────────────────────────────────

const BenchmarkReportModal: React.FC<Props> = ({ report, onClose }) => {
  const [view, setView] = useState<'md' | 'json'>('md');

  const mdContent   = formatReportMarkdown(report);
  const jsonContent = formatReportJSON(report);
  const activeText  = view === 'md' ? mdContent : jsonContent;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-2xl bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl flex flex-col max-h-[90vh]">

        {/* ── Header ───────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-indigo-400 mb-0.5">
              Benchmark Report
            </p>
            <p className="text-sm font-semibold text-white">
              {report.hostname ?? report.nodeId}
            </p>
            {report.hardware && (
              <p className="text-xs text-gray-500 mt-0.5">{report.hardware}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-gray-600 hover:text-gray-300 transition-colors p-1"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ── WES summary strip ────────────────────────────────────────────── */}
        <div className="grid grid-cols-3 divide-x divide-gray-800 border-b border-gray-800 shrink-0">
          <div className="px-5 py-3 text-center">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1">Raw WES</p>
            <p className="font-telin text-lg text-white">
              {report.rawWes != null ? report.rawWes.toFixed(3) : '—'}
            </p>
          </div>
          <div className="px-5 py-3 text-center">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1">Penalized WES</p>
            <p className="font-telin text-lg text-indigo-400">
              {report.penalizedWes != null ? report.penalizedWes.toFixed(3) : '—'}
            </p>
          </div>
          <div className="px-5 py-3 text-center">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1">Thermal Cost</p>
            <p className={`font-telin text-lg ${
              report.thermalCostPct >= 40 ? 'text-red-400'    :
              report.thermalCostPct >= 25 ? 'text-orange-400' :
              report.thermalCostPct > 0   ? 'text-amber-400'  : 'text-green-400'
            }`}>
              {report.thermalCostPct > 0 ? `${report.thermalCostPct}%` : '0%'}
            </p>
          </div>
        </div>

        {/* ── Format tabs ──────────────────────────────────────────────────── */}
        <div className="flex items-center gap-0 px-5 pt-3 shrink-0">
          {([['md', 'Markdown'], ['json', 'JSON']] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setView(id)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-t-lg transition-colors ${
                view === id
                  ? 'bg-gray-800 text-white'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* ── Report content ───────────────────────────────────────────────── */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-3">
          <pre className="bg-gray-950 border border-gray-800 rounded-b-xl rounded-tr-xl p-4 text-xs font-mono text-gray-300 whitespace-pre overflow-x-auto leading-relaxed">
            {activeText}
          </pre>
        </div>

        {/* ── Actions ──────────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-t border-gray-800 shrink-0">
          <div className="flex flex-wrap gap-2">
            <CopyBtn
              text={activeText}
              label={view === 'md' ? 'Copy Markdown' : 'Copy JSON'}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => downloadReport(mdContent, reportFilename(report, 'md'))}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Download .md
            </button>
            <button
              onClick={() => downloadReport(jsonContent, reportFilename(report, 'json'))}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700/60 text-xs font-medium text-gray-300 hover:text-white transition-colors"
            >
              <FileJson className="w-3.5 h-3.5" />
              Download .json
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};

export default BenchmarkReportModal;
