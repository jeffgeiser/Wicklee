/* Appends the Google Fonts stylesheet after the parser has moved on, so the
 * first paint does not wait on fonts.googleapis.com. Same-origin file because
 * the CSP forbids inline scripts. The <noscript> fallback in index.html covers
 * JS-disabled visitors; the preconnect hints warm the two font origins. */
(function () {
  var l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap';
  document.head.appendChild(l);

  /* Load diagnostics: open any page with `?perf=1` (or `#perf`) and /perf.js
   * renders the browser's own load timeline as a copyable report — the phone's
   * stand-in for a Network waterfall. Ordinary visits never request the file;
   * this is a regex on the query string and nothing else. Lives here rather
   * than in index.html so it costs no extra <script> tag on every page. */
  if (/[?&#]perf(?:=|&|$)/.test(location.search + location.hash)) {
    var s = document.createElement('script');
    s.src = '/perf.js';
    document.head.appendChild(s);
  }
})();
