#!/usr/bin/env node
/**
 * gen-og-image.mjs — render public/og-image.png (1200×630), the social/link
 * preview card for wicklee.dev (Slack/X/LinkedIn/Discord unfurls + AI cards).
 *
 * One-time / on-demand asset generation — NOT part of the normal build.
 * Requires `sharp` (native): `npm i -D sharp` then `node scripts/gen-og-image.mjs`.
 * The produced PNG is committed, so the build/deploy never needs sharp.
 *
 * Palette + copy mirror the site (bg gray-900 #111827, blue #2563eb / #60a5fa,
 * hero line from LandingPage.tsx). Typeface is whatever sans the renderer has
 * (Liberation/DejaVu here); swap in a bundled Inter .ttf for an exact brand
 * match if desired.
 */
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../public/og-image.png');
const FONT = 'Liberation Sans, DejaVu Sans, Arial, sans-serif';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="g1" cx="12%" cy="18%" r="55%">
      <stop offset="0%"  stop-color="#2563eb" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#2563eb" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="g2" cx="90%" cy="88%" r="50%">
      <stop offset="0%"  stop-color="#22d3ee" stop-opacity="0.14"/>
      <stop offset="100%" stop-color="#22d3ee" stop-opacity="0"/>
    </radialGradient>
    <filter id="glow" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur stdDeviation="7" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <rect width="1200" height="630" fill="#111827"/>
  <rect width="1200" height="630" fill="url(#g1)"/>
  <rect width="1200" height="630" fill="url(#g2)"/>
  <rect x="0" y="0" width="1200" height="6" fill="#2563eb"/>

  <!-- Wordmark with the logo's blue orb accent -->
  <g font-family="${FONT}" font-weight="700">
    <text x="80" y="118" font-size="40" fill="#f9fafb">wicklee</text>
    <circle cx="300" cy="104" r="7" fill="#3b82f6" filter="url(#glow)"/>
  </g>

  <!-- Hero -->
  <g font-family="${FONT}" font-weight="700">
    <text x="78" y="290" font-size="62" fill="#f9fafb">Self-hosted AI inference,</text>
    <text x="78" y="370" font-size="62" fill="#60a5fa">fully observable.</text>
  </g>

  <!-- Subline -->
  <text x="80" y="452" font-family="${FONT}" font-weight="400" font-size="30" fill="#9ca3af">WES — the MPG for local AI   ·   Ollama · vLLM · llama.cpp</text>

  <!-- Footer -->
  <g font-family="${FONT}" font-weight="400" font-size="26">
    <text x="80" y="560" fill="#e5e7eb">wicklee.dev</text>
    <text x="270" y="560" fill="#6b7280">Install in 60s — no sudo, no account, nothing to configure.</text>
  </g>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(OUT);
console.log(`[og-image] wrote ${OUT}`);
