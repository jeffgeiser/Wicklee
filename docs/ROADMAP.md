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

---

## In Progress

### Agent API & Integrations
REST API for fleet telemetry. AI agent discovery via `llms.txt`, OpenAPI spec, and structured endpoint metadata.

### Custom Alerts
User-configurable thresholds for TTFT regression, throughput, and thermal events. Slack and email notification channels.

---

## Planned

### OpenTelemetry Export
OTLP exporter for forwarding Wicklee telemetry to Datadog, Grafana, New Relic, and other observability platforms.

### MCP Server
Model Context Protocol integration for AI agents to query fleet state, route inference, and receive hardware-aware recommendations.

### Kubernetes Operator
Helm chart and operator for automated Wicklee agent deployment across GPU node pools.

---

## Contributing

Issues and PRs welcome. See the [README](../README.md) for build instructions.
