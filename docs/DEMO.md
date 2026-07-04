# Demo Fleet Mode (demo.wicklee.dev + Hugging Face Space)

The demo build (`npm run build:demo` → `dist-demo/`) is the full cloud
dashboard running against a **synthetic fleet** — no Clerk, no backend, no
account. Six imaginary nodes with scripted stories:

| Node | Story |
|---|---|
| Studio · M4 Max | healthy Apple Silicon prod inference |
| Rig A/B · 4090 | env:prod pair; Rig B swaps models every ~2.5 min |
| DGX · H100 | big model, high throughput |
| Mini · M2 | thermally throttles every ~4 min (Fair → Serious, WES penalty visible) |
| Edge · 4060 | drops offline for 40s every 5 min |

## How it works

- `VITE_BUILD_TARGET=demo` (`.env.demo`) — build-time constant, dead-code
  eliminated everywhere else.
- `src/demo/demoFleet.ts` — deterministic generator (seeded PRNG + sines over
  wall-clock time; no stored state, same demo every visit).
- `src/demo/demoEventSource.ts` — fake EventSource feeding frames through the
  **production** FleetStreamContext processing path at 1 Hz.
- `src/demo/demoApi.ts` — fetch shim serving fixtures for every `/api/*` GET
  (history charts, observations, SLOs, chargeback, audit log, alerts, keys…)
  so no tab looks broken; every write returns a friendly read-only 403.
- Clerk is fully absent: the demo renders `AppCore` directly with a fake
  Team-tier user; components that use Clerk (Sidebar account actions,
  AddNodeModal, APIKeysView, TeamManagement) gate on the demo flag.

## Deploying demo.wicklee.dev

The output is purely static:

```bash
npm run build:demo        # → dist-demo/
```

Host `dist-demo/` anywhere static (Cloudflare Pages project with a `demo`
CNAME is the natural fit next to wicklee.dev). No server config needed — the
demo never calls out.

## Publishing the Hugging Face Space

1. Create a new Space → SDK: **Static**.
2. Copy `dist-demo/*` into the Space repo root.
3. Add this `README.md` at the Space root (front-matter is required by HF):

```markdown
---
title: Wicklee Fleet Demo
emoji: 🕯️
colorFrom: indigo
colorTo: gray
sdk: static
pinned: false
license: mit
short_description: Live demo of Wicklee — hardware-first observability for local AI fleets
---

# Wicklee — Fleet Demo

A synthetic six-node GPU fleet streaming live into the real Wicklee
dashboard: WES (tokens per watt with thermal penalty), thermal throttling,
model swaps, cost & $/1M-token chargeback, SLO error budgets.

Install on your own nodes: `curl -fsSL https://wicklee.dev/install.sh | bash`
→ https://wicklee.dev
```

4. Commit — the Space serves `index.html` at its root.

Verification: `demo-smoke` (Playwright) drives the built bundle headlessly and
asserts the banner, nodes, models, and install snippet render with zero page
errors — run before every re-deploy.
