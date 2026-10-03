# Model governance (Enterprise)

Declare which models are approved to run, fleet-wide or per node tag, and get
flagged the moment an unapproved one loads. For teams that have to evidence
which models ran where — regulated industries, or anyone with a model-approval
process that currently exists only in a spreadsheet.

## Semantics

**Governance is active only for scopes that have at least one entry.** An empty
allow-list means *nothing is governed*, not "everything is blocked". This is the
fail-safe default: enabling the feature is an explicit act, rather than
something that starts flagging every model in the fleet the moment the table
exists.

An entry is `(model, tag?)`:

- `tag` omitted — applies **fleet-wide**.
- `tag` set — applies only to nodes carrying that tag (`env:prod`, `team:ml`, …),
  using the same comma/case/space normalization as alert-rule and webhook tag
  filters.

A node is governed if a fleet-wide entry exists **or** it carries a tag some
entry scopes to. Its approved set is the **union** of the fleet-wide entries and
the entries for every tag it carries. A node matching no scope is left alone —
so scoping to `env:prod` governs production without touching dev boxes.

### Matching

Exact, case-insensitive, whitespace-trimmed. One concession to how model names
actually look: a **trailing `*` matches by prefix**, so `llama3.1:8b*` admits
`llama3.1:8b-instruct-q4_K_M`. Real fleets swap quantizations constantly, and
exact-only matching would be unusable.

Matching runs in Rust, not via SQL `LIKE`, so `%` and `_` in a model name are
literal and a pattern can never be interpreted as SQL.

A bare `*` is **rejected** at the API and matches nothing in the evaluator. It
would otherwise allow every model — silently disabling governance for the scope
while still looking configured. To stop governing a scope, remove its entries.

## Detection

`evaluate_model_policy` runs in the telemetry push path, next to
`evaluate_webhooks`, so a violation is caught on the frame the model appears
rather than whenever a report is next run. The active model is read from
`ollama_active_model`, falling back to `vllm_model_name` then
`llamacpp_model_name`.

Note this is new machinery: there was **no live model-change detection** in the
cloud before it. `/api/v1/fleet/model-switches` derives swaps retrospectively
with a `LAG()` window over `metrics_raw` — an analytics query, not a signal.
`model_policy_state` tracks the per-node model to make edge detection possible.

**Violations fire once per (node, model).** A node sitting on an unapproved
model does not re-flag on every 1 Hz push. Returning to an approved model clears
the flag, so a repeat offence is recorded as a fresh violation.

Each violation writes a `model_policy_violations` row and a `node_events` row
(`level=warn`, `event_type=model_policy_violation`), so it appears in the fleet
event feed alongside thermal and pairing events.

## API

All endpoints require Enterprise tier.

| Endpoint | Role | Notes |
|---|---|---|
| `GET /api/model-policy` | any | Returns `{ active, entries }`. `active` is false when nothing is governed. |
| `POST /api/model-policy` | **Admin** | `{ model, tag?, note? }`. 409 on duplicate for the scope. |
| `DELETE /api/model-policy/{id}` | **Admin** | |
| `GET /api/model-policy/violations?limit=` | any | Newest first, limit 1–200 (default 50). |

Editing the allow-list is **Admin-only**: it is a security control, so it sits
at the bar set for node removal rather than day-to-day operations. Creates and
deletes are audited as `model_policy.created` / `model_policy.deleted`.

## Why violations are not in the audit log

`audit_log` is actor-keyed — `user_id NOT NULL`, plus a resolved `actor_email`.
A violation is detected by the telemetry path with **no acting user**; recording
one there would mean inventing an actor, which is exactly the kind of thing an
auditor should be able to trust us not to do.

So the split is:

- **Policy changes** → audit log (a person did them).
- **Violations** → `model_policy_violations` + the node event feed (the system
  observed them).

Be precise about this if a buyer asks. It also means violations are **not**
currently carried by the SIEM drain, which streams `audit_log` only.

## Known limitations

- **No SIEM streaming of violations** (see above). Wiring them into the drain, or
  adding a `model_policy_violation` webhook event, is the natural next step —
  the existing `SUPPORTED_WEBHOOK_EVENTS` machinery is edge-driven off
  thermal/inference/WES state and would need a model-aware path.
- **No alert-channel fan-out.** Violations do not currently notify Slack, email
  or PagerDuty; they surface in the UI, the API, and the event feed.
- **Detection, not prevention.** Nothing blocks an unapproved model from
  loading — the agent reports what is running, and the control plane records
  that it should not be. Enforcement would need an agent-side control and is a
  much larger change (and a much bigger promise).
- **One model per node per frame.** Only the active model is checked. A runtime
  holding several loaded models reports one active model at a time, so a model
  that is resident but never inferred on may not be flagged.
