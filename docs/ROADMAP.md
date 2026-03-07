# Wicklee Roadmap 🛰️

> *Sovereign GPU fleet monitoring. Your fleet data never leaves your network until you choose.*

---

## ✅ Phase 1: The Standalone Sentinel — COMPLETE

The single-binary local dashboard. Zero dependencies, zero cloud, zero config.

- Single Rust binary, ~672KB idle footprint — zero runtime dependencies
- Embedded React/Tailwind dashboard served at `localhost:7700` via `rust-embed` + Axum
- **Sudoless Deep Metal on Apple Silicon:**
  - GPU utilization via `ioreg` (AGX accelerator, no sudo)
  - Thermal state via `pmset` (Normal / Fair / Serious / Critical, no sudo)
  - Memory pressure via `vm_stat` (wired + active pages only, no sudo)
  - Available memory computed correctly (`total - used`, not `sysinfo.available_memory()`)
- 1Hz SSE stream + 10Hz WebSocket "Liquid Pulse" for rolling live charts
- CPU Power Draw (`cpu_power_w`, `ecpu_power_w`, `pcpu_power_w`) — requires `sudo wicklee`; renders with honest "requires elevated permissions" label without sudo
- Global CLI install: `sudo make install` → `wicklee` from anywhere
- ASCII startup box with port and dashboard URL printed to terminal

---

## ✅ Phase 2: The Multi-Node Fleet — COMPLETE

Connect multiple nodes to a hosted fleet view. Sovereign by default — nothing leaves the network until the operator explicitly pairs a node.

- **NVIDIA/NVML Support** — GPU utilization %, VRAM used/total, GPU temp, board power draw — Linux and Windows via `nvml-wrapper`, no sudo required
- **Windows Support** — full binary for `x86_64-pc-windows-msvc`. NVML works on consumer NVIDIA cards (GTX/RTX). Thermal state returns None on Windows (Phase 3: WMI)
- **Fleet Connect** — WK-XXXX persistent node identity, 6-digit pairing codes with 5-minute expiry, `wicklee --pair` CLI flag, PairingModal in local dashboard, AddNodeModal on hosted dashboard. Node identity stored in `~/.wicklee/config.toml`
- **Real Authentication** — `POST /api/auth/signup`, `POST /api/auth/login`, `GET /api/auth/me`. bcrypt (cost 12), UUID session tokens, AuthModal with Sign In / Create Account tabs, localStorage session restore
- **SQLite Persistence** — `rusqlite` (bundled, no system dep). Tables: `users`, `sessions`, `nodes`. WAL mode. Railway `/data` persistent volume. Accounts and pairings survive redeployment
- **Localhost auth bypass** — `isLocalHost` detection. `localhost:7700` boots directly to dashboard with no auth gate — local agent is single-user by design
- **Cloud telemetry architecture** — Agent pushes to Railway (`POST /api/telemetry`, 2Hz) after pairing. Browser reads from Railway (`GET /api/fleet/stream` SSE). Browser never connects directly to `localhost` from an HTTPS page (no mixed content)
- **Hosted view isolation** — Views requiring local agent data (Observability, Local Intelligence) show placeholder state on `wicklee.dev` directing users to `localhost:7700`. Eliminates Chrome Local Network Access permission prompts
- **Context-aware onboarding** — Zero-node accounts see 3-step empty state (Install → Open dashboard → Enter code) with Add Node CTA. "Disconnected from Local Agent" banner suppressed on hosted view
- **Stale-node detection** — Hosted dashboard shows "Node `<hostname>` appears offline — last seen `HH:MM:SS`" when telemetry goes stale >30 seconds
- **GitHub Actions release pipeline** — `.github/workflows/release.yml`. 4-platform parallel matrix. Trigger: `git tag v* && git push origin v*`. Each job builds frontend first (embeds into binary), then Rust agent. `linux-aarch64` uses `cross`
- **curl install script** — `install.sh` served at `wicklee.dev/install.sh`. Detects OS/arch, downloads correct binary from GitHub Releases. macOS post-install tip for `sudo wicklee` CPU power metrics
- **Domains** — `wicklee.dev` canonical (Railway). `wicklee.com` → 301 → `wicklee.dev` via Cloudflare. `www` variants redirect correctly
- **HF Space** — [Wattage-per-Token Calculator](https://huggingface.co/spaces/Wicklee/Wattage-per-token) live with GPU presets, cloud API cost comparison

**Remaining Phase 2 item:**
- [ ] **Multi-Tenant Backend** — fleet-wide aggregation, per-node history, alert management on Railway. Currently nodes store last telemetry snapshot only

---

## 🔜 Phase 3: The Intelligence Layer

Make the fleet self-aware. Surface the signals that predict problems before users notice them.

- [ ] **Wattage-per-Token (live)** — Real-time inference ROI: power draw ÷ tokens/sec across the fleet. Requires Ollama/vLLM integration for token throughput data
- [ ] **Ollama / vLLM / LM Studio Integration** — Read active models, requests/sec, and token throughput from local inference runtimes. Auto-detect: Ollama (`localhost:11434`), vLLM (`localhost:8000`), LM Studio (`localhost:1234`)
- [ ] **Thermal Rerouting (Sentinel)** — When a node crosses thermal threshold, dashboard surfaces one-click rerouting card: "Node X is throttling (89°C). Shift workload to Node Y (67°C)?" Phase 3 is observe + suggest. Phase 4 is automatic
- [ ] **Thermal Webhooks** — Nodes in `Serious` or `Critical` thermal state fire a configurable webhook (node ID, state, timestamp, current metrics). Targets: Slack, PagerDuty, custom HTTP
- [ ] **Alert Rules UI** — Define thresholds per node (thermal state, GPU %, memory pressure) and map each rule to webhook targets. Alert history log visible in Fleet View
- [ ] **Apple Neural Engine (ANE)** — Utilization and wattage for M-series ANE inference workloads — the metric Activity Monitor doesn't show
- [ ] **Unified Memory Deep-Dive** — Distinguish Model Weights from OS Overhead in the memory pressure breakdown on Apple Silicon
- [ ] **DuckDB Trace Visualization** — Wire `TracesView` to real DuckDB query results from the agent. TTFT, TPOT, latency per request per model
- [ ] **Thermal state on NVIDIA Linux** — Implement via NVML temperature thresholds
- [ ] **Thermal state on Windows** — Implement via WMI thermal zone API
- [ ] **Memory pressure on Linux** — Implement via `/proc/meminfo` pressure metrics

---

## 📋 Phase 4: The Commercial Layer

Turn the open-core into a sustainable business.

- [ ] **Team Edition gate** — Hard 5-node limit on Community Edition. Upgrade prompt at node 6. Stripe integration for Team Edition subscription
- [ ] **Real OAuth / Clerk** — Replace bcrypt DIY auth with Clerk. Email/password + Google + GitHub OAuth. Persistent sessions, forgot password, email verification
- [ ] **Sentinel Proxy (opt-in)** — Wicklee exposes a local OpenAI-compatible proxy endpoint. Clients point at Wicklee; Wicklee forwards to the healthiest node. Routing strategies: `lowest-thermal`, `lowest-load`, `round-robin`, `pinned`
- [ ] **Proxy Observability** — Per-request latency, reroute events, token throughput visible in dashboard alongside hardware metrics
- [ ] **Slack / PagerDuty alert integrations** — Production-grade alert delivery with retry, dedup, and escalation policies
- [ ] **90-day metric history** — DuckDB on Railway with time-series retention. Fleet trend analysis, capacity planning views
- [ ] **Show HN launch** — `install.sh` and GitHub Releases pipeline already exist. Launch when Phase 3 core features land

---

## 📋 Phase 5: Enterprise

- [ ] **On-premise deployment** — Docker Compose + Helm chart for teams that can't use Railway
- [ ] **SSO / SAML** — Enterprise identity provider integration
- [ ] **HIPAA / SOC 2 posture** — Audit logging, data residency controls, encryption at rest
- [ ] **WASM Interceptor Marketplace** — Users upload WASM modules to nodes for PII redaction, prompt safety, request transformation via Wasmtime runtime
- [ ] **mTLS secure fabric** — Node-to-node mutual TLS for zero-trust fleet communication
- [ ] **AMD GPU support** — ROCm-based GPU metrics for AMD inference hardware

---

## Platform Support Matrix

| Metric | Apple Silicon | NVIDIA Linux | NVIDIA Windows | AMD Linux |
|---|---|---|---|---|
| CPU usage % | ✅ | ✅ | ✅ | ✅ |
| Memory used/available | ✅ | ✅ | ✅ | ✅ |
| Memory pressure % | ✅ sudoless | 🔜 Phase 3 | — | 🔜 Phase 3 |
| GPU utilization % | ✅ sudoless | ✅ NVML sudoless | ✅ NVML sudoless | 📋 Phase 5 |
| GPU temp | — | ✅ NVML sudoless | ✅ NVML sudoless | 📋 Phase 5 |
| VRAM used/total | — | ✅ NVML sudoless | ✅ NVML sudoless | 📋 Phase 5 |
| GPU power draw | — | ✅ NVML sudoless | ✅ NVML sudoless | 📋 Phase 5 |
| Thermal state | ✅ sudoless | 🔜 Phase 3 | 🔜 Phase 3 | 📋 Phase 5 |
| CPU power draw | ⚠️ sudo only | ⚠️ sudo only | ⚠️ sudo only | ⚠️ sudo only |
| ANE utilization | 🔜 Phase 3 | — | — | — |

---

## Monetization Model

**Community Edition** — free, always, no account required for local use.
- Full local dashboard at `localhost:7700` with all Deep Metal metrics
- Hosted Fleet View for up to 5 nodes
- The natural upgrade threshold: when your fleet grows past 5 nodes, you're running infrastructure

**Team Edition** — paid subscription, unlocked at 6+ nodes.
- Unlimited nodes
- 90-day metric history
- Sentinel Thermal Rerouting
- Alert integrations (Slack, PagerDuty)
- Priority support

The local agent is and will remain open source. The hosted fleet infrastructure is the commercial layer.

---

*Wicklee is sovereign infrastructure. Your fleet data never leaves your network until you choose to connect it.*
