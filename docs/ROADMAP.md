# Wicklee Roadmap 🛰️

> *Sovereign GPU fleet monitoring. Built for humans and their agents.*

---

## ✅ Shipped (v0.4.28)

**Agent Hardening Sprint (v0.4.21–v0.4.28)**
- **`HOME` resolution via `getpwuid` (v0.4.25)** — `config_path()` falls back to `/etc/passwd` when `$HOME` is absent. Fixes `/.wicklee/config.toml` (root-owned) appearing when systemd starts the service with no `HOME=` env var.
- **systemd unit `User=` + `Environment=HOME=` (v0.4.23)** — `--install-service` now emits correct user and HOME directives so future installs never experience the bad-HOME condition.
- **Multi-PID socket scan + config-locked runtimes (v0.4.26)** — `scan_runtimes()` collects all matching PIDs per runtime and prefers the non-default port (main vLLM server vs worker subprocess). TOML `[runtime_ports]` overrides excluded from the 30s rediscovery loop — the override can never be clobbered by dynamic detection.
- **Self-update EPERM hardening (v0.4.26)** — `install_service` chowns the binary to the service user so future `wicklee --update` calls succeed without `sudo`. `install.sh` re-runs `--install-service` automatically when a service is already registered. Clear actionable error message on `EPERM`.
- **vLLM IDLE-SPD idle probe (v0.4.27)** — `probe_vllm_tps()` POSTs a 20-token `/v1/completions` request when `vllm_requests_running == 0`; wall-clock timing gives a real hardware throughput baseline for the IDLE-SPD display state. Prometheus `avg_generation_throughput_toks_per_s` filtered at `> 0.1` so idle zeros don't overwrite the probe value.
- **Agent-local DuckDB history store (v0.4.28)** — `~/.wicklee/metrics.db`; three-tier schema written entirely in `agent/src/store.rs`. Tier 0: 1-Hz raw samples / 24h. Tier 1: 1-min aggregates / 30d. Tier 2: 1-hr aggregates with `PERCENTILE_CONT(0.95)` p95 / 90d. Idempotent hourly `run_aggregation()`. `GET /api/history?node_id=&from=&to=&resolution=auto` — distinct from the cloud-side DuckDB (Railway). Musl targets compile the module out entirely.

**UI Accuracy Fixes**
- **Apple Silicon detector** — replaced `cpu_power_w != null` with `memory_pressure_percent != null` throughout fleet UI. Linux RAPL populates `cpu_power_w` on AMD/Intel; `memory_pressure_percent` is strictly IOKit/macOS-exclusive. Fixes AMD node being mis-labelled "unified memory".
- **Fleet VRAM aggregator unified** — single `calculateTotalVramMb` / `calculateTotalVramCapacityMb` in `efficiency.ts` used by both Management and Intelligence tabs. Fixed `appleGpuBudgetMb` zero-guard (`??` → `!= null && > 0`) — when the macOS sysctl probe emits `gpu_wired_limit_mb = 0`, the Apple node now contributes the correct 75%-of-RAM estimate instead of zero to fleet VRAM totals.
- **Three-state TOK/S display** — LIVE (`vllm_requests_running > 0` or `ollama_inference_active`), BUSY (GPU% ≥ threshold), IDLE-SPD (probe/smoothed baseline). Tilde `~` prefix only on pure GPU%-estimated values; never on measured Prometheus or probe readings.
- **W/1K column** — Fleet Status table column shows watts-per-1k-tokens (matching "WATTAGE / 1K TKN" summary tile). Lower = more efficient. Units consistent across table and summary cards.

**Agent & Platform (v0.4.20 and earlier)**
- Rust agent, single binary — zero runtime dependencies, ~700KB
- Embedded React/Tailwind dashboard at `localhost:7700`
- Sudoless Deep Metal on Apple Silicon: CPU, GPU, Thermal State, Memory Pressure
- NVIDIA/NVML support: board power, VRAM used/total, GPU temp — sudoless on Linux
- **NVIDIA GB10 Grace Blackwell (DGX Spark) unified memory** — `MemApi::Unified` uses process residency for VRAM; no discrete framebuffer required. Three-way probe: V1 (discrete) → V2 (Hopper HBM) → Unified (GB10 / shared pool)
- Linux musl binaries — runs on Ubuntu 18.04+ with no glibc dependency
- Linux RAPL CPU power via `/sys/class/powercap` (kernel 5.10+)
- AMD Ryzen chip name detection from `/proc/cpuinfo`
- **ARM chip_name fallback** — `/sys/firmware/devicetree/base/model` for boards where `/proc/cpuinfo` has no `model name` (NVIDIA Grace, Ampere Altra)
- Windows support via NVML
- Global CLI install: `curl -fsSL https://wicklee.dev/install.sh | bash`
- PowerShell install: `irm https://wicklee.dev/install.ps1 | iex`
- **5-platform GitHub Actions release pipeline** (macOS, Windows, Linux x64/arm64, Linux arm64-nvidia)
- **NVIDIA auto-detection in install.sh** — all Linux arches: `nvidia-smi` / `/dev/nvidia0` → downloads `-nvidia` build automatically

**Fleet & Cloud**
- 6-digit pairing code — zero-config fleet connection
- Hosted fleet dashboard at `wicklee.dev` — Community Edition free up to 3 nodes
- Railway cloud backend with SQLite persistence (survives redeployment)
- Rate limiting: auth endpoints protected against brute force
- SSE fleet stream — live telemetry aggregated from all paired nodes
- Clerk authentication — hosted signup/login, JWT-based session management
- FleetStreamContext — single SSE connection shared across all dashboard components via React Context

**Inference Runtime**
- Ollama integration: auto-detect `localhost:11434`, model name, quantization, size
- 30-second sampled tok/s probe via `/api/generate` (num_predict=3)
- Wattage/1K TKN: live calculation from board power ÷ tok/s
- Cost/1K TKN: wattage × configurable kWh rate (default $0.13)
- **Process-first runtime discovery** — `process_discovery.rs` module. Declarative `RuntimeSpec` table; adding a new runtime = one entry, no other code changes. Watch channels (`PortRx`/`PortTx`) for reactive harvesters. 30s background scan loop.
- **Three-tier Priority of Truth port resolution:**
  - Tier 1: TOML override `[runtime_ports]` in `~/.wicklee/config.toml` (v0.4.19)
  - Tier 2: Cmdline arg scan — `--port N` / `--port=N` in argv; explicit-port process wins over worker subprocesses; joined cmdline matching for multi-token markers like "vllm serve" (v0.4.17/18)
  - Tier 3: Socket inode scan — `/proc/{pid}/fd/` ↔ `/proc/net/tcp6` — world-readable, no elevated permissions; resolves actual listening port for cross-user processes where cmdline is hidden (v0.4.20)

**UI**
- Fleet Overview: 6 real-time summary cards (all live data, no mock values)
- Node Registry: collapsible cards, real-time search, sort, status filter pills
- Live Activity feed: node online/offline, thermal state transitions, pairing events
- System Performance graph: CPU/GPU/Mem/Power selector, current session
- Version numbers synced: Cargo.toml, package.json, UI footer, GitHub Release tag

---

## Phase 3A — The Insight Engine + Agent Foundation *(Current)*

> Goal: make the data speak. Ship WES. Lay the agent-native groundwork.

### WES — Wicklee Efficiency Score *(v1 shipped, v2 in progress)*

**WES v1** ✅
- [x] WES formula: `tok/s ÷ (Watts_adjusted × ThermalPenalty)`
- [x] WES displayed as headline metric on node cards
- [x] WES in Fleet Intelligence aggregate panel
- [x] WES leaderboard in Insights tab
- [x] getNodeSettings() helper: per-node kWh, currency, PUE override

**WES v2 — Raw + Penalized + Thermal Cost** *(Sprint B + C — shipped)*
> Elevates WES from a snapshot to a window measurement. Introduces Thermal Cost %
> as a named, visible quantity. Makes thermal penalty legible to operators.

- [x] **Thermal sampling loop** — independent 2s sampling task. Maintains 30-sample rolling window (60s). Averages `penalty_value` → `penalty_avg`. Tracks `penalty_peak` for alerting.
- [x] **MetricsPayload additions** — `penalty_avg`, `penalty_peak`, `thermal_source` (`iokit` | `nvml` | `sysfs` | `unavailable`), `sample_count`, `wes_version: 2`. All optional — no breaking changes.
- [x] **Refined penalty mapping** — Serious: 1.75 (was 2.0), Critical: 2.0. ⚠ Breaking change to existing WES scores — version-stamp all benchmarks after this ships.
- [x] **NVML throttle reason bitmask** — `device.current_throttle_reasons()` (nvml-wrapper API). Multi-reason: 2.5, HW_THERMAL: 2.0, SW_THERMAL/HW_SLOWDOWN: 1.25, pre-throttle (>90°C, no bits): 1.1. Source tag = `nvml` — hardware-authoritative, overrides temperature inference.
- [x] **`SentinelMetrics` v2 fields** — `penalty_avg`, `penalty_peak`, `thermal_source`, `sample_count`, `wes_version` added as optional TypeScript fields. Backward-compatible — older agents that don't emit them continue to work.
- [x] **Thermal Cost % UI** — `computeRawWES()` + `thermalCostPct()` in `wes.ts`. `-N% thermal` amber badge in Fleet Status table when TC% > 0. Hidden on normal-thermal nodes.
- [x] **Fleet Leaderboard TC%** — `rawWes`, `tcPct`, `thermalSource` on every `WESEntry`. Ranks by penalized WES (operational reality); raw WES available for gap analysis. Best Route Now card shows `-N% thermal` below efficiency WES.
- [x] **"Why is my WES low?" tooltip v2** — `wesBreakdownTitle()` shows tok/s · Watts · Thermal · Thermal Cost % · Thermal source on all WES values. Diagnostic recommendation inline.
- [ ] ~~**`wes_config.json`**~~ → **moved to Phase 4B** as agent auto-calibration (see below).

### Local Intelligence Tab — Free Tier Insight Cards ✅
- [x] **Model-to-Hardware Fit Score:** Ollama model size + VRAM/unified memory + thermal state → "Poor/Fair/Good fit" with recommendation. Always shown when a model is loaded. Community-free.
- [x] **Thermal Degradation Correlation:** Named insight card fires when thermal_state = Serious|Critical. Shows estimated tok/s loss (based on v2 penalty table), causal chain, recommendation. Not dismissable.
- [x] **Power Anomaly Detection:** Fires when board power > 2× session baseline OR watts > 50W at < 20% GPU utilization. Flags runaway processes invisible to standard monitoring.
- [x] **Unified Memory Exhaustion Warning (Apple Silicon / NVIDIA):** Fires when headroom < 10% of total VRAM/unified memory with a model loaded. Warns before swap storm — not after.
- [x] **Model Eviction Prediction:** Fires at 3 min inactivity (2 min before default Ollama keep_alive). Free: warning card. Keep Warm fires silent 1-token ping. Community: 1 node.
- [x] **Idle Resource Notice:** Node idle ≥ 1 hr with zero inference. Shows $/hr estimate. Community-free. Clock resets on any tok/s > 0.

### Fleet Intelligence Panel ✅
- [x] **Live WES Leaderboard:** Ranked by penalized WES with TC% badge and thermal state indicator per node. Top 4 shown. Community-free — no history required.
- [x] **Fleet Thermal Diversity Score:** Live count of nodes per thermal state (Normal/Fair/Serious/Critical) in Fleet Intelligence panel. Cascade risk analysis teased — Team+.
- [x] **Fleet Inference Density Map:** Hexagonal hive plot — glowing pulse on active inference nodes, cold dim on idle. Visual utilization map, demo-video-ready.
- [x] **Idle Fleet Cost Card:** Daily electricity cost per idle node (watts × PUE × 24h × kWh rate). Per-node PUE from node settings. Fleet total shown when ≥ 2 idle nodes. Community-free.

### Settings ✅
- [x] **Cost & Energy section:** kWh rate, currency, PUE multiplier with live cost preview
- [x] **Node Configuration table:** per-node overrides for kWh, currency, PUE, location label
- [x] **Display & Units:** temperature units, power display, WES precision, theme
- [x] **Alerts & Notifications:** full Team+ UI — channel management (Slack/email), rule builder, test button. Community: upgrade prompt. Local mode: locked. (Phase 4A shipped)
- [x] **Account & Data:** agent version, pairing, export, danger zone
- [x] **Reset button polish:** column reset label shortened to "Reset"; right-aligned under kWh Rate and PUE to match column text alignment

### Fleet UI ✅
- [x] Fleet Status row redesign — fixed-width single-line grid
- [x] Fleet Intelligence aggregates — six fleet-level cards
- [x] Management page — four header tiles, fixed-width node table
- [x] Responsive layout — column priority hiding on both tables
- [x] Navigation restructure — single profile entry point lower left
- [x] Profile dropdown cleanup — identity, Settings, Docs, Release notes, Sign out

### Live Activity — New Event Types ✅
- [x] Power anomaly detected (`power_anomaly` event type — in EventFeed since Phase 3A)
- [x] Model eviction predicted (`model_eviction_predicted`) / Keep Warm action taken (`keep_warm_taken`) — emitted from AIInsights, logged to Live Activity
- [x] Thermal degradation confirmed (`thermal_degradation_confirmed`) — causal chain detail, fires on condition onset not every frame
- [x] Fit score changed (`fit_score_changed`) — fired when ollama_active_model changes (load/unload transition)

### Agent-Native Foundation ✅
> Wicklee is built for humans and their agents. The marketing site and blog
> are the first step — agents can discover and read Wicklee before the API exists.

- [x] **`/llms.txt`** — plain text index of site content and API surface for LLM consumption. The `robots.txt` for the agent era. Lists blog posts, API endpoints, MCP server (future), docs. Served at `wicklee.dev/llms.txt`.
- [x] **Blog at `/blog`** — Markdown files in `/public/blog/`. Rendered HTML for humans, raw `.md` route for agents. No CMS, no cost, git push is the publish action.
- [x] **Raw Markdown route** — every post served at `/blog/[slug]` (rendered) and `/blog/[slug].md` (raw text). Agents fetch the `.md` directly.
- [x] **Path-based routing** — `currentPath` state + `navigate()` + `popstate` listener in App.tsx. Blog routes bypass auth entirely.
- [x] **Blog nav link** — "Blog" added to LandingPage nav between Documentation and GitHub.
- [x] **Blog auto-discovery via Vite plugin** ✅ — `blogIndexPlugin` in `vite.config.ts` scans `public/blog/*.md` at build time and dev server start. Writes `public/blog/index.json` sorted by frontmatter `date`. Flow: drop a `.md` → push to GitHub → Railway runs `vite build` → post is live. Zero manual manifest edits.
- [x] **First post content:** `wes-the-mpg-for-local-ai-inference.md` — WES formula, thermal penalty table, four-node comparison, IPW academic citation (arXiv:2511.07885). Published `2026-03-15`.

### Launch Prep
- [x] Fix mock data on localhost fleet overview cards — `MOCK_NODES_INITIAL` removed; AI prompt uses real SSE data
- [ ] Andy_PC — install Ollama, capture RTX 3070 WES score
- [ ] RTX 4090 Vast.ai test (~$0.50/hr) — complete four-node comparison table *(capture after WES v2 ships)*
- [x] Update wicklee.dev hero — "Local AI inference, finally observable." + updated meta/OG tags
- [ ] GitHub repo description update
- [ ] Show HN: "I coined WES — the MPG for local AI inference. Apple M2 scores 181.5. Ryzen 9 7950X scores 0.14. Here's why."
- [ ] r/LocalLLaMA post
- [ ] Ollama Discord #showcase

---

## Phase 3B — Platform Completeness + Public Launch

> Goal: close hardware gaps, launch publicly, ship Agent API v1.

### Platform
- [x] **vLLM Integration:** ✅ Prometheus `/metrics` endpoint. Real tok/s without 30s probe. 2s polling loop, 5 metrics harvested (`vllm_running`, `vllm_model_name`, `tok/s`, `cache_usage_perc`, `requests_running`). Port resolved via three-tier discovery (TOML override → cmdline scan → socket inode scan) — works on any port, including cross-user deployments.
- [x] **Linux Thermal:** ✅ `/sys/class/thermal` — reads all `thermal_zone*/temp` entries, maps max to Normal/Fair/Serious/Critical. Closes the thermal state gap on GeiserBMC and similar bare metal nodes.
- [ ] **Windows Thermal:** WMI thermal data for Windows nodes. Annotated as "estimated" in UI — lowest data quality platform.
- [ ] **ANE Utilization:** Apple Neural Engine utilization and wattage — the metric Activity Monitor doesn't show.
- [ ] **macOS CPU Power (sudoless):** Entitlement-based `powermetrics` access without requiring root.
- [x] **Linux arm64-nvidia build** — `ubuntu-24.04-arm` native runner + CUDA aarch64 NVML headers. Enables DGX Spark and Ampere Altra + NVIDIA installs. install.sh auto-detects and downloads correct binary on all Linux arches.

### WES Platform Expansion
- [x] **AMD CPU thermal** — k10temp hwmon detection + clock ratio derivation. `cpuinfo_max_freq` cached once at harvester startup. `scaling_cur_freq` averaged across all logical CPUs every 5s. Ratio thresholds: ≥0.95→Normal(1.00), ≥0.80→Fair(1.25), ≥0.60→Serious(1.75), <0.60→Critical(2.50). Tdie > 85°C tie-breaker bumps to at least Serious. `thermal_source: "clock_ratio"` visible in WES breakdown tooltip. **Bonus fix:** generic sysfs path was returning "Elevated" (mapped to penalty 1.0 by default) for 70–79°C; corrected to "Fair" (1.25) — affects all non-AMD Linux nodes in the warm zone. `LinuxThermalResult` struct replaces bare `Option<String>` throughout, carrying state + source + direct_penalty for clean WES sampler integration.
- [ ] **Intel CPU thermal** — `thermald` zone states (Linux) with clock ratio fallback. Same `clock_ratio` source annotation.
- [x] **WES history chart** — per-node time series. Penalized WES as filled indigo area. Raw WES (hardware ceiling) as dashed reference line — only visible when thermal gap exists. ComposedChart with time-range gating: 1H/24H Community, 7D Pro, 30D/90D Team. "Collecting data…" empty state includes Pro nudge when Community. Primary visualization for the benchmark research series.
- [x] **Thermal Cost % alerts** — Info >10%, Warning >25%, Critical >40%. Rate-of-change escalation: TC% rise ≥15pp in rolling 30-frame window bumps severity one level. Cards suppressed when ThermalDegradationCard already firing (Serious/Critical state) to avoid double-alerting. `ThermalCostAlertCard` lives in Triage tab alongside existing Alert Quartet; dormant monitoring row shows peak TC% when below threshold.
- [x] **Benchmark report output format** — reproducible, citable snapshot: model, quantization, tok/s, watts, Raw WES, Penalized WES, Thermal Cost %, Thermal State+Source, WES version, Wicklee version. `buildReportFromLive()` + `buildReportFromHistory()` factory functions. `BenchmarkReportModal` with Markdown/JSON tab toggle, copy-to-clipboard, `.md` + `.json` download. Export button in Insights → Performance tab (live snapshot) and WES Trend chart header (history point).

### Agent API v1 ✅
> The first machine-readable interface to Wicklee fleet data.
> Agents are first-class consumers — same data as the dashboard, JSON over HTTP.

- [x] **`GET /api/v1/fleet`** — fleet summary, all nodes, current state, WES
- [x] **`GET /api/v1/fleet/wes`** — WES scores across all nodes, ranked
- [x] **`GET /api/v1/nodes/{id}`** — single node deep metrics
- [x] **`GET /api/v1/route/best`** — opinionated routing recommendation:
  ```json
  {
    "latency":    { "node": "WK-C133", "tok_s": 240, "reason": "Highest throughput" },
    "efficiency": { "node": "WK-1EFC", "wes": 181.5, "reason": "20x WES advantage" },
    "default":    "efficiency"
  }
  ```
- [x] **API key management** — dedicated API Keys tab in the dashboard (create / list / delete). Key format `wk_live_<32-hex>`. SHA-256 hashed at rest. One-time reveal on creation.
- [x] **Developer Portal** — Quick Reference panel: base URL, auth header, endpoint table, auto-populated curl snippet. Two-click delete confirm.
- [x] **"The Programmable Fleet" landing section** — between Sovereignty and How It Works. Three cards: Programmable Routing, Reactive Automation, Performance CI/CD.
- [x] **Rate limiting** — 60 req/min (Community) / 600 req/min (Team) as an operational throttle, not a feature gate. API access is available on all tiers; node count is the tier differentiator.
- [x] **Public documentation page at `/docs`** ✅ — un-gated, human and agent readable. Five sections: Quick Start (two-step sudo framing), WES Score (v2 penalty table, multiplicative framing), Agent API v1 (endpoints, route response, rate limits), Configuration (env vars, data retention tiers, Ollama proxy), Platform Support (agent OS matrix + metric-by-runtime matrix with KV Cache scoped to vLLM only). Wired from nav, footer, sidebar, and all public pages.

### Sovereignty (Observability tab section)
- [x] **Sovereignty section in Observability tab:** Telemetry destination card (fleet URL or "local only"), outbound connection manifest (Ollama probe / fleet telemetry / Clerk auth — with active/inactive status and data-type label per row), connection event log from FleetStreamContext (node_online/offline events, live pulse). Two sub-lists: what IS transmitted (CPU/GPU metrics, WES, model name) vs what NEVER leaves (inference content, prompts, responses). Replaces the old HostedPlaceholder on cloud dashboard — now the trust case is made explicitly at wicklee.dev, not just on localhost. Trace table remains localhost-only below.
- [ ] **Audit Log Export (Free):** Exportable pairing and telemetry history.

### Launch Content
- [ ] dev.to article — seed WES term, cite IPW paper, live fleet data
- [ ] LinkedIn article — enterprise/investor framing
- [ ] arXiv comment on 2511.07885 (Stanford/Together AI IPW paper)

---

## Phase 4A — Intelligence Depth + Insights AI *(in progress)*

> DuckDB write path shipped. 90-day history accumulating. Unlocks trend-based insights and AI-powered briefings.

### Infrastructure
- [x] **Agent-local DuckDB history store (v0.4.28)** — `agent/src/store.rs`. Three-tier schema at `~/.wicklee/metrics.db` (agent node, not cloud). `GET /api/history` endpoint on the agent's port 7700. Distinct from the cloud-side store below — enables offline local history with no cloud dependency. See agent hardening notes in Shipped section above.
- [x] **DuckDB Write Path — cloud backend (Phase 4A shipped `e8c6b47`):**
  - `metrics_raw` table: 24-hour rolling window at native 1 Hz. `metrics_5min` table: 90-day aggregate retention (5-minute buckets with pre-computed tok_s P50/P95).
  - ZSTD compression (level 3). Tiered retention via hourly rollup with EXISTS guard (no data loss on partial failure). Nightly CHECKPOINT + ANALYZE at 3 AM UTC.
  - `mpsc` channel (8 192-slot) + dedicated writer task → DuckDB Appender API (10-20× insert throughput). 30-second flush interval, 512-row safety valve.
  - Storage math: ~3 MB per user per 90 days (5-min aggregates). Railway 10 GB volume covers ~3 000+ users.
  - duckdb crate v1.10500.0 (bundled — compiles on Railway). `DUCK_DB_PATH` env var for volume mount.
  - `thermal_cost_pct` and `agent_version` columns reserved; populated when WES v2 ships (Phase 4B).
- [x] **Historical Performance Graphs:** `MetricsHistoryChart` — 4-metric selector (Tok/s / Power / GPU% / Mem%), per-metric gradient area chart (indigo/amber/violet/cyan). Backend: `GET /api/fleet/metrics-history` — 1h from `metrics_raw` (60s buckets), 24h–90d from `metrics_5min` aggregates. Dashed P95 reference line for tok/s on 24h+ ranges. Live SSE value as horizontal reference line. Time-range gating mirrors WES chart (1H/24H Community, 7D Pro, 30D/90D Team). Placed in Insights → Performance tab below WES Trend.
- [x] **Percentile Baselines (tok/s):** P95 dashed reference line for tok/s on `MetricsHistoryChart` when source is `metrics_5min` (24h+ ranges). P50/P95 cross-metric expansion (power, memory) remains open for a future pass.
- [ ] **Per-model WES normalization** — WES at 3B vs 70B is not directly comparable. Normalize against per-model historical baseline in DuckDB. Requires history to establish baseline before normalization is meaningful.

### Insights AI *(new)*
> Wicklee Insights tab becomes AI-powered. Natural language summaries, anomaly
> explanations, and routing recommendations — not hardcoded rules.

- [ ] **Settings → Insights & AI section:** Choose provider — Wicklee Cloud AI (Team Edition) / BYOK Anthropic / BYOK OpenAI / local Ollama endpoint.
- [ ] **Morning Briefing:** Daily fleet summary in plain English. "WK-1EFC ran 847 inferences yesterday at avg WES 134. WK-C133 thermal throttled 3 times — consider workload rebalancing."
- [ ] **Anomaly Explanation:** Natural language explanation of WES drops, thermal spikes, tok/s regression. Causal chain with recommended action — not just a state label.
- [ ] **`GET /api/v1/insights/latest`** — same briefing as JSON. Orchestration agents consume Wicklee intelligence, not just raw metrics.

### Pattern Engine — Deterministic Intelligence Briefing Feed *(Sprint 1 shipped)*

> Time-windowed rules engine. Patterns require sustained evidence (`minObservationWindowMs` gate)
> before firing — no false positives from model-loading spikes. Each insight carries a quantified
> hook ($/day or tok/s delta) and one-click copy actions. Complementary to the Alert Quartet
> (which fires on threshold crossings); patterns live in a new "Observations" section in Triage.

**Infrastructure (Sprint 1 ✅)**
- [x] **`useMetricHistory` hook:** 30s downsampled localStorage rolling buffer. 2,880 samples/node (24h). Stable push/getHistory/getRecent/getWindow/prune API. `metricsToSample()` applies 1024 MB VRAM filter at write time. No re-renders on push.
- [x] **`patternEngine.ts`:** Pure deterministic evaluator `evaluatePatterns()`. Same inputs → same outputs. Returns `DetectedInsight[]` with `hook`, `body`, `confidence` (building/moderate/high), `confidenceRatio`, tier gate, and copy-button actions.
- [x] **`ObservationCard`:** Intelligence briefing layout — quantified hook top-right (amber/violet/indigo by type), copy-to-clipboard action buttons (shell command or API endpoint), thin confidence progress bar while building.
- [x] **Triage tab wiring:** Observations section renders above Local AI Analysis when patterns fire; hidden when no observations active. Pattern evaluator throttled to 30s cycles; samples pushed on every telemetry frame.

**Pattern A — Thermal Performance Drain** (Community ✅)
- [x] 5-min observation window. Baseline tok/s drawn **only from Normal-thermal samples** so the delta is against the node's own clean-state performance, not a hot vs. slightly-less-hot comparison. Fires when sustained degradation >8%. Hook: `-X tok/s (Y% below Normal baseline)`. Actions: `/api/v1/route/best` endpoint + `curl` health check.

**Pattern B — Phantom Load** (Community ✅)
- [x] 5-min observation window. Fires when VRAM allocated + watts above idle AND zero inference activity. 1024 MB VRAM filter applied at `metricsToSample()` layer — BMC chips never trigger. Hook: `-$X.XX/day` at configured kWh rate. Actions: `ollama stop` + `ollama ps`.

**Sprint 2 — Planned**
- [ ] **Pattern C — WES Velocity Drop:** Rate-of-change on WES score over a 10-min window. "Early warning" pattern — fires before thermal state changes. `minObservationWindowMs` = 10 min (highest sensitivity → highest gate). Not in original INSIGHTS.md; new capability from localStorage history.
- [ ] **Pattern F — Memory Pressure Trajectory:** Rate-of-change on `memory_pressure_percent` → ETA to critical. Pure frontend, no DuckDB required — uses localStorage 24h history. Supersedes the DuckDB-required implementation in Phase 4A for the ETA calculation.
- [ ] **Observation dismissal:** Per-patternId dismiss (localStorage), resurfaces if condition persists >1h after dismiss.
- [ ] **Alert wiring:** Map pattern IDs to `alert_rules` event_types in the Slack/email delivery layer (Team+).

**Planned Patterns (future sprints)**
- [ ] **Pattern D — Power-GPU Decoupling:** High watts + low GPU% = runaway background process. 5-min gate. Cross-correlates board power and GPU utilization.
- [ ] **Pattern E — Fleet Load Imbalance (Team+):** One node saturated while others idle. Fires after 10 min imbalance. Routes recommendation via `/api/v1/route/best`.

### Paid Intelligence Insights
- [ ] **Memory Pressure Forecasting:** Rate-of-change on memory pressure → ETA to critical. "At current rate, this node hits critical in ~7 minutes." Slack alert at 15min and 5min thresholds. *(Pattern F covers frontend ETA; this item is the Slack alert layer.)*
- [ ] **Tok/s Regression Detection:** Current probe vs 7-day P50 baseline per node. Alert when >20% degradation.
- [ ] **Quantization ROI Measurement:** Per-model, per-quant tok/s and W/1K TKN stored in DuckDB. "Q4 vs Q8 on YOUR hardware at YOUR thermal state" — live hardware-specific answer.
- [ ] **Efficiency Regression per Model:** "WK-C133 used to run llama3.1:8b at 17 tok/s. It now runs it at 11 tok/s." Baseline history required. Slack alert when >20% regression.
- [ ] **Fleet Degradation Trend:** Fleet-wide tok/s trend over 7/30 days.

### Notifications
- [x] **Slack / Resend (Email) Webhook System:** Per-node, per-event-type configuration. Urgency levels: immediate, 5-min debounce, 15-min debounce. Slack Block Kit formatting + HTML email with plain-text fallback. 5-min flap suppression via `quiet_until_ms`. Resolution notifications sent when condition clears. Team+ only (`subscription_tier` column on `users` table; `402` for community).
- [x] **Alert Threshold Configuration:** Per-node thresholds for thermal_serious, thermal_critical, memory_pressure_high, wes_drop. Fleet-wide or scoped to a specific node. CRUD API: 7 handlers for channels and rules. Settings UI with full channel management (test button) and rule builder.
- [x] **node_offline detection:** Independent 60s Tokio interval task — stateful via `alert_events`, fires once per outage, resolves when node reconnects.
- [ ] **Idle Cost Weekly Digest:** "Fleet idle cost this week: $X" — emailed or Slacked Monday 9am.

---

## Phase 4B — Commercial Layer + Auto-Calibration *(3–5 months)*

### WES Auto-Calibration *(replaces static `wes_config.json`)*
> The agent learns its own thermal penalty thresholds from observed hardware reality,
> then gives the operator a single slider to tune the tradeoff — not a JSON file.

- [ ] **Observation phase (24h):** Agent watches the hardware using its local DuckDB history (v0.4.28). Records Peak TPS at cold-state (Normal thermal) and Sustained TPS under sustained load (Serious/Critical). Derives the actual penalty multipliers from measured tok/s ratio — not a guess.
- [ ] **`wes_config.json` auto-write:** After sufficient observation, the agent writes its own calibrated thresholds to `~/.wicklee/wes_config.json`. Versioned + timestamped. Human-readable but never needs manual editing.
- [ ] **"Efficiency vs. Performance" slider in Settings:** Replaces any direct JSON editing. Slide toward Efficiency: agent penalizes heat more aggressively (saves power, lower sustained throughput). Slide toward Performance: agent tolerates heat until hardware literally throttles. Slider position stored in `wes_config.json`; agent re-computes penalty curve on save.

- [x] **Clerk Auth:** ✅ Shipped. Clerk-managed signup/login with JWT. Stream tokens (UUID, 60s TTL) authenticate SSE connections.
- [ ] **Stripe + Team Edition Gate:** 3-node free limit enforcement with upgrade flow.
- [x] **Keep Warm (Community: 1 node · Paid: unlimited):** ✅ Wicklee sends a silent 1-token `/api/generate` ping to reset Ollama `keep_alive` timer before predicted eviction. All actions logged in Live Activity with precise timestamp. Always opt-in, always logged, always reversible.
- [ ] **CSV / JSON Export:** Any metric, any time range, any node.
- [x] **Cold Start Detection:** ✅ GPU spike + VRAM jump = cold start event. Hardware-pattern detection — no proxy or TTFT required. Sentinel Proxy (Phase 5) adds TTFT precision as an optional enhancement for advanced teams.
- [ ] **Event Detail Panel (Live Activity):** Clickable events with metrics snapshot at moment of event, precise timestamp, trigger reason, duration.
- [ ] **LLC Formation:** Wyoming or Delaware via Stripe Atlas or Doola.
- [ ] **Product Hunt launch**

---

## Phase 5 — Enterprise & Orchestration *(6+ months)*

> Goal: close the enterprise loop. Sovereign deployment, programmable orchestration,
> Prometheus-native observability, and MCP-native agent integration.

### Sentinel Proxy
- [ ] **Inference Interceptor:** OpenAI-compatible proxy endpoint. Clients point at Wicklee; Wicklee forwards to healthiest node.
- [ ] **Automatic Rerouting:** Transparent workload shifting on thermal/load threshold breach. No client changes required.
- [ ] **Routing Policy Config:** `lowest-wes`, `lowest-watt-per-token`, `lowest-thermal`, `lowest-load`, `round-robin`, `pinned` — selectable per model or client tag.

### MCP Server
> Wicklee as an MCP server. Any Claude, GPT, or open-source agent with MCP support
> calls Wicklee tools natively — no API wrapper required.
> Listed in `/llms.txt` from Phase 3A. Agents discover and connect automatically.

- [ ] **`wicklee_fleet_status()`** — all nodes, current state
- [ ] **`wicklee_best_route(goal)`** — "latency" or "efficiency" → node recommendation
- [ ] **`wicklee_node_metrics(id)`** — single node deep metrics
- [ ] **`wicklee_wes_scores()`** — WES leaderboard, all nodes
- [ ] **`wicklee_insights_latest()`** — latest AI briefing as structured data
- [ ] **MCP server at `wss://wicklee.dev/mcp`**
- [ ] **Listed in MCP registries** — Anthropic, open-source registries

### Observability Integrations
- [ ] **Prometheus Exporter:** `/metrics` endpoint in Prometheus exposition format. WES, thermal state, tok/s, power draw, VRAM, and cost/token as labeled time series. Scraped by the operator's existing Prometheus instance — no Wicklee-specific sink required.
- [ ] **Pre-built Grafana dashboard:** Fleet WES trend panel, thermal cost heatmap, node efficiency ranking. Importable JSON — drop into any Grafana instance.
- [ ] **OpenTelemetry span export *(planned)*:** Inference request traces with TTFT and TPOT labels. Feeds directly into Jaeger, Honeycomb, Datadog.

### NVIDIA Accelerator Tier
> Applies broadly to Hopper, Blackwell datacenter, and GB10 Grace Blackwell. Not GB10-specific.
> RTX 4090/5090 (the primary local inference segment) is unaffected — they have no NVLink and
> already work on the current NVML path.

**Type contract stubs (shipped ✅)**
- [x] `vram_is_unified` — unified vs. discrete VRAM flag (GB10/Grace only). Null on Apple Silicon.
- [x] `cooling_type` — `'active' | 'passive'`. Pattern A uses a lower thermal trigger on passive nodes.
- [x] `wes_tier` — `'workstation' | 'server' | 'accelerator'`. Prevents cross-tier WES comparisons.
- [x] `gpu_count` + `host_id` — multi-GPU node grouping contract (DGX H100/B200).
- [x] `nvlink_peer_node_id` — NVLink bond stub. Pattern E skips independence assumption for bonded pairs.
- [x] `nvlink_bandwidth_gbps` — inter-node NVLink utilization, populated by NVML when peer is set.
- [x] `MIGInstance` interface — profile, vram_used/total, gpu_util_pct, power_draw_w.
- [x] `mig_instances?: MIGInstance[]` on `SentinelMetrics`.

**Platform Detection & Badges (planned)**
- [ ] **Node platform badge** in Fleet Status NODE cell — `M3 Max` / `RTX 4090` / `H100 SXM` / `GB10`. Color-coded by tier (gray workstation · blue accelerator). Zero new columns.
- [x] **Unified memory handling in Rust agent** — `MemApi::Unified` detects when NVML returns zero VRAM (GB10/shared pool) and falls back to process residency accounting. `total_mb` = system RAM; `used_mb` = sum of `nvmlDeviceGetComputeRunningProcesses()` used bytes. Hardware-agnostic: covers GB10, future SoCs with shared pools.
- [x] **`NVIDIA · Unified Memory` identity label in UI** — `nvidia_vram_total_mb >= total_memory_mb * 0.9` heuristic detects unified pool without requiring an explicit flag from the agent.
- [ ] **`vram_is_unified` explicit flag in agent** — emit the typed boolean field so UI doesn't need the heuristic. Phase 5 cleanup.
- [ ] **`cooling_type` detection** — passive if device name contains "Spark" or DGX SKU; active otherwise.
- [ ] **NVLink peer detection** — `nvmlDeviceGetNvLinkState` on all links; resolve peer UUID to Wicklee node_id; populate `nvlink_peer_node_id` + `nvlink_bandwidth_gbps`.

**Fleet Status UI (planned)**
- [ ] **Expandable node detail drawer** — click any row → slide-in panel with platform-specific depth. Apple: ANE + wired budget. RTX: GDDR6X BW + PCIe. H100: HBM3 BW + MIG slices + NVLink peer. GB10: unified pool + passive thermal headroom.
- [ ] **MIG slice sub-rows** — nodes with `mig_instances` get a ▶ expander. Slices render as virtual sub-rows with independent WES/VRAM/tok/s. No NodeAgent rearchitecture needed.
- [ ] **Multi-GPU host grouping** — nodes sharing `host_id` collapse under a single host header row with aggregate metrics. Sub-rows expand per GPU. Near-term: agent reports each GPU as a separate stream with shared `host_id` prefix.
- [ ] **NVLink bonded pair indicator** — Fleet Status shows a link icon between bonded nodes; VRAM aggregation treats them as one logical unit.

**WES Tier Normalization (planned)**
- [ ] **`wes_tier` baseline calibration** — Workstation: M3/RTX reference. Server: EPYC+A100. Accelerator: H100/GB10. WES normalizes within tier; cross-tier shows `relative_wes` (Workstation = 1.0×).
- [ ] **Adaptive tile labels** — "Total Fleet VRAM" tile subtitle adapts to `vram_is_unified` nodes (`Unified Alloc` per row). NVLink topology tile surfaces only when ≥ 2 bonded nodes detected.

### Orchestration Integrations
- [ ] **vLLM / Ray Serve awareness:** Consume vLLM's Prometheus `/metrics` endpoint at the orchestration layer. Surface per-model queue depth, KV cache hit rate, and TTFT alongside WES. Enables WES-aware routing across multi-model vLLM deployments.
- [ ] **Ray Serve backend support:** Register Ray Serve replicas as Wicklee nodes. WES computed from Ray's built-in metrics. Route decisions account for replica thermal state.
- [ ] **MIG (Multi-Instance GPU) awareness:** Detect NVIDIA MIG-partitioned instances via NVML. Report WES per MIG slice with correct power and VRAM fractions. Prevents over-routing to thermal-limited partitions.

### Sovereign Deployment
- [ ] **Sovereign Mode:** On-premise only — no cloud pairing, no outbound telemetry, airgapped operation. The key Enterprise differentiator.
- [ ] **Docker image:** Self-hosted fleet backend. Single-container deploy — agent + cloud backend in one image.
- [ ] **Helm chart:** Production-grade Kubernetes deployment with configurable replicas, PVCs, and ingress. Operators bring their own cluster.
- [ ] **Kubernetes Operator:** Fleet nodes register via in-cluster service discovery. No cloud relay, no external DNS. Deploy to any K8s namespace.
- [ ] **Cryptographically Signed Audit Export:** PDF signed by the Wicklee Agent's unique hardware ID (WK-XXXX). Tamper-evident. CISO-ready compliance artifact for HIPAA, financial services, defense-adjacent deployments.

### Enterprise Features
- [ ] SSO / SAML (Okta, Azure AD, Google Workspace)
- [ ] HIPAA / SOC2 BAA
- [ ] AMD GPU support (ROCm)
- [ ] Enterprise tier pricing ($199/mo)

---

## Tier Structure

| | Community | Team | Enterprise |
|---|---|---|---|
| Nodes | Up to 3 | Unlimited | Unlimited |
| Local dashboard | ✅ Full | ✅ Full | ✅ Full |
| Live metrics (all) | ✅ Full | ✅ Full | ✅ Full |
| Inference runtime (Ollama/vLLM) | ✅ Full | ✅ Full | ✅ Full |
| WES scores (Raw + Penalized) | ✅ Full | ✅ Full | ✅ Full |
| Fleet Intelligence panel | ✅ View | ✅ Full + alerts | ✅ Full |
| Agent API v1 ¹ | ✅ | ✅ | ✅ |
| `/api/v1/route/best` | ✅ | ✅ | ✅ |
| Local Intelligence (session) | ✅ Free cards | ✅ Full + alerts | ✅ Full |
| 24h session history (localStorage) | ✅ | ✅ | ✅ |
| Quantization ROI (live session) | ✅ | ✅ | ✅ |
| Local Intelligence (trend-based) | ❌ | ✅ Paid | ✅ Full |
| Insights AI (morning briefing) | ❌ | ✅ | ✅ |
| `/api/v1/insights/latest` | ❌ | ✅ | ✅ |
| Keep Warm (1 node free · unlimited paid) | ✅ 1 node | ✅ Unlimited | ✅ Unlimited |
| 90-day history | ❌ | ✅ | ✅ |
| Slack / PagerDuty | ❌ | ✅ | ✅ |
| MCP server tools | ❌ | ✅ | ✅ |
| Sovereignty audit log | ✅ View | ✅ View | ✅ Signed export |
| Sentinel Proxy routing | ❌ | ❌ | ✅ |
| Sovereign Mode (no cloud) | ❌ | ❌ | ✅ |
| Price | Free | ~$29/mo | ~$199/mo |

*¹ Agent API v1 is available on all tiers. Rate limits are operational throttles (60 req/min Community · 600 req/min Team · unlimited Enterprise), not feature gates. The tier differentiator is the node count limit in the "Nodes" row above.*

---

## The Agent-Native Vision

> Most SaaS is built for a human who logs in, reads a dashboard, and makes a decision.
> Wicklee is built for humans **and their agents**.

The local dashboard at `localhost:7700` is the human interface — sovereign, zero-login, always available.

The Agent API and MCP server are the agent interface — the same fleet intelligence, machine-readable, consumable by any orchestration agent that needs to know which node to route to next.

An agent running a multi-step inference pipeline calls `wicklee_best_route("efficiency")` before every dispatch. No human in the loop. No dashboard required. Wicklee becomes the routing brain for sovereign AI fleets — whether the decision-maker is a human or their agent counterpart.

**The progression:**
```
Phase 3A  →  /llms.txt + Markdown blog     agents can discover and read Wicklee       ✅
Phase 3B  →  Agent API v1                  agents can query live fleet data            ✅
Phase 4A  →  /api/v1/insights/latest       agents can consume Wicklee intelligence
Phase 5   →  MCP server                    agents call Wicklee tools natively
```

---

*Wicklee is sovereign infrastructure. Your fleet data never leaves your network until you choose.*
*Built for humans and their agents.*
