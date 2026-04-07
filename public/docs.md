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

## 18 Observation Patterns + 5 Fleet Alerts

### Agent-Evaluated (17 patterns, 10-min DuckDB buffer, every 10s)

**Community (9):** `thermal_drain`, `phantom_load`, `wes_velocity_drop`, `memory_trajectory`, `power_jitter`, `swap_io_pressure`, `clock_drift`, `nvidia_thermal_redline`, `vram_overcommit`

**Pro (8):** `power_gpu_decoupling`, `bandwidth_saturation`, `efficiency_drag`, `pcie_lane_degradation`, `vllm_kv_cache_saturation`, `ttft_regression`, `latency_spike`, `vllm_queue_saturation`

### Cloud-Evaluated (1 pattern)
`fleet_load_imbalance` — node WES > 20% below best healthy peer (Pro)

### Fleet Alerts (5, all tiers, cloud, 60s cadence)
`zombied_engine`, `thermal_redline`, `oom_warning`, `wes_cliff`, `agent_version_mismatch`

---

## Alerts & Notifications

When observations or fleet alerts fire, Wicklee delivers notifications to external channels.

| Channel | Configuration | Tier |
|---------|--------------|------|
| **Slack** | Incoming Webhook URL | Pro+ |
| **Email** | Any email address (via Resend) | Pro+ |
| **PagerDuty** | Integration Key (Routing Key) — Events API v2 with auto-resolve | Team+ |

Setup: Settings → Alerts → Add Channel → choose type → Test → Create Rules.

PagerDuty uses dedup keys (`wicklee-{node_id}-{event_type}`) for incident lifecycle — incidents auto-resolve when the condition clears.

Community tier: observations appear on the dashboard but no outbound notifications.

---

## Deep Intelligence

Wicklee uniquely has hardware telemetry, inference metrics, model identity, and per-request traces in the same DuckDB database. These endpoints leverage that combination:

### Inference Profiler
`GET /api/profile?minutes=60` — correlated timeline of TTFT, tok/s, KV cache %, queue depth, thermal penalty, and power on a single time axis. Resolution auto-scales (1s raw at 10min, 60s buckets at 24h).

### Cost Attribution Per Model
`GET /api/cost-by-model?hours=24` — per-model daily cost breakdown: model name, hours active, avg watts, cost USD. Uses power draw × model identity from DuckDB.

### "Why Was That Slow?" Explainer
`GET /api/explain-slowdown?ts_ms=N` — root cause analysis. Finds closest inference trace, reads ±30s hardware context, evaluates 6 factors (KV cache, thermal, queue, swap, memory, clock throttle), ranks by severity, generates natural-language summary.

### Model Comparison
`GET /api/model-comparison?hours=168` — side-by-side efficiency data for every model that has run on this node. Shows WES, tok/s, watts, TTFT, cost/hr. Answers "which model is most efficient on my hardware?" with real measured data.

Cloud MCP tools: `get_inference_profile` and `explain_slowdown` available for Team+ tier.

---

## Event Feeds

Wicklee has two distinct event surfaces that serve different purposes:

| | Live Activity | Recent Activity |
|---|---|---|
| **Location** | Intelligence page (scrollable feed) | Insights → Triage |
| **Data source** | Fleet events from SSE stream | Alert quartet latch system |
| **What it shows** | Connectivity, thermal transitions, model swaps, power anomalies, observation onset/resolved | Alert card lifecycle — when alerts fired and resolved, with duration |
| **Trigger** | Immediate — fires on every state transition | Delayed — fires after 15-second onset gate |
| **Persistence** | Current session only | sessionStorage — survives page refresh |
| **Purpose** | Real-time operational awareness | Post-incident review |

The Fleet Event Timeline on the Observability tab is a third, separate surface — it shows persisted `node_events` from Postgres (cloud) or DuckDB (localhost) with 30-day retention. This is the permanent audit record.

---

## Localhost API

Base URL: `http://localhost:7700`
Auth: None required.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/metrics | SSE stream — 1 Hz telemetry |
| GET | /ws | WebSocket — 10 Hz telemetry |
| GET | /api/observations | 17 server-side observation patterns (10-min DuckDB buffer) |
| GET | /api/profile?minutes=60 | Inference Profiler — correlated TTFT/KV/queue/thermal/power timeline |
| GET | /api/cost-by-model?hours=24 | Cost attribution per model — daily power cost breakdown |
| GET | /api/explain-slowdown?ts_ms=N | Root cause analysis for slow inference requests |
| GET | /api/model-comparison?hours=168 | Model comparison — side-by-side efficiency for all models |
| GET | /api/history?node_id=WK-XXXX | Metric history — 1h raw samples |
| GET | /api/traces | Proxy inference traces |
| GET | /api/events/history | Node event log |
| GET | /api/events/recent | Recent in-memory events |
| GET | /api/export?format=json\|csv | Data export |
| GET | /api/tags | Ollama model tags |
| GET | /api/pair/status | Pairing status |
| POST | /mcp | MCP JSON-RPC 2.0 endpoint |
| GET | /.well-known/mcp.json | MCP server manifest |

**Tip:** Discover your node ID with `curl -s http://localhost:7700/api/pair/status | jq .node_id` — use it for the `/api/history` endpoint:

```bash
NODE_ID=$(curl -s http://localhost:7700/api/pair/status | jq -r .node_id)
curl "http://localhost:7700/api/history?node_id=$NODE_ID" | jq '.samples | length'
```

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

## Teams & Organizations

Wicklee uses Clerk Organizations for shared fleet access. When you create an organization, every member sees the same fleet dashboard — nodes, observations, alerts, and history are all shared.

**Setup:** Create org → Invite members by email → Pair nodes while org is active → All members see the same fleet.

**Tier inheritance:** The org inherits the subscription tier of its creator. Upgrade to Team and all members benefit — no individual subscriptions needed.

**Solo users:** Organizations are optional. Community and Pro users can use Wicklee as a single-user dashboard with no changes.

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
| get_observations | 17 server-side observation patterns — live data from DuckDB |
| get_metrics_history | 1-hour rolling telemetry buffer from DuckDB |

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

# Linux
nano ~/.config/Claude/claude_desktop_config.json

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

Open the global config (or use `.cursor/mcp.json` for project-scoped):

```bash
nano ~/.cursor/mcp.json
```

Add the `wicklee` entry (create the file if it doesn't exist):

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

Open the config:

```bash
nano ~/.codeium/windsurf/mcp_config.json
```

Add the `wicklee` entry (create the file if it doesn't exist):

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

### Cloud MCP Server (Team+)

Fleet-aggregated MCP at `POST wicklee.dev/mcp`. Clerk JWT auth. 8 tools + 2 resources:

| Tool | Description |
|------|-------------|
| get_fleet_status | All nodes with online status, inference state, WES, tok/s, thermal |
| get_fleet_wes | Compact WES scores for all fleet nodes |
| get_node_detail | Full MetricsPayload for a specific node (requires node_id) |
| get_best_route | Routing recommendation — best node by throughput and efficiency |
| get_fleet_insights | Fleet health summary — online/total, avg WES, fleet tok/s, observation count |
| get_fleet_observations | Active/resolved observations across the fleet (tier-filtered) |
| get_inference_profile | Correlated profiler snapshot for a node (TTFT, KV cache, thermal, power) |
| explain_slowdown | Hardware context for root cause analysis of slow requests |

**Resources:**

| URI | Description |
|-----|-------------|
| wicklee://fleet/status | Fleet summary: online count, total nodes, avg WES |
| wicklee://fleet/thermal | Per-node thermal states + WES penalty values |

### Using MCP Resources

Resources are read via the `resources/read` method. Unlike tools (which take arguments), resources return a fixed payload for a given URI:

```json
// Request: read a resource
{
  "jsonrpc": "2.0",
  "method": "resources/read",
  "params": { "uri": "wicklee://fleet/status" },
  "id": 1
}

// Response
{
  "jsonrpc": "2.0",
  "result": {
    "contents": [{
      "uri": "wicklee://fleet/status",
      "mimeType": "application/json",
      "text": "{\"online\": 3, \"total\": 5, \"avg_wes\": 8.4}"
    }]
  },
  "id": 1
}
```

Local resources (`wicklee://node/metrics`, `wicklee://node/thermal`) work the same way on `localhost:7700/mcp`. No auth needed.

### Using MCP Tools

Tools are called via the `tools/call` method with a `name` and optional `arguments`:

```json
// Request: call a tool
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "get_best_route",
    "arguments": {}
  },
  "id": 2
}

// Response
{
  "jsonrpc": "2.0",
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"latency\": {\"node\": \"WK-A1B2\", \"tok_s\": 45.2}, \"efficiency\": {\"node\": \"WK-C3D4\", \"wes\": 12.1}, \"default\": \"efficiency\"}"
    }]
  },
  "id": 2
}
```

Tools that require arguments (like `get_node_detail`):

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "get_node_detail",
    "arguments": { "node_id": "WK-A1B2" }
  },
  "id": 3
}
```

---

## Inline Proxy (Ollama)

By default, Wicklee monitors inference using a lightweight synthetic probe (20 tokens every ~30 seconds). The optional inline proxy intercepts real Ollama traffic to provide continuous, production-grade metrics with zero sampling gap.

### What the proxy adds

| Metric | Probe (default) | With Proxy |
|--------|-----------------|------------|
| tok/s | Synthetic baseline (~30s cadence) | Exact from real requests (continuous) |
| TTFT | Cold-start synthetic | Rolling average from production traffic |
| E2E Latency | — | Full request duration (prompt + generation) |
| Request Count | — | Cumulative total since agent start |

### How it works

The proxy binds to `localhost:11434` (Ollama's default port). Ollama is moved to a different port. All requests flow through Wicklee transparently — the proxy extracts timing metrics from done packets and forwards everything unmodified. Your clients (Cursor, Open WebUI, etc.) don't need any configuration changes.

### Setup

**Step 1 — Move Ollama to a different port:**

```bash
# macOS (Ollama desktop app — most common)
launchctl setenv OLLAMA_HOST 127.0.0.1:11435
# Quit Ollama from menu bar, then reopen it.
# Verify: curl -s http://127.0.0.1:11435/api/version

# macOS (Ollama via launchd service — if you have a plist)
# Edit ~/Library/LaunchAgents/com.ollama.startup.plist
# Add EnvironmentVariables with OLLAMA_HOST=127.0.0.1:11435
# Then: launchctl unload / load the plist

# Linux (systemd)
sudo systemctl edit ollama
# Add under [Service]:
#   Environment="OLLAMA_HOST=127.0.0.1:11435"
sudo systemctl restart ollama
```

**Step 2 — Enable the proxy in Wicklee config:**

```bash
# Open the config:
# macOS: sudo nano "/Library/Application Support/Wicklee/config.toml"
# Linux: sudo nano /etc/wicklee/config.toml

# Add at the bottom:
[ollama_proxy]
enabled     = true
ollama_port = 11435   # port where Ollama now listens
```

**Step 3 — Restart the Wicklee agent:**

```bash
curl -fsSL https://wicklee.dev/install.sh | bash
# or manually:
# macOS: sudo launchctl kickstart -k system/dev.wicklee.agent
# Linux: sudo systemctl restart wicklee
```

Verify the proxy is active — your dashboard will show `proxy: :11434 → :11435` in the Diagnostics rail.

### Tier note

The proxy works locally on all tiers (Community included). Proxy-derived metrics (E2E latency, request count, production tok/s) are visible in the fleet dashboard for **Pro tier and above**.

### Why Ollama only?

vLLM already exposes production latency histograms natively via its `/metrics` Prometheus endpoint — no proxy needed. Ollama doesn't expose request-level timing, so the proxy fills that gap.

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
| ollama_proxy.enabled | false | Enable [inline proxy](#inline-proxy-ollama) on :11434 |

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
| Alerts | — | Slack, Email | Slack, Email, PagerDuty | All |

---

*Full API schema: [openapi.json](https://wicklee.dev/openapi.json) · AI discovery: [llms.txt](https://wicklee.dev/llms.txt)*
