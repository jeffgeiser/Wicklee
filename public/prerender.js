/* Hides the prerendered SEO block so it doesn't flash before React mounts.
 *
 * The block (injected by scripts/generate-static-pages.mjs) lives inside #root
 * and is cleared by createRoot().render(). With a ~1.6 MB bundle that leaves a
 * visible beat where a narrower, nav-less version of the page paints and then
 * shifts away.
 *
 * Why a tiny same-origin file rather than the obvious alternatives:
 *
 *   - Inline <script> is blocked: the CSP in index.html sets
 *     script-src 'self' ... with no 'unsafe-inline'. 'self' allows this file.
 *   - A CSS animation reveal was tried first and rejected. It depends on the
 *     document animation clock, which is suspended in some environments
 *     (verified: document.timeline.currentTime stays 0 under headless
 *     Chromium). Where animations don't run, the content would never appear at
 *     all — turning a cosmetic flash into a blank page whenever the bundle
 *     fails. setTimeout has no such problem.
 *   - Plain display:none loses the block's second job. It is not only for
 *     crawlers; it is the graceful fallback when the bundle fails or the
 *     network stalls. Hiding it unconditionally means a broken load shows
 *     nothing at all.
 *
 * So: hide immediately, and put it back if React hasn't taken over in time.
 * Every failure mode degrades to "content is visible", which is the safe
 * direction — if this file 404s or JS is disabled, nothing runs and the block
 * simply stays visible exactly as it does today.
 */
(function () {
  var el = document.getElementById('wk-prerender');
  if (!el) return;

  el.style.display = 'none';

  // If the app hasn't replaced #root by now, the bundle is slow or broken —
  // show the readable content rather than leaving a blank page.
  setTimeout(function () {
    if (el.isConnected) el.style.display = '';
  }, 4000);
})();
