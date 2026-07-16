# Self-Hosted Control Plane (Enterprise)

Run the entire Wicklee control plane — telemetry ingest, fleet dashboard, alerting,
SLOs, cost governance — on your own infrastructure. No telemetry leaves your network.
This is the deployment for organizations that won't ship fleet data to wicklee.dev.

The control plane is intentionally small: **one Rust binary + Postgres + a static
frontend**. The bundled Docker Compose runs the same images that serve wicklee.dev.

## Quick start

```bash
git clone https://github.com/jeffgeiser/Wicklee && cd Wicklee/deploy/self-hosted
cp .env.example .env       # fill in POSTGRES_PASSWORD + auth (below)
docker compose up -d --build
open http://localhost:8080
```

`GET /health` on the cloud service reports `{"status":"ok","self_hosted":true,"licensed":…}`.

## Licensing

Self-hosting for production requires an **Enterprise license** — contact
[sales@wicklee.dev](mailto:sales@wicklee.dev). Set the key as `WICKLEE_LICENSE_KEY`
in `.env`. Without a key the control plane runs in **evaluation mode**: fully
functional, but it announces itself as unlicensed at boot and in `/health`.

With `SELF_HOSTED=true`, every tenant resolves to the **enterprise tier** — there
is no Paddle billing in the box; entitlement came with the license.

## Auth: bring your own Clerk app (recommended) or DIY sessions

**Clerk (supported UI path).** Create a free application at
[dashboard.clerk.com](https://dashboard.clerk.com), then set three values in `.env`:

| Variable | Where in Clerk |
|----------|----------------|
| `CLERK_JWKS_URL` | API Keys → Show JWKS URL |
| `CLERK_SECRET_KEY` | API Keys → Secret keys |
| `VITE_CLERK_PUBLISHABLE_KEY` | API Keys → Publishable keys |

The publishable key is baked into the frontend at build time — re-run
`docker compose up -d --build frontend` after changing it. Clerk Organizations
(shared fleets), RBAC roles, and SSO/SAML all work exactly as on wicklee.dev,
configured in *your* Clerk dashboard.

**DIY sessions (API-only).** The control plane retains a legacy email/password
session path (`POST /api/auth/signup`, `POST /api/auth/login`) that needs no
external service. It predates Clerk Organizations, so it has **no org/RBAC/SSO
support and no sign-in UI** — it exists for headless/API-driven deployments and
air-gapped evaluation. For a team-facing dashboard, use Clerk.

## Pairing agents to your control plane

On each node, pair against your deployment instead of wicklee.dev — the pairing
flow in the dashboard (Add Node) displays the exact command. The agent persists
`fleet_url` in its config.toml and pushes telemetry every 2s to your instance only.

## What talks to the internet

Sovereignty inventory for network policy:

- **Nothing phones home to wicklee.dev.** Install telemetry pings come from
  `install.sh` at install time, not from the control plane or a running agent.
- `CLERK_JWKS_URL` — auth key refresh (your Clerk app), every 6h. Absent in DIY mode.
- `api.resend.com` — only if `RESEND_API_KEY` is set (email alerts, weekly digest).
- `huggingface.co` — only if `HUGGINGFACE_TOKEN` is set (Model Discovery catalog).
- `api.github.com` — the agent's update check (`/api/agent/version` proxied per
  deployment). Block it and the version banner simply goes stale.
- Anything you configure yourself: Slack/PagerDuty/webhook alert channels,
  OTel exporters, Prometheus scrapes, SIEM audit drains.

## Database

The compose file ships TimescaleDB (Postgres 16). Plain Postgres also works —
hypertable creation is best-effort and skipped when the extension is missing;
you lose time-partitioning efficiency, not features. Migrations run automatically
at boot; upgrades are `git pull && docker compose up -d --build`.

Back up the `pgdata` volume; that's the entire state of the control plane.

## Kubernetes

A Helm chart / operator is on the roadmap (Readiness Program item 13). The
Compose services map 1:1 onto a Deployment each + a StatefulSet for Postgres
if you want to hand-roll it sooner.
