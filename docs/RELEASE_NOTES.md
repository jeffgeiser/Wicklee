# Release notes

Paste the section for a release into its GitHub release body. The install block
at the top of each section is what `.github/workflows/release.yml` writes by
default, so a pasted body keeps it rather than replacing it.

Releases up to v0.14.0 carry only that install block. These are the first
written notes.

> **On v0.14.0.** That tag was cut on 2026-11-14 at the step 4 merge and
> contains Phase 1 steps 0 to 4 only: readiness, the findings rules and the
> first four routes. Receipts, fingerprint, verify, the MCP tools and the
> benchmark harness all came after it. Nothing below describes that tag, and
> no tag is created or moved by these notes.

---

## Unreleased — removals

No tag yet. The hosted fleet view and everything behind it are gone, so a
future release changes what the agent does, not only what it adds:

- Removed the fleet pairing flow (`--pair`, `/api/pair/*`), telemetry push, the
  `--no-cloud` flag (there is nothing left for it to turn off) and the
  self-update, which only ever ran for paired agents and depended on an endpoint
  that no longer exists. Upgrade by re-running the install script.
- `/api/health` now reports `node_id`, and `wicklee --status` and the MCP stdio
  bridge use it instead of `/api/pair/status`.
- An existing `config.toml` that still carries `fleet_url` or `session_token`
  keeps working; the keys are ignored.
- Removed the control-plane code, its deployment files and the Prometheus,
  OpenTelemetry and webhook paths that went with it.

---

## v0.15.0 — Phase 1 complete: `wicklee inspect`

**Install:**
```powershell
# Windows
irm https://wicklee.dev/install.ps1 | iex
```
```bash
# macOS / Linux
curl -fsSL https://wicklee.dev/install.sh | bash
```

Wicklee answers three questions about local inference, from the command line,
HTTP and MCP: what is happening to my models, which ones can run safely right
now, and did a change actually help. One binary, localhost, no account.

### Five commands

```bash
wicklee inspect              # what is happening, what can run, what to change
wicklee ready [MODEL]        # readiness only
wicklee findings [--all]     # findings alone, --all includes resolved
wicklee fingerprint MODEL    # measure a model, store a baseline (asks first)
wicklee verify F-xxxxxx      # re-run a finding's test and compare (asks first)
```

- **`inspect`** reports named findings with the evidence behind each line: a
  model being reloaded at the runtime's 4096 default after running larger, models
  clearing each other before their keep-alives expire, a keep-alive shorter than
  the gap between the steps that use the model, part of a model sitting outside
  accelerator memory, and a model that has lost more than 20% against its own
  measured baseline. A rule that could not run prints that it could not run,
  with the reason.
- **`ready`** answers per model: ready now, requires loading, may require
  eviction, or cannot determine — with the memory headroom, the basis for the
  footprint, and what a load would displace. Meant to be called before a job
  starts rather than after it fails.
- **`fingerprint`** and **`verify`** are the only operations that send inference
  requests or move models. Both print what they will do and wait for a yes, both
  are restricted to the local machine, and every request they send is tagged so
  a measurement never shows up later as the churn it was taken to look for.

Every statement carries an evidence label, enforced where statements are built:
`OBSERVED` is a recorded transition, sample or receipt and never states a cause;
`INFERRED` must hedge and must rest on something observed or verified;
`VERIFIED` means exact per-request receipts. A finding whose statements are all
inference is not shown.

The same answers over HTTP — `GET /v1/state`, `/v1/readiness`, `/v1/inspect`,
`/v1/findings`, `/v1/receipts`, and `POST /v1/receipts`, `/v1/fingerprint`,
`/v1/verify` — and three MCP tools, `wicklee_state`, `wicklee_readiness` and
`wicklee_inspect`, each calling the same function its route calls.
`get_model_fit` and `get_observations` are retired and answer with the name of
their replacement.

### Receipt callbacks

Hand Wicklee the completion metadata your runtime already returned and it
becomes an exact measurement of real traffic instead of a synthetic probe:

```bash
curl -X POST http://localhost:7700/v1/receipts \
  -H "Content-Type: application/json" \
  -d '{"model":"coder:14b","total_duration":8113331500,
       "load_duration":6396458,"prompt_eval_count":26,
       "eval_count":298,"eval_duration":4868000000,"num_ctx":32768}'
```

Nanosecond durations under the runtime's own field names, so the integration is
a copy of the response object rather than a transformation. Every field but
`model` is optional. The route **refuses** any payload carrying `prompt`,
`response`, `messages` or `context`, with a 400 naming the field, rather than
storing the body minus them — a careless integration fails loudly instead of
quietly sending content Wicklee promises never to store.

### Three fixes to shipping behaviour

- **Inbound authentication did not exist.** `session_token` was the outbound
  cloud credential, not an inbound one, so with `bind_address = "0.0.0.0"` both
  `/api/pair/claim` and `/mcp` were reachable by anything on the network.
  **Breaking:** a non-loopback bind with no token now refuses to start, and the
  refusal names the key to set. A token authenticates the caller and does not
  encrypt traffic — remote access belongs behind TLS or a trusted network.
- **The throughput probe was damaging what it measured.** It sent no `num_ctx`,
  so every interval silently reloaded the operator's model at the runtime
  default: 2,626 ms of reload, measured, against 3 ms after the fix.
- **`model_info` keys were hardcoded to `llama.*`**, which nulled context length
  and KV-cache size for every model that was not a Llama variant. They resolve
  from the model's own family now.

### Also in this release

- `--no-cloud` runs a process with every outbound fleet request off, for an
  agent started by hand on a host that is already paired.
- `WICKLEE_OLLAMA_PORT` chooses which runtime the harvester watches;
  `WICKLEE_DATA_DIR` moves the local store out of the root-owned config
  directory, so an agent started as yourself has history at all.
- Per-model residency and a real transition log, with probe- and test-caused
  changes tagged by cause.

### Known issues

**Readiness can be wrong about displacement, and a safety margin does not fix
it.** Measured on an M4 Mac mini with 16 GB: six ordered pairs of models, each
loaded at context 8192 with the first in use. Readiness answered `requires_loading`
with nothing displaced every time, and the runtime evicted the resident model in
**five of the six**. The decisive pair coexists at 9.32 GB when loaded in one
order and evicts when loaded in the other, reproducibly — so eviction there is
not a function of total resident size, and no "budget minus a constant"
reproduces it. The runtime is deciding on accounting `/api/ps` does not expose.

Until that is measured on more than one host, a `requires_loading` answer
carries `coexistence: "unverified"` whenever another model is resident, the text
output reads *"Fits by accounting; may still displace resident models
(unverified)"*, and the `wicklee_readiness` tool description tells an agent not
to treat it as safe. No threshold was changed and none of the three candidate
fixes was chosen on one machine's evidence.

Method, raw transcripts and reproduction steps: [`docs/PHASE1_RESULTS.md`](PHASE1_RESULTS.md).

Also known:

- **The statically linked Linux build has no local store**, so it keeps
  receipts and findings in memory until the agent restarts rather than in
  DuckDB. `GET /v1/receipts` and `POST /v1/fingerprint` work and report
  `persisted: false`; `baseline_regression` is listed as not checked, with the
  reason; and `POST /v1/verify` answers 501 naming it, because a verdict needs
  a durable baseline to be a verdict about.
- **`cpu_split` cannot fire on unified memory.** The runtime reports the whole
  footprint as accelerator-resident, so there is no boundary to fall outside of.
  `inspect` says so in its not-checked list rather than staying silent.
- **`baseline_regression` needs twelve fingerprint receipts** at one digest and
  context — two sets of three on each side — before it can compare anything.
- **The `improved` and `worse` verify verdicts are unit-tested, not measured
  live.** Manufacturing a real regression over the 5% floor needs a second model
  contending for memory, which 16 GB cannot do while one of them is busy.
