# Wicklee Roadmap 🛰️

## ✅ Shipped
- Rust agent, 672KB idle footprint — zero runtime dependencies
- Embedded React/Tailwind dashboard served at `:7700` from a single binary
- Sudoless Deep Metal on Apple Silicon: CPU Usage, GPU Utilization, Thermal State, Memory Pressure
- Available Memory via `vm_stat` (wired + active pages only)
- **Mem Pressure Accuracy:** Wired + Active pages only — inactive/speculative excluded
- 1Hz SSE stream — live hardware data with graceful `null` fallback for privileged metrics
- **10Hz WebSocket "Liquid Pulse":** Real-time rolling charts for CPU, GPU, and Memory
- **Global CLI Install:** `make install` → `wicklee` from anywhere in the terminal
- Green "Live" pulse indicator — connection state visible at a glance

---

## Phase 1: The Standalone Sentinel *(In Progress)*
- [ ] **CPU Power (Elevated):** `cpu_power_w`, `ecpu_power_w`, `pcpu_power_w` — requires root or entitlement; display with honest "requires elevated permissions" label

---

## Phase 2: The Multi-Node Fleet
- [ ] **NVIDIA/NVML Support:** Board power draw (Watts), VRAM used/total, GPU Temp — Linux nodes via `nvml-wrapper`
- [ ] **Fleet Connect:** Pair local agents to the hosted Fleet View at `wicklee.dev` via 6-digit pairing code. Zero config, instant aggregation. Dual-stream: 100ms local, 500ms cloud.
- [ ] **Multi-Tenant Backend:** Fleet-wide aggregation, node history, and alert management on Railway

---

## Phase 3: Sentinel Alerting
- [ ] **Thermal Webhooks:** Nodes in `SERIOUS` or `CRITICAL` thermal state fire a configurable webhook payload (node ID, state, timestamp, current metrics)
- [ ] **Suggested Rerouting:** Dashboard surfaces a one-click confirmation card — "Node X is throttling. Shift workload to Node Y?" with projected thermal relief shown inline
- [ ] **Alert Rules UI:** Define thresholds per-node (thermal state, GPU %, memory pressure) and map each rule to one or more webhook targets
- [ ] **Alert History:** Timestamped log of fired alerts and rerouting actions, visible in Fleet View

---

## Phase 4: Sentinel Proxy *(opt-in)*
- [ ] **Inference Interceptor:** Wicklee exposes a local OpenAI-compatible proxy endpoint — clients point at Wicklee instead of the model server; Wicklee forwards to the healthiest node
- [ ] **Automatic Rerouting:** When a node crosses a thermal or load threshold mid-fleet, in-flight requests are transparently shifted to the next best node with no client changes required
- [ ] **Routing Policy Config:** Configurable strategies — `lowest-thermal`, `lowest-load`, `round-robin`, `pinned` — selectable per model or per client tag
- [ ] **Proxy Observability:** Per-request latency, reroute events, and token throughput visible in the dashboard alongside hardware metrics

---

## Phase 5: The Generative Observer
- [ ] **Wattage-per-Token:** Real-time inference ROI — compute cost per 1,000 tokens across the fleet
- [ ] **Thermal Rerouting (Sentinel):** Automated workload shifting based on node health and thermal state
- [ ] **Apple Neural Engine (ANE):** Utilization and wattage for M-series inference workloads — the metric Activity Monitor doesn't show
- [ ] **Unified Memory Deep-Dive:** Distinguish Model Weights from OS Overhead in the memory pressure breakdown

---


*Wicklee is sovereign infrastructure. Your fleet data never leaves your network until you choose to connect it.*
