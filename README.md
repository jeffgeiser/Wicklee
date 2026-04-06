# Wicklee

[![License: FSL-1.1-Apache-2.0](https://img.shields.io/badge/License-FSL--1.1--Apache--2.0-blue.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/Rust-1.75%2B-orange.svg)](https://www.rust-lang.org/)
[![Build](https://img.shields.io/github/actions/workflow/status/jeffgeiser/Wicklee/release.yml?label=nightly)](https://github.com/jeffgeiser/Wicklee/actions)

**Sovereign-first GPU fleet monitor for local AI inference.**

One Rust binary per node. Live hardware dashboard at `localhost:7700`. Optional fleet aggregation at [wicklee.dev](https://wicklee.dev). No proxy in the inference path by default — your models run untouched.

<img width="1681" height="691" alt="Screenshot 2026-04-06 at 5 47 03 PM" src="https://github.com/user-attachments/assets/4f12d129-864a-4559-807e-634d57786bdd" />


---

## Install

**macOS & Linux:**

```bash
curl -fsSL https://wicklee.dev/install.sh | bash
```

**Windows (PowerShell as Administrator):**

```powershell
irm https://wicklee.dev/install.ps1 | iex
```

Dashboard opens at **http://localhost:7700**. Auto-starts on boot as a system service.

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

**Runtimes detected:** Ollama, vLLM — auto-discovered, no configuration needed.

---

## WES — Wicklee Efficiency Score

WES = tok/s per watt, adjusted for thermal state. A direct measure of how efficiently your hardware converts power into inference throughput.

When thermals degrade, WES penalizes the score — surfacing efficiency loss before it becomes a throughput problem.

---

## Observation Patterns

18 hardware-aware patterns continuously evaluated against live telemetry:

- **Thermal:** Thermal Drain, NVIDIA Thermal Ceiling
- **Power:** Phantom Load, Power-GPU Decoupling, Power Jitter
- **Memory:** Swap Pressure, Memory Pressure Trajectory, VRAM Overcommit
- **Inference:** TTFT Regression, Latency Spike, vLLM Queue Saturation, KV Cache Saturation
- **Hardware:** Bandwidth Saturation, Clock Drift, PCIe Degradation
- **Fleet:** WES Velocity Drop, Fleet Load Imbalance, Efficiency Penalty Drag

Each pattern produces actionable observations with severity, evidence, and recommended actions.

---

## Non-Proxy by Default

Wicklee observes inference — it doesn't intercept it. The agent reads hardware telemetry and runtime APIs without sitting in the request path.

An **optional transparent proxy** (port 11434) is available for teams that want production request metrics: per-request TTFT, end-to-end latency, and throughput aggregates. Opt-in only.

---

## Fleet View

For teams running multiple nodes, [wicklee.dev](https://wicklee.dev) aggregates all paired agents into a single dashboard with SSE real-time streaming.

| | Community | Pro | Team |
|---|---|---|---|
| Nodes | 3 | 10 | 25+ |
| History | 2 days | 7 days | 90 days |
| Patterns | 9 | 18 | 18 |
| Alerts | — | Slack, Email | Slack, Email, PagerDuty |
| API | — | ✅ | ✅ |
| Local MCP | ✅ | ✅ | ✅ |
| Cloud MCP | — | — | ✅ |
| OTel + Prometheus | — | — | ✅ |

To pair a node: open `localhost:7700` and click **Connect to Fleet**, or run `wicklee --pair`.

---

## For Agents & LLMs

Wicklee exposes structured telemetry for AI agents via MCP, REST, and standard discovery files:

- **`POST /mcp`** — MCP (Model Context Protocol) JSON-RPC 2.0 endpoint
- **`GET /.well-known/mcp.json`** — MCP server manifest
- **`/llms.txt`** — Lightweight discovery file
- **`/openapi.json`** — OpenAPI 3.0 spec
- **REST API** — Fleet state, WES scores, best-route inference, observations

### MCP Tools (localhost:7700, all tiers)

| Tool | Description |
|------|-------------|
| `get_node_status` | Full hardware + inference metrics snapshot |
| `get_inference_state` | Live/idle/busy state with sensor context |
| `get_active_models` | Running models across Ollama, vLLM, llama.cpp |
| `get_observations` | Local hardware pattern evaluation |
| `get_metrics_history` | 1-hour rolling telemetry buffer |

```bash
# Query node status via MCP
curl -X POST http://localhost:7700/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_node_status"},"id":1}'

# Get fleet-wide WES scores via REST
curl -H "X-API-Key: wk_..." https://wicklee.dev/api/v1/fleet/wes
```

### Enterprise Bridge (Team tier)

- **OpenTelemetry Export** — OTLP metrics to Datadog, Grafana Cloud, New Relic
- **Prometheus Endpoint** — `GET /metrics` with API key authentication
- **Cloud MCP** — Fleet-aggregated MCP for remote AI agents (coming soon)

---

## Architecture

Single binary. The React dashboard is compiled and embedded via `rust-embed` — no runtime dependencies.

```
wicklee (single binary)
├── Axum HTTP server (port 7700)
│   ├── Embedded React dashboard
│   ├── SSE telemetry stream (1 Hz)
│   ├── WebSocket live charts (10 Hz)
│   └── MCP server (JSON-RPC 2.0)
├── Hardware harvester (Tokio background tasks)
│   ├── Apple Silicon: ioreg, powermetrics, pmset, vm_stat
│   ├── NVIDIA: nvml-wrapper (sudoless)
│   ├── Linux: coretemp, cpufreq, sysinfo
│   └── Windows: WMI thermal, sysinfo
├── Runtime harvester (Ollama + vLLM auto-discovery)
├── Inference state machine (4-state, pure function)
├── DuckDB local history (1-hour observation buffer)
└── Optional: transparent proxy (port 11434)
```

**Sovereign by default.** Nothing leaves the machine until you explicitly pair with a fleet.

---

## Build from Source

**Prerequisites:** Rust 1.75+, Node.js 18+

```bash
git clone https://github.com/jeffgeiser/Wicklee.git
cd wicklee

# Build frontend (agent mode — no Clerk)
npm ci && npm run build:agent

# Copy to agent embed directory
cp -r dist/ agent/frontend/dist/

# Build agent
cd agent && cargo build --release
```

---

## Service Management

| Action | macOS / Linux | Windows |
|---|---|---|
| Install service | `sudo wicklee --install-service` | `wicklee --install-service` |
| Remove service | `sudo wicklee --uninstall-service` | `wicklee --uninstall-service` |
| Health check | `wicklee --status` | `wicklee --status` |

---

## License

[FSL-1.1-Apache-2.0](LICENSE) (Functional Source License). Free for personal use and small teams. Converts to Apache 2.0 after four years.

---

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

---

## Contributing

Issues and PRs welcome. See the [roadmap](docs/ROADMAP.md) for what's planned. Full documentation at [wicklee.dev/docs](https://wicklee.dev/docs).
