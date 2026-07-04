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

### Audit Logging (Business+)
Immutable, append-only audit trail for sensitive fleet operations, Postgres-backed (`audit_log` table, no UPDATE/DELETE paths anywhere in the codebase). `GET /api/audit-log` (Clerk JWT auth, tenant-scoped, cursor-paginated via `before`, filterable by `action`) is gated to Business+ for reads; events are recorded for every tier via a fire-and-forget `audit()` helper that never delays or fails the request and resolves the actor email server-side. `org_id` comes from the verified JWT claim, never a client header. Nine instrumented actions: `node.paired` / `node.removed` / `node.updated`, `alert_rule.created`, `alert_channel.created`, `webhook.created`, `api_key.created` / `api_key.deleted`, `stream_tokens.revoked`. Surfaced as the Audit Log section in Settings (Business+; action filter, load-more pagination, upgrade-nudge for lower tiers).

### Per-Tier Node Limits
Community: 3 nodes, Pro: 10 nodes, Team: 25 nodes (expandable), Business: 100 nodes (unlimited seats), Enterprise: unlimited. Enforced at pairing, fleet list, and SSE stream.

### Five-Tier Pricing
Community (Free) → Pro ($29/mo) → Team ($49/seat/mo) → Business ($499/mo) → Enterprise (Contact Sales). Business adds 365-day history, unlimited seats, SSO/SAML, and audit logging. Paddle billing with webhook-driven tier sync.

### Server-Side Pattern Evaluation (Phase 7)
Migrated all 18 observation patterns from client-side TypeScript to server-side Rust. Agent evaluates 17 patterns against 10-min DuckDB buffer every 10s, pushes to cloud via telemetry. Cloud evaluates `fleet_load_imbalance`. Deleted `patternEngine.ts` (2,254 lines) and `useMetricHistory.ts` (284 lines).

### Deployment Profiles
Single intent selector — `sovereign_dev`, `dedicated_server` (default), `production_fleet` — that coherently shifts the sensitivity of every local observation pattern instead of exposing per-pattern threshold knobs. Implemented as three tuning levers threaded into `evaluate_local_observations`: `density_scale` (multiplies the evidence-window density every pattern derives from `min_density_5m`/`min_density_10m`), `evidence_ratio` (the sustained-fraction gate, baseline 0.70), and `min_confidence` (a final emission filter). sovereign_dev raises all three (high bar + confidence floor for a mixed-use laptop); production_fleet lowers them (aggressive early warning); dedicated_server preserves the original baseline exactly (scale 1.0, gate 0.70, no floor). Persisted in `config.toml` as `deployment_profile`, switchable at runtime via `GET`/`PUT /api/deployment-profile` (the 10s evaluator re-reads it each tick), and selected in the localhost Settings UI. Node-local: governs which observations a node raises, not fleet-wide alert rules.

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
`computeModelFitScore()` previously used `nvidia_vram_used_mb` as a proxy for both model size *and* occupied memory. vLLM eagerly reserves ~90% of VRAM for KV cache (its `gpu_memory_utilization` default), so the proxy reflected engine reservation rather than weights — scoring nodes "Poor" for models that actually fit comfortably. New `src/utils/quantSize.ts` adds `bytesPerWeight()` + `parseQuantFromAnyModelName()` (handles GGUF tags AND full-precision tags FP8/BF16/F16) and an `estimateModelSizeGbFromName()` composer. The fit calculator now picks model size from a priority chain: ollama_model_size_gb → params×BPW from name → vram_used → system memory delta. For vLLM the "used" baseline becomes model_size + 30% (512 MB floor, matching the agent's `estimate_vram_mb()`), answering "does my model fit with room for context?" instead of "how much has the engine pre-allocated?" — llama.cpp doesn't eagerly reserve VRAM, so its measured usage is trusted directly.

### Calculation Consistency Audit (June 2026)
Full cross-stack audit of every metric formula across the frontend, localhost agent, and cloud, followed by fixes in severity order. **Critical:** the GGUF plausibility filter (`bytes_per_param_for_quant`, mirrored agent + cloud) stored bits-per-weight but multiplied them as bytes — expected sizes came out 8× too large and every correctly-sized GGUF fell below the 30% lower bound, silently emptying model discovery whenever param count + quant both parsed. **High:** cloud `cloud_fit_score` still used 10% + 256 MB working-set overhead after the agent moved to 30% + 512 MB (same model graded differently on cloud vs localhost — now locked with cross-binary contract tests); three conflicting chip-bandwidth tables consolidated into `chipBandwidth.ts` with word-boundary matching (NVML "A100-SXM4-80GB" previously resolved as an Apple M4 via the "m4" substring; "V100-SXM2" as an M2), A100/H100 split by variant, RTX 3090 Ti / Super cards / V100 / GB10 added. **Medium:** five coexisting default electricity rates (0.12/0.13/0.16) unified at $0.16/kWh across all three tiers; agent-attributed per-model WES now divided by PUE in the frontend so tables can't mix PUE-adjusted and unadjusted rows; the bandwidth-ceiling pattern's trigger now measures against the achievable ceiling (raw × 0.40 INFERENCE_EFFICIENCY) instead of the raw ceiling no real hardware can reach — the pattern was dead code. Also from the same audit: model-fit quant compression ratios were ~1.5× off vs FP16 (now derived from `bytesPerWeight()/2`), un-tagged Ollama names size as Q4_K_M instead of FP16, Quant Sweet Spot upgrades reserve 10% of capacity so a "fits" verdict can't land in the Poor band, and Context Runway works for vLLM/llama.cpp via name-based estimation. Test infrastructure added: vitest (71 frontend tests) + `#[cfg(test)]` suites in both Rust binaries (33 tests).

### CI Workflow (June 2026)
`.github/workflows/ci.yml` — on every push to main and every PR: frontend typecheck (`tsc --noEmit`) + vitest, `cargo test` in both the agent and cloud (with rust-cache), and the perplexity-baseline sync check. Previously only `release.yml` existed, so the audit's contract tests never ran automatically — both the fit-score drift and the compression-ratio drift happened while nothing watched.

### Installer Upgrade Path + Gatekeeper Fix (June 2026)
Two diagnosed-in-roadmap bugs fixed in `public/install.sh`. (1) Upgrade path: with a service-active system-path install, the installer now offers to finish the swap itself (runs `sudo ~/.wicklee/bin/wicklee --install-service`, reads consent from /dev/tty so it works under `curl | bash`), verifies the canonical binary's new version, and — when no TTY or the user declines — prints an explicit ⚠ warning that the service keeps serving the OLD binary until the command is run. Previously it silently wrote the user path and the "install succeeded" message while `localhost:7700` kept serving the old UI. (2) Gatekeeper: the `com.apple.quarantine` xattr is cleared at the download path — the single place the binary enters the system — so promotions to `/usr/local/bin` can't carry it along and get SIGKILLed ("zsh: killed"). Notarization remains the long-term fix (see Planned).

### vLLM Dtype Capture (June 2026)
vLLM's `/v1/models` and Prometheus endpoints omit the engine's runtime dtype/quantization, so Model Fit assumed FP16 for un-tagged vLLM names — up to 4× weight-size overestimate on AWQ/GPTQ deployments. The process-discovery scanner now extracts `--quantization`/`--dtype` from the vLLM command line (explicit-port main server preferred), normalizes to canonical quant tags (`awq_marlin`→AWQ, `fp8`→FP8, `half`→FP16, `--dtype auto`→nothing learned), and ships `vllm_dtype` on the wire with the three-way agent/cloud/frontend sync. Frontend gained `resolveModelSizeHints()` which keeps quant hints matched to the runtime the model name came from — previously a stale `ollama_quantization` could leak onto a vLLM model name.

### Shared Scoring Module — agent/cloud unification (June 2026)
The duplicated fit-scoring math is now a single source of truth: `shared/scoring.rs`, mirrored byte-identically into `agent/src/scoring.rs` and `cloud/src/scoring.rs` by `scripts/sync-scoring.mjs` (CI-enforced via `--check`, same pattern as `perplexity_baseline.json`). A cargo path dependency was ruled out because the cloud's Railway Docker build context is `cloud/` only. Owns `estimate_vram_mb`, `extract_params_b`, `bytes_per_param_for_quant`, `is_plausible_size_for_quant`, and the full `fit_components` curve; `score_fit` (agent) and `cloud_fit_score` (cloud) are thin wrappers. Unification surfaced and fixed two live bugs: `extract_params_b` used `find('x')` which matched the 'x' in "mi**x**tral" — Mixtral-8x7B parsed as 7B and its ~26 GB Q4 files were rejected by the plausibility filter as mislabeled; and the agent still summed thermal/WES/capacity points for models that don't fit (scores of 30–40 surviving `score > 0` filters) while the cloud had the hard gate — now both gate to 0.

### SEO for the Public Pages (June 2026)
The SPA served every route from one index.html shell with identical landing-page metadata — duplicate titles/snippets in Google, wrong social unfurls everywhere (Slack/X/LinkedIn don't run JS), an empty `<div>` for the AI crawlers robots.txt explicitly welcomes, and a robots.txt that advertised a sitemap.xml which didn't exist (the SPA fallback served HTML for it). Phase 1: per-route title/description/canonical/og:url swapping on navigation (`src/utils/pageMeta.ts`, with BlogPost resolving from frontmatter), missing `og:type`/`og:site_name`/`twitter:card`/canonical added to the shell, and a sitemap generator vite plugin (static routes + blog posts with lastmod). Phase 2: build-time static HTML via `scripts/generate-static-pages.mjs` (postbuild) — `dist/blog/{slug}/index.html`, blog listing, `/docs`, AND the landing page (`dist/index.html`), each the built SPA shell with swapped metadata, real content pre-injected into `#root`, and JSON-LD (`BlogPosting`/`TechArticle`/`SoftwareApplication`). The landing page's hero/subhead/install-command/feature-cards/section copy is injected verbatim from `LandingPage.tsx` (a later fix — the initial Phase-2 pass left the homepage's `#root` empty, serving zero content to non-JS crawlers/AI assistants/unfurlers despite correct meta; `landingBodyHtml()` must be kept in sync with `LandingPage.tsx`). nginx needed zero changes (`try_files $uri $uri/` prefers the emitted directory indexes); React takes over on load. `/metrics` deliberately excluded — nginx exact-matches it to the cloud's Prometheus scrape proxy. Deliberately NOT a framework migration: the dashboard has no SEO value; revisit Astro only if the marketing surface grows. Phase 3 closed the loop: a designed 1200×630 `public/og-image.png` (brand palette, hero line, WES tagline — regenerate via `scripts/gen-og-image.mjs`, sharp-rendered SVG, PNG committed so builds never need sharp) wired as `og:image`/`twitter:image` in the shell + `pageMeta.ts`, with `twitter:card` upgraded to `summary_large_image`. One site-wide card by design; per-post cards are a possible later nicety.

---

## Planned

### ★ Business & Enterprise Readiness Program (July 2026 strategic review)
The July 2026 Teams/Enterprise review found the Team tier strong and differentiated, but the Business/Enterprise story thin where enterprise buyers screen. This program is the ship-order plan. Each item carries implementation pointers + acceptance criteria so any session can pick one up cold. Work items sequentially within a phase; phases 1→5 are priority order.

**Phase 1 — Close the trust gap (blocks deals today)**

1. **RBAC: Admin / Member / Viewer (v1 SHIPPED — backend enforcement).** `validate_clerk_jwt` now returns the org role (handles v1 `org_role` and v2 nested `o.rol` claim shapes); `OrgRole` enum (Admin/Member/Viewer, solo = Admin over own resources, unknown custom roles → Member never Admin) + `require_user_org_role()` with `require_user_and_org`/`require_user_info` as wrappers (zero churn at ~28 read call sites). Enforced at 15 mutating handlers: Viewer → 403 on all mutations (update node, channel/rule create+delete+test, webhook create/delete/test, ack/resolve/submit observations, OTel PUT, pair/activate); node removal is Admin-only. `stream_tokens.revoked` stays self-scoped (users revoke their own). Unit-tested (role parsing incl. prefix variants, policy table; 17 cloud tests green). **Remaining follow-ups:** role-aware UI hiding (Clerk `useOrganization` exposes the role client-side — hide destructive buttons for viewers); audit `access.denied` events; org-key minting gated to Admin when item 4 lands.
2. **SSO/SAML (Business+) — ship it or stop advertising it.** Currently a claim on PricingPage/llms.txt with ZERO implementation. Clerk supports per-org SAML/OIDC (Enhanced Auth add-on) — the code-side work is small (org SSO enablement indicator + docs + an Enterprise setup guide); the real work is Clerk dashboard config, which needs the owner's Clerk account. Product decision recorded: either enable via Clerk and document the setup flow, or soften the pricing copy to "SSO/SAML (via Clerk, on request)" until enabled. A session without Clerk dashboard access should do the docs + copy honesty fix and leave enablement to the owner.
3. **Audit log export + SIEM streaming (SHIPPED).** `GET /api/audit-log/export?format=csv|json&action=&from=&to=` — full-history download, chronological, 100k-row cap, `Content-Disposition` attachment; CSV via a new `csv_escape` helper (RFC-4180 + formula-injection hardening, unit-tested — also the reusable fix for the June review's open CSV-escaping MEDIUM on the fleet export). SIEM drain: one per tenant in `audit_drains` (owner user_id + org_id stored for tier re-resolution), `GET/PUT/DELETE /api/audit-log/drain` (PUT/DELETE Admin-only via RBAC; secret returned once, re-PUT rotates + re-enables; cursor starts at current max audit id — export covers backfill). `audit_drain_task` ships ≤500-event HMAC-signed JSON batches every 60s via the existing `deliver_webhook`, re-checks tier at delivery, auto-disables after 20 consecutive failures. Exports and drain config changes are themselves audited (`audit_log.exported`, `audit_drain.created/deleted`). Settings UI: CSV/JSON export buttons + drain panel (status, failures, reveal-once secret). Retention documented: ≥365d Business, unlimited Enterprise. **Follow-up:** automated retention purge enforcement (delete non-Enterprise rows past retention) — documented policy only for now.
4. **Org-wide API keys (SHIPPED).** `api_keys.org_id` (NULL = personal). `validate_api_key` returns `(key_id, user_id, org_id, tier)` — tier now resolved via `resolve_tier` (org subscription for org keys; replaces the legacy `users.is_pro` rate-limit flag). All 7 API-key-authed sites (`/api/v1/fleet`, `fleet/wes`, `nodes/{id}`, `route/best`, `insights/latest`, `models/discover`, Prometheus `/metrics`) switched from `WHERE user_id` to `tenant_scope` — an org key sees the org fleet. Minting org keys: `POST /api/v1/keys` with `scope:"org"`, requires active org + Admin (RBAC); revoking org keys: any Admin of the key's org; list shows personal + active-org keys with scope. Key lifecycle audited with scope. Drive-by fix: the Prometheus tier gate was `!= "team" && != "enterprise"`, wrongly locking **Business** out — now `is_team_or_above`. Frontend: scope picker in the create-key modal + Org badge in the key list. **Phase 1 is now complete except SSO (item 2, parked for owner's Clerk time).**

**Phase 2 — Reliability maturity (become the pager for AI infra)**

5. **SLOs with error budgets (v1 SHIPPED).** Time-slice SLOs over sampled cloud telemetry: `slo_definitions` + `slo_windows` (one verdict per 5-min bucket, so 30-day compliance survives metrics_raw's 24h retention). Three v1 SLIs from `metrics_raw` via `percentile_cont`, filtered to active-inference samples: `ttft_p95_ms` (≤ threshold), `tok_s_p50` (≥), `wes_p50` (≥) — idle windows return NULL and don't count against the budget. Scope: fleet / tag / node (tag matching reuses the item-6 predicate). `slo_evaluator_task` (5-min loop) writes verdicts idempotently (ON CONFLICT DO NOTHING), re-checks tier, computes rolling-30d burn, and fires `slo_budget_burn` to the creator's channels once per 50/90/100% crossing (`last_burn_notified` latch, resets when burn recovers <25% as bad slices age out). CRUD `POST/GET/DELETE /api/slo` (Team+, Member+ RBAC, ≤20/fleet, audited); GET returns live compliance/burn/latest-window per SLO. Settings → SLOs section: create form, compliance %, budget-burn bar, latest window. Unit tests: SLI direction table + metric/SQL registry. **Follow-ups:** the monthly SLO report (email + endpoint — needs a month-boundary reporter task); per-request-trace SLIs once Fleet SLA Aggregation (below) ships trace shipping; dashboard SLO cards outside Settings.
6. **Environments & tag-based scoping (v1 SHIPPED).** Tags are now first-class: editable in Settings → Node Configuration (new Tags column, PATCH-synced like display names — previously NO UI could set them at all); carried on every fleet SSE frame (the display-name cache became a `node_meta` cache with tags, patched into `metrics.tags` by FleetStreamContext); and scoping **alert rules** + **threshold webhooks** via a nullable `tag` column matched case/space-insensitively against comma-separated `nodes.tags` in the evaluator queries (validated by `valid_scope_tag` — comma/wildcard-free charset so the LIKE match can't be gamed; unit-tested). Convention documented: `env:` prefix for environments. Tag inputs added to the alert-rule and webhook forms. **Follow-ups (deferred, not silent):** tag-filter chips on the Overview fleet table (tags already arrive client-side via the stream), `?tag=` filters on the V1 fleet/rollup endpoints, and the tag dimension on cost/WES rollups — these unlock when SLOs (item 5) consume tags next.
7. **Alert silences + maintenance windows (SHIPPED); escalation policies remain.** `alert_silences` table (tenant-scoped — org members share; `starts_at` in the future = scheduled maintenance window). Suppression is enforced as `NOT EXISTS` predicates inside BOTH evaluator queries on the telemetry hot path (`evaluate_alerts` resolves the node's tenant via `COALESCE(org_id, user_id)`; `evaluate_webhooks` is already tenant-keyed) — silenced conditions never fire, nothing to dedupe. A silence targets any combination of node / tag / event type (NULL = all; vocabulary = union of rule + webhook event types, `SILENCEABLE_EVENTS`). CRUD: `POST/GET/DELETE /api/alerts/silences` (Pro+, Member+ via RBAC, duration 1min–30d, reason ≤200 chars, tag validated by `valid_scope_tag`); create/delete audited. Settings → Alerts gained a Silences block (create form with duration presets + optional future start via datetime-local, active/scheduled badges, end-early). **Remaining from this item:** multi-step escalation policies (notify channel A, unacked after N min → channel B) — needs an ack model first, so it slots naturally after SLOs. Also noted: the fleet-alert evaluator + node-offline notification paths don't yet honor silences (custom rules + webhooks do) — fold in when escalation lands.
8. **Fleet config management (v1 SHIPPED).** `nodes.desired_profile` (NULL = agent keeps local choice). Delivery rides the existing telemetry exchange with zero new connections: `handle_telemetry`'s auth query also fetches the desired profile and the response (now 200+JSON, was 204 — old agents check only `is_success()` and ignore bodies) carries `{desired_profile}`; the agent's `cloud_push` applies it within one 2s push cycle (shared `Arc<Mutex<DeploymentProfile>>` — the 10s evaluator re-reads it — plus `update_config` persistence) and injects its ACTUAL `deployment_profile` into every outgoing frame (cloud `MetricsPayload` + frontend `SentinelMetrics` carry it), so the dashboard shows truth vs intent. Setting: per-node via `PATCH /api/nodes/:id` `{desired_profile}` (Pro+, validated, audited in `node.updated`) — surfaced as a Profile select column in Settings → Node Configuration; bulk-by-tag via `POST /api/fleet/config` `{tag, desired_profile}` (Team+, Member+ RBAC, tag-predicate UPDATE, returns `nodes_affected`, audited `fleet_config.applied`). **Follow-ups:** an intent-vs-actual drift indicator in the fleet view (both sides are now on the wire); agent remote-upgrade rings on the same delivery channel.

**Phase 3 — Cost governance (the CFO wedge; only Wicklee has watts AND tokens)**

9. **Showback/chargeback reports (v1 SHIPPED).** `GET /api/v1/fleet/chargeback?days=1..90&kwh_rate=` (Team+, JWT) — cost + token attribution by team tag / model / node + daily trend, from a shared base CTE (5-min rollup UNION raw trailing-day tail; energy conventions identical to cost-by-model: 30s cadence, watts × hours ÷ 1000). Tokens estimated from sampled throughput (tok/s × covered seconds — proxy-trace exact counts are a follow-up when trace shipping lands); `usd_per_mtok` is the headline metric. Tag groupings overlap by design (multi-tag nodes count under each; documented as showback, not double-billing; untagged → `(untagged)`). `&format=csv&group=tag|model|node|daily` = finance CSV via `csv_escape`, audited `chargeback.exported`. UI: Chargeback & Showback card on Insights → Performance (window picker 7/30/90d, grouping tabs, totals strip with $/1M-tok headline, CSV button, Team-gate upsell). **Follow-ups:** per-request token counts once traces ship; budgets with alerts (natural extension of the SLO burn machinery); monthly email — shared with item 10's digest.
10. **Idle-waste & right-sizing report.** Fleet rollup of phantom-load cost + quant-advisor savings: "fleet burned $X idle last 30d; these N changes recover $Y" with per-node actions (unload idle model, quant swap, consolidate). Weekly email digest (Resend is already wired for alerts). This makes Wicklee unremovable — removing it makes waste invisible again.
11. **Capacity planner with procurement scenarios** (sharpens the existing "Fleet Capacity Planner" entry below): "reach 200 tok/s sustained: 2×4090 vs 1×H100" priced from the fleet's own measured WES, not vendor benchmarks.

**Phase 4 — Enterprise deployment surface**

12. **Self-hosted control plane (Enterprise).** The cloud is one Rust binary + Postgres. Package as Docker Compose/Helm with license key; document Clerk-or-DIY-auth choice (legacy DIY session path still exists in `require_user_and_org`). Completes the "sovereign" brand honestly — the answer for buyers who won't ship telemetry to wicklee.dev.
13. **Kubernetes operator + Helm** (existing entry below — becomes Phase 4).
14. **Grafana datasource plugin + prebuilt dashboards; Terraform provider.** Meet platform teams inside tools they already defend budget for. Prometheus scrape + OTel export already exist — the plugin/dashboards are packaging, not new telemetry.

**Phase 5 — AI-native moats**

15. **Model governance.** Allowed-model registry per org; alert (or webhook) when an unapproved model appears on a tagged-prod node. The `model.changed` edge detection already exists in the webhook-subscription evaluator — this adds a policy table + a check in the same path. Compliance wedge for regulated industries.
16. **Governed agentic operations.** MCP tools that ACT (drain node, unload idle model, swap quant) behind RBAC approval, every action audit-logged. Builds directly on Phase 1 RBAC + audit; first governed write surface for AI-agent-driven infra ops.

**Packaging target once Phases 1–3 land:** Business = SSO + RBAC + audit export + org keys + SLO reports + cost governance (justifies $499). Enterprise = + self-hosted control plane + SCIM + custom SLA.

### ★ GTM & Distribution Features (July 2026 — see docs/GTM.md)
Features whose primary value is distribution and enterprise awareness, identified by the GTM review. Each is a product item that doubles as a channel:

1. **Demo fleet mode (BUILT — deploy pending).** `npm run build:demo` → static `dist-demo/` bundle: the full cloud dashboard against a six-node synthetic fleet (deterministic seeded generator, scripted thermal-throttle / model-swap / node-offline stories) with no Clerk and no backend — a fake EventSource drives the production FleetStreamContext, and a fetch shim serves fixtures for every /api/* panel (writes → friendly read-only 403). Verified headlessly with Playwright (banner, nodes, models, zero page errors). See `docs/DEMO.md` for the demo.wicklee.dev + HF Space deploy steps (founder: DNS + HF account). Rock-2 checklist item.
2. **WES Leaderboard as GTM engine** (elevates the existing "WES Leaderboard (Public)" entry below): opt-in anonymous agent submissions (chip, model, quant, tok/s, watts, WES — nothing else; consistent with sovereignty), public programmatic pages per chip×model combo ("RTX 4090 · Llama 3.1 70B — measured tok/s, watts, $/1M tok") ending in the install one-liner, and the quarterly "State of Local Inference Efficiency" report from the corpus. Prerender machinery from the SEO pass is reusable.
3. **Hardware-fit badge** — a tiny generator (SVG badge + link to wicklee.dev/fit/<model_id>) model authors paste into HF model cards / GitHub READMEs; the landing page runs the existing fit-check against the visitor's declared hardware. Every badge is a permanent inbound link on a high-intent page.
4. **MSP / multi-org console (Business+)** — one login managing many client orgs (Clerk supports multi-org membership; needs an org-switcher rollup view + per-org billing attribution). Five MSP partners ≈ fifty enterprise deployments; this is the partnerships wedge.
5. **Read-only fleet share links** — expiring, revocable, view-only dashboard URLs (a scoped stream token variant + a viewer route). "Look at our fleet" in a Slack channel is the viral loop.
6. **FOCUS-format chargeback export** — the chargeback endpoint gains `format=focus` emitting the FinOps Foundation's open billing spec. Cheap (one serializer over the existing report) and it's the credential for FinOps X / OpenCost ecosystem listing.

### ★ GTM Execution Tracker (non-code workstreams — see docs/GTM.md for strategy)
Trackable checklist for the marketing motions. Check items off as they land; each is durable (stays live once done). Items marked **[draftable]** can be prepared by a coding session (copy, PR text, listing metadata, page builds) with only the final submit needing the founder's accounts.

**Rock 1 — Registry & ecosystem blitz**
- [ ] MCP registry listings: Anthropic servers repo PR, mcp.so, Smithery, Glama **[draftable]**
- [ ] awesome-list PRs: awesome-selfhosted, awesome-llmops, awesome-mcp, awesome-local-llm **[draftable]**
- [ ] Ollama community-integrations PR **[draftable]**
- [ ] vLLM ecosystem docs PR **[draftable]**
- [ ] llama.cpp ecosystem/README listing PR **[draftable]**
- [ ] Homebrew cask (`brew install --cask wicklee`) **[draftable — formula is code]**

**Rock 2 — Hugging Face presence**
- [x] Demo fleet build shipped (`npm run build:demo`, docs/DEMO.md) — Space upload + demo.wicklee.dev DNS remain (founder)
- [ ] WES benchmark HF Dataset (initial seed from own nodes; grows with leaderboard opt-ins) **[draftable]**
- [ ] Hardware-fit badge generator + docs page (roadmap item 3 above) **[draftable]**

**Rock 3 — Leaderboard SEO engine**
- [ ] Opt-in anonymous benchmark submission in the agent (roadmap item 2 above)
- [ ] Programmatic chip×model pages + sitemap wiring **[draftable — prerender machinery exists]**
- [ ] Leaderboard landing + methodology page (credibility requires showing the measurement method) **[draftable]**

**Rock 4 — Launch moments**
- [ ] r/LocalLLaMA data post #1 (measured thermal/efficiency data across own fleet) **[draftable]**
- [ ] Show HN: demo Space as the hook (save HN for this — features go to Reddit)
- [ ] One blog data-post per shipped feature (rolling)

**Rock 5 — Partnerships**
- [ ] Partner one-pager: "bundle Wicklee with every box you sell" (hardware vendors/SIs) **[draftable]**
- [ ] MSP pitch + multi-org console spec (roadmap item 4 above) **[draftable]**
- [ ] Outreach list: 3 MSPs + 2 hardware vendors (founder — needs the human)
- [ ] Design-partner program page: free Business year ↔ logo + case study **[draftable]**

**Rock 6 — Enterprise credibility**
- [ ] Trust page on wicklee.dev (data-flow diagram, sovereignty story, RBAC/audit/SIEM) **[draftable — security write-ups are 80% of the copy]**
- [ ] FOCUS-format chargeback export (roadmap item 6 above) + OpenCost/FinOps ecosystem listing
- [ ] Quarterly "State of Local Inference Efficiency" report #1 **[draftable once leaderboard data exists]**
- [ ] Clerk / Railway / Ollama showcase submissions **[draftable]**

**North star:** weekly paired-node activations. Review this tracker monthly; a motion that shipped gets its date noted, a motion skipped two months running gets deleted (the list must stay honest).

### Security Review — Required Follow-ups (from June 2026 Pass 1 & 2)
Carried over from the cloud auth/tenancy review (Pass 1, shipped) and the agent concurrency review (Pass 2, partially shipped). These are the remaining **required** hardening items, in priority order:

1. **Agent task supervision (Pass 2, HIGH — SHIPPED).** Fire-and-forget `tokio::spawn` loops swallowed panics, so a dead subsystem left the agent running but silent. `agent/src/supervisor.rs` provides `supervise(name, factory)` (restart on panic/return, exponential backoff 1s→30s with reset after a 60s healthy run) and `supervise_until(name, factory)` (future returns `ControlFlow`; `Break` = deliberate permanent stop, not restarted). All four critical loops are now supervised: the metrics broadcast loop (`supervise`), and the Ollama / vLLM / llama.cpp harvester main loops + `cloud_push` (`supervise_until`, with their terminal exits — `port_rx.changed()` watch-close and 410-Gone — returning `Break` so shutdown doesn't restart-spin). Each wrap uses a compiler-checked clone-per-restart prelude with the body unchanged. Unit-tested (restart-on-panic, restart-on-return, no-restart-on-Break). Remaining nicety: the harvester *probe* sub-tasks (idle baseline measurement) are non-critical and still unsupervised — low priority.
2. **Crash-safety + cancellation polish (Pass 2, MEDIUM).** Graceful shutdown via `tokio_util::sync::CancellationToken` so background tasks aren't force-killed mid-write; bound the proxy `per_model` HashMap with a periodic prune independent of `/api/ps` success; consider a poison-tolerant lock helper for the hottest shared state once the supervisor reduces panic frequency.
3. **Org-wide API keys (Pass 1 deferral — SHIPPED via the Readiness Program, Phase 1 item 4).** `api_keys.org_id` added; `validate_api_key` and all 7 key-authed endpoints now scope via `tenant_scope`; org keys are minted/revoked by org Admins (RBAC) and inherit the org tier. Personal keys unchanged.
4. **Pass 3 — frontend state correctness (SHIPPED, core items).** Surveyed React state/effects/async lifecycle. Fixed: a React `ErrorBoundary` wrapping both render paths (the app had none — any uncaught render throw blanked the whole dashboard); SSE reconnect on org switch (`orgId` was missing from the connect-effect deps, so switching org kept the previous org's stream); AbortController on the MetricsHistoryChart/WESHistoryChart fetches (rapid range switches could let a stale earlier response overwrite newer data); stable React key on the cost-by-model table. Verified clean: the SSE lifecycle (cancelled guard, retry, EventSource closed on unmount, JSON.parse in try/catch) and the rolling smoothing store (correctly keyed/pruned per node). **Remaining (low priority):** fixed 5s SSE retry → exponential backoff; the broader untyped-React gap below.
5. **Frontend has no React type declarations (surfaced by Pass 3, MEDIUM).** The project ships no `@types/react` and React resolves as implicit `any`, so the entire frontend's type-safety is illusory — `tsc` can't catch prop/hook/return-type mistakes across any component. The whole app compiles only because React is untyped. Adding `@types/react` + `@types/react-dom` is a dedicated cleanup with real blast radius (it will surface latent type errors app-wide that must each be triaged), so scope it deliberately — not a drive-by. Until then, class components need member `declare`s (see `ErrorBoundary.tsx`).

Pre-existing-population note from Pass 1: nodes paired before the 64-bit node-ID change keep their legacy 16-bit `WK-XXXX` ids (and their collision/enumeration exposure) until they re-pair; the risk decays as new installs dominate. A forced re-pair migration was judged too disruptive.

### Full-Codebase Review — remaining MEDIUMs (June 2026; HIGHs all shipped)
The mid-June four-surface review's HIGHs landed in five merged chunks (pairing hijack, Prometheus auth, org-tenancy sweep, agent races, frontend HIGHs, dead-code pass — see progress.md). Remaining verified MEDIUMs, roughly by value:
1. **Cloud calculation fixes — SHIPPED** (wes_for_payload Apple SoC power, rollup straddling-bucket loss, the 24h hole in 7d+ charts, qf² in variant selection, plus the WES-drift evaluator that could never fire — its recent-24h window read metrics_5min, which never contains the last 24h). Still open from this group: OTel `export_interval_s` stored but ignored (fixed 30s tick).
2. **Cloud perf/hardening**: N+1 per-node aggregation loops in wes-history / metrics-history / fleet-duty (single GROUP BY query instead); `auth_rate_limits` IP keys never evicted (slow leak; also trusts spoofable XFF); `/api/agent/version` hits the GitHub API uncached per request (60/hr anonymous limit — cache ~10 min); CSV export escaping (newlines/quotes/formula injection); signup runs bcrypt before the duplicate-email check (timing oracle + wasted work); duplicate `MAX_FREE_NODES`/`FREE_NODE_LIMIT` constants and the thrice-copied tier-limit ladder (`node_limit_for_tier()`); node session-token compare not constant-time (main.rs ~2294).
3. **Agent**: Apple Silicon power double-counted in all DuckDB cost/WES queries (`Sample.gpu_power_w` holds SoC total, consumers add `cpu_power_w` on top; CPU-only Linux nodes get NULL → $0 cost) — fix at `BroadcastFrame::into_sample` with a canonical `total_power_w`; `/api/model-candidates` runs the "24h background" catalog refresh inline on the request path (first request of the day hangs minutes — spawn the documented background task); `[pm_raw]` debug dump on every powermetrics cycle into unrotated `/var/log/wicklee.log` + missing `MissedTickBehavior::Skip` makes powermetrics sample continuously; Windows blocking `wmic` in async loops every 2s (tokio::process + cache the failure); `sc create` binPath unquoted (classic unquoted-service-path; the validator defers to "quoting at the call site" that doesn't exist); Pattern P slope ×6 vs the correct ×60 on 1Hz data (fires ~10× late; Pattern R is correct); audit-export dismissals ignore the date window; CSV `model` column unescaped (client-controlled via proxy).
4. **Frontend**: `allNodeMetrics`/`lastSeenMsMap` never drop removed nodes (ghost data; defeats `pruneBuffers`); `useFleetCounts` hardcodes `status: 'online'` (counts are fiction — derive from `last_seen_ms`); `useFleetDuty` hardcodes `https://wicklee.dev` bypassing `cloudUrl.ts` (check if the hook is even still consumed after the Overview duty removal); audio regex `/\bsts?\b/` matches `st`/`sts` not `tts`/`stt` (modelCategory.ts); benchmark reports use `ollama_quantization` for vLLM runs and compute WES without PUE; `useInsightDismiss` state stales on key change; FleetModelDiscovery/ModelDiscoveryCard ~600-line copy-paste twins (already drifting) + the duplicated Active-Models VRAM panel inside Overview; the 1Hz Overview chart re-renders up to 3600 recharts points per SSE frame (downsample); `useSettings` runs side effects inside state updaters (StrictMode double-fire); `userApiKey` naming actually holds an Ollama base URL (SecurityView); index keys on shifting alert/violation lists; `efficiency.ts` doc comment teaches the wrong WES formula above a correct tooltip; two same-named `quantFamily()` functions with different semantics (rename one `quantSpeedBucket`).

### Apple Developer ID signing + notarization
The June 2026 installer fixes cleared the `com.apple.quarantine` xattr at download time (covering every later promotion path) and made install.sh finish service upgrades itself — when a TTY is available it offers to run `sudo ~/.wicklee/bin/wicklee --install-service` on the spot, and when not, it prints an explicit warning that the service keeps running the OLD binary until the command is run. The remaining long-term item is proper Developer ID code-signing + notarization in the release workflow ($99/yr + one-time CI setup); once notarized, the quarantine flag is benign and the xattr workaround can go.

### Catalog cache sync between agent and cloud (Bug 2 from Discovery audit)
Each backend pulls "top GGUF by HuggingFace downloads" on its own 24h cadence — agent caches into DuckDB, cloud into Postgres. The snapshots drift: as of audit, cloud showed 84 total models, localhost 46, with different model sets in each. Two reasonable resolutions: (A) the cloud becomes the single source of truth for the trending list; the agent's `/api/model-candidates` proxies the cloud catalog when paired (graceful fallback to local cache when unpaired or cloud unreachable). (B) Both keep separate caches but the response carries the cache age + size so the frontend can surface "your localhost catalog is 6 hours older than the fleet's — refresh available." Option B is lower effort and more honest about the dual-cache reality; option A is the long-term right call once the cloud's catalog refresh is fast enough that agents can rely on it.

### Subscription Tier Gating on Fleet Model Endpoints
The three new cloud endpoints shipped with the Models tab — `/api/v1/fleet/model-comparison`, `/api/v1/fleet/model-switches`, `/api/v1/fleet/cost-by-model` — are Bearer-auth-gated but not tier-gated. Any signed-in user gets the same 168-hour ceiling on the `hours` parameter regardless of plan. Intent per pricing: Community 24h, Pro 7d (168h), Team 90d, Business 365d. Implementation: extract `subscription_tier` from the user record at the handler, clamp `hours` against a per-tier max, and return a `tier_limit_hit` flag in the response envelope so the frontend can surface an upgrade nudge when a request was truncated. Low priority — small user base today, simple fix when revenue justifies it.

### Fleet SLA Aggregation (Pro/Team)
`GET /api/v1/fleet/sla` — fleet-wide aggregation of the per-node SLA Monitor. Cloud backend pulls each node's `inference_traces` via the existing telemetry path and computes fleet-wide p95/p99 across all requests, plus a per-node breakdown ranked by p95 TTFT. Surfaces on `wicklee.dev` as the fleet-level companion to the Performance tab's SLA Monitor card. Pro for single-node SLA on the cloud dashboard; Team for the fleet roll-up + cross-node compliance reporting.

### vLLM Native Histogram Source
Read percentiles directly from vLLM's Prometheus `/metrics` endpoint (`vllm_request_latency_seconds_bucket`, `vllm_time_to_first_token_seconds_bucket`) instead of relying on the Ollama proxy's per-request traces. Lets users running vLLM directly (no proxy) get accurate p95/p99 SLA data without enabling proxy mode. The SLA endpoint chooses source per-runtime: proxy traces for Ollama, native histograms for vLLM, both for mixed deployments.

### vLLM Exact GQA Architecture (HF config.json)
Stage 1 (shipped) captures `max_model_len` from vLLM's `/v1/models`, but exact `num_hidden_layers` / `num_key_value_heads` / `hidden_size` / `num_attention_heads` for the GQA-aware Context Runway require fetching the model's `config.json` from HuggingFace. To avoid adding a network dependency to the agent (sovereign / air-gapped deploys), Stage 2 will mediate this through the cloud: a new `/api/v1/model-arch?model_id=` endpoint proxies HF and caches in Postgres. Frontend prefers cloud-resolved arch when the node is paired; localhost-only nodes continue using the ±30% name-based estimate.

### Model-Hardware Fit Score
"Is this model right for this hardware?" Auto-computed from VRAM headroom, tok/s vs model size ratio, thermal behavior under load, swap pressure. Returns score + recommendation (e.g., "62/100 — VRAM tight, consider Q3_K_M or smaller variant").

### Fleet Capacity Planner
"Your 3-node fleet sustains 45 tok/s at current thermal conditions. Adding one M4 Pro would add ~15 tok/s at $0.04/day." Uses real WES data from fleet to project capacity and cost of scaling.

### Cross-Node Model Migration
"Llama 3.1 70B on WK-A1B2 has WES 8.2, VRAM at 89%. WK-C3D4 has WES 12.1, VRAM at 52%. Recommend migrating for 47% efficiency gain." Fleet-wide model placement optimization based on measured performance.

### Kubernetes Operator
Helm chart and operator for automated Wicklee agent deployment across GPU node pools.

### Install Telemetry
Anonymous install event tracking (OS, arch, version) via fire-and-forget ping from `install.sh` to cloud endpoint. Powers activation funnel metrics without collecting PII.


### WES Leaderboard (Public)
Anonymous hardware benchmark submissions with public ranking. "MPG for AI" — compare tok/W across hardware configurations. Public read API + submission endpoint.

---

## Contributing

Issues and PRs welcome. See the [README](../README.md) for build instructions.
