# Wicklee — Founder Next Steps

*Open items that need a human (dashboards, accounts, decisions). Last updated September 28, 2026.
Engineering history lives in `docs/progress.md`; product plan in `docs/ROADMAP.md`.*

## Done recently

- [x] Email Routing and Resend configured.
- [x] Mobile cold-load fixed (PRs #58–#60). Measured on iPhone: first paint 467 ms, React page 712 ms,
      Clerk off the critical path. `?perf=1` on any page shows a load report.
- [x] Cloudflare Web Analytics already running (real-visitor Core Web Vitals under
      Cloudflare → Analytics & Logs → Web Analytics).

## 1. Paddle — sandbox first, then live

### Sandbox setup
- [ ] Catalog → Products: create one product, **Wicklee Team**.
- [ ] Add four prices (the name appears on the invoice):
  - Wicklee Team, up to 10 nodes — $99 monthly
  - Wicklee Team, up to 10 nodes — $990 annual
  - Wicklee Team, up to 25 nodes — $200 monthly
  - Wicklee Team, up to 25 nodes — $2,000 annual
- [ ] Copy the four `pri_…` IDs.
- [ ] Developer Tools → Notifications: destination `<cloud host>/api/webhooks/paddle`, subscribed to
      `subscription.activated`, `subscription.updated`, `subscription.canceled`, `subscription.past_due`,
      `subscription.paused`, `subscription.resumed`. Copy its signing secret. (Events must arrive within
      5 minutes of their timestamp, so the cloud host's clock has to be right.)
- [ ] Developer Tools → Authentication: copy the client-side token.
- [ ] Railway, cloud service variables, then redeploy:
  ```
  PADDLE_ENV=sandbox
  PADDLE_CLIENT_TOKEN=<sandbox client token>
  PADDLE_WEBHOOK_SECRET=<signing secret>
  PADDLE_TEAM10_PRICE_ID=pri_...
  PADDLE_TEAM10_ANNUAL_PRICE_ID=pri_...
  PADDLE_TEAM_PRICE_ID=pri_...
  PADDLE_TEAM_ANNUAL_PRICE_ID=pri_...
  PADDLE_CHECKOUT_ENABLED=true
  ```

### Sandbox test (both sizes)
- [ ] Sign in with a test account, `/pricing`, buy the 10-node size with card `4242 4242 4242 4242`.
- [ ] Railway logs show `[billing] paddle: <user> → team_10`.
- [ ] Badge shows **Team · 10**; adding an 11th node returns the 402 pointing at the 25-node plan.
- [ ] Cancel, repeat with the 25-node size; log line ends `→ team`.

### Go live
- [ ] **Start early:** Checkout → Website approval for `wicklee.dev` (can take 1–2 days).
- [ ] Recreate the product and four prices in the live account. Archive the retired Pro,
      per-seat Team and Business prices.
- [ ] Live webhook destination + secret; live client token.
- [ ] Railway: `PADDLE_ENV=production`, the four live price IDs, live token/secret.
      Set `PADDLE_CHECKOUT_ENABLED=true` **last**, after everything else is confirmed.

## 2. Grafana dashboard + catalog listing
- [ ] Point a Prometheus scrape job at `https://wicklee.dev/metrics` with a Team-tier API key (see `docs/GRAFANA.md`;
      the endpoint lives on the cloud, not the agent, and needs the account on Team — do this after Paddle or on a comped account).
- [ ] Grafana → Dashboards → New → Import `deploy/grafana/wicklee-fleet.json`, pick the Prometheus datasource.
- [ ] After ~1 hour of data, screenshot with the thermal-penalty panel visible.
- [ ] grafana.com/grafana/dashboards → Upload dashboard (JSON, screenshot, description, Prometheus datasource).
- [ ] Send the assigned dashboard ID so the one-line import instruction can go into the docs.

## 3. Hugging Face Space
- [ ] Create the Space at huggingface.co/new-space, SDK **Static**.
- [ ] From an up-to-date `main`:
  ```
  git pull origin main
  npm run build:demo
  git clone https://huggingface.co/spaces/<your-user>/wicklee-fleet-demo hf-space
  cp -r dist-demo/* hf-space/
  cp deploy/hf-space/README.md hf-space/README.md
  cd hf-space && git add -A && git commit -m "Wicklee fleet demo" && git push
  ```
- [ ] `demo.wicklee.dev`: add the CNAME in Cloudflare DNS if missing (the `wicklee-demo` Pages project
      already builds on every merge).

## 4. Proof numbers from your own fleet
- [ ] Settings → API Keys: create a key, then run:
  ```
  curl -H "X-API-Key: wk_live_..." "https://wicklee.dev/api/v1/fleet/idle-waste?days=30"
  curl -H "X-API-Key: wk_live_..." "https://wicklee.dev/api/v1/fleet/chargeback?days=30&kwh_rate=0.16"
  ```
- [ ] Paste both outputs into a Claude session → landing-page proof strip + CFO-report blog post.

## 5. Quick checks and one decision
- [ ] Dashboard → Team tab: Clerk organization panel renders.
- [ ] `/pricing` signed out: selector defaults to $99 / 10 nodes.
- [ ] **Decide on SSO.** Clerk Enterprise SSO is a paid add-on billed per connection. Options: self-serve
      SAML for Enterprise customers, or hand-configure each connection when a deal closes
      (fine until the first request arrives). See `docs/SSO.md`.

## Engineering follow-ups
- [x] Security items S1–S9 from `docs/CODE_REVIEW.md` fixed. Bugs B1–B10 fixed. Performance (Priority 3) fixed. Remaining: cleanup (Priority 4).
- [ ] After the next agent release, confirm the release page lists a `SHA256SUMS` file (agents refuse to auto-update without it).

## From earlier GTM notes (still open)
- [ ] ~10 outreach targets for the design-partner program (`/design-partners`), then first emails.
