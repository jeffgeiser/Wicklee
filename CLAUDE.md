# Wicklee — Developer Guide

Wicklee is a sovereign GPU fleet monitor for local AI inference. One Rust binary per node, React dashboard at `localhost:7700`, optional fleet aggregation at `wicklee.dev`.

## Repository Structure

```
agent/src/              Rust agent (Tokio/Axum, single binary)
  main.rs               Orchestrator, hardware harvesters, HTTP handlers, broadcaster
  inference.rs          Inference state machine (HardwareSignals, InferenceState)
  harvester.rs          Ollama + vLLM runtime harvesters, probes, attribution logic
  proxy.rs              Transparent Ollama proxy (:11434 -> configurable port)
  cloud_push.rs         Fleet telemetry push (2s cadence, state-change bypass)
  service.rs            Install/uninstall as launchd/systemd/Windows service
  diagnostics.rs        Startup health-check (--status)
  process_discovery.rs  Runtime detection (Ollama, vLLM process scanning)
  store.rs              DuckDB local metrics storage (conditional, not on musl)
cloud/src/main.rs       Fleet cloud backend (Axum, Railway, Postgres via sqlx)
src/                    React 19 frontend (Vite, Tailwind, Recharts)
docs/                   Architecture spec, roadmap, security, tier definitions
```

## Agent (Rust)

### Build and Test
```bash
cd agent
cargo check            # fast compilation check
cargo test             # 18 tests (inference state machine + attribution)
cargo build --release  # production binary
```
For updating a running Mac install, use `curl -fsSL https://wicklee.dev/install.sh | bash` — not `cargo build`.

The frontend is embedded via RustEmbed from `agent/frontend/dist/`. Build the frontend first (`npm run build` in `src/`), then copy output to `agent/frontend/dist/` before `cargo build`.

### Inference State Machine (inference.rs)
Four states: `Live`, `IdleSpd`, `Busy`, `Idle`. Evaluated once per broadcast tick (1 Hz) as a pure function from sensor readings.

Tier hierarchy (first match wins):
- **Tier 1 (Exact):** vLLM active request count > 0
- **Tier 2 (Attribution):** `/api/ps` expires_at change attributed to user (not probe) within 15s. The `probe_caused_next_reset` one-shot flag in `OllamaMetrics` is what distinguishes probe-caused resets from user requests — the probe sets it on completion, the harvester consumes it on the first expires_at change it sees. Do not replace this with a time-based blackout (that was the Dead Zone bug).
- **Tier 3 (Physics):** GPU residency > 20%, SoC power > 8W, ANE power > 0.5W, or NVIDIA power > 40W

### Hardware Ground Truth (do not change these thresholds)
- Probe GPU residency never exceeds ~60% on Apple Silicon
- Saturated GPU override: >= 75% (confirmed on M2 — inference drives to 99%)
- powermetrics sampling window: 5000ms (shorter windows miss inter-token idles)
- `recent_probe` window: 30s (matches probe interval)
- Tier 2 attribution window: 15s
- M4 idle board power can read 0.2-0.4W — this is real, not a sensor fault. Do not add minimum-power sanity checks that would discard sub-0.5W readings.

### Wire Format (frozen — three-way sync required)
`MetricsPayload` exists in three places that MUST stay in sync:
1. **Agent** — `agent/src/main.rs` `struct MetricsPayload` (the serializer, SSOT)
2. **Cloud** — `cloud/src/main.rs` `struct MetricsPayload` (the deserializer)
3. **Frontend** — `src/types.ts` `SentinelMetrics` interface (the TypeScript consumer)

**When adding a new field to the agent's MetricsPayload, you MUST also add it to the cloud struct and the frontend type.** The cloud uses `serde(default)` so missing fields are silently dropped — the field will simply never reach the fleet dashboard or Postgres history. This silent failure caused the fleet power/WES divergence bug (cloud was missing `apple_soc_power_w` for months).

**When adding a new field to the Postgres `metrics_raw` table**, you MUST also: (1) add it to `MetricsRow` struct, (2) add it to the UNNEST batch INSERT in `flush_batch`, (3) add the AVG to `metrics_5min` rollup, (4) return it from the `/api/fleet/metrics-history` response. Use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migration for existing databases.

Field names are frozen — do not rename any fields. The `inference_state` string values ("live", "idle-spd", "busy", "idle") are frozen.

### Architecture Constraints
- Single broadcast channel is the SSOT — do not split into separate local/cloud channels
- `compute_inference_state()` must remain a pure function (no side effects, no stored state)
- All sensor data flows through `Arc<Mutex<T>>` shared state
- The agent runs as root (LaunchDaemon on macOS, systemd on Linux) for powermetrics access
- Graceful shutdown via SIGTERM/SIGINT — flushes in-flight responses and DuckDB WAL

### Config
- `/Library/Application Support/Wicklee/config.toml` (macOS) or `/etc/wicklee/config.toml` (Linux) — node_id, fleet_url, session_token
- Fleet cloud: `wicklee.dev` (not wicklee.app)
- Agent port: 7700 (default)
- Proxy port: 11434 (intercepts Ollama, forwards to configured backend port)
- Cloud env: `DATABASE_URL` (Postgres, Railway auto-provides), `CLERK_JWKS_URL`, `RESEND_API_KEY`
- Agent uses DuckDB for local history (`store.rs`); cloud uses Postgres — different databases for different roles

## Cloud Backend (Rust — `cloud/src/main.rs`)

Fleet aggregation backend, deployed on Railway. Receives telemetry from agents, stores in **Postgres** (all tables — users, nodes, metrics, events, observations), and serves the fleet dashboard via SSE.

**Database:** Single Railway Postgres instance via `sqlx::PgPool` (async connection pool, 20 connections). Replaced SQLite + DuckDB in Phase 5 migration. TimescaleDB extension used if available (non-fatal if absent — nightly task handles retention via DELETE).

**Key tables:**
- `users`, `nodes`, `sessions`, `api_keys`, `notification_channels`, `alert_rules`, `alert_events` — transactional
- `metrics_raw` (TIMESTAMPTZ, 2-day retention), `metrics_5min` (rollup, 90-day retention) — time-series
- `node_events` (30-day retention), `fleet_observations` (stateful alert triage) — events/alerts

### Data Flow
```
Agent (2s push) → POST /api/telemetry → cloud MetricsPayload deserialize
  → in-memory HashMap<node_id, MetricsEntry> (live cache)
  → metrics_writer_task (30s batch flush → Postgres UNNEST INSERT, 1000 rows/chunk)
  → SSE /api/fleet/stream (2s interval, reads from live cache)
  → Fleet frontend (wicklee.dev)
```

The SSE stream serves `entry.metrics` verbatim from the in-memory cache. Any field dropped at the deserialization step is permanently lost — it never reaches the SSE stream, the fleet frontend, or Postgres history.

### Power Priority in Metrics Rows
`metrics_row_from_payload` resolves watts as: NVIDIA board power → Apple SoC (Combined CPU+GPU+ANE) → cpu_power_w fallback. `apple_soc_power_w` is the correct total for Apple Silicon WES; `cpu_power_w` alone is just the CPU cluster (~0.1W idle).

### WES — Wicklee Efficiency Score
WES = tok/s ÷ (watts × thermal_penalty). When thermal is Normal (penalty=1.0), WES = tok/s ÷ watts — a direct measure of tokens per watt. There is NO ×10 multiplier.

**Thermal penalties:** Normal=1.0, Fair=1.25, Serious=1.75, Critical=2.0

**Color scale (frozen — used by `wesColorClass` in `src/utils/wes.ts` and must match everywhere). Applies to both WES and tok/W:**
- `> 10` → Emerald (`text-emerald-400`) — Excellent
- `3–10` → Light Green (`text-green-300`) — Good
- `1–3` → Yellow (`text-yellow-400`) — Acceptable
- `< 1` → Red (`text-red-400`) — Low

These thresholds appear in: `wes.ts`, `Overview.tsx` (3 MetricTooltip ranges), `MetricsPage.tsx`, `AIInsights.tsx` (2 inline conditionals), `FleetHeaderBar.tsx`, `SiliconFitAudit.tsx`, `DocsPage.tsx`, and `public/metrics.md`. When changing the scale, ALL locations must be updated.

WES is computed client-side at render time from the live SSE payload — the agent sends `penalty_avg`, `penalty_peak`, `thermal_source` but does NOT pre-compute WES. The cloud backend computes WES for Postgres storage (`metrics_row_from_payload`) and the fleet alert evaluator.

## Frontend (React)

### Tech Stack
- React 19, Vite, Tailwind CSS (dark mode, `gray-950` background)
- Recharts for telemetry charts, Lucide React for icons
- Inter for UI text, JetBrains Mono for telemetry/logs

### Design Language
"Hardware-Centric Dark" — precise, dense, atmospheric. See `HANDOVER.md` for full design tokens.

### Key Patterns
- WebSocket to `localhost:7700/ws` for real-time metrics
- `inference_state` field from agent is the SSOT — no frontend re-computation. The fleet frontend (Overview.tsx on wicklee.dev) must use this field directly. Any client-side logic that infers live/idle from `ollama_inference_active` or `gpu_utilization_percent` will diverge from the agent's classification and must be removed.
- Local mode (unpaired) vs Fleet mode (paired) — gates AI Key Vault + Team Management
- Graceful fallback: if agent unavailable, show "Disconnected" with setup guide link

## Conventions
- Rust: no `unsafe` except NVML bindings. Minimal dependencies. `pub(crate)` for inter-module visibility.
- Frontend: Tailwind utility classes only (no custom CSS). Strict typing in `types.ts`.
- All metrics are real or explicitly labeled as unavailable — no mock values in production.

## AI/Agent Discovery Files (keep in sync)
When adding new API endpoints, metrics fields, or observation patterns, update ALL of these:
- `public/llms.txt` — Short LLM discovery file (endpoint list, key metrics, pattern inventory)
- `public/llms-full.txt` — Extended reference (full MetricsPayload schema, all endpoints with examples)
- `public/api.md` — Markdown API reference (endpoint tables, response examples)
- `public/openapi.json` — OpenAPI 3.0 spec (structured schema for agent integration)
- `public/.well-known/ai-plugin.json` — AI plugin manifest
- `public/robots.txt` — AI crawler permissions
- `src/pages/DocsPage.tsx` — Interactive documentation (user-facing)
- `docs/progress.md` — Release notes
- `CLAUDE.md` — Developer guide (this file)

## v0.7.12 — Inference Intelligence, Routing Hints, Model Enrichment (2026-04-07)

### Inference Intelligence (4 endpoints)
- `GET /api/profile?minutes=60` — correlated timeline (TTFT, KV cache, queue, thermal, power). Auto-scaling resolution.
- `GET /api/cost-by-model?hours=24` — per-model daily cost breakdown (model, hours, watts, cost USD)
- `GET /api/explain-slowdown?ts_ms=N` — root cause analysis: 6 hardware factors, ranked severity, natural-language summary
- `GET /api/model-comparison?hours=168` — side-by-side WES, tok/s, watts, TTFT, cost for all models that have run on this node
- Frontend: Cost by Model table on Overview, Inference Profiler chart on Performance tab
- Cloud MCP tools: `get_inference_profile`, `explain_slowdown` (Team+)

### Observation Routing Hints
- Per-observation `routing_hint`: `steer_away` | `reduce_batch` | `monitor`
- Node-level aggregate on `/api/observations` envelope: `routing_hint` + `routing_hint_source`
- Mapping: critical → steer_away; thermal/swap/VRAM/bandwidth → steer_away; queue/latency/TTFT → reduce_batch; WES/memory/clock → monitor

### Ollama Model Enrichment
- `context_length` and `parameter_count` from `/api/show` (cached on model change)
- Exposed in MCP `get_active_models` and MetricsPayload

### MCP Fixes
- `get_observations` and `get_metrics_history` now return live data (were redirecting to REST)
- Cloud MCP: rate limiting (600 req/60s) + org_id scope fix

## v0.7.10 — Inference Metrics Expansion, Patterns P/Q/R, Pro Features (2026-03-31)

### Inference Metrics (13 new fields, three-way sync)
- **vLLM gauges:** `vllm_requests_waiting`, `vllm_requests_swapped` from `/metrics` Prometheus endpoint
- **Ollama probe:** `ollama_prompt_eval_tps`, `ollama_ttft_ms`, `ollama_load_duration_ms` from 20-token probe
- **vLLM histograms:** `vllm_avg_ttft_ms`, `vllm_avg_e2e_latency_ms`, `vllm_avg_queue_time_ms` via delta tracking + `vllm_total_prompt_tokens`, `vllm_total_generation_tokens`
- **Proxy aggregates:** `ollama_proxy_avg_ttft_ms`, `ollama_proxy_avg_latency_ms`, `ollama_proxy_request_count` from done-packet accumulators

### Patterns ttft_regression / latency_spike / vllm_queue_saturation (total: 18 patterns)
- **`ttft_regression` (Pro):** TTFT slope > +5 ms/min with mean > 100 ms → fires
- **`latency_spike` (Pro):** Recent E2E latency > 1.5x baseline and > 500 ms
- **`vllm_queue_saturation` (Pro):** requests_waiting avg > 3 sustained → horizontal scaling needed
- `vllm_kv_cache_saturation` enhanced with queue depth context in body text

### Pro Features
- **Node Display Names** — `PATCH /api/nodes/:node_id`, SSE stream includes `display_name`, syncs across devices
- **7-Day History Enforcement** — `isRangeLocked()` uses `subscriptionTier` instead of `historyDays` proxy
- **Pattern Tier Filtering** — Agent evaluates all patterns; cloud `allowed_patterns_for_tier()` gates visibility. Community: 9 patterns, Pro: 18

### Pricing & Subscriptions
- **Paddle** replaces Stripe for payment processing
- **Team: $19/seat/mo** (3-seat min), 25 nodes, $50/50-node expansion
- **Enterprise: From $200/mo** — Proxy exclusive

### Dashboard Layout
- **Intelligence tiles (10 per dashboard):**
  - Cloud: Capacity · Fleet Health · Fleet VRAM · Fleet TTFT · Avg WES · Fleet GPU% · Fleet Cost/Day · W/1K · Fleet Memory · Fleet tok/W
  - Localhost: Capacity · Node Cost/Day · Node VRAM · Node TTFT · Runtime · Inference State · Node WES · W/1K · Node Memory · Node tok/W
- **Expandable Fleet Status rows** — click node row → detail panel with runtime-filtered metrics (Ollama: Load Duration, Prefill Speed; vLLM: E2E Latency, Queue Depth, KV Cache). ChevronDown indicator.
- **Two-column Diagnostics rail (localhost)** — Column 1: core hardware. Column 2: inference + latency metrics. Metrics conditionally shown by runtime.
- **TTFT resolution priority:** vLLM histogram (production) → proxy rolling avg (production) → Ollama probe (synthetic baseline)

### Pro Features (complete)
- **Custom Alert Thresholds** — 2 new event types: `ttft_regression` (500ms default), `throughput_low` (5 tok/s default). Backend evaluation + frontend Settings UI.
- **Persistent Insight Cards (Pro+)** — `obsCacheRef` seeded from `useFleetObservations` on page load. Dismiss → `POST /api/fleet/observations/:id/acknowledge`. Resolved History (24h) on Triage tab.
- **Node Naming & Tags** — Settings UI + `PATCH /api/nodes/:node_id` + SSE sync
- **Pattern Tier Filtering** — Agent evaluates all patterns; cloud `allowed_patterns_for_tier()` gates visibility. Community: 9 patterns, Pro: 18

### Security Hardening (v0.7.10)
- **Agent CORS restricted** — `allow_origin(Any)` → explicit localhost allowlist. Prevents JS telemetry theft from external domains.
- **Localhost-only bind** — Default `127.0.0.1:7700`. LAN access opt-in via `bind_address = "0.0.0.0"` in config.toml.
- **Fleet removal detection** — Cloud returns 410 Gone when node deleted; agent clears pairing and stops push loop.
- **FSL-1.1-Apache-2.0 License** — protects commercial tiers. Converts to Apache 2.0 after 4 years.

### UI / Design
- **Dark mode enforced** — Theme toggle removed. `<html class="dark">` in index.html. "Hardware-Centric Dark" is the only mode.
- **Action buttons** — all CTA buttons use `bg-blue-600` matching active sidebar nav.
- **Sidebar icons centered** in collapsed rail.
- **Bell icon removed** from header.
- **Empty state** — lightning icon removed, onboarding copy clarified, step badges blue.

### WES Color Scale (updated — replaces blue with emerald)
- `> 10` → Emerald (`text-emerald-400`) — Excellent
- `3–10` → Light Green (`text-green-300`) — Good
- `1–3` → Yellow (`text-yellow-400`) — Acceptable
- `< 1` → Red (`text-red-400`) — Low

## v0.7.8 — Per-Model WES Baseline, Launchctl Fix, Intel/Windows Thermal (2026-03-27)

### Per-Model WES Normalization
- `query_model_baseline(node_id, model)` in `store.rs` — 7-day DuckDB median tok/s + watts at Normal thermal, min 100 samples
- Background task (5s poll) detects model changes, caches `(baseline_tps, baseline_wes, sample_count)` in `Arc<Mutex<>>`
- New fields on MetricsPayload: `model_baseline_tps`, `model_baseline_wes`, `model_baseline_samples` (three-way sync)

### Launchctl Auto-Start Fix
- `service.rs`: Check if label is loaded before bootout (skip on fresh install). Poll for deregistration instead of fixed 3s sleep. 3s retry backoff.
- `install.sh`: Poll for label removal (10s timeout). Verify service running before success message.

### Intel Thermal (Linux)
- `coretemp` hwmon detection + per-core temp scanning + clock ratio tie-breaker
- Generic cpufreq fallback for non-AMD/non-Intel CPUs
- `thermal_source: "coretemp"` or `"clock_ratio"`

### Windows Thermal (WMI)
- `read_thermal_sysctl()` queries `MSAcpi_ThermalZoneTemperature` via wmic
- Tenths-of-Kelvin → Celsius conversion, standard state mapping
- WES sampler: NVML → Apple → Linux → WMI → unavailable
- `thermal_source: "wmi"`

## v0.7.7 — Patterns M/N/O, Pricing, API QA, Bug Fixes (2026-03-27)

### Observations — 18 Patterns + 5 Fleet Alerts
The observation engine covers 18 patterns plus 5 fleet alerts:
- **Agent-evaluated (17):** `thermal_drain`, `phantom_load`, `wes_velocity_drop`, `memory_trajectory`, `power_jitter`, `swap_io_pressure`, `clock_drift`, `nvidia_thermal_redline`, `vram_overcommit` (Community); `power_gpu_decoupling`, `bandwidth_saturation`, `efficiency_drag`, `pcie_lane_degradation`, `vllm_kv_cache_saturation`, `ttft_regression`, `latency_spike`, `vllm_queue_saturation` (Pro) — evaluated by the Rust agent against local 10-min DuckDB buffer every 10s. Pushed to cloud via telemetry.
- **Cloud-evaluated (1):** `fleet_load_imbalance` (Pro) — requires multi-node fleet context
- **Fleet alerts (5, all tiers):** `zombied_engine`, `thermal_redline`, `oom_warning`, `wes_cliff`, `agent_version_mismatch` — cloud evaluator, 60s cadence

### Agent (Rust)
- **Hostname in cloud_push** — `MetricsPayload.hostname` now populated from `gethostname()` so fleet dashboard shows real hostnames instead of only WK-XXXX identifiers
- **gpu_wired_limit_mb fix** — Apple Silicon unified memory budget now falls back to 75% of total RAM when `sysctl iogpu.wired_limit_mb` returns 0 (common on M4)
- **Power/memory in DuckDB history** — `store.rs` now writes `gpu_power_w` (resolved from SoC/NVIDIA/CPU sources) and `mem_pressure_pct` to `metrics_raw`, and reads them back in `query_observation_window()`. Fixes empty Power and Memory charts on Observability and Performance tabs.

### Cloud Backend
- **nginx IPv6 DNS fix** — Railway internal DNS (`fd12::10`) is IPv6; nginx `resolver` directive now brackets it as `[fd12::10]` to prevent parse errors. Resolves persistent 502s on `/api/v1/*` endpoints through `wicklee.dev`.
- **i64::MAX overflow guard** — `events/history` endpoint now caps `before` param to `now + 1 day` instead of using `i64::MAX`, preventing potential Postgres overflow.
- **Node online event dedup** — `ONLINE_DEBOUNCE_MS` (90s) prevents repeated "came online" events from telemetry jitter.

### Frontend
- **Pricing page** — three-tier grid (Community/Pro/Team) + Enterprise footer. State-aware buttons (Get Started / Upgrade / Current Plan). SubscriptionGuard wrapper for tier-gated content (40% opacity blur + upgrade CTA overlay).
- **API Keys management** — Settings tab for creating, listing, and revoking API keys. One-time reveal on creation, SHA-256 hashed at rest.
- **Live Activity seed fix** — DB event types that don't map to recognized FleetEvent types (startup, update, agent_version_mismatch) are now filtered out instead of defaulting to `node_online`. Fixes the "came online" flood.
- **Intelligence layout** — Best Route + Node Cost side-by-side, Inference Density + Silicon Fit side-by-side. Live Activity scrollable with fixed height matching GPU Utilization panel.
- **Documentation page updated** — full 15-pattern observation inventory, verified API endpoint reference for both localhost and cloud.

### API Endpoints — Verified Working (QA'd 2026-03-27)
**Localhost (no auth):**
- `GET /api/metrics` (SSE), `/api/observations`, `/api/history?node_id=`, `/api/traces`, `/api/events/history`, `/api/events/recent`, `/api/export?format=json|csv`, `/api/tags`, `/api/pair/status`

**Cloud v1 (X-API-Key auth):**
- `GET /api/v1/fleet`, `/api/v1/fleet/wes`, `/api/v1/nodes/:id`, `/api/v1/route/best`, `/api/v1/insights/latest`

### Build Pipeline
- **Nightly builds** — GitHub Actions compiles agent binaries for 5 platforms on every push to main. `install.sh` pulls the latest nightly. Tagged releases (e.g., `v0.7.7`) are created manually.
- **Frontend** — `npm run build` → `dist/` is deployed to Railway nginx container. Backend (Rust cloud binary) deploys separately on Railway from `cloud/` directory.
- **Cargo.toml version** — must be bumped manually; `env!("CARGO_PKG_VERSION")` is baked into the binary at compile time.

## v0.7.6 — Local Observations + Performance Tab (2026-03-26)

### Agent (Rust)
- **GET /api/observations** — evaluates 4 hardware patterns (A: Thermal Drain, B: Phantom Load, J: Swap Pressure, L: PCIe Degradation) against DuckDB 1-hour buffer
- `query_observation_window()` in `store.rs`, `evaluate_local_observations()` in `main.rs` (pure function)
- All observation structs gated behind `#[cfg(not(target_env = "musl"))]` (musl has no DuckDB)
- Cargo.toml version bumped to `0.7.6` (was stuck at 0.6.0 — caused stale version reporting)

### Key bugs fixed
- **nodes[] empty on localhost** — cloud node fetch was skipped, leaving `nodes.length === 0`. Now bootstrapped from `pairingInfo.node_id` in App.tsx
- **Cargo.toml version stale** — `env!("CARGO_PKG_VERSION")` reported 0.6.0 in all binaries since Phase 3B
- **musl CI failure** — observation structs referenced `store::ObsSample` without cfg gate
