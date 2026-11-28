# Proposal: expose findings and readiness as Prometheus metrics

2026-11-28 · **Status: proposal. Not built, not committed to, not on the roadmap.**
Needs a maintainer decision (see "Decision" at the end). Nothing public should
claim this exists until it does.

## Why

The home page says Wicklee "works alongside what you already run", and that is
only half true. It reads the runtime's API and the machine's sensors without
touching the request path, but its output lives in its own CLI, HTTP and MCP
interfaces. A team with Prometheus, Grafana and Alertmanager cannot see a Wicklee
finding in any of them, so they cannot alert on "this model is being reloaded at
the wrong context" or put readiness next to the dashboards they already watch.

The pitch this would make true: *your dashboards show the numbers, Wicklee's
findings show up next to them, and your existing alerting fires on them.*

The hosted service used to claim OpenTelemetry and Prometheus export. Those were
properties of the hosted backend, not of the agent, and were removed with it. This
proposal is a new, much smaller thing: the agent exposes its own evidence for a
scraper to pull.

## Boundary check

`docs/STRATEGY.md` §14's test: does the feature turn Wicklee into a scheduler,
router, agent framework or generic observability platform?

| It would | It would not |
| --- | --- |
| Publish evidence Wicklee already computes: open findings, per-model readiness, what could not be checked | Collect or store time series. Prometheus does that |
| Be read-only and pull-based, on the same port and behind the same auth | Push anywhere, run a collector, or need any configured destination |
| Stay controller-neutral: state, not instructions | Say where to route a request or what to do about a finding |
| Export the signals no one else exports: findings, readiness, thermal state | Re-export CPU, memory or NVIDIA metrics that node_exporter and DCGM already provide |

Stage 4 lists "stable evidence schemas". Metric names become part of that surface,
so this is interoperability work and should be treated as such, not as a quick
add-on.

## Proposed design

**Route.** `GET /metrics` on the agent's port, Prometheus text exposition format.
Same auth as every other route: unauthenticated on a loopback bind; with a
non-loopback bind the agent already refuses to start without a token, and
Prometheus can send it as `authorization: { credentials: ... }` in the scrape
config. No new dependency; the text format is simple enough to render by hand and
test.

**Metrics.** Small and bounded. Names are `wicklee_*`.

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `wicklee_info` | gauge, always 1 | `version`, `node_id` | Which agent answered |
| `wicklee_finding_open` | gauge | `rule`, `severity`, `model` | 1 per open finding. The finding ID is **not** a label: it changes and would multiply series. Alerts point people to `wicklee inspect` |
| `wicklee_findings_open` | gauge | `severity` | Count |
| `wicklee_rule_not_checked` | gauge | `rule` | 1 when a rule could not run. Without it, "no findings" cannot be told from "could not check", which is the distinction `inspect` is built around |
| `wicklee_model_readiness` | gauge (state set) | `model`, `state` | 1 for the current state of `ready_now`, `requires_loading`, `may_require_eviction`, `cannot_determine`, 0 for the others |
| `wicklee_model_coexistence_unverified` | gauge | `model` | 1 while the answer fits by accounting only. Carries the known readiness caveat into the dashboard instead of dropping it |
| `wicklee_model_resident` / `wicklee_model_resident_bytes` | gauge | `model` | Loaded now, and its measured size |
| `wicklee_headroom_bytes` | gauge | `source` | Free accelerator memory and where the number came from |
| `wicklee_thermal_state` | gauge (state set) | `state` | `normal`, `fair`, `serious`, `critical` where the OS reports it |
| `wicklee_evaluated_timestamp_seconds` | gauge | none | When the rules last ran, so a stale answer is visible |
| `wicklee_store_available` | gauge | none | 0 on the static Linux build, which has no local store and a reduced rule set |

A second phase could add `wicklee_model_reloads_total{model,cause}` as a true
counter. It needs a monotonic count in the residency tracker, because the
transition log is a bounded window and a counter derived from it would go
backwards.

**Privacy.** No prompt, response or message content is involved, and the receipts
route's refusal of those fields is unchanged. Model names appear as label values.
They already appear in the API, but a scrape sends them to a Prometheus the
operator controls, so the docs must say so.

**Cost.** `inspect` evaluates its rules on request; one rule reads the local
store. A scrape every 15 s from several scrapers must not become the load it is
observing. Serve the last evaluation, refreshed by the existing 10 s evaluator,
rather than evaluating per scrape, and measure the overhead against the existing
acceptance row before shipping.

**Implementation sketch.** A new `agent/src/openmetrics.rs` with a pure
`render(&Snapshot) -> String`, in the same style as the rules, so every output is
reachable from a test with no runtime. The handler gathers the same inputs as
`handle_v1_inspect`. Tests: golden output; label escaping; no unbounded labels;
no content fields; auth through the existing middleware; and the musl build,
which must clippy clean and report `wicklee_store_available 0`. Rough size is a few
hundred lines plus tests and docs.

## Illustrative alert (not verified against a running Prometheus)

```yaml
groups:
  - name: wicklee
    rules:
      - alert: WickleeContextReset
        expr: wicklee_finding_open{rule="context_reset"} == 1
        for: 10m
        annotations:
          summary: "{{ $labels.model }} is being reloaded at the runtime's default context on {{ $labels.instance }}"
          description: "Run `wicklee inspect` on the node for the evidence."
```

## Alternatives

1. **Do nothing.** The page already says Wicklee does not push into dashboards.
   Honest and free, but it leaves the "alongside" pitch partly rhetorical.
2. **A textfile-collector script first.** `wicklee findings --json` and
   `GET /v1/readiness` already contain everything above. A small
   `examples/prometheus-textfile.mjs` could write them for node_exporter's textfile
   collector. This needs no agent change, takes about a day and tests whether
   anyone wants the data in Prometheus before the agent commits to metric names.
   **This is the recommended first step.**
3. **OpenTelemetry export.** Heavier: a push model, a dependency, and a destination
   to configure. It is the kind of thing that was in the hosted service.
4. **A webhook when a finding opens.** Closer to what people want from alerting,
   but it is push, needs configuration, and starts to look like the
   alert-routing the strategy rules out.

## Risks

- **Scope creep toward a monitoring product.** Hold the line at "evidence
  Wicklee uniquely has". If a metric exists in node_exporter or DCGM, it does not
  belong here.
- **Metric names become a contract.** Name them once, document them as
  experimental until Stage 4's schema work, and expect to rename them.
- **Cardinality.** Bounded by rules, severities and installed models, and checked
  in a test. A host with hundreds of models would still multiply `model`-labelled
  series.
- **Unproven demand.** There is no telemetry, so the only signals are issues and
  conversations. That argues for the textfile script first.

## Decision

1. **Now (recommended):** build `examples/prometheus-textfile.mjs`, with tests,
   and say nothing on the website beyond what is true today. See whether anyone
   uses it.
2. **If it gets used:** promote it to a native `GET /metrics` as designed above,
   behind the same auth, and then add the "works with your Prometheus" claim to the
   site.
3. **If it does not:** leave it as an example and close this proposal.

Not part of this proposal: dashboards, a push or hosted path, and cross-node
aggregation (the optional coordinator is a separate Stage 4 item).
