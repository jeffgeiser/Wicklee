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
- [ ] **Fleet Connect:** Pair local agents to the hosted Fleet View at `wicklee.app` via 6-digit pairing code. Zero config, instant aggregation. Dual-stream: 100ms local, 500ms cloud.
- [ ] **Multi-Tenant Backend:** Fleet-wide aggregation, node history, and alert management on Railway

---

## Phase 3: The Generative Observer
- [ ] **Wattage-per-Token:** Real-time inference ROI — compute cost per 1,000 tokens across the fleet
- [ ] **Thermal Rerouting (Sentinel):** Automated workload shifting based on node health and thermal state
- [ ] **Apple Neural Engine (ANE):** Utilization and wattage for M-series inference workloads — the metric Activity Monitor doesn't show
- [ ] **Unified Memory Deep-Dive:** Distinguish Model Weights from OS Overhead in the memory pressure breakdown

---

*Wicklee is sovereign infrastructure. Your fleet data never leaves your network until you choose to connect it.*
