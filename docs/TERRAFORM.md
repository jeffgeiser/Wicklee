# Terraform provider — design notes

**Status: not built, deliberately.** The API isn't shaped for it yet. This
records the audit so the decision doesn't have to be re-derived, and so the
provider isn't built on a foundation that would force bad semantics on everyone
who adopts it.

## What a provider would manage

Config that platform teams reasonably want in version control:

| Resource | Terraform shape |
|---|---|
| Alert channels | `wicklee_alert_channel` |
| Alert rules | `wicklee_alert_rule` |
| Alert silences / maintenance windows | `wicklee_alert_silence` |
| SLOs | `wicklee_slo` |
| Threshold webhooks | `wicklee_webhook` |
| Model governance entries | `wicklee_model_policy` |
| OTel export config | `wicklee_otel_config` (singleton) |
| Weekly digest config | `wicklee_digest_config` (singleton) |
| Node tags / desired profile | `wicklee_node` — **import only** |

Nodes are deliberately import-only: an agent creates a node by pairing, so
Terraform can adopt and configure one (`tags`, `desired_profile`) but must never
own its lifecycle.

## The blocker: the collection resources are create/list/delete only

Audited against the router:

| Resource | Create | List | Read by id | Update | Delete |
|---|---|---|---|---|---|
| Alert channels | `POST` | `GET` | ❌ | ❌ | `DELETE /:id` |
| Alert rules | `POST` | `GET` | ❌ | ❌ | `DELETE /:id` |
| Alert silences | `POST` | `GET` | ❌ | ❌ | `DELETE /:id` |
| SLOs | `POST` | `GET` | ❌ | ❌ | `DELETE /:id` |
| Webhooks | `POST` | `GET` | ❌ | ❌ | `DELETE /:id` |
| Model policies | `POST` | `GET` | ❌ | ❌ | `DELETE /:id` |
| OTel config | — | `GET` | — | `PUT` | — |
| Digest config | — | `GET` | — | `PUT` | — |

The two singletons are fine — `GET`/`PUT` is exactly what Terraform wants. Every
collection resource is missing both **read-by-id** and **update**.

### Why that matters more than it looks

**No update means every change is destroy-then-create.** Terraform would show
`-/+ replace` for a one-character description edit. Consequences:

- An alert rule or SLO is briefly *absent* mid-apply. Coverage gaps during a
  routine config change are the opposite of what an SLO is for.
- **Webhook secrets rotate.** The HMAC secret is returned exactly once, at
  creation. So editing an unrelated field — a threshold, a tag scope — would
  mint a new secret and silently break every receiver verifying signatures.
  That is a genuinely damaging failure mode to bake into a published provider.

**No read-by-id means Read is list-and-filter.** Workable, but the provider
can't cleanly distinguish "this resource was deleted outside Terraform" from
"it wasn't in the page I fetched", which is how providers end up either
recreating live resources or going silent on real drift.

## Recommendation: fix the API first

Add to each of the six collection resources:

- `GET /:id` — 404 when absent, so Read is unambiguous.
- `PATCH /:id` — partial update, and for webhooks **explicitly not** touching the
  secret unless asked (a separate rotate action).

That is a bounded, well-understood change, it benefits the dashboard as much as
Terraform, and it should land *before* a provider is published. Provider
semantics are hard to walk back once modules depend on them: shipping
destroy/create now means either living with it or issuing a breaking major
version later.

## Repo and publishing requirements

The provider cannot live in this repository. Publishing to the Terraform
Registry needs:

- its own Git repository named `terraform-provider-wicklee`;
- a Go module using `terraform-plugin-framework`, with acceptance tests
  (`TF_ACC`) that run against a real control plane;
- GitHub releases built by GoReleaser, **GPG-signed**, with a
  `terraform-registry-manifest.json`;
- its own semver cadence, independent of the agent and cloud.

The same is true of the **Grafana datasource plugin**: signed, own repo, own
release cycle. Note that the prebuilt dashboards in `deploy/grafana/` already
cover the common case via the existing Prometheus endpoint (see
`docs/GRAFANA.md`), so the plugin's remaining value is querying Wicklee's own
API for things the Prometheus gauges don't carry — per-model rollups,
chargeback, capacity scenarios.

## Suggested order

1. Add `GET /:id` + `PATCH /:id` to the six collection resources (in this repo).
2. Extend `public/openapi.json`, which currently documents 19 paths and has
   drifted behind the config API — it's the natural contract for both a provider
   and generated clients.
3. Then `terraform-provider-wicklee` in its own repo.
4. Grafana datasource plugin last: the dashboards already deliver most of the
   distribution benefit for a fraction of the work.
