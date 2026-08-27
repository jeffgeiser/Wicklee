/**
 * Published contact addresses.
 *
 * Every address that appears on a public page comes from here. They had drifted
 * to eight separate literals — jeff@, sales@, support@, legal@, privacy@,
 * security@ — scattered across the pricing page, trust page, design-partner
 * page, terms/privacy/refund pages and the AI plugin manifest, which is both
 * more surface than a one-person company needs and more places to get wrong.
 *
 * The scheme is deliberately small:
 *
 *   CONTACT  — everything commercial and everything support. A real name is
 *              more credible than a `sales@` alias that routes to the same
 *              person anyway; nobody is fooled by the alias and the reply comes
 *              from a human either way.
 *   SECURITY — kept separate because researchers look for exactly this address,
 *              it is published in SECURITY.md, and a bounce there turns a
 *              private disclosure into a public one.
 *   PRIVACY  — kept separate because the Privacy Policy names it and data
 *              subject requests conventionally go to a privacy alias.
 *
 * Note these only work while the domain has mail routing (a Cloudflare Email
 * Routing catch-all forwarding to a real inbox is the cheap way). Adding a new
 * address here without a catch-all publishes a dead end.
 *
 * Not in this file, deliberately:
 *   - alerts@wicklee.dev — the OUTBOUND Resend sender for alert and digest
 *     email (FROM_EMAIL in the cloud). It is a sender, not somewhere to write.
 *   - demo@wicklee.dev — fake user data in the demo build, never published.
 */

/** Commercial, sales, support, and general enquiries. */
export const CONTACT_EMAIL = 'jeff@wicklee.dev';

/** Vulnerability disclosure. Mirrored in SECURITY.md — keep the two in sync. */
export const SECURITY_EMAIL = 'security@wicklee.dev';

/** Privacy and data-subject requests. Named in the Privacy Policy. */
export const PRIVACY_EMAIL = 'privacy@wicklee.dev';

/**
 * Build a mailto: URL with an optional pre-filled subject and body.
 * Both are encoded here so callers pass readable strings.
 */
export function mailto(
  address: string,
  subject?: string,
  body?: string,
): string {
  const params: string[] = [];
  if (subject) params.push(`subject=${encodeURIComponent(subject)}`);
  if (body) params.push(`body=${encodeURIComponent(body)}`);
  return `mailto:${address}${params.length ? `?${params.join('&')}` : ''}`;
}
