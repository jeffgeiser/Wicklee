import React from 'react';
import {
  Check, Zap, Server, Building2, ArrowRight,
} from 'lucide-react';
import type { SubscriptionTier } from '../types';
import Logo from './Logo';
import { CONTACT_EMAIL, mailto } from '../utils/contact';
import { perfMark } from '../utils/perfMark';

// ── Props ────────────────────────────────────────────────────────────────────

interface PricingPageProps {
  /** Null when logged out or on localhost. Drives the "Your plan" badge only. */
  currentTier?: SubscriptionTier | null;
  /** Logged-in user — drives nav buttons and the "Your plan" badge. */
  isLoggedIn?: boolean;
  /** Navigate within the SPA. */
  onNavigate?: (path: string) => void;
  /** Auth callbacks — rendered in the nav when logged out. */
  onSignIn?: () => void;
  onSignUp?: () => void;
  /** When true, hides the standalone nav (rendered inside dashboard layout). */
  embedded?: boolean;
}

// ── Tier data ────────────────────────────────────────────────────────────────
//
// Three tiers: Community (free), Team, Enterprise (custom). Team comes in two
// sizes — up to 10 nodes ($99/mo) and up to 25 ($200/mo) — with an identical
// feature set. The size is a node cap, never a feature unlock: the reason to
// move up is more GPUs, which a customer can't fake and doesn't resent. Above
// 25 nodes is an Enterprise conversation, not a bigger checkout.
//
// Billing is NOT wired to these cards. Every paid CTA is a mailto — there is
// deliberately no checkout flow here. (Paddle plumbing exists behind the
// in-app upgrade modal; it is not reachable from this page.)
//
// Claims on this page are kept to what actually ships:
//   - "Up to 25 nodes" is the real cap (MAX_TEAM_NODES in cloud/src/main.rs).
//     This card said "Unlimited nodes" for a month while the backend returned
//     402 at the 26th — the copy moved, the enforcement didn't. Node caps on
//     this page must match node_limit_for_tier().
//   - "90-day metric history" is the range-selector limit for Team
//     (MetricsHistoryChart RANGE_CONFIG minTier), not a storage guarantee.
//   - "12-month metric history" matches the real nightly prune in
//     cloud/src/main.rs, which deletes metrics_5min older than 365 days for
//     every tenant. Do NOT promote this to "unlimited" without first making
//     that prune tier-aware.
//   - Audit log export is Business+/Enterprise in code (isBusinessOrAbove), so
//     it is listed under Enterprise only.
//   - Sovereign Mode is deliberately absent: today it is only a UI label for an
//     unpaired node, with no sovereign.lock and no binary-level enforcement.
//     It goes on this page when it is actually built.

/** The two Team sizes. Order is display order. */
const TEAM_SIZES = [
  { tier: 'team_10' as const, nodes: 10, price: '$99',  annual: '$990/yr',   annualNote: 'save 2 months' },
  { tier: 'team'    as const, nodes: 25, price: '$200', annual: '$2,000/yr', annualNote: 'save 2 months' },
];
type TeamSize = typeof TEAM_SIZES[number];

interface TierDef {
  id: SubscriptionTier;
  name: string;
  price: string;
  period: string;
  /** Secondary price line (annual deal), rendered under the price. */
  subPrice?: string;
  tagline: string;
  accent: string;
  accentBg: string;
  accentText: string;
  badge?: string;
  badgeCls?: string;
  features: string[];
  highlight: boolean;
  cta: { label: string; href: string };
}

const TIERS: TierDef[] = [
  {
    id: 'community',
    name: 'Community',
    price: 'Free',
    period: '',
    tagline: 'For individuals and small fleets. Everything you need to see what your hardware is doing.',
    accent: 'border-gray-700',
    accentBg: 'bg-gray-500/5',
    accentText: 'text-gray-400',
    features: [
      'Unlimited local nodes',
      'Full local dashboard at localhost:7700',
      'Cloud fleet view — up to 3 nodes',
      '24-hour rolling metric history',
      'WES v2 + tok/W diagnostics',
      'Local API + MCP server (localhost, no auth)',
      'Open-source agent',
      'Community support — GitHub issues',
    ],
    highlight: false,
    cta: { label: 'Get started', href: '/#install-snippet' },
  },
  {
    id: 'team',
    name: 'Team',
    // price / subPrice are overridden per selected size at render time.
    price: '$200',
    period: '/mo',
    subPrice: '$2,000/yr — save 2 months',
    tagline: 'For teams running production inference. Fleet visibility, history, and API access. Pick the size that fits your fleet — the features are the same.',
    accent: 'border-blue-500/50',
    accentBg: 'bg-blue-500/5',
    accentText: 'text-blue-400',
    badge: 'Recommended',
    features: [
      'Everything in Community',
      'Up to 25 nodes in cloud fleet view',
      '90-day metric history',
      'Fleet API access (/api/v1/*)',
      'Cost & chargeback reports — $/1M tokens by node, model and tag',
      'Idle-waste & right-sizing report + weekly digest',
      'Capacity planner + model migration advisor',
      'SLOs with error budgets',
      'Benchmark report export',
      'Email support',
    ],
    highlight: true,
    cta: { label: 'Contact us', href: mailto(CONTACT_EMAIL, 'Wicklee Team') },
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 'Custom',
    period: '',
    tagline: 'For organizations with sovereignty, compliance, or scale requirements.',
    accent: 'border-purple-500/40',
    accentBg: 'bg-purple-500/5',
    accentText: 'text-purple-400',
    features: [
      'Everything in Team',
      'Self-hosted control plane — runs on your own infrastructure',
      'Helm chart for Kubernetes deployment',
      'SSO / SAML — your IdP, via Clerk enterprise connections',
      'Audit log export + SIEM streaming',
      '12-month metric history',
      'SLA + dedicated support',
      'Custom deployment support',
    ],
    highlight: false,
    cta: { label: 'Talk to us', href: mailto(CONTACT_EMAIL, 'Wicklee Enterprise') },
  },
];

// ── Component ────────────────────────────────────────────────────────────────

const PricingPage: React.FC<PricingPageProps> = ({
  currentTier = null,
  isLoggedIn = false,
  onNavigate,
  onSignIn,
  onSignUp,
  embedded = false,
}) => {
  React.useEffect(() => { perfMark('wk:page-pricing'); }, []);
  // Preselect the size the visitor is already on. Otherwise default to the
  // 10-node size: the entry price is the first number a new visitor should
  // see, and the 25-node size is one click away in the selector.
  const [teamSize, setTeamSize] = React.useState<TeamSize>(
    TEAM_SIZES.find(sz => sz.tier === currentTier) ?? TEAM_SIZES[0],
  );

  return (
    <div className="min-h-screen bg-gray-900">
      {/* ── Navigation — only on the standalone /pricing route ── */}
      {!embedded && <nav className="max-w-7xl mx-auto px-4 sm:px-8 py-5 sm:py-8 flex items-center justify-between relative z-10">
        <button onClick={() => onNavigate?.('/')} className="cursor-pointer">
          <Logo className="text-3xl" connectionState="connected" />
        </button>
        <div className="flex items-center gap-4 sm:gap-8">
          {/* Mirrors the landing nav — a separate deployment, not a route. */}
          <a
            href="https://demo.wicklee.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:block text-sm font-medium text-blue-400 hover:text-blue-300 transition-colors"
          >
            Live demo
          </a>
          <button onClick={() => onNavigate?.('/docs')} className="hidden sm:block text-sm font-medium text-gray-400 hover:text-white transition-colors">Documentation</button>
          <button onClick={() => onNavigate?.('/pricing')} className="hidden sm:block text-sm font-medium text-white transition-colors">Pricing</button>
          <a
            href="https://github.com/jeffgeiser/Wicklee"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:block text-sm font-medium text-gray-400 hover:text-white transition-colors"
          >
            GitHub
          </a>
          {!isLoggedIn ? (
            <>
              <button
                onClick={onSignIn}
                className="px-4 sm:px-6 py-2 border border-gray-700 hover:border-gray-500 text-white text-sm font-bold rounded-xl transition-all"
              >
                Sign In
              </button>
              <button
                onClick={onSignUp}
                className="px-4 sm:px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold rounded-xl transition-all shadow-lg shadow-blue-500/20"
              >
                Get Started
              </button>
            </>
          ) : (
            <button
              onClick={() => onNavigate?.('/')}
              className="px-4 sm:px-6 py-2 border border-gray-700 hover:border-gray-500 text-white text-sm font-bold rounded-xl transition-all"
            >
              Dashboard
            </button>
          )}
        </div>
      </nav>}

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pb-16 space-y-12">

        {/* ── Header ─────────────────────────────────────────────────── */}
        <div className="text-center space-y-3">
          <h1 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">
            Pricing
          </h1>
          <p className="text-gray-500 max-w-xl mx-auto text-sm leading-relaxed">
            Hardware-aware observability for private AI fleets. Every tier includes WES
            diagnostics, real-time telemetry, and the local API — the cloud relay is
            always opt-in.
          </p>
        </div>

        {/* ── Tier cards ─────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-stretch">
          {TIERS.map(tierDef => {
            // The Team card is one card with two sizes; both team tiers land on it.
            const isTeamCard = tierDef.id === 'team';
            const tier: TierDef = isTeamCard
              ? {
                  ...tierDef,
                  price:    teamSize.price,
                  subPrice: `${teamSize.annual} — ${teamSize.annualNote}`,
                  features: tierDef.features.map(f =>
                    f.startsWith('Up to ') && f.endsWith('nodes in cloud fleet view')
                      ? `Up to ${teamSize.nodes} nodes in cloud fleet view`
                      : f),
                  cta: { label: 'Contact us', href: mailto(CONTACT_EMAIL, `Wicklee Team (${teamSize.nodes} nodes)`) },
                }
              : tierDef;
            const isCurrent = isLoggedIn && (
              isTeamCard ? (currentTier === 'team' || currentTier === 'team_10') : tier.id === currentTier
            );

            return (
              <div
                key={tier.id}
                className={`relative flex flex-col rounded-2xl border p-6 transition-all duration-300 ${
                  tier.highlight
                    ? `${tier.accent} ${tier.accentBg} shadow-[0_0_30px_rgba(59,130,246,0.08)] md:scale-[1.03] z-10`
                    : `border-gray-700 bg-gray-900 hover:border-gray-600`
                }`}
              >
                {/* Badge */}
                {tier.badge && (
                  <div className={`absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 text-white text-[9px] font-bold uppercase tracking-widest rounded-full shadow-lg ${tier.badgeCls ?? 'bg-blue-600 shadow-blue-600/30'}`}>
                    {tier.badge}
                  </div>
                )}

                {/* Name + price */}
                <div className="space-y-1 mb-5">
                  <div className="flex items-center gap-2">
                    <p className={`text-[10px] font-bold uppercase tracking-widest ${tier.accentText}`}>
                      {tier.name}
                    </p>
                    {isCurrent && (
                      <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[9px] font-bold uppercase tracking-widest">
                        Your plan
                      </span>
                    )}
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-bold text-white">{tier.price}</span>
                    {tier.period && <span className="text-gray-600 text-sm">{tier.period}</span>}
                  </div>
                  {tier.subPrice && (
                    <p className="text-xs text-blue-400/80 font-medium">{tier.subPrice}</p>
                  )}
                  <p className="text-xs text-gray-500 leading-relaxed pt-1">{tier.tagline}</p>
                </div>

                {isTeamCard && (
                  <div className="mb-5">
                    <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-gray-800/80 border border-gray-700" role="tablist" aria-label="Team plan size">
                      {TEAM_SIZES.map(sz => {
                        const active = sz.tier === teamSize.tier;
                        return (
                          <button
                            key={sz.tier}
                            role="tab"
                            aria-selected={active}
                            onClick={() => setTeamSize(sz)}
                            className={`py-2 rounded-lg text-xs font-semibold transition-colors ${
                              active ? 'bg-blue-600 text-white shadow' : 'text-gray-400 hover:text-white'
                            }`}
                          >
                            Up to {sz.nodes} nodes
                            <span className={`block text-[10px] font-normal ${active ? 'text-blue-100' : 'text-gray-500'}`}>{sz.price}/mo</span>
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-[11px] text-gray-500 mt-2 leading-relaxed">
                      More than 25 nodes? <a href={mailto(CONTACT_EMAIL, 'Wicklee — more than 25 nodes')} className="text-blue-400 hover:text-blue-300 underline underline-offset-2">Talk to us</a> — same-day quote.
                    </p>
                  </div>
                )}

                {/* Feature list */}
                <div className="flex-1 space-y-2.5 mb-6">
                  {tier.features.map(f => (
                    <div key={f} className="flex items-start gap-2.5">
                      <div className="mt-0.5 p-0.5 rounded-full bg-emerald-500/10">
                        <Check className="w-3 h-3 text-emerald-400" />
                      </div>
                      <span className="text-sm text-gray-300 leading-snug">{f}</span>
                    </div>
                  ))}
                </div>

                {/* CTA — mt-auto pushes to bottom so buttons align across cards */}
                <a
                  href={tier.cta.href}
                  className={`mt-auto w-full py-3 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2 ${
                    tier.highlight
                      ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/20'
                      : tier.id === 'enterprise'
                        ? 'bg-purple-600/90 hover:bg-purple-500 text-white shadow-lg shadow-purple-600/20'
                        : 'bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700'
                  }`}
                >
                  {tier.cta.label}
                  <ArrowRight className="w-3.5 h-3.5" />
                </a>
              </div>
            );
          })}
        </div>

        {/* ── What every tier includes ─────────────────────────────── */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-center">
          {[
            {
              icon: <Zap className="w-5 h-5 text-cyan-400" />,
              title: 'WES Diagnostics',
              desc: 'Every tier. Real-time efficiency scoring with thermal cost penalties.',
            },
            {
              icon: <Server className="w-5 h-5 text-emerald-400" />,
              title: 'Local API + MCP',
              desc: 'The localhost API and MCP server are free on every tier, no auth required.',
            },
            {
              icon: <Building2 className="w-5 h-5 text-purple-400" />,
              title: 'Your Infrastructure',
              desc: 'Prompts and responses never leave the node. Pairing to the cloud is opt-in, and Enterprise runs the control plane on your own hardware.',
            },
          ].map(item => (
            <div key={item.title} className="rounded-xl border border-gray-700 bg-gray-800/30 p-5 space-y-2">
              <div className="flex justify-center">{item.icon}</div>
              <p className="text-sm font-bold text-white">{item.title}</p>
              <p className="text-xs text-gray-500 leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>

        {/* ── Back link ───────────────────────────────────────────────── */}
        {onNavigate && (
          <div className="text-center">
            <button
              onClick={() => onNavigate('/')}
              className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
            >
              &larr; Back to Dashboard
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default PricingPage;
