# MSP / Multi-Org Console — Product Spec (v1)

> GTM feature 4 · Rock 5 outreach artifact. Status: **spec — build on first MSP
> commitment.** The pitch works with this document in hand; the console ships
> when a partner signs.

## Why

MSPs and consultancies deploying on-prem AI for regulated clients need
monitoring for every fleet they hand over — and they need to operate all of
those fleets without ten browser profiles. One MSP partner ≈ ten enterprise
deployments; five partners ≈ fifty. This is the partnerships wedge: their
sales team, our product.

**Persona:** the MSP operations engineer responsible for N client
environments. Wants one login, one screen answering "which client needs
attention today," and a way to bill fleet costs through to each client.

## What already works today (no build needed)

- **Clerk multi-org membership** — one account can belong to many client orgs
  and switch between them. Each client org is fully tenant-isolated (verified
  JWT org claim), with its own RBAC roles, audit trail, alerts, and history.
- **Per-client RBAC** — the MSP engineer is invited into each client org as
  Admin (operate) or Member (configure); the client can keep their own users
  as Viewers. No new auth surface required.
- **Per-client chargeback** — each org already has cost attribution and the
  FOCUS-format export for pass-through billing.

The gap is purely *aggregation*: today the operator switches org-by-org.

## v1 scope (the build)

1. **Rollup view** (`/msp` route, visible when the account belongs to 2+ orgs):
   one row per client org — nodes online/total, open observations by severity,
   SLO compliance worst-of, active silences, 24h cost. Row click = switch org
   and land on that client's Intelligence tab. Data: a new
   `GET /api/msp/rollup` that fans out the existing per-org summaries across
   the caller's Clerk org memberships (server-side, one call).
2. **Per-org billing attribution** — the rollup's cost column links to each
   org's chargeback report; a `?format=focus` bundle export concatenates every
   client's FOCUS rows with the org name in Tags, for one invoice run.
3. **Alert inbox (stretch)** — the rollup surfaces each org's open
   observations inline so triage doesn't require switching.

Out of scope for v1: cross-org dashboards mixing telemetry (tenancy stays
hard), MSP-branded white-labeling, per-org margin management.

## Commercial shape (founder decision, not spec)

Straw proposal for the outreach conversation: MSP pays per managed client org
at a partner rate (margin on Team/Business), client contracts stay between the
MSP and their customer, Wicklee invoices the MSP. Alternative: client pays
Wicklee directly and the MSP takes a referral margin. Decide with partner #1.

## Acceptance criteria

- An operator in 5 orgs sees all 5 in one rollup within 2s, with per-org
  isolation intact (no cross-org data in any payload beyond the summary rows).
- Switching from the rollup lands in the right org context in one click.
- Bundle FOCUS export produces one file importable into the MSP's billing tool
  with client attribution per row.
- Every rollup access is audit-logged in each covered org.

## Sequencing

Spec-first is deliberate: the console is ~2–3 sessions of build, but only
after an MSP validates the shape. Pitch with this doc; adjust scope to the
first partner's actual billing workflow; then build.
