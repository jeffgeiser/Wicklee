/**
 * Post-auth return path for the Clerk sign-in / sign-up pages.
 *
 * /pricing sends signed-out buyers to `/sign-up?redirect_url=/pricing?plan=…`
 * so they land back on the Team card with their selection after auth. Only a
 * same-origin path is accepted — "/…", never "//host" or "/\host" (browsers
 * treat both as protocol-relative) and never an absolute URL — so the param
 * can't be used as an open redirect.
 */
export function safeRedirectPath(search: string): string | null {
  const raw = new URLSearchParams(search).get('redirect_url');
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null;
  return raw;
}
