# Wicklee Documentation

> Sovereign GPU fleet monitor for local AI inference.
> One Rust binary per node, React dashboard at localhost:7700, fleet aggregation at wicklee.dev.

---

## Quick Start

```bash
# macOS & Linux
curl -fsSL https://wicklee.dev/install.sh | bash

# Windows (PowerShell as Administrator)
irm https://wicklee.dev/install.ps1 | iex
```

Dashboard opens at **http://localhost:7700**. Auto-starts on boot as a system service.

## CLI Reference

| Command | Description |
|---------|-------------|
| `sudo wicklee --install-service` | Install as system service (auto-start on boot) |
| `sudo wicklee --uninstall-service` | Remove service |
| `wicklee --status` | Health check (queries running agent) |
| `wicklee --pair` | Pair with fleet (interactive) |
| `wicklee --version` | Print version |

---

## WES Score

**WES = tok/s / (Watts x ThermalPenalty)**

Wicklee Efficiency Score — the MPG for local AI. A direct measure of how efficiently your hardware converts power into inference throughput.

### Thermal Penalties

| State | Penalty | Effect |
|-------|---------|--------|
| Normal | 1.0x | No penalty |
| Fair | 1.25x | Mild throttling |
| Serious | 1.75x | Heavy throttling |
| Critical | 2.0x | Maximum penalty |

### Color Scale

| WES | Color | Rating |
|-----|-------|--------|
| > 10 | Emerald | Excellent |
| 3–10 | Green | Good |
| 1–3 | Yellow | Acceptable |
| < 1 | Red | Low |

---

## Node States

The agent computes inference state once per second as a pure function from sensor readings. The `inference_state` field is the single source of truth — the dashboard displays it directly and never re-computes it.

| State | Meaning |
|-------|---------|
| **live** | Active inference detected |
| **idle-spd** | Model loaded, no active inference — probe baseline visible |
| **busy** | GPU active but no AI runtime detected (non-inference workload) |
| **idle** | No activity |

### Three-tier detection hierarchy (first match wins)

1. **Tier 1 — Exact runtime API:** vLLM and llama.cpp report active request/slot counts. If `requests_running > 0` or `slots_processing > 0`, the node is LIVE — zero ambiguity.

2. **Tier 2 — Ollama attribution:** When Ollama's `/api/ps` shows a model expiry change attributed to a user request (not the agent's probe), the node is LIVE for 15 seconds. A one-shot flag (`probe_caused_next_reset`) prevents the probe from being mistaken for user activity.

3. **Tier 3 — Physics / sensor fusion:** GPU utilization, SoC power, ANE power, and NVIDIA board power are read directly. If these exceed idle thresholds while a **model is loaded in VRAM**, the node is LIVE. A running runtime process (e.g. Ollama) with no model loaded will not trigger Tier 3 — everyday GPU activity from other apps cannot produce a false LIVE. A saturated-GPU override (≥75%) bypasses the post-probe cooldown window.

---

## Latency & TTFT

TTFT (Time to First Token) resolution priority:
1. **vLLM histogram** — production traffic (most accurate)
2. **Proxy rolling average** — real requests through optional proxy
3. **Ollama probe** — synthetic 20-token baseline (~30s cadence)

---

## 18 Observation Patterns (A–R)

### Community (9 patterns)

| ID | Pattern | Scope |
|----|---------|-------|
| A | Thermal Drain | Local |
| B | Phantom Load | Local |
| C | WES Velocity Drop | Cloud |
| F | Memory Pressure Trajectory | Cloud |
| H | Power Jitter | Both |
| J | Swap Pressure | Local |
| K | Clock Drift | Both |
| N | NVIDIA Thermal Ceiling | Both |
| O | VRAM Overcommit | Both |

### Pro (9 additional patterns)

| ID | Pattern | Scope |
|----|---------|-------|
| D | Power-GPU Decoupling | Both |
| E | Fleet Load Imbalance | Cloud |
| G | Bandwidth Saturation | Both |
| I | Efficiency Penalty Drag | Cloud |
| L | PCIe Degradation | Local |
| M | vLLM KV Cache Saturation | Both |
| P | TTFT Regression | Both |
| Q | Latency Spike | Both |
| R | vLLM Queue Saturation | Both |

---

## Localhost API

Base URL: `http://localhost:7700`
Auth: None required.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/metrics | SSE stream — 1 Hz telemetry |
| GET | /ws | WebSocket — 10 Hz telemetry |
| GET | /api/observations | Local patterns (A, B, J, L) against 1h DuckDB buffer |
| GET | /api/history?node_id=WK-XXXX | Metric history — 1h raw samples |
| GET | /api/traces | Proxy inference traces |
| GET | /api/events/history | Node event log |
| GET | /api/events/recent | Recent in-memory events |
| GET | /api/export?format=json\|csv | Data export |
| GET | /api/tags | Ollama model tags |
| GET | /api/pair/status | Pairing status |
| POST | /mcp | MCP JSON-RPC 2.0 endpoint |
| GET | /.well-known/mcp.json | MCP server manifest |

---

## Fleet API v1

Base URL: `https://wicklee.dev/api/v1`
Auth: `X-API-Key: wk_live_...` header.

| Method | Endpoint | Description | Tier |
|--------|----------|-------------|------|
| GET | /api/v1/fleet | All nodes with full MetricsPayload | All |
| GET | /api/v1/fleet/wes | WES scores ranked | All |
| GET | /api/v1/nodes/{id} | Single node deep dive | All |
| GET | /api/v1/route/best | Routing recommendation | All |
| GET | /api/v1/insights/latest | Fleet intelligence snapshot | Team+ |
| GET | /metrics | Prometheus scrape endpoint | Team+ |
| GET | /api/otel/config | OTel export configuration | Team+ |
| PUT | /api/otel/config | Update OTel settings | Team+ |

---

## MCP Server

The agent exposes a local MCP (Model Context Protocol) server for AI agents. Available on all tiers, localhost only, no auth.

**Endpoint:** `POST http://localhost:7700/mcp` (JSON-RPC 2.0)

### Tools

| Tool | Description |
|------|-------------|
| get_node_status | Full hardware + inference metrics snapshot |
| get_inference_state | Live/idle/busy state with sensor context |
| get_active_models | Running models across Ollama, vLLM, llama.cpp |
| get_observations | Local hardware pattern evaluation (A, B, J, L) |
| get_metrics_history | 1-hour rolling telemetry buffer |

### Resources

| URI | Description |
|-----|-------------|
| wicklee://node/metrics | Live MetricsPayload JSON |
| wicklee://node/thermal | Thermal state + WES penalty values |

### Connect to Claude Desktop

Open the config file in your terminal:

```bash
# macOS
nano "$HOME/Library/Application Support/Claude/claude_desktop_config.json"

# Windows (PowerShell)
notepad "$env:APPDATA\Claude\claude_desktop_config.json"
```

Add the `wicklee` entry inside `mcpServers` (create the file if it doesn't exist):

```json
{
  "mcpServers": {
    "wicklee": {
      "command": "/opt/homebrew/bin/npx",
      "args": ["-y", "mcp-remote", "http://localhost:7700/mcp"],
      "env": {
        "HOME": "/Users/YOUR_USERNAME",
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
      }
    }
  }
}
```

Requires Node.js. Use `which npx` to find the correct path for your system. Fully quit Claude Desktop (Cmd+Q) and relaunch after editing.

### Connect to Claude Code

```bash
claude mcp add -s user wicklee -- npx -y mcp-remote http://localhost:7700/mcp
```

### Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "wicklee": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:7700/mcp"]
    }
  }
}
```

If you already have other servers configured, add the `"wicklee"` entry inside the existing `mcpServers` object.

### Windsurf

Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "wicklee": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:7700/mcp"]
    }
  }
}
```

All setups require Node.js for the mcp-remote bridge. Restart your IDE after configuration changes.

### Test with curl

```bash
curl -X POST http://localhost:7700/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_node_status"},"id":1}'
```

---

## OpenTelemetry & Prometheus

**Team tier required.**

### OpenTelemetry Export

Cloud backend pushes OTLP JSON metrics to any OpenTelemetry-compatible collector. Configure in Settings.

8 gauges per node: `wicklee.gpu.utilization`, `wicklee.power.watts`, `wicklee.inference.tokens_per_second`, `wicklee.wes.score`, `wicklee.thermal.penalty`, `wicklee.memory.pressure`, `wicklee.inference.ttft_ms`, `wicklee.inference.state`

Resource attributes: `node.id`, `node.hostname`, `node.gpu.name`, `node.os`, `node.arch`

### Prometheus

```bash
curl -H "X-API-Key: wk_live_..." https://wicklee.dev/metrics
```

Returns standard Prometheus text format with 7 gauges per node, labeled by `node_id` and `hostname`.

---

## Configuration

Wicklee is zero-config by default. Optional settings:

**Config file:** `/Library/Application Support/Wicklee/config.toml` (macOS) or `/etc/wicklee/config.toml` (Linux)

| Setting | Default | Description |
|---------|---------|-------------|
| node_id | Auto-generated (WK-XXXX) | Stable node identifier |
| fleet_url | None | Cloud fleet URL (set by pairing) |
| bind_address | 127.0.0.1 | Set to 0.0.0.0 for LAN access |
| ollama_proxy.enabled | false | Enable transparent proxy on :11434 |

---

## Sovereignty

Wicklee is sovereign by default:
- The agent runs entirely on your machine
- Nothing leaves until you explicitly pair with a fleet
- No outbound connections by default — structural guarantee
- Local dashboard at localhost:7700 works with zero configuration

---

## Platform Support

| Platform | GPU | Power | Thermal |
|----------|-----|-------|---------|
| macOS (Apple Silicon) | ioreg (sudoless) | powermetrics (root) | pmset/sysctl |
| macOS (Intel) | — | powermetrics (root) | pmset/sysctl |
| Linux (NVIDIA) | NVML (sudoless) | NVML | coretemp/clock_ratio |
| Linux (CPU only) | — | RAPL powercap | coretemp/cpufreq |
| Windows | NVML | NVML | WMI |

### Runtimes Detected

- Ollama (macOS, Linux, Windows)
- vLLM (Linux)
- llama.cpp / llama-box (macOS, Linux)

---

## Pricing

| | Community | Pro | Team | Enterprise |
|---|---|---|---|---|
| Price | Free | $9/mo | $19/seat/mo | From $200/mo |
| Nodes | 3 | 10 | 25+ | Custom |
| History | 24h | 7 days | 90 days | Custom |
| Patterns | 9 | 18 | 18 | 18 |
| Local MCP | ✅ | ✅ | ✅ | ✅ |
| Cloud MCP | — | — | ✅ | ✅ |
| OTel + Prometheus | — | — | ✅ | ✅ |
| Alerts | — | Slack | Slack, PagerDuty | All |

---

*Full API schema: [openapi.json](https://wicklee.dev/openapi.json) · AI discovery: [llms.txt](https://wicklee.dev/llms.txt)*
