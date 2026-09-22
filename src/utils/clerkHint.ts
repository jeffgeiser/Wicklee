/**
 * clerkHint.ts — is there any evidence of a Clerk session, before Clerk loads?
 *
 * Clerk drops two cookies on the application domain when a user is signed in:
 *
 *   __session      the short-lived session JWT (~1 min, refreshed by ClerkJS)
 *   __client_uat   "client updated at" — a unix timestamp while signed in,
 *                  and literally `0` once signed out
 *
 * Both are absent (or `__client_uat=0`) for a visitor who has never signed in
 * or has signed out. That is the common case for the landing page, and it is
 * the case that should not have to wait for ClerkJS to confirm it.
 *
 * This is a hint, not an auth check: nothing is trusted on the strength of it.
 * A false negative (signed in, cookie somehow unreadable) means the landing
 * page shows for a beat before the dashboard — the behaviour before the gate
 * existed. A false positive means that visitor waits for Clerk as before.
 */
export function hasClerkSessionHint(cookie: string): boolean {
  if (!cookie) return false;
  for (const part of cookie.split(';')) {
    const [rawName, ...rest] = part.split('=');
    const name = rawName.trim();
    const value = rest.join('=').trim();
    if (name === '__session' && value.length > 0) return true;
    if (name === '__client_uat' && /^[1-9]\d*$/.test(value)) return true;
  }
  return false;
}
