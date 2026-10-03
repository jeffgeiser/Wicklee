/**
 * Single sign-on settings section (Enterprise).
 *
 * There is deliberately no "enable SSO" control here, because SSO is not a
 * Wicklee feature flag. Authentication is delegated entirely to Clerk, and the
 * backend validates the session JWT reading only `sub` and the org role claim —
 * it never inspects how the user authenticated. A SAML/OIDC login therefore
 * produces the same session as a password login, and RBAC, audit logging and
 * org scoping all behave identically.
 *
 * What an Enterprise admin actually needs is to know WHERE their SSO is
 * configured, which differs by deployment:
 *
 *   - Self-hosted: they own the Clerk application, so they configure enterprise
 *     connections in their own tenant against their own IdP. Nothing is needed
 *     from us, and no identity data transits Wicklee infrastructure.
 *   - Hosted wicklee.dev: the connection lives in our Clerk instance and is
 *     scoped to their Organization, so it goes through us.
 *
 * This panel tells them which case they are in and what to do about it, rather
 * than inventing a status indicator we cannot honestly derive.
 */
import React, { useEffect, useState } from 'react';
import { KeyRound, Lock, ExternalLink } from 'lucide-react';
import { CLOUD_URL } from '../../utils/cloudUrl';
import { CONTACT_EMAIL, mailto } from '../../utils/contact';

interface Props {
  subscriptionTier: string;
  onNavigateToPricing?: () => void;
}

const SSO_GUIDE = 'https://github.com/jeffgeiser/Wicklee/blob/main/docs/SSO.md';

const SsoSection: React.FC<Props> = ({ subscriptionTier, onNavigateToPricing }) => {
  const isEnterprise = ['business', 'enterprise'].includes(subscriptionTier);

  // /health reports self_hosted only on self-hosted deployments; it is
  // unauthenticated and returns no platform stats.
  const [selfHosted, setSelfHosted] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${CLOUD_URL}/health`);
        if (!r.ok) return;
        const j = await r.json() as { self_hosted?: boolean };
        if (!cancelled) setSelfHosted(!!j.self_hosted);
      } catch {
        /* leave null — the panel simply omits the deployment-specific line */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const header = (
    <div className="px-6 py-4 border-b border-gray-700 flex items-center gap-3">
      <div className="p-1.5 rounded-lg bg-violet-500/10 flex items-center justify-center">
        <KeyRound className="w-3.5 h-3.5 text-violet-400" />
      </div>
      <div>
        <h3 className="text-sm font-semibold text-gray-200">Single sign-on</h3>
        <p className="text-[10px] text-gray-500">SAML / OIDC through your identity provider</p>
      </div>
    </div>
  );

  if (!isEnterprise) {
    return (
      <div className="bg-gray-800 border border-gray-700 rounded-2xl">
        {header}
        <div className="px-6 py-6 space-y-4">
          <div className="rounded-xl bg-violet-500/5 border border-violet-500/20 px-5 py-4 flex items-start gap-3">
            <Lock size={14} className="text-violet-400 mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="text-xs font-semibold text-gray-200">Single sign-on — Enterprise</p>
              <p className="text-[11px] text-gray-500 leading-relaxed">
                Authenticate with Okta, Microsoft Entra ID, Google Workspace, or any
                SAML 2.0 / OIDC provider. Members keep the same Admin / Member / Viewer
                org roles, enforced server-side on every write.
              </p>
            </div>
          </div>
          <button
            onClick={() => onNavigateToPricing?.()}
            className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white transition-colors"
          >
            Talk to us about Enterprise
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-2xl">
      {header}
      <div className="px-6 py-6 space-y-4">
        <p className="text-[11px] text-gray-400 leading-relaxed">
          Wicklee delegates authentication to Clerk and reads only the user and org
          role from the session token — so an SSO login behaves exactly like any
          other. There is nothing to switch on here; connections are configured in
          Clerk.
        </p>

        {selfHosted === true && (
          <div className="rounded-xl bg-emerald-500/5 border border-emerald-500/20 px-5 py-4 space-y-1.5">
            <p className="text-xs font-semibold text-emerald-300">Self-hosted — you own this</p>
            <p className="text-[11px] text-gray-400 leading-relaxed">
              This control plane runs against your own Clerk application, so you can
              add an enterprise SAML or OIDC connection in your own Clerk tenant,
              against your own IdP. No identity data passes through Wicklee
              infrastructure and nothing is required from us.
            </p>
          </div>
        )}

        {selfHosted === false && (
          <div className="rounded-xl bg-blue-500/5 border border-blue-500/20 px-5 py-4 space-y-1.5">
            <p className="text-xs font-semibold text-blue-300">Hosted — configured with us</p>
            <p className="text-[11px] text-gray-400 leading-relaxed">
              On wicklee.dev the connection is created in our Clerk instance and scoped
              to your organization. Email us at{' '}
              <a href={mailto(CONTACT_EMAIL, 'Wicklee SSO setup')} className="text-blue-400 hover:text-blue-300">
                {CONTACT_EMAIL}
              </a>{' '}
              with your IdP and the full list of email domains your team signs in with.
            </p>
          </div>
        )}

        <div className="rounded-xl bg-amber-500/5 border border-amber-500/20 px-5 py-3">
          <p className="text-[11px] text-amber-200/90 leading-relaxed">
            <strong className="font-semibold">Domain matching is exact.</strong> A SAML
            connection covers one email domain and does not include subdomains by
            default — someone at <code className="font-mono text-[10px]">sales.example.com</code> cannot
            sign in through a connection for <code className="font-mono text-[10px]">example.com</code>.
            List every domain up front.
          </p>
        </div>

        <a
          href={SSO_GUIDE}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-violet-400 hover:text-violet-300 transition-colors"
        >
          Enterprise SSO setup guide
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  );
};

export default SsoSection;
