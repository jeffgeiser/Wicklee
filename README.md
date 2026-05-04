# Wicklee

[![License: FSL-1.1-Apache-2.0](https://img.shields.io/badge/License-FSL--1.1--Apache--2.0-blue.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/Rust-1.75%2B-orange.svg)](https://www.rust-lang.org/)
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

**Runtimes detected:** Ollama and vLLM — auto-discovered, no configuration needed.

---

## WES — Wicklee Efficiency Score

WES = tok/s ÷ (watts × thermal_penalty) — like mpg for inference. The thermal_penalty is a multiplier derived from sustained throttle events, so a thermally stressed node scores lower even at the same raw throughput.

When thermals degrade, WES penalizes the score — surfacing efficiency loss before it becomes a throughput problem.

---

## Observation Patterns

18 hardware-aware patterns continuously evaluated against live telemetry:

- **Thermal:** Thermal Drain, NVIDIA Thermal Ceiling
- **Power:** Phantom Load, Power-GPU Decoupling, Power Jitter
- **Memory:** Swap Pressure, Memory Pressure Trajectory, VRAM Overcommit
- **Inference:** TTFT Regression, Latency Spike, vLLM Queue Saturation, KV Cache Saturation
- **Hardware:** Bandwidth Saturation, Clock Drift, PCIe Lane Degradation *(NVIDIA only, no root required)*
- **Fleet:** WES Velocity Drop, Fleet Load Imbalance, Efficiency Penalty Drag

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

### Local MCP Tools (localhost:7700, all tiers)

| Tool | Description |
|------|-------------|
| `get_node_status` | Full hardware + inference metrics snapshot |
| `get_inference_state` | Live/idle/busy state with sensor context |
| `get_active_models` | Running models across Ollama and vLLM |
| `get_observations` | Local hardware pattern evaluation |
| `get_metrics_history` | 1-hour rolling telemetry buffer |
| `get_model_fit` | Memory Fit, WES Efficiency, Context Runway, and Quant Sweet Spot for the currently loaded model |

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
- **Prometheus Endpoint** — `GET /metrics` with API key authentication
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
│   └── MCP server (JSON-RPC 2.0)
├── Hardware harvester (Tokio background tasks)
│   ├── Apple Silicon: ioreg, powermetrics, pmset, vm_stat
│   ├── NVIDIA: nvml-wrapper (zero-privilege)
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

> **Contributing:** Issues and bug reports welcome.
> Pull requests are not accepted at this time.

See [CONTRIBUTING.md](CONTRIBUTING.md) for details, the [roadmap](docs/ROADMAP.md) for what's planned, and full documentation at [wicklee.dev/docs](https://wicklee.dev/docs).
