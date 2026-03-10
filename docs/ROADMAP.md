# Wicklee Roadmap 🛰️

> *Sovereign GPU fleet monitoring. Your data never leaves your network until you choose.*

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

**Inference Runtime**
- Ollama integration: auto-detect `localhost:11434`, model name, quantization, size
- 30-second sampled tok/s probe via `/api/generate` (num_predict=3)
- Wattage/1K TKN: live calculation from board power ÷ tok/s
- Cost/1K TKN: wattage × configurable kWh rate (default $0.13)

**UI**
- Fleet Overview: 6 real-time summary cards (all live data, no mock values)
- Node Registry: collapsible cards, real-time search, sort, status filter pills
- Live Activity feed: node online/offline, thermal state transitions, pairing events
- System Performance graph: CPU/GPU/Mem/Power selector, current session
- Version numbers synced: Cargo.toml, package.json, UI footer, GitHub Release tag

---

## Phase 3A — The Insight Engine *(Next)*

> Goal: make the data speak. Nine insights can ship using data that already exists.

**WES — Wicklee Efficiency Score**
- [ ] **Coin and ship WES as the live fleet efficiency standard:** `WES = tok/s ÷ (Watts_adjusted × ThermalPenalty)` — the MPG for local AI inference. Calculated at render time from existing SSE payload fields; no Rust changes required. Display as unitless score to 1 decimal ("WES 181.5") on every node card and in the Fleet WES Leaderboard. Thermal penalty (Normal=1.0, Fair=1.25, Serious=2.0) ensures a throttled node's WES reflects its true efficiency, not just its current output.

**Local Intelligence Tab — Free Tier Insight Cards**
- [ ] **Model-to-Hardware Fit Score:** Ollama model size + VRAM/unified memory + thermal state → "Poor/Fair/Good fit" with recommendation. Always shown when a model is loaded.
- [ ] **Thermal Degradation Correlation:** Named insight card when thermal state transition + tok/s drop detected simultaneously. Shows before/after tok/s, causal chain, recommendation.
- [ ] **Power Anomaly Detection:** Fires when board power exceeds 2× session baseline or when power/GPU utilization ratio is anomalous. Flags runaway processes invisible to standard monitoring.
- [ ] **Unified Memory Exhaustion Warning (Apple Silicon):** Correlates Ollama model size + available unified memory + vm_stat pressure. Warns before swap storm — not after.
- [ ] **Model Eviction Prediction:** Fires 2 minutes before predicted Ollama model unload based on `/api/ps` inactivity. Free: warning. Paid: "Keep Warm" toggle sends silent ping to reset `keep_alive` timer.
- [ ] **Idle Resource Notice:** Node online >1hr with zero inference activity. Shows estimated electricity cost of idle time.

**Fleet Intelligence Panel (Fleet Overview page)**
- [ ] **Fleet WES Leaderboard:** WES-ranked across all nodes. Cross-node efficiency comparison that accounts for thermal state — the question "which node is most efficient per token right now?" answered live with thermal penalty applied.
- [ ] **Fleet Thermal Diversity Score:** Distribution of thermal states across the fleet. "3/4 nodes thermally stressed — fleet is one spike from cascade failure." Free: score. Paid: Slack alert.
- [ ] **Fleet Inference Density Map:** Heatmap/hive plot visualization — glowing pulse on active inference nodes, cold dim on idle. Visual utilization map, not a grid of numbers. Demo-video-ready.
- [ ] **Idle Fleet Cost Card (8th summary card):** Daily electricity cost of idle nodes with PUE multiplier support. Formula: `idle_watts × pue × hours × kwh_rate`. Shows "Node: $X/day · Facility: $Y/day (PUE 1.4)" so math is transparent.

**Settings**
- [ ] **Electricity Rate field:** kWh rate input (default $0.13). Affects Cost/1K TKN and Idle Fleet Cost.
- [ ] **PUE Multiplier field:** Default 1.0 (home lab). Standard datacenter: 1.4–1.6. Makes idle cost accurate for colo users.

**Live Activity — New Event Types**
- [ ] Power anomaly detected/resolved
- [ ] Model eviction predicted / Keep Warm action taken
- [ ] Thermal degradation confirmed (causal chain, not just state change)
- [ ] Fit score changed (model loaded/unloaded)

---

## Phase 3B — Platform Completeness + Show HN

> Goal: close hardware gaps, launch publicly.

**Platform**
- [ ] **vLLM Integration:** Prometheus `/metrics` endpoint at `localhost:8000`. Real tok/s without 30s probe. Phase 3 priority pull-forward — vLLM users need fleet routing most.
- [ ] **Linux Thermal:** `/sys/class/thermal` — closes the thermal state gap on GeiserBMC and similar bare metal nodes.
- [ ] **Windows Thermal:** WMI thermal data for Andy_PC and Windows nodes.
- [ ] **ANE Utilization:** Apple Neural Engine utilization and wattage — the metric Activity Monitor doesn't show.
- [ ] **macOS CPU Power (sudoless):** Entitlement-based `powermetrics` access without requiring root.

**Sovereignty**
- [ ] **Sovereignty Tab (Settings):** Pairing event log, telemetry destination, outbound connection manifest. Structural proof that inference data never left the network.
- [ ] **Audit Log Export (Free):** Exportable pairing and telemetry history.

**Launch**
- [ ] RTX 4090 rental test — complete three-way comparison table (M2 vs 4090 vs Ryzen)
- [ ] README screenshot (three-node fleet with all Wattage/1K TKN populated)
- [ ] Show HN post: "I coined WES — the MPG for local AI inference. Apple M2 scores 181.5. Ryzen 9 7950X scores 0.14. Here's why."
- [ ] r/LocalLLaMA post
- [ ] Ollama Discord #showcase

---

## Phase 4A — Intelligence Depth *(2–3 months)*

> Requires DuckDB 90-day history. Unlocks trend-based insights.

**Infrastructure**
- [ ] **DuckDB Time-Series:** 90-day per-node, per-metric history stored on Railway. Powers all trend-based insights below.
- [ ] **Historical Performance Graphs:** Same metric selector as live graph but spanning 1hr/24hr/7d/30d/90d.
- [ ] **Percentile Baselines:** P50/P95 for tok/s, power, CPU per node — shown as reference lines on graphs.

**Paid Intelligence Insights**
- [ ] **Memory Pressure Forecasting:** Rate-of-change on memory pressure → ETA to critical. "At current rate, this node hits critical in ~7 minutes." Slack alert at 15min and 5min thresholds.
- [ ] **Tok/s Regression Detection:** Current probe vs 7-day P50 baseline per node. Alert when >20% degradation.
- [ ] **Quantization ROI Measurement:** Per-model, per-quant tok/s and W/1K TKN stored in DuckDB. "Q4 vs Q8 on YOUR hardware at YOUR thermal state" — live hardware-specific answer.
- [ ] **Efficiency Regression per Model:** "WK-C133 used to run llama3.1:8b at 17 tok/s. It now runs it at 11 tok/s." Baseline history required. Slack alert when >20% regression.
- [ ] **Fleet Degradation Trend:** Fleet-wide tok/s trend over 7/30 days.

**Notifications**
- [ ] **Slack / PagerDuty Webhook System:** Per-node, per-event-type configuration. Urgency levels: immediate, 5-min debounce, 15-min debounce, daily digest.
- [ ] **Alert Threshold Configuration:** Per-node thresholds for thermal, power, tok/s, memory pressure.
- [ ] **Idle Cost Weekly Digest:** "Fleet idle cost this week: $X" — emailed or Slacked Monday 9am.

---

## Phase 4B — Commercial Layer *(3–5 months)*

- [ ] **Stripe + Team Edition Gate:** 3-node free limit enforcement with upgrade flow.
- [ ] **Keep Warm Toggle (Paid):** Wicklee sends silent ping to reset Ollama `keep_alive` timer before predicted eviction. All actions logged in Live Activity.
- [ ] **Clerk Auth:** Replace DIY bcrypt/session system.
- [ ] **CSV / JSON Export:** Any metric, any time range, any node.
- [ ] **Cold Start Detection:** GPU spike + memory jump + elevated TTFT = cold start event. Requires TTFT data from Sentinel Proxy or vLLM metrics.
- [ ] **Event Detail Panel (Live Activity):** Clickable events with metrics snapshot at moment of event, precise timestamp, trigger reason, duration.
- [ ] **LLC Formation:** Wyoming or Delaware via Stripe Atlas or Doola.
- [ ] **Product Hunt launch**
- [ ] **dev.to article:** "I built a GPU fleet monitor in Rust that measures wattage-per-token across heterogeneous hardware"

---

## Phase 5 — Enterprise / Sovereign *(6+ months)*

**Sentinel Proxy**
- [ ] **Inference Interceptor:** OpenAI-compatible proxy endpoint. Clients point at Wicklee; Wicklee forwards to healthiest node.
- [ ] **Automatic Rerouting:** Transparent workload shifting on thermal/load threshold breach. No client changes required.
- [ ] **Routing Policy Config:** `lowest-watt-per-token`, `lowest-thermal`, `lowest-load`, `round-robin`, `pinned` — selectable per model or client tag.

**Sovereignty / Compliance**
- [ ] **Cryptographically Signed Audit Export:** PDF signed by the Wicklee Agent's unique hardware ID (WK-XXXX). Tamper-evident. CISO-signable compliance artifact for HIPAA, financial services, defense-adjacent use cases.
- [ ] **Sovereign Mode:** On-premise only — no cloud pairing, no outbound telemetry, airgapped operation.
- [ ] **On-Premise Deployment:** Docker image + Helm chart for self-hosted fleet backend.

**Enterprise Features**
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
| Fleet Intelligence panel | ✅ View | ✅ Full + alerts | ✅ Full |
| Local Intelligence (session) | ✅ Free cards | ✅ Full + alerts | ✅ Full |
| Local Intelligence (trend-based) | ❌ | ✅ Paid | ✅ Full |
| Keep Warm toggle | ❌ | ✅ | ✅ |
| 90-day history | ❌ | ✅ | ✅ |
| Slack / PagerDuty | ❌ | ✅ | ✅ |
| Sovereignty audit log | ✅ View | ✅ View | ✅ Signed export |
| Sentinel Proxy routing | ❌ | ❌ | ✅ |
| Sovereign Mode (no cloud) | ❌ | ❌ | ✅ |
| Price | Free | ~$29/mo | ~$199/mo |

---

*Wicklee is sovereign infrastructure. Your fleet data never leaves your network until you choose.*
