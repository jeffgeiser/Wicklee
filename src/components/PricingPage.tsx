import React from 'react';
import {
  Check, Shield, Zap, Server, Crown, ArrowRight, Lock,
} from 'lucide-react';
import type { SubscriptionTier } from '../types';
import Logo from './Logo';

// ── Props ────────────────────────────────────────────────────────────────────

interface PricingPageProps {
  /** Null when logged out or on localhost. */
  currentTier?: SubscriptionTier | null;
  /** Logged-in user — drives button labels. */
  isLoggedIn?: boolean;
  /** Navigate within the SPA. */
  onNavigate?: (path: string) => void;
  /** Trigger Paddle checkout for a given tier. */
  onCheckout?: (tier: 'pro' | 'team') => void;
  /** Auth callbacks — rendered in the nav when logged out. */
  onSignIn?: () => void;
  onSignUp?: () => void;
  /** When true, hides the standalone nav (rendered inside dashboard layout). */
  embedded?: boolean;
}

// ── Tier data derived from TIERS.md ──────────────────────────────────────────

interface TierDef {
  id: SubscriptionTier;
  name: string;
  price: string;
  period: string;
  tagline: string;
  accent: string;           // border / glow color
  accentBg: string;         // subtle background
  accentText: string;       // text color
  badge?: string;
  badgeCls?: string;        // badge color override (default: blue)
  features: string[];
  highlight: boolean;
}

const TIERS: TierDef[] = [
  {
    id: 'community',
    name: 'Community',
    price: '$0',
    period: 'forever',
    tagline: 'Local experimentation and single-node monitoring.',
    accent: 'border-gray-700',
    accentBg: 'bg-gray-500/5',
    accentText: 'text-gray-400',
    features: [
      '3 Nodes',
      '24-Hour Rolling History',
      '9 Observation Patterns — thermal, power, memory & hardware health',
      'WES v2 + tok/W Diagnostics',
      'Optional Cloud Relay',
      'Agent API v1',
      'Local MCP Server — AI agent integration',
      'Local Ollama proxy — production tok/s, TTFT & latency on-device',
    ],
    highlight: false,
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$9',
    period: '/mo',
    tagline: 'Unattended monitoring with Slack alerts and pattern intelligence.',
    accent: 'border-blue-500/50',
    accentBg: 'bg-blue-500/5',
    accentText: 'text-blue-400',
    badge: 'Most Popular',
    features: [
      '10 Nodes',
      '7-Day Metric History',
      'All 18 Patterns — adds fleet, inference latency & advanced diagnostics',
      'Custom Alert Thresholds',
      'Node Naming & Tags',
      'Slack & Email Alerts (Single Channel)',
      'Persistent Insight Cards',
      'Fleet proxy metrics — production tok/s, TTFT & latency in cloud dashboard',
    ],
    highlight: true,
  },
  {
    id: 'team',
    name: 'Team',
    price: '$19',
    period: '/seat/mo',
    tagline: 'Production fleet with shared dashboards, exports, and PagerDuty.',
    accent: 'border-amber-500/50',
    accentBg: 'bg-amber-500/5',
    accentText: 'text-amber-400',
    badge: 'Coming Soon',
    badgeCls: 'bg-amber-600 shadow-amber-600/30',
    features: [
      '3-Seat Minimum · 25 Nodes Included',
      '+50 Nodes Expansion Pack ($50/mo)',
      '90-Day Metric History',
      'Shared Fleet Dashboard via Clerk Org',
      'CSV / JSON Exports',
      'Slack, Email & PagerDuty Alerts',
      'Trend Analysis + Regression Detection',
      'Cloud MCP Server + Insights API',
      'OpenTelemetry Bridge + Prometheus Endpoint',
    ],
    highlight: false,
  },
];

// ── Component ────────────────────────────────────────────────────────────────

const PricingPage: React.FC<PricingPageProps> = ({
  currentTier = null,
  isLoggedIn = false,
  onNavigate,
  onCheckout,
  onSignIn,
  onSignUp,
  embedded = false,
}) => {

  const tierRank = (t: SubscriptionTier | null): number =>
    t === 'enterprise' ? 4 : t === 'team' ? 3 : t === 'pro' ? 2 : 1;

  const currentRank = tierRank(currentTier);

  function handleCta(tier: TierDef) {
    if (!isLoggedIn) {
      onNavigate?.('/sign-up');
      return;
    }
    if (tier.id === 'community') return; // free tier — no checkout
    if (tierRank(tier.id) <= currentRank) return; // current or lower
    onCheckout?.(tier.id as 'pro' | 'team');
  }

  function ctaLabel(tier: TierDef): string {
    if (!isLoggedIn) return 'Get Started';
    if (tier.id === currentTier) return 'Current Plan';
    if (tierRank(tier.id) < currentRank) return 'Current Plan Includes This';
    return `Upgrade to ${tier.name}`;
  }

  function isCtaDisabled(tier: TierDef): boolean {
    if (!isLoggedIn) return false;
    return tierRank(tier.id) <= currentRank;
  }

  return (
    <div className="min-h-screen bg-gray-950">
      {/* ── Navigation — only shown on standalone /pricing route, hidden when embedded in dashboard ── */}
      {!embedded && <nav className="max-w-7xl mx-auto px-4 sm:px-8 py-5 sm:py-8 flex items-center justify-between relative z-10">
        <button onClick={() => onNavigate?.('/')} className="cursor-pointer">
          <Logo className="text-3xl" connectionState="connected" />
        </button>
        <div className="flex items-center gap-4 sm:gap-8">
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
            Sovereign-First Pricing
          </h1>
          <p className="text-gray-500 max-w-xl mx-auto text-sm leading-relaxed">
            Monitor your local AI fleet with full hardware sovereignty.
            Every tier includes WES diagnostics, real-time telemetry, and the Agent API.
          </p>
        </div>

        {/* ── Tier cards ─────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-stretch">
          {TIERS.map(tier => {
            const isCurrent = tier.id === currentTier;
            const disabled  = isCtaDisabled(tier);

            return (
              <div
                key={tier.id}
                className={`relative flex flex-col rounded-2xl border p-6 transition-all duration-300 ${
                  tier.highlight
                    ? `${tier.accent} ${tier.accentBg} shadow-[0_0_30px_rgba(59,130,246,0.08)] md:scale-[1.03] z-10`
                    : `border-gray-800 bg-gray-950 hover:border-gray-700`
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
                  <p className={`text-[10px] font-bold uppercase tracking-widest ${tier.accentText}`}>
                    {tier.name}
                  </p>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-bold text-white">{tier.price}</span>
                    <span className="text-gray-600 text-sm">{tier.period}</span>
                  </div>
                  <p className="text-xs text-gray-500 leading-relaxed">{tier.tagline}</p>
                </div>

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
                <button
                  onClick={() => handleCta(tier)}
                  disabled={disabled}
                  className={`mt-auto w-full py-3 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2 ${
                    isCurrent
                      ? 'bg-gray-800 text-gray-500 cursor-default'
                      : disabled
                        ? 'bg-gray-900 text-gray-600 cursor-default border border-gray-800'
                        : tier.highlight
                          ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/20'
                          : tier.id === 'team'
                            ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-lg shadow-amber-600/20'
                            : 'bg-gray-900 hover:bg-gray-800 text-gray-300 border border-gray-800'
                  }`}
                >
                  {ctaLabel(tier)}
                  {!disabled && !isCurrent && <ArrowRight className="w-3.5 h-3.5" />}
                </button>
              </div>
            );
          })}
        </div>

        {/* ── Enterprise footer ───────────────────────────────────────── */}
        <div className="rounded-2xl border border-gray-800 bg-gray-900/40 p-6 sm:p-8 flex flex-col sm:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-4">
            <div className="p-3 rounded-xl bg-purple-500/10 border border-purple-500/20">
              <Shield className="w-6 h-6 text-purple-400" />
            </div>
            <div>
              <h4 className="text-base font-bold text-white flex items-center gap-2">
                Enterprise — Airgapped / Sovereign
                <span className="text-[9px] font-bold uppercase tracking-widest text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded-full">
                  From $200/mo
                </span>
              </h4>
              <p className="text-sm text-gray-500 mt-0.5">
                On-premise deployment. No outbound telemetry. Inline proxy for inference tracing,
                Kubernetes Operator, Prometheus export, SSO/SAML, signed PDF audits, and SIEM integration.
              </p>
            </div>
          </div>
          <a
            href="mailto:enterprise@wicklee.dev"
            className="shrink-0 px-6 py-3 rounded-xl text-sm font-bold text-purple-300 border border-purple-500/30 hover:bg-purple-500/10 transition-colors"
          >
            Contact Sales
          </a>
        </div>

        {/* ── Feature comparison highlights ────────────────────────── */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-center">
          {[
            { icon: <Zap className="w-5 h-5 text-cyan-400" />, title: 'WES Diagnostics', desc: 'Every tier. Real-time efficiency scoring with thermal cost penalties.' },
            { icon: <Server className="w-5 h-5 text-emerald-400" />, title: 'Agent API v1', desc: 'Full API access on every tier. /route/best, /health, /metrics.' },
            { icon: <Lock className="w-5 h-5 text-amber-400" />, title: 'Sovereignty First', desc: 'Your hardware, your data. Cloud relay is optional — Enterprise goes fully airgapped.' },
          ].map(item => (
            <div key={item.title} className="rounded-xl border border-gray-800 bg-gray-900/30 p-5 space-y-2">
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
