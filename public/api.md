# Wicklee API Reference

## Localhost Agent API

Base URL: `http://localhost:7700`
Auth: None required.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/metrics | SSE stream — 1 Hz telemetry with full MetricsPayload |
| GET | /ws | WebSocket — 1 Hz live telemetry (same payload as SSE, fallback transport) |
| GET | /api/observations | 17 patterns with routing_hint per observation + node-level routing_hint/routing_hint_source |
| GET | /api/history?node_id=WK-XXXX | Metric history — 1h raw samples |
| GET | /api/profile?minutes=60 | Inference Profiler — correlated TTFT/KV/queue/thermal/power timeline |
| GET | /api/cost-by-model?hours=24 | Cost attribution per model — daily power cost breakdown |
| GET | /api/explain-slowdown?ts_ms=N | Slowdown explainer — root cause analysis for a slow request |
| GET | /api/model-comparison?hours=168 | Model comparison — side-by-side efficiency for every model that has run |
| GET | /api/model-switches?hours=24 | Model switching cost — swap frequency, idle gap per transition |
| GET | /api/traces | Proxy inference traces |
| GET | /api/events/history | Node event log |
| GET | /api/events/recent | Recent in-memory events |
| GET | /api/export?format=json\|csv | Data export |
| GET | /api/tags | Ollama model tags |
| GET | /api/pair/status | Pairing status |
| POST | /api/insights/dismiss | Permanently dismiss a pattern |
| GET | /api/insights/dismissed | List dismissed patterns |
| POST | /mcp | MCP (Model Context Protocol) JSON-RPC 2.0 endpoint |
| GET | /.well-known/mcp.json | MCP server manifest |

## MCP (Model Context Protocol)

The agent exposes a local MCP server for AI agents (Cursor, Claude Desktop, custom agents).

**Endpoint:** `POST http://localhost:7700/mcp`
**Protocol:** JSON-RPC 2.0
**Auth:** None (localhost only)

### Tools

| Tool | Description |
|------|-------------|
| `get_node_status` | Full hardware + inference metrics snapshot |
| `get_inference_state` | Live/idle/busy state with sensor context |
| `get_active_models` | Running models across Ollama, vLLM, llama.cpp |
| `get_observations` | Server-side pattern evaluation — 17 agent-evaluated observations (live data) |
| `get_metrics_history` | 1-hour rolling telemetry buffer |

### Resources

| URI | Description |
|-----|-------------|
| `wicklee://node/metrics` | Live MetricsPayload JSON |
| `wicklee://node/thermal` | Thermal state + WES penalty values |

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

Requires Node.js. Use `which npx` to find the correct npx path. Fully quit Claude Desktop (Cmd+Q) and relaunch after editing.

### Connect to Claude Code

```bash
claude mcp add -s user wicklee -- npx -y mcp-remote http://localhost:7700/mcp
```

### Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project). Add `wicklee` to `mcpServers`:

```json
"wicklee": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "http://localhost:7700/mcp"]
}
```

### Windsurf

Edit `~/.codeium/windsurf/mcp_config.json`. Add `wicklee` to `mcpServers`:

```json
"wicklee": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "http://localhost:7700/mcp"]
}
```

All setups require Node.js for the mcp-remote bridge. Restart your IDE after configuration changes.

### Test with curl

```bash
curl -X POST http://localhost:7700/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_inference_state"},"id":1}'
```

## Fleet API v1

Base URL: `https://wicklee.dev/api/v1`
Auth: `X-API-Key: wk_live_...` header.

| Method | Endpoint | Description | Tier |
|--------|----------|-------------|------|
| GET | /api/v1/fleet | All nodes with full MetricsPayload | All |
| GET | /api/v1/fleet/wes | WES scores ranked | All |
| GET | /api/v1/nodes/{id} | Single node deep dive | All |
| GET | /api/v1/route/best | Routing recommendation (latency or efficiency) | All |
| GET | /api/v1/insights/latest | Fleet intelligence snapshot | Team+ |
| POST | /api/v1/keys | Create API key | All |
| GET | /api/v1/keys | List API keys | All |
| DELETE | /api/v1/keys/{id} | Revoke API key | All |
| GET | /metrics | Prometheus scrape endpoint (text format) | Team+ |
| GET | /api/otel/config | OpenTelemetry export configuration | Team+ |
| PUT | /api/otel/config | Update OTel export settings | Team+ |

## Response Examples

### GET /api/v1/fleet/wes
```json
{
  "nodes": [
    { "node_id": "WK-XXXX", "online": true, "wes": 15.0 },
    { "node_id": "WK-99E9", "online": true, "wes": 3.2 }
  ]
}
```

### GET /api/v1/route/best
```json
{
  "latency":    { "node": "WK-99E9", "tok_s": 31.9, "wes": 3.3, "reason": "Highest throughput" },
  "efficiency": { "node": "WK-XXXX", "tok_s": 19.5, "wes": 15.0, "reason": "Highest WES" },
  "default":    "efficiency"
}
```

### GET /api/v1/insights/latest
```json
{
  "generated_at_ms": 1774624251478,
  "fleet": { "online_count": 3, "total_count": 3, "avg_wes": 9.9, "fleet_tok_s": 79.0 },
  "findings": [{
    "node_id": "WK-99E9",
    "hostname": "spark-c559",
    "severity": "low",
    "pattern": "wes_below_baseline",
    "title": "WES below fleet average",
    "detail": "WES 3.3 vs fleet average 9.9",
    "value": 3.3,
    "unit": "WES"
  }]
}
```

## Key Metrics

| Field | Type | Description |
|-------|------|-------------|
| inference_state | string | "live" \| "idle-spd" \| "busy" \| "idle" |
| ollama_tokens_per_second | f32 | tok/s from 20-token probe (~30s) |
| apple_soc_power_w | f32 | Combined CPU+GPU+ANE (Apple Silicon) |
| nvidia_power_draw_w | f32 | Board power (NVIDIA) |
| thermal_state | string | "Normal" \| "Fair" \| "Serious" \| "Critical" |
| penalty_avg | f32 | Thermal penalty (1.0 = no penalty) |
| ollama_ttft_ms | f32 | TTFT from probe baseline |
| vllm_avg_ttft_ms | f32 | TTFT from production histogram |
| vllm_requests_waiting | u32 | Queue depth |

## WES Formula

```
WES = tok/s / (Watts x ThermalPenalty)
```

Normal thermal (penalty=1.0): WES = tok/s / Watts = tok/W.

Color scale: >10 Excellent (emerald) · 3-10 Good (green) · 1-3 Acceptable (yellow) · <1 Low (red)
