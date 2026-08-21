# Enterprise SSO (SAML / OIDC)

Wicklee delegates all authentication to [Clerk](https://clerk.com). The backend
validates the Clerk session JWT and reads only `sub` (user) and the org role
claim — it never inspects *how* the user authenticated.

**That has a useful consequence: SSO needs no application code.** A user who
signs in through Okta, Entra ID, or Google Workspace arrives with the same
session token shape as one who used a password, so RBAC, audit logging, org
scoping, and every API surface behave identically. Enabling SSO is a Clerk
configuration task, not a Wicklee release.

There are two deployment shapes, and they put the work in different hands.

---

## 1. Self-hosted control plane (Enterprise)

**Status: works today, nothing to enable on our side.**

A self-hosted deployment brings its own Clerk application
(`docs/SELF_HOSTING.md`). The customer therefore owns the Clerk instance and can
configure Enterprise SSO in their own tenant, against their own IdP, without
involving us at all — no data, no metadata, and no user directory passes through
Wicklee infrastructure.

This is the strongest version of the story for a regulated buyer: their identity
provider, their Clerk tenant, their control plane. Point them at
[Clerk's enterprise connections docs](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/overview)
and the provider-specific guide for their IdP
([Okta](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/saml/okta),
[Microsoft Entra ID](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/saml/azure),
[Google Workspace](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/saml/google),
or [any SAML 2.0 IdP](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/saml/custom-provider)).

Note that legacy DIY sessions (the API-only auth mode) have no org or SSO
support — SSO requires the Clerk path.

## 2. Hosted wicklee.dev

**Status: requires configuration in our Clerk instance, per customer org.**

Enterprise SSO is a paid Clerk capability, so this is gated on the Clerk plan
for the wicklee.dev instance. Once available, a connection is created in the
Clerk Dashboard and **scoped to a specific Organization** — leaving the
Organization unset would apply the connection application-wide, which is not
what you want for a single customer.

Rough shape of a per-customer setup:

1. The customer creates (or is invited to) a Wicklee Organization.
2. In the Clerk Dashboard, add an enterprise connection for their IdP and select
   that Organization.
3. Exchange metadata: Clerk supplies the ACS URL and Entity ID; the IdP supplies
   its metadata URL or certificate.
4. Verify the customer's email domain.
5. Test with one account before enabling the connection for the domain.

Clerk has since shipped **self-serve SSO** ([SAML, June 2026](https://clerk.com/changelog/2026-06-26-self-serve-sso);
[OIDC, July 2026](https://clerk.com/changelog/2026-07-30-self-serve-sso-oidc)),
which lets customers configure their own connection rather than routing every
deal through us. For a single-founder operation that is the difference between
SSO being a per-deal support burden and being a self-service feature — worth
checking whether it's available on the current plan before committing to manual
setup in a contract.

### The domain gotcha worth stating up front

SAML authentication requires the user's email domain to **exactly** match the
domain the connection was configured with. Subdomains are not included by
default — a user at `john@sales.example.com` cannot authenticate through a
connection configured for `example.com`.

Ask for the full list of email domains during onboarding. Discovering this after
go-live looks like a Wicklee bug and isn't one.

---

## What to promise in a contract

Accurate today:

- Self-hosted Enterprise: "authenticate against your own IdP through your own
  Clerk tenant; identity never transits Wicklee infrastructure."
- Hosted: "SSO/SAML available on request" — honest, because it needs the Clerk
  plan and a per-org connection.

Do **not** promise:

- SCIM / directory sync — not implemented anywhere. It appears in the roadmap's
  Enterprise packaging target but no provisioning code exists. A buyer asking
  for SCIM is asking for automated user lifecycle (deprovisioning on
  termination), which is a real compliance requirement and a real project.
- IdP group → Wicklee role mapping. Org roles are assigned in Clerk, not derived
  from SAML attributes. An SSO user still has to be given Admin / Member /
  Viewer like anyone else.
- **Authentication events in the audit log.** The trail covers operations —
  node add/remove/rename, alert and webhook configuration, API-key lifecycle,
  audit exports — but *not* sign-ins, sign-in failures, or session activity.
  Security reviewers ask for authentication logs specifically, so answer this
  one precisely: those live in Clerk's own logs, not in Wicklee's audit trail.
- Per-org SSO on hosted wicklee.dev as a self-serve toggle, until self-serve SSO
  is confirmed on the instance's Clerk plan.
