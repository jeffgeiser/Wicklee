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

### Observability Tab — Phase 3B Foundations

> **Tab role:** The Observability tab is the verification layer — not the intelligence layer.
> It surfaces raw evidence: inference traces, metric history, sovereignty audit, and agent health.
> Patterns, WES scoring, and recommendations belong in Intelligence/Insights.
> The full scope is specified in `docs/SPEC.md → Observability Tab Specification`.
>
> **Build order across phases:**
> - Phase 3B → Inference Traces (TracesView) + Sovereignty Audit *(this section)*
> - Phase 4A → Raw Metric History ("View source →" panel) + Agent Health panel
> - Phase 4A Sprint 6 → Dismissal Log
>
> **Phase 5 Prometheus/Grafana/OTel are export mechanisms** configured in
> Settings → Integrations — not Observability tab content. The tab is sovereign and
> requires no external sink.

- [x] **Inference Traces (TracesView):** DuckDB-backed trace table, scoped to agent-local `metrics.db`. Always localhost-only — traces never transit the cloud backend (sovereignty boundary). Primary evidence surface for "why did this recommendation fire?".
- [x] **Sovereignty Audit section:** Telemetry destination card (fleet URL or "local only"), outbound connection manifest (Ollama probe / fleet telemetry / Clerk auth — with active/inactive status and data-type label per row), connection event log from FleetStreamContext (node_online/offline events, live pulse). Two sub-lists: what IS transmitted (CPU/GPU metrics, WES, model name) vs what NEVER leaves (inference content, prompts, responses). Replaces the old HostedPlaceholder on cloud dashboard — the trust case is explicit at wicklee.dev.
- [ ] **Audit Log Export (Free):** Exportable pairing and telemetry history.

### Launch Content
- [ ] dev.to article — seed WES term, cite IPW paper, live fleet data
- [ ] LinkedIn article — enterprise/investor framing
- [ ] arXiv comment on 2511.07885 (Stanford/Together AI IPW paper)

---

## Phase 4A — Automated Insight Briefing *(in progress)*

> Architecture principle: **deterministic over generative**. Every finding is reproducible,
> citable, and sovereign. DuckDB history is the source of truth. No LLM dependency in the
> core intelligence loop — AI is an optional Phase 5 enhancement.

### Infrastructure ✅
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
- [x] **Hardware-derived node ID (v0.4.29)** — `generate_node_id()` reads `/etc/machine-id` (Linux), `IOPlatformUUID` via `ioreg` (macOS), or `MachineGuid` registry key (Windows). XOR-folds to stable WK-XXXX suffix. Timestamp fallback for containers/live ISOs. Existing paired nodes unaffected — `load_or_create_config()` only calls this on first run.
- [ ] **Per-model WES normalization** — WES at 3B vs 70B is not directly comparable. Normalize against per-model historical baseline in DuckDB. Requires history to establish baseline before normalization is meaningful.

---

### Pattern Engine — Deterministic Intelligence ✅

> Pure math on time-series data. Same inputs → same outputs — always. No API key, no cloud
> call, no hallucination surface. Patterns require sustained evidence before firing;
> each finding carries a quantified hook and a directed recommendation.

**Infrastructure (Sprint 1 ✅)**
- [x] **`useMetricHistory` hook** — 30s downsampled localStorage rolling buffer. 2,880 samples/node (24h). Stable push/getHistory/getRecent/getWindow/prune API. `metricsToSample()` applies 1024 MB VRAM filter at write time. No re-renders on push.
- [x] **`patternEngine.ts`** — Pure deterministic evaluator `evaluatePatterns(input)`. Returns `DetectedInsight[]` with `hook`, `body`, `confidence`, `confidenceRatio`, tier gate, copy-button actions.
- [x] **`ObservationCard`** — Intelligence briefing card: quantified hook (top-right), copy actions, confidence progress bar, dismiss with 1h resurface.
- [x] **Triage tab wiring** — Observations section above Alert Quartet. Evaluator throttled to 30s cycles.

**Pattern A — Thermal Performance Drain (Community ✅)**
- [x] 5-min window. Baseline tok/s from Normal-thermal samples only — delta against clean-state, not hot vs. slightly-less-hot. Fires at >8% degradation. Hook: `-X tok/s (Y% below baseline)`.

**Pattern B — Phantom Load (Community ✅)**
- [x] 5-min window. VRAM allocated + watts above idle + zero inference = wasted $/day. 1024 MB VRAM filter — BMC chips never trigger. Hook: `-$X.XX/day`.

**Pattern C — WES Velocity Drop (Community ✅)**
- [x] 10-min window. OLS slope on WES over rolling window. Fires when slope is negative AND total drop >10%. Early warning — fires before thermal state transitions. Highest gate (`minObservationWindowMs` = 10 min) because earliest signal.

**Pattern F — Memory Pressure Trajectory (Community ✅)**
- [x] 10-min window. Linear regression on `memory_pressure_percent` → ETA to 85% critical threshold. Fires when projected ETA < 30 min. Pure localStorage history — no DuckDB required.

---

### Sprint 3 — Prescriptive Recommendations ✅

> Give every finding a voice. A graph showing "WES Velocity Drop" is a warning;
> a directive saying "Move the 70B model to WK-1EFC — online, Normal thermal,
> within 8% throughput parity" is a solution.

- [x] **`recommendation: string` on `DetectedInsight`** — prescriptive 1–2 sentence operator action, fleet-availability-aware and hardware-tier-aware. Derived from the node's own localStorage history, not platform averages.
- [x] **`action_id: ActionId` on `DetectedInsight`** — typed machine-readable directive for agent consumers. Enum: `rebalance_workload` | `evict_idle_models` | `reduce_batch_size` | `check_thermal_zone` | `investigate_phantom` | `schedule_offpeak`.
- [x] **`FleetNodeSummary[]` context in `PatternInput`** — cross-node awareness for recommendations. Pattern evaluator receives live fleet state (online status, thermal state, WES, VRAM headroom, wesTier) alongside per-node history. Built in AIInsights.tsx from allNodeMetrics on every eval cycle.
- [x] **Node-availability gate on routing recommendations** — `bestAlternativeNode()` helper: candidates must be `isOnline === true` + Normal thermal state; sorted by WES descending, VRAM headroom as tiebreaker. When no candidate qualifies the recommendation falls back to local mitigation (airflow / workload reduction).
- [x] **Hardware-tier-aware recommendation text** — `wes_tier === 'accelerator'` nodes (H100/B200/GB10) receive preservation-first directives ("route lower-priority requests to preserve accelerator capacity"); workstation/server nodes receive standard rerouting copy. The `wes_tier` field in `SentinelMetrics` is the discriminator.
- [x] **`ObservationCard` Sprint 3 UI** — "Recommended Action" panel (indigo-tinted, lightbulb icon) renders `recommendation` text + `ActionIdBadge` colored pill between body and copy buttons. Hidden when insight is resolved.

  | Pattern | Recommendation source | ActionId |
  |---|---|---|
  | Thermal Drain | Fleet peer lookup → named node or local mitigation | `rebalance_workload` / `check_thermal_zone` |
  | Phantom Load | Exact `ollama ps` + `ollama stop` workflow | `evict_idle_models` |
  | WES Velocity Drop | Fleet peer + ETA-aware urgency | `rebalance_workload` / `check_thermal_zone` |
  | Memory Trajectory | Specific unload workflow with process check | `evict_idle_models` |
  | Power-GPU Decoupling | Quantization + batch tuning directives | `reduce_batch_size` |
  | Fleet Load Imbalance | Named target node + thermal recovery advice | `rebalance_workload` |

- [x] **Pattern D — Power-GPU Decoupling (Pro tier):** Inference is active (tok/s > 0) but GPU utilization is anomalously low (<20%) while drawing >50W — suggests CPU-bound or memory-bound workload (large context KV cache, CPU-offloaded layers, or under-saturated batch size). 5-min gate. `action_id: reduce_batch_size`. Distinct from Pattern B (phantom load): Pattern B fires when there is NO inference; Pattern D fires when inference IS running but the GPU isn't being fully utilized.
- [x] **Pattern E — Fleet Load Imbalance (Pro tier):** This node is thermally stressed OR WES is >20% below the fleet's best peer, while that peer is online in Normal thermal state. Cross-node pattern — requires `FleetNodeSummary[]` context. Names the target node in the recommendation. `action_id: rebalance_workload`.

---

### Sprint 4 — Morning Briefing Card

> Always rendered. Zero external calls. The Pattern Engine's findings, surfaced as a
> pinned daily summary at the top of the Triage tab.

- [x] **`InsightsBriefingCard` — core shell:** Pinned at top of Triage tab. 24h localStorage event buffer — onset / resolved / dismissed rows sourced from `insightLifecycle.ts`. Three-tier logging: Live Activity Feed (FleetEvent) → localStorage 24h buffer (InsightRecentEvent) → metrics.db Sprint 6 audit trail. Dedup per `patternId × nodeId` pair with `×N in 24h` count badge. 60s refresh interval. Collapsible with ChevronDown toggle. Empty state: compact dormant row.
- [x] **Node-availability gating:** `useFleetStream()` resolves live `isOnline` status at render time — stale routing recommendations show amber `StaleNodeWarning` banner (WifiOff icon) or `DegradedNodeWarning` (AlertTriangle icon). `resolveNodeStatus()` returns `'online' | 'offline' | 'degraded' | 'unknown'`. `ONLINE_GATE_MS = 90s` mirrors the AIInsights constant. Routing action suppressed when node is offline; operator directed to `/api/v1/route/best` for current target.
- [x] **Onset suppression + resolution logging:** `patternOnsetMapRef` tracks last emit time per `${patternId}:${nodeId}`. `ONSET_SUPPRESSION_MS = 15m` (> `OBS_HOLD_MS = 10m`) creates a 5-minute quiet window after resolution. `wes_at_onset` captured at exact onset moment for "WES 181.5 → 142.0" diffs. `durationMs = lastSeenFiringMs − onsetMs` (excludes hold wait — reflects actual stress time).
- [ ] **Fleet Pulse (live) section:** Nodes online/total · total fleet tok/s · top WES node + score · fleet idle cost if applicable.
- [ ] **Head-to-head comparison** (when ≥ 2 nodes with stable hardware IDs): "WK-99E9 is 12× more efficient than WK-C133 for this model class." Anchored to matching model size class from history — apples to apples. Only shown when both nodes have run the same model class within the window.
- [ ] **Top Finding + Recommendation** — Highest-confidence active pattern displayed with its `recommendation` string and `action_id` as a copy-able curl command.
- [ ] **"View source →" links** — each finding navigates directly to the exact DuckDB graph (WES Trend, Metrics History, or Memory chart) that produced the finding, pre-scoped to the triggering time window. Reinforces the "Silicon Truth" principle: every recommendation is one click from its evidence. Requires Phase 4A Raw Metric History panel (see Observability Tab additions below).

---

### Sprint 5 — `GET /api/v1/insights/latest` (All tiers)

> Deterministic JSON. Always returns something meaningful. No LLM. Agents get
> a machine-readable directive; humans get the same data rendered in the Briefing Card.

- [ ] **`action_id` as Primary Key for automation** — the `action_id` field is not a UI label; it is the machine directive. An orchestration agent calling this endpoint receives everything it needs to act without a follow-up lookup: the `action_id` tells it *what* to do; `best_online_node` tells it *where* to do it. No second API call required.
- [ ] **Endpoint on cloud backend** — returns structured fleet briefing:
  ```json
  {
    "generated_at_ms": 1742000000000,
    "fleet_pulse": {
      "nodes_online": 2, "nodes_total": 3,
      "fleet_tok_s": 84.4,
      "top_wes_node": { "node_id": "WK-1EFC", "wes": 181.5 }
    },
    "findings": [
      {
        "pattern_id": "thermal_drain",
        "node_id": "WK-99E9",
        "hook": "-4.2 tok/s",
        "recommendation": "Move batch workloads to WK-1EFC — online, Normal thermal, within 8% throughput parity",
        "action_id": "rebalance_workload",
        "best_online_node": {
          "node_id": "WK-1EFC",
          "hostname": "JEFFs-MacBook-Pro-2",
          "tok_s": 32.5,
          "wes": 181.5,
          "thermal_state": "Normal",
          "vram_headroom_pct": 43
        },
        "confidence": "high"
      }
    ],
    "top_recommendation": {
      "action_id": "rebalance_workload",
      "text": "Move batch workloads to WK-1EFC — online, Normal thermal, within 8% throughput parity",
      "best_online_node": "WK-1EFC"
    }
  }
  ```
- [ ] **Available on all tiers** — deterministic data, not a paid AI feature. Rate-limited at same tiers as other v1 endpoints.

---

### Observability Tab — Phase 4A Additions

> The Observability tab gains its evidence panels in Phase 4A, completing the
> "one click from recommendation to raw data" chain started by the Morning Briefing Card.
> See `docs/SPEC.md → Observability Tab Specification` for section definitions.

- [ ] **Raw Metric History panel** — DuckDB time series charts in the Observability tab. WES Trend, tok/s, thermal state, and power draw — per node, with 1H/24H/7D/30D/90D time-range selectors (range gated by tier). Pre-scopable by time window from Briefing Card "View source →" links. Evidence layer only — no pattern scoring, no recommendations.
- [ ] **Agent Health panel** — Harvester status, SSE connection health, DuckDB write path status, last successful write timestamp. Visible in Observability tab. Answers "is the data pipeline working?" without leaving the tab. Complements the Sovereignty Audit section already present.

---

### Sprint 6 — Pattern Dismissal Audit Trail

> Move dismissals from ephemeral localStorage to `metrics.db` — persistent, cross-session,
> operator-annotatable. Prevents Morning Briefing from becoming notification spam.

- [ ] **`POST localhost:7700/api/insights/dismiss`** — writes to `accepted_states` table in agent-local `metrics.db`.
  ```sql
  CREATE TABLE accepted_states (
    pattern_id   TEXT,
    node_id      TEXT,
    accepted_at  BIGINT,   -- ms epoch
    expires_at   BIGINT,   -- NULL = permanent accept
    note         TEXT      -- optional operator annotation
  );
  ```
- [ ] **Permanent accept option** — for legitimate operational states (intentionally idle node, intentional phantom load). Resurface suppressed.
- [ ] **Dismissal Log section in Observability tab** — persistent audit surface showing all `accepted_states` rows: `pattern_id`, `node_id`, `accepted_at`, `expires_at`, operator note. Completes the Observability tab's four sections (Traces, Raw Metric History, Sovereignty Audit, Agent Health + Dismissal Log). The dismissal record belongs in the verification layer — not the intelligence layer.
- [ ] **Alert wiring** — map pattern IDs to `alert_rules` event_types in Slack/email delivery layer (Team+).

---

### Paid Intelligence (DuckDB history required)
- [ ] **Tok/s Regression Detection:** Current probe vs 7-day P50 baseline per node. Alert when >20% degradation.
- [ ] **Quantization ROI Measurement:** Per-model, per-quant tok/s and W/1K TKN in DuckDB. "Q4 vs Q8 on YOUR hardware at YOUR thermal state."
- [ ] **Efficiency Regression per Model:** "WK-C133 used to run llama3.1:8b at 17 tok/s. Now 11 tok/s." Slack alert at >20% regression.
- [ ] **Fleet Degradation Trend:** Fleet-wide tok/s trend over 7/30 days.
- [ ] **Memory Pressure Slack Alert:** Pattern F covers frontend ETA; this is the Slack delivery layer at 15min and 5min thresholds.

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

## Phase 5 — Enterprise, Orchestration & Optional AI *(6+ months)*

> Goal: close the enterprise loop. Sovereign deployment, programmable orchestration,
> Prometheus-native observability, MCP-native agent integration, and — for power users
> who want it — optional natural language queries over their own fleet history.

### Chat with your Fleet Data *(optional, power user)*

> The only LLM feature in Wicklee. Optional. Never required. Zero data egress when
> using local Ollama. The deterministic Pattern Engine is the brain; this is the voice.

- [ ] **Provider config in Settings → Intelligence:** Local Ollama (sovereign, proxied through agent at `localhost:7700`) · BYOK Anthropic · BYOK OpenAI. All calls are client-side — no fleet data transits Wicklee servers in BYOK mode.
- [ ] **Grounded query architecture:** Every question is answered by running a deterministic DuckDB query first, injecting the real results as context, then asking the LLM to interpret. The LLM is a translator, not a sensor — it cannot invent fleet metrics it hasn't been given.
  ```
  User: "Why was my fleet slow last Tuesday?"
      ↓
  Query planner (deterministic) → SELECT from metrics.db / cloud DuckDB
      ↓
  Real data injected as structured context
      ↓
  LLM: interprets, explains, formats — never invents
  ```
- [ ] **Example queries:** "Which quantization performs best on the Spark?" · "How much has idle cost changed this month?" · "When was WK-C133 last at Normal thermal?" · "Compare my two nodes head-to-head over the last 7 days."
- [ ] **Chat panel in Intelligence tab** — clearly labeled "Chat with your data (requires AI provider configured)". Raw query results always shown alongside narrative — operators can verify any number.
- [ ] **`wicklee_insights_latest()` MCP tool** — exposes the deterministic briefing JSON to MCP-capable agents. The same data the Briefing Card shows, in tool-call format. No LLM required for the data; LLM optional for interpretation.

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
- [ ] **`wicklee_insights_latest()`** — deterministic briefing as structured data (pattern findings + recommendations + fleet pulse)
- [ ] **MCP server at `wss://wicklee.dev/mcp`**
- [ ] **Listed in MCP registries** — Anthropic, open-source registries

### Observability Integrations *(export mechanisms — not Observability tab content)*

> Prometheus, Grafana, and OTel are bridges to operator-owned observability stacks —
> not sections within the Observability tab. They are configured in Settings → Integrations.
> The Observability tab is sovereign and complete without any external sink. These
> integrations let operators place Wicklee metrics alongside other services in their
> existing Grafana/Datadog/Jaeger instances.

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
| `/api/v1/insights/latest` (deterministic) | ✅ | ✅ | ✅ |
| Chat with Fleet Data (LLM, BYOK/Ollama) | ❌ | ✅ | ✅ |
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

The full architectural specification is in `docs/SPEC.md → Agent-First Architecture — Built for Humans and Their Agents`.

**Four-layer agent progression:**
```
Layer 1 — Discovery        /llms.txt + Markdown blog + /docs     agents discover and read Wicklee
Layer 2 — Query            Agent API v1 (REST, JSON, rate-limited) agents query live fleet data
Layer 3 — Intelligence     /api/v1/insights/latest               agents consume deterministic briefing
                           (action_id + best_online_node)        machine-readable directives, no LLM
Layer 4 — Native Tools     MCP server tools                      agents call Wicklee natively;
                           + Chat with Fleet Data (optional)     power users query history via LLM
```

**Roadmap phase mapping:**
```
Phase 3A  →  Layer 1: /llms.txt + Markdown blog          ✅
Phase 3B  →  Layer 2: Agent API v1                        ✅
Phase 4A  →  Layer 3: /api/v1/insights/latest
             (pattern findings + action_ids — no LLM)
Phase 5   →  Layer 4: MCP server + Chat with your Data
```

**Design rules for every new feature (from SPEC.md):**
1. If it's in the dashboard, it must also be in the API — no dashboard-only primitives.
2. `action_id` is an external API contract — never rename or change values.
3. `best_online_node` must be verified at response time — agents cannot tolerate stale routing targets.
4. Every finding must be grounded in deterministic data — no LLM inference in the intelligence loop.
5. Do not think dashboard-first — design the data contract first, then render it.

---

*Wicklee is sovereign infrastructure. Your fleet data never leaves your network until you choose.*
*Built for humans and their agents.*
