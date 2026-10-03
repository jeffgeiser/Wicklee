# Wicklee — Release QA Checklist

*Standing manual checks to run on wicklee.dev after a deploy that touches the
area in question (and before tagging an agent release). Automated coverage:
CI runs `tsc`, vitest, `cargo clippy -D warnings` and `cargo test` for agent and
cloud; `release.yml` builds all six agent targets; `scripts/qa_agent.sh`
smoke-tests a running local agent (`bash scripts/qa_agent.sh`).*

## Upgrade path (standing — every release)
- [ ] Signed out, `/pricing`: Team card defaults to 10 nodes / monthly; the
      Monthly ↔ Annual and 10 ↔ 25 toggles update price, billing line (incl.
      "plus tax where applicable") and saving.
- [ ] `curl https://wicklee.dev/api/billing/status` → `{"checkout_enabled":true}`.
- [ ] Signed out, **Subscribe** → `/sign-up?redirect_url=/pricing?…&checkout=1`;
      after sign-in you land back on `/pricing` with the selection kept and the
      Paddle overlay open at the right price.
- [ ] Signed in on Community: every in-app upgrade button (upgrade modal,
      Insights teaser/locked cards, Performance "Upgrade to Team" buttons) goes
      to `/pricing`.
- [ ] Signed in on Team: the Team card shows "Your plan" and **Contact us**
      (no second checkout).
- [ ] A Team-gated endpoint called with a Community key returns **402** with
      `"tier_required": "team"` and `"upgrade": true`.

## Billing (after any change to billing code or Paddle config)
- [ ] Sandbox purchase of each size/period → Railway log
      `[billing] paddle: <user> → team_10|team (…)`; badge shows Team · 10/25.
- [ ] Cancel **immediately** in Paddle → log `→ community`; badge drops to
      Community. A cancel "at period end" correctly keeps Team until renewal.

## Accounts & teams
- [ ] Team Management tab (Owners): Clerk organization panel renders; with no
      organization it shows **Create organization**.
- [ ] API Keys: a new key's popup shows the full `wk_live_…` key once and Copy
      copies all of it; the list shows it masked with no copy button.

## Fleet & agent
- [ ] Dashboard tabs (Intelligence, Models, Insights, Management,
      Observability) render live data; switching org clears the previous
      org's nodes.
- [ ] Pairing a new node: 6-digit code activates; the 11th node on Team · 10
      returns the 402 pointing at the 25-node plan.
- [ ] Agent release page lists `SHA256SUMS` (agents refuse to auto-update
      without it).
- [ ] Prometheus scrape of `https://wicklee.dev/metrics` with a Team key is
      `up`; the Grafana dashboard's panels have data.
