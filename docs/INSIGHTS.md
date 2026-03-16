# Wicklee — Intelligence Strategy: 15 Unique Insights 🛰️

> *Every insight on this list is impossible without owning both hardware telemetry and inference runtime context simultaneously. That intersection is Wicklee's structural moat.*

---

## The Core Thesis

Standard monitoring tools see CPU and RAM as separate, unrelated metrics. Wicklee owns both sides:

- **Hardware side:** CPU power (RAPL/NVML), GPU utilization, thermal state, VRAM, memory pressure
- **Runtime side:** model loaded, quantization, size, tokens/sec (Ollama probe / vLLM Prometheus)

The product strategy is built around insights that are only possible at the intersection of both. No other tool has both. This is not a feature list — it is a structural moat.

---

## WES — The Foundation Metric

Before the 15 insights, there is one number that makes them possible: **WES (Wicklee Efficiency Score)**.

### Formula

```
WES = tok/s ÷ (Watts_adjusted × ThermalPenalty)
```

**ThermalPenalty lookup:**

| Thermal State | Penalty |
|---|---|
| Normal | 1.0 |
| Fair | 1.25 |
| Serious | 1.75 |
| Critical | 2.0 |

### Why It Exists

Wattage/1K Tokens tells you what inference costs right now. WES tells you how efficiently the hardware is being used at its current thermal state. Without the thermal penalty, a throttled node looks artificially efficient — it's generating fewer tokens on less power, but the hardware is working far below its true capability.

WES is Wicklee's coined fleet efficiency standard. The concept is aligned with the Stanford / Together AI "Intelligence per Watt" framework (arXiv:2511.07885, Nov 2025), which proposes normalizing AI output quality by energy consumed. WES applies that lens at the operator layer: real tokens, real hardware, real thermal conditions.

### Real Fleet Measurements

| Hardware | Model | tok/s | Watts | Thermal | WES |
|---|---|---|---|---|---|
| Apple M2 | llama3.1:8b | 108.9 | 0.6W | Normal | **181.5** |
| Ryzen 9 7950X | llama3.1:8b | 17.3 | 32.5W (idle probe) | Normal | **0.53** |
| Ryzen 9 7950X | llama3.1:8b | 17.1 | 121.2W (load) | Normal | **0.14** |

Apple Silicon is approximately 340× more WES-efficient than CPU-only inference on the same model.

### Display

WES is shown as a unitless score to one decimal place: "WES 181.5". When tok/s or power data is unavailable, it shows "—". Higher is always better.

### Which Insights Use WES

WES is the primary input to three of the 15 insights:
- **#2** — Wattage-per-Token ROI / Fleet WES Leaderboard: ranks nodes by WES live across heterogeneous hardware
- **#3** — Thermal Degradation Correlation: WES drop quantifies the causal chain (temperature rise → efficiency loss)
- **#10** — Fleet Thermal Diversity Score: thermal penalty distribution drives the fleet health calculation

---

## Implementation Status

| # | Insight | Status | Mechanism | Tier |
|---|---|---|---|---|
| 1 | Unified Memory Exhaustion Warning | ✅ Shipped (Phase 3A) | Threshold crossing, live | Community |
| 2 | Fleet WES Leaderboard | ✅ Shipped (Phase 3A) | Live calculation | Community |
| 3 | Thermal Degradation Correlation | ✅ Shipped (Phase 3A) | Threshold crossing, live | Community |
| 4 | Idle Fleet Cost | ✅ Shipped (Phase 3A) | Live calculation | Community |
| 5 | Model-to-Hardware Fit Score | ✅ Shipped (Phase 3A) | Live calculation | Community |
| 6 | Cross-Node Inference Routing | 🔲 Phase 5 | Sentinel Proxy | Enterprise |
| 7 | Memory Pressure Forecasting | 🔲 Phase 4A open | DuckDB rate-of-change | Team+ |
| 8 | Cold Start Detection | ✅ Shipped (Phase 3B) | Hardware pattern | Community |
| 9 | Quantization ROI | ✅ Live card (Phase 3A) · 🔲 Historical (Phase 4A) | Live / DuckDB | Community / Team+ |
| 10 | Fleet Thermal Diversity Score | ✅ Shipped (Phase 3A) | Live distribution | Community |
| 11 | Power Anomaly Detection | ✅ Shipped (Phase 3A) | Cross-correlated live | Community |
| 12 | Sovereignty Audit Trail | ✅ UI (Phase 3B) · 🔲 Signed export (Phase 5) | UI / Enterprise | Community+ |
| 13 | Model Eviction Prediction | ✅ Shipped (Phase 3A) | /api/ps + timer | Community |
| 14 | Fleet Inference Density Map | ✅ Shipped (Phase 3A) | HexHive visualization | Community |
| 15 | Efficiency Regression per Model | 🔲 Phase 4A open | DuckDB per-model baseline | Team+ |
| A | Thermal Performance Drain *(Pattern Engine)* | ✅ Shipped (Sprint 1) | Time-windowed, localStorage | Community |
| B | Phantom Load *(Pattern Engine)* | ✅ Shipped (Sprint 1) | Time-windowed, localStorage | Community |
| C | WES Velocity Drop *(Pattern Engine)* | 🔲 Sprint 2 | Rate-of-change, localStorage | Community |
| F | Memory Pressure Trajectory *(Pattern Engine)* | 🔲 Sprint 2 | Rate-of-change, localStorage | Community |
| D | Power-GPU Decoupling *(Pattern Engine)* | 🔲 Sprint 3 | Cross-correlated, localStorage | Community |
| E | Fleet Load Imbalance *(Pattern Engine)* | 🔲 Sprint 3 | Fleet-wide, localStorage | Team+ |

**11 of 15 original insights shipped.** 2 pattern engine observations also live. 4 open items remain: #7 (Memory Forecasting alert layer), #15 (Efficiency Regression), #6 (Sentinel Proxy), #9 historical.

---

## The 15 Original Insights

### #1 — Unified Memory Exhaustion Warning
**Tagline:** Warns before the swap storm hits — not after.

Activity Monitor shows memory pressure but has no inference context. It doesn't know your 70B model needs 40GB and you have 2GB of headroom. Wicklee correlates `ollama_model_size_gb` + `available_memory_mb` + `memory_pressure_percent` and warns before the model starts swapping — which manifests as a catastrophic tok/s collapse invisible to any other tool.

- **Where:** Local Intelligence tab — warning card
- **Data:** Ollama model size + vm_stat / /proc/meminfo + memory pressure %
- **Free:** Warning card shown
- **Paid:** Slack alert when headroom < configurable threshold (default 10%)
- **Phase:** 3A

---

### #2 — Fleet WES Leaderboard (Wattage-per-Token ROI Across Heterogeneous Fleet)
**Tagline:** Which node is most WES-efficient for this model right now? Live answer across mixed hardware.

Nobody knows this today without manual math. An M3 Max, RTX 4090, and Ryzen 9 7950X running the same model have vastly different efficiency profiles. Wicklee is the only tool that can answer this question live because it owns both power draw (NVML board power / RAPL) and token throughput (Ollama probe) simultaneously — and applies the ThermalPenalty to give a true efficiency score, not just a raw cost number.

**WES = tok/s ÷ (Watts_adjusted × ThermalPenalty)**

Real measurements from the Wicklee fleet:
- Apple M2 · llama3.1:8b · 5.4W/1K TKN · **WES 181.5**
- Ryzen 9 7950X · llama3.1:8b · 2,080W/1K TKN (idle probe) · **WES 0.53**
- RTX 4090 · llama3.1:8b · ~2,900W/1K TKN (estimated)

Apple Silicon is ~340× more WES-efficient than CPU-only inference on the same model. A thermally stressed high-end node can have a lower WES than a clean mid-range node — raw tok/s alone doesn't tell you this.

- **Where:** Fleet Intelligence panel — Fleet WES Leaderboard card
- **Data:** NVML board power / RAPL + Ollama tok/s + thermal state — live on all nodes
- **Free:** View current leaderboard (WES-ranked)
- **Paid:** Historical trend, alerts on WES regression
- **Phase:** 3A — data exists now ✅

---

### #3 — Thermal Degradation Correlation
**Tagline:** The causal chain invisible everywhere else: temperature rise → tok/s drop, quantified and named.

A node at 89°C isn't just "hot" — its tok/s has silently dropped 30–40% due to throttling. Standard monitoring shows temperature and throughput as separate unrelated metrics. Wicklee can correlate them: "Node WK-C133 dropped from 42 tok/s to 28 tok/s four minutes after thermal state changed to Serious." That causal chain is invisible everywhere else.

- **Where:** Local Intelligence tab — named insight card with before/after tok/s, causal chain, recommendation
- **Data:** Thermal state transitions + tok/s 30s probe — both live now
- **Free:** Session-scope detection, insight card shown
- **Paid:** Trend analysis, Slack alert on confirmed degradation event
- **Phase:** 3A — data exists now ✅

---

### #4 — Idle Fleet Cost Visibility
**Tagline:** Teams leave GPU nodes running 24/7. Nobody knows what that costs. Wicklee shows it live.

Across a 4-node fleet, idle power draw can represent $200–400/month in electricity that nobody is tracking. Wicklee surfaces idle power per node continuously, with a PUE multiplier for accurate datacenter cost.

**Formula:** `idle_watts × pue × 24hrs × (kwh_rate / 1000) = $/day`

**PUE Multiplier** (configurable in Settings):
- Home lab / desktop: 1.0 (no overhead)
- Standard datacenter: 1.4–1.6
- Hyperscale colo: 1.1–1.2

UI shows: "Node: $X.XX/day · Facility: $Y.YY/day (PUE 1.4)" — math always visible.

- **Where:** Fleet Overview — 8th summary card + Local Intelligence idle notice
- **Data:** Idle board power / RAPL per node + kWh rate + PUE setting
- **Free:** Live idle cost card
- **Paid:** Weekly cost digest via Slack
- **Phase:** 3A — data exists now ✅

---

### #5 — Model-to-Hardware Fit Score
**Tagline:** "Llama-3-70B on 8GB M2: Poor fit. Recommended: Llama-3-8B-Q4 or add a node."

When Ollama reports the loaded model and Wicklee knows the hardware specs, it can surface a fit score: does this hardware have enough VRAM/unified memory headroom to run this model without thrashing? No tool does this today — it requires owning both the hardware telemetry and the runtime context simultaneously.

**Scoring:**
- ✅ **Good:** Model fits with >20% memory headroom, thermal Normal
- 🟡 **Fair:** Model fits but memory pressure >60% or thermal Fair
- 🔴 **Poor:** Memory headroom <10%, thermal Serious, or model exceeds VRAM

- **Where:** Local Intelligence tab — always shown when a model is loaded
- **Data:** Ollama model size + available unified/VRAM memory + thermal state + memory pressure
- **Free:** Fit score card with recommendation
- **Paid:** Alert when fit score degrades to Poor
- **Phase:** 3A — data exists now ✅

---

### #6 — Cross-Node Inference Routing (Sentinel Proxy)
**Tagline:** Route each request to the currently most efficient node. Novel routing strategy — doesn't exist in any inference proxy today.

When Wicklee knows the live W/1K TKN for every node in the fleet, it can route each incoming inference request to whichever node is currently the most cost-efficient. This isn't round-robin — it's efficiency-aware routing that dynamically shifts with thermal state, load, and model fit. The policy options include `lowest-watt-per-token`, `lowest-thermal`, `lowest-load`, and `pinned`.

- **Where:** Phase 5 — Sentinel Proxy architectural component (separate from dashboard)
- **Data:** Live W/1K TKN + thermal state + VRAM headroom + queue depth
- **Free:** No
- **Paid:** Enterprise tier
- **Phase:** Phase 5 — requires Sentinel Proxy

---

### #7 — Inference-Aware Memory Pressure Forecasting
**Tagline:** "At current rate, this node hits critical memory pressure in ~7 minutes." Predictive, with inference context.

Standard memory tools show current state. Wicklee can show trajectory — if memory pressure is at 65% and rising 2% per minute under current load, with a 40GB model loaded, the swap storm arrives in ~7 minutes. No tool does predictive pressure forecasting with inference context because it requires owning the time-series data AND knowing what model is loaded.

- **Where:** Local Intelligence tab — Forecast card with ETA countdown
- **Data:** Memory pressure time-series (DuckDB) + rate of change + model size loaded
- **Free:** No
- **Paid:** Team Edition — Slack alert at 15min and 5min ETA thresholds
- **Phase:** Phase 4A — requires DuckDB history

---

### #8 — Cold Start Detection
**Tagline:** GPU spike + VRAM jump = cold start. Hardware-pattern detection — no proxy or TTFT required.

The first inference request after a model loads is always slower — model weights are paging into memory. Standard monitoring sees GPU utilization spike, VRAM jump, and slow response as three unrelated metric events. Wicklee identifies the causal hardware pattern: cold start event, with timestamp and duration — no HTTP proxy or TTFT interception required. Sentinel Proxy (Phase 5) adds TTFT precision as an optional enhancement for teams that want sub-request granularity.

- **Where:** Local Intelligence + Live Activity event type
- **Data:** GPU utilization spike + VRAM jump (hardware pattern — no proxy required); Sentinel Proxy adds TTFT precision (Phase 5, optional)
- **Free:** Live Activity event (free, on detection)
- **Paid:** Alert on repeated cold starts
- **Phase:** Phase 3B ✅ — hardware detection available now

---

### #9 — Quantization ROI Measurement
**Tagline:** Q4 vs Q8 on YOUR hardware at YOUR thermal state. No benchmark database can give you this answer.

The right quantization choice depends on hardware. Wicklee can measure: Q4 on this node = X W/1K TKN at Y tok/s. Q8 = X' W/1K TKN at Y' tok/s. That's a live, hardware-specific answer derived from actual conditions on your node — current thermal state, memory pressure, and load included. Published benchmarks assume clean conditions that don't reflect production inference.

**Two delivery tiers:**
- **Live session card (Community free):** Current model, current node snapshot — W/1K TKN, tok/s, WES by quant level. Shown in Local Intelligence tab whenever a model is loaded. Persisted in localStorage (24h expiry).
- **Historical comparison (Team+):** Per-model, per-quant tok/s and W/1K TKN stored in DuckDB. Cross-session comparison: "Q4 on this node has averaged 12% better WES than Q8 over the past 30 days."

- **Where:** Local Intelligence tab — Quantization ROI card (session card always shown; historical comparison gated)
- **Data:** Live: current tok/s + W/1K TKN from active probe. Historical: per-model, per-quant DuckDB records
- **Free:** Live session card (Community)
- **Paid:** Historical DuckDB comparison (Team Edition)
- **Phase:** Phase 3A (live session card ✅) / Phase 4A (historical DuckDB comparison)

---

### #10 — Fleet Thermal Diversity Score
**Tagline:** "3/4 nodes thermally stressed — fleet is one spike from cascade failure."

If three nodes are at Serious thermal state, the fleet is vulnerable. A single additional load spike causes a cascade. Standard monitoring shows per-node status — nobody tracks the distribution of thermal states at the fleet level. Wicklee can surface a fleet health score based on the thermal state distribution across all paired nodes.

**Scoring:**
- 🟢 **Healthy:** All nodes Normal or Fair
- 🟡 **Stressed:** >25% of nodes at Serious
- 🔴 **Critical:** >50% of nodes at Serious or Critical

- **Where:** Fleet Overview — Fleet Health card (8th summary card)
- **Data:** Thermal state distribution — all paired nodes, live now
- **Free:** Score card shown
- **Paid:** Slack alert when score reaches Stressed or Critical
- **Phase:** 3A — data exists now ✅

---

### #11 — Power Anomaly Detection
**Tagline:** 450W at 30% GPU utilization. Something is consuming power that isn't inference work.

A node drawing full board power at low GPU utilization has a mismatch — a background process, a memory leak, a runaway job consuming power without doing inference work. Standard monitoring sees power and GPU utilization as separate metrics and never connects the anomaly. Wicklee cross-correlates them in real time.

- **Where:** Local Intelligence tab — Anomaly card + Live Activity event
- **Data:** Board power (NVML/RAPL) + GPU utilization % — cross-correlated
- **Free:** Detection + in-dashboard card
- **Paid:** Slack alert on sustained anomaly >5 minutes
- **Phase:** 3A — data exists now ✅ (NVML nodes; RAPL nodes Phase 3B)

---

### #12 — Sovereignty Audit Trail
**Tagline:** Structural proof that inference data never left the network. Not a nice-to-have — a compliance requirement.

Every other monitoring solution requires you to trust that data isn't being exfiltrated. Wicklee's architecture makes the guarantee structural — the agent only phones home when the operator explicitly pairs it. For HIPAA, financial services, and defense-adjacent inference use cases, this isn't a nice-to-have, it's a procurement requirement.

**Observability tab — Sovereignty section content:**
- Complete pairing event log (timestamp, destination IP, session duration)
- Telemetry destination: `wicklee.dev` or "Sovereign Mode: no outbound telemetry"
- Outbound connection manifest: every domain the agent has ever connected to

**Cryptographically Signed Export (Enterprise):** PDF signed by the agent's unique hardware ID (WK-XXXX) using HMAC-SHA256. Tamper-evident. A CISO can independently verify the document hasn't been modified since export. This is the compliance artifact that wins HIPAA and defense contracts.

- **Where:** Observability tab → Sovereignty section (not a standalone tab)
- **Data:** Agent pairing events + telemetry destination log
- **Free:** View only
- **Paid (Team):** View + audit log export (CSV)
- **Paid (Enterprise):** Cryptographically signed PDF export + Sovereign Mode (no cloud)
- **Phase:** 3B (UI surface) / Phase 5 (signed export)

---

### #13 — Model Eviction Prediction
**Tagline:** Ollama quietly unloads models after inactivity. Wicklee can predict the eviction before it happens.

Ollama unloads models after a `keep_alive` timeout (default 5 minutes of inactivity). The next request pays the cold start penalty. Wicklee already polls `/api/ps` — it knows the last activity time and the model size (larger models = slower reload). It can predict eviction 2 minutes before it happens and surface a warning.

**Keep Warm:** If the user enables the Keep Warm toggle, Wicklee sends a silent 1-token `/api/generate` with `keep_alive: -1` to reset the expiry timer. Every action is logged in Live Activity with precise timestamp. Always opt-in, always logged, always reversible.

- **Where:** Local Intelligence tab — Eviction Risk notice
- **Data:** Time since last /api/ps activity + model size
- **Free:** Warning card 2min before predicted eviction + Keep Warm on 1 node (Community)
- **Paid:** Keep Warm on unlimited nodes (Team+)
- **Phase:** 3A — /api/ps already polled ✅

---

### #14 — Fleet Inference Density Map
**Tagline:** Where in the fleet is inference actually happening right now?

A visual utilization map across the fleet: which nodes are actively running inference, which are idle, which are saturated. Implemented as a heatmap/hive plot — glowing amber pulse on nodes with active inference, cold dim gray on idle nodes. Not a grid of numbers — a visual that makes fleet state readable at a glance. Demo-video-ready.

**Visual design:** Each node as a hexagonal cell. Active inference = glowing amber pulse animation. Idle = dim gray. Saturated (CPU/GPU >80%) = bright red. Offline = dark with disconnected indicator.

- **Where:** Fleet Overview — below All Nodes compact rows
- **Data:** Ollama /api/ps active model + CPU/GPU % per node — all live
- **Free:** Full visualization
- **Paid:** Historical density heatmap (which nodes were active when)
- **Phase:** 3A — data exists now ✅

---

### #15 — Efficiency Regression Alert (per model, per hardware)
**Tagline:** A node used to run llama3.1:8b at 17 tok/s. It now runs it at 11 tok/s. Wicklee notices.

Per-node, per-model efficiency regression is invisible without baseline history. Causes include: thermal paste degradation, background process competition, VRAM fragmentation, or model file corruption. None of these are detectable from a single snapshot — they only emerge from comparing current performance to a historical baseline for the same model on the same hardware.

- **Where:** Local Intelligence tab — Regression card with baseline vs current comparison
- **Data:** Per-model tok/s history in DuckDB + current probe value
- **Free:** No
- **Paid:** Team Edition — Slack alert when regression >20% vs 7-day baseline
- **Phase:** Phase 4A — requires per-model DuckDB history

---

---

## Pattern Engine — Time-Windowed Intelligence

> The 15 original insights are threshold-crossing cards — they fire the moment a condition
> is detected. The Pattern Engine is a complementary layer: deterministic time-windowed rules
> that require sustained evidence before surfacing a finding. No false positives from
> model-loading spikes. No AI required.
>
> Pattern findings appear in an **"Observations"** section in the Insights → Triage tab,
> styled as an intelligence briefing feed rather than alert cards.

### Architecture

```
useMetricHistory (hook)          patternEngine.ts (evaluator)
┌──────────────────────────┐     ┌────────────────────────────────┐
│ localStorage rolling buf │     │ evaluatePatterns(input)         │
│ 1 sample / 30s / node    │────▶│   → DetectedInsight[]           │
│ 2,880 samples = 24h      │     │                                 │
│ metricsToSample() applies│     │ Each insight:                   │
│ 1024 MB VRAM filter      │     │   hook     — quantified "$-or-  │
└──────────────────────────┘     │             metric" number      │
                                 │   body     — causal explanation │
         AIInsights.tsx          │   confidence — building/mod/high│
         pushes samples on       │   actions  — copy-to-clipboard  │
         every SSE frame         │             shell or endpoint   │
         evaluates every 30s     └────────────────────────────────┘
```

### Pattern A — Thermal Performance Drain ✅ (Sprint 1, Community)

**What:** Node sustaining elevated thermal penalty with measurable tok/s loss vs. its own Normal-thermal baseline.

**Key design decisions:**
- Baseline tok/s drawn **only from Normal-thermal samples** in the 24h history. This was the critical refinement — without it the delta is "hot vs. slightly less hot" rather than "hot vs. the node's clean-state capability."
- `minObservationWindowMs = 5 min` (10 samples). Thermal loading spikes during model load don't trigger it.
- Fires only when sustained degradation > 8%.

**Hook:** `-X tok/s (Y% below Normal baseline)`
**Action:** `GET /api/v1/route/best` · `curl localhost:7700/api/health | jq '.thermal_state'`
**Relationship to #3:** #3 (Thermal Degradation Correlation) fires immediately on `thermal_state` change. Pattern A requires 5 min of sustained evidence and provides a quantified tok/s delta against a clean baseline — not just a state label.

---

### Pattern B — Phantom Load ✅ (Sprint 1, Community)

**What:** A model is loaded and holding VRAM + drawing power with zero inference activity. Pure OpEx waste.

**Key design decisions:**
- VRAM gate: `vram_used_mb > 0` using the 1024 MB filtered field in `MetricSample`. BMC/ASPEED/Matrox chips never appear here — the filter is applied at `metricsToSample()` write time, not at eval time.
- Watts gate: `> 5W idle baseline` (excludes truly idle CPU-only nodes).
- Inference gate: `tok_s < 0.5` (no meaningful inference activity).
- `minObservationWindowMs = 5 min` (70% of samples must match).

**Hook:** `-$X.XX/day` at configured kWh rate
**Action:** `ollama stop $(ollama ps | awk 'NR>1 {print $1}')` · `ollama ps`
**Relationship to #4/#11:** #4 (Idle Fleet Cost) fires when a node is idle ≥1 hr (no inference). #11 (Power Anomaly) fires on high watts at low GPU%. Pattern B is their intersection: model loaded + VRAM held + power drawn + zero inference. More specific and more immediately actionable.

---

### Pattern C — WES Velocity Drop 🔲 (Sprint 2, Community)

**What:** Rate-of-change on WES score over a 10-min window is sharply negative — WES is dropping before thermal state changes or thresholds are crossed.

**Why it matters:** The leading indicator. Thermal state transitions happen after throttle is already occurring. WES velocity captures the inflection point — the first 3–5 minutes of degradation before any threshold fires.

**Design constraints:**
- `minObservationWindowMs = 10 min` — highest gate of all patterns. WES is sensitive to tok/s probe noise; requiring 10 min prevents model-loading dips from triggering.
- Baseline: WES P50 from last 60 samples (30 min). Velocity: slope of last 20 samples (10 min). Fires when slope < −5% per sample window AND absolute WES has dropped > 15%.

**Hook:** `-Y% WES in 10 min (dropping)`
**Relationship:** Not in original INSIGHTS.md. New capability unlocked by the localStorage history layer.

---

### Pattern F — Memory Pressure Trajectory 🔲 (Sprint 2, Community)

**What:** `memory_pressure_percent` has been rising monotonically for 10+ min at a rate that projects to critical within the session.

**Why it matters:** The existing #7 (Memory Pressure Forecasting) requires DuckDB history and is gated to Team+. Pattern F delivers the ETA calculation using localStorage history — available to all Community users without a cloud backend.

**Design constraints:**
- `minObservationWindowMs = 10 min`. Pressure fluctuates; need a real trend before projecting.
- ETA = linear regression over last 20 samples. Fire only when projected time-to-critical < 30 min.
- Suppressed if `MemoryExhaustionCard` (threshold-crossing) is already firing — no double-alerting.

**Hook:** `~Xm to critical memory pressure`
**Relationship:** Supersedes the "requires DuckDB" implementation in Phase 4A for the ETA calculation itself. The alert notification (Slack at 15m/5m) remains a Team+ paid layer.

---

### Pattern D — Power-GPU Decoupling 🔲 (Sprint 3, Community)

**What:** Board power > 2× session baseline AND GPU utilization < 20% for a sustained window. Something is consuming power that isn't inference work.

**Relationship to #11:** #11 (Power Anomaly) fires on immediate threshold crossing. Pattern D requires sustained evidence (5 min) and quantifies the magnitude of the decoupling — not just "anomaly detected" but "X watts unexplained."

---

### Pattern E — Fleet Load Imbalance 🔲 (Sprint 3, Team+)

**What:** One or more nodes saturated (GPU% > 85% or mem pressure > 80%) while other fleet nodes are idle. Load distribution is suboptimal.

**Why Team+:** Requires fleet-wide view. Cockpit (single-node) can't evaluate imbalance.
**Hook:** Throughput left on the table (estimated tok/s from idle nodes)
**Action:** `GET /api/v1/route/best`

---

## Gaps in Original INSIGHTS.md

Three shipped capabilities have no entry in the original 15:

| Capability | Status | Notes |
|---|---|---|
| **Thermal Cost %** | ✅ Shipped (Phase 3B) | TC% = `(penalized WES - raw WES) / raw WES`. Named badge in Fleet Status table; alert card in Triage. Not a standalone insight in the original list — deserves its own entry. |
| **WES History Chart** | ✅ Shipped (Phase 3B) | Per-node penalized WES trend with raw WES ceiling reference. Time-range gated. Primary benchmark visualization tool. Original INSIGHTS.md doesn't address historical WES at all. |
| **Benchmark Report Export** | ✅ Shipped (Phase 3B) | Reproducible, citable snapshot: model, quant, tok/s, watts, raw/penalized WES, TC%, thermal source, WES version. Markdown + JSON download. Not in original 15. |

These should be added as **#16, #17, #18** in a future INSIGHTS.md revision or treated as subsections of existing insights.

---

## Delivery Matrix

| # | Insight | Phase | Free | Paid | Alert |
|---|---|---|---|---|---|
| 1 | Unified Memory Warning | 3A | Warning card | Slack threshold | Paid |
| 2 | W/1K TKN Efficiency Leaderboard | 3A ✅ | View | History + alert | Paid |
| 3 | Thermal Degradation Correlation | 3A ✅ | Session card | Trend + alert | Paid |
| 4 | Idle Fleet Cost (with PUE) | 3A ✅ | Live card | Weekly digest | Paid |
| 5 | Model-to-Hardware Fit Score | 3A ✅ | Full card | Alert on Poor | Paid |
| 6 | Sentinel Proxy Routing | Phase 5 | ❌ | Enterprise | No |
| 7 | Memory Pressure Forecasting | 4A | ❌ | Full | Paid |
| 8 | Cold Start Detection | 3B ✅ | Live Activity | Alert | Paid |
| 9 | Quantization ROI | 3A ✅ / 4A | Live card (session) | Historical (DuckDB) | No |
| 10 | Fleet Thermal Diversity Score | 3A ✅ | Score card | Alert | Paid |
| 11 | Power Anomaly Detection | 3A ✅ | Detection card | Alert | Paid |
| 12 | Sovereignty Audit Trail | 3B / 5 | View | CSV export | No |
| 13 | Model Eviction Prediction | 3A ✅ | Warning + Keep Warm (1 node) | Keep Warm unlimited | No |
| 14 | Fleet Inference Density Map | 3A ✅ | Full | Historical | No |
| 15 | Efficiency Regression per Model | 4A | ❌ | Alert | Paid |

✅ = data already exists in current v0.4.5 build, insight is aggregation/presentation work only

---

## Notification Architecture

All notifications are opt-in per node per event type. Never default-on except thermal Critical.

| Event | Urgency | Channel | Tier |
|---|---|---|---|
| Thermal: Serious → Critical | Immediate, cannot disable | Slack + PagerDuty | Free (critical safety) |
| Node offline > 5min | Immediate | Slack | Paid |
| Unified Memory < 10% headroom | Immediate | Slack | Paid |
| Power anomaly sustained > 5min | 5min debounce | Slack | Paid |
| Fleet thermal diversity Critical | 15min debounce | Slack | Paid |
| Tok/s regression > 20% | 30min debounce | Slack | Paid |
| Memory pressure ETA < 15min | Immediate | Slack | Paid |
| Memory pressure ETA < 5min | Immediate, cannot disable | Slack + PagerDuty | Paid |
| Idle cost weekly digest | Weekly, Monday 9am | Slack / email | Paid |
| Efficiency regression > 20% | Daily digest | Slack | Paid |

---

*Wicklee is sovereign infrastructure. Your fleet data never leaves your network until you choose.*
