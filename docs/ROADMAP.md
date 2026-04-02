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
User-configurable thresholds for TTFT regression, throughput, and thermal events. Slack and email notification channels.

---

## In Progress

### Cloud MCP Server
Fleet-aggregated MCP endpoint for remote AI agents. Fleet status, multi-node routing, cross-node pattern correlation. Team tier.

---

## Planned

### Kubernetes Operator
Helm chart and operator for automated Wicklee agent deployment across GPU node pools.

---

## Contributing

Issues and PRs welcome. See the [README](../README.md) for build instructions.
