# Wicklee

[![Agent: Apache 2.0](https://img.shields.io/badge/Agent-Apache--2.0-blue.svg)](LICENSE) [![Control plane: FSL-1.1-Apache-2.0](https://img.shields.io/badge/Control%20plane-FSL--1.1--Apache--2.0-lightgrey.svg)](cloud/LICENSE)
[![Rust](https://img.shields.io/badge/Rust-1.85%2B-orange.svg)](https://www.rust-lang.org/)
[![Build](https://img.shields.io/github/actions/workflow/status/jeffgeiser/Wicklee/release.yml?label=nightly)](https://github.com/jeffgeiser/Wicklee/actions)

**Sovereign-first GPU fleet monitor for local AI inference.**

One Rust binary per node. Live hardware dashboard at `localhost:7700`. Optional fleet aggregation at [wicklee.dev](https://wicklee.dev). No proxy in the inference path by default — your models run untouched.

<img width="1681" height="691" alt="Screenshot 2026-04-06 at 5 47 03 PM" src="https://github.com/user-attachments/assets/4f12d129-864a-4559-807e-634d57786bdd" />

---

## Install

**macOS & Linux:**

```bash
curl -fsSL https://wicklee.dev/install.sh | bash
```

No sudo. Installs to `~/.wicklee/bin/wicklee` so you can try it before granting root.

To run on every boot as a background service (the only step that needs sudo):

```bash
sudo ~/.wicklee/bin/wicklee --install-service
```

That command stops any running service, copies the binary to `/usr/local/bin/wicklee`, and registers the LaunchDaemon (macOS) / systemd unit (Linux).

**Windows (PowerShell as Administrator):**

```powershell
irm https://wicklee.dev/install.ps1 | iex
```

Dashboard opens at **http://localhost:7700**.

---

## Diagnose local inference — `wicklee inspect`

```bash
wicklee inspect
```

```
WHAT IS HAPPENING
  F-7fff93  OBSERVED  qwen3.5:4b was reloaded at the default 4096-token context 4
                      times in the last 5 minutes, dropping from as high as 8192
                      tokens. The load cost of each reload is not measured.
            INFERRED  A caller is likely omitting num_ctx, so each such request
                      silently reloads qwen3.5:4b at the default instead of reusing
                      the resident copy.

  F-e0438f  OBSERVED  3 models were cleared 5 times in the last 7 minutes within 10
                      seconds of another model loading, each before its own
                      keep-alive expired: llama3.1:8b, qwen3.5:4b, qwen3.5:9b.
            INFERRED  Memory contention may be causing the reloads: a load that does
                      not fit clears resident models rather than queueing.

WHICH MODELS CAN RUN SAFELY NOW
  llama3.1:8b     May require eviction: likely clears qwen3.5:4b, which is in
                  use
  qwen3.5:4b      Ready now, in use 7 s ago
  qwen3.5:9b      Requires loading, and fits on a measured footprint

WHAT TO CHANGE
  F-7fff93  Re-measure qwen3.5:4b and compare: wicklee verify F-7fff93
  F-e0438f  Re-measure qwen3.5:9b, qwen3.5:4b, llama3.1:8b and compare:
            wicklee verify F-e0438f
```

Real output, two of that run's five findings. The whole transcript, including
the three left out, is in
[docs/bench-fault-inject-m4-2026-11-15.json](docs/bench-fault-inject-m4-2026-11-15.json).

### How to read it

**Three sections, one per question.** What is happening, which models can run
right now without disturbing what is already loaded, and what to change.

**Every line carries its evidence label, and the labels are enforced in code.**

| Label | What it guarantees |
|---|---|
| `OBSERVED` | A transition, a sample or a receipt that was recorded. Never states a cause |
| `INFERRED` | A reading of observed evidence, always hedged, never shown on its own |
| `VERIFIED` | Exact per-request receipts: a number and its range, from runs you consented to |

A finding with nothing but inference is not shown. So "a caller is likely
omitting `num_ctx`" sits under a count of reloads that actually happened, and
the word "likely" is there because the cause was not measured.

**A rule that could not run says so.** It prints
`Not checked: baseline_regression (no fingerprint baseline yet)` rather than
nothing, because a diagnostic that goes quiet when it cannot see is worse than
one that says it cannot see.

**Findings resolve by being looked for and not found.** A finding's resolved
time is when Wicklee last checked and did not see it — never a timer.

### The rest of the surface

| Command | What it does |
|---|---|
| `wicklee inspect [--since 24h] [--json]` | Findings, readiness, what to change |
| `wicklee ready [MODEL]` | Readiness only: ready now, requires loading, would displace, cannot determine |
| `wicklee findings [--all]` | Findings alone, `--all` including resolved ones |
| `wicklee fingerprint [MODEL] [--cold]` | Measure a model and store a baseline. Asks first — it sends real requests |
| `wicklee verify F-xxxxxx` | Re-run a finding's own test and compare against the last run |

Same data over HTTP, from the same functions: `GET /v1/state`,
`/v1/readiness`, `/v1/inspect`, `/v1/findings`, `/v1/receipts`, and
`POST /v1/fingerprint`, `/v1/verify` (both local-only, both need
`"consent": true`). `POST /v1/receipts` takes the completion metadata your
runtime already handed you and turns it into an exact measurement — it
**refuses** any payload carrying `prompt`, `response`, `messages` or `context`,
so a careless integration fails loudly rather than sending content Wicklee
promises never to store.

Two things worth knowing before you rely on it:

- **It needs the agent running**, and a store for anything that spans time. The
  CLI is a client of `localhost:7700`, like `--status`.
- **Readiness can be wrong about displacement.** On a 16 GB M4, Ollama evicted
  an in-use model in five of six cases where readiness said the load would fit
  — and the same two models coexist in one load order and evict in the other,
  so no margin fixes it. Measured, published, not papered over:
  [docs/PHASE1_RESULTS.md](docs/PHASE1_RESULTS.md).

Design and rules: [docs/PHASE1_SPEC.md](docs/PHASE1_SPEC.md). Measured runtime
behaviour: [docs/ollama-capabilities.md](docs/ollama-capabilities.md).

---

## What It Monitors

| Metric | Apple Silicon | NVIDIA (Linux/Windows) |
|--------|:---:|:---:|
| GPU utilization % | ✅ | ✅ via NVML |
| Board power draw (W) | ✅ | ✅ |
| Thermal state + penalties | ✅ | ✅ |
| VRAM used / total | Unified | ✅ |
| Memory pressure % | ✅ | — |
| Inference state (live/idle/busy) | ✅ | ✅ |
| Tok/s, TTFT, queue depth | ✅ | ✅ |
| WES (tokens per watt) | ✅ | ✅ |

**Runtimes detected:** Ollama, vLLM, and llama.cpp / llama-box — auto-discovered, no configuration needed.

---

## WES — Wicklee Efficiency Score

WES = tok/s ÷ (watts × thermal_penalty) — like mpg for inference. The thermal_penalty is a multiplier derived from sustained throttle events, so a thermally stressed node scores lower even at the same raw throughput.

When thermals degrade, WES penalizes the score — surfacing efficiency loss before it becomes a throughput problem.

---

## Observation Patterns

20 hardware-aware patterns continuously evaluated against live telemetry (18 on the node, 2 in the fleet cloud):

- **Thermal:** Thermal Drain, NVIDIA Thermal Ceiling
- **Power:** Phantom Load, Power-GPU Decoupling, Power Jitter
- **Memory:** Swap Pressure, Memory Pressure Trajectory, VRAM Overcommit
- **Inference:** TTFT Regression, Latency Spike, vLLM Queue Saturation, KV Cache Saturation
- **Hardware:** Bandwidth Saturation, Bandwidth Ceiling Reached, Clock Drift, PCIe Lane Degradation *(NVIDIA only, no root required)*
- **Efficiency:** WES Velocity Drop, Efficiency Penalty Drag
- **Fleet (cloud-evaluated):** Fleet Load Imbalance, WES Long-Term Drift

Each pattern produces actionable observations with severity, evidence, and routing hints (`steer_away` / `reduce_batch` / `monitor`).

---

## Model Discovery

Before pulling a model, Wicklee scores every quantization variant against your real hardware — VRAM budget, thermal state, and power envelope. It searches HuggingFace live or shows trending GGUF models, ranked by fit.

```
Qwen2.5-14B-Instruct-Q4_K_M   Excellent   Q4_K_M   8.2 GB
Qwen2.5-14B-Instruct-Q6_K     Good        Q6_K     11.4 GB
Qwen2.5-14B-Instruct-Q8_0     Tight       Q8_0     15.7 GB
```

For each model it gives you the exact Ollama pull command for the best-fitting quant:

```bash
ollama pull hf.co/bartowski/Qwen2.5-14B-Instruct-GGUF:Q4_K_M
```

Fleet mode scores every model against every online node simultaneously.

---

## Non-Proxy by Default

Wicklee observes inference — it doesn't intercept it. The agent reads hardware telemetry and runtime APIs without sitting in the request path.

An **optional transparent proxy** (port 11434) is available for teams that want production request metrics: per-request TTFT, end-to-end latency, and throughput aggregates. Opt-in only.

---

## Fleet View

For teams running multiple nodes, [wicklee.dev](https://wicklee.dev) aggregates all paired agents into a single dashboard with SSE real-time streaming.

| | Community | Team | Enterprise |
|---|---|---|---|
| Price | Free | $99/mo (10 nodes) · $200/mo (25 nodes) | Custom |
| Nodes in fleet view | 3 | 10 or 25 | Unlimited |
| History | 24 hours | 90 days | 12 months |
| Patterns | 9 | 20 | 20 |
| Alerts | — | Slack, Email, PagerDuty | Slack, Email, PagerDuty |
| Local API + MCP | ✅ | ✅ | ✅ |
| Fleet API (`/api/v1/*`) | ✅ core endpoints, 60 req/min | ✅ + analytics, 600 req/min | ✅ + analytics, 600 req/min |
| Cloud MCP | — | ✅ | ✅ |
| OTel + Prometheus | — | ✅ | ✅ |
| Cost & chargeback reports | — | ✅ | ✅ |
| Idle-waste + capacity planner | — | ✅ | ✅ |
| SLOs with error budgets | — | ✅ | ✅ |
| Audit log export + SIEM drain | — | — | ✅ |
| SSO / SAML | — | — | ✅ |
| Self-hosted control plane | — | — | ✅ |

Local nodes are unlimited — the node limit applies only to the cloud fleet
view. Full detail at [wicklee.dev/pricing](https://wicklee.dev/pricing).

To pair a node: open `localhost:7700` and click **Connect to Fleet**, or run `wicklee --pair`.

---

## For Agents & LLMs

Wicklee exposes structured telemetry for AI agents via MCP, REST, and standard discovery files:

- **`POST /mcp`** — MCP (Model Context Protocol) JSON-RPC 2.0 endpoint
- **`GET /.well-known/mcp.json`** — MCP server manifest
- **`/llms.txt`** — Lightweight discovery file
- **`/openapi.json`** — OpenAPI 3.0 spec
- **REST API** — Fleet state, WES scores, best-route inference, observations. On the agent, `GET /api/metrics` is an SSE stream; `GET /api/metrics/snapshot` returns the latest frame as JSON for scripts.
- **`/v1` diagnostics** — `state`, `readiness`, `inspect`, `findings`, `receipts`. Evidence-labelled, same functions as the CLI and MCP. [Above](#diagnose-local-inference--wicklee-inspect).

### Local MCP Tools (localhost:7700)

| Tool | Description |
|------|-------------|
| `wicklee_state` | What is installed and loaded, with residency, context, placement and measured footprint |
| `wicklee_readiness` | Whether a model can run now without displacing another. Call it before starting a task |
| `wicklee_inspect` | Current findings about slow or unstable inference, with evidence labels |
| `get_node_status` | Full hardware + inference metrics snapshot |
| `get_inference_state` | Live/idle/busy state with sensor context |
| `get_active_models` | Running models across Ollama and vLLM |
| `get_metrics_history` | 1-hour rolling telemetry buffer |

The three `wicklee_*` tools call the same functions their HTTP routes call, so
tool output and route output cannot drift apart. `fingerprint` and `verify` are
deliberately not on MCP: they are the only operations that load models, and
that needs a person's consent, not an agent's.

`get_model_fit` and `get_observations` are retired — `wicklee_readiness` and
`wicklee_inspect` replace them. They answer with the name of their replacement
rather than "unknown tool".

### Cloud MCP Tools (wicklee.dev/mcp, Team tier)

Fleet-aggregated MCP for remote AI agents — multi-node routing, cross-node WES comparison, and fleet-wide observations. Includes `get_fleet_model_fit` to score any HuggingFace GGUF against every online node simultaneously.

```bash
# Add to Claude Desktop, Cursor, or Windsurf
npx -y mcp-remote http://localhost:7700/mcp

# Query node status directly
curl -X POST http://localhost:7700/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_node_status"},"id":1}'

# Ask your agent
# "Can I run Qwen2.5-72B on my hardware right now?"
# "Which node in my fleet should handle the next request?"
# "Why was my last inference run slow?"
```

Point your agent at **wicklee.dev/llms.txt** for full capability discovery.

### Enterprise Bridge (Team tier)

- **OpenTelemetry Export** — OTLP metrics to Datadog, Grafana Cloud, New Relic
- **Prometheus Endpoint** — `GET https://wicklee.dev/metrics` on the cloud (not the agent) with API key authentication — see [docs/GRAFANA.md](docs/GRAFANA.md)
- **Cloud MCP** — Fleet-aggregated MCP for remote AI agents

---

## Architecture

Single binary. The React dashboard is compiled and embedded via `rust-embed` — no runtime dependencies.

```
wicklee (single binary)
├── Axum HTTP server (port 7700)
│   ├── Embedded React dashboard
│   ├── SSE telemetry stream (1 Hz)
│   ├── WebSocket live charts (1 Hz)
│   ├── MCP server (JSON-RPC 2.0)
│   └── /v1 diagnostics (state, readiness, inspect, findings, receipts)
├── Hardware harvester (Tokio background tasks)
│   ├── Apple Silicon: ioreg, powermetrics, pmset, vm_stat
│   ├── NVIDIA: nvml-wrapper (zero-privilege)
│   ├── Linux: coretemp, cpufreq, sysinfo
│   └── Windows: WMI thermal, sysinfo
├── Runtime harvester (Ollama + vLLM auto-discovery)
├── Inference state machine (4-state, pure function)
├── DuckDB local history (24h raw · 30d 1-min · 90d 1-hour)
└── Optional: transparent proxy (port 11434)
```

**Sovereign by default.** Nothing leaves the machine until you explicitly pair with a fleet.

---

## Build from Source

**Prerequisites:** Rust 1.85+ (edition 2024), Node.js 20+

```bash
git clone https://github.com/jeffgeiser/Wicklee.git
cd Wicklee

# Build frontend (agent mode — no Clerk); Vite writes straight into agent/frontend/dist
npm ci && npm run build:agent

# Build agent → agent/target/release/wicklee-agent
cd agent && cargo build --release
```

`make` runs both steps; `make install` also copies the binary to `/usr/local/bin/wicklee`.

---

## Service Management

| Action | macOS / Linux | Windows |
|---|---|---|
| Install service | `sudo wicklee --install-service` | `wicklee --install-service` |
| Remove service | `sudo wicklee --uninstall-service` | `wicklee --uninstall-service` |
| Health check | `wicklee --status` | `wicklee --status` |

---

## License

Wicklee is licensed by directory. [LICENSING.md](LICENSING.md) has the full map.

- **The agent and local dashboard are open source under [Apache 2.0](LICENSE).** That is everything that runs on your nodes: `agent/`, the dashboard at `localhost:7700`, and the metric calculations including WES.
- **The fleet control plane is source-available under [FSL-1.1-Apache-2.0](cloud/LICENSE).** That is `cloud/`, `src/cloud/`, `src/site/` and the control-plane deployment files. You can read, run, modify and self-host it for anything except offering a competing fleet monitoring service; each release converts to Apache 2.0 after four years.

"Wicklee" and the Wicklee logo are trademarks and are not covered by either licence. Forks must use a different name.

---

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

---

## Contributing

> **Contributing:** Issues and bug reports welcome.
> Pull requests are not accepted at this time.

See [CONTRIBUTING.md](CONTRIBUTING.md) for details, the [roadmap](docs/ROADMAP.md) for what's planned, and full documentation at [wicklee.dev/docs](https://wicklee.dev/docs).
