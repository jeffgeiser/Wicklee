/* Load-diagnostics overlay. Loaded by /fonts.js only when the URL carries
 * `perf` (e.g. https://wicklee.dev/pricing?perf=1); ordinary visitors never
 * fetch this file.
 *
 * Phones have no Web Inspector, but every browser keeps a performance timeline
 * of its own: navigation timing, one resource-timing entry per request, paint
 * and largest-contentful-paint entries, long tasks (Chromium), and the `wk:*`
 * User Timing marks the app records as it boots. This script reads that
 * timeline a moment after `load` and renders it as a plain-text report with
 * Copy and Share buttons, so the numbers from the actual device on the actual
 * network can be pasted into a chat or an issue.
 *
 * Cross-origin resources (Clerk, Paddle, Google Fonts) expose start and end
 * times but hide sizes and wait/download split unless they send
 * Timing-Allow-Origin — those show as `?`. The waterfall shape is still there.
 */
(function () {
  'use strict';
  if (!window.performance || !performance.getEntriesByType) return;
  try { performance.setResourceTimingBufferSize(600); } catch (e) { /* optional */ }

  var lcp = null, longTasks = [], shift = 0;
  function observe(type, cb) {
    try {
      var po = new PerformanceObserver(function (list) { list.getEntries().forEach(cb); });
      po.observe({ type: type, buffered: true });
      return true;
    } catch (e) { return false; }
  }
  var hasLcp = observe('largest-contentful-paint', function (e) { lcp = e; });
  var hasLongTask = observe('longtask', function (e) { longTasks.push(e); });
  observe('layout-shift', function (e) { if (!e.hadRecentInput) shift += e.value; });

  function ms(v) { return (v == null || isNaN(v)) ? '-' : Math.round(v) + 'ms'; }
  function kb(b) { return b ? (b / 1024).toFixed(b < 10240 ? 1 : 0) + 'kB' : '?'; }
  function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
  function lpad(s, n) { s = String(s); while (s.length < n) s = ' ' + s; return s; }
  function short(url) {
    try {
      var u = new URL(url), p = u.pathname;
      if (p.length > 52) p = p.slice(0, 24) + '…' + p.slice(-26);
      return (u.host === location.host ? '' : u.host) + p;
    } catch (e) { return url; }
  }

  function report() {
    var L = [];
    var nav = performance.getEntriesByType('navigation')[0];
    var c = navigator.connection || {};
    L.push('Wicklee load report  ' + new Date().toISOString());
    L.push('url: ' + location.href.replace(/[?&#]perf(=[^&#]*)?/, ''));
    L.push('ua: ' + navigator.userAgent);
    L.push('viewport: ' + innerWidth + 'x' + innerHeight + ' @' + devicePixelRatio + 'x' +
      (c.effectiveType ? '   net: ' + c.effectiveType + (c.downlink ? ' ' + c.downlink + 'Mbps' : '') + (c.rtt ? ' rtt ' + c.rtt + 'ms' : '') : '   net: (not exposed by this browser)'));
    if (nav) {
      L.push('');
      L.push('navigation (' + nav.type + (nav.deliveryType ? ', ' + nav.deliveryType : '') + '):');
      L.push('  redirect ' + ms(nav.redirectEnd - nav.redirectStart) +
        '  dns ' + ms(nav.domainLookupEnd - nav.domainLookupStart) +
        '  connect ' + ms(nav.connectEnd - nav.connectStart) +
        '  ttfb ' + ms(nav.responseStart) +
        '  html ' + ms(nav.responseEnd - nav.responseStart) +
        '  ' + kb(nav.transferSize) + (!nav.transferSize && nav.decodedBodySize ? ' (cache)' : ''));
      L.push('  domInteractive ' + ms(nav.domInteractive) +
        '  DOMContentLoaded ' + ms(nav.domContentLoadedEventEnd) +
        '  load ' + (nav.loadEventEnd ? ms(nav.loadEventEnd) : '(not yet)'));
    }
    L.push('');
    L.push('paint:');
    performance.getEntriesByType('paint').forEach(function (p) { L.push('  ' + pad(p.name, 26) + ms(p.startTime)); });
    if (lcp) {
      var el = lcp.element;
      L.push('  ' + pad('largest-contentful-paint', 26) + ms(lcp.startTime) +
        (el ? '  <' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '> ' + (el.textContent || el.currentSrc || '').trim().slice(0, 40) : ''));
    } else {
      L.push('  largest-contentful-paint  ' + (hasLcp ? '(none recorded yet)' : '(not supported by this browser)'));
    }
    var marks = performance.getEntriesByType('mark').filter(function (m) { return m.name.indexOf('wk:') === 0; });
    if (marks.length) {
      L.push('');
      L.push('app marks:');
      marks.forEach(function (m) { L.push('  ' + pad(m.name.slice(3), 20) + ms(m.startTime)); });
    }
    if (document.getElementById('wk-prerender')) {
      L.push('  !! prerendered block still in the DOM — React has not mounted');
    }
    L.push('');
    if (hasLongTask) {
      var tot = 0, max = 0;
      longTasks.forEach(function (t) { tot += t.duration; if (t.duration > max) max = t.duration; });
      L.push('main thread: ' + longTasks.length + ' long tasks, total ' + ms(tot) + ', longest ' + ms(max) + '   layout shift ' + shift.toFixed(3));
    } else {
      L.push('main thread: long tasks not exposed by this browser   layout shift ' + shift.toFixed(3));
    }
    L.push('');
    var res = performance.getEntriesByType('resource').slice().sort(function (a, b) { return a.startTime - b.startTime; });
    L.push('resources (' + res.length + '):  start→end   wait/download   size    type     url');
    res.forEach(function (r) {
      var timing = r.responseStart
        ? ms(r.responseStart - r.startTime) + '/' + ms(r.responseEnd - r.responseStart)
        : ms(r.duration) + ' (opaque)';
      var size = r.transferSize ? kb(r.transferSize) : (r.decodedBodySize ? 'cache' : '?');
      L.push('  ' + lpad(Math.round(r.startTime), 5) + '→' + pad(Math.round(r.responseEnd), 5) +
        '  ' + pad(timing, 15) + ' ' + pad(size, 7) + ' ' + pad(r.initiatorType || '', 8) + ' ' + short(r.name) +
        (r.renderBlockingStatus === 'blocking' ? '  [render-blocking]' : ''));
    });
    return L.join('\n');
  }

  // ── UI ────────────────────────────────────────────────────────────────────
  var root = document.createElement('div');
  root.id = 'wk-perf';
  var S = root.style;
  S.position = 'fixed'; S.left = '0'; S.right = '0'; S.bottom = '0'; S.zIndex = '2147483647';
  S.maxHeight = '62vh'; S.display = 'flex'; S.flexDirection = 'column';
  S.background = '#0b1220'; S.color = '#e5e7eb'; S.borderTop = '2px solid #3b82f6';
  S.font = '12px/1.4 -apple-system, system-ui, sans-serif'; S.boxShadow = '0 -8px 30px rgba(0,0,0,.5)';

  var bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:8px;align-items:center;padding:8px 10px;flex:none;border-bottom:1px solid #1f2937';
  var title = document.createElement('span');
  title.textContent = 'Load report';
  title.style.cssText = 'font-weight:600;margin-right:auto';
  bar.appendChild(title);

  function button(label, onClick) {
    var b = document.createElement('button');
    b.type = 'button'; b.textContent = label;
    b.style.cssText = 'appearance:none;border:1px solid #374151;background:#1f2937;color:#f9fafb;border-radius:6px;padding:6px 10px;font:inherit;font-weight:500';
    b.addEventListener('click', onClick);
    bar.appendChild(b);
    return b;
  }

  var pre = document.createElement('pre');
  pre.style.cssText = 'margin:0;padding:10px;overflow:auto;flex:1;font:10px/1.45 ui-monospace,Menlo,monospace;white-space:pre;-webkit-user-select:text;user-select:text;-webkit-overflow-scrolling:touch';

  var pill = document.createElement('button');
  pill.type = 'button'; pill.textContent = 'perf';
  pill.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;appearance:none;border:0;border-radius:999px;padding:8px 14px;background:#3b82f6;color:#fff;font:600 12px system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.4);display:none';
  pill.addEventListener('click', show);

  function refresh() { pre.textContent = report(); }
  function show() { refresh(); pill.style.display = 'none'; if (!root.isConnected) document.body.appendChild(root); }
  function hide() { if (root.isConnected) root.remove(); pill.style.display = ''; }

  var copyBtn = button('Copy', function () {
    var text = pre.textContent;
    function done(ok) { copyBtn.textContent = ok ? 'Copied ✓' : 'Select text to copy'; setTimeout(function () { copyBtn.textContent = 'Copy'; }, 2500); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallback(); });
    } else fallback();
    function fallback() {
      try {
        var range = document.createRange(); range.selectNodeContents(pre);
        var sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
        done(document.execCommand('copy'));
      } catch (e) { done(false); }
    }
  });
  if (navigator.share) {
    button('Share', function () {
      navigator.share({ title: 'Wicklee load report', text: pre.textContent }).catch(function () { /* user cancelled */ });
    });
  }
  button('Refresh', refresh);
  button('Hide', hide);

  root.appendChild(bar);
  root.appendChild(pre);
  document.documentElement.appendChild(pill);

  // Open a beat after `load` so late arrivals (ClerkJS, fonts, the lazy app
  // chunk) are in the list. Refresh re-reads the timeline at any time.
  function armed() { setTimeout(show, 2500); }
  if (document.readyState === 'complete') armed(); else addEventListener('load', armed);
})();
