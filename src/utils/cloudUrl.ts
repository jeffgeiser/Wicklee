/**
 * Canonical cloud base URL for the Wicklee fleet backend.
 *
 * Resolution rules (in priority order):
 *   1. `VITE_CLOUD_URL` env var when set:
 *        - "/"        → empty string (same-origin nginx proxy mode used by
 *                       the Railway frontend service; all /api/* calls go
 *                       through nginx → backend without crossing origins)
 *        - http(s)://… → used as-is
 *        - other       → prefixed with "https://"
 *   2. Default → "https://wicklee.dev" (production canonical hostname).
 *
 * Why this lives in one place: this resolver had drifted across 14 files —
 * some defaulted to `https://wicklee.dev`, others to the raw Railway
 * hostname `https://vibrant-fulfillment-production-62c0.up.railway.app`.
 * Mixed defaults meant that if the Railway URL changed, half the app
 * would break and half wouldn't. Single source of truth fixes that.
 */
export const CLOUD_URL: string = (() => {
  const v = (import.meta.env.VITE_CLOUD_URL as string | undefined) ?? '';
  if (!v) return 'https://wicklee.dev';
  if (v === '/') return '';
  return v.startsWith('http') ? v : `https://${v}`;
})();
