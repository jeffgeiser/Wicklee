# Grafana + Prometheus

> **The hosted control plane is not maintained.** Wicklee v0.15.0 is a single
> binary on one host, reached over localhost; the paid tiers behind this
> document are withdrawn (`docs/STRATEGY.md` §14) and the hosted backend, its
> database and the payment integration are being shut down rather than left
> running. `cloud/`, `src/cloud/` and the control-plane deployment files are
> frozen in the repository, and whether they are deleted or kept as the Stage 4
> starting point is step 7 of `docs/TRANSITION_PLAN.md`. Nothing below is
> tested against a current release. It is kept as a description of what the
> frozen code does, not as something to deploy.

Wicklee already exposes a Prometheus scrape endpoint, so getting fleet
efficiency into Grafana needs no plugin — just a scrape job and a dashboard
import.

`deploy/grafana/wicklee-fleet.json` is a ready-made dashboard built on that
endpoint.

## What's exposed

`GET https://wicklee.dev/metrics` — **Team tier or above**, API-key auth. Seven
gauges, each labelled `node_id` and `hostname`:

| Metric | Unit | Notes |
|---|---|---|
| `wicklee_wes_score` | ratio | tok/s ÷ (watts × thermal_penalty) — the efficiency number |
| `wicklee_inference_tokens_per_second` | tok/s | Ollama or vLLM |
| `wicklee_power_watts` | W | NVIDIA board power, Apple SoC package power, or CPU package power, in that order |
| `wicklee_thermal_penalty` | ratio | 1.0 Normal · 1.25 Fair · 1.75 Serious · 2.0 Critical |
| `wicklee_gpu_utilization` | % | compute utilization |
| `wicklee_memory_pressure` | % | |
| `wicklee_inference_ttft_ms` | ms | vLLM, then the Ollama proxy, then Ollama |

### Gaps are idle, not missing data

Series are emitted only when the underlying value is readable on that scrape.
`wicklee_wes_score` in particular requires throughput **and** power **and** a
thermal penalty all present, so it is absent whenever a node isn't inferring.
The dashboard sets `spanNulls: false` deliberately — a break in the line means
the node was idle, and joining across it would invent throughput that never
happened.

Nodes that are offline don't appear at all (the endpoint serves the live
telemetry cache), so `count()` over a metric is a "nodes reporting" count, not a
fleet inventory.

## Scrape config

The endpoint accepts the API key as either `X-API-Key` or
`Authorization: Bearer`, so stock Prometheus `authorization` works — no
`http_headers` block and no proxy needed:

```yaml
scrape_configs:
  - job_name: wicklee
    scheme: https
    metrics_path: /metrics
    static_configs:
      - targets: ['wicklee.dev']
    authorization:
      type: Bearer
      credentials: 'YOUR_WICKLEE_API_KEY'   # or credentials_file:
    scrape_interval: 30s
```

Mint the key in the dashboard under **API Keys**. The full `wk_live_…` key is
shown **only once**, at creation — copy it then. Org-scoped keys (Admin-minted)
see the whole org fleet; personal keys see only your own nodes.

`scrape_interval` is a free choice — paid tiers allow 600 API requests per
rolling minute, so even a 1 s interval is inside the budget. Bear in mind the
limit is per key and shared with any other API use, so give Prometheus its own
key rather than reusing one that also drives automation.

If the target shows **down** with a `401` and the body
`Invalid API key or rate limit exceeded`, that one message covers **both**
cases: a wrong/revoked key *and* a key that has exceeded its per-minute
budget. Check the key first; if it's correct, look for other clients sharing it.

A valid key on the **Community** tier gets `402 Payment Required` instead
(`"Prometheus metrics requires Team tier or above"`) — `/metrics` needs Team or
above.

For **Grafana Alloy** or the OpenTelemetry Collector, the same job works as a
`prometheus.scrape` component. Wicklee also has a native OTel exporter
(Settings → OpenTelemetry Export) if you'd rather push than scrape.

## Import the dashboard

1. Grafana → **Dashboards → New → Import**.
2. Enter dashboard ID **25854** in *Find and import dashboards for common
   applications* and click **Load** ([grafana.com listing](https://grafana.com/grafana/dashboards/25854-wicklee-fleet-efficiency/)),
   or upload `deploy/grafana/wicklee-fleet.json` (or paste its contents).
3. Grafana then shows an import form with a **Prometheus** dropdown — pick the
   datasource that scrapes Wicklee and click **Import**.

The file is in Grafana's "exported for sharing" format: it declares a
`DS_PROMETHEUS` datasource input in `__inputs`, and every panel, target and the
`node` variable reference `${DS_PROMETHEUS}`. Grafana substitutes the uid of the
datasource you pick at import time, so nothing is hardcoded and it imports
cleanly into any instance. `id` is `null` so it never collides with an existing
dashboard. The uid is `wicklee-fleet`; if you already have it, the import form
flags the conflict and offers to overwrite (or change the uid to keep both).

Importing via the HTTP API works the same way — pass the input explicitly:

```bash
curl -s -u admin:… -H 'Content-Type: application/json' \
  -X POST http://localhost:3000/api/dashboards/import \
  -d "{\"dashboard\": $(cat deploy/grafana/wicklee-fleet.json), \"overwrite\": true,
       \"inputs\": [{\"name\": \"DS_PROMETHEUS\", \"type\": \"datasource\",
                    \"pluginId\": \"prometheus\", \"value\": \"YOUR_DATASOURCE_UID\"}]}"
```

File provisioning (`providers:` → `type: file`) does **not** process
`__inputs`, so for a provisioned copy replace `${DS_PROMETHEUS}` with your
datasource uid first, e.g.
`sed 's/\${DS_PROMETHEUS}/YOUR_DATASOURCE_UID/g' wicklee-fleet.json`.

It has a `node` multi-select (populated from `label_values(wicklee_power_watts,
node_id)`), a fleet summary row, efficiency, throughput/latency, hardware, and a
per-node snapshot table.

The one panel worth reading carefully is **thermal penalty**: a rising line is
throughput being taxed by heat *before* tok/s visibly drops, which is the whole
argument for measuring watts alongside tokens.

## Caveats

- **Apple Silicon power is whole-SoC.** `wicklee_power_watts` reports the
  package, not an isolated GPU rail — Apple doesn't expose one. Don't compare an
  M-series watt figure to an NVIDIA board-power figure as though they measure
  the same thing.
- **Point-in-time gauges.** The endpoint serves the current telemetry cache;
  Prometheus builds the history. A scrape gap is a gap, not an average.
- **Per-node, not per-model.** These gauges carry no model label. For
  per-model cost and efficiency use the Fleet API
  (`/api/v1/fleet/cost-by-model`, `/api/v1/fleet/model-comparison`) or the
  chargeback endpoint.

## What was never built

- **Prebuilt dashboards** — done (this file).
- **Grafana datasource plugin** — not built. It would let Grafana query Wicklee's
  own API directly (chargeback, capacity, per-model rollups — things the
  Prometheus gauges don't carry) instead of going through Prometheus. That is a
  signed plugin in its own repository with its own release cycle, not something
  that can live here.
- **Terraform provider** — not built, and the API is the reason. The six
  collection resources a provider would manage (alert channels, alert rules,
  silences, SLOs, webhooks, model policies) are create/list/delete only: no
  `GET /:id` and no `PATCH`, so every edit becomes destroy-then-create. That
  means coverage gaps mid-apply, and webhook HMAC secrets silently rotating on
  any unrelated field change, since the secret is returned only at creation.
  Fixing the API comes first. The longer write-up was `docs/TERRAFORM.md`,
  deleted with the other paid-tier documents; it is in git history.

Listing this dashboard on
[grafana.com/grafana/dashboards](https://grafana.com/grafana/dashboards) is a
distribution step worth taking on its own: platform teams search that catalog,
and a listing costs one submission rather than a plugin build.
