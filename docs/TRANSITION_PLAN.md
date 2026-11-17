# Wicklee: Transition Plan

2026-11-15 · Jeff Geiser

This is the ordered plan for moving the public site, the public documentation and the running infrastructure from the old product (dashboard, hosted fleet view, paid tiers) to the one described in `docs/STRATEGY.md`. It is written to be handed to Claude Code one step at a time.

The component-level decisions are in the "Deployed infrastructure" section of `docs/PHASE1_SPEC.md`. This document adds the order, the owner of each step and the check that says a step is done. Where the two disagree, this one is newer.

## End state

- **Cloudflare Pages** serves wicklee.dev: a static marketing and docs site built from `src/site/` only.
- **GitHub Releases** distributes the agent binary.
- Nothing else is running. No Railway services, no Postgres, no Paddle, no demo.

## Rules

1. Steps run in the order below. The order exists because later steps break public pages if earlier ones are skipped.
2. Steps marked **Maintainer** need account access or a judgement only Jeff can make. Claude Code does not attempt them.
3. Nothing that is public describes something that does not run. If a page mentions a feature, a price or a service, that thing exists.
4. Planned capabilities are labelled as planned. Readiness is described as informational until the displacement decision is made (see `docs/PHASE1_RESULTS.md`).
5. `cloud/` and `src/cloud/` stay frozen in the repository until step 7 decides otherwise. Removing links to them is in scope; editing them is not.
6. Each step is its own branch and pull request, with every CI job green, including the musl build.

## Steps

| # | Step | Owner | Depends on |
| --- | --- | --- | --- |
| 1 | Release v0.15.0 | Claude Code, then Maintainer | Nothing |
| 2 | Turn off payments | **Done, 2026-11-16.** All Paddle products archived, no active subscriptions, and `PADDLE_CHECKOUT_ENABLED` set false on Railway — `/api/billing/status` now answers `{"checkout_enabled":false}`. Step 3's deploy removed the route as well: `wicklee.dev/pricing` serves the landing shell with no Subscribe button, no price and no Paddle reference |
| 3 | Rewrite the public site | Claude Code | 2 |
| 4 | Rewrite the public markdown | Claude Code | Nothing |
| 5 | Remove the demo | Maintainer, then Claude Code | Nothing |
| 6 | Shut down Railway | Maintainer, then Claude Code | 3 |
| 7 | Decide the frozen cloud code | Maintainer | 6 |
| 8 | Second-host validation | Claude Code | 1 |

Steps 2, 4 and 5 can run in parallel with step 1. Steps 2 and 3 have the deadline: they are what a new visitor sees once the release is announced.

### 1. Release v0.15.0

- **Claude Code:** get every CI job green on `phase1/release` (PR #105), including `Agent · musl (no DuckDB)` and the frontend lint job. Both are red on `main` as of 2026-11-15.
- **Maintainer:** merge, then tag v0.15.0 from `main`. Do not move v0.14.0, which contains steps 0 to 4 only.
- **Done when:** the release workflow publishes every platform binary, including musl, and the release notes carry the known-issues section on displacement.

### 2. Turn off payments

All Maintainer, in this order:

1. Confirm in Paddle that there are no active subscriptions. Cancel and refund any that exist.
2. Turn checkout off in Paddle.
3. Tell Claude Code to proceed with step 3, which removes the pricing page.

- **Done when:** no route on wicklee.dev can start a checkout.

### 3. Rewrite the public site

Claude Code, in `src/site/`. Read `docs/STRATEGY.md` sections 2 and 4 and `docs/OVERVIEW.md` first; the positioning and the command surface come from there.

| Page | Action |
| --- | --- |
| `LandingPage.tsx` | Rewrite. Lead with the developer message and the find, fix, verify loop. Commands shown are `inspect`, `ready`, `findings`, `fingerprint`, `verify` and nothing else. No dashboard screenshots, no fleet view, no pricing |
| `PricingPage.tsx` | Remove the page, its route and every link to it. Remove `src/cloud/utils/loadPaddle.ts` usage from the site bundle and `src/types/paddle.d.ts` if nothing else uses it |
| `LegalPage.tsx` | Remove the Paddle merchant-of-record, billing and refund terms. Keep what still applies. Flag anything uncertain for the Maintainer instead of guessing at legal text |
| `DocsPage.tsx` | Already updated to the `/v1` surface. Remove any remaining fleet, pairing, sign-in or tier content |
| `TrustPage.tsx`, `DesignPartnersPage.tsx` | Review against `docs/STRATEGY.md`. Remove claims about the hosted service, SSO, audit logs or tiers. Report what is left and whether each page still earns its place |
| `BlogListing.tsx`, `BlogPost.tsx` | Keep. Remove pricing and sign-in links from the chrome. List any posts that describe the old product for the Maintainer to decide on |
| Site navigation and footer | Remove sign-in, dashboard, pricing and demo links |

Also fix the two known credibility errors if they are still present: "true cost" used for an electricity-only figure, and the cloud price comparison that is off by about 1,000 times in the metrics reference.

- **Done when:** a search of the built site finds no link to sign-in, the dashboard, pricing, the demo or `/api`; no mention of Paddle, tiers or the fleet view; and no command that does not exist in v0.15.0.

### 4. Rewrite the public markdown

Claude Code. `README.md` is handled in PR #105.

| File | Action |
| --- | --- |
| `docs/ROADMAP.md` | Rewrite to the five stages in `docs/STRATEGY.md` section 13 |
| `docs/SSO.md`, `docs/BILLING.md`, `docs/MODEL_GOVERNANCE.md`, `docs/TERRAFORM.md` | Delete. They document paid features that are withdrawn |
| `docs/SELF_HOSTING.md`, `docs/GRAFANA.md` | Delete with the fleet view unless step 7 keeps the cloud code. Until then, add a banner saying the hosted control plane is not maintained |
| `docs/DEMO.md` | Deleted in step 5 |
| `docs/QA_CHECKLIST.md`, `docs/leaderboard-charter.md` | Review and report. Delete what describes the dashboard |
| `CONTRIBUTING.md`, `SECURITY.md`, `LICENSING.md` | Check for references to the hosted service, tiers or deleted documents |
| The five AI-discovery files | Keep in sync, per the repository's own rule |

- **Done when:** no tracked markdown file describes a feature, price or service that does not run, and no file links to a deleted document.

### 5. Remove the demo

1. **Maintainer:** disconnect the `wicklee-demo` Cloudflare Pages project and take down the HF Space, so nothing serves a build that is about to disappear.
2. **Claude Code:** delete `src/demo/`, the three call sites in `src/index.tsx`, the `mode === 'demo'` branch in `vite.config.ts`, the `build:demo` script, `docs/DEMO.md` and `deploy/hf-space/`. Check `Sidebar.tsx`, `App.tsx`, `ModelsPage.tsx` and `FleetStreamContext.tsx` for demo-conditional branches first.

- **Done when:** the `wicklee-demo` check no longer appears on commits and the frontend job is green.

### 6. Shut down Railway

Only after step 3 is live, so no public page links to the backend.

1. **Claude Code:** confirm what a paired agent does when the backend is unreachable. `cloud_push.rs` must fail quietly, without log spam or retry storms. Fix it first if it does not.
2. ~~**Maintainer:** export Postgres.~~ **Decided 2026-11-17: skipped, no export.** There are no users in the field, so `users`, `organizations`, `api_keys` and `sessions` are the maintainer and test rows. The telemetry is already on each node and at finer resolution for the window that matters: the agent's local DuckDB keeps 24 h at 1 Hz, 30 days at 1-minute and 90 days at 1-hour, beside `config.toml` in a directory `install.sh` never touches, so it survives updates and reinstalls. Postgres only added 5-minute resolution on the 30–90 day window and one extra day of raw. Knowingly accepted as lost: the fleet-level tables that had no local twin — `fleet_observations`, `node_events`, `alert_events`, `model_catalog`, `slo_windows`. The database can be deleted with the services.
3. **Claude Code, before any service stops:** narrow the Cloudflare Pages build to `src/site/` so dashboard routes are no longer shipped to the static site. This has to come first, not after. Measured 2026-11-17: `wicklee.dev` is Cloudflare *proxying to Railway*, not Pages serving — `x-railway-edge: jfk1` on every response, and an unlisted path returns 200 from nginx's `try_files` rather than the 404 Pages would give. So stopping Railway today takes the whole site down, not just `/api`. Worse, the Pages copy answers `/api/billing/status` with `text/html` and a 200 — the SPA shell — where Railway answers `application/json`. Any dashboard code still shipped to Pages would therefore receive a web page where it expects JSON and fail confusingly instead of cleanly. Removing it first means nothing on the static site calls the backend at all.
4. **Maintainer:** point `wicklee.dev` at the `wicklee` Pages project instead of Railway (Pages → Custom domains, which rewrites the DNS record), then confirm every page loads, direct hits included. `wicklee.pages.dev` already serves the site, so the deployment exists; only the apex is still pointed at Railway.
5. **Maintainer:** stop both Railway services and the database.
6. **Claude Code:** delete the root `Dockerfile`, `nginx.conf`, `entrypoint.sh` and `railway.toml`.
7. **Claude Code: done.** `SECURITY.md` no longer lists a fleet backend in scope and now says plainly that there isn't one — `wicklee.dev` serves the site, the install scripts and the discovery files as static files and runs no API. The public site is in scope instead. `README.md` lost the hosted-fleet tagline, the `Cloud MCP Tools (wicklee.dev/mcp)` section and the whole `Enterprise Bridge` section: OTLP export and the Prometheus `/metrics` endpoint are cloud-only (the agent has neither, just `/api/metrics` as SSE), so all three bullets were hosted-service claims. The localhost MCP examples that sat under the cloud heading moved up to the local section rather than being deleted. Verified first that `install.sh`, `install.ps1` and all six discovery files are static files in `public/` served by Pages, so the install path and agent discovery survive the shutdown.
   **One gap left, deliberately deferred:** `public/openapi.json` lists `https://wicklee.dev` as its first server and carries an `/api/v1/fleet` path, with no way to express a prose banner. `llms.txt`, `api.md` and `docs.md` already carry "being shut down" notices from step 4. All four are better done in one pass once the services are actually stopped, when the wording becomes "shut down" rather than "being shut down" — doing it now means doing it twice.
8. **Maintainer:** check wicklee.dev end to end, then close the Railway project.

- **Done when:** wicklee.dev loads every page with Railway stopped, the built site contains no dashboard code, and no tracked file tells a reader to use or report against the hosted backend.

### 7. Decide the frozen cloud code

Maintainer. Once Railway is gone, `cloud/`, `src/cloud/`, `cloud_push.rs`, `pairing.rs`, `deploy/helm/` and `deploy/self-hosted/` have no deployment to talk to. Either delete them, which is the simpler position and is recoverable from git history, or keep them as the starting point for the self-hostable coordinator in Stage 4. Record the decision in `docs/STRATEGY.md`.

Four documents follow whichever way it goes, and Claude Code picks them up once the decision is recorded. `LICENSING.md` splits the repository between Apache 2.0 and FSL-1.1-Apache-2.0 by directory; deleting those directories leaves a licence document with a second half that has no referent, and that is a legal statement rather than a wording fix — flag it rather than rewriting it unasked. `CONTRIBUTING.md` opens by telling a contributor the control plane is source-available, for the same reason. `GRAFANA.md` and `SELF_HOSTING.md` carry a banner from step 4 saying the control plane is not maintained; they were kept rather than deleted precisely so this decision would have the description of the code to decide about, so deleting the code means deleting them too.

- **Done when:** the decision is in `docs/STRATEGY.md`, and no document describes a licence boundary or a deployment that the repository no longer has.

### 8. Second-host validation

Claude Code, on a second machine. A rented NVIDIA GPU with discrete VRAM is the preferred host; the DGX Spark is the third when it is available. On the Mac mini, a scenarios file with 1b-class models unblocks the tests that the larger models could not produce.

Run the bench scripts, commit the raw transcripts, add the host comparison to `docs/PHASE1_RESULTS.md` and write `docs/DISPLACEMENT_DECISION.md` without choosing an option. This is the step that decides what readiness promises and whether the agent-value hypothesis holds on a host where the smallest model is not the one that coexists.

## Status

| # | Step | Status |
| --- | --- | --- |
| 1 | Release v0.15.0 | **Done, 2026-11-16.** PRs #105 and #106 merged, `v0.15.0` tagged from `main` and published: four platform binaries plus `SHA256SUMS`, marked latest, release body carrying the displacement known-issue. `v0.14.0` unmoved. No musl asset — that one was retired in v0.8.2 (`install.sh`, `agent/src/update.rs`), so the four are the full set |
| 2 | Turn off payments | **Done, 2026-11-16.** All Paddle products archived, no active subscriptions. `PADDLE_CHECKOUT_ENABLED=false` is set on Railway and `/api/billing/status` now answers `{"checkout_enabled":false}`, verified against the live site. Step 3's deploy removed the route as well, so `wicklee.dev/pricing` serves the landing shell with no Subscribe button, no price and no Paddle reference |
| 3 | Rewrite the public site | **Done in PR #108.** `PricingPage` and the checkout deleted, `LandingPage` rewritten around find/fix/verify, `DesignPartnersPage` deleted (its whole offer was a withdrawn tier), `TrustPage` reduced to the data boundary, five hosted-only sections out of `DocsPage`, billing terms out of `LegalPage`, Paddle out of the CSP. Both credibility errors fixed. `Team+` strings survive only in frozen `src/cloud/` chunks, which step 6 stops shipping |
| 4 | Rewrite the public markdown | Done in PR #106, stacked on #105. `GRAFANA.md` and `SELF_HOSTING.md` are bannered rather than deleted, pending step 7 |
| 5 | Remove the demo | **Done, 2026-11-17.** Maintainer: the Hugging Face Space, the `wicklee-demo` Cloudflare Pages project and the `demo.wicklee.dev` DNS record are all deleted — the host is unresolvable and the `wicklee-demo` check no longer appears on commits. Claude Code, in PR #113: `src/demo/` (5 files), `deploy/hf-space/`, `docs/DEMO.md`, `.env.demo`, the `build:demo` script, the `mode === 'demo'` outDir branch and the now-unused `mode` param in `vite.config.ts`, the `dist-demo` entries in `.gitignore` and `eslint.config.js`, and every `IS_DEMO` branch in `index.tsx`, `App.tsx` (including the synthetic `DEMO_USER`), `FleetStreamContext.tsx` and `Sidebar.tsx`. `IS_DEMO` survives only as a pinned `false` in `src/utils/buildTarget.ts`, because `AddNodeModal`, `TeamManagement` and `APIKeysView` still read it and `src/cloud/` is frozen until step 7 — delete the constant and its three readers together. Nothing else tracked references the demo; step 3 had already removed the public links |
| 6 | Shut down Railway | **Items 1 and 2 closed.** Item 1: the `cloud_push.rs` retry defect is fixed in PR #110 — a failed push no longer bypasses the throttle, and the interval doubles from 2s to a 60s ceiling instead of hammering a dead backend at 1 Hz. Item 2: the Postgres export is **skipped by decision** — no users, and the telemetry is already on each node at finer resolution for the first 30 days. Outstanding: Claude Code narrows the Pages build (item 3, and it must land before the DNS switch), then the Maintainer repoints `wicklee.dev` to Pages, stops both services and the database, and closes the project. `wicklee.dev` is still Cloudflare proxying to Railway, so stopping it before the repoint takes every page down |
| 7 | Decide the frozen cloud code | Not started. Four documents wait on it: `LICENSING.md`, `CONTRIBUTING.md`, `GRAFANA.md`, `SELF_HOSTING.md` |
| 8 | Second-host validation | **Not started, and now the only unblocked step that is not waiting on the Maintainer.** Step 1 is done, which was its only dependency. The Mac mini half needs a scenarios file with 1b-class models; `scripts/bench/scenarios.json` is tracked and pre-filled with this M4's own values, which needs sorting out first. The preferred host is a rented NVIDIA GPU with discrete VRAM — a spend decision, so the Maintainer's |
