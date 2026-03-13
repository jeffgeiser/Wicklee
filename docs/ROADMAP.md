# Wicklee Roadmap 🛰️

> *Sovereign GPU fleet monitoring. Built for humans and their agents.*

---

## ✅ Shipped (v0.4.5)

**Agent & Platform**
- Rust agent, single binary — zero runtime dependencies, ~700KB
- Embedded React/Tailwind dashboard at `localhost:7700`
- Sudoless Deep Metal on Apple Silicon: CPU, GPU, Thermal State, Memory Pressure
- NVIDIA/NVML support: board power, VRAM used/total, GPU temp — sudoless on Linux
- Linux musl binaries — runs on Ubuntu 18.04+ with no glibc dependency
- Linux RAPL CPU power via `/sys/class/powercap` (kernel 5.10+)
- AMD Ryzen chip name detection from `/proc/cpuinfo`
- Windows support via NVML
- Global CLI install: `curl -fsSL https://wicklee.dev/install.sh | bash`
- PowerShell install: `irm https://wicklee.dev/install.ps1 | iex`
- 4-platform GitHub Actions release pipeline (macOS, Windows, Linux x64/arm64)

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
- vLLM integration: Prometheus `/metrics` at `localhost:8000` — real tok/s (no 30s probe), model name, KV cache utilisation %, requests running; 2s poll; `#[serde(skip_serializing_if)]` keeps JSON compact when not running

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

**WES v2 — Raw + Penalized + Thermal Cost**
> Elevates WES from a snapshot to a window measurement. Introduces Thermal Cost %
> as a named, visible quantity. Makes thermal penalty legible to operators.

- [ ] **Thermal sampling loop** — independent 2s sampling task during active inference. Averages `penalty_value` across the window → `thermal_penalty_avg`. Also tracks `thermal_penalty_peak` for alerting.
- [ ] **MetricsPayload additions** — `penalty_avg`, `penalty_peak`, `thermal_source` (`iokit` | `nvml` | `clock_ratio` | `unavailable`), `sample_count`. All optional fields — no breaking changes.
- [ ] **Refined penalty mapping** — Serious: 1.75 (was 2.0), Critical: 2.0. ⚠ Breaking change to existing WES scores — version-stamp all benchmarks after this ships.
- [ ] **NVML throttle reason bitmask** — `nvmlDeviceGetCurrentClocksThrottleReasons()`. Elevates NVIDIA thermal data from temperature-inferred to hardware-authoritative. Multi-reason: 2.5, HW_THERMAL: 2.0, SW_THERMAL: 1.25, pre-throttle (>90°C): 1.1.
- [ ] **Dual WES node card** — Raw WES + Penalized WES + Thermal Cost % on every node card. Thermal Cost % is the primary alert signal — not raw temperature, not WES alone.
- [ ] **Fleet Leaderboard with Raw/Penalized columns** — rank by Penalized WES (operational reality), Raw WES as secondary. Gap = architectural vs thermal underperformance.
- [ ] **"Why is my WES low?" tooltip** — inline calculation breakdown: tok/s ÷ Watts ÷ Penalty = WES, with Thermal Cost % and recommended action.
- [ ] **`wes_config.json`** — configurable penalty thresholds per platform. Sane defaults ship tuned for standard deployments. Operators can override for unusual hardware or environments.

### Local Intelligence Tab — Free Tier Insight Cards
- [ ] **Model-to-Hardware Fit Score:** Ollama model size + VRAM/unified memory + thermal state → "Poor/Fair/Good fit" with recommendation. Always shown when a model is loaded.
- [ ] **Thermal Degradation Correlation:** Named insight card when thermal state transition + tok/s drop detected simultaneously. Shows before/after tok/s, causal chain, recommendation.
- [ ] **Power Anomaly Detection:** Fires when board power exceeds 2× session baseline or when power/GPU utilization ratio is anomalous. Flags runaway processes invisible to standard monitoring.
- [ ] **Unified Memory Exhaustion Warning (Apple Silicon):** Correlates Ollama model size + available unified memory + vm_stat pressure. Warns before swap storm — not after.
- [ ] **Model Eviction Prediction:** Fires 2 minutes before predicted Ollama model unload based on `/api/ps` inactivity. Free: warning. Paid: "Keep Warm" toggle sends silent ping to reset `keep_alive` timer.
- [ ] **Idle Resource Notice:** Node online >1hr with zero inference activity. Shows estimated electricity cost of idle time.

### Fleet Intelligence Panel
- [ ] **Fleet WES Leaderboard:** WES-ranked across all nodes. Cross-node efficiency comparison that accounts for thermal state — "which node is most efficient per token right now?" answered live.
- [ ] **Fleet Thermal Diversity Score:** Distribution of thermal states across the fleet. "3/4 nodes thermally stressed — fleet is one spike from cascade failure." Free: score. Paid: Slack alert.
- [ ] **Fleet Inference Density Map:** ✅ Hexagonal hive plot — glowing pulse on active inference nodes, cold dim on idle. Visual utilization map, demo-video-ready.
- [ ] **Idle Fleet Cost Card:** Daily electricity cost of idle nodes with PUE multiplier support. Formula: `idle_watts × pue × hours × kwh_rate`. Shows "Node: $X/day · Facility: $Y/day (PUE 1.4)" so math is transparent.

### Settings ✅
- [x] **Cost & Energy section:** kWh rate, currency, PUE multiplier with live cost preview
- [x] **Node Configuration table:** per-node overrides for kWh, currency, PUE, location label
- [x] **Display & Units:** temperature units, power display, WES precision, theme
- [x] **Alerts & Notifications:** locked preview (Phase 4A)
- [x] **Account & Data:** agent version, pairing, export, danger zone
- [x] **Reset button polish:** column reset label shortened to "Reset"; right-aligned under kWh Rate and PUE to match column text alignment

### Fleet UI ✅
- [x] Fleet Status row redesign — fixed-width single-line grid
- [x] Fleet Intelligence aggregates — six fleet-level cards
- [x] Management page — four header tiles, fixed-width node table
- [x] Responsive layout — column priority hiding on both tables
- [x] Navigation restructure — single profile entry point lower left
- [x] Profile dropdown cleanup — identity, Settings, Docs, Release notes, Sign out

### UI Conventions — Telin Audit
> `font-telin` (JetBrains Mono + `tabular-nums`) is the required class for all live numeric telemetry.
> `font-mono` is for static strings only (code, keys, URLs). Wrong token = layout jitter at 10Hz.

- [ ] **Telin Audit — existing components:** Sweep all 83+ `font-telin` usages and confirm zero regressions to bare `font-mono` on numeric values. Flag any `font-mono` on a live SSE-derived field as a bug.
- [ ] **Telin gate — new Insight cards:** Model-Fit Score, Thermal Degradation Correlation, Power Anomaly, Memory Pressure Forecast, Tok/s Regression delta — all derived numeric scores must use `font-telin`. Enforce in PR review checklist.
- [ ] **Telin gate — `font-sans` on numbers:** Catch any numeric telemetry value rendered in `font-sans` (Inter). Inter has no `tabular-nums` variant at the weights we use — layout shift guaranteed under load.

### Live Activity — New Event Types
- [ ] Power anomaly detected/resolved
- [ ] Model eviction predicted / Keep Warm action taken
- [ ] Thermal degradation confirmed (causal chain, not just state change)
- [ ] Fit score changed (model loaded/unloaded)

### Agent-Native Foundation ✅
> Wicklee is built for humans and their agents. The marketing site and blog
> are the first step — agents can discover and read Wicklee before the API exists.

- [x] **`/llms.txt`** — plain text index of site content and API surface for LLM consumption. The `robots.txt` for the agent era. Lists blog posts, API endpoints, MCP server (future), docs. Served at `wicklee.dev/llms.txt`.
- [x] **Blog at `/blog`** — Markdown files in `/public/blog/`. Rendered HTML for humans, raw `.md` route for agents. No CMS, no cost, git push is the publish action.
- [x] **Raw Markdown route** — every post served at `/blog/[slug]` (rendered) and `/blog/[slug].md` (raw text). Agents fetch the `.md` directly.
- [x] **Path-based routing** — `currentPath` state + `navigate()` + `popstate` listener in App.tsx. Blog routes bypass auth entirely.
- [x] **Blog nav link** — "Blog" added to LandingPage nav between Documentation and GitHub.
- [ ] **First post content:** `wes-the-mpg-for-local-ai-inference.md` — WES formula, live fleet data, four-node comparison table, IPW academic citation (arXiv:2511.07885). *(placeholder live, full article pending)*

### Launch Prep
- [ ] Fix mock data on localhost fleet overview cards
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
- [x] **vLLM Integration:** ✅ Shipped (v0.4.5). Prometheus `/metrics` at `localhost:8000`. Real tok/s, model name, KV cache %, requests running. Ollama and vLLM can run simultaneously — fleet tok/s sums both.
- [x] **Linux Thermal:** ✅ Shipped (v0.4.5). `/sys/class/thermal` — thermal state on GeiserBMC and similar bare metal nodes.
- [ ] **Windows Thermal:** WMI thermal data for Windows nodes. Annotated as "estimated" in UI — lowest data quality platform.
- [ ] **ANE Utilization:** Apple Neural Engine utilization and wattage — the metric Activity Monitor doesn't show.
- [ ] **macOS CPU Power (sudoless):** Entitlement-based `powermetrics` access without requiring root.

### Binary Release & Local-Sync Pipeline
- [ ] **Automated UI Sync** — post-build script that copies `frontend/dist/` into the agent embed path and verifies hashes match the cloud deployment. Prevents version drift between the Cockpit SPA and Mission Control SPA. Build gate: block release if hashes diverge.
- [ ] **10Hz WebSocket** — Hardware Rail for the Cockpit. Rolling CPU/GPU/Thermal/Power sparkline at 10 frames/second. Separate `/ws` endpoint from the 1Hz `/api/metrics` SSE stream. The pulse chart is the Cockpit's signature visual.
- [ ] **Sovereign Mode Toggle** — UI control in Settings → Account & Data. Permanently disables the cloud relay even when a pairing code is entered. Backed by a `sovereign.lock` file that the agent respects on restart. Enterprise gate for HIPAA/defense operators who cannot have outbound telemetry under any circumstances.

### WES Platform Expansion
- [ ] **AMD CPU thermal** — k10temp + clock ratio derivation. Cache max boost at agent startup. Clock ratio thresholds: ≥0.95→1.0, ≥0.80→1.25, ≥0.60→1.75, <0.60→2.5. Temperature tie-breaker at >85°C. Flagged as `clock_ratio` source in UI.
- [ ] **Intel CPU thermal** — `thermald` zone states (Linux) with clock ratio fallback. Same `clock_ratio` source annotation.
- [ ] **WES history chart** — per-node time series. Raw WES as slow-moving baseline (hardware ceiling). Penalized WES as live line. Gap shaded as thermal cost area. Primary visualization for the benchmark research series.
- [ ] **Thermal Cost % alerts** — Info >10%, Warning >25%, Critical >40%. Alert on rate-of-change as well as absolute — a 15% drop in 5 minutes is more urgent than a steady 20%.
- [ ] **Benchmark report output format** — reproducible, citable: model, prompt, token count, date, Wicklee version, per-node Raw WES / Penalized WES / Thermal Cost % / Thermal Source. Enables the published research series.

### Agent API v1 *(new)*
> The first machine-readable interface to Wicklee fleet data.
> Agents are first-class consumers — same data as the dashboard, JSON over HTTP.

- [ ] **`GET /api/v1/fleet`** — fleet summary, all nodes, current state
- [ ] **`GET /api/v1/fleet/wes`** — WES scores across all nodes, ranked
- [ ] **`GET /api/v1/nodes/{id}`** — single node deep metrics
- [ ] **`GET /api/v1/route/best`** — opinionated routing recommendation:
  ```json
  {
    "latency":    { "node": "WK-C133", "tok_s": 240, "reason": "Highest throughput" },
    "efficiency": { "node": "WK-1EFC", "wes": 181.5, "reason": "20x WES advantage" },
    "default":    "efficiency"
  }
  ```
- [ ] **API key generation** — Settings → Account & Data
- [ ] **API docs at `/docs/api`** — human and agent readable
- [ ] **Rate limiting** — Community: 60 req/min. Team: 600 req/min.

### Sovereignty
- [ ] **Sovereignty Tab:** Pairing event log, telemetry destination, outbound connection manifest. Structural proof that inference data never left the network.
- [ ] **Audit Log Export (Free):** Exportable pairing and telemetry history.

### Launch Content
- [ ] dev.to article — seed WES term, cite IPW paper, live fleet data
- [ ] LinkedIn article — enterprise/investor framing
- [ ] arXiv comment on 2511.07885 (Stanford/Together AI IPW paper)

---

## Phase 4A — Intelligence Depth + Insights AI *(2–3 months)*

> Requires DuckDB 90-day history. Unlocks trend-based insights and AI-powered briefings.

### Infrastructure
- [ ] **DuckDB Time-Series:** 90-day per-node, per-metric history stored on Railway. Powers all trend-based insights below.
- [ ] **Historical Performance Graphs:** Same metric selector as live graph but spanning 1hr/24hr/7d/30d/90d.
- [ ] **Percentile Baselines:** P50/P95 for tok/s, power, CPU per node — shown as reference lines on graphs.
- [ ] **Per-model WES normalization** — WES at 3B vs 70B is not directly comparable. Normalize against per-model historical baseline in DuckDB. Requires history to establish baseline before normalization is meaningful.

### Insights AI *(new)*
> Wicklee Insights tab becomes AI-powered. Natural language summaries, anomaly
> explanations, and routing recommendations — not hardcoded rules.

- [ ] **Settings → Insights & AI section:** Choose provider — Wicklee Cloud AI (Team Edition) / BYOK Anthropic / BYOK OpenAI / local Ollama endpoint.
- [ ] **Morning Briefing:** Daily fleet summary in plain English. "WK-1EFC ran 847 inferences yesterday at avg WES 134. WK-C133 thermal throttled 3 times — consider workload rebalancing."
- [ ] **Anomaly Explanation:** Natural language explanation of WES drops, thermal spikes, tok/s regression. Causal chain with recommended action — not just a state label.
- [ ] **`GET /api/v1/insights/latest`** — same briefing as JSON. Orchestration agents consume Wicklee intelligence, not just raw metrics.

### Paid Intelligence Insights
- [ ] **Memory Pressure Forecasting:** Rate-of-change on memory pressure → ETA to critical. "At current rate, this node hits critical in ~7 minutes." Slack alert at 15min and 5min thresholds.
- [ ] **Tok/s Regression Detection:** Current probe vs 7-day P50 baseline per node. Alert when >20% degradation.
- [ ] **Quantization ROI Measurement:** Per-model, per-quant tok/s and W/1K TKN stored in DuckDB. "Q4 vs Q8 on YOUR hardware at YOUR thermal state" — live hardware-specific answer.
- [ ] **Efficiency Regression per Model:** "WK-C133 used to run llama3.1:8b at 17 tok/s. It now runs it at 11 tok/s." Baseline history required. Slack alert when >20% regression.
- [ ] **Fleet Degradation Trend:** Fleet-wide tok/s trend over 7/30 days.

### Notifications
- [ ] **Slack / PagerDuty Webhook System:** Per-node, per-event-type configuration. Urgency levels: immediate, 5-min debounce, 15-min debounce, daily digest.
- [ ] **Alert Threshold Configuration:** Per-node thresholds for thermal, power, tok/s, memory pressure.
- [ ] **Idle Cost Weekly Digest:** "Fleet idle cost this week: $X" — emailed or Slacked Monday 9am.

---

## Phase 4B — Commercial Layer *(3–5 months)*

- [x] **Clerk Auth:** ✅ Shipped. Clerk-managed signup/login with JWT. Stream tokens (UUID, 60s TTL) authenticate SSE connections.
- [ ] **Stripe + Team Edition Gate:** 3-node free limit enforcement with upgrade flow.
- [ ] **Keep Warm Toggle (Paid):** Wicklee sends silent ping to reset Ollama `keep_alive` timer before predicted eviction. All actions logged in Live Activity.
- [ ] **CSV / JSON Export:** Any metric, any time range, any node.
- [ ] **Cold Start Detection:** GPU spike + memory jump + elevated TTFT = cold start event. Requires TTFT data from Sentinel Proxy or vLLM metrics.
- [ ] **Event Detail Panel (Live Activity):** Clickable events with metrics snapshot at moment of event, precise timestamp, trigger reason, duration.
- [ ] **LLC Formation:** Wyoming or Delaware via Stripe Atlas or Doola.
- [ ] **Product Hunt launch**

---

## Phase 5 — Enterprise + MCP Server *(6+ months)*

### Sentinel Proxy
- [ ] **Inference Interceptor:** OpenAI-compatible proxy endpoint. Clients point at Wicklee; Wicklee forwards to healthiest node.
- [ ] **Automatic Rerouting:** Transparent workload shifting on thermal/load threshold breach. No client changes required.
- [ ] **Routing Policy Config:** `lowest-wes`, `lowest-watt-per-token`, `lowest-thermal`, `lowest-load`, `round-robin`, `pinned` — selectable per model or client tag.

### MCP Server *(new)*
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

### Sovereignty / Compliance
- [ ] **Cryptographically Signed Audit Export:** PDF signed by the Wicklee Agent's unique hardware ID (WK-XXXX). Tamper-evident. CISO-signable compliance artifact for HIPAA, financial services, defense-adjacent use cases.
- [ ] **Sovereign Mode:** On-premise only — no cloud pairing, no outbound telemetry, airgapped operation.
- [ ] **On-Premise Deployment:** Docker image + Helm chart for self-hosted fleet backend.

### Enterprise Features
- [ ] SSO / SAML
- [ ] HIPAA / SOC2 BAA
- [ ] AMD GPU support (ROCm)
- [ ] Enterprise tier pricing ($199/mo or $X/node)

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
| Agent API v1 | ✅ 60 req/min | ✅ 600 req/min | ✅ Unlimited |
| `/api/v1/route/best` | ✅ | ✅ | ✅ |
| Local Intelligence (session) | ✅ Free cards | ✅ Full + alerts | ✅ Full |
| Local Intelligence (trend-based) | ❌ | ✅ Paid | ✅ Full |
| Insights AI (morning briefing) | ❌ | ✅ | ✅ |
| `/api/v1/insights/latest` | ❌ | ✅ | ✅ |
| Keep Warm toggle | ❌ | ✅ | ✅ |
| 90-day history | ❌ | ✅ | ✅ |
| Slack / PagerDuty | ❌ | ✅ | ✅ |
| MCP server tools | ❌ | ✅ | ✅ |
| Sovereignty audit log | ✅ View | ✅ View | ✅ Signed export |
| Sentinel Proxy routing | ❌ | ❌ | ✅ |
| Sovereign Mode (no cloud) | ❌ | ❌ | ✅ |
| Price | Free | ~$29/mo | ~$199/mo |

---

## Alerting Tiers — Pricing Consideration *(for future design)*

> Alerting capability is the clearest paywall signal in the monitoring space.
> The table below proposes a four-tier alerting model for consideration when Phase 4A
> notifications ship. Key design intent: the $9 Prosumer tier creates a meaningful
> "unattended monitoring" entry point between free and the full Team integration layer.

| Tier | Price | Alerting Capability | Rationale |
|---|---|---|---|
| Community | $0/mo | None — dashboard only | Encourages keeping the tab open. Zero friction to try. |
| Prosumer | $9/mo | Email only | Covers individuals with small clusters who want overnight / unattended monitoring without a Slack workspace. Makes $9 the obvious "middle path" upgrade. |
| Team | $29/mo | Slack + PagerDuty | Integrates with professional on-call rotations. Meaningful step up for teams running production workloads. |
| Enterprise | $199/mo | Webhooks + Custom | Automated failover, custom infrastructure responses, SIEM integration. Enterprise buying motion — procurement-friendly. |

**Open questions for design phase:**
- Does Prosumer get email-only for *all* alert types, or only thermal/power (not tok/s regression)?
- Does the $9 tier get a node cap (e.g., up to 5 nodes) or match Team (unlimited)?
- Email provider for Prosumer tier: Resend (current infra path) or Postmark?
- Should "email digest" (daily summary) be Community/free to drive activation, with real-time email reserved for Prosumer+?

**Tier Structure impact:**
The Prosumer tier ($9) sits between Community and Team in the existing table above.
When this ships, add a Prosumer column to the Tier Structure table with:
- Nodes: up to 5 (TBD)
- Alerting: email only
- History: session only (no 90-day DuckDB)
- Agent API: 60 req/min (same as Community)
- Price: $9/mo

---

## The Agent-Native Vision

> Most SaaS is built for a human who logs in, reads a dashboard, and makes a decision.
> Wicklee is built for humans **and their agents**.

The local dashboard at `localhost:7700` is the human interface — sovereign, zero-login, always available.

The Agent API and MCP server are the agent interface — the same fleet intelligence, machine-readable, consumable by any orchestration agent that needs to know which node to route to next.

An agent running a multi-step inference pipeline calls `wicklee_best_route("efficiency")` before every dispatch. No human in the loop. No dashboard required. Wicklee becomes the routing brain for sovereign AI fleets — whether the decision-maker is a human or their agent counterpart.

**The progression:**
```
Phase 3A  →  /llms.txt + Markdown blog     agents can discover and read Wicklee
Phase 3B  →  Agent API v1                  agents can query live fleet data
Phase 4A  →  /api/v1/insights/latest       agents can consume Wicklee intelligence
Phase 5   →  MCP server                    agents call Wicklee tools natively
```

---

*Wicklee is sovereign infrastructure. Your fleet data never leaves your network until you choose.*
*Built for humans and their agents.*
