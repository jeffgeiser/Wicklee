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

## Phase 6+ — Context Compaction Authority *(Research / Placeholder)*

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
- [ ] Monitor Anthropic/OpenAI API roadmaps for compaction hooks or memory authority APIs
- [ ] **Context Priority API** — ranked importance endpoint using conviction + query frequency + behavioral signals
- [ ] **Compaction Hints** — library function (not MCP) for orchestrators to call pre-compaction; takes a list of context items, returns them ranked by importance signals
- [ ] **Memory Invariants** — concept for Vault standards marked as "never-compress" by the developer explicitly
- [ ] **Integration path research** — Claude memory system, OpenAI memory API, future compaction hooks

### Strategic Note
The behavioral calibration dataset (ConflictSignal + QueryLog) is the only external signal that knows what a specific developer considers important across time. This is a genuine moat in the memory authority space — cannot be replicated without the usage history. If compaction hooks become available at the API level, this positions the system as a registerable memory authority: "before you compact, check here for what this developer considers invariant."

---

*Wicklee is sovereign infrastructure. Your fleet data never leaves your network until you choose to connect it.*
