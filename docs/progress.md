# Wicklee — Progress Journal

*A running log of what shipped, what was learned, and what's next. Most recent entry first.*

> **Canonical references:** `docs/ROADMAP.md` (product roadmap, phases, tier structure) · `docs/progress.md` (this file — engineering journal, most-recent-first)

---

## March 23, 2026 — v0.5.16–v0.5.20: DuckDB Events, Port Validation, Proxy Awareness, Diagnostic Doctor

### v0.5.16 — DuckDB Event Persistence ✅
- **Agent:** `node_events` table in `store.rs` with `write_event()`, `query_events()`, 7-day retention. `event_type` field on `LiveActivityEvent`. Centralized `push_event()` helper. `GET /api/events/history` endpoint (paginated, cursor-based).
- **Cloud:** `live_activities` + `LiveActivityEventPayload` added to cloud `MetricsPayload` (three-way sync fix). `node_events` DuckDB table with tenant isolation, 30-day retention. `events_writer_task` via mpsc channel. `GET /api/fleet/events/history` (JWT-authenticated).
- **Frontend:** `EventHistoryRecord` interface, `useEventHistory` hook with cursor-based pagination, Event History panel in Observability tab.

### v0.5.16 — UI Fixes ✅
- **Version display:** `package.json` synced to match `Cargo.toml` — footer no longer shows stale fallback version.
- **Fleet row height:** Invisible placeholder in TOK/S column idle state prevents row height shifting when IDLE-SPD badge appears/disappears.
- **Thermal on localhost:** New `Thermal` row in DiagnosticRail (after Board Power) — shows Normal/Fair/Serious/Critical with color coding and penalty multiplier badge.

### v0.5.17 — Probe Diagnostic Logging ✅
- Added `eprintln!` to both silent skip paths in the Ollama probe (port=None, model=None).
- `discover_first_ollama_model` now logs failures instead of silently returning `None`.
- Removed per-scan socket-scan log spam from `process_discovery` (logged on change only).

### v0.5.18 — Ollama Port Validation ✅
- **Root cause:** Tier 3 socket scan found Ollama worker subprocesses (`ollama_llama_server`) on internal port 34111 — not the API. All API calls returned 404.
- **Fix:** Harvester health-checks discovered port via `/api/version`. Falls back to default port (11434) when API doesn't respond. Validated port stored in `OllamaMetrics.validated_port` so probe task uses correct port.
- **Install script:** `cap_sys_ptrace` capability preserved across upgrades (install.sh checks old binary before replacing).
- **Release workflow:** Nightly release now also updates on version tag pushes (not just main branch).

### v0.5.19 — tok/s Regression Fix ✅
- **Root cause:** `validated_port` not in the carry-forward list when the harvester rebuilds `OllamaMetrics` every 5s. Zeroed by `..Default::default()`, causing the probe to skip every cycle.
- **Fix:** One line — `validated_port: prev_state.validated_port` in the struct rebuild.

### v0.5.20 — Proxy Awareness UI + Port Doctor ✅
- **Proxy Awareness:** Dynamic Sovereignty manifest shows "Wicklee Proxy" (active) or "Ollama inference probe" (inactive) based on real-time agent data. Rich traces empty state with 3-step proxy setup guide (proxy inactive) or curl test command (proxy active, no traces yet). `proxy_listen_port` + `proxy_target_port` on MetricsPayload (three-way sync).
- **Port Doctor:** `--status` diagnostic warns when runtime detected on default port but API not responding. Suggests `[runtime_ports]` config override.
- **Discovery hints:** First-scan log for default-port runtimes suggests config override.
- **Settings cleanup:** Node Configuration section hidden on localhost (cloud-only feature).

### Critical Bugs Found & Fixed
- **Ollama worker socket discovery (BMC)** — Tier 3 socket scan preferred non-default ports, picking up internal worker sockets instead of the API. Fixed with API health check + default port fallback.
- **tok/s regression (all Ollama nodes)** — `validated_port` erased every 5s by struct rebuild. Probe skipped permanently, tok/s stayed blank.
- **Spark vLLM port loss** — `cap_sys_ptrace` stripped by install script replacing the binary. Fixed: install.sh now preserves the capability.
- **Nightly release stale** — Version tag builds didn't update the nightly release. Install script pulled old version. Fixed: nightly job now runs on both main pushes and tag pushes.

### What's Next (Phase 3B remaining)
1. **Audit Log Export** — exportable pairing and telemetry history (`GET /api/export`)
2. **Network & Port Discovery docs** — Hierarchy of Truth, Admin-not-Root guide, Proxy setup
3. **v0.6.0 — "Sovereignty Release"** tag

---

## March 23, 2026 — v0.5.10–v0.5.15: Dead Zone Fix, Module Extraction, Inference Traces, llama.cpp Harvester

### v0.5.10 — Dead Zone Fix ✅
- **Root cause:** Ollama `/api/ps` `expires_at` resets were being attributed to user inference even when caused by the 30s probe. Result: Tier 2 "Live" classification during idle periods (the "Dead Zone").
- **Fix:** `probe_caused_next_reset` one-shot flag in `OllamaMetrics`. The probe sets it on completion; the harvester consumes it on the first `expires_at` change it sees. This cleanly distinguishes probe-caused resets from real user requests without time-based blackouts.
- **`InferenceState` enum** replaces raw strings in Rust — `Live`, `IdleSpd`, `Busy`, `Idle`. Serializes to frozen wire values (`"live"`, `"idle-spd"`, `"busy"`, `"idle"`).
- **8 new unit tests** covering all tier transitions and probe attribution edge cases.

### v0.5.11 — Graceful Shutdown ✅
- SIGTERM/SIGINT handler flushes in-flight responses and DuckDB WAL.
- `powermetrics` child process uses `kill_on_drop` — no orphan processes after agent restart.

### v0.5.12 — Module Extraction ✅
- `main.rs` split into focused modules: `inference.rs`, `harvester.rs`, `proxy.rs`, `cloud_push.rs`, `service.rs`, `diagnostics.rs`.
- `pub(crate)` visibility for inter-module access. No behavioral changes.

### v0.5.13 — Bootstrap Retry + Install Script Hardening ✅
- **launchctl race fix:** bootstrap retry loop handles port-release timing after `bootout`.
- **install.sh bash guard:** detects `dash`/`sh` and re-execs under `bash` for array syntax compatibility.
- **`--status` power check:** diagnostics now probe powermetrics availability.

### v0.5.14 — Inference Traces ✅
- Ollama proxy captures done-packet timing → `inference_traces` DuckDB table.
- `GET /api/traces` endpoint serves trace history to the Observability tab's TracesView.
- `uuid` crate added for trace ID generation.

### v0.5.15 — llama.cpp Inference-Active Harvester ✅
- **Tier 1 (Exact) detection** for `llama-server` and `llama-box` via `/health` endpoint polling.
- Polls configurable `llama_cpp_url` (default `localhost:8080`) every 2s.
- Parses `{"slots_idle": N, "slots_processing": M}` — `slots_processing > 0` = inference active.
- New `LlamaCppMetrics` shared state: `llama_cpp_running`, `llama_cpp_model`, `llama_cpp_slots_processing`, `llama_cpp_slots_idle`.
- `compute_inference_state()` updated: `llama_cpp_slots_processing > 0` is Tier 1 (exact), same priority as vLLM `requests_running > 0`.
- **Three-way sync maintained:** agent `MetricsPayload` → cloud `MetricsPayload` → frontend `SentinelMetrics` all updated with `llama_cpp_*` fields.
- 1 new unit test for llama.cpp inference state transition.

### Critical Bugs Found & Fixed
- **Cloud MetricsPayload missing 20+ fields** — `serde(default)` silently dropped `apple_soc_power_w`, `inference_state`, `agent_version`, `penalty_avg`, etc. Root cause of fleet power/WES divergence for months. Fixed in `cloud/src/main.rs`.
- **Frontend power calculation** — ~30 callsites used `cpu_power_w` instead of `apple_soc_power_w`. Created `src/utils/power.ts` with `getNodePowerW()` utility, replaced all inline calculations.
- **Fleet smoothing divergence** — fleet SSE at 2s cadence with 8-sample window = 16s lag. Added `FLEET_ROW_ROLLING_WINDOW=4` and GPU% smoothing in fleet row.
- **Localhost version display** — DashboardShell read from FleetStreamContext (empty on localhost). Fixed with one-shot `/api/metrics` fetch.
- **Power cost $0.00** — shows "< $0.01/day" when cost rounds to zero.

### What's Next (Phase 3B remaining)
1. **DuckDB event persistence** — `node_events` table, `GET /api/events/history`
2. **Audit Log Export** — exportable pairing and telemetry history

---

## March 19, 2026 — Sprint 7: Pattern K + L, Deep Metal Charts, Agent CLI Polish (v0.4.30–v0.4.33)

### New Agent Fields — Deep Metal Expansion ✅

Three new fields on `MetricsPayload` and `SentinelMetrics` (TypeScript + Rust):

| Field | Source | Platform | Notes |
|---|---|---|---|
| `swap_write_mb_s` | `/proc/diskstats` (Linux) · `vm_stat` (macOS) · WMI (Windows) | All | Swap write rate during inference; explains inference stuttering |
| `clock_throttle_pct` | NVML `clock_info(Clock::Graphics)` vs `max_clock_info(Clock::Graphics)` | NVIDIA | `(1 − cur/max) × 100`; 0 = full speed, 100 = fully throttled |
| `pcie_link_width` | NVML `current_pcie_link_width()` | NVIDIA | Current PCIe lane count (1/4/8/16); zero-privilege |
| `pcie_link_max_width` | NVML `max_pcie_link_width()` | NVIDIA | Max lane count the GPU + slot support |

**Rust agent (`agent/src/main.rs`):**
- `NvidiaMetrics` struct gains `pcie_link_width: Option<u32>` + `pcie_link_max_width: Option<u32>` (both with `#[serde(skip)]`).
- NVML harvester probes both after the clock throttle block.
- `MetricsPayload` gains all four new fields with `#[serde(skip_serializing_if = "Option::is_none")]`; forwarded in both WS + SSE broadcast loops.
- **NVML API correction:** `ClockType` → `Clock` enum (nvml_wrapper 0.10 rename). Previously caused Linux CI build failure — Mac arm64 compiled cleanly because `#[cfg(no_nvml)]` skipped the affected code.

**TypeScript (`src/types.ts`):** `SentinelMetrics` and `HistorySample` gain optional fields for all four.

**`useMetricHistory` hook (`src/hooks/useMetricHistory.ts`):** `MetricSample` interface gains `swap_write_mb_s`, `clock_throttle_pct`, `pcie_link_width`, `pcie_link_max_width`. `metricsToSample()` maps all four from the raw metrics object. localStorage schema version unchanged (additive).

---

### MetricHistoryPanel — 5th + 6th Charts + 2×3 Grid ✅

`src/components/TracesView.tsx` — `MetricHistoryPanel` expanded from 4 to 6 charts:

| Chart | Color | Field | Unit |
|---|---|---|---|
| Tok/s | indigo | `tps` / `tps_avg` | `tok/s` |
| Power Draw | amber | `gpu_power_w` | `W` |
| GPU Util % | cyan | `gpu_util_pct` | `%` |
| CPU Usage % | blue | `cpu_usage_pct` | `%` |
| **Swap Write** | rose `#f43f5e` | `swap_write_mb_s` | `MB/s` |
| **Clock Throttle** | violet `#8b5cf6` | `clock_throttle_pct` | `%` |

Grid changed from `grid-cols-1 sm:grid-cols-2` → `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3` (2×3 on large screens, 2×2 stacked on md, single-col on mobile).

---

### Pattern K — Clock Drift (Community) ✅

`src/lib/patternEngine.ts` — `evaluatePatternK()`.

**Detection (5-min gate):**
- 70% data coverage gate on `clock_throttle_pct` samples
- `tok_s > 0.5` — inference active
- `avgThrottle > 15%` (soft threshold, warning) or `> 35%` (hard threshold, severe escalation)
- ≤ 30% hot thermal samples — guards against overlap with Pattern A (heat-driven throttle)

**Signal:** Clock throttling without thermal cause. Root causes: power delivery limits, TDP cap set too low, VRM current limit, driver-enforced frequency cap.

**Quantification:** `impliedFullTokS = avgTokS / ((100 - avgThrottle) / 100)` — how fast the node would run at full clock speed. Hook: `"-X tok/s (Y% clock throttle)"`.

**Severe escalation (> 35%):** Title changes to "Severe Clock Throttle During Inference". `action_id: check_power_limits` (new ActionId).

**`PATTERN_LABELS` additions:**
```typescript
clock_drift:           'Clock Drift',
pcie_lane_degradation: 'PCIe Lane Degradation',
```

---

### Pattern L — PCIe Lane Degradation (Pro) ✅

`src/lib/patternEngine.ts` — `evaluatePatternL()`.

**Detection (5-min data window):**
- 70% of samples have `pcie_link_width` + `pcie_link_max_width` present
- 70% of those samples show `curWidth < maxWidth` (degraded lanes)
- ≥ 50% of samples with `tok_s > 0.5` — active inference required

**Signal:** Physical hardware condition — GPU not seated fully in PCIe slot, or slot wiring fault. Causes silent bandwidth reduction invisible to software monitoring.

**Quantification:** `bandwidthLossPct = Math.round((1 - curWidth / maxWidth) * 100)`. Hook: `"PCIe x{cur} of x{max} ({loss}% bandwidth loss)"`.

**Note:** PCIe lane count is static (doesn't change at runtime). The 5-min window is for data-quality confidence, not temporal change detection.

**Tier:** `pro`. `action_id: check_power_limits` (closest available physical-fix action).

---

### v0.4.32 — launchctl `--install-service` Reinstall Fix ✅

**Root cause:** `launchctl load -w` (deprecated macOS 10.15+) fails with I/O error 5 when the service label `dev.wicklee.agent` is already registered in the system domain. The plist would write successfully, but the old service kept running the old binary. Error shown to user but reported as success.

**Fix — `install_service()` macOS block:**
```rust
// Bootout any existing registration (silently no-ops if not registered)
let _ = tokio::process::Command::new("launchctl")
    .args(["bootout", "system/dev.wicklee.agent"])
    .status().await;
// Bootstrap the new plist
let status = tokio::process::Command::new("launchctl")
    .args(["bootstrap", "system", plist_path])
    .status().await;
```

**Fix — `uninstall_service()` macOS block:**
`launchctl unload -w <plist>` → `launchctl bootout system/dev.wicklee.agent`.

Both paths now use the modern `bootout` / `bootstrap` commands. Clean reinstalls work on all macOS 10.15+ versions without the I/O error 5.

---

### v0.4.33 — Version Print on Every Invocation ✅

`println!("wicklee-agent v{}", env!("CARGO_PKG_VERSION"))` added as the first statement in `main()` — before all flag dispatch. Every `wicklee` / `sudo wicklee` invocation announces its version on line one.

- `--install-service` → `wicklee-agent v0.4.33` then install result
- `--uninstall-service` → version then result
- `--status` → version then status box
- `--version` → version (returns immediately; `--version` handler's duplicate `println!` removed)
- Daemon startup → version appears in `/var/log/wicklee.log` at boot — useful for diagnosing which build is running

---

## March 19, 2026 — Sprint 6: Dismissal Log Panel + Probe Startup Alignment

### Dismissal Log — Observability Tab ✅

Sprint 6 is now complete on the frontend. The Observability tab has a fifth section: **Dismissal Log** (`DismissalLogPanel` in `TracesView.tsx`).

**What it shows:**
- All active (non-expired) `accepted_states` rows from the agent DuckDB, fetched via `GET /api/insights/dismissed`
- Columns: **Pattern** (human-readable label + raw ID), **Scope** (Fleet-wide badge or `node_id`), **Dismissed**, **Expires** (relative — "in 2d 4h", "Permanent", or "Expired"), **Note**
- Polls every 30s; relative-time labels tick independently every 30s without a re-fetch
- `PATTERN_LABELS` map covers all 10 patterns A–J

**Design details:**
- Amber section icon (`ClipboardList`) — distinct from the other blue/green/indigo panels
- Fleet-wide dismissals (empty-string `node_id`) rendered as an indigo `Fleet-wide` badge
- Permanent dismissals (>5-year expiry) show `XCircle` icon + "Permanent" in gray — intentional, not alarming
- Cockpit-only (`isLocalHost`) — same gate as Agent Health and Metric History
- Empty state explains the dismiss lifecycle; footer names `accepted_states` table and `metrics.db` for operator reference

### Ollama + vLLM Probe Startup Alignment

Diagnosed a real field issue: after a Mac agent restart, metrics wouldn't appear until a manual Ollama prompt was sent. Root cause: the probe task raced the agent startup and attempted to fire before Ollama's HTTP server was ready.

**Fix:**
- Both `start_ollama_harvester` and `start_vllm_harvester` now sleep 7s before entering their probe loops (previously: 0s for Ollama, 30s tick-burn for vLLM)
- Ollama also gains an `/api/tags` fallback: if no model is loaded on startup, the probe queries the model list and uses the first available — ensuring the first 30s probe always has a target
- The asymmetry is intentional: vLLM requires `--model` at launch (never modelless); Ollama can have keep_alive expire with no loaded model

---

## March 19, 2026 — Sprint 6: Dismiss API + Pattern I + Prescriptive Resolution Steps 🎯

### Sprint 6 — `POST localhost:7700/api/insights/dismiss` ✅

Insight dismissals are now persisted to the local agent's DuckDB, not just localStorage.

**Agent changes (`agent/src/store.rs`):**
- New `accepted_states` table: `(pattern_id, node_id, dismissed_at_ms, expires_at_ms, note)` — `(pattern_id, node_id)` primary key, upsert resets expiry on re-dismiss
- `record_dismiss()` — upsert method
- `query_active_dismissals(now_ms)` — filters expired rows
- `prune_expired_dismissals()` — cleanup utility

**Agent routes (`agent/src/main.rs`):**
- `POST /api/insights/dismiss` — `DismissRequest { pattern_id, node_id?, expires_at_ms?, note? }` → 202 Accepted
- `GET /api/insights/dismissed` — returns `{ dismissals: Dismissal[] }` for all non-expired records
- Both gated on `#[cfg(not(target_env = "musl"))]` (require DuckDB store)

**Frontend (`src/hooks/useInsightDismiss.ts`):**
- Dual-write: localStorage (zero-latency, works offline) + agent endpoint (fire-and-forget)
- Agent sync on mount: pulls active dismissals from agent and merges into localStorage (longer-lived agent record wins)
- New `dismiss(expiresInMs?, note?)` signature — optional params, backward-compatible

### Pattern I — Efficiency Penalty Drag ✅

New pattern exploiting the `penalty_avg` field from WES v2 — none of A–H used it. Catches the "invisible tax" class of software-configuration performance losses.

**Detection (5-min gate, pro tier):**
- `penalty_avg > 0.30` — > 30% of WES eaten by software overhead
- `thermal_state === 'Normal'` — not a thermal penalty
- `gpu_util_pct > 30%` — GPU is active (not Pattern D decoupled)
- `mem_pressure < 75%` and `vram < 80%` — not Pattern F/G memory-bound
- `tok_s > 0.5` — inference active

**Root causes surfaced:** context windows too long, batch too small to saturate GPU pipeline, KV cache fragmentation from mixed-length requests, MoE expert routing overhead.

**Icon:** `Wind` (yellow) in InsightsBriefingCard, `TrendingDown` (yellow) in ObservationCard.

### `resolution_steps: string[]` added to all patterns A–I ✅

New field on `DetectedInsight` — 5 numbered, prescriptive steps per pattern. Each step is a complete standalone instruction (command, config change, or physical action).

Patterns and their resolution focus:
- **A (Thermal Drain):** airflow → reroute → TDP cap commands
- **B (Phantom Load):** `ollama stop` → `OLLAMA_KEEP_ALIVE` → per-request `keep_alive`
- **C (WES Velocity Drop):** watch command → preemptive reroute → background process check
- **D (Power-GPU Decoupling):** `OLLAMA_NUM_GPU=99` → quantization switch → vLLM batch tuning
- **E (Fleet Imbalance):** `/api/v1/fleet/wes` → Nginx weight update → auto-rebalance webhook
- **F (Memory Trajectory):** `ollama stop` → `OLLAMA_MAX_LOADED_MODELS=1` → pressure monitoring
- **G (Bandwidth Saturation):** quantization downgrade → context reduction → hardware upgrade path
- **H (Power Jitter):** thundering herd vs PSU branch — queue smoothing vs PSU headroom check
- **I (Efficiency Drag):** context window reduction → batch tuning → MoE GPU offload → vLLM chunked prefill

Rendered as a numbered list in ObservationCard, below the recommendation and above copy buttons. Exposed in `/api/v1/insights/latest` for automation consumers.

---

## March 19, 2026 — Pattern H (Power Jitter) 🌊

**The Goal:** Implement Pattern H — Power Jitter — the leading indicator of PSU/VRM stress and thundering-herd load balancer issues.

---

### `src/lib/patternEngine.ts` — Pattern H: Power Jitter ✅

New `stddev()` helper added alongside `mean()`. New `evaluatePatternH()` wired into `evaluatePatterns()`.

**Detection (5-min gate, community tier):**
- `mean(watts) > 30W` — not idle drift
- `tok_s > 0.5` — inference active
- `stddev(watts) / mean(watts) > 0.20` — coefficient of variation > 20%

**Thundering herd upgrade:** if `tok_s` CoV is also > 25%, hook appends `· thundering herd` and recommendation targets bursty dispatch. This separates "load balancer is inconsistent" from "PSU is stressed".

**Why 30s samples are sufficient:** PSU/VRM stress accumulates from repeated swing events. A node cycling 200W → 40W in 30-second windows is still wearing its VRMs. True 1Hz data would catch finer spikes but the inter-window variance is already a reliable signal for the batch-level load inconsistency case.

**New icon:** `Waves` (orange) — electrical ripple/oscillation, distinct from all existing patterns.

### `src/components/insights/ObservationCard.tsx` + `InsightsBriefingCard.tsx` ✅

- `power_jitter` → `Waves` icon, `text-orange-400` in both icon maps

---

## March 19, 2026 — Pattern G (Bandwidth Saturation) + Deep Metal Roadmap 🔬

**The Goal:** Implement Pattern G — the "Model Suitability" / Bandwidth Saturation insight — and document the Deep Metal metrics expansion roadmap.

---

### `src/lib/patternEngine.ts` — Pattern G: Bandwidth Saturation ✅

New `evaluatePatternG()` function wired into `evaluatePatterns()`.

**Detection logic (all conditions, 5-min gate):**
- `gpu_util_pct < 45%` — GPU cores are waiting, not working
- VRAM > 80% (NVIDIA) or memory pressure > 70% (Apple Silicon proxy)
- `tok_s > 0.5` — inference IS active (not phantom load)
- Thermal state is Normal — this is not a thermal issue
- WES dropped > 35% from session peak — confirms real degradation

**Key architectural distinctions:**
- Not Pattern A: thermals are Normal (not the root cause)
- Not Pattern D: the bottleneck is the memory bus, not CPU-offload or batch size
- Not Pattern C: WES is stuck low, not declining (condition already chronic)

**Recommendation branches:**
- Fleet peer available → `rebalance_workload` (shift to higher-bandwidth node) + quantization note
- Solo/no peer → `switch_quantization` (new ActionId) + hardware upgrade note

**New ActionId:** `switch_quantization` — reduce model precision to lower memory bandwidth demand. Added to `ActionId` union in `patternEngine.ts`.

**Tier:** `pro` — requires GPU utilization history (NVIDIA or Apple Silicon IOKit).

---

### `src/components/insights/ObservationCard.tsx` ✅

- New `switch_quantization` badge: `Gauge` icon, emerald color
- New `bandwidth_saturation` pattern icon: `Gauge`, `text-emerald-400`
- New `bandwidth_saturation` hookColor: `text-emerald-400`

### `src/components/insights/InsightsBriefingCard.tsx` ✅

- `bandwidth_saturation` added to `patternIcon()` + `patternColor()`
- `switch_quantization` added to `ACTION_ID_COLORS` (emerald)

---

### Deep Metal Roadmap documented ✅

New Phase 4B section in ROADMAP.md: "Deep Metal Metrics Expansion" table with 8 metrics,
source, privilege level, platform, phase, and pattern trigger:

| Priority | Metric | Why it matters |
|---|---|---|
| 4B-1 | Power jitter (stddev/10s) | PSU/VRM stress, thundering-herd LB detection |
| 4B-1 | SSD Swap I/O | Explains inference "stuttering" when VRAM pressure causes swap |
| 4B-2 | Clock frequency drift | Voltage/power throttle not captured by thermal_state |
| 4B-3 | PCIe lane width | Physical bus fault causes "slow GPU" with no software signal |
| 4B-3 | XID error logs | Pre-crash kernel events → stability penalty → near-zero WES |
| 4B-4 | VRAM temperature | HBM throttle when core is "cool" — false normal detection |
| 4B-4 | Fan efficacy | Predictive: blocked airflow before throttle onset |
| 4B-enterprise | ECC / page retirement | VRAM degradation pre-failure signal (A100/H100) |

---

## March 19, 2026 — Sprint 5 + Sovereignty Copy Fix + isPaired cloud bug 🛰️

**The Goal:** Fix the broken Sovereignty section in cloud mode, improve context-aware copy, and ship the `GET /api/v1/insights/latest` endpoint (Sprint 5).

---

### `src/components/TracesView.tsx` — Sovereignty section fixes ✅

**Bug fix — `isPaired` derived incorrectly in cloud mode:**
- `isPaired` was derived from `pairingInfo?.status === 'connected'`, where `pairingInfo` comes from `GET localhost:7700/api/pair/status` (the local agent's pairing handshake). In cloud mode at wicklee.dev, this fetch fails or returns unpaired, even when the user has 3 fleet nodes streaming live via SSE.
- **Fix:** split derivation by context. Cockpit (localhost): `pairingInfo.status === 'connected'` (unchanged). Mission Control (cloud): `connectionState === 'connected' || connectionState === 'degraded'` from `useFleetStream()` — correct signal for live fleet presence.

**Copy fix — three-branch Telemetry Destination card:**
- **Cockpit (localhost):** "No outbound telemetry. All inference data stays on this machine." + "Transmitted to fleet" / "Never leaves this machine" — machine-centric, unchanged.
- **Cloud + paired:** "Each node transmits only system metrics and WES scores. Inference content is processed on-device and never leaves the node." + "Each node transmits" / "Never leaves the node" — node-centric, viewer-agnostic.
- **Cloud + no nodes:** "No nodes connected yet. Add a node to see its telemetry routing details here." + neutral gray `Radio` icon + "No nodes" badge. Removes the confusing "localhost:7700 / LOCAL ONLY" display for cloud users who haven't paired yet.

---

### `cloud/src/main.rs` — Sprint 5: `GET /api/v1/insights/latest` ✅

New handler `handle_v1_insights_latest`. Six deterministic pattern rules evaluated against `AppState.metrics` (in-memory fleet state — no DuckDB, no LLM):

| Pattern key | Trigger | Severity |
|---|---|---|
| `fleet_offline` | All nodes unreachable (>30s) | high |
| `node_offline` | Single node missing, partial outage | moderate |
| `thermal_stress` | `Critical` / `Serious` thermal state | high / moderate |
| `memory_pressure` | mem pressure ≥90% / ≥75% | high / moderate |
| `low_throughput` | Node tok/s <40% of fleet average (≥2 nodes) | low |
| `wes_below_baseline` | Node WES <40% of fleet average (≥2 nodes) | low |

Findings sorted high → moderate → low, then alphabetically by node_id within severity.

Response shape: `{ generated_at_ms, fleet: { online_count, total_count, avg_wes, fleet_tok_s }, findings: [...] }`.

Auth: `X-API-Key` (same as all v1 routes). Rate limits: same 60/600 req/min tiers.

**Route registered:** `.route("/api/v1/insights/latest", get(handle_v1_insights_latest))` + startup banner updated.

**`cargo check` passes cleanly.**

---

## March 19, 2026 — Phase 4A: Observability Tab Panels + Sprint 4 "View source →" 🔬

**The Goal:** Complete the Phase 4A Observability Tab additions from `docs/ROADMAP.md` —
Raw Metric History panel and Agent Health panel. Wire the "View source →" link that closes
Sprint 4's final item: one click from a pattern finding to its raw evidence.

---

### `src/components/TracesView.tsx` — Two new Phase 4A sections ✅

**`MetricHistoryPanel` (Cockpit / localhost only):**
- Fetches `GET /api/history?node_id=X&from=X&to=X` from the local agent DuckDB store
- `nodeId` sourced from `pairingInfo.node_id` (always populated — present before pairing)
- Time window selector: **1h / 6h / 24h** with manual refresh button
- Auto resolution: agent picks raw (1 Hz) → 1-min agg → 1-hr agg based on window width
- Four `MiniChart` area charts (Recharts `AreaChart` + gradient fill):
  - **Tok/s** — `tps` (raw tier) or `tps_avg` (aggregate tiers), indigo
  - **Power Draw** — `gpu_power_w` (Apple Silicon cpu_power + GPU, or NVIDIA board_power), amber
  - **GPU Util %** — `gpu_util_pct`, cyan
  - **CPU Usage %** — `cpu_usage_pct`, blue
- Resolution badge + per-chart sample count
- Error state: amber banner for musl targets where DuckDB is compiled out
- Empty state: prompt to run inference ("history collects at 1 Hz")

**`AgentHealthPanel` (Cockpit / localhost only):**
- Three indicator tiles:
  - **Collection** — `connectionState` dot (green pulse/amber/red) + transport badge (`sse`)
  - **DuckDB Store** — lightweight `/api/history` probe on mount (30s window) → ok / unavailable. "musl target — DuckDB disabled" hint on failure.
  - **Last Frame** — `lastTelemetryMs` relative age: "just now" / "Ns ago" / "Nm ago"
- Harvester manifest: lists all 4 active collection threads + cadences (WS 100ms · SSE 1Hz · history 1Hz DuckDB)

**Main component refactored:** `TracesView` is now a function component (not arrow-const
expression) so `nodeId` can be derived from `pairingInfo.node_id` before rendering.
Phase 4A panels are conditionally rendered: `{isLocalHost && nodeId && <Panel />}`.

---

### `src/components/AIInsights.tsx` — "View source →" link ✅

New optional prop: `onNavigateToObservability?: () => void`.

"View raw metric history →" button (Activity icon) added to the Top Finding card's
action_id / curl snippet block. Visible only in Cockpit mode (`isLocalHost`) when
the prop is provided. Clicking navigates to the Observability tab where the Raw Metric
History panel now lives — completing the "Silicon Truth" chain: pattern finding →
recommendation → raw evidence.

---

### `src/App.tsx` — Navigation wiring ✅

```tsx
<AIInsights
  ...
  onNavigateToObservability={() => setActiveTab(DashboardTab.TRACES)}
/>
```

---

### `src/types.ts` — History types added ✅

```typescript
interface HistorySample {
  ts_ms, model?, tps?, tps_avg?, tps_max?, tps_p95?,
  cpu_usage_pct?, gpu_util_pct?, gpu_power_w?, vram_used_mb?, thermal_state?
}
interface HistoryResponse {
  node_id, resolution: 'raw' | '1min' | '1hr', from_ms, to_ms, samples[]
}
```
Mirrors `store::HistorySample` and `store::HistoryResponse` in `agent/src/store.rs`.

---

### Architecture note — `/api/v1/insights/latest` and the dashboard

The Wicklee dashboard computes pattern findings **client-side** via `patternEngine.ts`.
It does **not** call `/api/v1/insights/latest` (Sprint 5). That endpoint is for
**external consumers only**: automation scripts, CI/CD pipelines, MCP tools, and cron
jobs that need a machine-readable directive without running a browser. Both the dashboard
and the API run the same deterministic logic — the API is the external projection, not
the source of truth for the dashboard.

---

### What's Next

**Sprint 4 (Morning Briefing Card — remaining items):**
- Fleet Pulse section: nodes online/total · fleet tok/s · top WES node · fleet idle cost
- Head-to-head comparison (≥ 2 nodes, same model size class)
- Top Finding + Recommendation (action_id as curl command in InsightsBriefingCard)

**Sprint 5 — Cloud Rust backend:**
- `GET /api/v1/insights/latest` — deterministic JSON, all tiers, no LLM
- External consumer endpoint: CI/CD, MCP, orchestration agents

**Sprint 6:**
- `POST localhost:7700/api/insights/dismiss` → `accepted_states` table
- Permanent accept option in ObservationCard
- Dismissal Log section in Observability tab

---

*Entries before March 19, 2026 (Phase 3A, Phase 3B, Phase 4A Sprints 1–3) are in **`docs/progress-archive.md`**.*
