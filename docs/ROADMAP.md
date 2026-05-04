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

### Inference SLA Monitor (Pro)
`GET /api/sla?window_min=60&target_ttft_ms=500` — p50/p95/p99/max for TTFT, end-to-end latency, and TPOT, computed via DuckDB `quantile_cont()` over per-request `inference_traces`. Compliance percentage against a configurable TTFT target, the 20 most-recent violations, and a per-model breakdown. Frontend SLA Monitor card on the Performance tab with 1h / 6h / 24h windows and 250 ms / 500 ms / 1 s / 2 s target presets. Powers the "is my local inference meeting SLA?" question for teams exposing Wicklee nodes as internal inference APIs.

### Bandwidth Ceiling Reached Pattern (Pro)
19th observation pattern (info severity). Detects when a node sustains ≥65% of its theoretical memory-bandwidth ceiling for the loaded model+quant with GPU < 95% — explains "Low" tok/W as physics, not pathology. Per-chip bandwidth lookup (Apple M-series, NVIDIA H100/H200/A100/L40S/RTX, DGX Spark/GB10).

### Perplexity Tax — Empirical Quant Quality Cost
Replaces the hand-tuned `QUALITY_DELTA` heuristics in `quantSweet.ts` and the coarse `quant_quality_factor()` multiplier in `cloud/main.rs` with empirical KL divergence + perplexity-delta data sourced from Unsloth Dynamic GGUF benchmarks and llama.cpp perplexity discussions. Single source of truth in `public/perplexity_baseline.json`; cloud embeds it via `include_str!` so frontend Quant Sweet Spot tiles and cloud-side fleet-discovery scoring agree.

Curated coverage for ~15 model families (Llama 3.1/3.2 8B-70B, Qwen 2.5 7B-72B, Mistral 7B, Mixtral 8x7B, Gemma 2 9B-27B, Phi-3 Mini, DeepSeek-R1 distills) with a "default" generic baseline as fallback. Lookup falls back: exact family → default → legacy heuristic. `quant_quality_factor()` becomes a continuous KLD-derived multiplier (0.0 at KLD=0.15, 1.0 at KLD=0). New "Perplexity Tax" block on ModelFitAnalysis detail view shows band label (Imperceptible / Mild / Noticeable / Severe / Unusable), KLD, and PPL delta. Quant Sweet Spot summary strip tile gains a Quality: line.

### Model Fit Summary Strip (Overview)
Three condensed first-fold tiles under the KPI hero row — Model Fit, Quant Sweet Spot, Context Runway — promoting the existing analysis to first-glance visibility without disrupting Diagnostics/Inference layout. Each tile click-throughs to the full ModelFitAnalysis section. Localhost: per-node strip. Fleet: highest-throughput active node with a chip-row picker when multiple nodes have models loaded. ModelFitAnalysis detail view also gains a plain-English verdict sentence; fleet-aggregate sentence summarises *"X of Y models need attention across N nodes"*.

### Context Runway for vLLM / llama.cpp
`computeContextRunway` previously required Ollama `/api/show` enrichment fields (num_layers, kv_heads, embedding_dim) or `ollama_parameter_count` — both Ollama-only. New `parseParamCountFromModelName()` extracts size from the model name itself (handles `qwen2.5-32b`, `Mixtral-8x7B`, `deepseek-coder-6.7b`) so vLLM and llama.cpp nodes get a ±30% architecture estimate instead of "Awaiting architecture."

### vLLM `/v1/models` Metadata Capture
Agent harvester now fetches `/v1/models` on each model change and exposes `vllm_max_model_len` on the wire. Replaces the conservative 8 192-token Context Runway floor with the engine's actual context window for vLLM-backed nodes. Cached per (model_name, port) — fetched once per model change rather than every 2-second tick. Three-way wire-format sync (agent → cloud → frontend type).

### Model Fit Score: vLLM KV-Cache Reservation Fix
`computeModelFitScore()` previously used `nvidia_vram_used_mb` as a proxy for both model size *and* occupied memory. vLLM eagerly reserves ~90% of VRAM for KV cache (its `gpu_memory_utilization` default), so the proxy reflected engine reservation rather than weights — scoring nodes "Poor" for models that actually fit comfortably. New `src/utils/quantSize.ts` adds `bytesPerWeight()` + `parseQuantFromAnyModelName()` (handles GGUF tags AND full-precision tags FP8/BF16/F16) and an `estimateModelSizeGbFromName()` composer. The fit calculator now picks model size from a priority chain: ollama_model_size_gb → params×BPW from name → vram_used → system memory delta. For vLLM/llama.cpp the "used" baseline becomes model_size + 10%, answering "does my model fit with room for context?" instead of "how much has the engine pre-allocated?"

---

## Planned

### Fleet SLA Aggregation (Pro/Team)
`GET /api/v1/fleet/sla` — fleet-wide aggregation of the per-node SLA Monitor. Cloud backend pulls each node's `inference_traces` via the existing telemetry path and computes fleet-wide p95/p99 across all requests, plus a per-node breakdown ranked by p95 TTFT. Surfaces on `wicklee.dev` as the fleet-level companion to the Performance tab's SLA Monitor card. Pro for single-node SLA on the cloud dashboard; Team for the fleet roll-up + cross-node compliance reporting.

### vLLM Native Histogram Source
Read percentiles directly from vLLM's Prometheus `/metrics` endpoint (`vllm_request_latency_seconds_bucket`, `vllm_time_to_first_token_seconds_bucket`) instead of relying on the Ollama proxy's per-request traces. Lets users running vLLM directly (no proxy) get accurate p95/p99 SLA data without enabling proxy mode. The SLA endpoint chooses source per-runtime: proxy traces for Ollama, native histograms for vLLM, both for mixed deployments.

### vLLM Dtype Capture (Process Cmdline)
The vLLM Prometheus `/metrics` endpoint and `/v1/models` both omit the engine's runtime dtype (FP8 / BF16 / FP16 / AWQ / GPTQ etc.). To accurately size weight memory for the Model Fit calculator we currently default to FP16/BF16 (2 bytes/weight) when the model name carries no quant tag — slightly over-estimates for actually-quantized vLLM deployments. Stage 2: capture the `--dtype` / `--quantization` flags from the vLLM process command line via the existing process_discovery scanner; expose as `vllm_dtype` on the wire (three-way sync); frontend prefers it over name-based parsing. Eliminates the over-estimate path for users running explicit FP8 / AWQ / GPTQ.

### vLLM Exact GQA Architecture (HF config.json)
Stage 1 (shipped) captures `max_model_len` from vLLM's `/v1/models`, but exact `num_hidden_layers` / `num_key_value_heads` / `hidden_size` / `num_attention_heads` for the GQA-aware Context Runway require fetching the model's `config.json` from HuggingFace. To avoid adding a network dependency to the agent (sovereign / air-gapped deploys), Stage 2 will mediate this through the cloud: a new `/api/v1/model-arch?model_id=` endpoint proxies HF and caches in Postgres. Frontend prefers cloud-resolved arch when the node is paired; localhost-only nodes continue using the ±30% name-based estimate.

### Model-Hardware Fit Score
"Is this model right for this hardware?" Auto-computed from VRAM headroom, tok/s vs model size ratio, thermal behavior under load, swap pressure. Returns score + recommendation (e.g., "62/100 — VRAM tight, consider Q3_K_M or smaller variant").

### Fleet Capacity Planner
"Your 3-node fleet sustains 45 tok/s at current thermal conditions. Adding one M4 Pro would add ~15 tok/s at $0.04/day." Uses real WES data from fleet to project capacity and cost of scaling.

### Quantization Advisor
"Switching from Q8_0 to Q4_K_M would: free 4.2GB VRAM, reduce power ~15%, improve WES from 8.2 to 11.4." Based on observed metrics for the same model family at different quantizations across fleet nodes.

### WES Long-Term Trending
Weekly/monthly WES trend line per node. Detects gradual degradation: thermal paste aging, dust accumulation, driver regression, background process creep. Extends Pattern C (short-term velocity drop) to 7d/90d timeframes.

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
