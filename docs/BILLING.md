# Billing (Paddle)

Wicklee sells one self-serve plan in two sizes — **Team**, priced by the number
of nodes in the cloud fleet view:

| Size | Tier string | Nodes | Monthly | Annual |
|---|---|---|---|---|
| Team (10 nodes) | `team_10` | up to 10 | $99 | $990 |
| Team (25 nodes) | `team` | up to 25 | $200 | $2,000 |

Same features at both sizes — chargeback, idle-waste, capacity planner, SLOs,
the Fleet API. The size is a node cap, never a feature unlock; the reason to
move up is more GPUs. Above 25 nodes is an Enterprise conversation, not a
bigger checkout. Community is free and Enterprise is `mailto:` CTAs on
`/pricing`, so Paddle only ever needs to hold the four Team prices.

## Current state

Self-serve checkout is **off**. `GET /api/billing/config` returns
`checkout_enabled: false` unless all three hold:

1. `PADDLE_CHECKOUT_ENABLED=true`
2. a real (non-`pri_placeholder*`) Team price ID is configured
3. `PADDLE_CLIENT_TOKEN` is non-empty

While it's off, the in-app upgrade modal routes to `/pricing` instead of opening
the Paddle overlay. Nothing can be mis-billed, and nothing needs doing in Paddle
until you actually want to take card payments.

The kill switch is explicit on purpose: a configured price ID looks identical
whether it points at the current $200 Team plan or the retired $49 one, so the
server cannot tell "correct" from "stale". `PADDLE_CHECKOUT_ENABLED=true` is you
asserting that Paddle now matches the published prices.

## Environment variables

| Variable | Purpose |
|---|---|
| `PADDLE_ENV` | `sandbox` (default) or `production` |
| `PADDLE_CLIENT_TOKEN` | Client-side token for the Paddle.js overlay |
| `PADDLE_WEBHOOK_SECRET` | HMAC-SHA256 verification. **Unset ⇒ webhooks are rejected.** |
| `PADDLE_CHECKOUT_ENABLED` | `true` turns on self-serve checkout. Default off. |
| `PADDLE_TEAM10_PRICE_ID` | Team 10-node monthly ($99) → tier `team_10` |
| `PADDLE_TEAM10_ANNUAL_PRICE_ID` | Team 10-node annual ($990) → tier `team_10` |
| `PADDLE_TEAM_PRICE_ID` | Team 25-node monthly ($200) → tier `team` |
| `PADDLE_TEAM_ANNUAL_PRICE_ID` | Team 25-node annual ($2,000) → tier `team` |
| `PADDLE_PRO_PRICE_ID` | **Retired — keep set.** Grandfathers existing Pro subscribers. |
| `PADDLE_BUSINESS_PRICE_ID` | **Retired — keep set.** Grandfathers existing Business subscribers. |

### Why the retired price IDs must stay set

Paddle keeps existing subscriptions on the price they were created with. The
webhook maps `price_id → tier`, so those two variables are the only thing
telling the backend that an old subscription is still Pro or Business. Delete
them "to clean up" and the next `subscription.updated` event for those customers
maps to nothing — and the handler fails closed, so they lose their tier.

## Going live checklist

In Paddle:

1. One product, **Wicklee Team**, with four prices:
   - **Team 10 monthly, $99/mo** → `PADDLE_TEAM10_PRICE_ID`
   - **Team 10 annual, $990/yr** → `PADDLE_TEAM10_ANNUAL_PRICE_ID`
   - **Team 25 monthly, $200/mo** → `PADDLE_TEAM_PRICE_ID`
   - **Team 25 annual, $2,000/yr** → `PADDLE_TEAM_ANNUAL_PRICE_ID`
   Name them by node count in Paddle so the invoice line reads
   "Wicklee Team — up to 10 nodes"; the customer should never see `team_10`.
2. Checkout is enabled once **any one** of the four is a real price ID
   (`team_configured()`); wire all four before flipping step 7 so both sizes
   are purchasable.
3. **Archive** the retired prices — Pro $29, Team $49/seat, Business $499 — so
   nothing new can subscribe to them. Archiving does not cancel existing
   subscriptions, which is what you want.
4. Point the webhook at `POST /api/webhooks/paddle` and set
   `PADDLE_WEBHOOK_SECRET` to its signing secret. Subscribe to
   `subscription.activated`, `subscription.updated`, `subscription.canceled`,
   `subscription.past_due`.
5. Check whether any live subscriptions exist on the retired prices. If none,
   step 3's grandfathering caveat is moot and both retired variables can be left
   empty.

Then, in the deployment env:

6. `PADDLE_ENV=production`, `PADDLE_CLIENT_TOKEN=<live token>`.
7. `PADDLE_CHECKOUT_ENABLED=true` — last, once 1–6 are verified.

Verify with a sandbox purchase of **each size** before flipping step 7 in
production: the log line `[billing] paddle: <user> → team_10 (sub=…)` or
`→ team (sub=…)` confirms the mapping resolved.

### Moving a customer from 10 to 25 nodes

Paddle plan changes go through its API (`PATCH /subscriptions/{id}` with the new
price and `proration_billing_mode: prorated_immediately`), not through a second
checkout — a new checkout would open a second subscription. There is no
self-serve upgrade button yet: the 402 the customer sees at the 11th node says
to move to the 25-node plan, and today that means an email and the PATCH done
by hand (or the SQL below plus a Paddle dashboard change). A `/api/billing/upgrade`
endpoint is the follow-up once the first 10-node customer exists.

## Manual (invoiced) sales

Until checkout is on, a Team sale closed over email needs the tier set by hand —
a Paddle payment link created in the dashboard will **not** grant it. The
webhook reads `data.custom_data.user_id`, which a hand-made link doesn't carry,
so the update matches no row and no-ops silently.

To fix a subscription up by hand, set both:

```sql
-- 'team_10' for the 10-node plan, 'team' for 25 nodes
UPDATE users SET subscription_tier = 'team' WHERE id = '<user_id>';
-- and, if they own an org (shared fleet):
UPDATE organizations SET subscription_tier = 'team' WHERE created_by = '<user_id>';
```

…then mirror it to Clerk `publicMetadata.tier` (`PATCH
https://api.clerk.com/v1/users/<clerk_id>/metadata`), which is what the frontend
reads. `sync_tier_to_clerk` does this automatically on the webhook path.

## Fail-closed price mapping

`tier_for_price_id` returns `None` for any price it doesn't recognize, and the
webhook then logs the price ID and **leaves the tier unchanged** (it still links
`paddle_customer_id` / `paddle_subscription_id` so the subscription can be
repaired by hand).

This replaced an `else { "pro" }` fallback that silently granted Pro to any
unrecognized price — including every subscription when the env vars were unset.
After the three-tier repricing that would have put paying $200 customers on a
tier that fails `is_team_or_above`, locking them out of chargeback, idle-waste,
capacity planning and SLOs. Granting nothing is recoverable; granting the wrong
entitlements quietly is not. Covered by `paddle_price_tests` in
`cloud/src/main.rs`.
