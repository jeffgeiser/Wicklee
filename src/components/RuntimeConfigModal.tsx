/**
 * RuntimeConfigModal — v0.9.0 Runtime Config Surface.
 *
 * Fetches GET /api/runtime-config?model=<name> from the local agent and
 * renders the cached launch-time configuration. Three runtimes supported:
 *   - Ollama: parameters table + collapsible template + system prompt
 *   - vLLM:   parameters table + process_args
 *   - llama.cpp: parameters table + process_args
 *
 * Privacy: template and system_prompt stay local — the localhost endpoint
 * serves them to the localhost dashboard. They are never pushed to cloud.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { X, Copy, Check, ChevronDown, ChevronRight } from 'lucide-react';

interface Props {
  modelName: string;
  onClose: () => void;
  agentBaseUrl?: string;
}

interface RuntimeConfig {
  model: string;
  runtime: string;
  captured_at_ms: number;
  context_length?: number;
  n_gpu_layers?: number;
  quantization?: string;
  parameter_count?: number;
  template?: string;
  system_prompt?: string;
  process_args?: string[];
  raw?: unknown;
}

const fmtNum = (n?: number): string => {
  if (n === undefined || n === null) return '—';
  return n.toLocaleString();
};

const fmtParamCount = (n?: number): string => {
  if (!n) return '—';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(2)}M`;
  return n.toLocaleString();
};

const runtimeBadgeClass = (runtime: string): string => {
  switch (runtime) {
    case 'ollama':   return 'bg-emerald-500/15 text-emerald-300 border-emerald-700/40';
    case 'vllm':     return 'bg-indigo-500/15 text-indigo-300 border-indigo-700/40';
    case 'llamacpp': return 'bg-amber-500/15 text-amber-300 border-amber-700/40';
    default:         return 'bg-gray-700/40 text-gray-300 border-gray-600/40';
  }
};

const buildMarkdown = (cfg: RuntimeConfig): string => {
  const lines: string[] = [];
  lines.push(`# Runtime Config — ${cfg.model}`);
  lines.push('');
  lines.push(`- Runtime: \`${cfg.runtime}\``);
  lines.push(`- Captured: ${new Date(cfg.captured_at_ms).toISOString()}`);
  if (cfg.context_length !== undefined) lines.push(`- Context length: ${cfg.context_length}`);
  if (cfg.parameter_count !== undefined) lines.push(`- Parameters: ${fmtParamCount(cfg.parameter_count)}`);
  if (cfg.quantization) lines.push(`- Quantization: ${cfg.quantization}`);
  if (cfg.n_gpu_layers !== undefined) lines.push(`- GPU layers: ${cfg.n_gpu_layers}`);
  if (cfg.process_args && cfg.process_args.length) {
    lines.push('');
    lines.push('## Process args');
    lines.push('```');
    lines.push(cfg.process_args.join(' '));
    lines.push('```');
  }
  if (cfg.template) {
    lines.push('');
    lines.push('## Template');
    lines.push('```');
    lines.push(cfg.template);
    lines.push('```');
  }
  if (cfg.system_prompt) {
    lines.push('');
    lines.push('## System prompt');
    lines.push('```');
    lines.push(cfg.system_prompt);
    lines.push('```');
  }
  return lines.join('\n');
};

const Row: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="flex items-center justify-between py-2 border-b border-gray-800 last:border-b-0">
    <span className="text-xs uppercase tracking-wide text-gray-500">{label}</span>
    <span className="text-sm font-mono text-gray-200">{value}</span>
  </div>
);

const Collapsible: React.FC<{
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}> = ({ title, defaultOpen = false, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-900/60 hover:bg-gray-800/60 text-left"
      >
        {open
          ? <ChevronDown className="w-4 h-4 text-gray-400" />
          : <ChevronRight className="w-4 h-4 text-gray-400" />}
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-300">{title}</span>
      </button>
      {open && (
        <pre className="px-3 py-2 bg-gray-950 text-xs font-mono text-gray-300 whitespace-pre-wrap break-words max-h-72 overflow-y-auto">
          {children}
        </pre>
      )}
    </div>
  );
};

const RuntimeConfigModal: React.FC<Props> = ({
  modelName,
  onClose,
  agentBaseUrl = 'http://localhost:7700',
}) => {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${agentBaseUrl}/api/runtime-config?model=${encodeURIComponent(modelName)}`)
      .then(async (resp) => {
        if (cancelled) return;
        if (resp.status === 404) {
          setError('No cached config for this model yet — the harvester hasn\'t observed a model change since startup. Try again in a few seconds.');
          setLoading(false);
          return;
        }
        if (!resp.ok) {
          setError(`Agent returned ${resp.status}`);
          setLoading(false);
          return;
        }
        const json = await resp.json();
        if (!cancelled) {
          setConfig(json);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(`Could not reach agent: ${e.message}`);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [modelName, agentBaseUrl]);

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleCopy = useCallback(() => {
    if (!config) return;
    navigator.clipboard.writeText(buildMarkdown(config)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }, [config]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-2xl bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl flex flex-col max-h-[80vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-widest text-blue-400 mb-0.5">
              Runtime Config
            </p>
            <p className="text-sm font-semibold text-white truncate">{modelName}</p>
            {config && (
              <p className="text-[11px] text-gray-500 mt-0.5">
                Captured {new Date(config.captured_at_ms).toLocaleString()}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-3">
            {config && (
              <button
                onClick={handleCopy}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-xs font-medium text-gray-300 hover:text-white transition-colors"
              >
                {copied
                  ? <Check className="w-3.5 h-3.5 text-green-400" />
                  : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied!' : 'Copy as Markdown'}
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white transition-colors"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {loading && (
            <div className="text-center text-sm text-gray-400 py-8">Loading…</div>
          )}

          {error && !loading && (
            <div className="text-sm text-amber-300 bg-amber-900/20 border border-amber-700/40 rounded-lg px-4 py-3">
              {error}
            </div>
          )}

          {config && !loading && (
            <>
              {/* Runtime badge */}
              <div className="flex items-center gap-2">
                <span className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded border ${runtimeBadgeClass(config.runtime)}`}>
                  {config.runtime}
                </span>
              </div>

              {/* Parameters table */}
              <div className="bg-gray-950/40 border border-gray-800 rounded-lg px-4 py-2">
                <Row label="Context length" value={fmtNum(config.context_length)} />
                <Row label="Parameters" value={fmtParamCount(config.parameter_count)} />
                <Row label="Quantization" value={config.quantization ?? '—'} />
                <Row
                  label={config.runtime === 'vllm' ? 'Tensor parallel' : 'GPU layers'}
                  value={config.n_gpu_layers !== undefined ? config.n_gpu_layers : '—'}
                />
              </div>

              {/* Ollama: template + system prompt */}
              {config.runtime === 'ollama' && (
                <>
                  {config.template && (
                    <Collapsible title="Template">{config.template}</Collapsible>
                  )}
                  {config.system_prompt && (
                    <Collapsible title="System prompt" defaultOpen>{config.system_prompt}</Collapsible>
                  )}
                </>
              )}

              {/* vLLM / llama.cpp: process args */}
              {(config.runtime === 'vllm' || config.runtime === 'llamacpp') && config.process_args && config.process_args.length > 0 && (
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-1.5">
                    Process args
                  </div>
                  <pre className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-xs font-mono text-gray-300 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                    {config.process_args.join(' ')}
                  </pre>
                </div>
              )}

              {/* Raw response (collapsible) */}
              {config.raw !== undefined && config.raw !== null && (
                <Collapsible title="Raw response">
                  {JSON.stringify(config.raw, null, 2)}
                </Collapsible>
              )}

              <p className="text-[10px] text-gray-600 leading-relaxed pt-2">
                Templates and system prompts stay on this device — they are not
                pushed to the cloud telemetry channel.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default RuntimeConfigModal;
