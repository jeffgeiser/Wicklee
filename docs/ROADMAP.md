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
Postgres time-series storage, 5-minute rollups, tiered history retention (24h Community, 7d Pro, 90d Team, 365d Business, unlimited Enterprise), fleet alerting with per-node pattern suppression.

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
Community: 3 nodes, Pro: 10 nodes, Team: 25 nodes (expandable), Business: 100 nodes (unlimited seats), Enterprise: unlimited. Enforced at pairing, fleet list, and SSE stream.

### Five-Tier Pricing
Community (Free) → Pro ($29/mo) → Team ($49/seat/mo) → Business ($499/mo) → Enterprise (Contact Sales). Business adds 365-day history, unlimited seats, SSO/SAML, and audit logging. Paddle billing with webhook-driven tier sync.

### Server-Side Pattern Evaluation (Phase 7)
Migrated all 18 observation patterns from client-side TypeScript to server-side Rust. Agent evaluates 17 patterns against 10-min DuckDB buffer every 10s, pushes to cloud via telemetry. Cloud evaluates `fleet_load_imbalance`. Deleted `patternEngine.ts` (2,254 lines) and `useMetricHistory.ts` (284 lines).

---

### Inference Intelligence (4 features)
Four DuckDB-backed intelligence endpoints on the agent + Cloud MCP tools. Inference Profiler (`/api/profile`): correlated timeline of TTFT, KV cache, queue depth, thermal penalty, power. Cost Attribution (`/api/cost-by-model`): per-model daily cost breakdown. Slowdown Explainer (`/api/explain-slowdown`): root cause analysis with 6 hardware factors. Model Comparison (`/api/model-comparison`): side-by-side WES, tok/s, watts, TTFT, cost for every model that has run on this node — answers "which model is most efficient on my hardware?" Frontend: Cost by Model table on Overview, Profiler chart on Performance tab, enriched observation body text.

### MCP Tool Fixes
`get_observations` and `get_metrics_history` now return live data via internal HTTP calls to the agent's own REST API instead of redirecting users to REST endpoints.

---

## Planned

### Model-Hardware Fit Score
"Is this model right for this hardware?" Auto-computed from VRAM headroom, tok/s vs model size ratio, thermal behavior under load, swap pressure. Returns score + recommendation (e.g., "62/100 — VRAM tight, consider Q3_K_M or smaller variant").

### Fleet Capacity Planner
"Your 3-node fleet sustains 45 tok/s at current thermal conditions. Adding one M4 Pro would add ~15 tok/s at $0.04/day." Uses real WES data from fleet to project capacity and cost of scaling.

### Quantization Advisor
"Switching from Q8_0 to Q4_K_M would: free 4.2GB VRAM, reduce power ~15%, improve WES from 8.2 to 11.4." Based on observed metrics for the same model family at different quantizations across fleet nodes.

### WES Long-Term Trending
Weekly/monthly WES trend line per node. Detects gradual degradation: thermal paste aging, dust accumulation, driver regression, background process creep. Extends Pattern C (short-term velocity drop) to 7d/90d timeframes.

### Inference SLA Monitor
p95/p99 TTFT over configurable windows. "Your p95 TTFT over the last 24h was 340ms. 3 requests exceeded 2s (all during thermal throttle at 14:00-14:15)." For teams running local inference as internal service.

### Cross-Node Model Migration
"Llama 3.1 70B on WK-A1B2 has WES 8.2, VRAM at 89%. WK-C3D4 has WES 12.1, VRAM at 52%. Recommend migrating for 47% efficiency gain." Fleet-wide model placement optimization based on measured performance.

### Thermal Budget Calculator
"Your M4 Pro sustains 40 tok/s indefinitely at Normal thermal. Pushing to 50 tok/s triggers Fair thermal within ~8 min, reducing effective throughput to 32 tok/s. Net: fewer tokens by pushing harder." Predicts when increased load backfires.

### Deployment Profiles
Single config selector (`sovereign_dev`, `dedicated_server`, `production_fleet`) that adjusts all observation thresholds, evidence windows, and alert sensitivity coherently. sovereign_dev: high thresholds, long windows — laptop running inference alongside other workloads. dedicated_server: standard thresholds — single-purpose inference node. production_fleet: aggressive early warning — serving real users where latency matters. Eliminates per-pattern threshold knobs in favor of a single intent declaration. Maps cleanly to routing_hint severity: steer_away on a dev profile means genuinely broken, on production it means slightly degraded.

### Threshold Webhooks (Event-Driven Push)
Register interest in specific state transitions (inference_state changed, thermal_state > Fair, WES dropped below threshold) and receive push notifications without polling. Essential for NRO/agent automation loops that need sub-second reaction to fleet state changes. Would run off the existing SSE stream with a subscription/filter model.

### Kubernetes Operator
Helm chart and operator for automated Wicklee agent deployment across GPU node pools.

### Install Telemetry
Anonymous install event tracking (OS, arch, version) via fire-and-forget ping from `install.sh` to cloud endpoint. Powers activation funnel metrics without collecting PII.

### Audit Logging (Business+)
Immutable audit trail for sensitive fleet operations: node add/remove, alert config changes, API key lifecycle, team member management. Postgres-backed with `GET /api/audit-log` endpoint and Settings UI.

### WES Leaderboard (Public)
Anonymous hardware benchmark submissions with public ranking. "MPG for AI" — compare tok/W across hardware configurations. Public read API + submission endpoint.

### SSO/SAML (Business+)
SAML 2.0 single sign-on via Clerk Organizations. Configured per-org in Clerk dashboard. Business and Enterprise tiers.

---

## Contributing

Issues and PRs welcome. See the [README](../README.md) for build instructions.
