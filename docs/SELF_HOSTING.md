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
air-gapped evaluation. For a team-facing dashboard, use Clerk. The two paths are exclusive: the password routes return 404 whenever
`CLERK_JWKS_URL` is set, and a legacy account is never auto-linked to a Clerk
identity (set `users.clerk_id` by hand to migrate one). Legacy sessions expire
30 days after login.

## Pairing agents to your control plane

Agents send pairing codes and telemetry to the URL in their `WICKLEE_CLOUD_URL`
environment variable, which defaults to the hosted service. Set it on each node
to your deployment's URL (the frontend works, since nginx proxies `/api/*`)
**before** pairing:

```bash
# foreground
WICKLEE_CLOUD_URL=https://wicklee.internal ~/.wicklee/bin/wicklee

# installed service (Linux) — a drop-in survives --install-service rewrites
sudo systemctl edit wicklee     # add: [Service]
                                #      Environment=WICKLEE_CLOUD_URL=https://wicklee.internal
sudo systemctl restart wicklee
```

On macOS add it under `EnvironmentVariables` in
`/Library/LaunchDaemons/dev.wicklee.agent.plist`. Then pair as usual (Connect to
Fleet on `localhost:7700`, enter the code under Add Node in your dashboard). The
agent pushes telemetry every 2s to that URL only. (The `fleet_url` the agent
writes to config.toml is a display label, not the push target.)

## What talks to the internet

Sovereignty inventory for network policy:

- **The control plane never phones home to wicklee.dev.** Install telemetry
  pings come from `install.sh` at install time. One agent exception: a
  **paired** agent checks `https://wicklee.dev/api/agent/version` for updates
  (hardcoded — it does not follow `WICKLEE_CLOUD_URL`). Block it and agents
  simply stop auto-updating; unpaired agents make no outbound calls.
- `CLERK_JWKS_URL` — auth key refresh (your Clerk app), every 6h. Absent in DIY mode.
- `api.resend.com` — only if `RESEND_API_KEY` is set (email alerts, weekly digest).
- `huggingface.co` — only if `HUGGINGFACE_TOKEN` is set (Model Discovery catalog).
- `api.github.com` — the control plane's own `/api/agent/version` looks up the
  latest release there. Block it and the version banner simply goes stale.
- `github.com` (release downloads) — agents that auto-update fetch the new
  binary and the release's `SHA256SUMS` directly and install only on a
  checksum match. Block it and agents stay on their current version.
- Anything you configure yourself: Slack/PagerDuty/webhook alert channels,
  OTel exporters, Prometheus scrapes, SIEM audit drains.
  Self-hosted mode may deliver these to private addresses (your SIEM on
  `10.x`, an in-cluster collector). The hosted service refuses private,
  loopback and link-local targets; `OUTBOUND_ALLOW_PRIVATE=true` lifts that
  outside self-hosted mode. Redirects from these receivers are never followed.

## Database

The compose file ships TimescaleDB (Postgres 16). Plain Postgres also works —
hypertable creation is best-effort and skipped when the extension is missing;
you lose time-partitioning efficiency, not features. Migrations run automatically
at boot; upgrades are `git pull && docker compose up -d --build`.

Back up the `pgdata` volume; that's the entire state of the control plane.

## Reverse proxies and client IPs

The cloud service reads the client address from `X-Forwarded-For`, counting
`TRUSTED_PROXY_HOPS` entries from the right (default `1` — the bundled nginx).
The auth and pairing rate limiters key on it. If you put another load balancer
in front of the frontend, set `TRUSTED_PROXY_HOPS=2` in `.env` (one per proxy
that appends to the header); the compose file passes it to the `cloud` service.

## Kubernetes (Helm)

`deploy/helm/wicklee` deploys the same control plane onto a cluster: cloud
Deployment, frontend Deployment (nginx proxies `/api/*`, `/mcp`, `/metrics`
same-origin), optional bundled TimescaleDB StatefulSet, and an optional
Ingress. There is no public image registry yet — build and push the two
images first:

```bash
docker build -t REGISTRY/wicklee-cloud:0.11.0 cloud/
docker build -t REGISTRY/wicklee-frontend:0.11.0 \
  --build-arg VITE_CLOUD_URL=/ \
  --build-arg VITE_CLERK_PUBLISHABLE_KEY=pk_... .

helm install wicklee deploy/helm/wicklee \
  --set cloud.image.repository=REGISTRY/wicklee-cloud \
  --set frontend.image.repository=REGISTRY/wicklee-frontend \
  --set postgresql.password=... \
  --set config.clerkJwksUrl=... --set config.clerkSecretKey=... \
  --set config.licenseKey=...
```

Bring your own Postgres with `--set postgresql.enabled=false
--set externalDatabaseUrl=postgres://...`. The Clerk publishable key is baked
into the frontend image at build time (Vite) — it cannot be set via values.
Check `frontend.dnsResolver` matches your cluster's CoreDNS ClusterIP.

### Agents on Kubernetes

The chart deploys the **control plane**, not agents. Agents monitor the
*node* — bare-metal telemetry (powermetrics/NVML), host processes, node-local
runtimes — so on Kubernetes they belong on each GPU node (hostNetwork, with
`[runtime_ports]` pointed at your inference services), not behind a Service.
Today, enrollment is the blocker for a DaemonSet: pairing is an interactive
6-digit flow, one node at a time. A proper operator with bulk token-based
enrollment is the recorded follow-up (Readiness Program item 13); until then,
run agents on the GPU hosts themselves via `install.sh` and pair each against
your self-hosted URL.
