# Wicklee — Architecture Specification 🛰️

> *Sovereign GPU fleet monitoring. Your data never leaves your network until you choose.*

---

## The Problem

Teams running local AI inference — Ollama, vLLM, custom stacks — are flying blind. Standard monitoring tools see CPU and RAM. They do not see GPU utilization, unified memory pressure, thermal state, or wattage-per-token. When a node overheats, degrades, or falls over, the operator finds out from a user, not a dashboard.

Wicklee fixes this. It is a single Rust binary that runs on any inference node, surfaces the metrics that matter for AI workloads, and optionally connects to a hosted fleet view for multi-node management.

---

## Core Design Principles

**Sovereign by default.** The agent collects and displays data locally. Nothing leaves the machine until the operator explicitly pairs it to the Fleet View. This is not a privacy feature — it is the architecture.

**Zero-dependency install.** One binary. No Docker, no Python, no Node, no runtime. Copy it to a machine, run it, open a browser. Done.

**Honest footprint.** The agent is designed to be invisible. Target: <1MB binary, <50MB RAM, <2% CPU at idle. A monitoring tool that degrades the system it monitors is not a monitoring tool.

**Graceful degradation.** Every metric that requires elevated permissions fails silently with a `null` value and a clear label. The dashboard never crashes, never shows an error state, never requires sudo to be useful.

---

## Delivery Model

### Local — The Node View
The agent serves a React dashboard at `http://localhost:7700`. Built for the person sitting at the machine.

- **Latency:** 1Hz SSE stream; 10Hz WebSocket (`/ws`) for live rolling charts
- **Scope:** Single node — the machine the agent is running on
- **Privacy:** Fully local — no outbound connections
- **Access:** Free, always, with no account required

### Hosted — The Fleet View
The hosted dashboard at `wicklee.app` aggregates all paired agents for the operator or team lead.

- **Latency:** 500ms–1s polling from each agent
- **Scope:** All paired nodes — full fleet in one view
- **Pairing:** 6-digit code entered in the local dashboard
- **Model:** Community Edition (up to 5 nodes) is free. Team Edition (unlimited nodes, history, alerts) is a paid tier.

---

## Binary Architecture

```
wicklee-agent (single Rust binary)
│
├── Axum HTTP Server (port 7700)
│   ├── GET /                    → index.html (embedded React app)
│   ├── GET /assets/*            → JS/CSS (embedded, Brotli-compressed)
│   ├── GET /nodes, /team, …     → index.html (SPA fallback for React Router)
│   ├── GET /api/metrics         → SSE stream, 1 event/sec
│   ├── GET /ws                  → WebSocket stream, 10 Hz (liquid pulse)
│   └── GET /api/tags            → JSON model list
│
├── Metrics Harvester (tokio async loop)
│   ├── sysinfo crate            → CPU %, Memory used/total/available
│   ├── ioreg -r -c IOGPUDevice  → GPU utilization % (macOS, no sudo)
│   ├── pmset -g therm           → Thermal state (macOS, no sudo)
│   ├── vm_stat                  → Memory pressure % (wired + active pages)
│   └── powermetrics             → CPU cluster power in watts (requires root — graceful null)
│
└── Static Assets (rust-embed)
    └── frontend/dist/           → Compiled React/Tailwind app, baked into binary at build time
```

---

## SSE Metrics Payload

```json
{
  "node_id": "hostname.local",
  "timestamp_ms": 1234567890000,
  "cpu_usage_percent": 44.5,
  "cpu_core_count": 8,
  "total_memory_mb": 8192,
  "used_memory_mb": 6654,
  "available_memory_mb": 1537,
  "memory_pressure_percent": 68.2,
  "gpu_utilization_percent": 29.0,
  "thermal_state": "Normal",
  "cpu_power_w": null,
  "ecpu_power_w": null,
  "pcpu_power_w": null
}
```

Fields returning `null` require elevated permissions on the current platform. They are clearly labeled in the dashboard and never cause a render error.

---

## Build Pipeline

```bash
# 1. Build the React frontend
cd frontend && npm run build
# Output: agent/frontend/dist/

# 2. Build the Rust binary (embeds the dist/ folder)
cd agent && cargo build --release
# Output: agent/target/release/wicklee-agent

# 3. Run
./agent/target/release/wicklee-agent
# Dashboard: http://localhost:7700
```

**Planned:** `make install` → copies binary to `/usr/local/bin/wicklee` for global CLI access.

---

## Platform Support

| Platform | CPU/Memory | GPU | Thermal | Power |
|---|---|---|---|---|
| macOS Apple Silicon | ✅ | ✅ ioreg | ✅ pmset | ⚠️ root only |
| macOS Intel | ✅ | ✅ ioreg | ✅ xcpm sysctl | ⚠️ root only |
| Linux (NVIDIA) | ✅ | 🔜 nvml-wrapper | 🔜 | 🔜 |
| Linux (AMD) | ✅ | 📋 Planned | 📋 Planned | 📋 Planned |
| Windows | 📋 Planned | 📋 Planned | 📋 Planned | 📋 Planned |

---

## Monetization Model

Wicklee is open-core.

**Community Edition** — free, always, no account required.
- Single-node local dashboard with full Deep Metal metrics
- All core metrics (CPU, GPU, Memory, Thermal)
- Hosted Fleet View for **up to 5 nodes** — the natural threshold for a solo developer or small team

**Team Edition** — paid subscription, triggered at 6+ nodes.
- Unlimited nodes in the Fleet View
- 90-day metric history
- Sentinel Thermal Rerouting
- Slack / PagerDuty alert integrations
- Priority support

The upgrade moment is natural: when your fleet grows past 5 nodes, you're no longer a hobbyist — you're running infrastructure. That's when Team Edition becomes the right tool.

The local agent is and will remain open source. The hosted fleet infrastructure is the commercial layer.

---

## Key Technology Choices

| Choice | Rationale |
|---|---|
| Rust | Single binary, zero runtime, cross-compile to any target, <1MB footprint |
| rust-embed | Bakes the React build into the binary — no separate web server, no file paths |
| Axum | Async HTTP + SSE with minimal overhead, same tokio runtime as the harvester |
| React + Tailwind | Fast to build, dark-mode native, no build-time CSS purge needed for embedded use |
| SSE + WebSocket | SSE for 1Hz baseline metrics; WebSocket (`/ws`) for 10Hz liquid pulse rolling charts |
| SQLite (planned) | Local metric history without a database server — fits the sovereign model |
