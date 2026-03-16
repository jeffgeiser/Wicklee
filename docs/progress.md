# Wicklee — Progress Journal

*A running log of what shipped, what was learned, and what's next. Most recent entry first.*

---

## March 15, 2026 — Sprint 1: Pattern Engine + Observations Briefing Feed 🧠

**The Goal:** Build the "Infrastructure of Time" for the Insights tab — a deterministic, time-windowed rules engine that transforms raw telemetry history into actionable operator briefings. No external AI. No threshold crossings. Sustained evidence only.

---

### useMetricHistory Hook ✅

`src/hooks/useMetricHistory.ts` — the memory layer that makes patterns possible.

- **Downsampled storage:** One sample per 30-second bucket per node. Deduplication by bucket timestamp means rapid SSE frames don't bloat the buffer.
- **Rolling 24h buffer:** 2,880 samples/node max (`24h × 2/min × 60min`). Oldest entries evicted automatically. Survives page refreshes via localStorage.
- **`metricsToSample()` helper:** Converts live `SentinelMetrics` to a `MetricSample`. Applies `INFERENCE_VRAM_THRESHOLD_MB = 1024` filter at write time — BMC/ASPEED chips never appear in VRAM history.
- **Stable imperative API:** `push`, `getHistory`, `getRecent`, `getWindow`, `prune`, `clear`. No re-renders on push — callers feed the engine from `useEffect` without causing render loops.
- **QuotaExceededError handling:** Falls back to trimming the oldest half of all node histories before retrying the localStorage write.

### patternEngine.ts ✅

`src/lib/patternEngine.ts` — the deterministic evaluator.

- **Architecture:** `evaluatePatterns(input)` takes node history + config, returns `DetectedInsight[]`. Pure function — same inputs → same outputs. No side effects, no time.now() divergence except at the call site.
- **`DetectedInsight` shape:** `patternId`, `hook` (the quantified "so what"), `body`, `confidence` (building/moderate/high), `confidenceRatio` (0–1 for the progress bar), `tier` gate, `actions[]` with copy-text and endpoint flag.
- **`toConfidence()` helper:** `ratio < 0.5` → building, `< 0.9` → moderate, else high.

**Pattern A — Thermal Performance Drain** (Community)
- 5-min observation window (10 samples). Baseline tok/s drawn **exclusively from Normal-thermal samples** in history — this was the key refinement. Without it, the delta is "hot vs. slightly less hot" instead of "hot vs. the node's own clean-state capability." Fires when sustained degradation > 8%. Hook: `-X tok/s (Y% below Normal baseline)`.

**Pattern B — Phantom Load** (Community)
- 5-min observation window. Fires when: watts > idle threshold AND VRAM allocated (`vram_used_mb > 0` after 1024 MB filter) AND tok/s < 0.5 (no meaningful inference). The VRAM gate is what separates this from plain idle cost — a model is loaded, holding VRAM, drawing power, and not serving. Hook: `-$X.XX/day` at configured kWh rate.

### ObservationCard + Triage Wiring ✅

`src/components/insights/ObservationCard.tsx`:
- **Intelligence briefing layout**: quantified hook top-right in pattern-specific color (amber for thermal drain, violet for phantom load), body paragraph, copy-to-clipboard action buttons.
- **Confidence progress bar**: renders only when `confidence === 'building'`. Shows "Observing: Xm of Ym required" so operators know the finding is still accumulating evidence — not a false positive.
- **Copy buttons**: both shell commands (`ollama stop ...`) and API endpoints (`GET /api/v1/route/best`) render as monospace copy chips.

`AIInsights.tsx` wiring:
- `useMetricHistory` + `evaluatePatterns` added to the component's hook chain.
- Samples pushed on every telemetry frame (SSE or local); evaluator throttled to 30s cycles via `lastObsEvalRef`.
- `prune()` called once per eval cycle to evict stale 24h+ entries.
- "Observations" section renders in Triage tab above Local AI Analysis when patterns fire; hidden when `observations.length === 0`.

### What's Next (Sprint 2)

- **Pattern C — WES Velocity Drop:** 10-min gate. Rate-of-change on WES score — fires before thermal state changes. The true "leading indicator."
- **Pattern F — Memory Pressure Trajectory:** ETA to critical from localStorage rate-of-change. No DuckDB required — supersedes the Phase 4A DuckDB implementation for the ETA calculation.
- **Observation dismissal:** Per-patternId dismiss with 1h snooze.
- **Alert wiring:** Map pattern IDs to `alert_rules` event_types (Team+ delivery via Slack/email).

---

## March 15, 2026 — Phase 4A: Alerting Engine + Settings UI + VRAM Fixes 🔔

**The Goal:** Ship the full Phase 4A notification pipeline (Slack + Resend delivery, stateful eval loop, CRUD API), build the Settings UI for Alerts & Notifications, fix VRAM display for Apple Silicon and EPYC nodes, and tighten the sidebar profile menu.

---

### VRAM Column — Apple Silicon Wired Budget ✅

Apple M-series nodes have unified memory — VRAM is not a separate pool. macOS exposes the actual GPU memory budget via `iogpu.wired_limit_mb` (sysctl), which represents the maximum the GPU may wire at any time (~75% of RAM on typical configs). The VRAM column now shows `headroom_available / wired_limit` for Apple nodes as a utilization bar, with a `Unified` badge to distinguish it from discrete VRAM.

The fleet-wide Total VRAM tile was updated to use `gpu_wired_limit_mb` as the capacity figure for Apple nodes (was previously zero, causing the tile to under-count).

**The "Ghost 0.8 GB" Problem:** EPYC and server nodes with BMC/IPMI graphics chips (ASPEED AST, Matrox, etc.) were reporting ~840 MB of VRAM — real hardware, zero inference value. Added `INFERENCE_VRAM_THRESHOLD_MB = 1024` filter in `efficiency.ts` and `Overview.tsx`. Any VRAM device below 1 GB is excluded from fleet totals and the VRAM column. The column shows `—` for nodes with no qualifying GPU.

Key changes:
- `efficiency.ts`: exported `INFERENCE_VRAM_THRESHOLD_MB = 1024`; `calculateTotalVramMb` and `calculateTotalVramCapacityMb` both apply the threshold.
- `Overview.tsx`: `hasNvidia` guard uses `>= INFERENCE_VRAM_THRESHOLD_MB`; Apple Silicon bar reads `gpu_wired_limit_mb`; fleet tile capacity uses same field.
- VRAM column widened 80→100px to accommodate `available/limit` format.
- `DocsPage.tsx`: three new footnotes — Apple Silicon unified memory / wired budget, Linux NVIDIA glibc requirement, ≥1 GB threshold excluding BMC chips.

---

### Phase 4A Alerting Engine ✅

Full notification pipeline shipped in `cloud/src/main.rs`.

**Schema additions** (run_migrations):
- `notification_channels`: id, user_id, channel_type ('slack'|'email'), name, config_json, verified, created_at
- `alert_rules`: id, user_id, node_id (NULL = fleet-wide), event_type, threshold_value, urgency ('immediate'|'debounce_5m'|'debounce_15m'), channel_id, enabled, created_at
- `alert_events`: id, rule_id, node_id, triggered_at, resolved_at, quiet_until_ms, metrics_snapshot_json
- `ALTER TABLE users ADD COLUMN subscription_tier TEXT NOT NULL DEFAULT 'community'`
- `ALTER TABLE users ADD COLUMN stripe_customer_id TEXT`
- `ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT`

**Delivery layer:**
- `send_slack()`: posts Slack Block Kit JSON (header + section + context with dashboard link).
- `send_email()`: POSTs to Resend API (`https://api.resend.com/emails`) with HTML + plain-text fallback. Reads `RESEND_API_KEY` + `FROM_EMAIL` env vars.
- `deliver_alert()`: routes to Slack or email based on channel_type; logs on failure without panicking.

**Evaluation state machine (`evaluate_alerts`):**
- Called from `handle_telemetry` spawn_blocking for Team+ users.
- Evaluates 4 event types: `thermal_serious`, `thermal_critical`, `memory_pressure_high`, `wes_drop`.
- Open/resolved state tracked in `alert_events`. `quiet_until_ms = resolved_at + 300_000` enforces 5-min flap suppression after resolution.
- Debounce: 'immediate' fires on every qualifying telemetry tick; 'debounce_5m'/'debounce_15m' only re-fires after `resolved_at + debounce_ms`.
- Resolution notifications sent when a previously-triggered condition clears.

**Node offline detection (`node_offline_alert_task`):**
- Independent Tokio interval task (60s). Checks `last_seen` in SQLite for all paired nodes.
- Fires once per outage — checks `alert_events` for an existing open `node_offline` alert before firing.
- Resolves the event when the node comes back online.

**Tier gating:**
- `is_team_or_above()` helper checks `subscription_tier`.
- All alert CRUD endpoints return `402 Payment Required` for community tier.
- `evaluate_alerts` is a no-op for community users.

**CRUD API (7 handlers):**
- `POST /api/alerts/channels` — create notification channel
- `GET /api/alerts/channels` — list channels for authenticated user
- `DELETE /api/alerts/channels/:id` — delete channel
- `POST /api/alerts/channels/:id/test` — send test message
- `POST /api/alerts/rules` — create alert rule
- `GET /api/alerts/rules` — list rules
- `DELETE /api/alerts/rules/:id` — delete rule

**CORS fix:** Added `DELETE` to allowed methods in the cloud CORS middleware (was `GET, POST, OPTIONS` only — blocked browser preflight for delete operations).

---

### Settings UI — Alerts & Notifications ✅

Full replacement of the locked Phase 4A placeholder in `SettingsView.tsx`.

Three states based on context:
1. **Local mode** (not paired to fleet): shows lock icon + "Connect your fleet" message.
2. **Community tier**: upgrade prompt with feature list and "Upgrade to Team" CTA.
3. **Team+ tier**: full configuration UI.

Team+ UI has two sections:

**Notification Channels:**
- Add form with Slack/email toggle. Slack: webhook URL input. Email: address input.
- Test button with three visual states: sending → ok (green check) / fail (red X).
- Delete with confirmation. Displays channel name, type badge, created date.

**Alert Rules:**
- Form: event type selector (5 types with `hasThreshold` flag), notification channel picker, node scope (all nodes or specific node), urgency selector, conditional threshold input (only shown for threshold-based events).
- Rule list: event type + node scope + urgency displayed per row, delete button.

New types in `types.ts`: `ApiKey` (key_id, name, created_at, last_used_ms).
New props on `SettingsViewProps`: `getToken?: () => Promise<string | null>`, `subscriptionTier?: string`.
`App.tsx` passes `getToken={getToken}` and `subscriptionTier={clerkTier}` to `<SettingsView>`.

---

### Sidebar — Profile Menu Fix ✅

Profile menu (JS state) stayed open when the sidebar collapsed on mouse leave — CSS `hover:w-64` drives the width but has no JS counterpart.

Fix: added `onMouseLeave={() => setIsAvatarMenuOpen(false)}` to the `<aside>` element in `Sidebar.tsx`. One line. Profile menu now closes automatically when the cursor exits the sidebar.

---

## March 15, 2026 — AMD CPU Thermal: k10temp + Clock Ratio 🔥

**The Goal:** Implement AMD-specific thermal detection in the Rust agent. The generic sysfs path catches temperature after the fact; clock ratio catches throttle as it happens — the right signal for WES penalty derivation on Ryzen/EPYC nodes.

---

### AMD Thermal via k10temp + Clock Ratio ✅

**Architecture change:** Replaced `Arc<Mutex<Option<String>>>` (bare state string) with `Arc<Mutex<Option<LinuxThermalResult>>>` throughout the thermal pipeline. `LinuxThermalResult` carries `{ state: String, source: &'static str, direct_penalty: Option<f32> }` — allows AMD path to pass a direct penalty (up to 2.5 for severe throttle) bypassing the state→penalty mapping, while the sysfs fallback still uses `thermal_penalty_v2(state)`.

**AMD detection:**
- `find_hwmon("k10temp")` scans `/sys/class/hwmon/*/name` — presence of k10temp driver is the AMD signal
- `read_cpu_max_freq_khz()` reads `cpuinfo_max_freq` (hardware ceiling) once at startup — never re-polled
- `read_avg_cur_freq_khz()` averages `scaling_cur_freq` across all cpu0…cpuN directories every 5s
- Clock ratio = avg_cur / max; thresholds: ≥0.95→Normal(1.00), ≥0.80→Fair(1.25), ≥0.60→Serious(1.75), <0.60→Critical(2.50)
- `read_k10temp_tdie_c()` tries `temp2_input` (Zen2+ Tdie) then `temp1_input`; Tdie > 85°C bumps to at least Serious as tie-breaker
- `thermal_source: "clock_ratio"` — new source tag, visible in WES breakdown tooltip

**Bug fix (all Linux nodes):** Generic sysfs path returned `"Elevated"` for 70–79°C. `thermal_penalty_v2` has no "Elevated" case — fell through to default (1.0). Corrected to `"Fair"` (1.25). Non-AMD Linux nodes in the warm zone now receive the correct WES penalty. **This is a WES score change for affected nodes — scores will decrease (more accurate).**

**WES sampler:** Uses `direct_penalty` when `Some` (AMD path); falls back to `thermal_penalty_v2(state)` when `None` (sysfs). `lt.source` flows as `wes_metrics.thermal_source`.

### What's Next (Rust agent)

- Intel CPU thermal — thermald zone states (Linux) with clock ratio fallback
- ANE Utilization — Apple Neural Engine
- macOS CPU Power sudoless
- `wes_config.json` — configurable penalty thresholds

---

## March 15, 2026 — Phase 3B Closure + Phase 4A Historical Graphs 📈

**The Goal:** Close out Phase 3B frontend — Sovereignty section (last open item) + dead code cleanup. Then immediately start Phase 4A with Historical Performance Graphs, making the accumulated DuckDB history visible for the first time.

---

### Housekeeping ✅

Removed dead `MOCK_NODES_INITIAL` constant from `App.tsx`. Defined but never referenced — fleet data has been live SSE-only since Phase 2. No behaviour change; cleaner codebase.

### Sovereignty Section (Observability Tab) ✅

`TracesView.tsx` fully rewritten. The old `HostedPlaceholder` ("traces run locally, go to localhost:7700") replaced with a full **Sovereignty** section visible on both the cloud dashboard and localhost:

**Telemetry Destination card:**
- Paired: shows fleet URL with "Fleet connected" badge (indigo)
- Unpaired/localhost-only: shows `localhost:7700` with "Local only" badge (green)
- Two explicit sub-lists: what IS transmitted (CPU/GPU metrics, WES score, active model name) and what NEVER leaves (inference content, prompts, responses, user conversations)
- The "never leaves" list uses green `CheckCircle` icons — the trust signal is visual, not just text

**Outbound Connection Manifest:**
- Three rows: Ollama probe (localhost:11434 / local), Fleet telemetry (fleet URL / active or inactive), Clerk auth (api.clerk.dev / cloud only)
- Status badges: green "local", indigo "active", gray "inactive" — state-driven from current `pairingInfo`
- Footnote: "No inference data appears in any outbound connection"

**Connection Event Log:**
- Pulls `node_online` / `node_offline` events live from `FleetStreamContext`
- Live pulse dot when SSE connected
- Empty state: "No connection events in this session"

**Localhost:** Trace table still renders below the Sovereignty section. Cloud: Sovereignty section is now the full content of the Observability tab — makes the trust case to wicklee.dev visitors explicitly, not just on localhost.

### Historical Performance Graphs ✅

Phase 4A unlocked. DuckDB has been accumulating data since `e8c6b47` — now it's visible.

**Backend — `GET /api/fleet/metrics-history`:**
- Same auth + DuckDB bucketing architecture as `wes-history`
- 1h range: `metrics_raw` at 60-second buckets — tok_s, watts, gpu_pct, mem_pressure_pct
- 24h–90d: `metrics_5min` aggregates — tok_s_avg + tok_s_p95, watts_avg, gpu_pct_avg, mem_pressure_pct_avg
- Response: `{ range, nodes: [{ node_id, hostname, points: [{ ts_ms, tok_s, tok_s_p95, watts, gpu_pct, mem_pct }] }] }`

**Frontend — `MetricsHistoryChart.tsx`:**
- 4-metric selector: Tok/s (indigo) · Power/W (amber) · GPU% (violet) · Mem% (cyan)
- Each metric has its own gradient fill + colour — switching metric re-renders the area and defs
- **P95 dashed reference line** for tok/s on 24h+ ranges (from `metrics_5min` `tok_s_p95`) — shows headroom vs average
- **Live SSE reference line** — current value from `useFleetStream()` as a horizontal `ReferenceLine` labeled "Now: X unit" — anchors historical trend to present state
- Time-range gating: 1H/24H Community, 7D Pro, 30D/90D Team (lock icons on gated buttons)
- Node tabs for multi-node fleet selection
- "Collecting data" empty state with Pro nudge on Community 24h view

**Placement:** Insights → Performance tab, below WES Trend chart.

### What's Next

**Phase 3B remaining (Rust agent):**
- AMD CPU thermal — k10temp + clock ratio
- Intel CPU thermal — thermald zone states
- ANE Utilization — Apple Neural Engine
- macOS CPU Power sudoless
- `wes_config.json` — configurable penalty thresholds

---

## March 15, 2026 — WES v2 Sprint D: Insights Restructure + Thermal Alerts + Benchmark Reports 📊

**The Goal:** Close the WES v2 UI loop — restructure Insights into a 3-tab hierarchy, add strategic doc updates (TIERS.md, ROADMAP.md Phase 5, metrics.md Prometheus schema), implement WES history chart (raw vs penalized), Thermal Cost % alerts, and benchmark report output format.

---

### Insights Tab Hierarchy ✅

Restructured `AIInsights.tsx` from a vertical-scroll layout into three tabs:

- **Triage** — Alert Quartet (Thermal Degradation, Power Anomaly, Memory Exhaustion, Thermal Cost), Model Eviction, Idle Resource, Model Fit, Local AI Analysis (Cockpit only).
- **Performance** — WES Leaderboard, Inference Density HexHive, WES Trend Chart (cloud only, Pro+), Quantization ROI, Export Benchmark Report.
- **Forensics** — Six Team+ locked/tease cards: Efficiency Regression, Memory Forecast, Hardware Cold Start, Fleet Thermal Diversity, Inference Density Historical, Sovereignty Audit.

`InsightsGlobalStatusRail` always visible above all tabs. Tab bar renders "Team" badge on Forensics when locked. Dormant monitoring panel refactored to array-based isFirst/isLast logic — safe for variable number of dormant rows.

### WES History Chart ✅

`WESHistoryChart.tsx` switched from stacked `AreaChart` to `ComposedChart` with:
- `Area` — filled indigo (Penalized WES, operational score)
- `Line` — dashed reference (Raw WES / hardware ceiling) — only appears when `hasThermalCost` is true
- Time-range gating: 1H/24H (Community), 7D (Pro), 30D/90D (Team). Locked buttons show tier label.
- Pro nudge in empty state: "DuckDB is active. Pro unlocks 7-day historical trends." — contextual, single line, disappears once data arrives.
- Tooltip shows both Penalized WES and Raw WES (ceiling) labels.

### Thermal Cost % Alerts ✅

New `ThermalCostAlertCard` (Tier 1) in Triage tab:

- **Info** >10% · **Warning** >25% · **Critical** >40%
- Rate-of-change escalation: TC% rise ≥15pp in rolling 30-frame SSE window bumps severity one level — a spike from 5%→20% is more urgent than steady 20%
- Suppressed when `ThermalDegradationCard` is already firing (Serious/Critical thermal state) — no double-alerting
- `tcPctHistoryRef` per-node rolling history for rate detection
- TC% fires into `firingAlerts` array → appears in `InsightsGlobalStatusRail`
- Dormant monitoring row shows peak fleet TC% when below threshold

### Benchmark Report Output Format ✅

`src/utils/benchmarkReport.ts`:
- `BenchmarkReport` type — full provenance: node, hardware, OS, runtime, model, quantization, tok/s, watts, Raw WES, Penalized WES, Thermal Cost %, thermal state+source, WES version, Wicklee version, ISO timestamp
- `buildReportFromLive(SentinelMetrics)` — live snapshot with full field coverage
- `buildReportFromHistory(opts)` — WES history point snapshot (WES/thermal fields; model/watts absent)
- `formatReportMarkdown(report)` — pasteable Markdown block for blog/arXiv/GitHub
- `formatReportJSON(report)` — machine-readable JSON
- `downloadReport(content, filename)` + `reportFilename(report, ext)` utilities

`src/components/BenchmarkReportModal.tsx`:
- WES summary strip (Raw / Penalized / Thermal Cost %)
- Markdown ↔ JSON tab toggle
- Copy-to-clipboard button
- Download `.md` (primary) + Download `.json` (secondary)

Export triggers:
1. **Insights → Performance tab** — "Export snapshot" button appears when WES data is live. Uses best-WES node (Mission Control) or `localSentinel` (Cockpit).
2. **WES Trend chart header** — "Export" button appears when history data is loaded. Snapshots the most recent point from the selected node's window.

### Strategic Docs ✅

- `docs/TIERS.md` — Enterprise tier: Prometheus/Grafana, Kubernetes Operator, SSO/SAML
- `docs/ROADMAP.md` — Phase 5 "Enterprise & Orchestration": Prometheus Exporter, Grafana, OTel, vLLM/Ray Serve awareness, MIG slice WES, Docker/Helm/K8s Operator, Signed Audit PDF
- `docs/metrics.md` — Enterprise Contextual Metrics (Cost Allocation formula, departmental multi-tenancy), full Prometheus schema (10 gauge + 2 state label metrics)
- `src/hooks/usePermissions.ts` — `canGoSovereign` + `hasPrometheusExport` Enterprise flags
- `src/types.ts` — `TIER_BADGE` constant (`Record<SubscriptionTier, { label, color }>`)
- `src/pages/DocsPage.tsx` — Pro tier row in data retention table, Benchmark Report sub-section in WES section

### What's Next

**Phase 3B remaining (agent/Rust):**
- AMD CPU thermal — k10temp + clock ratio
- Intel CPU thermal — thermald zone states
- ANE Utilization — Apple Neural Engine watt + utilization
- macOS CPU Power sudoless

**Phase 3B remaining (frontend):**
- Sovereignty section in Observability tab (pairing event log, telemetry destination, outbound connection manifest)

**Launch prep:**
- Andy_PC RTX 3070 WES capture
- RTX 4090 Vast.ai test
- GitHub repo description
- Show HN · r/LocalLLaMA · Ollama Discord

---

## March 15, 2026 — WES v2 Sprint C: Thermal Cost % UI 🌡️

**The Goal:** Surface Thermal Cost % as a first-class visible metric in the Fleet Status table, Best Route Now card, and WES tooltip. Wire rawWes / tcPct / thermalSource through the leaderboard data model. Fix formula errors in the `/docs` page.

---

### WES v2 Sprint C — UI Layer ✅ (commit `b61e661`)

**What shipped:**

- **`computeRawWES()`** added to `wes.ts` — WES without thermal penalty applied. Represents the hardware ceiling: what the node *would* score thermally unimpeded.
- **`thermalCostPct(rawWes, penalizedWes)`** — `(Raw − Penalized) / Raw × 100`, rounded to integer. Returns 0 when either input is null (normal thermal or no data) — badge stays hidden, no false alarms.
- **`thermalSourceLabel(source)`** — maps `'nvml'` → `'NVML'`, `'iokit'` → `'IOKit'`, `'sysfs'` → `'sysfs'`. Shown in tooltip for provenance.
- **`-N% thermal` badge** in Fleet Status table — amber, `text-[9px]`, appears below the WES score when `tcPct > 0 && isOnline`. Zero visual noise on normal-thermal nodes.
- **`WESEntry` extended** — `rawWes`, `tcPct`, `thermalSource` added to the leaderboard data model. Leaderboard continues to rank by penalized WES (operational reality); raw WES is available for gap analysis.
- **Best Route Now card** — efficiency WES now shows the `-N% thermal` badge in the amber chip below the score.
- **`wesBreakdownTitle()` v2** — tooltip now shows tok/s · Watts · Thermal state · Thermal Cost % · Thermal source on *all* WES values (was: only WES < 10). Diagnostic recommendation line included.
- **`SentinelMetrics` v2 fields** — `penalty_avg`, `penalty_peak`, `thermal_source`, `sample_count`, `wes_version` typed as optional in `types.ts`. Backward-compatible: older agents that don't emit them work with TC% = 0.

**What was learned:**
- TC% badge threshold of `> 0` is the right gate. `thermalCostPct()` returns exactly 0 for Normal state (penalty 1.0), so the badge is invisible unless throttling is active. No need for a separate `> 5%` dead zone.
- The tooltip is most useful when shown on *all* WES values, not just low ones. A high WES with a non-zero TC% is the most actionable signal — the node is performing well but leaving efficiency on the table.

---

### Docs Page — Formula + Multiplier Fixes ✅

**Problems fixed in `src/pages/DocsPage.tsx`:**
- Formula had spurious `× 10` scaling factor: `WES = (tok/s ÷ Watts) × 10 ÷ ThermalPenalty`. Corrected to: `WES = tok/s ÷ (Watts × ThermalPenalty)` — matches `wes.ts` exactly.
- Penalty multiplier for Fair was `0.90×` (should be `0.80×` = 1/1.25).
- Penalty multiplier for Serious was `0.75×` (should be `0.57×` ≈ 1/1.75).
- Added **Thermal Cost %** callout block below the penalty table — formula, definition, and amber `-N% thermal` badge explanation.

---

## March 14, 2026 — WES v2 Agent-Side + Documentation Hub + Site Polish 📄

**The Goal:** Ship the WES v2 thermal sampler and NVML bitmask on the agent. Fix two Railway cloud build failures. Overhaul landing page Problem section copy. Launch a public `/docs` page with full content and wire it site-wide as the authoritative documentation hub.

---

### WES v2 — Sprint B: Agent-Side Thermal Sampler ✅ (commit `74fd625`)

**What shipped:**
- Independent 2-second tokio sampling task (`start_wes_sampler`). Maintains a 30-sample (60s) `VecDeque` rolling window. Computes `penalty_avg` and `penalty_peak` from accumulated samples.
- `WesMetrics` struct — `Arc<Mutex<WesMetrics>>` shared between the sampler, the 1 Hz broadcaster, and the SSE handler.
- Refined penalty table: `Normal→1.00`, `Fair→1.25`, `Serious→1.75` (was 2.0 in v1), `Critical→2.00`. The v1→v2 break is intentional and version-stamped via `wes_version: 2` in every payload.
- **NVML throttle-reason bitmask** — `device.current_throttle_reasons()` from nvml-wrapper. Priority order: multi-thermal (`>1 bit set`) → `HW_THERMAL_SLOWDOWN` → `SW_THERMAL/HW_SLOWDOWN/POWER_BRAKE` → pre-throttle (`≥90°C, no bits`). Source tagged `nvml` — hardware-authoritative, overrides temperature inference on all NVIDIA nodes.
- Five new `MetricsPayload` fields: `penalty_avg`, `penalty_peak`, `thermal_source`, `sample_count`, `wes_version`. All optional (`skip_serializing_if = "Option::is_none"`) — zero breaking changes to existing consumers.
- `main()` spawns the sampler, wires `Arc<Mutex<WesMetrics>>` into broadcaster and SSE handler via Axum `Extension`.

**What was learned:**
- The `nvml-wrapper` `ThrottleReasons` type must be imported as `bitmasks::device::ThrottleReasons` — it lives under `bitmasks`, not `enum_wrappers`. Gate the import behind the same `cfg` block as the rest of NVML.
- Thermal source priority matters: prefer `nvml` (bitmask is authoritative) → `iokit` (Apple SMC) → `sysfs` (Linux thermal zones) → `unavailable`. This prevents a sysfs fallback from contradicting a hardware-confirmed NVML reading.

---

### Railway Build Fixes ✅ (commits `0d8a0ec`, `bde9f49`)

**Problem 1 — "failed to find tool c++" on Railway build:**
- DuckDB's `bundled` feature compiles ~500 KB of C++ via cmake. The `rust:1.88-slim` Debian image has no C++ compiler.
- Fix: added `apt-get install -y --no-install-recommends build-essential cmake` to `cloud/Dockerfile` builder stage, before any cargo commands.

**Problem 2 — Runtime panic: `zstd_compression_level`:**
- Error: `"Catalog Error: unrecognized configuration parameter \"zstd_compression_level\""` — this DuckDB v1 setting doesn't exist (it was invented when writing the implementation).
- Fix: removed `SET zstd_compression_level=3;` from `open_duck_db()`. Kept `SET force_compression='zstd';` which is valid.

---

### Landing Page — Problem Section Copy ✅ (commit `670dcf6`)

Replaced the old framing with inference-layer positioning:
- **Headline:** "Standard monitors stop at the hardware. We see the inference layer."
- **Sub-headline:** Specifically calls out WES scores, wattage-per-token, and runtime health as the gap between standard hardware monitors and what operators actually need.
- Removed the "Note" callout box (13 lines of JSX). Tightened spacing: `mb-6` + Note's `mb-10` → single `mb-10` on the sub-headline.

---

### UI Polish — Hero + Logo ✅ (commit `256e54b`)

- **Hero sign-in button removed.** The Sign In CTA was already in the top-right nav — having it in the hero was redundant. CTA section simplified to a single centered button.
- **Logo `connectionState` prop fixed site-wide.** `LandingPage.tsx`, `BlogPost.tsx`, `BlogListing.tsx` all passed the stale `active={true}` prop from before the Logo component was refactored. TypeScript doesn't error on extra props — all three were silently rendering a dim, non-pulsing logo. Fixed to `connectionState="connected"` across all three.

---

### Documentation Hub — `/docs` page ✅ (commits `50c91bc`, `5fcb74e`)

**New page: `src/pages/DocsPage.tsx`**

Five sections with full content:
- **Quick Start** — Two-step flow: Step 1 (user-level curl, live-only, no sudo) → Step 2 (sudo service install). `NoteBox` callout explains *why* sudo is needed: launchd/systemd registration + direct hardware sensor and power-rail access. Frames it as a system-level hardware requirement, not a red flag.
- **WES Score** — Formula with explicit "multiplicative penalty" framing. Penalty Impact table (State / Divisor / Score multiplier / Effect) with color-coded state labels. Score interpretation table. v1 vs v2 note with `wes_version` field explanation.
- **Agent API v1** — Base URL, auth header, full endpoint table, `TipBox` implementation tip for `/route/best` (LangChain router / load balancer use case), route response JSON shape, rate limits per tier.
- **Configuration** — Dashboard settings, env vars table, **Data Retention** table (Community: 24h / Team: 90d DuckDB / Enterprise: configurable), Ollama proxy `wicklee.toml` snippet.
- **Platform Support** — Two tables: (1) agent platform support by OS × capability; (2) metric availability by inference runtime — WES Score / Wattage / GPU Temp / KV Cache Saturation. KV Cache marked `vLLM only` with a purple badge. Honesty-first: blanks are blanks, not omissions.

**Wired site-wide:**
- `App.tsx`: `/docs` route added before auth gate (same pattern as `/metrics`, `/blog`)
- `Sidebar.tsx`: "Metrics Reference" → **"Documentation"**, route `/metrics` → `/docs` in avatar drop-up
- `LandingPage.tsx`: nav + footer Documentation links wired to `onNavigate('/docs')`
- `BlogPost.tsx`, `BlogListing.tsx`: nav Documentation links wired

---

## March 14, 2026 — Utility-First Gating: Community Tier Expansion 🔓

**The Goal:** Lower friction for early adopters by moving key diagnostic tools out of the Pro/Team paywall and into Community. Replace hard locks on Team cards with a "tease" pattern showing live data. Wire the Keep Warm button end-to-end. Persist insight dismissals for 24h across tab closes.

---

### Gate Changes ✅ (commit `22fe9a1`)

**`usePermissions.ts` — INSIGHT_TIER_GATE updates:**
- Insight 4 (Model Fit Score): `persistent` → `live_session` — Community now gets the full card, not the lite partial view
- Insight 5 (Model Eviction): `persistent` → `live_session` — Community now gets the full eviction card with countdown and Keep Warm
- Insight 10 (Quantization ROI): `trend` → `live_session` — new live snapshot card built from SSE data

**New `usePermissions` return fields:**
- `historyDays`: `{ community: 1, pro: 7, team: 90, enterprise: Infinity }`
- `canKeepWarm: true` — all tiers; limit varies
- `keepWarmNodeLimit`: Community=1, Pro=3, Team/Enterprise=∞

---

### Keep Warm Wired ✅ (commit `22fe9a1`)

`ModelEvictionCard.tsx` upgraded from a disabled Phase-4B stub to a live action:
- `canKeepWarm=true` → button fires `fetch('http://localhost:11434/api/generate', { num_predict: 1, stream: false })` — silent 1-token ping that resets Ollama's keep_alive timer
- Loading spinner → "Model kept warm ✓" for 3s → idle
- `canKeepWarm=false` → disabled button with lock + "Pro+" label (unused path now that all tiers have Keep Warm)

---

### New Components ✅ (commit `22fe9a1`)

**`InsightsTeaseCard.tsx`** — Replaces `InsightsLockedCard` for Team cards. Shows full live SSE data (no blur) + blurred trend placeholder + "Unlock on Team →" CTA. Used by: Efficiency Regression, Memory Forecast, Hardware Cold Start, Fleet Thermal Diversity.

**`QuantizationROICard.tsx`** — Live snapshot card for Community+. Shows: model name, quant badge (Q4_K_M / Q8_0 / F16 etc.), tok/s, W/1K TKN, WES (color-coded by efficiency), quant-family-aware educational copy. All from live SSE — no historical DB required.

---

### Insight Persistence Upgrade ✅ (commit `22fe9a1`)

`useInsightDismiss.ts` switched from `sessionStorage` (lost on tab close) to `localStorage` with 24h expiry:
```typescript
localStorage.setItem(key, JSON.stringify({ dismissed: true, expiresAt: Date.now() + 86_400_000 }));
```
Cards reappear automatically after 24h without manual action.

---

### TIERS.md Updated ✅ (commit `22fe9a1`)

Community section: history `Real-time only` → `24-Hour Rolling`, Keep Warm `Disabled` → `1 Active Node`, insights list updated with new cards, persistence notes updated.
Pro section: Keep Warm `1 Active Node` → `3 Active Nodes`.
Tier summary table updated.

---

## March 14, 2026 — Transparent Ollama Proxy, Three-State TOK/S & Metric Smoothing 🔧

**The Goal:** Eliminate the 5–35s inference detection lag from `/api/ps` polling by shipping a transparent Ollama proxy that sits on `:11434` and extracts exact tok/s from the done-packet. Simultaneously fix jumpy localhost metrics by throttling the broadcaster from 10 Hz → 1 Hz. Document all smoothing logic transparently in `metrics.md`.

---

### Phase B — Transparent Ollama Proxy ✅ (commit `00d2042`)

Optional proxy on `:11434` — binds ahead of Ollama (moved to `:11435`) and intercepts streaming inference responses. Provides zero-lag inference detection and exact tok/s from `eval_count/eval_duration` in the done-packet, replacing the 30s synthetic probe when active.

**How it works:**
- `ProxyState` — shared state (`AtomicBool inference_active`, `Mutex<Option<Instant>> last_done_ts`, `Mutex<Option<f32>> exact_tps`) passed to both the proxy Axum app and the OllamaMetrics writer task.
- `proxy_ollama_streaming` — handles POST `/api/generate` + `/api/chat`. Sets `inference_active=true` immediately. Streams NDJSON chunks, scans for `"done":true`, extracts exact tok/s. Uses `tokio_stream::StreamExt`.
- `proxy_passthrough` — pure forwarding for all other routes (`/api/ps`, `/api/tags`, etc.).
- **Bind-or-fallback startup**: if `:11434` can't be bound, logs clearly and falls back to Phase A `/api/ps` polling unchanged.
- `start_ollama_harvester` updated to accept `proxy_arc: Option<Arc<ProxyState>>`. Probe task gated with `if proxy_arc.is_none()`. When proxy active, reads `exact_tps`, `last_done_ts`, `inference_active` from `ProxyState`.
- `ollama_proxy_active` field added to `MetricsPayload` — frontend shows "live" instead of "live estimate" when proxy is active.

**Files changed:** `agent/Cargo.toml` (stream feature), `agent/src/main.rs`, `src/types.ts`, `src/components/Overview.tsx`

---

### Three-State TOK/S Display ✅ (commit `17fdcf9`)

Replaced binary inference active/idle with three explicit states:

| Badge | Color | Condition |
|---|---|---|
| **LIVE** | Green `~{tps}` | `ollama_inference_active = true` OR vLLM actively serving |
| **BUSY** | Amber | `inference_active = false` AND `gpu% ≥ 50%` |
| **IDLE-SPD** | Gray | Not inferring, not busy, clean probe value available |

`estimateTps(rawTps, peak, gpuUtil, inferenceActive)` helper: `rawTps + (peak × gpu_frac)` when under load with probe; `peak × gpu_frac` when probe skipped; `rawTps` unmodified when idle.

---

### Broadcaster Throttle: 10 Hz → 1 Hz ✅ (commit `93b6053`)

**Problem:** At 10 Hz the 8-sample rolling window covered only ~800ms — almost no damping, causing visible metric jumpiness on the localhost dashboard.

**Fix:** `Duration::from_millis(100)` → `Duration::from_millis(1_000)` in `start_metrics_broadcaster()`. At 1 Hz, 8 samples = 8s and 12 samples = 12s — matching the effective smoothing depth of the cloud fleet dashboard.

---

### Metrics Reference — Comprehensive Rewrite ✅ (commit `dff5ab8`)

`public/metrics.md` fully rewritten. New sections:
- **Visual Indicators at a Glance** — every colored dot, badge, bar explained (including the Model Fit Dot / why it goes red)
- **Dashboard: Insight Tiles** — all 8 header tiles with exact formulas
- **Dashboard: Fleet Status Table** — all 10 columns with data sources and color logic
- **Dashboard: Fleet Intelligence Cards** — Best Route Now, Cost, Tok/W, Thermal Diversity
- **Display Smoothing** — corrected window-to-time equivalents, 1 Hz broadcast rate rationale, three additional protections documented

---

## March 13, 2026 — Metrics Reference, Hover Tooltips & Docs Cleanup 📖

**The Goal:** Give operators a permanent reference for every metric Wicklee surfaces. Build a hover-tooltip system so metric labels are self-explaining in context. Formalize the four-tier pricing model in ROADMAP. Clean up SPEC/ROADMAP inconsistencies introduced by the proxy-dependent metrics design.

---

### Four-Tier Subscription Structure ✅ (commit `d257bf6`)

Formalized the subscription model from 3 tiers to 4 in `docs/ROADMAP.md`:

| Tier | Price | Nodes | History | Alerts |
|---|---|---|---|---|
| Community (Free) | $0 | Up to 3 | 24 h | — |
| Prosumer | $9/mo | Up to 10 | 7 days | Email |
| Team | $29/mo | Unlimited | 90 days | Slack / PagerDuty |
| Enterprise | $199/mo | Unlimited | Sovereign / airgapped | Signed audits |

Removed stale "Tier Structure impact" planning block from Alerting Tiers section — now formalized in the table.

---

### SPEC / ROADMAP Inconsistency Cleanup ✅ (commits `7a43bc0`, `e08a705`)

Two substantive changes based on a doc review:

**Cold Start → Hardware-Detected Cold Start:**
- Old: required `TTFT on request #1` — proxy-dependent, incompatible with zero-intercept privacy
- New: `model load → first tok/s transition` — detected via GPU spike + VRAM jump in the hardware stream, no proxy required
- Updated in both SPEC.md Intelligence Architecture table and ROADMAP Phase 4B

**Rate limiting removed from Agent API plan:**
- Per-tier req/min limits require a proxy or API gateway layer — not implementable without breaking the sovereign architecture
- Removed `Rate limiting — Community: 60 req/min. Team: 600 req/min.` from Phase 3B todo list
- Collapsed req/min column values in the Tier Structure table

---

### Metrics Reference Page ✅ (commit `9dc9a49`) — 7 files, +834 lines

A full documentation page and hover-tooltip system covering every metric Wicklee surfaces.

**`src/pages/MetricsPage.tsx`** — three-section reference page:
- **Node Metrics** (10 cards): WES, TOK/S, TOK/W, WATTS, GPU%, MEMORY, VRAM, THERMAL STATE, W/1K TKN, COST/1K TOKENS
- **Fleet Metrics** (4 cards): FLEET AVG WES, COST EFFICIENCY, TOKENS PER WATT (Fleet), FLEET HEALTH
- **Configuration** (2 cards): PUE, MODEL FIT SCORE
- Each card: name, formula (where applicable, `font-mono` indigo block), description, color-coded range dots, "If this is low / high" action guidance
- Deep-link anchors (`id` + `scroll-mt-24`) for URL-addressable references
- Sticky top nav with Back button + ExternalLink to `/metrics.md`
- Route: `/metrics` — public, no auth, works in both agent and cloud builds

**`src/components/MetricTooltip.tsx`** — hover card component:
- 400 ms delay via `useRef<setTimeout>` — not intrusive on casual mouse movement
- Touch-device guard: `window.matchMedia('(hover: hover)')` — never fires on touch-only devices
- `pointer-events-none` on the tooltip card; `pointer-events-auto` on the "Full reference →" link only — prevents mouseleave flicker when cursor enters the tooltip
- Compact range table (max 3 entries via `slice(0, 3)`)
- `wrapperClassName` prop for responsive visibility classes (e.g. `hidden md:block`)

**`src/components/Overview.tsx`** — 12 metric labels wrapped:
- `InsightTile.label` and `FleetCard.label` widened from `string` to `React.ReactNode`; render element changed from `<p>` to `<div>` to accept block children without invalid HTML nesting
- **6 Fleet Status column headers**: WES, TOK/S, TOK/W (hidden md:block), WATTS (hidden md:block), GPU% (hidden md:block), THERMAL (hidden sm:block) — `wrapperClassName` carries the responsive class so the visibility logic stays in one place
- **3 InsightTile labels**: Node/Avg WES (tile 5), Wattage/1k Tkn (tile 6), Cost/1k Tokens (tile 7)
- **3 FleetCard labels**: Cost Efficiency, Fleet Avg WES, Tokens Per Watt

**`src/components/Sidebar.tsx`** — profile drop-up cleanup:
- Removed: Documentation (→ GitHub README), Release Notes (→ GitHub releases)
- Added: **Metrics Reference** (button → `onNavigate('/metrics')`) · **GitHub** (external link)
- `onNavigate?: (path: string) => void` added to `SidebarProps`

**`src/App.tsx`**:
- `/metrics` route added before auth check (same pattern as blog routes)
- `navigate` threaded into `DashboardShellProps` and destructured in `DashboardShell` — was previously undefined at the Sidebar call site (caught by `tsc --noEmit`)

**`public/metrics.md`** — static Markdown version served at `/metrics.md`:
- Machine-readable by agents and LLMs; identical content to the interactive page
- Linked from page header ("Raw Markdown for agents") and `public/llms.txt`

**`public/llms.txt`** — `## Metrics Reference` section added:
- `/metrics` — interactive metrics reference page
- `/metrics.md` — raw Markdown version (machine-readable)

---

### "How Wicklee Works: Synchronous Observation" ✅ (commit `62fdf3d`)

New first section on the Metrics Reference page and in `metrics.md` — conceptual context before the metric definitions.

Four pillars documented:
1. **Hardware Harvester (10 Hz)** — NVML / IOReg / RAPL queries that capture micro-spikes 1-minute scrapers miss
2. **Performance Probe (30 s)** — 3-token automated pulse to local API, no request traffic intercepted
3. **Local Interpretation** — Conditional Insights: Power Anomaly, Thermal Degradation
4. **Zero-Intercept Privacy** — no proxy, no prompt visibility, sovereign boundary preserved

Visual treatment: `bg-gray-900 border border-indigo-500/20 rounded-2xl` card with indigo dot bullets — matches MetricCard range style but indigo accent border distinguishes conceptual content from metric-data cards.

---

### What Was Learned

- **`tsc --noEmit` catches prop threading bugs instantly** — `navigate` was referenced inside `DashboardShell` without being in scope. TypeScript caught it in one pass; added to `DashboardShellProps` and threaded cleanly.
- **`React.ReactNode` labels need `<div>` wrappers, not `<p>`** — a `<div>` (MetricTooltip's outer element) inside a `<p>` is invalid HTML. Changing label renders from `<p>` to `<div>` preserves visual identity while accepting block children.
- **`wrapperClassName` solves the responsive tooltip problem** — column headers like TOK/W are `hidden md:block`. Moving the visibility class to the MetricTooltip wrapper keeps the `<p>` inside clean and puts the responsive logic in the one right place.
- **Proxy-dependent metrics are a spec smell** — any metric that requires request interception is incompatible with zero-intercept privacy. Hardware-observable equivalents (GPU spike, VRAM jump) should be the default design for all future inference metrics.
- **`/metrics.md` as a machine-readable contract** — static Markdown at a predictable URL is the lowest-friction way to make documentation consumable by agents. No API, no auth, no parsing complexity.

---

### Code Shipped (commits `d257bf6` → `62fdf3d`)

| Commit | Description | Files |
|---|---|---|
| `d257bf6` | docs: formalize 4-tier subscription structure in ROADMAP | 1 file |
| `7a43bc0` | docs: Hardware-Detected Cold Start, remove proxy-dependent metrics | 2 files |
| `e08a705` | docs: remove rate limiting from Agent API plan | 1 file |
| `9dc9a49` | feat: Metrics Reference page, MetricTooltip, 12 label wraps | 7 files, +834 |
| `62fdf3d` | docs: add Synchronous Observation section to Metrics Reference | 2 files, +50 |

---

## March 13, 2026 — Insights Tab Rationalization & Model Fit Score 🧠

**The Goal:** Replace the Insights tab's placeholder structure with a real three-tier card hierarchy as defined in SPEC.md. Ship Model-to-Hardware Fit Score as the first live insight card. All conditions computed at render time from live SSE data — no backend changes.

---

### Model-to-Hardware Fit Score ✅ (commit `8970420`)

The first live Insight card. Answers "Is this hardware a good match for the model currently loaded?"

**`src/utils/modelFit.ts`** — pure compute function, no React imports, no side effects:
- Returns `FitResult | null` — null when no model loaded or data insufficient
- NVIDIA nodes use VRAM headroom; Apple Silicon / CPU nodes use system RAM
- Scoring: **Good** (fits + >20% headroom + Normal/null thermal) · **Fair** (fits + 10–20% headroom OR Fair thermal) · **Poor** (no fit OR <10% headroom OR Serious/Critical)
- Reason strings at each branch — human-readable, `toFixed(1)` on all GB values

**`src/components/insights/ModelFitCard.tsx`** — visual card:
- Score badge: CheckCircle2 (green) / AlertTriangle (amber) / XCircle (red)
- Hardware identity line: chip_name or gpu_name + total GB + "VRAM" vs "unified memory"
- Three-segment memory bar: model (indigo) · other used (gray) · free (dark)
- `font-telin` on all numeric values
- `showNodeHeader` prop for fleet mode (node ID + hostname + live dot)
- `bare` prop added later to compose cleanly inside InsightCard

**`src/components/Overview.tsx` — MODEL column fit dot:**
- Colored 1.5px dot (green/amber/red) next to model name
- `title` attribute shows full reason string on hover
- Only rendered when `ollama_model_size_gb != null`

**`src/components/AIInsights.tsx` (initial):**
- Local SSE connection pattern (mirrors Overview.tsx)
- Local mode: ModelFitCard at top when model loaded, `NoModelPlaceholder` otherwise
- Cloud mode: one ModelFitCard per node with model loaded, stacked with node headers

---

### Tooltip float precision fix ✅ (commit `bdf49dd`)

`modelSizeGb` was interpolated raw in the "doesn't fit" reason string — leaked full float precision into tooltips (e.g. `2.561380386352539GB`). Fixed to `modelSizeGb.toFixed(1)` — consistent with headroomGb already on the same line.

---

### Insights Tab Architecture documented ✅ (commit `32cfbba`)

Added `## Insights Tab — Architecture & Card Hierarchy` section to `docs/SPEC.md`:
- Core principle: live triage feed, empty tab = positive signal
- Two contexts: localhost:7700 (single node, operator present) vs wicklee.dev (fleet, remote)
- Three-tier card hierarchy with conditions, copy patterns, dismiss rules
- ASCII layout diagrams for both contexts
- Implementation rules: all cards computed at render time, sessionStorage dismiss, no mock data

---

### Insights Tab Full Rationalization ✅ (commit `128627b`) — 10 files, +1,077/−153

The structural overhaul that puts all pieces in the correct hierarchy from the start.

**New shared infrastructure:**
- **`src/hooks/useInsightDismiss.ts`** — sessionStorage-backed dismiss hook. Key format: `insight-dismissed:<cardId>:<nodeId>`. Tier 1 cards never call it.
- **`src/components/insights/InsightCard.tsx`** — base card shell. Left border (red/amber/green), severity icon, title row, optional ✕ dismiss button (Tier 2 only). Returns null when dismissed.

**Tier 1 — Active Alerts (undismissable, red border):**
| Card | Condition |
|---|---|
| `ThermalDegradationCard` | `thermal_state` Serious/Critical — shows est. tok/s loss (50% for Serious/Critical) |
| `MemoryExhaustionCard` | Headroom < 10% + model loaded — NVIDIA uses VRAM, others use system RAM |
| `PowerAnomalyCard` | Watts > 2× session baseline OR (watts > 50 && GPU < 20%) — baseline = rolling avg of first 10 readings |

**Tier 2 — Insights (per-session dismiss, amber/red border):**
| Card | Condition |
|---|---|
| `ModelFitInsightCard` | `ollama_model_size_gb != null` — wraps `ModelFitCard(bare)` inside InsightCard; poor score → red border |
| `ModelEvictionCard` | Model loaded + no tok/s activity ≥ 5 min — warns 2 min before eviction; Keep Warm locked (Phase 4B) |
| `IdleResourceCard` | No inference all session + uptime ≥ 1hr — shows `$X.XX/hr` idle cost using `getNodeSettings().kwhRate × PUE` |

**Three-section layout (both builds):**

*localhost:7700:*
```
Section 1: Active Alerts — Tier 1 cards or "✓ All systems nominal"
Section 2: Insights — Tier 2 cards (hidden entirely when all dismissed)
Section 3: Local AI Analysis — Ollama CTA, unchanged
```

*wicklee.dev:*
```
Section 1: Active Alerts — Tier 1 per node or "✓ Fleet nominal · N nodes"
Section 2: Insights — ModelFitInsightCard per node with model loaded
Section 3: Fleet Intelligence — Phase 3A placeholders (lock icon)
```

**Section 2 visibility:** sessionStorage checked at render time on every SSE frame (1Hz). Section header disappears within 1s of last active Tier 2 card being dismissed.

**Fleet mode notes:** Power anomaly uses high-W+low-GPU condition only (no per-node baseline). Eviction and Idle cards skip fleet mode (require per-node time tracking not yet available).

**`ModelFitCard.tsx` — `bare` prop:** Skips the outer `bg/border/rounded` wrapper so the card composes inside InsightCard without double nesting. All existing usages unaffected.

---

### What Was Learned

- **Empty state as a positive signal, not a broken state** — "✓ All systems nominal" is calm and reassuring, not celebratory. The Insights tab should feel like a security guard who's bored because nothing is happening.
- **Section 2 visibility without reactive sessionStorage** — reading sessionStorage at render time (not as React state) works cleanly because SSE frames arrive at 1Hz. The 1-second delay before the section header disappears is imperceptible.
- **`bare` prop pattern for composable cards** — rather than duplicating visual logic in two places, a single `bare` prop lets the existing card content compose inside a different outer shell. Keeps ModelFitCard's visual logic in one place.
- **Power baseline in a ref, not state** — accumulating the first 10 watt readings in a `useRef<number[]>` avoids re-renders during accumulation. A single `useState` flip at length === 10 triggers the one render that matters.
- **Fleet mode power anomaly simplification** — without per-node session baselines, the "2× baseline" condition is meaningless for fleet mode. The high-W+low-GPU condition fires independently and is more actionable at fleet scale anyway.
- **Tier 1 cards and the dismiss hook** — InsightCard calls `useInsightDismiss` unconditionally but only returns null when `tier === 2 && dismissed`. Tier 1 cards get the hook call for free; the guard prevents any behavior change.

---

### Code Shipped (commits `8970420` → `128627b`)

| Commit | Description | Files |
|---|---|---|
| `8970420` | Model-to-Hardware Fit Score — first live Insight card | 4 files, +541 |
| `bdf49dd` | Fix modelSizeGb float precision in tooltip | 1 file |
| `32cfbba` | docs: Insights Tab architecture in SPEC.md | 1 file, +115 |
| `128627b` | Rationalize Insights tab — 3-section hierarchy | 10 files, +1,077/−153 |

---

## March 12, 2026 — Security Hardening, Install Polish, Fleet Count Unification 🔒

**The Goal:** Pre-Show HN security pass. Full codebase audit across dead code, performance, correctness, and security. Ship the highest-priority fixes. Document everything in `docs/SECURITY.md`. Unify all node count displays behind a single hook.

---

### Install Script & Landing Page Polish ✅

**`install.sh` + `public/install.ps1`:**
- Success block replaced with version-dynamic output: `✓ Wicklee agent installed successfully (vX.X.X)`
- Recommended next step shown inline: `sudo wicklee --install-service`
- Fallback `sudo wicklee` shown beneath it
- PowerShell: version extracted via `wicklee --version`, falls back to release tag

**`src/components/LandingPage.tsx`:**
- Install section split into macOS/Linux (`curl`) + Windows (`irm`) blocks with separate copy buttons
- `--install-service` inline comment: `← runs on every boot`
- URL updated from `https://get.wicklee.dev` → `https://wicklee.dev/install.sh`

**`README.md`:**
- Replaced stale "curl install script coming soon" stub with live commands
- Added **Service Management** table: macOS/Linux/Windows rows for install/remove/status

---

### Dashboard Polish ✅ (commit `2f217a1`)

**`NodesList.tsx` — Management tab restructure:**
- `HarvesterHealth`: compact 2-column grid instead of full-width stacked
- `TelemetryRelayStatus`: slim single-row pill (was prominent card)
- Section order: HarvesterHealth → tiles → table → TelemetryRelayStatus → CTA
- VERSION column: shows `VITE_AGENT_VERSION` for local node
- RAPL hint: `sudo wicklee --install-service`

**`Overview.tsx` + `NodeHardwarePanel.tsx`:**
- `DiagnosticRail`: 5-sample rolling-average buffers (cpu/gpu/mem/power) moved before early `!s` return — Rules of Hooks fix
- Fleet Preview CTA: hidden when `pairingInfo.status === 'connected'`; copy → "Monitor from anywhere"
- Apple Silicon VRAM tile: shows `— / Unified Memory` instead of blank when `nvidia_vram_total_mb` is null

**`TracesView.tsx`:** Auto-sync dot — gray (no data) / green+pulse (receiving) / red (error)

**`Sidebar.tsx`:** Fleet Connected pill collapsed state = icon centered only; text fades in on hover via `group-hover/nav`

---

### AddNodeModal — 3-Step Wizard ✅ (commit `be8068f`)

Full rewrite of `AddNodeModal.tsx` (cloud-side, wicklee.dev) as a guided 3-step flow:
- **Step 1:** Install agent — `curl` command + `--install-service` recommended, macOS/Linux only
- **Step 2:** Open `localhost:7700`, find the 6-digit code
- **Step 3:** Existing digit-by-digit pairing code input

Added `StepDots` component, `CopyBtn`, `CmdRow` sub-components. `useEffect` resets state on modal open. `autoFocus` on first digit in step 3. `max-w-md` (was `max-w-sm`).

---

### Full Security Audit ✅

Four-category audit across cloud Rust backend, agent Rust code, and frontend TypeScript:
1. Dead code
2. Performance
3. Correctness risks
4. Security (injection, auth bypass, DoS, info disclosure, CORS, SSE token, CVEs)

**Tools run:** `cargo audit` (cloud + agent), `npm audit`

Results:
- npm audit: **0 vulnerabilities**
- cargo audit (cloud): **0 vulnerabilities**
- cargo audit (agent): **1 CVE** (quinn-proto 0.11.13, RUSTSEC-2026-0037, CVSS 8.7)

Full findings documented in `docs/SECURITY.md`. Fixes for C1/C2/C4/H1 shipped this session.

---

### Security Fixes ✅ (commit — this session)

**H1 — quinn-proto CVE (RUSTSEC-2026-0037):**
- `cargo update -p quinn-proto` in `agent/` → 0.11.13 → **0.11.14** (patched)

**C2 — CORS wildcard → origin allowlist:**
- `cloud/src/main.rs` CORS middleware: `Access-Control-Allow-Origin: *` replaced with per-request origin validation against `ALLOWED_ORIGINS` allowlist (`wicklee.dev`, `www.wicklee.dev`, `localhost:5173`, `localhost:3000`)
- Unknown origins receive no CORS header — browser blocks the request

**C1 — `/api/telemetry` unauthenticated:**
- Added node_id existence check: fast in-memory lookup first (O(1) for known nodes), DB fallback only for new/restarting nodes
- Unregistered node_ids → **403 Forbidden**
- Prevents fake metric injection from arbitrary node IDs

**C4 — Pairing code brute-force:**
- Added per-IP sliding-window rate limiter to `handle_activate`
- 10 attempts per IP per 60-second window → **429 Too Many Requests**
- `client_ip()` helper: reads `X-Forwarded-For` (Railway proxy) with direct IP fallback
- `pair_attempts: Arc<Mutex<HashMap<String, Vec<u64>>>>` added to `AppState`

---

### `useFleetCounts` — Single Source of Truth ✅ (commit `efd0ba8`)

**Problem:** FLEET NODES tile used `effectiveMetrics.length` (SSE-derived, can lag), NodesList used `enriched.filter(e => e.isOnline).length` (client-side time check). Both diverged from each other and from the registered `NodeAgent[]` array.

**Fix:** `src/hooks/useFleetCounts.ts` — a single `useMemo` hook returning `{ total, online, unreachable, idle }` from the live `NodeAgent[]` array. One hook, one source, zero divergence.

**`NodeAgent.status`** extended: `'online' | 'offline' | 'degraded' | 'unreachable' | 'idle'` — type-safe and forward-compatible with backend status values.

**Replaced in:**
- `Overview.tsx`: FLEET NODES tile + Fleet Status header pill
- `NodesList.tsx`: Connectivity tile, status-filter tab badges, footer counts

---

### What Was Learned

- **Rules of Hooks is non-negotiable** — moving 4 `useRollingBuffer()` calls before the `if (!s) return` in `DiagnosticRail` was a correctness fix, not an optimization. React will silently misbehave otherwise.
- **CORS `*` is a pre-auth header, not a post-auth one** — it lets any origin send credentials. The fix is per-request echo of allowed origins, which is standard practice.
- **Telemetry without auth is effectively an open write endpoint** — even without user impact today, it's a data integrity risk and a DoS vector once traffic scales.
- **Rate limiting pairing codes is table stakes** — 10^6 codes with no limit = brute-forceable in minutes with a fast connection.
- **cargo audit isolation** — no workspace-level `Cargo.lock` in this repo; audits must be run from `cloud/` and `agent/` subdirectories separately.
- **Single source of truth for UI state** — count divergence between tiles is a trust-eroding class of bug. One hook eliminates the category.

---

## March 12, 2026 — Rolling Smoothing, Nav Polish, Cloud Version Endpoint 🔧

**The Goal:** Eliminate metric jitter in the dashboard display, fix nav visual regressions after the rail refactor, and ship a version endpoint to the cloud backend.

---

### Rolling-Average Display Smoothing ✅ (Shipped)

Display-layer 5-sample rolling average applied to fast-moving metrics — no SSE or agent changes.

**New hook: `src/hooks/useRollingMetrics.ts`:**
- `useRollingBuffer(window=5)` — generic hook backed by `useRef<{buf, lastTs}>`. Deduplicates same-timestamp pushes (React strict-mode safe). Null/NaN values skip the buffer without clearing it.
- `useNodeRollingMetrics()` — per-node hook with three keyed slots (`tps`, `watts`, `gpu`). `resetAll()` fires synchronously when a node goes offline.

**Smoothed metrics in `Overview.tsx`:**
- Fleet: tok/s (Tile 1), Avg WES (Tile 5), W/1K (Tile 6), Cost/1K (Tile 7)
- Per-node: tok/s (Ollama + vLLM combined), total power draw (Watts column), GPU% column
- Fleet dedup key: `Math.max(...effectiveMetrics.map(m => m.timestamp_ms))`
- Per-node buffers reset on node offline transition

---

### Nav & Header Visual Polish ✅ (Shipped)

Five targeted fixes after the collapsible-rail refactor introduced visual regressions:

- **Logo size**: Restored to `text-xl` (was `text-base` — too small post-refactor)
- **Icon vertical position**: `pt-16` on the nav container clears the 64px sticky header zone; icons now start below the header, not overlapping it
- **Nav icon horizontal centering**: `px-6` on nav buttons — icon center lands at exactly 32px = half the 64px rail width
- **Profile avatar centering**: `justify-center group-hover/nav:justify-start` on the button + `max-w-0 overflow-hidden group-hover/nav:max-w-full` on name span — avatar is perfectly centered in collapsed state
- **Icon size normalization**: `UserIcon` at `w-4 h-4` to match nav icons

---

### Cloud Version Endpoint ✅ (Shipped)

`GET /api/agent/version` on the cloud backend — returns `{"version": env!("CARGO_PKG_VERSION")}`. Enables future update-check flows from the hosted dashboard.

---

## March 12, 2026 — Rationalizing the Sovereign Cockpit ⚡

**The Goal:** Ship vLLM runtime detection. Formally document the Cockpit vs. Mission Control identity split. Eliminate the Credibility Gap on local installs.

---

### vLLM Integration ✅ (Shipped v0.4.5)

Full-stack vLLM runtime detection and metrics harvesting across agent → cloud → frontend:

**Agent (`agent/src/main.rs`):**
- `VllmMetrics` struct + 5 fields in `MetricsPayload` (`vllm_running`, `vllm_model_name`, `vllm_tokens_per_sec`, `vllm_cache_usage_perc`, `vllm_requests_running`)
- `harvest_vllm()` — GET `localhost:8000/metrics`, 500ms timeout, Prometheus text line parser (no library)
- `start_vllm_harvester()` — 2s polling loop, `Arc<Mutex<VllmMetrics>>` pattern identical to Ollama harvester
- Dual `MetricsPayload` construction (broadcaster at 10Hz + SSE handler at 1Hz) — both updated; `cargo check` caught the first miss immediately

**Cloud (`cloud/src/main.rs`):**
- 5 fields with `#[serde(default)]` — older agents deserialise cleanly, newer agents populate the fields

**Frontend:**
- `types.ts` — 5 new optional fields on `SentinelMetrics`
- `NodesList.tsx` — dynamic vLLM diagnostic row: CheckCircle when detected, model name, tok/s (green `font-telin`), KV cache % (cyan `font-telin`)
- `Overview.tsx` — fleet throughput sums Ollama + vLLM; MODEL column shows vLLM cache badge; WES leaderboard + HexHive both include vLLM tok/s

**Design decision:** Ollama and vLLM can run simultaneously on the same node. Fleet tok/s = sum of both. No priority, no override — both coexist.

**Key metric note:** vLLM reports `gpu_cache_usage_perc` as 0.0–1.0 in Prometheus. Agent multiplies by 100 for consistent % representation across all surfaces. Document and enforce at the source, not the display layer.

---

### The Cockpit vs. Mission Control Identity Split

The most important architectural decision today: **Wicklee has two UI identities, not one.**

**The Credibility Gap problem:**
When a user runs `localhost:7700` — a single bare-metal node — and sees "Pair your fleet," "Team Management," and "Billing," the UI is lying about their context. It signals cloud SaaS product, not sovereign tool. For the Show HN audience and for HIPAA/defense operators who chose the agent for its sovereignty properties, this erodes trust in all the data.

**The solution:** A single `isLocalhost` flag at runtime branches the entire UI identity:

```typescript
const isLocalhost = window.location.hostname === 'localhost' ||
                    window.location.hostname === '127.0.0.1';
```

**The Cockpit (`localhost:7700`):**
- No Clerk auth — the filesystem is the auth
- 10Hz WebSocket (Hardware Rail pulse charts)
- Zero outbound connections
- Single-node scope — deep diagnostics, not fleet chrome
- "Node Intelligence" tab (not "AI Insights")
- Hardware Rail — live scrolling CPU/GPU/Thermal/Power timeline at 10Hz

**Mission Control (`wicklee.dev`):**
- Clerk auth — JWT, hosted signup/login
- 1Hz SSE via FleetStreamContext (single shared connection)
- Fleet scope — aggregates, WES Leaderboard, Inference Density Map
- "AI Insights" tab with cross-node fleet intelligence
- Team management, billing, node Coverage table

**Why this matters for Show HN:**
The Sovereign by Design thesis requires that the local install looks and feels like sovereign infrastructure — not a cloud product that happens to run locally. The Cockpit identity is the thesis made visible in the product.

---

### Documents Updated This Session

| File | Change |
|---|---|
| `docs/SPEC.md` | Added "Dual-Surface Strategy: Cockpit vs. Mission Control" section; vLLM Harvester marked live; SSE payload vLLM fields documented; Platform Support Linux Thermal updated to shipped |
| `docs/ROADMAP.md` | vLLM Integration + Linux Thermal marked shipped (v0.4.5); Binary Release & Local-Sync Pipeline section added |
| `docs/PROGRESS.md` | This entry |

---

### What Was Learned

- **Dual `MetricsPayload` construction pattern** — agent has two independent MetricsPayload constructions (broadcaster at 10Hz, SSE handler at 1Hz). When adding new fields, both must be updated. `cargo check` caught the miss instantly — the compiler is the checklist.
- **vLLM Prometheus metric units are 0–1, not 0–100** — `gpu_cache_usage_perc` requires ×100 at the agent layer. Enforce at the source, not the display layer.
- **The Credibility Gap is a product problem, not a marketing problem** — it cannot be solved with better copy. It requires a UI identity split backed by runtime detection.
- **`isLocalhost` is a clean enough heuristic** for the current stage — operators accessing the embedded binary will always be on localhost. Edge case (Nginx proxy) is acceptable as a later refinement.
- **Coverage, not Permissions** — "Coverage" describes what metric data the agent can collect from a node. "Permissions" implies access control. The distinction matters for operator mental models.
- **`font-telin` + `tabular-nums` everywhere numeric** — all tok/s, WES, power, cache % values use this. Prevents layout shifts at 10Hz update rates. Typography is load-bearing infrastructure.

---

### Code Shipped This Session

**Commit `b497199` — vLLM integration (5 files, 226 insertions):**
- `agent/src/main.rs` — `VllmMetrics` struct, `harvest_vllm()`, `start_vllm_harvester()`, updated broadcaster + SSE handler + main
- `cloud/src/main.rs` — 5 `#[serde(default)]` vLLM fields
- `src/types.ts` — 5 vLLM fields on `SentinelMetrics`
- `src/components/NodesList.tsx` — dynamic vLLM diagnostic row
- `src/components/Overview.tsx` — fleet tps + WES + HexHive updated for vLLM

---

*"Sovereign by default. Two surfaces, one codebase, one flag."*

---

## March 11, 2026 — WES, Agent-Native, Clerk, and the Two-Database Architecture ⚡

**The Goal:** Coin and ship WES as the live efficiency standard. Redesign the console UI for launch readiness. Lay the agent-native foundation. Integrate Clerk auth. Design the two-database architecture.

---

### WES — Wicklee Efficiency Score

The single most important thing that happened today: **WES was coined and shipped**.

**Formula:**
```
WES = tok/s ÷ (Watts_adjusted × ThermalPenalty)
```
Which is equivalently:
```
WES = tok/watt ÷ ThermalPenalty
```

This second framing is the cleaner explanation: WES is tok/watt made thermally honest. When a node is thermally healthy, WES equals tok/watt. When it's throttling, WES is lower — and the gap tells you exactly how much efficiency is being lost to heat. That gap is **Thermal Cost %**.

**Live fleet scores (at time of coining):**

| Node | tok/s | Watts | WES |
|---|---|---|---|
| Apple M2 (WK-1EFC) | 108.9 | 0.6W | 181.5 |
| Ryzen 9 7950X idle (WK-C133) | 17.3 | 32.5W | 0.53 |
| Ryzen 9 7950X load (WK-C133) | 17.1 | 121.2W | 0.14 |

The 1,296× WES differential between M2 and Ryzen under load is the Show HN headline.

**Academic precedent:** Stanford/Together AI "Intelligence per Watt" (IPW, arXiv:2511.07885). WES is the operational counterpart — live fleet, thermal-aware, real-time. IPW = lab benchmark. WES = fleet operations.

**Dual meaning:** "Wicklee Efficiency Score" (branded) or "Watt-normalized Efficiency Score" (industry-neutral).

**WES v2 planned (spec document produced):**
- Thermal sampling loop — average ThermalPenalty over inference window at 2s intervals, not snapshot
- Separate Raw WES (tok/watt) from Penalized WES (÷ ThermalPenalty)
- Thermal Cost % as named visible quantity: `(tok/watt - WES) / tok/watt × 100`
- NVML throttle reason bitmask for NVIDIA — hardware-authoritative thermal source
- Refined Apple Silicon penalty: Serious→1.75 (was 2.0), Critical→2.0
- `wes_config.json` for configurable thresholds per platform
- "Why is my WES low?" tooltip with full calculation breakdown

**⚠ Breaking change:** Serious penalty 2.0→1.75 shifts existing scores. Capture four-node comparison table AFTER this ships.

---

### Console UI — Full Redesign Pass

**Intelligence page:**
- Fleet Status rows: fixed-width single-line grid, column priority hiding at breakpoints
- Fleet Intelligence: six fleet-level aggregate cards
- Inference Density Map: ✅ hexagonal hive plot, amber pulse on active inference, dim gray idle — the Show HN visual
- Best Route Now card: latency recommendation vs efficiency recommendation, delta line
- WES displayed as headline metric on every node card

**Management page (formerly Node Registry):**
- Four header tiles: Fleet VRAM, Connectivity, Hardware Mix, Lifecycle Alerts
- Fixed-width node table with expand/collapse rows
- "Permissions" column renamed → **Coverage** (metric coverage, not access control)
  - Full ✓ / Partial ⚠ / — with tooltip explaining what's available per node
- Responsive column hiding: always visible (Status+NodeID, Identity, Connectivity, Coverage), hide at breakpoints (Agent Version, OS, Uptime, Memory)
- Telemetry endpoint URL removed — was exposing Railway internal URL with no user value
- Expanded row: Connectivity | Node Settings (read-only) | Diagnostics

**Settings page — full redesign:**
- Cost & Energy: kWh rate, currency, PUE multiplier with live cost preview panel
- Node Configuration table: per-node overrides with amber indicator on overridden cells
- Display & Units: temperature, power display, WES precision, theme
- Alerts & Notifications: locked preview (Phase 4A)
- Account & Data: agent version, pairing, export, danger zone
- Auto-save to localStorage, no Save button anywhere
- getNodeSettings(nodeId) helper: resolves node override ?? fleet default

**Bug fixes:**
- Memory % showing 15 decimal places → fixed to 1dp
- Missing memory showing "memory —" → now shows clean "—"
- Permissions/Coverage column wrapping onto second line → single-line enforcement

**Navigation restructure:**
- Settings removed from primary left nav → single ⚙ icon in bottom anchor
- Profile dropdown cleaned: identity header, Settings, Docs, Release Notes, Sign out
- Removed: Account Security, API Keys, AI Providers, Preferences, Billing from dropdown
- Single profile entry point: lower left only. Topbar avatar removed.
- Theme toggle removed from topbar → Settings → Display & Units
- Search tab removed — no backend to power it, returns in Phase 4A with DuckDB
- Topbar: Search · Pair node · Notifications only

**Status indicators — consistency pass:**
- Per-node dots: Green (online <60s), Red (offline >60s), Gray (pending)
- SSE indicator: Green/all nodes (pulsing), Amber/some offline (pulsing), Red/disconnected (no pulse)
- Footer fleet count: "Fleet: 2 / 3 online" with color matching severity
- Tooltips on all three surfaces showing per-node last-seen elapsed time

---

### Marketing Site

**New hero copy:**
> **Local AI inference, finally observable.**
> Routing intelligence. True inference cost. Thermal state. Live, across every node. Built for Ollama and vLLM. Install in 60 seconds — nothing to configure.

**Blog launched:**
- Markdown files in Railway repo — git push is the publish action
- `/blog/[slug]` renders HTML for humans
- `/blog/[slug].md` serves raw Markdown for agents
- Defensive frontmatter parsing: missing fields degrade gracefully, never crash listing
- "Blog" added to marketing site top nav between Documentation and GitHub

**`/llms.txt` published:**
- Plain text index of site content and API surface for LLM consumption
- Lists blog posts, API endpoints (current and coming), MCP server (Phase 5), docs, install commands
- The `robots.txt` for the agent era

---

### Agent-Native Vision — Coined and Documented

The strategic insight captured today: **Wicklee is built for humans and their agents.**

Most SaaS is being retrofitted for agents as an afterthought. Wicklee is designed for both from the start. The data Wicklee collects — WES scores, thermal state, tok/s, cost per token, node availability — is exactly what an orchestration agent needs to make intelligent routing decisions.

**The four-phase progression:**
```
Phase 3A  →  /llms.txt + Markdown blog     agents can discover and read Wicklee
Phase 3B  →  Agent API v1                  agents can query live fleet data
Phase 4A  →  /api/v1/insights/latest       agents can consume Wicklee intelligence
Phase 5   →  MCP server                    agents call Wicklee tools natively
```

**Agent API v1 designed (Phase 3B):**
```
GET /api/v1/fleet           → fleet summary
GET /api/v1/fleet/wes       → WES scores, ranked
GET /api/v1/nodes/{id}      → single node deep metrics
GET /api/v1/route/best      → latency vs efficiency recommendation
```

The `/route/best` endpoint is the one agents need most — returns two opinionated recommendations with reasoning JSON.

**Blog post drafted:** "Built for Humans and Their Agents" — ready to publish after Show HN.

---

### Clerk Auth Integration ✅

Replaced DIY bcrypt/session auth with Clerk. Eight tasks completed by Claude Code:

1. `@clerk/clerk-react` installed
2. `VITE_CLERK_PUBLISHABLE_KEY` added to env (Vite stack, not Next.js)
3. App wrapped with `<ClerkProvider>`
4. DIY auth state removed — replaced with `useAuth()` / `useUser()`
5. `SignInPage.tsx` / `SignUpPage.tsx` — Clerk `<SignIn>` / `<SignUp>` components
6. Sidebar uses `useClerk()` for signOut and `openUserProfile()`
7. AddNodeModal token from `useAuth().getToken()`
8. `AuthModal.tsx` deleted

**What Clerk now handles:** password hashing, session management, token refresh, email verification, password reset, 2FA, active session management. None of this is custom code.

**"Manage Account"** added to profile dropdown → opens Clerk hosted account portal.

---

### Two-Database Architecture — Designed and Documented

The key architectural decision: **two databases, two purposes, one sovereign promise.**

```
Local agent SQLite  →  on-node, embedded in Rust binary
                        powers localhost:7700 entirely
                        never leaves node without explicit export

Cloud SQLite        →  Railway, multi-tenant
                        powers wicklee.dev fleet console
                        receives only SSE stream subset when paired
```

**Local agent schema:** `metrics_history`, `inference_runs`, `thermal_events`, `model_registry`. 90-day retention on metrics, 1-year on runs, unlimited thermal events.

**Cloud schema:** `fleet_metrics`, `fleet_events`, `node_registry`, `user_settings`, `api_keys` (Phase 3B). Scoped by Clerk `user_id`.

**Sovereign Mode (Phase 5)** becomes a single feature flag — disable the SSE forward branch. The two-database architecture makes this trivially implementable rather than a rewrite.

**DuckDB deferred:** SQLite handles all Phase 4A analytical queries at current scale (3-50 node fleets). Migration trigger: when P50/P95 queries over 90 days exceed 200ms. Schema designed for clean migration when that time comes.

---

### Documents Produced This Session

| File | Purpose |
|---|---|
| `ROADMAP_merged.md` | Full roadmap incorporating all session additions |
| `DATABASE_ARCHITECTURE.md` | Two-database design with full schemas |
| `built-for-humans-and-their-agents.md` | Blog post draft, ready to publish post-Show HN |
| `claude_code_clerk_prompt.md` | Clerk integration prompt (executed, complete) |
| `claude_code_blog_llms_prompt.md` | Blog + llms.txt prompt (executed, complete) |
| WES Implementation Spec | Agent changes for WES v2 (external doc, reviewed) |

---

### What Was Learned

- **WES = tok/watt ÷ ThermalPenalty** is the cleaner framing. Leads with tok/watt as an already-understood metric, positions WES as its thermal-honest extension. Thermal Cost % is the gap made visible.
- **"Permissions" is the wrong word** for metric coverage — implies access control rather than data quality. "Coverage" is precise and unambiguous.
- **Two database problem is real and architectural.** Local data must live in a local database by design, not policy. Cloud gets only what's needed for fleet aggregation.
- **Agent-native is a founding assumption, not a feature.** `/llms.txt` and raw Markdown routes are the first step of a deliberate progression toward MCP server. Each phase builds on the last.
- **Clerk on Vite requires `VITE_` prefix** on publishable key — not `NEXT_PUBLIC_`. Claude Code adapted correctly without being told.
- **The SSE indicator showing green when nodes are offline** erodes trust in all data. Status must be fleet-state-aware, not just connection-aware.

---

### Code Shipped This Session (commits ddbad6d → f21a4f8)

**Clerk auth** (`f21a4f8`):
- `@clerk/clerk-react` installed; `ClerkProvider` in `src/index.tsx` with `VITE_CLERK_PUBLISHABLE_KEY`
- `useAuth` + `useUser` replace all DIY session state; `getToken()` replaces `localStorage` token reads
- `/sign-in` + `/sign-up` path-routed pages; `AuthModal.tsx` deleted
- Sidebar: `signOut()` + `openUserProfile()` via `useClerk()`; "Manage Account" added to dropdown
- Header search bar removed

**`src/utils/time.ts`** — new shared module:
- `NODE_REACHABLE_MS = 60_000` — single threshold for all reachability checks
- `fmtAgo(ms)` — <60s → "just now", else Xm/Xh/Xd ago

**SSE indicator overhaul** (Intelligence page, Fleet Status card header):
- 3-state: green+pulse (all nodes <60s), amber+pulse (some nodes >60s), red/no-pulse (stream down)
- Hover tooltip lists node IDs + elapsed time per unreachable node

**Node status consistency** (3 surfaces, same `NODE_REACHABLE_MS`):
- Fleet Status rows: green/red/gray dot with reachability tooltip (was always green)
- Management table: threshold updated 30s → 60s; same 3-state dot; amber permission indicator removed from reachability dot
- Footer: "Fleet: X / Y online" with green/amber/red text + per-node tooltip breakdown; `nodeLastSeenMs` captured from existing App-level SSE

**Coverage column** (Management page):
- "Permissions" → "Coverage"; header tooltip added
- Offline: `—` with "Node offline — coverage unknown"; Full: `✓ Full`; Partial: `⚠ Partial` with dynamic missing-metric tooltip
- Row height locked: `max-h-[48px] overflow-hidden` — no wrapping

---

### Current State

**Live fleet:** Apple M2 (WK-1EFC) ✅, GeiserBMC Ryzen (WK-C133) ✅, Andy_PC RTX 3070 (WK-03E2) ⬜ pending Ollama install

**Critical path to Show HN:**
```
Andy_PC Ollama install  →  RTX 4090 Vast.ai test (~$0.50/hr)
→  Four-node WES table (after WES v2 penalty fix)
→  dev.to article  →  Show HN
```

**Remaining code work before Show HN:**
- WES v2: thermal sampling loop, NVML bitmask, dual display, wes_config.json
- Mock data fix on fleet overview cards
- Local agent SQLite (embedded Rust)

---

*"Local AI inference, finally observable."*

---

## March 1–2, 2026 — The London Protocol 🇬🇧☕

**The Goal:** Go from "Rust agent + separate React frontend" to a single binary that serves a live hardware dashboard at `localhost:7700` with zero separate processes, zero sudo, and metrics that Activity Monitor can't show.

**What Shipped:**

### Binary UI (Commit 6e5c725)
- Added `rust-embed` and `mime_guess` to `agent/Cargo.toml`
- Created `StaticAssets` struct embedding `frontend/dist/` directly into the binary at compile time
- Axum router now serves the React app at `/`, with SPA fallback for sub-routes (`/nodes`, `/team`, etc.) so React Router works on page refresh
- SSE endpoint live at `/api/metrics` — 1 event per second
- Clean ASCII startup box printed to terminal on launch
- Vite build output redirected to `agent/frontend/dist/` to match the embed path

### Deep Metal — Apple Silicon (Commits 4988706, 8cec0f7)
- `ioreg -r -c IOGPUDevice` → GPU Utilization % (no sudo, M-series compatible)
- `pmset -g therm` → Thermal State mapped to Normal / Elevated / High / Critical (no sudo)
- `vm_stat` → Memory Pressure % computed from wired + active pages only (dropped inactive/speculative inflation)
- `powermetrics` attempted without sudo — graceful `null` on failure, never crashes
- `machdep.xcpm.cpu_thermal_level` sysctl attempted — graceful `null` on M-series (Intel only)
- All privileged metrics (`cpu_power_w`, `ecpu_power_w`, `pcpu_power_w`) return `null` with clear dashboard label

### Dashboard Wiring (Overview.tsx)
- `EventSource('/api/metrics')` hooked into `useEffect` — relative URL works for both embedded binary (7700) and Vite dev proxy (3000)
- Green pulsing dot when SSE connected, grey "Reconnecting…" on drop with 3s auto-retry
- Sentinel Node panel: CPU %, Memory Used/Total, Memory Available, CPU Cores, Thermal State (color-coded badge)
- Apple Silicon row: GPU Utilization, Memory Pressure — conditionally rendered only when data is non-null
- All fields show `—` until first SSE frame arrives

### Bug Fixes
- `available_memory_mb` was always `0` on macOS — fixed using `total_memory().saturating_sub(used_memory())` (sysinfo's `available_memory()` is unreliable on macOS 0.30)
- Memory pressure was inflated by inactive pages — recalculated as wired + active only

**Final SSE Stream (verified live):**
```json
{
  "node_id": "JEFFs-MacBook-Pro-2.local",
  "cpu_usage_percent": 29.4,
  "total_memory_mb": 8192,
  "used_memory_mb": 6654,
  "available_memory_mb": 1537,
  "memory_pressure_percent": 99.0,
  "gpu_utilization_percent": 29.0,
  "thermal_state": "Normal",
  "cpu_power_w": null,
  "ecpu_power_w": null,
  "pcpu_power_w": null,
  "cpu_core_count": 8,
  "timestamp_ms": 1772405021684
}
```

**What Was Learned:**
- `powermetrics` requires a privileged kernel entitlement on macOS — there is no sudoless workaround for CPU cluster power. Own it, label it honestly.
- `machdep.xcpm.cpu_thermal_level` is Intel-only. M-series thermal comes from `pmset`.
- `ioreg -r -c IOAccelerator` is the wrong class on M-series. `IOGPUDevice` is correct.
- rust-embed with Brotli compression keeps the embedded JS reasonable despite React + Recharts + Lucide bundle size.
- SPA fallback in Axum is essential — forgetting it causes 404s on any browser refresh of a sub-route.

**What's Next:**
- Fix memory pressure calc (wired + active only — drop speculative/inactive)
- `make install` → `wicklee` global CLI
- 10Hz WebSocket for liquid pulse charts
- NVIDIA/NVML support for Linux nodes
- `docs/` folder: SPEC.md, ROADMAP.md, progress.md committed to repo

---

*"Your fleet data never leaves your network until you choose."*
