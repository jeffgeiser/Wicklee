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
| 6 | Shut down Railway | **Done, 2026-11-20.** Items 1 and 2 closed earlier (PR #110 retry fix; Postgres export skipped by decision). Narrowing the Pages build was skipped by decision. The Maintainer repointed `wicklee.dev` to Pages on 2026-11-17, stopped both services and the database on 2026-11-20, and closed the project; `/api/*`, `/mcp` and `/metrics` answer 404 and the site and install path are untouched |
| 7 | Decide the frozen cloud code | **Done, 2026-11-20: deleted.** Recorded in `docs/STRATEGY.md` §14. The four dependent documents are resolved: `GRAFANA.md` and `SELF_HOSTING.md` deleted, `LICENSING.md` and `CONTRIBUTING.md` updated (legal review still wanted). Follow-ups listed under step 7 |
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
| `docs/SELF_HOSTING.md`, `docs/GRAFANA.md` | Delete with the fleet view unless step 7 keeps the cloud code. Bannered until step 7; **deleted 2026-11-20** with the cloud code |
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
3. ~~**Claude Code:** narrow the Cloudflare Pages build to `src/site/`.~~ **Decided 2026-11-17: skipped.** The reason for it weakened once the switch landed: Cloudflare routes HTML to Pages and still sends `/api/*`, `/mcp` and `/metrics` to Railway, so the SPA fallback never answers an API call with the page shell. When the services stop, those paths fail outright rather than returning `text/html` with a 200, which is the cleaner failure. Cost of skipping: Pages keeps shipping ~1.2 MB of dashboard JS it cannot use (`AIInsights` 216K, Recharts `AreaChart` 324K, `Overview` 100K, `SettingsView` 108K, plus `ModelsPage`, `TracesView`, `NodesList`), and `/dashboard` and `/sign-in` keep loading a shell that cannot reach a backend. With no users, accepted.
4. **Maintainer: done, 2026-11-17.** `wicklee.dev` now serves from Pages — verified live: every HTML route answers 200 with no `x-railway-edge` header, `/docs` and `/blog` 308 to their trailing-slash prerendered files and carry real docs content rather than falling back to the homepage, and a direct hit on `/trust` resolves client-side in a real browser with its own title. `/api/*`, `/mcp` and `/metrics` still route to Railway, so the split is deliberate. `install.sh`, `install.ps1` and all six discovery files serve from Pages as static files, so the install path survives the next step.
5. **Maintainer: done, 2026-11-20.** Both services and the database are stopped. Verified: `/api/*`, `/api/v1/fleet`, `/mcp` and `/metrics` all answer 404 — a clean JSON body from Railway's edge fallback (`x-railway-fallback: true`, "Application not found"), not the SPA shell, so the failure is unambiguous. The site and the install path are untouched: every HTML route, `install.sh`, `install.ps1` and all six discovery files still answer 200 from Pages, and `install.sh` still returns an 11,097-byte script.
6. **Claude Code: done, with one correction to this item.** Only `railway.toml` was Railway's. `Dockerfile`, `nginx.conf` and `entrypoint.sh` are the **generic self-hosted frontend image**, not Railway config: `nginx.conf` is parameterised entirely on `$BACKEND_HOST`/`$PORT`/`$RESOLVER`, the Dockerfile's only Railway mention is a comment, `docs/SELF_HOSTING.md:139` documents building the frontend from it, and `deploy/helm/wicklee/templates/frontend.yaml` requires that image. Deleting them would have broken the self-hosting path that step 7 has not decided yet, so they stayed — until step 7 deleted the control plane and the Helm chart on 2026-11-20, after which they went too. What did change: `entrypoint.sh` defaulted `BACKEND_HOST` to `vibrant-fulfillment.railway.internal:8080`, a host that no longer exists, so an unset variable proxied silently into nothing — it now fails with a message naming what to set. `cloud/railway.toml` is left alone: it is inside the frozen `cloud/`, so it is step 7's.
   Also swept, beyond this item: `public/install.sh` POSTed install telemetry to `wicklee.dev/api/telemetry/install` on every run. Backgrounded with `&`, so `set -e` never saw it fail and installs were never broken — but it was a call to a dead endpoint on every install. Removed.
7. **Claude Code: done.** `SECURITY.md` no longer lists a fleet backend in scope and now says plainly that there isn't one — `wicklee.dev` serves the site, the install scripts and the discovery files as static files and runs no API. The public site is in scope instead. `README.md` lost the hosted-fleet tagline, the `Cloud MCP Tools (wicklee.dev/mcp)` section and the whole `Enterprise Bridge` section: OTLP export and the Prometheus `/metrics` endpoint are cloud-only (the agent has neither, just `/api/metrics` as SSE), so all three bullets were hosted-service claims. The localhost MCP examples that sat under the cloud heading moved up to the local section rather than being deleted. Verified first that `install.sh`, `install.ps1` and all six discovery files are static files in `public/` served by Pages, so the install path and agent discovery survive the shutdown.
   **One gap left, deliberately deferred:** `public/openapi.json` lists `https://wicklee.dev` as its first server and carries an `/api/v1/fleet` path, with no way to express a prose banner. `llms.txt`, `api.md` and `docs.md` already carry "being shut down" notices from step 4. All four are better done in one pass once the services are actually stopped, when the wording becomes "shut down" rather than "being shut down" — doing it now means doing it twice.
8. **Maintainer: done, 2026-11-20.** Railway is closed. The openapi/discovery-file wording pass that item 7 deferred was done with step 7's sweep, once the services were stopped.

- **Done when:** wicklee.dev loads every page with Railway stopped, the built site contains no dashboard code, and no tracked file tells a reader to use or report against the hosted backend.

### 7. Decide the frozen cloud code

**Done, 2026-11-20. Decision: delete.** Railway was closed, so `cloud/`, `src/cloud/`, `cloud_push.rs`, `pairing.rs`, `deploy/helm/` and `deploy/self-hosted/` had no deployment to talk to. The decision is recorded in `docs/STRATEGY.md` §14. Everything is recoverable from git history (`git show 68ca72f:cloud/`); a Stage 4 coordinator would start fresh from it.

What went, beyond the directories named above:

- `deploy/grafana/`, `shared/` (`agent/src/scoring.rs` is now the only copy) and `scripts/sync-scoring.mjs`, `scripts/sync-perplexity.mjs` (`public/perplexity_baseline.json` is now the only copy).
- The root `Dockerfile`, `nginx.conf` and `entrypoint.sh`. Step 6 had kept them as the generic self-hosted frontend image; that image existed to proxy to the deleted control plane and was required by the deleted Helm chart.
- `agent/src/update.rs`. Self-update checked `wicklee.dev/api/agent/version`, an endpoint that died with the backend, and only ever ran for paired agents. Upgrade is re-running `install.sh`. Also removed: `--pair`, `/api/pair/*`, `--no-cloud` (nothing left to disable), the `fleet_url` and `session_token` config fields (old config files still load; the keys are ignored), and the `self-replace`, `sha2` and `rand` dependencies. `/api/health` now reports `node_id`; `--status` and the MCP stdio bridge use it.
- `docs/SELF_HOSTING.md` and `docs/GRAFANA.md`; the CI `cloud` job and the perplexity/scoring sync checks; `@clerk/clerk-react`; `IS_DEMO` and `src/utils/cloudUrl.ts`; the Clerk CSP entries in `index.html`.
- The website is now a separate entry from the dashboard: `App.tsx` renders static pages in the site build and the dashboard only in the agent build. The refund page and the sign-in and sign-up routes are gone.
- `LegalPage.tsx` rewritten to say what is true (no accounts, no hosted service, no pairing). The four 2026 blog posts keep their text but carry dated notes where they described the hosted fleet view, OpenTelemetry, Prometheus or webhooks.
- `LICENSING.md`, `NOTICE`, `CONTRIBUTING.md`: the FSL half now covers `src/site/` only, and `src/site/LICENSE` holds the full licence text that used to live in `cloud/LICENSE`.

**Follow-ups, not done:**

- **Maintainer legal review** of the rewritten Terms and Privacy pages and of `LICENSING.md`. They were edited to match what runs; they were not reviewed as legal text.
- ~~**Tier and upsell machinery in the local dashboard**~~ **Done, 2026-11-20.** `usePermissions`, `utils/tier.ts` (and its test), `InsightsTeaseCard`, `InsightsLiteCard`, `tierStyle.ts`, `SubscriptionTier`/`InsightsTier`/`TIER_BADGE`, the Team and API-keys tabs, the "restricted node" banner and locked metric tiles are removed; the gated insight cards render unconditionally, as they already did for the community tier.
- ~~**`PairingInfo` in `src/types.ts`**~~ Done: removed.
- **Cloudflare Pages build settings**: check that the build command and output directory still match (`npm run build`, `agent/frontend/dist`), and that the `_redirects` file trimmed here is what is deployed.

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
| 6 | Shut down Railway | **Done, 2026-11-20.** Items 1 and 2 closed earlier (PR #110 retry fix; Postgres export skipped by decision). Narrowing the Pages build was skipped by decision. The Maintainer repointed `wicklee.dev` to Pages on 2026-11-17, stopped both services and the database on 2026-11-20, and closed the project; `/api/*`, `/mcp` and `/metrics` answer 404 and the site and install path are untouched |
| 7 | Decide the frozen cloud code | **Done, 2026-11-20: deleted.** Recorded in `docs/STRATEGY.md` §14. The four dependent documents are resolved: `GRAFANA.md` and `SELF_HOSTING.md` deleted, `LICENSING.md` and `CONTRIBUTING.md` updated (legal review still wanted). Follow-ups listed under step 7 |
| 8 | Second-host validation | **Not started, and now the only remaining step.** Step 1 is done, which was its only dependency. The Mac mini half needs a scenarios file with 1b-class models; `scripts/bench/scenarios.json` is tracked and pre-filled with this M4's own values, which needs sorting out first. The preferred host is a rented NVIDIA GPU with discrete VRAM — a spend decision, so the Maintainer's |
