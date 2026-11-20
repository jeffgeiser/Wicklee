# Wicklee API Reference

## Localhost Agent API

Base URL: `http://localhost:7700`
Auth: none on a loopback bind. A non-loopback `bind_address` refuses to start
without an inbound token, and the refusal names the key to set.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/metrics | SSE stream — 1 Hz telemetry with full MetricsPayload |
| GET | /ws | WebSocket — 1 Hz live telemetry (same payload as SSE, fallback transport) |
| GET | /api/observations | 18 agent-evaluated patterns with routing_hint per observation + node-level routing_hint/routing_hint_source. |
| GET | /api/history?node_id=WK-XXXX | Metric history — 1h raw samples |
| GET | /api/profile?minutes=60 | Inference Profiler — correlated TTFT/KV/queue/thermal/power timeline |
| GET | /api/sla?window_min=60&target_ttft_ms=500 | Inference SLA Monitor — p50/p95/p99 for TTFT, E2E latency, TPOT plus compliance vs target |
| GET | /api/health | Agent diagnostic — agent version, build target, node id, DuckDB store health, list of routes available/unavailable when store init failed. One-curl debug for "why are my routes missing?" |
| GET | /api/cost-by-model?hours=24 | Cost attribution per model — daily power cost breakdown |
| GET | /api/explain-slowdown?ts_ms=N | Slowdown explainer — root cause analysis for a slow request |
| GET | /api/model-comparison?hours=168 | Model comparison — side-by-side efficiency for every model that has run |
| GET | /api/model-switches?hours=24 | Model switching cost — swap frequency, idle gap per transition |
| GET | /api/model-candidates?search=llama&limit=20 | Model discovery — GGUF models from HuggingFace scored against local hardware |
| GET | /api/runtime-config?model=X | Runtime Config Surface (v0.9.0) — cached launch-time config for a named model (Ollama, vLLM, llama.cpp). 200 with JSON, 400 if `?model=` missing, 404 if not yet cached. Templates and system prompts never leave the machine. |
| GET | /api/traces | Proxy inference traces |
| GET | /api/events/history | Node event log |
| GET | /api/events/recent | Recent in-memory events |
| GET | /api/export?format=json\|csv | Data export |
| GET | /api/tags | Ollama model tags |
| POST | /api/insights/dismiss | Permanently dismiss a pattern |
| GET | /api/insights/dismissed | List dismissed patterns |
| POST | /mcp | MCP (Model Context Protocol) JSON-RPC 2.0 endpoint |
| GET | /.well-known/mcp.json | MCP server manifest |

## Phase 1 `/v1` — models, readiness, findings

Base URL: `http://localhost:7700`
Auth: none when the agent is bound to loopback. With `bind_address = "0.0.0.0"`
every `/api`, `/v1` and `/mcp` request from another machine must present the
configured token as a bearer token, and the agent refuses to start bound
non-loopback without one.

Every statement these routes make carries a label — `observed` (Wicklee saw
it), `inferred` (a likely cause, always hedged) or `verified` (measured, with
a range) — and the evidence behind it. Where a rule could not run, the
response lists it under `not_checked` rather than returning an empty result.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /v1/state | Every installed model: residency, running context, measured footprint, how much sits outside accelerator memory, last real caller. Plus a capability record of which fields this runtime actually returns |
| GET | /v1/readiness?model=X | `ready_now`, `requires_loading`, `would_displace` or `cannot_determine`, with memory headroom and the evidence. `valid_for_s` says how long it holds. A `requires_loading` answer carries `coexistence: "unverified"` while another model is resident: it fits by accounting, and on the one host measured the runtime still evicted a resident model in 5 of 6 such cases |
| GET | /v1/inspect?since=24h | Findings, readiness and what was not checked, in one answer |
| GET | /v1/findings?all=true | The findings alone. Resolution is observed, not scheduled: a finding resolves because an evaluation ran and did not produce it |
| GET | /v1/receipts?model=X&limit=N | Stored per-request measurements with a median and range. `persisted` says whether they survive a restart: a build with no local store keeps them in memory only |
| POST | /v1/receipts | Your runtime's final-response metadata, stored as a receipt. Durations are nanoseconds in the runtime's own field names. **Refuses any payload containing `prompt`, `response`, `messages` or `context` with a 400 naming the field** |
| POST | /v1/fingerprint | A consented test run: `decode_rate`, `cold_load` or `workflow_replay`. Without `"consent": true` it answers 400 with the plan and the sentence you would agree to |
| POST | /v1/verify | Re-runs a finding's test and compares it with the first run. `improved`, `worse` or `no measurable change`. Same consent gate. **501 on a build with no local store** (the statically linked Linux build), which has no stored finding to look up and no durable baseline to compare against |

### POST /v1/receipts

```bash
curl -X POST http://localhost:7700/v1/receipts \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "coder:14b",
    "total_duration": 8113331500,
    "load_duration": 6396458,
    "prompt_eval_count": 26,
    "prompt_eval_duration": 130079000,
    "eval_count": 298,
    "eval_duration": 4868000000,
    "num_ctx": 32768
  }'
```

Every field is optional except `model`. A receipt with only durations is still
useful. A posted receipt also counts as activity, so a model serving real
traffic through your own caller no longer reads as idle to `/v1/readiness`.

This is the preferred way to get exact receipts, and on a default macOS
install the only one that works: the proxy cannot bind 11434 while Ollama
holds it.

### A verdict from POST /v1/verify

Improved or worse needs three things: ranges that do not overlap, at least
three receipts a side, and medians at least 5% apart. Anything else is
`no measurable change` with the reason printed — two runs of the same test on
an idle host can land in disjoint narrow bands 1.5% apart, which is scatter
rather than a result.

### CLI

```bash
wicklee ready [MODEL]          # /v1/readiness
wicklee inspect [--since 24h]  # /v1/inspect
wicklee findings [--all]       # /v1/findings
wicklee fingerprint MODEL [--cold] [--runs N] [--force] [--yes]
wicklee verify FINDING_ID [--force] [--yes]
```

`--json` on any of them prints the route's body verbatim.

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
| `get_metrics_history` | 1-hour rolling telemetry buffer |
| `wicklee_state` | Same JSON as `GET /v1/state` |
| `wicklee_readiness` | Same JSON as `GET /v1/readiness`. Takes `model`. Call before starting a task to see whether a model can run without displacing another |
| `wicklee_inspect` | Same JSON as `GET /v1/inspect`. Takes `since` |

Each `wicklee_*` tool calls the same handler function its route calls, so the
two cannot diverge.

**Retired:** `get_model_fit` (use `wicklee_readiness`) and `get_observations`
(use `wicklee_inspect`). Both still answer, with `-32601` and the name of
their replacement.

**Not exposed:** `fingerprint` and `verify`. They are the only routes that
load models, and an agent able to trigger one could displace a colleague's
model while answering a question about it.

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

## Response Examples

## Response Examples

See the `/v1` sections above and [llms-full.txt](https://wicklee.dev/llms-full.txt) for example bodies.

## Key Metrics

| Field | Type | Description |
|-------|------|-------------|
| inference_state | string | "live" \| "idle-spd" \| "busy" \| "idle" |
| ollama_tokens_per_second | f32 | tok/s from 20-token probe (≤ every 10 min) |
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
