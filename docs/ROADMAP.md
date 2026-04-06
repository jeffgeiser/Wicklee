# Wicklee Roadmap

> Sovereign GPU fleet monitoring for local AI inference.

For detailed documentation, visit [wicklee.dev/docs](https://wicklee.dev/docs).

---

## Shipped

### Standalone Agent
Single Rust binary, embedded React dashboard, Apple Silicon deep metal telemetry, sudoless GPU metrics, global CLI installer.

### Multi-Node Fleet
NVIDIA/NVML support, fleet pairing, hosted fleet aggregation, SSE-based real-time streaming.

### Intelligence Layer
WES (Wicklee Efficiency Score) — tokens per watt with thermal penalty. 18 hardware observation patterns across thermal, power, memory, bandwidth, and inference domains.

### Inference Metrics
Ollama and vLLM runtime detection. Prompt eval speed, TTFT, queue depth, KV cache utilization. Optional transparent proxy for production request metrics.

### Cloud Infrastructure
Postgres time-series storage, 5-minute rollups, 90-day history, fleet alerting with per-node pattern suppression.

### Platform Support
macOS (Apple Silicon + Intel), Linux (x86_64 + aarch64), Windows, NVIDIA GPU builds with NVML.

### Local MCP Server
JSON-RPC 2.0 endpoint (`POST /mcp`) on the agent for AI agents (Cursor, Claude Desktop) to query node status, inference state, active models, observations, and thermal data. Zero new dependencies. All tiers.

### OpenTelemetry Export
OTLP HTTP exporter on the cloud backend. 8 gauges per node (GPU utilization, power, tok/s, WES, thermal penalty, memory pressure, TTFT, inference state) pushed to configured endpoints. Prometheus scrape endpoint. Team tier.

### Agent API & Integrations
REST API for fleet telemetry. AI agent discovery via `llms.txt`, OpenAPI spec, and structured endpoint metadata.

### Custom Alerts
User-configurable thresholds for TTFT regression, throughput, and thermal events. Slack, email, and PagerDuty notification channels. PagerDuty uses Events API v2 with auto-resolve on incident lifecycle.

### Cloud MCP Server
Fleet-aggregated MCP endpoint (`POST wicklee.dev/mcp`) for remote AI agents. 6 tools: fleet status, WES scores, node detail, best route, fleet insights, fleet observations. 2 resources: fleet status summary, fleet thermal states. Team+ tier, Clerk JWT auth.

### Clerk Organizations (Shared Fleet)
Team dashboard sharing via Clerk Organizations. Org members see the same fleet — nodes, observations, alerts, and history are all scoped to the organization. Org inherits creator's subscription tier; syncs on Paddle upgrade/downgrade. Solo users unaffected.

### PagerDuty Alerts
Events API v2 integration for Team+ tier. Trigger and resolve events with dedup key for incident lifecycle. Routing key configured in Settings → Alerts.

### Per-Tier Node Limits
Community: 3 nodes, Pro: 10 nodes, Team: 25 nodes (expandable), Enterprise: unlimited. Enforced at pairing, fleet list, and SSE stream.

### Server-Side Pattern Evaluation (Phase 7)
Migrated all 18 observation patterns from client-side TypeScript to server-side Rust. Agent evaluates 17 patterns against 10-min DuckDB buffer every 10s, pushes to cloud via telemetry. Cloud evaluates `fleet_load_imbalance`. Deleted `patternEngine.ts` (2,254 lines) and `useMetricHistory.ts` (284 lines).

---

## Planned

### Kubernetes Operator
Helm chart and operator for automated Wicklee agent deployment across GPU node pools.

---

## Contributing

Issues and PRs welcome. See the [README](../README.md) for build instructions.
