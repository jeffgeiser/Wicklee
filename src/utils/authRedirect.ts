/**
 * Post-auth return path for the Clerk sign-in / sign-up pages.
 *
 * /pricing sends signed-out buyers to `/sign-up?redirect_url=/pricing?plan=…`
 * so they land back on the Team card with their selection after auth. Only a
 * same-origin path is accepted, so the param can't be used as an open
 * redirect. The value is resolved with the URL parser rather than prefix
 * checks: browsers strip tabs/newlines and treat "\" like "/", so strings such
 * as "/\t/evil.example" or "/\evil.example" are protocol-relative in practice.
 */
export function safeRedirectPath(search: string, origin: string = window.location.origin): string | null {
  const raw = new URLSearchParams(search).get('redirect_url');
  if (!raw || !raw.startsWith('/')) return null;
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
