/**
 * TrustPage — /trust — what the agent does and does not send.
 *
 * Answers the question a security reviewer actually asks about a binary
 * running on their hardware: what leaves this machine. The answer is nothing:
 * there is no hosted service, and the agent makes no outbound connections.
 * Every claim here is behaviour of the agent in the current release.
 */

import React, { useEffect } from 'react';
import { ArrowLeft, ShieldCheck, Lock, Eye, EyeOff, Network } from 'lucide-react';
import { CONTACT_EMAIL, mailto } from './utils/contact';

interface TrustPageProps {
  onNavigate: (path: string) => void;
}

const Section: React.FC<{ icon: React.ElementType; title: string; children: React.ReactNode }> =
  ({ icon: Icon, title, children }) => (
    <section className="space-y-4">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
          <Icon className="w-3.5 h-3.5 text-emerald-400" />
        </span>
        <h2 className="text-lg font-bold text-white">{title}</h2>
      </div>
      {children}
    </section>
  );

const TrustPage: React.FC<TrustPageProps> = ({ onNavigate }) => {
  useEffect(() => { window.scrollTo(0, 0); }, []);

  return (
    <div className="min-h-screen bg-gray-900 text-gray-300">
      <div className="border-b border-gray-700 bg-gray-900/80 backdrop-blur-md sticky top-0 z-20">
        <div className="max-w-4xl mx-auto px-4 sm:px-8 py-4 flex items-center gap-4">
          <button onClick={() => onNavigate('/')} className="text-gray-500 hover:text-white transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <span className="text-white font-bold text-lg cursor-pointer" onClick={() => onNavigate('/')}>wicklee</span>
          <span className="text-xs text-gray-600 uppercase tracking-widest ml-2">Trust &amp; Security</span>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-8 py-12 space-y-14">
        <div className="space-y-3">
          <h1 className="text-3xl font-bold text-white">Sovereign by architecture, not by policy</h1>
          <p className="text-gray-400 leading-relaxed max-w-2xl">
            Wicklee reads the hardware and runtime state your AI runs on — never the AI's content.
            This page is the complete answer to "what leaves my machine." The answer is nothing:
            there is no hosted service for it to go to.
          </p>
        </div>

        <Section icon={Network} title="What the agent reads, stores and sends">
          <p className="text-sm text-gray-400 leading-relaxed">
            The agent is a single Rust binary on your machine. It makes <strong className="text-white">no
            outbound connections at all</strong>: it talks to inference runtimes you already run
            (Ollama, vLLM, llama.cpp) on localhost, and answers requests you make to it on
            port 7700. wicklee.dev is a static website that serves the documentation, the install
            scripts and the release links. It runs no API and has no accounts.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5 space-y-2">
              <div className="flex items-center gap-2 text-emerald-400 text-sm font-semibold">
                <Eye className="w-4 h-4" /> Read and kept on your machine
              </div>
              <ul className="text-sm text-gray-400 space-y-1.5 list-disc pl-5">
                <li>Hardware telemetry: CPU/GPU utilization, power draw, thermal state, memory</li>
                <li>Inference metrics: tok/s, TTFT, queue depth, KV-cache utilization</li>
                <li>Model <em>identity</em>: name, quantization, VRAM footprint, runtime settings</li>
                <li>Findings, per-request receipts and baselines, in a local DuckDB store: 24 hours at 1 Hz, 30 days at 1 minute, 90 days at 1 hour</li>
              </ul>
            </div>
            <div className="rounded-2xl border border-rose-500/20 bg-rose-500/5 p-5 space-y-2">
              <div className="flex items-center gap-2 text-rose-400 text-sm font-semibold">
                <EyeOff className="w-4 h-4" /> Never read — structurally
              </div>
              <ul className="text-sm text-gray-400 space-y-1.5 list-disc pl-5">
                <li>Prompts, responses, conversations — the receipt endpoint refuses payloads that carry them</li>
                <li>Files, logs, environment variables, credentials</li>
              </ul>
            </div>
          </div>
          <p className="text-xs text-gray-500 leading-relaxed">
            Two things run on your machine at your request and talk only to your own runtime: the
            idle probe (a 20-token generation against an already-loaded model, at most every ten
            minutes, off with <code className="text-gray-300">[probe]</code> in config.toml) and the
            consented <code className="text-gray-300">fingerprint</code> and <code className="text-gray-300">verify</code> runs.
            The agent binds to localhost by default; reaching it from other machines is opt-in and
            requires a bearer token.
          </p>
        </Section>

        <Section icon={ShieldCheck} title="Compliance posture — the honest version">
          <ul className="text-sm text-gray-400 space-y-2 list-disc pl-5 leading-relaxed">
            <li>The agent that runs on your nodes is open source (Apache 2.0) on GitHub — verify any claim on this page against the code.</li>
            <li>Wicklee holds no data about you or your machines, so there is nothing to certify, audit or delete on our side.</li>
          </ul>
        </Section>

        <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/5 p-6 space-y-3">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-emerald-400" />
            <h2 className="text-base font-bold text-white">Questions for a security review?</h2>
          </div>
          <p className="text-sm text-gray-400 leading-relaxed">
            Security questionnaires or a question about the architecture:{' '}
            <a href={mailto(CONTACT_EMAIL)} className="text-emerald-400 underline">{CONTACT_EMAIL}</a>.
          </p>
        </div>
      </div>
    </div>
  );
};

export default TrustPage;
