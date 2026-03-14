# Wicklee — Architecture Specification 🛰️

> *Sovereign GPU fleet monitoring. Your data never leaves your network until you choose.*

---

## The Problem

Teams running local AI inference — Ollama, vLLM, custom stacks — are flying blind. Standard monitoring tools see CPU and RAM as separate, unrelated metrics. They don't see GPU utilization, unified memory pressure, thermal state, or wattage-per-token. More importantly, they don't own both sides simultaneously.

A CPU monitor doesn't know your 70B model needs 40GB of unified memory and you have 2GB of headroom. A temperature monitor doesn't know the node running at 89°C has silently dropped 35% tok/s due to throttling. A power meter doesn't know which of your three nodes is cheapest per token right now.

**Wicklee's structural moat:** it owns both hardware telemetry AND inference runtime context simultaneously. Every unique insight Wicklee surfaces is impossible without both sides. No other tool has both.

---

## Core Design Principles

**Sovereign by default.** The agent collects and displays data locally. Nothing leaves the machine until the operator explicitly pairs it to the Fleet View. This is not a privacy feature — it is the architecture. For HIPAA, financial services, and defense-adjacent inference, this is a compliance requirement.

**Zero-dependency install.** One binary. No Docker, no Python, no Node, no runtime. `curl | bash` on Mac/Linux, `irm | iex` on Windows. Copy it to a machine, run it, open a browser. Done.

**Honest footprint.** Target: <1MB binary, <50MB RAM, <2% CPU at idle. A monitoring tool that degrades the system it monitors is not a monitoring tool.

**Graceful degradation.** Every metric that requires elevated permissions fails with a `null` value and a clear human-readable label. The dashboard never crashes. Sudo is never required to be useful.

**Honest data only.** No mock values, no fake percentage deltas, no placeholder numbers. Every metric shown is either real or labeled with exactly why it isn't available yet ("requires elevated permissions", "connect inference runtime", "requires kernel 5.10+").

**Monitor, then act.** Wicklee observes first. When it takes action (e.g. Keep Warm ping), it is always opt-in, always logged in Live Activity with a precise timestamp, and always reversible.

---

## Delivery Model

### Local — The Node View (`localhost:7700`)
The agent serves a React dashboard at `http://localhost:7700`. Built for the person sitting at the machine or SSHed into a bare metal node.

- **Latency:** 1Hz SSE stream; 10Hz WebSocket for live rolling charts
- **Scope:** Single node — the machine the agent is running on
- **Privacy:** Fully local — zero outbound connections
- **Auth:** None required
- **Content:** Hardware metrics + Inference Runtime panel (if Ollama/vLLM detected) + pairing CTA

### Hosted — The Fleet View (`wicklee.dev`)
The hosted dashboard at `wicklee.dev` aggregates all paired agents for the operator or team lead.

- **Latency:** 500ms–1s polling from each agent to cloud, SSE to browser
- **Scope:** All paired nodes — full fleet in one view
- **Pairing:** 6-digit code entered at `wicklee.dev` — no agent config required
- **Auth:** Clerk (hosted signup/login, JWT). Stream tokens authenticate SSE connections.
- **Tiers:** Community (3 nodes, free), Team (unlimited, paid ~$29/mo), Enterprise (sovereign, paid ~$199/mo)

---

## Binary Architecture

```
wicklee-agent (single Rust binary, ~700KB)
│
├── Axum HTTP Server (port 7700)
│   ├── GET /                    → index.html (embedded React SPA)
│   ├── GET /assets/*            → JS/CSS (embedded, Brotli-compressed)
│   ├── GET /nodes, /team, …     → index.html (SPA fallback for React Router)
│   ├── GET /api/metrics         → SSE stream, 1Hz telemetry
│   ├── GET /ws                  → WebSocket, 10Hz (liquid pulse charts)
│   └── GET /api/diagnostics     → JSON self-test output
│
├── Metrics Harvester (tokio async loop, 1Hz)
│   ├── sysinfo                  → CPU %, memory used/total/available, core count
│   ├── ioreg (macOS)            → GPU utilization % — sudoless
│   ├── pmset (macOS)            → Thermal state — sudoless
│   ├── vm_stat (macOS)          → Memory pressure % (wired + active pages)
│   ├── powermetrics (macOS)     → CPU power watts — requires root, graceful null
│   ├── nvml-wrapper (Linux)     → GPU %, VRAM, board power, GPU temp — sudoless
│   ├── /sys/class/powercap      → CPU RAPL power (Linux, kernel 5.10+)
│   ├── /proc/cpuinfo            → Chip name (Linux)
│   └── /sys/class/thermal       → Thermal state (Linux ✅)
│
├── Ollama Harvester (tokio async loop, 30s probe)
│   ├── GET localhost:11434/api/ps    → active model, quantization, model size
│   └── POST localhost:11434/api/generate → 3-token probe → tok/s measurement
│
├── vLLM Harvester ✅ (2s poll)
│   └── GET localhost:8000/metrics    → Prometheus metrics → real tok/s, cache%, req count
│
├── Cloud Relay (when paired)
│   └── POST /api/telemetry      → push MetricsPayload to wicklee.dev cloud backend
│
└── Static Assets (rust-embed)
    └── frontend/dist/           → Compiled React/Tailwind SPA, baked in at build time
```

---

## Agent ↔ Cloud Payload Sync Rule

`MetricsPayload` is defined independently in both `agent/src/main.rs` and `cloud/src/main.rs`. They must stay in sync.

**Rule:** Any field added to `MetricsPayload` in the agent **must** also be added to the cloud struct with `#[serde(default)]`. This ensures older cloud deployments (or older agents) don't reject payloads when a new field is present or absent.

The `#[serde(default)]` attribute on the cloud side means:
- A new field sent by a newer agent → cloud deserializes it correctly
- An older agent that doesn't send the field → cloud gets the field's `Default` value (typically `None` for `Option<T>`)

**Never add a non-optional, non-defaulted field to `MetricsPayload` on the agent without the matching cloud update deployed first.** The cloud processes telemetry from all paired agents simultaneously — a missing field with no default will cause deserialization failures for all agents on that firmware until the cloud redeploys.

---

## SSE Metrics Payload (current v0.4.5)

```json
{
  "node_id": "WK-1EFC",
  "hostname": "Mac",
  "timestamp_ms": 1234567890000,
  "cpu_usage_percent": 19.6,
  "cpu_core_count": 8,
  "chip_name": "Apple M2",
  "total_memory_mb": 8192,
  "used_memory_mb": 5939,
  "available_memory_mb": 2100,
  "memory_pressure_percent": 68.0,
  "gpu_utilization_percent": 32.0,
  "thermal_state": "Normal",
  "cpu_power_w": 0.6,
  "nvidia_gpu_util_percent": null,
  "nvidia_vram_used_mb": null,
  "nvidia_vram_total_mb": null,
  "nvidia_gpu_temp_c": null,
  "nvidia_board_power_w": null,
  "ollama_running": true,
  "ollama_active_model": "tinyllama:latest",
  "ollama_model_size_gb": 0.7,
  "ollama_quantization": "Q4_0",
  "ollama_tokens_per_second": 108.9,
  "wattage_per_1k_tokens": 5.4,
  "vllm_running": false,
  "vllm_model_name": null,
  "vllm_tokens_per_sec": null,
  "vllm_cache_usage_perc": null,
  "vllm_requests_running": null
}
```

All fields are nullable. Null values display with honest gap labels in the UI — never as zero, never as an error.

---

## Derived Metrics

Derived metrics are calculated at render time from the raw SSE payload fields — they do not require changes to the Rust `MetricsPayload` struct.

### WES — Wicklee Efficiency Score

**Formula:**
```
WES = tok/s ÷ (Watts_adjusted × ThermalPenalty)
```

Where:
- `tok/s` = `ollama_tokens_per_second`
- `Watts_adjusted` = `cpu_power_w` (Apple Silicon) or `nvidia_board_power_w` (NVIDIA), adjusted by PUE if configured
- `ThermalPenalty` = lookup from `thermal_state`:

| thermal_state | ThermalPenalty |
|---|---|
| `Normal` | 1.0 |
| `Fair` | 1.25 |
| `Serious` | 1.75 |
| `Critical` | 2.0 |
| `null` | 1.0 (assumed Normal) |

**Display:** Unitless score to 1 decimal place, e.g. "WES 181.5". Displays "—" when `ollama_tokens_per_second` is null or power data is unavailable.

**Academic grounding:** Conceptually aligned with the Stanford / Together AI "Intelligence per Watt" framework (arXiv:2511.07885, Nov 2025). WES applies the same lens at the operator layer — real tokens, real hardware, real thermal conditions.

**Example calculations from the Wicklee fleet:**

| Hardware | tok/s | Watts | ThermalPenalty | WES |
|---|---|---|---|---|
| Apple M2 · llama3.1:8b | 108.9 | 0.6W | 1.0 | **181.5** |
| Ryzen 9 7950X · llama3.1:8b (idle probe) | 17.3 | 32.5W | 1.0 | **0.53** |
| Ryzen 9 7950X · llama3.1:8b (load) | 17.1 | 121.2W | 1.0 | **0.14** |

WES is the primary input to the **Fleet WES Leaderboard** (Insight #2), **Thermal Degradation Correlation** (Insight #3), and **Fleet Thermal Diversity Score** (Insight #10).

---

## Cloud Backend Architecture

```
wicklee-cloud (Rust + Axum, deployed on Railway)
│
├── Auth (Clerk)
│   ├── Clerk-managed signup/login (hosted UI, JWT issued by Clerk)
│   ├── POST /api/auth/stream-token  → exchange Clerk JWT for short-lived SSE stream token (UUID, 60s TTL)
│   └── Scheduled cleanup task       → purge expired stream_tokens every 5 minutes
│
├── Pairing
│   ├── POST /api/pair/claim       → generate 6-digit code, store with account
│   └── POST /api/pair/activate    → agent calls this on first pairing; stores node
│
├── Telemetry
│   ├── POST /api/telemetry        → agent pushes MetricsPayload every 500ms
│   └── GET  /api/fleet/stream?token=  → SSE stream to browser; token = stream_token from /api/auth/stream-token
│
└── Storage
    ├── SQLite (rusqlite, bundled)  → users, sessions, nodes (persistent via Railway volume)
    └── DuckDB (Phase 4A)          → time-series metric history, 90-day retention
```

**Rate limits:** POST /api/pair/activate (10/5min). Auth rate limiting is handled by Clerk.

---

## Frontend SSE Architecture

The hosted dashboard opens a single SSE connection to the cloud backend, managed by `FleetStreamContext` (`src/contexts/FleetStreamContext.tsx`):

- `FleetStreamProvider` (wrapped in `App.tsx`) owns the one `EventSource`
- Fetches a stream token via Clerk JWT → `POST /api/auth/stream-token`
- Opens `EventSource(/api/fleet/stream?token=...)`
- Exposes fleet state via `useFleetStream()` hook
- Consumers: `Overview`, `NodesList`, `DashboardShell` (footer/header)
- Event detection (online/offline/thermal transitions) runs inside the provider
- `onNodesSnapshot` callback patches node hostnames from telemetry into the nodes array

Previously, three components each opened their own `EventSource` — three token fetches, three connections, three places to break. The context consolidates this to a single connection shared via React Context.

---

## Intelligence Architecture

### The Unique Position

Wicklee is the only tool that owns both hardware telemetry and inference runtime context simultaneously. This enables 15 classes of insight impossible to produce without both:

| Insight Class | Hardware Side | Runtime Side |
|---|---|---|
| Unified Memory Exhaustion Warning | `memory_pressure_percent`, `available_memory_mb` | `ollama_model_size_gb` |
| WES / Fleet WES Leaderboard | `cpu_power_w` or `nvidia_board_power_w`, `thermal_state` | `ollama_tokens_per_second` |
| Thermal Degradation Correlation | `thermal_state` transition | `ollama_tokens_per_second` drop |
| Model-to-Hardware Fit Score | VRAM/unified memory, thermal state | model size, quantization |
| Power Anomaly Detection | `nvidia_board_power_w` vs `nvidia_gpu_util_percent` | inference activity context |
| Quantization ROI | power draw, thermal state | tok/s at Q4 vs Q8 |
| Cold Start Detection | GPU spike, VRAM jump (hardware pattern — no proxy required) | inference activity context |

### Insight Delivery Surfaces

**Local Intelligence Tab** — per-node insights, derived from the local SSE stream:
- Free: Model Fit Score, Thermal Degradation, Power Anomaly, Unified Memory Warning, Eviction Prediction, Idle Notice
- Paid (Team+): Memory Pressure Forecast, Tok/s Regression, Quantization ROI, Efficiency Regression per model

**Fleet Intelligence Panel** — cross-node insights, derived from fleet SSE aggregation:
- Free: Fleet WES Leaderboard (WES-ranked across all nodes), Thermal Diversity Score, Inference Density Map, Idle Cost
- Paid: Thermal Routing Recommendation, Fleet Degradation Trend, Power Budget Tracker

**Live Activity Feed** — real-time event stream:
- Free: node online/offline, thermal state transition, model eviction predicted, power anomaly detected, node paired
- Paid: tok/s regression detected, fleet thermal alert, Keep Warm action taken

### Keep Warm ✅
When Eviction Prediction fires and the user has Keep Warm enabled, the agent sends a silent 1-token `/api/generate` with `keep_alive: -1` to reset the Ollama expiry timer. Every Keep Warm action is logged in Live Activity with precise timestamp: "Wicklee sent keep-alive ping to llama3.1:8b at 10:42:33 PM." Actions are always opt-in, always logged, always reversible.

**Community:** 1 node free. **Paid (Team+):** unlimited nodes.

---

## Idle Fleet Cost Methodology

Idle Fleet Cost uses a two-variable formula to surface the true facility cost of idle inference nodes:

```
idle_cost_per_day = idle_watts × pue × 24 × (kwh_rate / 1000)
```

**Variables:**
- `idle_watts` — board power or CPU power draw when no inference is active (from NVML/RAPL live data)
- `pue` — Power Usage Effectiveness multiplier (configurable in Settings, default 1.0)
  - Home lab / desktop: 1.0 (no overhead)
  - Standard datacenter: 1.4–1.6 (cooling, distribution, UPS)
  - Hyperscale / efficient colo: 1.1–1.2
- `kwh_rate` — electricity rate in $/kWh (configurable in Settings, default $0.13)

**UI display:** `Node: $X.XX/day · Facility: $Y.YY/day (PUE 1.4)` — math always visible.

---

## Sovereignty Architecture

### Structural Guarantee
The agent collects hardware and inference telemetry locally. Outbound connections occur only when:
1. The operator explicitly pairs the agent to wicklee.dev using the 6-digit pairing code
2. After pairing, telemetry is pushed to the Wicklee cloud backend

An unpaired agent has zero outbound network activity. An operator can verify this independently with `lsof -i` or `ss -tuln`.

### Sovereignty (Observability Tab — Phase 3B)
Sovereignty data surfaces as a section within the Observability tab — not a standalone tab. Content:
- Complete pairing event log: timestamp, destination IP, session duration
- Telemetry destination: `wicklee.dev` or "Sovereign Mode: no outbound telemetry"
- Outbound connection manifest: every domain the agent has ever connected to
- Exportable audit log (CSV)

### Cryptographically Signed Audit Export (Phase 5)
Enterprise tier produces a tamper-evident PDF audit report signed by the agent's unique hardware ID (WK-XXXX). The signature uses HMAC-SHA256 with the node's private key. A CISO can verify the document independently — the signature proves the audit log has not been modified since export. This is the compliance artifact for HIPAA, financial services, and defense-adjacent inference operators.

---

## Platform Support

| Platform | CPU/Memory | GPU | Thermal | CPU Power |
|---|---|---|---|---|
| macOS Apple Silicon | ✅ | ✅ ioreg | ✅ pmset | ⚠️ root only |
| macOS Intel | ✅ | ✅ ioreg | ✅ xcpm sysctl | ⚠️ root only |
| Linux (NVIDIA) | ✅ | ✅ nvml-wrapper | ✅ /sys/class/thermal | ✅ RAPL (kernel 5.10+) |
| Linux (AMD CPU-only) | ✅ | ❌ | ✅ /sys/class/thermal | ✅ RAPL (kernel 5.10+) |
| Linux (AMD GPU) | ✅ | 📋 Phase 5 | ✅ /sys/class/thermal | ✅ RAPL |
| Windows (NVIDIA) | ✅ | ✅ nvml-wrapper | 🔜 Phase 5 (WMI) | 📋 Phase 5 |
| Linux musl (static) | ✅ | ✅ nvml-wrapper† | ✅ /sys/class/thermal | ✅ |

† nvml-wrapper excluded on musl targets; NVIDIA Linux users should use gnu builds

---

## Build Pipeline

```bash
# 1. Build the React frontend
npm ci && npm run build
# Output: agent/frontend/dist/

# 2. Build the Rust agent (embeds dist/ via rust-embed)
cd agent && cargo build --release
# Output: agent/target/release/wicklee-agent

# 3. Run
wicklee
# Dashboard: http://localhost:7700
```

**Release pipeline:** tag push (`git tag vX.X.X && git push origin vX.X.X`) triggers 4-platform GitHub Actions build. Assets: `wicklee-agent-darwin-aarch64`, `wicklee-agent-linux-x86_64`, `wicklee-agent-linux-aarch64`, `wicklee-agent-windows-x86_64.exe`.

**Linux targets use musl** (`x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`) for fully static binaries with no glibc dependency.

---

## Monetization Model

Wicklee is open-core. The agent is and will remain open source. The hosted fleet infrastructure and intelligence layer are the commercial layer.

**Community Edition — Free**
- Up to 3 paired nodes
- Full local dashboard (localhost:7700), all hardware metrics
- Full Fleet Overview with live data
- Local Intelligence free cards (Fit Score, Thermal Degradation, Power Anomaly, Eviction Prediction, Cold Start)
- Quantization ROI — live session snapshot (current model, current node — no history required)
- 24h session history (localStorage with expiry — per-node insight persistence across page reloads)
- Keep Warm: 1 node (silent 1-token ping to reset Ollama keep_alive before predicted eviction)
- Fleet Intelligence panel: Efficiency Leaderboard, Thermal Diversity Score, Density Map, Idle Cost
- Sovereignty audit log (view only)

**Team Edition — ~$29/mo**
- Unlimited paired nodes
- All free tier features
- 90-day metric history (DuckDB)
- Trend-based Local Intelligence (Memory Forecast, Tok/s Regression, Quantization ROI historical comparison, Efficiency Regression)
- Slack / PagerDuty webhook alerts with per-node, per-event-type configuration
- Keep Warm: unlimited nodes (Community gets 1 node free)
- Alert threshold configuration
- CSV/JSON export
- Signed audit log export

**Enterprise / Sovereign — ~$199/mo**
- All Team Edition features
- Unlimited nodes
- Sentinel Proxy (cross-node inference routing)
- Sovereign Mode (no cloud pairing, fully airgapped)
- Cryptographically signed audit export (CISO-ready compliance artifact)
- On-premise Docker/Helm deployment
- SSO / SAML
- HIPAA / SOC2 BAA
- Priority support + SLA

The upgrade moment for Community → Team is natural: when inference quality degrades and you don't know why. When tok/s drops 20% and there's no alert. When idle nodes cost $200/month and nobody knows. Team Edition is when Wicklee stops being a monitor and starts being an operator.

---

*Wicklee is sovereign infrastructure. Your fleet data never leaves your network until you choose.*
