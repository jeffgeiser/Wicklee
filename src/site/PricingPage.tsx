import React from 'react';
import {
  Check, Zap, Server, Building2, ArrowRight,
} from 'lucide-react';
import type { SubscriptionTier } from '../types';
import Logo from '../components/Logo';
import { CONTACT_EMAIL, mailto } from './utils/contact';
import { perfMark } from '../utils/perfMark';
import { CLOUD_URL } from '../utils/cloudUrl';

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
  /**
   * Opens Paddle checkout for the chosen Team size + billing period (App's
   * openTeamCheckout). Resolves false when checkout can't run. Omitted in
   * builds with no self-serve billing (agent, demo) — the Team card then
   * shows the contact CTA only.
   */
  onTeamCheckout?: (cycle: BillingCycle, plan: TeamPlan) => Promise<boolean>;
}

// ── Tier data ────────────────────────────────────────────────────────────────
//
// Three tiers: Community (free), Team, Enterprise (custom). Team comes in two
// sizes — up to 10 nodes ($99/mo) and up to 25 ($200/mo) — with an identical
// feature set. The size is a node cap, never a feature unlock: the reason to
// move up is more GPUs, which a customer can't fake and doesn't resent. Above
// 25 nodes is an Enterprise conversation, not a bigger checkout.
//
// Billing: the Team card is the only self-serve checkout. Whether it shows a
// checkout button is decided by the server — GET /api/billing/status (public,
// no auth) returns checkout_enabled, the same check /api/billing/config makes.
// While that is false, unknown, or errors, the card keeps its mailto CTA, and
// a checkout that fails to open falls back to the same mailto. Enterprise is
// always a mailto.
//
// Claims on this page are kept to what actually ships:
//   - "Up to 25 nodes" is the real cap (MAX_TEAM_NODES in cloud/src/main.rs).
//     This card said "Unlimited nodes" for a month while the backend returned
//     402 at the 26th — the copy moved, the enforcement didn't. Node caps on
//     this page must match node_limit_for_tier().
//   - "90-day metric history" is the range-selector limit for Team
//     (MetricsHistoryChart RANGE_CONFIG minTier), not a storage guarantee.
//   - "12-month metric history" matches the real nightly prune in
//     cloud/src/maintenance.rs, which deletes metrics_5min older than 365
//     days for every tenant, and the 1Y range in cloud/utils/historyRange.ts
//     (Enterprise + grandfathered Business) that makes it viewable. Do NOT promote this to "unlimited" without first making
//     that prune tier-aware.
//   - Audit log export is Business+/Enterprise in code (isBusinessOrAbove), so
//     it is listed under Enterprise only.
//   - Sovereign Mode is deliberately absent: today it is only a UI label for an
//     unpaired node, with no sovereign.lock and no binary-level enforcement.
//     It goes on this page when it is actually built.

/** The two Team sizes. Order is display order. Prices in whole USD and must
 *  match the Paddle prices (docs/BILLING.md): annual is 10× monthly. */
const TEAM_SIZES = [
  { tier: 'team_10' as const, nodes: 10, monthly: 99,  annual: 990 },
  { tier: 'team'    as const, nodes: 25, monthly: 200, annual: 2000 },
];
type TeamSize = typeof TEAM_SIZES[number];
type TeamPlan = TeamSize['tier'];
type BillingCycle = 'monthly' | 'annual';

const usd = (n: number) => `$${n.toLocaleString('en-US')}`;

/** Checkout availability from GET /api/billing/status. 'unknown' (in flight)
 *  renders exactly like 'off' — the contact CTA — so there is never a gap. */
type CheckoutStatus = 'unknown' | 'on' | 'off';

/** Selection carried through sign-up: /pricing?plan=team_10&cycle=annual&checkout=1 */
function readSelectionFromUrl(): { plan: TeamPlan | null; cycle: BillingCycle | null; checkout: boolean } {
  const q = new URLSearchParams(window.location.search);
  const plan = TEAM_SIZES.find(sz => sz.tier === q.get('plan'))?.tier ?? null;
  const c = q.get('cycle');
  const cycle = c === 'annual' || c === 'monthly' ? c : null;
  return { plan, cycle, checkout: q.get('checkout') === '1' };
}

interface TierDef {
  id: SubscriptionTier;
  name: string;
  price: string;
  period: string;
  /** Billing line (e.g. "Billed monthly"), rendered under the price. */
  billing?: string;
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
      'All 18 observation patterns on the local dashboard; 10 in the cloud fleet view',
      'Local API + MCP server (localhost, no auth)',
      'Fleet API (/api/v1/*) — core endpoints, 60 req/min',
      'Open-source agent and local dashboard (Apache 2.0)',
      'Community support — GitHub issues',
    ],
    highlight: false,
    cta: { label: 'Get started', href: '/#install-snippet' },
  },
  {
    id: 'team',
    name: 'Team',
    // price / period / billing / subPrice are overridden per selected size
    // and billing period at render time.
    price: '$99',
    period: '/mo',
    tagline: 'For teams running production inference. Fleet visibility, history, and API access. Pick the size that fits your fleet — the features are the same.',
    accent: 'border-blue-500/50',
    accentBg: 'bg-blue-500/5',
    accentText: 'text-blue-400',
    badge: 'Recommended',
    features: [
      'Everything in Community',
      'Up to 25 nodes in cloud fleet view',
      'All 20 observation patterns in the fleet view, including long-term WES drift',
      '90-day metric history',
      'Fleet API at 600 req/min, plus the analytics endpoints',
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
  onTeamCheckout,
}) => {
  React.useEffect(() => { perfMark('wk:page-pricing'); }, []);
  // A selection carried back from sign-up (?plan=&cycle=&checkout=1) wins on
  // the standalone page; the embedded dashboard copy ignores the URL.
  const [fromUrl] = React.useState(() =>
    embedded ? { plan: null, cycle: null, checkout: false } : readSelectionFromUrl());
  // Preselect the size the visitor is already on. Otherwise default to the
  // 10-node size: the entry price is the first number a new visitor should
  // see, and the 25-node size is one click away in the selector.
  const [teamSize, setTeamSize] = React.useState<TeamSize>(
    TEAM_SIZES.find(sz => sz.tier === fromUrl.plan)
      ?? TEAM_SIZES.find(sz => sz.tier === currentTier)
      ?? TEAM_SIZES[0],
  );
  const [cycle, setCycle] = React.useState<BillingCycle>(fromUrl.cycle ?? 'monthly');

  // Terms / Refund / Privacy links shown next to checkout. Real hrefs so they
  // work without JS and open in a new tab; a plain click stays in the SPA.
  const legalLink = (path: '/terms' | '/refund' | '/privacy', label: string) => (
    <a
      href={path}
      onClick={e => {
        if (!onNavigate || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onNavigate(path);
      }}
      className="text-gray-400 hover:text-gray-200 underline underline-offset-2"
    >
      {label}
    </a>
  );

  // ── Self-serve checkout ──────────────────────────────────────────────────
  const checkoutWired = !!onTeamCheckout;
  const [checkoutStatus, setCheckoutStatus] = React.useState<CheckoutStatus>('unknown');
  const [checkoutBusy, setCheckoutBusy] = React.useState(false);
  const [checkoutFailed, setCheckoutFailed] = React.useState(false);

  React.useEffect(() => {
    if (!checkoutWired) return;
    let cancelled = false;
    fetch(`${CLOUD_URL}/api/billing/status`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: { checkout_enabled?: boolean } | null) => {
        if (!cancelled) setCheckoutStatus(d?.checkout_enabled === true ? 'on' : 'off');
      })
      .catch(() => { if (!cancelled) setCheckoutStatus('off'); });
    return () => { cancelled = true; };
  }, [checkoutWired]);

  const onTeamPlan = isLoggedIn && (currentTier === 'team' || currentTier === 'team_10');
  // Existing Team subscribers never get a second checkout (Paddle would open a
  // second subscription); plan changes stay a conversation — see BILLING.md.
  const selfServe = checkoutWired && checkoutStatus === 'on' && !onTeamPlan;

  const startTeamCheckout = React.useCallback(async (plan: TeamPlan, billing: BillingCycle) => {
    setCheckoutFailed(false);
    if (!isLoggedIn) {
      // Sign up (or in — Clerk links the two) and come back here with the
      // selection preserved; checkout=1 reopens checkout once signed in.
      const back = `/pricing?plan=${plan}&cycle=${billing}&checkout=1`;
      const to = `/sign-up?redirect_url=${encodeURIComponent(back)}`;
      if (onNavigate) onNavigate(to); else window.location.assign(to);
      return;
    }
    if (!onTeamCheckout) return;
    setCheckoutBusy(true);
    const ok = await onTeamCheckout(billing, plan);
    setCheckoutBusy(false);
    if (!ok) setCheckoutFailed(true);
  }, [isLoggedIn, onNavigate, onTeamCheckout]);

  // Back from sign-up with ?checkout=1: open checkout once, as soon as the
  // session and the checkout status are both known. checkout=1 is dropped from
  // the URL first so a reload or Back doesn't reopen the overlay; plan/cycle
  // stay so the selection survives. Signed-out (abandoned sign-up) or checkout
  // off → nothing opens, the selection is just preselected.
  const autoOpenPending = React.useRef(fromUrl.checkout);
  React.useEffect(() => {
    if (!autoOpenPending.current || !isLoggedIn || checkoutStatus === 'unknown') return;
    autoOpenPending.current = false;
    const url = new URL(window.location.href);
    url.searchParams.delete('checkout');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    if (selfServe) void startTeamCheckout(teamSize.tier, cycle);
  }, [isLoggedIn, checkoutStatus, selfServe, startTeamCheckout, teamSize.tier, cycle]);

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
            // Annual is 10× monthly; the saving is the real dollar figure.
            const annualSaving = teamSize.monthly * 12 - teamSize.annual;
            const tier: TierDef = isTeamCard
              ? {
                  ...tierDef,
                  price:    usd(cycle === 'annual' ? teamSize.annual : teamSize.monthly),
                  period:   cycle === 'annual' ? '/yr' : '/mo',
                  // Paddle prices are tax-exclusive: sales tax / VAT is
                  // added at checkout by location (EU/UK businesses with a
                  // VAT ID reverse-charge), so say so before the overlay does.
                  billing:  cycle === 'annual'
                    ? `Billed annually — ${usd(teamSize.annual)} per year, plus tax where applicable`
                    : `Billed monthly — ${usd(teamSize.monthly)} per month, plus tax where applicable`,
                  subPrice: cycle === 'annual'
                    ? `Save ${usd(annualSaving)} vs. ${usd(teamSize.monthly * 12)} paid monthly — 2 months free`
                    : `Or ${usd(teamSize.annual)}/yr billed annually — save ${usd(annualSaving)}`,
                  features: tierDef.features.map(f =>
                    f.startsWith('Up to ') && f.endsWith('nodes in cloud fleet view')
                      ? `Up to ${teamSize.nodes} nodes in cloud fleet view`
                      : f),
                  cta: { label: 'Contact us', href: mailto(CONTACT_EMAIL, `Wicklee Team (${teamSize.nodes} nodes, ${cycle})`) },
                }
              : tierDef;
            const isCurrent = isTeamCard ? onTeamPlan : isLoggedIn && tier.id === currentTier;
            const ctaCls = `mt-auto w-full py-3 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2 ${
              tier.highlight
                ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/20'
                : tier.id === 'enterprise'
                  ? 'bg-purple-600/90 hover:bg-purple-500 text-white shadow-lg shadow-purple-600/20'
                  : 'bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700'
            }`;

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
                  {tier.billing && (
                    <p className="text-xs text-gray-400">{tier.billing}</p>
                  )}
                  {tier.subPrice && (
                    <p className="text-xs text-blue-400/80 font-medium">{tier.subPrice}</p>
                  )}
                  <p className="text-xs text-gray-500 leading-relaxed pt-1">{tier.tagline}</p>
                </div>

                {isTeamCard && (
                  <div className="mb-5">
                    <div className="grid grid-cols-2 gap-1 p-1 mb-2 rounded-xl bg-gray-800/80 border border-gray-700" role="tablist" aria-label="Billing period">
                      {(['monthly', 'annual'] as const).map(c => {
                        const active = c === cycle;
                        return (
                          <button
                            key={c}
                            role="tab"
                            aria-selected={active}
                            onClick={() => { setCycle(c); setCheckoutFailed(false); }}
                            className={`py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 ${
                              active ? 'bg-blue-600 text-white shadow' : 'text-gray-400 hover:text-white'
                            }`}
                          >
                            {c === 'monthly' ? 'Monthly' : 'Annual'}
                            {c === 'annual' && (
                              <span className={`text-[9px] font-bold uppercase tracking-wider ${active ? 'text-blue-100' : 'text-emerald-400'}`}>2 mo free</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-gray-800/80 border border-gray-700" role="tablist" aria-label="Team plan size">
                      {TEAM_SIZES.map(sz => {
                        const active = sz.tier === teamSize.tier;
                        return (
                          <button
                            key={sz.tier}
                            role="tab"
                            aria-selected={active}
                            onClick={() => { setTeamSize(sz); setCheckoutFailed(false); }}
                            className={`py-2 rounded-lg text-xs font-semibold transition-colors ${
                              active ? 'bg-blue-600 text-white shadow' : 'text-gray-400 hover:text-white'
                            }`}
                          >
                            Up to {sz.nodes} nodes
                            <span className={`block text-[10px] font-normal ${active ? 'text-blue-100' : 'text-gray-500'}`}>
                              {cycle === 'annual' ? `${usd(sz.annual)}/yr` : `${usd(sz.monthly)}/mo`}
                            </span>
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

                {/* CTA — mt-auto pushes to bottom so buttons align across cards.
                    Team gets a checkout button only while self-serve is on;
                    otherwise (off / unknown / error) it keeps the mailto. */}
                {isTeamCard && selfServe ? (
                  <div className="mt-auto space-y-2">
                    <button
                      onClick={() => void startTeamCheckout(teamSize.tier, cycle)}
                      disabled={checkoutBusy}
                      aria-busy={checkoutBusy}
                      className={`${ctaCls} disabled:opacity-70 disabled:cursor-wait`}
                    >
                      {checkoutBusy
                        ? 'Opening checkout…'
                        : `Subscribe — ${usd(cycle === 'annual' ? teamSize.annual : teamSize.monthly)}${cycle === 'annual' ? '/yr' : '/mo'}`}
                      {!checkoutBusy && <ArrowRight className="w-3.5 h-3.5" />}
                    </button>
                    {checkoutFailed ? (
                      <p className="text-[11px] text-amber-400/90 text-center leading-relaxed" role="alert">
                        Checkout couldn't open. <a href={tier.cta.href} className="text-blue-400 hover:text-blue-300 underline underline-offset-2">Contact us</a> and we'll set you up.
                      </p>
                    ) : !isLoggedIn ? (
                      <p className="text-[11px] text-gray-500 text-center">You'll create an account (or sign in) first.</p>
                    ) : null}
                    <p className="text-[11px] text-gray-500 text-center leading-relaxed">
                      By purchasing you agree to the {legalLink('/terms', 'Terms')} and {legalLink('/refund', 'Refund Policy')}.
                    </p>
                  </div>
                ) : (
                  <a href={tier.cta.href} className={ctaCls}>
                    {tier.cta.label}
                    <ArrowRight className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>
            );
          })}
        </div>

        {/* Legal footer — Paddle (merchant of record) expects the Terms,
            Refund and Privacy pages to be reachable from where people buy. */}
        <p className="text-[11px] text-gray-500 text-center leading-relaxed -mt-6">
          Prices in USD, excluding applicable taxes (calculated at checkout). Orders are processed by Paddle.com, our merchant of record.
          By purchasing you agree to the {legalLink('/terms', 'Terms of Service')} and {legalLink('/refund', 'Refund Policy')}.
          See also our {legalLink('/privacy', 'Privacy Policy')}.
        </p>

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
