/**
 * TrustPage — /trust — what the agent does and does not send.
 *
 * Answers the question a security reviewer actually asks about a binary
 * running on their hardware: what leaves this machine. The sections on
 * tenancy, RBAC, the audit trail and the two deployment models were removed
 * with the hosted control plane — they described a service being shut down.
 * Every claim left here is behaviour of the agent in the current release.
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
      {/* Header */}
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
        {/* Hero */}
        <div className="space-y-3">
          <h1 className="text-3xl font-bold text-white">Sovereign by architecture, not by policy</h1>
          <p className="text-gray-400 leading-relaxed max-w-2xl">
            Wicklee monitors the hardware your AI runs on — never the AI's content. This page is the
            complete answer to "what leaves our machines, who can touch it, and what if nothing may
            leave at all." Everything described here is shipped, running behavior.
          </p>
        </div>

        {/* Data flow */}
        <Section icon={Network} title="What leaves a node — and what never does">
          <p className="text-sm text-gray-400 leading-relaxed">
            The agent is a single Rust binary on each node. Unpaired, it makes <strong className="text-white">no
            outbound connections at all</strong> — the localhost dashboard works fully offline. When you pair a
            node to a fleet, it pushes a hardware telemetry frame every 2 seconds. The split:
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5 space-y-2">
              <div className="flex items-center gap-2 text-emerald-400 text-sm font-semibold">
                <Eye className="w-4 h-4" /> Transmitted when paired
              </div>
              <ul className="text-sm text-gray-400 space-y-1.5 list-disc pl-5">
                <li>Hardware telemetry: CPU/GPU utilization, power draw, thermal state, memory</li>
                <li>Inference metrics: tok/s, TTFT, queue depth, KV-cache utilization</li>
                <li>Model <em>identity</em>: name, quantization, VRAM footprint</li>
                <li>Agent version, hostname, observation pattern results</li>
              </ul>
            </div>
            <div className="rounded-2xl border border-rose-500/20 bg-rose-500/5 p-5 space-y-2">
              <div className="flex items-center gap-2 text-rose-400 text-sm font-semibold">
                <EyeOff className="w-4 h-4" /> Never leaves the node — structurally
              </div>
              <ul className="text-sm text-gray-400 space-y-1.5 list-disc pl-5">
                <li>Prompts, responses, conversations — the agent never reads request bodies into telemetry</li>
                <li>Model templates and system prompts (the Runtime Config Surface keeps these local-only by design)</li>
                <li>Files, logs, environment variables, credentials</li>
              </ul>
            </div>
          </div>
          <p className="text-xs text-gray-500 leading-relaxed">
            The full network-egress inventory — every optional outbound connection the control plane can
            make (Clerk, Resend, HuggingFace) and how to firewall each — is documented in{' '}
            <a href="https://github.com/jeffgeiser/Wicklee/blob/main/docs/SELF_HOSTING.md" className="text-blue-400 underline" target="_blank" rel="noopener noreferrer">
              SELF_HOSTING.md
            </a>. Nothing phones home to wicklee.dev from a self-hosted deployment.
          </p>
        </Section>

        {/* Access control */}
        <Section icon={ShieldCheck} title="Compliance posture — the honest version">
          <ul className="text-sm text-gray-400 space-y-2 list-disc pl-5 leading-relaxed">
            <li>Independent security review completed June 2026 (auth/tenancy, agent concurrency, frontend); all required findings shipped — the review write-ups live in the public repo's engineering journal.</li>
            <li>The agent that runs on your nodes is open source (Apache 2.0) on GitHub — verify any claim on this page against the code.</li>
          </ul>
        </Section>

        {/* CTA */}
        <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/5 p-6 space-y-3">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-emerald-400" />
            <h2 className="text-base font-bold text-white">Evaluating for your organization?</h2>
          </div>
          <p className="text-sm text-gray-400 leading-relaxed">
            Security questionnaires or an architecture review call:{' '}
            <a href={mailto(CONTACT_EMAIL)} className="text-emerald-400 underline">{CONTACT_EMAIL}</a>.
          </p>
        </div>
      </div>
    </div>
  );
};

export default TrustPage;
