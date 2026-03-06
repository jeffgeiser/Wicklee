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

## Phase 3: The Generative Observer
- [ ] **Wattage-per-Token:** Real-time inference ROI — compute cost per 1,000 tokens across the fleet
- [ ] **Thermal Rerouting (Sentinel):** Automated workload shifting based on node health and thermal state
- [ ] **Apple Neural Engine (ANE):** Utilization and wattage for M-series inference workloads — the metric Activity Monitor doesn't show
- [ ] **Unified Memory Deep-Dive:** Distinguish Model Weights from OS Overhead in the memory pressure breakdown

---

## Phase 6+ — Context Compaction Authority *(Memory Sovereignty)*

**Goal:** Solve the "Inference Tax" by moving from a context *provider* to a Context *Optimizer*.

> **Core insight:** Current model memory is recency-biased — recent context survives, old context compresses, regardless of actual importance. A usage-frequency + conviction signal inverts that: something referenced 50 times across 6 months should survive compaction even if it wasn't mentioned in the last 10 messages. "Use it a lot historically" should mean "never lose it."

### API Concept — Context Priority Endpoint
```
GET /api/context/priority
→ {
    critical:    [...],  // queried 10+ times, HIGH conviction
    important:   [...],  // queried 3–9 times, MEDIUM+ conviction
    contextual:  [...],  // queried 1–2 times
    dormant:     [...]   // never queried, low conviction
  }
```
An agent or orchestration layer calls this before compaction to explicitly inject `critical` items into the preserved context window.

### Research Tasks
- [ ] **Context Priority API** — `/api/context/priority` endpoint using conviction + query frequency + ConflictSignal data to rank importance
- [ ] **Compaction Hints** — library function for orchestrators (CrewAI/LangGraph) to call pre-compaction to identify "Hard Invariants"
- [ ] **Memory Invariants** — UI in the Vault Editor to mark specific standards as "Never Compress"
- [ ] **Model Hook Research** — monitor Anthropic/OpenAI for memory APIs or internal compaction hooks to register as the "Context Oracle"
- [ ] **Semantic Deduplication** — replace redundant session context with single LogicNode Reference IDs to save tokens

### Strategic Note
Model providers only see the current window; this system sees the 6-month evolution of the developer's standards. The behavioral calibration dataset (ConflictSignal + QueryLog) is the only external signal that knows what a specific developer considers important across time — a moat that cannot be replicated without the usage history. If compaction hooks become available at the API level, this positions the system as a registerable memory authority: "before you compact, check here for what this developer considers invariant."

---

*Wicklee is sovereign infrastructure. Your fleet data never leaves your network until you choose to connect it.*
