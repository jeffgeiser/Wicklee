/* Appends the Google Fonts stylesheet after the parser has moved on, so the
 * first paint does not wait on fonts.googleapis.com. Same-origin file because
 * the CSP forbids inline scripts. The <noscript> fallback in index.html covers
 * JS-disabled visitors; the preconnect hints warm the two font origins. */
(function () {
  var l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap';
  document.head.appendChild(l);
})();
