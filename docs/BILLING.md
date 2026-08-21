# Billing (Paddle)

Wicklee sells one self-serve tier — **Team, $200/mo or $2,000/yr**. Community is
free and Enterprise is a conversation (`mailto:` CTAs on `/pricing`), so Paddle
only ever needs to hold Team products.

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
| `PADDLE_TEAM_PRICE_ID` | Team monthly ($200) |
| `PADDLE_TEAM_ANNUAL_PRICE_ID` | Team annual ($2,000) |
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

1. Create a **Team monthly** price at **$200/mo** → set `PADDLE_TEAM_PRICE_ID`.
2. Create a **Team annual** price at **$2,000/yr** → set `PADDLE_TEAM_ANNUAL_PRICE_ID`.
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

Verify with a sandbox purchase before flipping step 7 in production: the log
line `[billing] paddle: <user> → team (sub=…)` confirms the mapping resolved.

## Manual (invoiced) sales

Until checkout is on, a Team sale closed over email needs the tier set by hand —
a Paddle payment link created in the dashboard will **not** grant it. The
webhook reads `data.custom_data.user_id`, which a hand-made link doesn't carry,
so the update matches no row and no-ops silently.

To fix a subscription up by hand, set both:

```sql
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
