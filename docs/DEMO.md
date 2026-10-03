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

The Space card is version-controlled at `deploy/hf-space/README.md` — copy it
in rather than retyping the front-matter (HF requires it).

```bash
npm run build:demo                                   # → dist-demo/

git clone https://huggingface.co/spaces/<user>/wicklee-fleet-demo hf-space
cp -r dist-demo/*                 hf-space/          # index.html + assets/
cp    deploy/hf-space/README.md   hf-space/README.md  # Space card

cd hf-space && git add -A && git commit -m "Wicklee fleet demo" && git push
```

Notes:

- Create the Space first at https://huggingface.co/new-space → SDK **Static**.
  Push over HTTPS with an HF access token (write scope) as the password, or
  add an SSH key.
- The Space serves `index.html` from the repo root — `dist-demo/*` must land
  at the root, not inside a subdirectory.
- Assets are referenced with **absolute** paths (`/assets/…`, Vite's default
  `base: '/'`). That is fine on HF: a static Space is served from its own
  subdomain root (`https://<user>-<space>.hf.space/`), so no base-URL rebuild
  is needed. It would break only if the bundle were hosted under a sub-path.
- `index.html` carries `<link rel="canonical" href="https://wicklee.dev/">`,
  so the Space does not compete with the real site in search results.
- Re-deploying is the same three copies plus a push; the demo is deterministic,
  so there is no state to migrate.

## Verifying before you deploy

The bundle is static, so serve it and look at it — but serve it on a **real
hostname, or on localhost** (both work; see below):

```bash
npm run build:demo
npx serve dist-demo -l 8099        # → http://localhost:8099
```

Check: six nodes in Fleet Status, non-zero throughput/WES tiles, the demo
banner with the install one-liner, and a clean browser console (no
`ws://…/ws`, no `/api/*` 404s — those mean the demo shim was bypassed).

> Historical note: before `src/utils/buildTarget.ts` existed, five modules
> each did a bare `window.location.hostname === 'localhost'` check to decide
> "talk to the local agent." Previewing the demo on localhost therefore tripped
> every one of them and rendered an empty dashboard reading *"Connecting to
> local agent…"*, even though the synthetic stream was running fine underneath.
> `IS_LOCAL_HOST` now excludes the demo target, so local preview matches
> production. There is no automated smoke test yet — a Playwright check that
> asserts the six nodes and a clean console would be a cheap, worthwhile add.
