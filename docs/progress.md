# Wicklee — Progress Journal

*A running log of what shipped, what was learned, and what's next. Most recent entry first.*

> **Canonical references:** `docs/ROADMAP.md` (product roadmap, phases, tier structure) · `docs/progress.md` (this file — engineering journal, most-recent-first)

---

## May 21, 2026 — v0.8.0: No-Sudo Install Flow

### Why
`curl | bash` previously prompted for sudo on every fresh install — required to drop the binary in `/usr/local/bin` and register the service in one shot. That made the no-friction first-touch story ("just paste this") feel heavier than it had to. Many evaluators want to *try* the agent before granting root.

### What changed
- **Two-step model.** `install.sh` now installs to `~/.wicklee/bin/wicklee` with **no sudo**. The only sudo step is `sudo wicklee --install-service`, which the user runs themselves when they're ready to run on every boot.
- **Self-promoting service installer.** `agent/src/service.rs::install_service()` detects when it's invoked from a non-canonical path (e.g. `~/.wicklee/bin/wicklee`), stops any running service, copies the binary to `/usr/local/bin/wicklee`, and registers the LaunchDaemon / systemd unit against that canonical path. No manual move required.
- **Single upgrade path.** If `/usr/local/bin/wicklee` already exists, `install.sh` detects it, reports the version + service state, and points to `sudo /usr/local/bin/wicklee --install-service` as the only upgrade command. No alternative offered — power users who want a parallel install can handle it themselves.
- **install.sh ghost-kill block removed.** The `--install-service` path now handles stopping/restarting on upgrade.
- **Windows untouched.** `install.ps1` still installs to Program Files. The two-step model only applies to Unix.

### Files
- `agent/src/service.rs` — `install_service()` self-copy block, `CANONICAL_BIN = "/usr/local/bin/wicklee"`.
- `public/install.sh` — full rewrite. No sudo on fresh path; upgrade path detects and instructs only.
- `agent/Cargo.toml` — bumped to 0.8.0.

---

## April 13-14, 2026 — v0.7.14: Multi-Model Monitoring, Model Discovery, Install Telemetry, Billing Pipeline

### Multi-Model Concurrent Tracking
- **Per-model proxy accumulators** — `ProxyState` now uses `Mutex<HashMap<String, ModelStats>>` instead of global atomics. Each model's tok/s, TTFT, latency, and request count tracked independently.
- **Harvester reads all models** — `/api/ps` iteration replaces `.first()`. Merges proxy per-model stats with Ollama VRAM/size/quantization data. Stale entries cleaned up when models are unloaded.
- **`active_models` on MetricsPayload** — new array field (three-way sync: agent, cloud, frontend). Only emitted when 2+ models loaded. Singular fields preserved for backwards compat (populated from most-recently-active model).
- **Per-model WES** — `tok/s ÷ (proportional_watts × thermal_penalty)` using VRAM share for power attribution. Computed in broadcast loop where power + thermal data are available.
- **VRAM budget visualization** — color-coded stacked bar showing each model's GPU memory allocation vs total budget (Apple unified memory or NVIDIA VRAM). Legend with model names.
- **Model switching cost** — `GET /api/model-switches?hours=24` detects model transitions via DuckDB `LAG()` window function. Returns each swap with from/to model, timestamp, and idle gap. Summary: total swaps + total gap minutes.
- **Per-model routing** — `GET /api/v1/route/best?model=qwen2.5:7b` filters to nodes with the target model loaded, uses per-model tok/s and WES from `active_models` array.
- **Frontend** — multi-model panel on localhost diagnostic rail + fleet expanded detail rows. Shows per-model tok/s, WES (color-coded), VRAM, and request count.
- **Landing page** — "Every model. Tracked independently." section with 6-card feature grid.
- **Docs** — new Multi-Model Monitoring section in DocsPage, docs.md, and llms.txt.

### Model Discovery & Hardware Fit Score
- **HuggingFace GGUF catalog** — agent fetches top 50 GGUF repos by downloads, parses `siblings[]` for `.gguf` files, extracts quant level from filename. Cached to DuckDB `model_catalog` table with 24h TTL.
- **Fit score algorithm** — pure function scoring model variants against hardware: VRAM headroom (40pts) + thermal margin (20pts) + historical WES (20pts) + power efficiency (20pts). Labels: Excellent/Good/Tight/Won't Fit.
- **`GET /api/model-candidates`** — localhost endpoint, all tiers. Returns scored models with per-variant fit score, VRAM headroom %, and human-readable recommendation. Includes live hardware profile.
- **Cloud `GET /api/v1/models/discover`** — three modes:
  - Browse: catalog search with fit scores (all tiers)
  - Simulate: `?simulate_hw=nvidia_4090` — 12 predefined profiles M4 through H100, or custom VRAM/power (Pro+)
  - Fleet match: `?fleet=true&model_id=X` — which fleet nodes can run this model, scored per node (Team+)
- **Frontend: ModelDiscoveryCard** — expandable card in AI Insights tab with search, hardware summary, color-coded fit scores, per-variant quant breakdown, and recommendations.
- **Landing page** — "Every model. Tracked independently." section with 6-card feature grid.

### Install Telemetry & Event Pipeline
- `POST /api/telemetry/install` — anonymous install ping from `install.sh` (OS, arch, version, nvidia, upgrade). Persisted to `installs` Postgres table. No auth, no PII.
- `install.sh` updated with fire-and-forget curl (backgrounded, non-blocking, silent on failure).
- `GET /api/events/poll?since_ms=N` — authenticated event polling endpoint for Taarn consumption. Returns install, pairing, and subscription events since cursor. Bearer auth via `TAARN_EVENT_SECRET`.
- Taarn webhook forwarder (`forward_to_taarn`) — fire-and-forget POST to `TAARN_WEBHOOK_URL` on install, pairing, subscription activate/cancel. Silently skipped when env vars unset.

### Billing Pipeline — End-to-End
- **Clerk tier sync** — Paddle webhook now calls Clerk Backend API (`PATCH /v1/users/{clerk_id}/metadata`) to set `publicMetadata.tier` after every subscription change. Frontend reads tier from Clerk; the missing bridge between Paddle and the UI.
- **Profile badge** — Sidebar avatar menu reads `currentUser.tier` via `TIER_BADGE` instead of hardcoded "Free Plan".
- **Email alerts** — Resend API integration with branded HTML template (dark theme, structured card layout, human-readable pattern names). Domain verified at `wicklee.dev`.
- **Slack alerts** — verified working end-to-end via test channel.
- **Pricing page refinements** — Community: "Unlimited nodes locally · 3 synced to fleet". Pro: "Slack or Email Alerts (1 channel)". Team: "Coming Soon" (disabled). Enterprise: positioning preamble.

### Documentation Accuracy
- WebSocket cadence corrected from 10 Hz → 1 Hz across 9 files (was stale from pre-v0.5.22 throttle)
- New "Data Flow & Transport" section in DocsPage documenting all 6 telemetry paths with ASCII diagram
- Cloud MCP tool count updated from 6 → 8 (added `get_inference_profile`, `explain_slowdown`)
- Fleet alerts updated from 5 → 6 (added `fleet_load_imbalance`)

---

## April 11, 2026 — v0.7.13: Five-Tier Pricing, Business Tier

### Five-Tier Pricing Revision
- **Pro** $9 → $29/mo, **Team** $19 → $49/seat/mo (prices aligned to value delivered)
- **Business tier added** ($499/mo): 100 nodes, unlimited seats, SSO/SAML, audit logging, 365-day metric history, priority support
- **Enterprise** simplified to "Contact Sales" (removed $200/mo floor)
- `SubscriptionTier` union type updated across 12 files (types.ts, PricingPage, TracesView, usePermissions, 3 Insights card components, DocsPage, docs.md, llms.txt, cloud/src/main.rs)

### Business Tier — Cloud Backend
- `MAX_BUSINESS_NODES = 100`, `is_business_or_above()` helper
- All node limit checks updated (pairing, fleet list, SSE stream)
- Paddle webhook maps `PADDLE_BUSINESS_PRICE_ID`
- `metrics_5min` retention extended from 90 → 365 days (TimescaleDB policy + nightly fallback DELETE)

### Business Tier — Frontend
- Business banner card on pricing page (teal accent, between grid and Enterprise)
- "Unlimited Seats · Up to 100 Nodes" as primary value prop
- 365-day history in `usePermissions.ts` (`historyDays: 365`)
- `isBusinessOrAbove` convenience boolean for tier gating
- Enterprise positioning preamble: "For regulated, sovereign, and air-gapped deployments"

### Documentation
- Pricing tables updated in DocsPage.tsx, docs.md, llms.txt (5 tiers, all features)
- Roadmap updated with Business tier, install telemetry, audit logging, WES leaderboard planned items

---

## April 7, 2026 — v0.7.12: Inference Intelligence

### Inference Profiler
- `GET /api/profile?minutes=60` — correlated timeline: TTFT, tok/s, KV cache %, queue depth, thermal penalty, power, GPU util on a single time axis
- Resolution auto-scales: ≤10min raw 1s, ≤1h 10s, ≤6h 30s, ≤24h 60s
- Frontend: multi-series Recharts chart on Performance tab with 5 selectable metrics + tok/s reference line
- Cloud MCP tool: `get_inference_profile(node_id, minutes)` — Team+

### Cost Attribution Per Model
- `GET /api/cost-by-model?hours=24&kwh_rate=0.12` — GROUP BY model with hours active, avg watts, total Wh, cost USD, avg tok/s
- Uses metrics_raw (≤24h) or metrics_1min (>24h) for up to 30 days
- Frontend: collapsible "Cost by Model (24h)" table on Overview tab, auto-refreshes every 60s

### "Why Was That Slow?" Explainer
- `GET /api/explain-slowdown?ts_ms=N` — finds closest inference_trace, reads ±30s hardware context, evaluates 6 factors (KV cache, thermal, queue, swap, memory, clock throttle), ranks by severity, generates natural-language summary
- Cloud MCP tool: `explain_slowdown(node_id, ts_ms)` — Team+
- Observation enrichment: Patterns P (`ttft_regression`) and Q (`latency_spike`) now include contributing hardware factors in body text

### Model Comparison
- `GET /api/model-comparison?hours=168&kwh_rate=0.12` — side-by-side efficiency data for every model that has run on this node
- Returns: model name, hours active, avg tok/s, avg watts, WES, TTFT, cost/hr, total cost, sample count
- Uses metrics_raw (≤24h) or metrics_1min (>24h) for up to 30 days

### MCP Tool Fixes
- `get_observations` and `get_metrics_history` now return actual data (via internal HTTP call to agent REST API) instead of redirect messages
- All 5 local MCP tools are fully functional

### Ollama Model Enrichment
- `get_active_models` MCP tool now includes `context_length` and `parameter_count` from Ollama `/api/show`
- Cached on model change — not queried every tick
- Enables NRO bandwidth estimation and capacity planning

### Observation Routing Hints
- Every observation now includes `routing_hint`: `steer_away` | `reduce_batch` | `monitor`
- Node-level aggregate: `routing_hint` + `routing_hint_source` on `/api/observations` response envelope
- Derived from pattern_id + severity via `routing_hint_for()` — no extra configuration
- Machine-readable signal for NRO/partner routing automation

### MCP Tool Fixes
- `get_observations` and `get_metrics_history` now return actual data via internal HTTP calls (were redirecting to REST)
- All 5 local MCP tools fully functional

### Cloud MCP Security
- Added 600 req/60s sliding-window rate limiting
- Fixed org_id scope — Cloud MCP now uses `tenant_scope()` for shared fleet access

---

## April 6, 2026 — v0.7.11: Server-Side Patterns, Cloud MCP, PagerDuty, Clerk Orgs

### Phase 7 — Remove Client-Side Pattern Engine
Moved all pattern evaluation from the browser (patternEngine.ts) to the Rust agent and cloud backend.

- **7A:** Extracted shared types (`DetectedInsight`, `ActionId`, etc.) to `src/types/observations.ts`
- **7B:** Agent evaluates 17 patterns every 10s in a background task, writes to shared `ObservationCache`, embeds in telemetry JSON via `cloud_push.rs`
- **7C:** Cloud deserializes `AgentObservationPayload`, upserts into `fleet_observations` table (`source='agent'`), auto-resolves stale observations when nodes go offline (5 min)
- **7D:** Frontend refactored — `AIInsights.tsx` reads from `useLocalObservations` (localhost) and `useFleetObservations` (cloud). No client-side `evaluatePatterns()`.
- **7E:** Deleted `patternEngine.ts` (2,254 lines) and `useMetricHistory.ts` (284 lines). Net: -2,500 lines.

### Pattern O — VRAM Overcommit (`vram_overcommit`)
- Point-in-time check: fires when loaded model > 90% of GPU memory (NVIDIA VRAM or Apple unified). Critical at >= 98%.
- Community tier, `action_id=switch_quantization`. Platform-aware resolution steps (nvidia-smi vs sysctl).

### Cloud Alert Fixes
- **Tier filtering bug fixed:** `allowed_patterns_for_tier()` now returns actual `alert_type` strings instead of single letters A–R that never matched the database values. All 6 cloud alerts + all agent pattern IDs correctly gated by tier.
- **Staleness reaper expanded:** Auto-resolves ALL open observations (agent + cloud) when node offline > 5 min.
- **`oom_warning` hardened:** Requires 2 consecutive 60s ticks at > 95% memory pressure (was 1).

### Cloud MCP Server (Team+)
Fleet-aggregated MCP endpoint at `POST wicklee.dev/mcp`. Clerk JWT auth, Team+ tier gate.
- 6 tools: `get_fleet_status`, `get_fleet_wes`, `get_node_detail`, `get_best_route`, `get_fleet_insights`, `get_fleet_observations`
- 2 resources: `wicklee://fleet/status`, `wicklee://fleet/thermal`
- Manifest at `GET wicklee.dev/mcp/manifest`
- Uses owned metrics snapshot (no RwLockReadGuard across await points)

### PagerDuty Alerts (Team+)
- Events API v2 integration in `deliver_alert` — trigger and resolve with dedup key (`wicklee-{node_id}-{event_type}`)
- `pagerduty` added to `notification_channels` CHECK constraint (migration)
- Settings UI: PagerDuty tab with routing key input, green bell icon in channel list
- Severity mapping: `zombied_engine`/`thermal_redline`/`oom_warning` → critical; `wes_cliff`/`thermal_serious` → error; others → warning

### Per-Tier Node Limits
- `MAX_PRO_NODES = 10`, `MAX_TEAM_NODES = 25` (Enterprise = unlimited)
- Enforced at pairing (`handle_activate`), fleet list (restricted nodes), SSE stream (restricted flag)
- Previously only Community (3) was enforced; Pro/Team could add unlimited nodes

### Clerk Organizations — Shared Fleet Dashboard
- Extract `org_id` from Clerk JWT claims; `X-Org-Id` header for tenant scoping
- `organizations` table: `org_id`, `subscription_tier`, `created_by`
- `org_id` column on `nodes`, `stream_tokens` tables
- `tenant_scope()` helper: returns `("org_id", oid)` or `("user_id", uid)` for format!-based SQL
- `resolve_tier()`: checks organizations table for org users, falls back to user tier
- Org tier inherits from creating user's subscription; syncs on Paddle upgrade/downgrade
- Frontend: `useOrganization()` in CloudApp, `X-Org-Id` in FleetStreamContext, `OrganizationProfile` replaces mock TeamManagement
- Critical paths updated: fleet list, pairing, SSE stream, telemetry tenant resolution

### Documentation Overhaul
- Replaced letter labels (A–R) with `pattern_id` strings across all docs
- New DocsPage sections: Alerts & Notifications (channel setup, PagerDuty lifecycle), Teams & Organizations (4-step setup, tier inheritance), Cloud MCP (tools, auth, curl example)
- Pricing table expanded: pattern counts, alert channels per tier, extras column
- Updated llms.txt, llms-full.txt, api.md, openapi.json, CLAUDE.md

### Total Coverage
- 18 observation patterns: 17 agent-evaluated + 1 cloud-evaluated (`fleet_load_imbalance`)
- 5 fleet alerts: `zombied_engine`, `thermal_redline`, `oom_warning`, `wes_cliff`, `agent_version_mismatch`
- 9 Community patterns, 9 Pro patterns, 5 all-tier fleet alerts
- All Community, Pro, and Team features complete

---

## March 31, 2026 — v0.7.10: Inference Metrics Expansion, Patterns P/Q/R, Pro Features

### Inference Metrics Expansion (Phases 1–7) ✅
- **Phase 1: vLLM Gauges** — `vllm_requests_waiting`, `vllm_requests_swapped` harvested from `/metrics` endpoint
- **Phase 2: Ollama Probe** — `ollama_prompt_eval_tps`, `ollama_ttft_ms`, `ollama_load_duration_ms` parsed from 20-token probe response
- **Phase 3: vLLM Histograms** — `vllm_avg_ttft_ms`, `vllm_avg_e2e_latency_ms`, `vllm_avg_queue_time_ms`, token counters via delta tracking
- **Phase 4: Proxy Aggregates** — `ollama_proxy_avg_ttft_ms`, `ollama_proxy_avg_latency_ms`, `ollama_proxy_request_count` from done-packet accumulators
- **Phase 5: Storage** — DuckDB columns + Postgres `metrics_raw` and rollup additions for all 13 new fields
- **Phase 6: Frontend** — TTFT column in Fleet Status table, TTFT summary tile on Intelligence page (replaces Fleet Nodes), TTFT in Diagnostics rail and Performance tab charts
- **Phase 7: Patterns P/Q/R** — TTFT Regression (P), Latency Spike (Q), vLLM Queue Saturation (R). Pattern M enhanced with queue depth context.
- **Total: 18 observation patterns** (A–R). 9 Community, 9 Pro.

### Pro Features ✅
- **Node Display Names** — Settings → Node Configuration "Display Name" column. Syncs to Postgres via `PATCH /api/nodes/:node_id` for Pro+ users. SSE stream includes `display_name` so all devices see the custom name within 60s.
- **7-Day History Enforcement** — `isRangeLocked()` now uses actual `subscriptionTier` instead of `historyDays` proxy. Community: 1h/24h. Pro: +7d. Team: +30d/90d.
- **Paddle Integration** — Replaced Stripe references with Paddle throughout (ROADMAP.md, TIERS.md, PricingPage.tsx). Paddle overlay script + `openCheckout()` wired into pricing buttons.

### Pricing Updates ✅
- **Team tier** — $19/seat/mo (3-seat min), 25 nodes, $50/50-node expansion. Marked "Coming Soon".
- **Enterprise tier** — "From $200/month". Proxy exclusive to Enterprise.
- **Pro features added** — Custom Alert Thresholds, Node Naming & Tags.

### Dashboard ✅
- **10-tile Intelligence layout** — both localhost and cloud now have 10 summary tiles (5 per row).
  - Cloud: Capacity · Fleet Health · Fleet VRAM · Fleet TTFT · Avg WES · Fleet GPU% · Fleet Cost/Day · W/1K · Fleet Memory · Fleet tok/W
  - Localhost: Capacity · Node Cost/Day · Node VRAM · Node TTFT · Runtime · Inference State · Node WES · W/1K · Node Memory · Node tok/W
- **Expandable Fleet Status rows** — click any node row to reveal a detail panel with all inference metrics. Smart-filtered by runtime: Ollama nodes show Load Duration + Prefill Speed, vLLM nodes show E2E Latency + Queue Depth + KV Cache. No dashes for inapplicable fields.
- **Two-column Diagnostics rail (localhost)** — Live Hardware section now uses a 2-column grid: Column 1 (core hardware: CPU, GPU%, Memory, Power, Thermal, Swap, Clock Throttle) + Column 2 (inference + latency: Tok/s, TTFT, E2E Latency, Queue Depth, Load Duration, Prefill Speed, KV Cache, Requests Running).
- **TTFT column in Fleet Status** — resolves best-available source (vLLM histogram → proxy rolling → Ollama probe). Color-coded: <100ms green, 100-500ms yellow, >500ms red.
- **tok/W column + tile** — replaces Duty on both dashboards. Raw tok/s ÷ watts, same color scale as WES.
- **WES color scale** — emerald (>10), green (3-10), yellow (1-3), red (<1). Applied consistently across all components.
- **Landing page** — runtime comparison tiles (vLLM/Ollama native vs Wicklee-exclusive metrics), 18 patterns with simplified scope labels (only cloud-only patterns flagged).

### Bug Fixes ✅
- **Ollama probe carry-forward** — TTFT, prefill speed, load duration wiped every 5s harvester tick. Now carried forward like tok/s.
- **vLLM histogram delta guard** — relaxed from dc≥3 to dc≥1. Low-traffic nodes never accumulated 3 requests in a 2s poll window, causing TTFT/latency to stay permanently null.
- **nginx IPv6 DNS** — Railway internal DNS `[fd12::10]` bracketed correctly, resolves persistent 502 on `/api/v1/*`.
- **gpu_wired_limit_mb** — M4 fallback to 75% of total RAM when sysctl returns 0.
- **False thermal on idle CPU** — clock_ratio source with <15% CPU usage forced to Normal.
- **Live Activity flood** — DB seed events with unrecognized types no longer default to `node_online`.
- **10 documentation accuracy fixes** — WebSocket Hz, agent privilege, probe token count, config filename, CLI reference, API endpoints, pattern scopes, thermal mapping.

### Pro Features — Custom Alert Thresholds + Persistent Insight Cards ✅
- **Custom Alert Thresholds** — 2 new event types: `ttft_regression` (default 500ms) and `throughput_low` (default 5 tok/s). Backend evaluation fires when TTFT > threshold during active inference, or tok/s < threshold during live inference.
- **Persistent Insight Cards (Pro+)** — `obsCacheRef` seeded from server observations (`useFleetObservations`) on page load. Cards survive browser close and device switch. Dismiss calls `POST /api/fleet/observations/:id/acknowledge` for cross-device sync.
- **Resolved History (24h)** — Triage tab shows server-backed resolved observations from last 24h for Pro+ users. Green check styling with duration and age.

### Security Hardening ✅
- **R1: Agent CORS restricted** — `allow_origin(Any)` → explicit allowlist (localhost:7700, 127.0.0.1:7700, localhost:3000). Malicious webpages on external domains cannot read telemetry via JS.
- **R2: Localhost-only bind** — Default bind changed from `0.0.0.0` to `127.0.0.1`. LAN access opt-in via `bind_address = "0.0.0.0"` in config.toml.
- **R3: Fleet removal detection** — Agent detects 410 Gone from telemetry push, clears pairing state and stops push loop. Cloud returns 410 when `node_id` not in `nodes` table.

### UI Polish ✅
- **Action buttons indigo→blue** — all CTA buttons (Header, AddNodeModal, EmptyFleetState, NodesList) now use `bg-blue-600` matching the active sidebar nav color.
- **Dark mode enforced** — Theme toggle removed from Settings and Preferences. `<html class="dark">` in index.html. "Hardware-Centric Dark" is the only mode.
- **Sidebar icons centered** — Nav icons centered in collapsed rail (was left-aligned by px-6).
- **Empty state cleanup** — Lightning icon removed, step badges blue, onboarding copy updated.
- **Bell icon removed** — Notification bell placeholder removed from header.

### Pre-Launch Cleanup ✅
- **FSL-1.1-Apache-2.0 License** — protects commercial tiers from hosted competitors. Converts to Apache 2.0 after 4 years.
- **Cloud URL fixed** — `cloud_push.rs` changed from internal Railway hostname to `https://wicklee.dev`.
- **`.env.agent` untracked** — removed from git, added to `.gitignore`.
- **GitHub repo polished** — description updated, 8 topics added (gpu-monitoring, local-ai, ollama, vllm, inference, observability, rust, wes).
- **Blog post accuracy** — WES color scale, typical ranges, and route/best description fixed.

### Documentation ✅
- **Latency & TTFT section** added to DocsPage — three-source TTFT explanation (synthetic probe vs production), resolution priority, full latency metrics table.
- **Security audit updated** — R1, R2, R3, R5, R6 marked fixed. Only R8 (Paddle webhook signature) remains open.
- **AI/agent discovery files** — llms.txt, llms-full.txt, openapi.json, robots.txt, ai-plugin.json updated.

---

## March 30, 2026 — v0.7.9: Subscription Gating, WES Cleanup, Event Unification, Clerk Production

### WES Formula Cleanup ✅
- **Removed ×10 multiplier** from all WES calculations (agent `cloud/src/main.rs`, frontend `wes.ts`). WES now equals tok/watt when thermal is Normal — clean, intuitive, matches what users see.
- **tok/W column added** to Fleet Status table and summary tiles (replaces Fleet Duty on cloud, Node Duty on localhost). Formula: `tok/s ÷ watts`. Same color scale as WES.
- **Color scale updated** across all components: Excellent (>10) emerald-400, Good (3–10) green-300, Acceptable (1–3) yellow-400, Low (<1) red-400. Previous blue for Excellent replaced with emerald.
- Updated in: `wes.ts`, `MetricTooltip`, `Overview`, `MetricsPage`, `FleetHeaderBar`, `AIInsights`, `DocsPage`, `CLAUDE.md`.

### Subscription Gating ✅
- **Pattern tier filtering** — `evaluatePatterns()` accepts `subscriptionTier` param and filters Pro patterns (D, E, G, I, L, M) from Community users at evaluation time.
- **Backend export gate** — `GET /api/fleet/export` returns 402 for Community/Pro (Team+ only).
- **Backend insights API gate** — `GET /api/v1/insights/latest` returns 402 for Community/Pro (Team+ only).
- **Pricing page updated** — Team: $19/seat/mo (3-seat min), 25 nodes, +50 expansion packs ($50/mo). Enterprise: "From $200/mo" with Sentinel Proxy exclusive. Pro: added Custom Alert Thresholds and Node Naming/Tags.
- **TIERS.md updated** — Proxy row added (Enterprise only), correct node counts and pricing.

### Event Stream Unification ✅
- **Observation events in Fleet Event Timeline** — new "observation" filter chip matching all 5 cloud evaluator types + resolved variants. Color-coded badges.
- **Live Activity seeds from history** — observation onset/resolved events now persist across page loads via DB seed.
- **EventFeed resolved rendering** — green check icon for all `_resolved` variants (zombied_engine, thermal_redline, oom_warning, wes_cliff, agent_version_mismatch).
- **"Came online" flood fix** — DB events without recognized FleetEvent types no longer default to `node_online`.

### Thermal Improvements ✅
- **Idle CPU thermal override** — nodes using `clock_ratio` thermal source with CPU usage < 15% now forced to Normal. Fixes false Fair/Serious on EPYC/Xeon CPUs that aggressively frequency-scale at idle.
- **Documentation** — full platform thermal detection table added to DocsPage (NVML, IOKit, coretemp, clock_ratio, sysfs, WMI).

### Clerk Production Migration ✅
- Migrated from Clerk development instance to production (clerk.wicklee.dev proxy domain, Google OAuth configured).
- nginx IPv6 DNS fix: bracketed `[fd12::10]` for Railway internal resolver.
- Nodes re-paired under production Clerk user ID.

### Documentation Audit ✅
- 10 accuracy fixes: WebSocket 1Hz (not 10Hz), agent runs as root, Ollama probe 20-token, config.toml filename, --status CLI command, API key endpoints, dismiss endpoints, thermal_source values, pattern scope groupings (4 localhost / 4 cloud / 7 both), macOS Nominal mapping.

---

## March 27, 2026 — v0.7.8: Per-Model WES Baseline, Launchctl Fix, Intel/Windows Thermal

### Per-Model WES Normalization ✅
- **`query_model_baseline(node_id, model)`** in `store.rs` — 7-day DuckDB median tok/s and watts at Normal thermal state, minimum 100 samples for reliability
- **Background model-change watcher** — 5s polling task detects `ollama_active_model` changes, queries DuckDB, caches `(baseline_tps, baseline_wes, sample_count)` in `Arc<Mutex<>>`
- **Three-way sync** — `model_baseline_tps`, `model_baseline_wes`, `model_baseline_samples` added to MetricsPayload (agent), cloud struct (serde default), and SentinelMetrics (frontend)
- WES 180 on a 3B model vs WES 24 on a 70B is now contextual — "92% of baseline" vs "67% of baseline" tells the operator if their hardware is underperforming for this specific model

### Launchctl Auto-Start Fix ✅
- **service.rs:** Check if label is loaded before bootout (skip on fresh install — eliminates the race entirely). After bootout, poll `launchctl list` every 500ms for up to 10s instead of fixed 3s sleep. Retry backoff increased to 3s.
- **install.sh:** Poll for label removal after bootout (20 × 500ms = 10s max). Verify service is running via `curl localhost:7700` before printing "Service updated and restarted automatically". If not running, print platform-specific hint (`sudo wicklee --install-service` on macOS, `sudo systemctl restart wicklee` on Linux).
- **Root cause:** Double bootout race — `install.sh` + `--install-service` both called `launchctl bootout`. The async deregistration from the first was still in flight when the second tried to bootstrap. Polling confirms deregistration before proceeding.

### Intel Thermal (Linux) ✅
- **coretemp hwmon** — scans `/sys/class/hwmon/*/name` for "coretemp", reads all `temp*_input` entries, takes max across cores
- **Clock ratio + coretemp** — same ratio-to-state mapping as AMD (`cpuinfo_max_freq / scaling_cur_freq`), with coretemp temperature as tie-breaker (Tdie > 85°C → at least Serious)
- **Generic cpufreq fallback** — for CPUs without k10temp or coretemp hwmon, uses clock ratio alone
- **thermal_source:** `"coretemp"` (Intel with hwmon) or `"clock_ratio"` (generic)

### Windows Thermal (WMI) ✅
- **`read_thermal_sysctl()`** on Windows now queries `MSAcpi_ThermalZoneTemperature` via wmic
- Temperature in tenths of Kelvin → Celsius: `(value / 10) - 273.15`
- State mapping: Normal <70°C, Fair <80°C, Serious <90°C, Critical ≥90°C
- WES sampler falls through NVML → Apple → Linux → **WMI** → unavailable
- **thermal_source:** `"wmi"` — annotated as "estimated" in UI (lowest data quality platform)

### Key Decisions
- **100-sample minimum** for model baseline — prevents cold-start noise from producing misleading "vs baseline" indicators. A 3B model needs ~2 minutes of Normal-thermal inference to establish baseline.
- **Polling over fixed sleep** for launchctl — eliminates both under-waiting (exit status 5) and over-waiting (unnecessary delay on fast systems)
- **coretemp priority over generic sysfs** — direct per-core readings are more accurate than thermal_zone max, which often includes chipset/VRM temps

---

## March 27, 2026 — v0.7.7: Patterns M/N/O, Pricing, API QA, Production Fixes

### Observation Patterns M, N, O ✅
- **Pattern M — vLLM KV Cache Saturation (Community, Cloud+Localhost):** `vllm_cache_usage_pct > 85%` sustained 3 min during active inference. Hook: `"KV cache {pct}% — queue backlog risk"`. Action: `nvidia-smi` + vLLM cache config. vLLM-only (Linux).
- **Pattern N — NVIDIA Thermal Ceiling (Community, Cloud+Localhost):** `nvidia_gpu_temp_c > 83°C` sustained 3 min. Hook: `"{temp}°C — approaching TJmax"`. Action: `nvidia-smi -q -d TEMPERATURE`. NVIDIA-only.
- **Pattern O — VRAM Overcommit (Community, Cloud+Localhost):** Model size > 90% of available VRAM/unified memory. Hook: `"Model needs {need}GB, {avail}GB available"`. Platform-aware actions: Apple Silicon uses `ollama` commands, NVIDIA uses `nvidia-smi`.

### Pricing Page + SubscriptionGuard ✅
- Three-column pricing grid (Community/Pro/Team) + Enterprise footer
- State-aware buttons: logged-out → "Get Started", logged-in → "Upgrade to [Tier]", current tier → disabled "Current Plan"
- `SubscriptionGuard` wrapper component: `requiredTier` prop, renders children at 40% opacity blur with centered upgrade CTA when user tier < required
- Wired from nav header ("Pricing") and profile menu ("Billing")

### API Keys Settings Tab ✅
- Full CRUD UI for API key management in Settings
- Create key → one-time reveal modal, SHA-256 hashed at rest
- List keys with created date, last-used, revoke button
- Backend endpoints: `POST/GET/DELETE /api/v1/keys`

### Agent Fixes ✅
- **Hostname in telemetry** — `cloud_push.rs` now sends `gethostname()` in MetricsPayload. Fleet dashboard shows real hostnames (macmini.local, GeiserBMC, spark-c559) instead of only WK-XXXX.
- **gpu_wired_limit_mb** — Falls back to 75% of total RAM when sysctl returns 0 (M4). Fixes zero VRAM budget in WES calculation and fleet VRAM aggregation.
- **Power/memory in DuckDB** — `store.rs` writes `gpu_power_w` (resolved from SoC/NVIDIA/CPU priority) and `mem_pressure_pct` to metrics_raw. Fixes blank Power Draw and Memory charts on Observability and Performance tabs.

### Cloud Backend Fixes ✅
- **nginx IPv6 DNS** — Railway internal DNS is IPv6 (`fd12::10`); nginx `resolver` now brackets it as `[fd12::10]`. Fixes 502s on all `/api/v1/*` endpoints through wicklee.dev.
- **i64::MAX overflow** — `/api/fleet/events/history` capped `before` param to `now + 1 day` instead of `i64::MAX`.
- **Node online dedup** — `ONLINE_DEBOUNCE_MS = 90_000` prevents repeated "came online" events from telemetry timing jitter.

### Frontend Fixes ✅
- **Live Activity seed** — DB events without recognized FleetEvent types (startup, update, agent_version_mismatch) now filtered instead of defaulting to `node_online`. Stops the "came online" flood.
- **Intelligence layout** — Best Route + Node Cost side-by-side (50/50), Inference Density + Silicon Fit side-by-side. Live Activity fixed-height scrollable, matches GPU Utilization panel. Removed "View Detailed Benchmarks" link from Silicon Fit.
- **useEventHistory** — Uses `CLOUD_URL` for API calls, `lastFetchFailed` ref prevents infinite retry on transient errors.
- **Documentation page** — Full 15-pattern observation inventory, verified API endpoint reference.

### Full API QA ✅
All endpoints tested from command line, both via `localhost:7700` (agent) and `wicklee.dev` (production nginx proxy):
- **Localhost (9 endpoints):** metrics SSE, observations, history, traces, events/history, events/recent, export, tags, pair/status
- **Cloud v1 (5 endpoints):** fleet, fleet/wes, nodes/:id, route/best, insights/latest
- **Cloud health:** /health returns ok with metrics_raw stats

### Key Bugs & Lessons
- **nginx IPv6 in resolver directive** — `fd12::10` parsed as host:port by nginx. Must bracket as `[fd12::10]`. Railway containers may use IPv6-only internal DNS.
- **Event seed default type** — Any unmapped `event_type` from DB falling through to `node_online` caused cascading false connectivity events in Live Activity.
- **gpu_wired_limit_mb = 0 on M4** — `sysctl iogpu.wired_limit_mb` silently returns 0 on some Apple Silicon. Agent must fallback to `total_memory_mb * 0.75`.

---

## March 26, 2026 — v0.7.6: Local Observations + Localhost Performance Tab

### Agent: Local Observations Endpoint ✅
- **GET /api/observations** — server-side evaluation of 4 hardware patterns (A: Thermal Drain, B: Phantom Load, J: Swap Pressure, L: PCIe Degradation) against the DuckDB 1-hour buffer
- `query_observation_window()` in `store.rs` — queries last 5 min of `metrics_raw`
- `evaluate_local_observations()` — pure function, returns `Vec<LocalObservation>`
- All observation structs gated behind `#[cfg(not(target_env = "musl"))]`
- Cargo.toml version bumped to 0.7.6 (was stuck at 0.6.0)

### Triage Tab: Local Observations ✅
- Hardware observation accordion cards rendered from `/api/observations` on localhost
- Cloud-Only placeholder cards for Patterns C (WES Drift), E (Fleet Imbalance), I (Efficiency Penalty) with "Pair with wicklee.dev →" CTA
- `useLocalObservations` hook — polls agent every 30s

### Performance Tab: Localhost Symmetry ✅
- **Model Efficiency** card replaces WES Leaderboard — live tok/s, WES (with idle watt offset), W/1K TKN
- **LocalPerformanceHistory** — multi-metric area chart (TPS, Power, GPU%, Memory%) from 1h DuckDB buffer, 60s auto-refresh
- **Silicon Fit Audit** accepts `systemIdleW` prop — subtracts idle power from accelerator watts for WES

### Bug Fixes ✅
- **Collection "Disconnected" on localhost** — Diagnostics panel probed fleet SSE instead of local agent. Now uses direct HTTP probe.
- **nodes[] empty on localhost** — Settings idle watts input never rendered because `nodes.length === 0`. Bootstrapped from `pairingInfo.node_id` in App.tsx.
- **Cargo.toml version stale** — `env!("CARGO_PKG_VERSION")` reported 0.6.0 in all binaries since Phase 3B.
- **Metric History 6h/24h on localhost** — removed; only 1h DuckDB buffer available locally.
- **EventFeed footer** — removed "Full event history in Observability →" cross-link.

---

## March 25–26, 2026 — Phase 5: Postgres Migration + Observability Restructure

### Cloud Database Migration: SQLite + DuckDB → Railway Postgres ✅
- **Complete backend rewrite** — `cloud/src/main.rs` migrated from `rusqlite` + `duckdb` (bundled C libs) to `sqlx::PgPool` (async Postgres connection pool, 20 connections)
- **All 13 tables in single Postgres** — 8 transactional (users, nodes, sessions, api_keys, notification_channels, alert_rules, alert_events, stream_tokens) + 5 time-series (metrics_raw, metrics_5min, node_events, fleet_observations, schema_breakpoints)
- **TimescaleDB support** — hypertable + retention + compression policies applied when extension available (non-fatal if absent)
- **Batch INSERT via UNNEST** — `metrics_writer_task` chunks 1000 rows per INSERT, respects Postgres 65K param limit
- **TIMESTAMPTZ** for time-series columns — Postgres query planner skips chunks efficiently vs raw BIGINT
- **Eliminated all `spawn_blocking`** — sqlx is async-native, no mutex contention
- **Build speed** — removed DuckDB bundled C compile (~4 min), Railway deploys much faster
- **Railway networking** — nginx internal proxy with Docker DNS resolver (`127.0.0.11`)

### DuckDB Crash Resolution ✅
- **Root cause:** `free(): corrupted unsorted chunks` — heap corruption from concurrent `Arc<Mutex<DuckConn>>` access across 6 background tasks + HTTP handlers on Railway's ephemeral containers
- **Intermediate fixes:** mutex poisoning recovery (`duck_lock()`), schema drift migration (ALTER TABLE), INSERT-with-named-columns (replace Appender), `/health` diagnostic endpoint
- **Final fix:** Complete migration to Postgres eliminates the DuckDB dependency on cloud entirely. Agent keeps DuckDB for local history.

### Observability Tab Restructure ✅
- **Unified 6-chart grid (3×2)** on both localhost + cloud: Tok/s, Power Draw, GPU Util, CPU Usage, Mem Pressure, Swap Write
- **Cloud FleetMetricsMini** expanded from 4 (2×2) to 6 (3×2) charts
- **swap_write** column added to Postgres pipeline (metrics_raw, metrics_5min rollup, history response)
- **Localhost section reorder:** Sovereignty → Metric History → Inference Traces → Connection Events → Diagnostics
- **DismissalLogPanel removed** — no longer needed
- **Agent Health → Diagnostics** rename
- **Sovereignty collapsible** on localhost (default collapsed, "Sovereign" badge)
- **Merged FleetSovereigntyGuard + TelemetryInspector** on cloud — single component with expandable node rows. Click a node → inline field inspector (SYNCED vs LOCAL_ONLY fields, Copy JSON)
- **Clock throttle indicator** on Power Draw chart — amber "⚡ Throttled X%" badge when `clock_throttle_pct > 0`

### Agent Version Mismatch Alert ✅
- New alert #5 in `fleet_alert_evaluator_task`: compares each node's `agent_version` against fleet majority (mode). Warning when mismatched. Auto-resolves on update.

### Acknowledged Observations ✅
- `acknowledged_by` column on `fleet_observations` — tracks who acknowledged
- Server-side 1hr cooldown after resolve/acknowledge prevents flickering alerts
- Client-side pattern engine per-(node, type) suppression key

### Frontend Polish ✅
- **"DuckDB" → "local store"** — 20+ user-facing string replacements across TracesView, WESHistoryChart, MetricsHistoryChart, PricingPage, ScaffoldingView
- **Overview chart: 60s → 1hr** buffer (3600 samples at 1 Hz), HH:MM:SS labels
- **Recharts minHeight={1}** fix — suppresses -1 dimension console warning
- **`/api/pair/status` 404 fix** — gated behind `isLocalHost` on cloud
- **Localhost idle watts setting** — Cost & Energy section, same `systemIdleW` path as cloud per-node table
- **Settings Account & Data** — fleet status shows connected count, agent version mismatch indicator, "Managed Postgres" storage label

### Key Bugs & Lessons
- **DuckDB + Railway = fatal** — concurrent Mutex access + container kills → heap corruption. Postgres with connection pooling is the correct architecture for multi-tenant cloud.
- **UNNEST batch INSERT** — Postgres 65K param limit means 18-column rows must be chunked to ≤1000 rows per INSERT
- **Railway internal networking** — `service.railway.internal` DNS requires Docker resolver at `127.0.0.11` in nginx config
- **`CREATE TABLE IF NOT EXISTS` doesn't update schema** — always pair with `ALTER TABLE ADD COLUMN IF NOT EXISTS` migrations for existing databases

---

## March 24, 2026 (Session 3) — Phase 4B: Fleet Alerting & Observations

### Fleet Observations System (Cloud Backend) ✅
- **`fleet_observations` DuckDB table** — stateful alert triage: `(tenant_id, node_id, alert_type, fired_at_ms)` PK, severity (critical/warning/info), state (open/resolved/acknowledged), context JSON for forensic detail.
- **`GET /api/fleet/observations?state=open|resolved|all`** — authenticated endpoint for triage tab consumption. Returns structured observation records with context.
- **`fleet_alert_evaluator_task`** — new 60s cloud background task evaluating Essential Four alert conditions against live metrics cache:
  1. **Zombied Engine** — `inference_state == "busy"` sustained >10min → critical
  2. **Thermal Redline** — `thermal_state == "Critical"` sustained >2min → critical
  3. **OOM Warning** — `memory_pressure > 95%` sustained >1min → warning
  4. **WES Cliff** — WES < 50% of 24h DuckDB baseline → warning
- In-memory ring buffers per node (60 slots) for "sustained" threshold checks. Writes to both `node_events` (flat timeline) and `fleet_observations` (stateful triage). Auto-resolves observations when condition clears.
- **Node offline dedup** — `node_offline_alert_task` now checks for existing recent events before writing, preventing repeated "no telemetry received for Xm" entries.

### DuckDB Pipeline Fix (Critical Production Issue) ✅
- **Root cause:** Appender column count mismatch — Railway DuckDB table had 16 columns (created from older schema) but Appender sent 18 values. Missing ALTER TABLE migrations for `wes_version` + `agent_version`. Silent failure since ~1:23 PM EST.
- **Fix 1:** Added ALTER TABLE migrations for all missing columns on `metrics_raw` and `metrics_5min`.
- **Fix 2:** Replaced DuckDB Appender with explicit `INSERT INTO ... (col1, col2, ...) VALUES (?, ?, ...)` — immune to schema drift from ALTER TABLE migrations.
- **Fix 3:** Added `duck_lock()` helper (21 call sites) — recovers from poisoned mutexes via `.unwrap_or_else(|e| e.into_inner())` instead of cascading panics across all DuckDB tasks.
- **Fix 4:** Added error logging to `metrics_tx.try_send()` so pipeline breaks are visible in Railway logs.
- **Fix 5:** Added `/health` endpoint with DuckDB diagnostics (`latest_age_s`, `rows_1h`, `rows_24h`, `fleet_observations_open`).

### Live Activity De-spam ✅
- **Fleet-wide onset coalescing** — `FLEET_COALESCE_MS = 60s`. Same pattern firing on 3 nodes within 1 minute now emits 1 feed event instead of 3. Per-node `ONSET_SUPPRESSION_MS` (15m) still applies.
- **Proper event rendering** — Added `pattern_onset` (amber AlertTriangle), `pattern_resolved` (green Check), `pattern_dismissed` (gray Check) to EventFeed's `eventMeta()`. Also added server-side alert types: `zombied_engine`, `thermal_redline`, `oom_warning`, `wes_cliff` with semantic icons.
- **FleetEvent type union** — Added all new event types to `types.ts` for strict TypeScript coverage.

### Silicon Fit Audit (QuantizationROI replacement) ✅
- `SiliconFitAudit.tsx` replaces `QuantizationROICard.tsx` (deleted). Severity-based Fit status from WES (Optimal >100, Sub-Optimal 10-100, Poor <10). Multi-node pill selector. VRAM savings calculation. W/1K TKN as primary metric, Chip icon.

### Telemetry Inspector Dropdown Fix ✅
- Replaced native `<select>` (broken dark theme rendering on browser default option styling) with pill button selector matching SiliconFitAudit node picker. Cyan border on active, gray for inactive, "(offline)" suffix.

### Server-Side Tier Enforcement ✅
- Verified server-side range gating on all history endpoints (wes-history, metrics-history, duty). Community: 1h/24h, Pro: +7d, Team/Enterprise: +30d/90d. Frontend `RANGE_LIMITS` aligned. Lock icons on disabled ranges.

### Intelligence Tab Mission Control Layout ✅
- Reordered: Fleet Status + Triage → Fleet Intelligence + HexHive → Silicon Fit → Performance → Benchmark.
- Monitoring strip compacted to single row of dormant pattern pills.

### Key Bugs & Lessons
- **DuckDB Appender + ALTER TABLE = schema drift** — CREATE TABLE IF NOT EXISTS is a no-op on existing tables. Columns added via ALTER TABLE change the physical schema, but Appender assumes the original CREATE TABLE order. INSERT with named columns is immune.
- **Mutex poisoning cascade** — One task panicking while holding `Arc<Mutex<DuckConn>>` poisons the mutex, making ALL subsequent `.lock().unwrap()` calls panic. `duck_lock()` helper recovers via `.into_inner()`.
- **`try_send` silent drops** — `let _ = tx.try_send(row)` silently swallows `SendError` when receiver is dropped. Pipeline breaks become invisible. Always log send failures on critical paths.

---

## March 24, 2026 — Cloud Observability Fleet-First Redesign + Duty Cycle + Alerting Foundation

### Cloud Observability Tab — 4 Fleet-First Sections ✅
Complete redesign of the cloud Observability tab at wicklee.dev. Localhost (Cockpit) unchanged.

- **Section 1: Live Sovereignty Guard** — real-time connection manifest from SSE stream. Per-node status dots (green < 10s, amber < 30s, red > 30s stale). Pulsing "LIVE" badge. Data boundary strip: "N nodes connected · telemetry only · inference content never transmitted".
- **Section 2: Telemetry Inspector** — collapsible sovereignty proof panel. Shows actual SSE field values grouped by category ([SYNCED] in green vs [LOCAL_ONLY] struck-through). Copy JSON export for audit docs. Node selector shows all registered nodes (not just SSE-active).
- **Section 3: Fleet Event Timeline** — paginated events from DuckDB `node_events` (30-day retention). Node dropdown + event type filter chips (startup, update, model_swap, thermal_change, node_offline, node_online, error). Authenticated CSV/JSON export via Blob URL. Cursor-based pagination.
- **Section 4: Fleet Metric History** — compact 2×2 mini-chart grid (Tok/s, Power, GPU Util, Mem Pressure). Tier-gated range selector (1H/24H/7D/30D). Node pill selectors matching MetricsHistoryChart design. Adaptive X-axis labels (HH:MM:SS for 1H, HH:MM for 24H, M/D HH:MM for 7D+). Client-side CSV export.

### Inference Duty Cycle in Cloud DuckDB ✅
- `inference_state VARCHAR` persisted to `metrics_raw` on every 2s telemetry frame
- `inference_duty_pct FLOAT` computed during 5-min rollup (% of samples where state = 'live')
- New `GET /api/fleet/duty?range=1h|24h|7d|30d` endpoint — fleet-wide + per-node duty
- Overview tile reads 24h duty from DuckDB server-side (60s refresh), replacing ephemeral client-side tick counter

### Per-Node Idle Wattage Offset ✅
- Settings UI: per-node idle power offset (W) configurable in fleet settings
- Factored into cost/day calculation across all tiles

### Node Offline/Online Events ✅
- Cloud `node_offline_alert_task` now writes `node_offline` + `node_online` events to DuckDB `node_events`
- In-memory `known_offline` set prevents duplicate events per 60s tick
- Node recovery detection: auto-resolves open `alert_events` when node resumes telemetry
- Debounced: 5-minute offline threshold, must sustain one full tick cycle online for recovery event

### Critical Fixes
- **24h graphs empty** — `metrics_5min` only populated by hourly rollup of data >24h old. Changed 24h range to query `metrics_raw` directly (2-day retention, bucketed at query time). Same fix for WES history endpoint.
- **Auth race on Fleet Event Timeline** — `useEventHistory` hook fired before JWT resolved, got 401. Added `skip` option to hook + JWT refresh every 50s.
- **Telemetry Inspector missing nodes** — was using `Object.values(allNodeMetrics)` (SSE-only). Switched to registered `nodes` prop from SQLite.
- **Rollup startup delay** — rollup task skipped immediate first tick, waited full hour. Added 60s warm-up then immediate first rollup.
- **Cloud compile fix** — `resolve_user_from_jwt` → `require_user`, `state.duck` → `state.duck_db`

### Phase 4 Alerting Architecture (Designed — Implementation Next)
Full alerting system designed with "Forensic Loop" flow:
1. **Detection** — `fleet_alert_evaluator_task` (60s cloud background task)
2. **Notification** — `deliver_alert()` (webhook / email / Slack)
3. **Persistence** — DuckDB `node_events` + new `fleet_observations` table
4. **Discovery** — Triage tab shows open observations as severity cards
5. **Investigation** — Observability tab cross-nav with pre-set node/time filters
6. **Resolution** — Auto-resolve when condition clears + manual acknowledge

**Essential Four Alert Triggers:**
| # | Alert | Condition | Priority |
|---|---|---|---|
| 1 | Zombied Engine | `inference_state == "busy"` sustained >10min | Critical |
| 2 | Thermal Redline | `thermal_state == "Critical"` sustained >2min | Critical |
| 3 | OOM Warning | `memory_pressure > 95%` sustained >1min | Warning |
| 4 | WES Cliff | WES < 50% of 24h rolling baseline | Warning |
| 5 | Node Offline | No telemetry >5min (✅ shipped) | Critical |
| 6 | Node Back Online | Recovery from offline (✅ shipped) | Info |

---

## March 23, 2026 — v0.5.16–v0.5.20: DuckDB Events, Port Validation, Proxy Awareness, Diagnostic Doctor

### v0.5.16 — DuckDB Event Persistence ✅
- **Agent:** `node_events` table in `store.rs` with `write_event()`, `query_events()`, 7-day retention. `event_type` field on `LiveActivityEvent`. Centralized `push_event()` helper. `GET /api/events/history` endpoint (paginated, cursor-based).
- **Cloud:** `live_activities` + `LiveActivityEventPayload` added to cloud `MetricsPayload` (three-way sync fix). `node_events` DuckDB table with tenant isolation, 30-day retention. `events_writer_task` via mpsc channel. `GET /api/fleet/events/history` (JWT-authenticated).
- **Frontend:** `EventHistoryRecord` interface, `useEventHistory` hook with cursor-based pagination, Event History panel in Observability tab.

### v0.5.16 — UI Fixes ✅
- **Version display:** `package.json` synced to match `Cargo.toml` — footer no longer shows stale fallback version.
- **Fleet row height:** Invisible placeholder in TOK/S column idle state prevents row height shifting when IDLE-SPD badge appears/disappears.
- **Thermal on localhost:** New `Thermal` row in DiagnosticRail (after Board Power) — shows Normal/Fair/Serious/Critical with color coding and penalty multiplier badge.

### v0.5.17 — Probe Diagnostic Logging ✅
- Added `eprintln!` to both silent skip paths in the Ollama probe (port=None, model=None).
- `discover_first_ollama_model` now logs failures instead of silently returning `None`.
- Removed per-scan socket-scan log spam from `process_discovery` (logged on change only).

### v0.5.18 — Ollama Port Validation ✅
- **Root cause:** Tier 3 socket scan found Ollama worker subprocesses (`ollama_llama_server`) on internal port 34111 — not the API. All API calls returned 404.
- **Fix:** Harvester health-checks discovered port via `/api/version`. Falls back to default port (11434) when API doesn't respond. Validated port stored in `OllamaMetrics.validated_port` so probe task uses correct port.
- **Install script:** `cap_sys_ptrace` capability preserved across upgrades (install.sh checks old binary before replacing).
- **Release workflow:** Nightly release now also updates on version tag pushes (not just main branch).

### v0.5.19 — tok/s Regression Fix ✅
- **Root cause:** `validated_port` not in the carry-forward list when the harvester rebuilds `OllamaMetrics` every 5s. Zeroed by `..Default::default()`, causing the probe to skip every cycle.
- **Fix:** One line — `validated_port: prev_state.validated_port` in the struct rebuild.

### v0.5.20 — Proxy Awareness UI + Port Doctor ✅
- **Proxy Awareness:** Dynamic Sovereignty manifest shows "Wicklee Proxy" (active) or "Ollama inference probe" (inactive) based on real-time agent data. Rich traces empty state with 3-step proxy setup guide (proxy inactive) or curl test command (proxy active, no traces yet). `proxy_listen_port` + `proxy_target_port` on MetricsPayload (three-way sync).
- **Port Doctor:** `--status` diagnostic warns when runtime detected on default port but API not responding. Suggests `[runtime_ports]` config override.
- **Discovery hints:** First-scan log for default-port runtimes suggests config override.
- **Settings cleanup:** Node Configuration section hidden on localhost (cloud-only feature).

### v0.5.21 — vLLM/llama.cpp IDLE-SPD Fix ✅
- **Root cause:** The inference state machine's IDLE-SPD gate only checked `ollama.recent_probe_baseline()`. vLLM and llama.cpp probes set tok/s correctly, but `inference_state` stayed `"idle"` because `recent_probe` was always `false` for non-Ollama runtimes. Fleet frontend shows `—` when state is `idle`.
- **Fix:** Added `last_probe_end` + `recent_probe_baseline()` to `VllmMetrics` and `LlamacppMetrics`. `HardwareSignals.recent_probe` now ORs all three: `ollama || vllm || llamacpp`.

### Critical Bugs Found & Fixed
- **Ollama worker socket discovery (BMC)** — Tier 3 socket scan preferred non-default ports, picking up internal worker sockets instead of the API. Fixed with API health check + default port fallback.
- **tok/s regression (all Ollama nodes)** — `validated_port` erased every 5s by struct rebuild. Probe skipped permanently, tok/s stayed blank.
- **Spark vLLM port loss** — `cap_sys_ptrace` stripped by install script replacing the binary. Fixed: install.sh now preserves the capability.
- **Nightly release stale** — Version tag builds didn't update the nightly release. Install script pulled old version. Fixed: nightly job now runs on both main pushes and tag pushes.
- **vLLM/llama.cpp tok/s invisible in fleet** — IDLE-SPD gate was Ollama-only. Spark showed 32 tok/s locally but `—` in fleet dashboard.

### v0.5.22 — Audit Log Export + Sovereignty Badge ✅
- **Agent:** `GET /api/export?format=csv|json` — unified audit log joining `node_events`, `inference_traces`, and `accepted_states`. Time range + limit params. CSV with Content-Disposition for browser download. Actionable error: "sudo chown" on permission denied, platform hint on musl.
- **Cloud:** `GET /api/fleet/export` — JWT-authenticated, tenant-isolated. Exports fleet `node_events` as CSV/JSON.
- **Frontend:** CSV and JSON download buttons in Event History panel. `AuditLogRecord` interface.
- **Sovereignty badge:** Blue `config.toml` badge in manifest when `[runtime_ports]` override is active. `runtime_port_overrides` field on MetricsPayload (three-way sync).

### Phase 3B Complete → v0.6.0 "Sovereignty Release" 🏷️

---

## March 23, 2026 — v0.5.10–v0.5.15: Dead Zone Fix, Module Extraction, Inference Traces, llama.cpp Harvester

### v0.5.10 — Dead Zone Fix ✅
- **Root cause:** Ollama `/api/ps` `expires_at` resets were being attributed to user inference even when caused by the 30s probe. Result: Tier 2 "Live" classification during idle periods (the "Dead Zone").
- **Fix:** `probe_caused_next_reset` one-shot flag in `OllamaMetrics`. The probe sets it on completion; the harvester consumes it on the first `expires_at` change it sees. This cleanly distinguishes probe-caused resets from real user requests without time-based blackouts.
- **`InferenceState` enum** replaces raw strings in Rust — `Live`, `IdleSpd`, `Busy`, `Idle`. Serializes to frozen wire values (`"live"`, `"idle-spd"`, `"busy"`, `"idle"`).
- **8 new unit tests** covering all tier transitions and probe attribution edge cases.

### v0.5.11 — Graceful Shutdown ✅
- SIGTERM/SIGINT handler flushes in-flight responses and DuckDB WAL.
- `powermetrics` child process uses `kill_on_drop` — no orphan processes after agent restart.

### v0.5.12 — Module Extraction ✅
- `main.rs` split into focused modules: `inference.rs`, `harvester.rs`, `proxy.rs`, `cloud_push.rs`, `service.rs`, `diagnostics.rs`.
- `pub(crate)` visibility for inter-module access. No behavioral changes.

### v0.5.13 — Bootstrap Retry + Install Script Hardening ✅
- **launchctl race fix:** bootstrap retry loop handles port-release timing after `bootout`.
- **install.sh bash guard:** detects `dash`/`sh` and re-execs under `bash` for array syntax compatibility.
- **`--status` power check:** diagnostics now probe powermetrics availability.

### v0.5.14 — Inference Traces ✅
- Ollama proxy captures done-packet timing → `inference_traces` DuckDB table.
- `GET /api/traces` endpoint serves trace history to the Observability tab's TracesView.
- `uuid` crate added for trace ID generation.

### v0.5.15 — llama.cpp Inference-Active Harvester ✅
- **Tier 1 (Exact) detection** for `llama-server` and `llama-box` via `/health` endpoint polling.
- Polls configurable `llama_cpp_url` (default `localhost:8080`) every 2s.
- Parses `{"slots_idle": N, "slots_processing": M}` — `slots_processing > 0` = inference active.
- New `LlamaCppMetrics` shared state: `llama_cpp_running`, `llama_cpp_model`, `llama_cpp_slots_processing`, `llama_cpp_slots_idle`.
- `compute_inference_state()` updated: `llama_cpp_slots_processing > 0` is Tier 1 (exact), same priority as vLLM `requests_running > 0`.
- **Three-way sync maintained:** agent `MetricsPayload` → cloud `MetricsPayload` → frontend `SentinelMetrics` all updated with `llama_cpp_*` fields.
- 1 new unit test for llama.cpp inference state transition.

### Critical Bugs Found & Fixed
- **Cloud MetricsPayload missing 20+ fields** — `serde(default)` silently dropped `apple_soc_power_w`, `inference_state`, `agent_version`, `penalty_avg`, etc. Root cause of fleet power/WES divergence for months. Fixed in `cloud/src/main.rs`.
- **Frontend power calculation** — ~30 callsites used `cpu_power_w` instead of `apple_soc_power_w`. Created `src/utils/power.ts` with `getNodePowerW()` utility, replaced all inline calculations.
- **Fleet smoothing divergence** — fleet SSE at 2s cadence with 8-sample window = 16s lag. Added `FLEET_ROW_ROLLING_WINDOW=4` and GPU% smoothing in fleet row.
- **Localhost version display** — DashboardShell read from FleetStreamContext (empty on localhost). Fixed with one-shot `/api/metrics` fetch.
- **Power cost $0.00** — shows "< $0.01/day" when cost rounds to zero.

### What's Next (Phase 3B remaining)
1. **DuckDB event persistence** — `node_events` table, `GET /api/events/history`
2. **Audit Log Export** — exportable pairing and telemetry history

---

## March 19, 2026 — Sprint 7: Pattern K + L, Deep Metal Charts, Agent CLI Polish (v0.4.30–v0.4.33)

### New Agent Fields — Deep Metal Expansion ✅

Three new fields on `MetricsPayload` and `SentinelMetrics` (TypeScript + Rust):

| Field | Source | Platform | Notes |
|---|---|---|---|
| `swap_write_mb_s` | `/proc/diskstats` (Linux) · `vm_stat` (macOS) · WMI (Windows) | All | Swap write rate during inference; explains inference stuttering |
| `clock_throttle_pct` | NVML `clock_info(Clock::Graphics)` vs `max_clock_info(Clock::Graphics)` | NVIDIA | `(1 − cur/max) × 100`; 0 = full speed, 100 = fully throttled |
| `pcie_link_width` | NVML `current_pcie_link_width()` | NVIDIA | Current PCIe lane count (1/4/8/16); zero-privilege |
| `pcie_link_max_width` | NVML `max_pcie_link_width()` | NVIDIA | Max lane count the GPU + slot support |

**Rust agent (`agent/src/main.rs`):**
- `NvidiaMetrics` struct gains `pcie_link_width: Option<u32>` + `pcie_link_max_width: Option<u32>` (both with `#[serde(skip)]`).
- NVML harvester probes both after the clock throttle block.
- `MetricsPayload` gains all four new fields with `#[serde(skip_serializing_if = "Option::is_none")]`; forwarded in both WS + SSE broadcast loops.
- **NVML API correction:** `ClockType` → `Clock` enum (nvml_wrapper 0.10 rename). Previously caused Linux CI build failure — Mac arm64 compiled cleanly because `#[cfg(no_nvml)]` skipped the affected code.

**TypeScript (`src/types.ts`):** `SentinelMetrics` and `HistorySample` gain optional fields for all four.

**`useMetricHistory` hook (`src/hooks/useMetricHistory.ts`):** `MetricSample` interface gains `swap_write_mb_s`, `clock_throttle_pct`, `pcie_link_width`, `pcie_link_max_width`. `metricsToSample()` maps all four from the raw metrics object. localStorage schema version unchanged (additive).

---

### MetricHistoryPanel — 5th + 6th Charts + 2×3 Grid ✅

`src/components/TracesView.tsx` — `MetricHistoryPanel` expanded from 4 to 6 charts:

| Chart | Color | Field | Unit |
|---|---|---|---|
| Tok/s | indigo | `tps` / `tps_avg` | `tok/s` |
| Power Draw | amber | `gpu_power_w` | `W` |
| GPU Util % | cyan | `gpu_util_pct` | `%` |
| CPU Usage % | blue | `cpu_usage_pct` | `%` |
| **Swap Write** | rose `#f43f5e` | `swap_write_mb_s` | `MB/s` |
| **Clock Throttle** | violet `#8b5cf6` | `clock_throttle_pct` | `%` |

Grid changed from `grid-cols-1 sm:grid-cols-2` → `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3` (2×3 on large screens, 2×2 stacked on md, single-col on mobile).

---

### Pattern K — Clock Drift (Community) ✅

`src/lib/patternEngine.ts` — `evaluatePatternK()`.

**Detection (5-min gate):**
- 70% data coverage gate on `clock_throttle_pct` samples
- `tok_s > 0.5` — inference active
- `avgThrottle > 15%` (soft threshold, warning) or `> 35%` (hard threshold, severe escalation)
- ≤ 30% hot thermal samples — guards against overlap with Pattern A (heat-driven throttle)

**Signal:** Clock throttling without thermal cause. Root causes: power delivery limits, TDP cap set too low, VRM current limit, driver-enforced frequency cap.

**Quantification:** `impliedFullTokS = avgTokS / ((100 - avgThrottle) / 100)` — how fast the node would run at full clock speed. Hook: `"-X tok/s (Y% clock throttle)"`.

**Severe escalation (> 35%):** Title changes to "Severe Clock Throttle During Inference". `action_id: check_power_limits` (new ActionId).

**`PATTERN_LABELS` additions:**
```typescript
clock_drift:           'Clock Drift',
pcie_lane_degradation: 'PCIe Lane Degradation',
```

---

### Pattern L — PCIe Lane Degradation (Pro) ✅

`src/lib/patternEngine.ts` — `evaluatePatternL()`.

**Detection (5-min data window):**
- 70% of samples have `pcie_link_width` + `pcie_link_max_width` present
- 70% of those samples show `curWidth < maxWidth` (degraded lanes)
- ≥ 50% of samples with `tok_s > 0.5` — active inference required

**Signal:** Physical hardware condition — GPU not seated fully in PCIe slot, or slot wiring fault. Causes silent bandwidth reduction invisible to software monitoring.

**Quantification:** `bandwidthLossPct = Math.round((1 - curWidth / maxWidth) * 100)`. Hook: `"PCIe x{cur} of x{max} ({loss}% bandwidth loss)"`.

**Note:** PCIe lane count is static (doesn't change at runtime). The 5-min window is for data-quality confidence, not temporal change detection.

**Tier:** `pro`. `action_id: check_power_limits` (closest available physical-fix action).

---

### v0.4.32 — launchctl `--install-service` Reinstall Fix ✅

**Root cause:** `launchctl load -w` (deprecated macOS 10.15+) fails with I/O error 5 when the service label `dev.wicklee.agent` is already registered in the system domain. The plist would write successfully, but the old service kept running the old binary. Error shown to user but reported as success.

**Fix — `install_service()` macOS block:**
```rust
// Bootout any existing registration (silently no-ops if not registered)
let _ = tokio::process::Command::new("launchctl")
    .args(["bootout", "system/dev.wicklee.agent"])
    .status().await;
// Bootstrap the new plist
let status = tokio::process::Command::new("launchctl")
    .args(["bootstrap", "system", plist_path])
    .status().await;
```

**Fix — `uninstall_service()` macOS block:**
`launchctl unload -w <plist>` → `launchctl bootout system/dev.wicklee.agent`.

Both paths now use the modern `bootout` / `bootstrap` commands. Clean reinstalls work on all macOS 10.15+ versions without the I/O error 5.

---

### v0.4.33 — Version Print on Every Invocation ✅

`println!("wicklee-agent v{}", env!("CARGO_PKG_VERSION"))` added as the first statement in `main()` — before all flag dispatch. Every `wicklee` / `sudo wicklee` invocation announces its version on line one.

- `--install-service` → `wicklee-agent v0.4.33` then install result
- `--uninstall-service` → version then result
- `--status` → version then status box
- `--version` → version (returns immediately; `--version` handler's duplicate `println!` removed)
- Daemon startup → version appears in `/var/log/wicklee.log` at boot — useful for diagnosing which build is running

---

## March 19, 2026 — Sprint 6: Dismissal Log Panel + Probe Startup Alignment

### Dismissal Log — Observability Tab ✅

Sprint 6 is now complete on the frontend. The Observability tab has a fifth section: **Dismissal Log** (`DismissalLogPanel` in `TracesView.tsx`).

**What it shows:**
- All active (non-expired) `accepted_states` rows from the agent DuckDB, fetched via `GET /api/insights/dismissed`
- Columns: **Pattern** (human-readable label + raw ID), **Scope** (Fleet-wide badge or `node_id`), **Dismissed**, **Expires** (relative — "in 2d 4h", "Permanent", or "Expired"), **Note**
- Polls every 30s; relative-time labels tick independently every 30s without a re-fetch
- `PATTERN_LABELS` map covers all 10 patterns A–J

**Design details:**
- Amber section icon (`ClipboardList`) — distinct from the other blue/green/indigo panels
- Fleet-wide dismissals (empty-string `node_id`) rendered as an indigo `Fleet-wide` badge
- Permanent dismissals (>5-year expiry) show `XCircle` icon + "Permanent" in gray — intentional, not alarming
- Cockpit-only (`isLocalHost`) — same gate as Agent Health and Metric History
- Empty state explains the dismiss lifecycle; footer names `accepted_states` table and `metrics.db` for operator reference

### Ollama + vLLM Probe Startup Alignment

Diagnosed a real field issue: after a Mac agent restart, metrics wouldn't appear until a manual Ollama prompt was sent. Root cause: the probe task raced the agent startup and attempted to fire before Ollama's HTTP server was ready.

**Fix:**
- Both `start_ollama_harvester` and `start_vllm_harvester` now sleep 7s before entering their probe loops (previously: 0s for Ollama, 30s tick-burn for vLLM)
- Ollama also gains an `/api/tags` fallback: if no model is loaded on startup, the probe queries the model list and uses the first available — ensuring the first 30s probe always has a target
- The asymmetry is intentional: vLLM requires `--model` at launch (never modelless); Ollama can have keep_alive expire with no loaded model

---

## March 19, 2026 — Sprint 6: Dismiss API + Pattern I + Prescriptive Resolution Steps 🎯

### Sprint 6 — `POST localhost:7700/api/insights/dismiss` ✅

Insight dismissals are now persisted to the local agent's DuckDB, not just localStorage.

**Agent changes (`agent/src/store.rs`):**
- New `accepted_states` table: `(pattern_id, node_id, dismissed_at_ms, expires_at_ms, note)` — `(pattern_id, node_id)` primary key, upsert resets expiry on re-dismiss
- `record_dismiss()` — upsert method
- `query_active_dismissals(now_ms)` — filters expired rows
- `prune_expired_dismissals()` — cleanup utility

**Agent routes (`agent/src/main.rs`):**
- `POST /api/insights/dismiss` — `DismissRequest { pattern_id, node_id?, expires_at_ms?, note? }` → 202 Accepted
- `GET /api/insights/dismissed` — returns `{ dismissals: Dismissal[] }` for all non-expired records
- Both gated on `#[cfg(not(target_env = "musl"))]` (require DuckDB store)

**Frontend (`src/hooks/useInsightDismiss.ts`):**
- Dual-write: localStorage (zero-latency, works offline) + agent endpoint (fire-and-forget)
- Agent sync on mount: pulls active dismissals from agent and merges into localStorage (longer-lived agent record wins)
- New `dismiss(expiresInMs?, note?)` signature — optional params, backward-compatible

### Pattern I — Efficiency Penalty Drag ✅

New pattern exploiting the `penalty_avg` field from WES v2 — none of A–H used it. Catches the "invisible tax" class of software-configuration performance losses.

**Detection (5-min gate, pro tier):**
- `penalty_avg > 0.30` — > 30% of WES eaten by software overhead
- `thermal_state === 'Normal'` — not a thermal penalty
- `gpu_util_pct > 30%` — GPU is active (not Pattern D decoupled)
- `mem_pressure < 75%` and `vram < 80%` — not Pattern F/G memory-bound
- `tok_s > 0.5` — inference active

**Root causes surfaced:** context windows too long, batch too small to saturate GPU pipeline, KV cache fragmentation from mixed-length requests, MoE expert routing overhead.

**Icon:** `Wind` (yellow) in InsightsBriefingCard, `TrendingDown` (yellow) in ObservationCard.

### `resolution_steps: string[]` added to all patterns A–I ✅

New field on `DetectedInsight` — 5 numbered, prescriptive steps per pattern. Each step is a complete standalone instruction (command, config change, or physical action).

Patterns and their resolution focus:
- **A (Thermal Drain):** airflow → reroute → TDP cap commands
- **B (Phantom Load):** `ollama stop` → `OLLAMA_KEEP_ALIVE` → per-request `keep_alive`
- **C (WES Velocity Drop):** watch command → preemptive reroute → background process check
- **D (Power-GPU Decoupling):** `OLLAMA_NUM_GPU=99` → quantization switch → vLLM batch tuning
- **E (Fleet Imbalance):** `/api/v1/fleet/wes` → Nginx weight update → auto-rebalance webhook
- **F (Memory Trajectory):** `ollama stop` → `OLLAMA_MAX_LOADED_MODELS=1` → pressure monitoring
- **G (Bandwidth Saturation):** quantization downgrade → context reduction → hardware upgrade path
- **H (Power Jitter):** thundering herd vs PSU branch — queue smoothing vs PSU headroom check
- **I (Efficiency Drag):** context window reduction → batch tuning → MoE GPU offload → vLLM chunked prefill

Rendered as a numbered list in ObservationCard, below the recommendation and above copy buttons. Exposed in `/api/v1/insights/latest` for automation consumers.

---

## March 19, 2026 — Pattern H (Power Jitter) 🌊

**The Goal:** Implement Pattern H — Power Jitter — the leading indicator of PSU/VRM stress and thundering-herd load balancer issues.

---

### `src/lib/patternEngine.ts` — Pattern H: Power Jitter ✅

New `stddev()` helper added alongside `mean()`. New `evaluatePatternH()` wired into `evaluatePatterns()`.

**Detection (5-min gate, community tier):**
- `mean(watts) > 30W` — not idle drift
- `tok_s > 0.5` — inference active
- `stddev(watts) / mean(watts) > 0.20` — coefficient of variation > 20%

**Thundering herd upgrade:** if `tok_s` CoV is also > 25%, hook appends `· thundering herd` and recommendation targets bursty dispatch. This separates "load balancer is inconsistent" from "PSU is stressed".

**Why 30s samples are sufficient:** PSU/VRM stress accumulates from repeated swing events. A node cycling 200W → 40W in 30-second windows is still wearing its VRMs. True 1Hz data would catch finer spikes but the inter-window variance is already a reliable signal for the batch-level load inconsistency case.

**New icon:** `Waves` (orange) — electrical ripple/oscillation, distinct from all existing patterns.

### `src/components/insights/ObservationCard.tsx` + `InsightsBriefingCard.tsx` ✅

- `power_jitter` → `Waves` icon, `text-orange-400` in both icon maps

---

## March 19, 2026 — Pattern G (Bandwidth Saturation) + Deep Metal Roadmap 🔬

**The Goal:** Implement Pattern G — the "Model Suitability" / Bandwidth Saturation insight — and document the Deep Metal metrics expansion roadmap.

---

### `src/lib/patternEngine.ts` — Pattern G: Bandwidth Saturation ✅

New `evaluatePatternG()` function wired into `evaluatePatterns()`.

**Detection logic (all conditions, 5-min gate):**
- `gpu_util_pct < 45%` — GPU cores are waiting, not working
- VRAM > 80% (NVIDIA) or memory pressure > 70% (Apple Silicon proxy)
- `tok_s > 0.5` — inference IS active (not phantom load)
- Thermal state is Normal — this is not a thermal issue
- WES dropped > 35% from session peak — confirms real degradation

**Key architectural distinctions:**
- Not Pattern A: thermals are Normal (not the root cause)
- Not Pattern D: the bottleneck is the memory bus, not CPU-offload or batch size
- Not Pattern C: WES is stuck low, not declining (condition already chronic)

**Recommendation branches:**
- Fleet peer available → `rebalance_workload` (shift to higher-bandwidth node) + quantization note
- Solo/no peer → `switch_quantization` (new ActionId) + hardware upgrade note

**New ActionId:** `switch_quantization` — reduce model precision to lower memory bandwidth demand. Added to `ActionId` union in `patternEngine.ts`.

**Tier:** `pro` — requires GPU utilization history (NVIDIA or Apple Silicon IOKit).

---

### `src/components/insights/ObservationCard.tsx` ✅

- New `switch_quantization` badge: `Gauge` icon, emerald color
- New `bandwidth_saturation` pattern icon: `Gauge`, `text-emerald-400`
- New `bandwidth_saturation` hookColor: `text-emerald-400`

### `src/components/insights/InsightsBriefingCard.tsx` ✅

- `bandwidth_saturation` added to `patternIcon()` + `patternColor()`
- `switch_quantization` added to `ACTION_ID_COLORS` (emerald)

---

### Deep Metal Roadmap documented ✅

New Phase 4B section in ROADMAP.md: "Deep Metal Metrics Expansion" table with 8 metrics,
source, privilege level, platform, phase, and pattern trigger:

| Priority | Metric | Why it matters |
|---|---|---|
| 4B-1 | Power jitter (stddev/10s) | PSU/VRM stress, thundering-herd LB detection |
| 4B-1 | SSD Swap I/O | Explains inference "stuttering" when VRAM pressure causes swap |
| 4B-2 | Clock frequency drift | Voltage/power throttle not captured by thermal_state |
| 4B-3 | PCIe lane width | Physical bus fault causes "slow GPU" with no software signal |
| 4B-3 | XID error logs | Pre-crash kernel events → stability penalty → near-zero WES |
| 4B-4 | VRAM temperature | HBM throttle when core is "cool" — false normal detection |
| 4B-4 | Fan efficacy | Predictive: blocked airflow before throttle onset |
| 4B-enterprise | ECC / page retirement | VRAM degradation pre-failure signal (A100/H100) |

---

## March 19, 2026 — Sprint 5 + Sovereignty Copy Fix + isPaired cloud bug 🛰️

**The Goal:** Fix the broken Sovereignty section in cloud mode, improve context-aware copy, and ship the `GET /api/v1/insights/latest` endpoint (Sprint 5).

---

### `src/components/TracesView.tsx` — Sovereignty section fixes ✅

**Bug fix — `isPaired` derived incorrectly in cloud mode:**
- `isPaired` was derived from `pairingInfo?.status === 'connected'`, where `pairingInfo` comes from `GET localhost:7700/api/pair/status` (the local agent's pairing handshake). In cloud mode at wicklee.dev, this fetch fails or returns unpaired, even when the user has 3 fleet nodes streaming live via SSE.
- **Fix:** split derivation by context. Cockpit (localhost): `pairingInfo.status === 'connected'` (unchanged). Mission Control (cloud): `connectionState === 'connected' || connectionState === 'degraded'` from `useFleetStream()` — correct signal for live fleet presence.

**Copy fix — three-branch Telemetry Destination card:**
- **Cockpit (localhost):** "No outbound telemetry. All inference data stays on this machine." + "Transmitted to fleet" / "Never leaves this machine" — machine-centric, unchanged.
- **Cloud + paired:** "Each node transmits only system metrics and WES scores. Inference content is processed on-device and never leaves the node." + "Each node transmits" / "Never leaves the node" — node-centric, viewer-agnostic.
- **Cloud + no nodes:** "No nodes connected yet. Add a node to see its telemetry routing details here." + neutral gray `Radio` icon + "No nodes" badge. Removes the confusing "localhost:7700 / LOCAL ONLY" display for cloud users who haven't paired yet.

---

### `cloud/src/main.rs` — Sprint 5: `GET /api/v1/insights/latest` ✅

New handler `handle_v1_insights_latest`. Six deterministic pattern rules evaluated against `AppState.metrics` (in-memory fleet state — no DuckDB, no LLM):

| Pattern key | Trigger | Severity |
|---|---|---|
| `fleet_offline` | All nodes unreachable (>30s) | high |
| `node_offline` | Single node missing, partial outage | moderate |
| `thermal_stress` | `Critical` / `Serious` thermal state | high / moderate |
| `memory_pressure` | mem pressure ≥90% / ≥75% | high / moderate |
| `low_throughput` | Node tok/s <40% of fleet average (≥2 nodes) | low |
| `wes_below_baseline` | Node WES <40% of fleet average (≥2 nodes) | low |

Findings sorted high → moderate → low, then alphabetically by node_id within severity.

Response shape: `{ generated_at_ms, fleet: { online_count, total_count, avg_wes, fleet_tok_s }, findings: [...] }`.

Auth: `X-API-Key` (same as all v1 routes). Rate limits: same 60/600 req/min tiers.

**Route registered:** `.route("/api/v1/insights/latest", get(handle_v1_insights_latest))` + startup banner updated.

**`cargo check` passes cleanly.**

---

## March 19, 2026 — Phase 4A: Observability Tab Panels + Sprint 4 "View source →" 🔬

**The Goal:** Complete the Phase 4A Observability Tab additions from `docs/ROADMAP.md` —
Raw Metric History panel and Agent Health panel. Wire the "View source →" link that closes
Sprint 4's final item: one click from a pattern finding to its raw evidence.

---

### `src/components/TracesView.tsx` — Two new Phase 4A sections ✅

**`MetricHistoryPanel` (Cockpit / localhost only):**
- Fetches `GET /api/history?node_id=X&from=X&to=X` from the local agent DuckDB store
- `nodeId` sourced from `pairingInfo.node_id` (always populated — present before pairing)
- Time window selector: **1h / 6h / 24h** with manual refresh button
- Auto resolution: agent picks raw (1 Hz) → 1-min agg → 1-hr agg based on window width
- Four `MiniChart` area charts (Recharts `AreaChart` + gradient fill):
  - **Tok/s** — `tps` (raw tier) or `tps_avg` (aggregate tiers), indigo
  - **Power Draw** — `gpu_power_w` (Apple Silicon cpu_power + GPU, or NVIDIA board_power), amber
  - **GPU Util %** — `gpu_util_pct`, cyan
  - **CPU Usage %** — `cpu_usage_pct`, blue
- Resolution badge + per-chart sample count
- Error state: amber banner for musl targets where DuckDB is compiled out
- Empty state: prompt to run inference ("history collects at 1 Hz")

**`AgentHealthPanel` (Cockpit / localhost only):**
- Three indicator tiles:
  - **Collection** — `connectionState` dot (green pulse/amber/red) + transport badge (`sse`)
  - **DuckDB Store** — lightweight `/api/history` probe on mount (30s window) → ok / unavailable. "musl target — DuckDB disabled" hint on failure.
  - **Last Frame** — `lastTelemetryMs` relative age: "just now" / "Ns ago" / "Nm ago"
- Harvester manifest: lists all 4 active collection threads + cadences (WS 100ms · SSE 1Hz · history 1Hz DuckDB)

**Main component refactored:** `TracesView` is now a function component (not arrow-const
expression) so `nodeId` can be derived from `pairingInfo.node_id` before rendering.
Phase 4A panels are conditionally rendered: `{isLocalHost && nodeId && <Panel />}`.

---

### `src/components/AIInsights.tsx` — "View source →" link ✅

New optional prop: `onNavigateToObservability?: () => void`.

"View raw metric history →" button (Activity icon) added to the Top Finding card's
action_id / curl snippet block. Visible only in Cockpit mode (`isLocalHost`) when
the prop is provided. Clicking navigates to the Observability tab where the Raw Metric
History panel now lives — completing the "Silicon Truth" chain: pattern finding →
recommendation → raw evidence.

---

### `src/App.tsx` — Navigation wiring ✅

```tsx
<AIInsights
  ...
  onNavigateToObservability={() => setActiveTab(DashboardTab.TRACES)}
/>
```

---

### `src/types.ts` — History types added ✅

```typescript
interface HistorySample {
  ts_ms, model?, tps?, tps_avg?, tps_max?, tps_p95?,
  cpu_usage_pct?, gpu_util_pct?, gpu_power_w?, vram_used_mb?, thermal_state?
}
interface HistoryResponse {
  node_id, resolution: 'raw' | '1min' | '1hr', from_ms, to_ms, samples[]
}
```
Mirrors `store::HistorySample` and `store::HistoryResponse` in `agent/src/store.rs`.

---

### Architecture note — `/api/v1/insights/latest` and the dashboard

The Wicklee dashboard computes pattern findings **client-side** via `patternEngine.ts`.
It does **not** call `/api/v1/insights/latest` (Sprint 5). That endpoint is for
**external consumers only**: automation scripts, CI/CD pipelines, MCP tools, and cron
jobs that need a machine-readable directive without running a browser. Both the dashboard
and the API run the same deterministic logic — the API is the external projection, not
the source of truth for the dashboard.

---

### What's Next

**Sprint 4 (Morning Briefing Card — remaining items):**
- Fleet Pulse section: nodes online/total · fleet tok/s · top WES node · fleet idle cost
- Head-to-head comparison (≥ 2 nodes, same model size class)
- Top Finding + Recommendation (action_id as curl command in InsightsBriefingCard)

**Sprint 5 — Cloud Rust backend:**
- `GET /api/v1/insights/latest` — deterministic JSON, all tiers, no LLM
- External consumer endpoint: CI/CD, MCP, orchestration agents

**Sprint 6:**
- `POST localhost:7700/api/insights/dismiss` → `accepted_states` table
- Permanent accept option in ObservationCard
- Dismissal Log section in Observability tab

---

*Entries before March 19, 2026 (Phase 3A, Phase 3B, Phase 4A Sprints 1–3) are in **`docs/progress-archive.md`**.*
