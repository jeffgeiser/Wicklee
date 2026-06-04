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

### Quantization Advisor (Pro)
The "would-be" tile spec — *"Switching from Q8_0 to Q4_K_M would: free 4.2 GB VRAM, reduce power ~15%, improve WES from 8.2 to 11.4"* — is delivered by the composition of two shipped features rather than a separate tile:

1. **Quant Sweet Spot** (existing, on the Model Fit Summary Strip + Model Fit Analysis card) — bandwidth-aware tok/s and VRAM projections via `computeQuantRecommendation()`. Estimates the speed and headroom delta for moving up or down a quant level.
2. **Perplexity Tax** (shipped this release, `public/perplexity_baseline.json` + `quantSweet.ts qualityDeltaFor()`) — empirical KLD/PPL data per (model family, quant) pair sourced from Unsloth Dynamic GGUF benchmarks.

Together they answer the same three-axis question the Advisor spec posed: speed, memory, quality. The Quant Sweet Spot tile's `detail` string now reads something like *"Q6_K fits in headroom (+1.4 GB) at +0.10% PPL — near-lossless. ~13 tok/s (-31% speed)"* — covering all three axes. Future enhancement (cross-fleet empirical data: *"observed across 3 nodes running Q4 vs 1 node running Q8"*) is queued under the Team trend-cards section.

### Threshold Webhooks (Pro)
`POST /api/v1/webhooks` plus list / delete / test endpoints. Replaces polling with sub-second push notifications for state transitions (`thermal_state_changed`, `inference_state_changed`) and threshold crossings (`wes_below`, `wes_above`). Subscriptions are HMAC-SHA256 signed via `X-Wicklee-Signature` header so receivers verify authenticity. Per-(subscription, node) cooldown prevents flapping. Evaluator runs inline in the telemetry-push path so subscribers see fires within 1-2 seconds of the condition. Fire-and-forget delivery (5s timeout, no retries). Surfaced in Settings → Threshold Webhooks with a CRUD UI, secret reveal-once flow, and per-row test button.

### Thermal Budget Calculator (Pro)
`GET /api/v1/thermal-budget?node_id=X` — predicts when pushing a node harder backfires. Walks the 7-day `metrics_5min` rollup, identifies sustained Normal blocks (≥30 min) and Normal→Fair transitions, computes the sustainable tok/s rate, the load level that pushed the node out of Normal, the average time-to-Fair, and the resulting penalized rate (push ÷ 1.25). Generates a plain-English advice string comparing 1-hour token output of "stay sustainable" vs "push then drop to penalized." Confidence levels (insufficient / low / medium / high) gate the analysis based on transitions observed and total samples. Surfaced on the Performance tab as the Thermal Budget card.

### WES Long-Term Drift Pattern (Pro, #20)
20th observation pattern, cloud-evaluated. Detects gradual WES degradation by comparing the most recent 24-hour rolling average against the 6-day baseline (days 1–6 of the 7-day Pro Postgres history). Fires when the drop exceeds 15% with ≥100 baseline samples and ≥30 recent samples; cooldown 24h. Surfaces in the existing observation flow with severity `warning`. The Insights → Performance WES history chart shows a matching drift annotation when 7d range is selected, so chart and observation card stay in agreement. Extends `wes_velocity_drop` (10-minute window) into a 7-day analysis that catches dust accumulation, thermal paste aging, driver regression, and background process creep — degradations the short-window pattern misses.

### Runtime Config Surface (v0.9.0)
`GET /api/runtime-config?model=<name>` — cached launch-time configuration per model across all three runtimes. Ollama harvester populates the cache on model change via `/api/show`. Dedicated 5-minute pollers for vLLM (tries `/v1/server_info`, falls back to `ps aux`) and llama.cpp (tries `/props`, falls back to `ps aux`). New `runtime_config_available: bool` field on the MetricsPayload tells the frontend whether to render the "Config" affordance. Two placements in the dashboard: a "Config" pill in the Diagnostics rail (single-model nodes) and a per-row link in the Active Models panel (multi-model nodes). Both open `RuntimeConfigModal` with a Copy-as-Markdown button. Templates and system prompts stay local — the cloud telemetry push does NOT carry these fields, so v0.9.0 is local-only by design.

### Models Tab — Top-Level Model Lifecycle View
New `DashboardTab.MODELS` slot between Intelligence and Insights in the sidebar (icon: Boxes). Three sections: **Loaded** (model-state view: Node / Model / Quant / Memory / Active vs Idle), **Browse** (HuggingFace GGUF catalog scored against the fleet — Discovery v2 lives here), and a collapsible **Past activity** footer with 7-day model comparison and 24h swap activity. Page subtitle: *"What's loaded across your fleet, and what could you add. Inference performance lives on the Intelligence tab."*

### Discovery v2 — Context Picker, Fleet Projections, Sweet-Spot Quants
The Browse / Model Discovery panel got a major overhaul. HuggingFace catalog bumped 30 → 100 cached models. New context-length picker (2K / 4K / 8K (default) / 16K / 32K / 128K) — each variant's VRAM and fit re-score when changed, using architecture-aware KV cache estimates per parameter class. New fit-mode toggle: **"Any node ✓"** (default) vs **"All nodes (intersection)"** — default-any unlocks heterogeneous fleets that the implicit intersection used to punish. Two-line row layout surfaces recommended quant, file size, fit bars, projected tok/s, projected cost/M tokens, downloads, likes. Quant labels carry hover tooltips from the QUANT_QUALITY map; the sweet-spot quant per model family gets a `[Rec]` badge. Projected tok/s and cost/M tokens are sourced from the fleet's own historical model-comparison data — only shown when 2+ similar-size models have been observed — which is the moat versus generic "can you run this LLM?" tools.

### Cloud Fleet Model Endpoints
Three new Bearer-authed endpoints on the cloud backend, mirroring the localhost shape so the frontend re-uses rendering logic verbatim: `GET /api/v1/fleet/model-comparison?hours=168` (per-model rollup from `metrics_5min`), `GET /api/v1/fleet/model-switches?hours=24` (LAG window function over `metrics_raw`, capped at 200 rows), `GET /api/v1/fleet/cost-by-model?hours=24` (per-model cost at $0.16/kWh default). Backed by a new `ollama_active_model TEXT` column added to both `metrics_raw` and `metrics_5min` via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — additive, zero-downtime; old rows stay NULL until new ingestion populates them.

### Install Flow v0.8.x — No-Sudo + glibc 2.31 Default
`curl | bash` now drops the binary at `~/.wicklee/bin/wicklee` with **no sudo** (v0.8.0). Service install via `sudo ~/.wicklee/bin/wicklee --install-service` is opt-in and self-promotes the binary to `/usr/local/bin/wicklee`. v0.8.1 auto-stops any foreground process holding `:7700` so users can chain the two commands without a `pkill` in between. v0.8.2 switched the default Linux build from musl to glibc, restoring DuckDB and the 14 store-backed routes that musl silently stripped (`/api/observations`, `/api/profile`, `/api/sla`, `/api/cost-by-model`, `/api/explain-slowdown`, `/api/model-comparison`, `/api/model-switches`, `/api/model-candidates`, `/api/history`, `/api/traces`, `/api/events/history`, `/api/export`, `/api/insights/dismiss`, `/api/insights/dismissed`). v0.8.3 builds Linux binaries inside an `ubuntu:20.04` container so they target glibc 2.31 — forward-compatible with Ubuntu 20.04+, Debian 11+, RHEL 8+, Fedora 33+.

### Landing Page Repositioning
Hero rewritten to *"Self-hosted AI inference, fully observable."* Subtitle calls out WES, 18 patterns, instant model fit checks, programmable APIs for Ollama / vLLM / llama.cpp. New Model Fit / Model Discovery section under the fold with a live-feeling mocked panel. Replaced the "Grows With You" tier-ladder narrative with an "Enriches your existing stack" ecosystem narrative — Wicklee is positioned as best-of-breed hardware observability that complements Datadog/Grafana, not a replacement.

### Launch-Week Blog Posts
Four pieces shipped together: `/blog/wes-the-mpg-for-local-ai-inference` (polished with a "What's shipped since" section), `/blog/hardware-aware-observability` (positioning manifesto), `/blog/apple-silicon-thermal-throttling` (technical credibility piece), `/blog/runtime-config-surface` (v0.9.0 launch post).

### Model Fit Score: vLLM KV-Cache Reservation Fix
`computeModelFitScore()` previously used `nvidia_vram_used_mb` as a proxy for both model size *and* occupied memory. vLLM eagerly reserves ~90% of VRAM for KV cache (its `gpu_memory_utilization` default), so the proxy reflected engine reservation rather than weights — scoring nodes "Poor" for models that actually fit comfortably. New `src/utils/quantSize.ts` adds `bytesPerWeight()` + `parseQuantFromAnyModelName()` (handles GGUF tags AND full-precision tags FP8/BF16/F16) and an `estimateModelSizeGbFromName()` composer. The fit calculator now picks model size from a priority chain: ollama_model_size_gb → params×BPW from name → vram_used → system memory delta. For vLLM/llama.cpp the "used" baseline becomes model_size + 10%, answering "does my model fit with room for context?" instead of "how much has the engine pre-allocated?"

---

## Planned

### install.sh upgrade path for users with system-path binaries
The no-sudo install introduced in v0.8.x writes to `~/.wicklee/bin/wicklee`, but users who originally ran `sudo wicklee --install-service` have a LaunchDaemon (macOS) or systemd unit (Linux) baked with `/usr/local/bin/wicklee` (or `/usr/bin/wicklee`) as the program path. Today's `install.sh` doesn't detect this case — it silently puts the new binary at the user path while the service keeps running the stale system-path binary. The user sees "install succeeded" but `wicklee --version` shows the old version (PATH resolution finds the system binary first) and `localhost:7700` keeps serving the old UI. Fix: when install.sh detects a service-active install AND a system-path binary, prompt for sudo and replace `/usr/local/bin/wicklee` in addition to writing the user path, then `launchctl kickstart` / `systemctl restart` the service. Until shipped, the docs and post-install message should call out the manual `sudo cp ~/.wicklee/bin/wicklee /usr/local/bin/wicklee && sudo launchctl kickstart -k system/dev.wicklee.agent` step. Real bug — discovered when a user updated and saw their old UI persist after a successful install.

### macOS Gatekeeper quarantine on copied binary (related to above)
Second gotcha on the same upgrade path: once the binary is `sudo cp`'d into `/usr/local/bin/`, macOS Gatekeeper SIGKILLs it on launch (`zsh: killed`) because the `com.apple.quarantine` xattr rides along from the curl download. The binary worked fine from `~/.wicklee/bin/` (user paths are inspected more loosely); promoting it into a system path triggers stricter enforcement. Quick fix in install.sh: `xattr -d com.apple.quarantine "$BIN_PATH" 2>/dev/null || true` immediately after writing to either path. Proper long-term fix: Apple Developer ID code-signing + notarization in the release workflow ($99/yr + one-time CI setup). Once notarized, the quarantine flag is benign — signed-and-notarized binaries run from any path without Gatekeeper intervention.

### Unify fit-scoring between agent and cloud (Bug 3 from Discovery audit)
The agent's `score_fit()` in `agent/src/main.rs:197` and the cloud's `cloud_fit_score()` in `cloud/src/main.rs:4847` started from the same logic but have drifted. Same hardware (12 GB Apple M4) running the same candidate (`Qwen2.5-Coder-7B-Instruct-GGUF`) renders as "Tight ≈27 tok/s" on the cloud and "Good ≈58 tok/s" on localhost — the 2× tok/s gap is mostly explained by the catalog-variant bug fixed in v0.9.x, but the underlying fit grades still differ even on the same variant. Fix: extract the scoring logic into a shared crate `wicklee-scoring` consumed by both binaries, or duplicate but lock with a cross-binary contract test that asserts identical scores for a canonical input set. The drift erodes user trust the moment they compare localhost and cloud dashboards. Same applies to `extract_params_b` and `bytes_per_param_for_quant`/`is_plausible_size_for_quant` — currently duplicated between agent + cloud as an interim measure while the shared crate is on the backlog.

### Catalog cache sync between agent and cloud (Bug 2 from Discovery audit)
Each backend pulls "top GGUF by HuggingFace downloads" on its own 24h cadence — agent caches into DuckDB, cloud into Postgres. The snapshots drift: as of audit, cloud showed 84 total models, localhost 46, with different model sets in each. Two reasonable resolutions: (A) the cloud becomes the single source of truth for the trending list; the agent's `/api/model-candidates` proxies the cloud catalog when paired (graceful fallback to local cache when unpaired or cloud unreachable). (B) Both keep separate caches but the response carries the cache age + size so the frontend can surface "your localhost catalog is 6 hours older than the fleet's — refresh available." Option B is lower effort and more honest about the dual-cache reality; option A is the long-term right call once the cloud's catalog refresh is fast enough that agents can rely on it.

### Subscription Tier Gating on Fleet Model Endpoints
The three new cloud endpoints shipped with the Models tab — `/api/v1/fleet/model-comparison`, `/api/v1/fleet/model-switches`, `/api/v1/fleet/cost-by-model` — are Bearer-auth-gated but not tier-gated. Any signed-in user gets the same 168-hour ceiling on the `hours` parameter regardless of plan. Intent per pricing: Community 24h, Pro 7d (168h), Team 90d, Business 365d. Implementation: extract `subscription_tier` from the user record at the handler, clamp `hours` against a per-tier max, and return a `tier_limit_hit` flag in the response envelope so the frontend can surface an upgrade nudge when a request was truncated. Low priority — small user base today, simple fix when revenue justifies it.

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

### Cross-Node Model Migration
"Llama 3.1 70B on WK-A1B2 has WES 8.2, VRAM at 89%. WK-C3D4 has WES 12.1, VRAM at 52%. Recommend migrating for 47% efficiency gain." Fleet-wide model placement optimization based on measured performance.

### Deployment Profiles
Single config selector (`sovereign_dev`, `dedicated_server`, `production_fleet`) that adjusts all observation thresholds, evidence windows, and alert sensitivity coherently. sovereign_dev: high thresholds, long windows — laptop running inference alongside other workloads. dedicated_server: standard thresholds — single-purpose inference node. production_fleet: aggressive early warning — serving real users where latency matters. Eliminates per-pattern threshold knobs in favor of a single intent declaration. Maps cleanly to routing_hint severity: steer_away on a dev profile means genuinely broken, on production it means slightly degraded.

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
