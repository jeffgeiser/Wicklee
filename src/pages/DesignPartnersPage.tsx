/**
 * DesignPartnersPage — /design-partners — GTM Rock 5.
 *
 * The offer: 3–5 companies running private AI get Enterprise free for a
 * year in exchange for a logo, a case study, and monthly feedback. Case
 * studies are the only advertising enterprises trust; partners also steer
 * the roadmap while the surface is still wet.
 */

import React, { useEffect } from 'react';
import { ArrowLeft, Handshake, Check, Building2, ShieldCheck, LineChart } from 'lucide-react';
import { CONTACT_EMAIL, mailto } from '../utils/contact';

interface DesignPartnersPageProps {
  onNavigate: (path: string) => void;
}

const MAILTO = mailto(
  CONTACT_EMAIL,
  'Design partner program',
  'Company:\nFleet (nodes, hardware, runtimes):\nWhat you run locally and why:\n',
);

const DesignPartnersPage: React.FC<DesignPartnersPageProps> = ({ onNavigate }) => {
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
          <span className="text-xs text-gray-600 uppercase tracking-widest ml-2">Design Partners</span>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-8 py-12 space-y-12">
        {/* Hero */}
        <div className="space-y-4">
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/25 bg-blue-500/10 px-3 py-1 text-xs font-semibold text-blue-300">
            <Handshake className="w-3.5 h-3.5" /> 3–5 companies · applications open
          </div>
          <h1 className="text-3xl font-bold text-white leading-tight">
            Running private AI in production?<br />Help us build your fleet's observability — Enterprise tier free for a year.
          </h1>
          <p className="text-gray-400 leading-relaxed max-w-2xl">
            Wicklee is the observability layer for private AI inference — on-prem, private cloud, or colo: hardware telemetry
            and token throughput in one store, so you can see efficiency, cost, and reliability the way
            you see them for the rest of your infrastructure. We're taking on a small number of design
            partners whose fleets and requirements will steer the roadmap.
          </p>
        </div>

        {/* The trade */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-6 space-y-3">
            <h2 className="text-base font-bold text-white">You get</h2>
            <ul className="text-sm text-gray-400 space-y-2">
              {[
                'Enterprise tier free for 12 months: unlimited nodes and seats, SSO/SAML, RBAC, audit log export + SIEM streaming, 12-month history',
                'SLOs with error budgets, chargeback/showback, capacity planning, idle-waste recovery — the cost-governance suite, on your real fleet',
                'A direct line to the founder: monthly call, priority on your feature requests and fixes',
                'Self-hosted control plane evaluation if telemetry can’t leave your network',
              ].map((t, i) => (
                <li key={i} className="flex gap-2.5">
                  <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span className="leading-relaxed">{t}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-6 space-y-3">
            <h2 className="text-base font-bold text-white">We ask</h2>
            <ul className="text-sm text-gray-400 space-y-2">
              {[
                'Your logo on wicklee.dev',
                'One case study when you’re happy (we draft, you approve every word)',
                'A monthly 30-minute feedback call',
                'Honest, blunt input — tell us what’s missing before you work around it',
              ].map((t, i) => (
                <li key={i} className="flex gap-2.5">
                  <Check className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                  <span className="leading-relaxed">{t}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Who it's for */}
        <div className="space-y-4">
          <h2 className="text-lg font-bold text-white">Who this fits</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              { icon: Building2, title: 'Regulated & on-prem', body: 'Healthcare, legal, financial services, public sector — anywhere inference must stay on hardware you control.' },
              { icon: LineChart, title: 'Real fleets', body: 'A handful to a hundred nodes running Ollama, vLLM, or llama.cpp — Apple Silicon, NVIDIA, or mixed.' },
              { icon: ShieldCheck, title: 'Accountable teams', body: 'Someone owns uptime, someone owns the power bill, and someone answers the auditor.' },
            ].map(({ icon: Icon, title, body }, i) => (
              <div key={i} className="rounded-2xl border border-gray-700 bg-gray-800/40 p-5 space-y-2">
                <Icon className="w-4 h-4 text-blue-400" />
                <h3 className="text-sm font-semibold text-white">{title}</h3>
                <p className="text-sm text-gray-400 leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Why now / credibility */}
        <div className="space-y-3">
          <h2 className="text-lg font-bold text-white">Why now</h2>
          <p className="text-sm text-gray-400 leading-relaxed max-w-2xl">
            The enterprise surface shipped this quarter: RBAC, append-only audit with SIEM streaming,
            org-scoped API keys, SLOs with error budgets, chargeback in finance-ready CSV, capacity
            planning priced from your own measured efficiency, and a self-hosted control plane. Design
            partners get all of it while the roadmap is still soft enough to bend around your
            requirements. Read the security posture first:{' '}
            <button onClick={() => onNavigate('/trust')} className="text-blue-400 underline">wicklee.dev/trust</button>.
          </p>
        </div>

        {/* CTA */}
        <div className="rounded-2xl border border-blue-500/25 bg-blue-500/5 p-6 space-y-3">
          <h2 className="text-base font-bold text-white">Apply</h2>
          <p className="text-sm text-gray-400 leading-relaxed">
            Three lines is enough: who you are, what your fleet looks like, and what you run locally
            and why. We reply to every application.
          </p>
          <a
            href={MAILTO}
            className="inline-block px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-sm font-semibold text-white transition-colors"
          >
            {CONTACT_EMAIL} →
          </a>
        </div>
      </div>
    </div>
  );
};

export default DesignPartnersPage;
