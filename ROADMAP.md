# Wicklee — Engineering Roadmap

_Last updated: 2026-03-18. Updated after DGX Spark hardening sprint (v0.4.21–v0.4.27) and fleet metric accuracy fixes._

---

## Status Key

| Symbol | Meaning |
|--------|---------|
| ✅ | Shipped |
| 🔨 | In progress |
| 🗓️ | Planned |
| 💡 | Idea — needs design |

---

## Recently Shipped

- ✅ **vLLM IDLE-SPD idle probe (v0.4.27)** — `probe_vllm_tps()` POSTs 20-token completions request when `vllm_requests_running == 0`; wall-clock timing gives real hardware throughput baseline. Prometheus `avg_generation_throughput_toks_per_s` filtered at `> 0.1` so idle zeros don't clobber the probe value.
- ✅ **Three-state TOK/S display** — LIVE (`vllm_requests_running > 0` or `ollama_inference_active`), BUSY (GPU% ≥ threshold), IDLE-SPD (probe/smoothed baseline). Tilde `~` prefix only on pure GPU%-estimated values, never on measured Prometheus or probe readings.
- ✅ **Self-update service hardening (v0.4.26)** — `install_service` chowns binary to service user; `install.sh` re-runs `--install-service` on update; `EPERM` prints actionable hint.
- ✅ **Multi-PID socket scan + config-locked runtimes (v0.4.26)** — discovery collects all matching PIDs, prefers non-default port (main server vs worker subprocess). TOML `[runtime_ports]` overrides are fully excluded from the 30s discovery loop — dynamic discovery can never overwrite a config value.
- ✅ **`HOME` resolution via getpwuid (v0.4.25)** — `resolve_config_path()` falls back to `getpwuid(getuid())` when `$HOME` is absent from the environment. Fixes `/.wicklee/config.toml` appearing under systemd with no `HOME=` directive.
- ✅ **systemd unit `User=` + `HOME=` (v0.4.23)** — `install_service` emits correct `User=` and `Environment=HOME=` entries. Services no longer run as root with an absent HOME.
- ✅ **Apple Silicon detector fix** — replaced `cpu_power_w != null` with `memory_pressure_percent != null` throughout UI. Linux RAPL populates `cpu_power_w` on AMD/Intel; `memory_pressure_percent` is strictly IOKit/macOS-exclusive.
- ✅ **Fleet VRAM aggregator unified (NodesList + Overview)** — single `calculateTotalVramMb`/`calculateTotalVramCapacityMb` in `efficiency.ts` covers NVIDIA VRAM + Apple GPU wired budget. Both tiles (Management tab and Intelligence tab) use the same functions. Fixed `appleGpuBudgetMb` zero-guard (`??` → `!= null && > 0`) so nodes where the sysctl probe emits `gpu_wired_limit_mb=0` contribute the correct 75%-of-RAM estimate instead of zero.
- ✅ **W/1K column** — Fleet Status table column renamed and recalculated to watts-per-1k-tokens (matching "WATTAGE / 1K TKN" summary tile). Lower = more efficient; units consistent end-to-end.
- ✅ **Peak TPS tracking + throughput estimation** — per-node session high-water mark; `estimateTps()` fills in GPU-utilisation-based estimate when probe fails or returns depressed reading during inference lockup.
- ✅ **`None`-on-probe-failure handling** — Ollama probe writes `null` instead of crashing on connection error.
- ✅ **MIN_COST_TPS rolling-buffer guard** — `MIN_COST_TPS = 0.1 tok/s` prevents Ollama startup-ramp spikes from contaminating the 12-sample cost rolling buffer.
- ✅ **Cost formula unit fix** — `costPer1k` was using `÷1000` where `÷3,600,000` is required (J/k·tok → $/k·tok). Off by ×3600. Fixed.

---

## Phase 1 — Observability Foundation  _(Do first — everything else depends on it)_

### 1.1 DuckDB Write Path + Schema  🔨

Three-tier columnar schema. Design it right before writing a single row — migrations are painful.

**Tables:**
```sql
-- Tier 0: raw 1Hz samples, 24h retention
CREATE TABLE metrics_raw (
  ts           TIMESTAMPTZ NOT NULL,
  node_id      TEXT        NOT NULL,
  model        TEXT,
  tps          DOUBLE,
  cpu_temp_c   DOUBLE,
  cpu_power_w  DOUBLE,
  gpu_power_w  DOUBLE,
  gpu_util_pct DOUBLE,
  vram_used_mb BIGINT,
  wes          DOUBLE,
  cost_per_1m  DOUBLE,
  PRIMARY KEY (ts, node_id)
);

-- Tier 1: 1-minute aggregates, 30d retention
CREATE TABLE metrics_1min (
  ts           TIMESTAMPTZ NOT NULL,
  node_id      TEXT        NOT NULL,
  tps_avg      DOUBLE, tps_max DOUBLE, tps_min DOUBLE,
  cpu_temp_avg DOUBLE, cpu_temp_max DOUBLE,
  power_avg_w  DOUBLE,
  wes_avg      DOUBLE,
  cost_avg_1m  DOUBLE,
  PRIMARY KEY (ts, node_id)
);

-- Tier 2: 1-hour heartbeat snapshots, 90d retention
CREATE TABLE metrics_1hr (
  ts           TIMESTAMPTZ NOT NULL,
  node_id      TEXT        NOT NULL,
  tps_avg      DOUBLE, tps_p95 DOUBLE,
  cpu_temp_avg DOUBLE, cpu_temp_max DOUBLE,
  power_avg_w  DOUBLE,
  wes_avg      DOUBLE,
  cost_avg_1m  DOUBLE,
  PRIMARY KEY (ts, node_id)
);
```

**Rust agent tasks:**
- Write to `metrics_raw` on every SSE frame
- Hourly background Tokio task: aggregate raw → 1min, raw → 1hr, then delete raw rows older than 24h and 1min rows older than 30d
- Target: under 100 MB for a 10-node fleet over a full quarter

**API endpoint:**
```
GET /api/history?node_id=&from=&to=&resolution=auto
```
Agent auto-selects tier based on window size:
- < 2h → raw
- 2h–7d → 1-minute
- > 7d → 1-hour

Never send raw rows to the browser. Always pre-aggregate server-side.

---

### 1.2 Idle-Only Probing ("Stealth Canary")  🗓️

**Why:** The Ollama 20-token benchmark probe runs every 30s regardless of whether the node is serving a real request. Under load it returns a depressed reading or times out. This is the root cause of the spike problem `MIN_COST_TPS` patches around. Fixing at the source eliminates the need for the patch.

**Logic (Rust agent):**
```
if now - last_inference_end_ts < 60s:
    skip probe; use estimation gap math (peak × gpu_util%)
else:
    fire 20-token benchmark; update peak_tps if result > current peak
```

**"Idle" definition:** Model unloaded from Ollama context (clean signal from `/api/ps`), not throughput-below-threshold (noisy). Fallback for always-busy nodes: cap probe interval at 5 min to reduce interference.

**Benefit:** Turns Wicklee from an active monitor into a passive observer that only benchmarks when safe. Peak TPS becomes a true high-water mark rather than a lucky timing artifact.

---

## Phase 2 — Metric Quality Improvements

### 2.1 Empirical Thermal Penalty  🗓️

Replace the hardcoded `THERMAL_PENALTY` table with a live, measured degradation ratio.

**Formula:**
```
thermal_penalty_ratio = peak_tps / rolling_avg_current_tps
                        (only when cpu_temp_c > 85°C)
```

**Data flow:**
- `peakTpsMap` (already tracking session high-water mark, resets on model swap) is the baseline
- Short rolling average of current tps (last 4 samples) is the degraded reading
- Ratio displayed: "⚠️ 1.4× measured throttle at 95°C" instead of static "2.0× (estimated)"

**Depends on:** Phase 1.1 (historical baseline) makes this more accurate; can ship with session-only baseline first.

---

### 2.2 Ghost Power — Calibrated CPU Coefficient  💡

For Apple Silicon nodes where `cpu_power_w` requires `sudo`, infer total power from GPU power draw using a per-node calibration coefficient.

**Approach:**
- First time a node runs with sufficient permissions, store the observed `cpu_power_w / gpu_power_w` ratio during inference in DuckDB as `node_calibration.cpu_gpu_ratio`
- All future no-permission sessions estimate: `estimated_cpu_w = gpu_power_w × cpu_gpu_ratio`
- Tag all estimated values with `(est)` in the UI
- If no calibration data exists: show `—` (not a wrong number)

**UI:** "Limited Telemetry" banner showing exact command to copy, not a curl-pipe-to-sudo one-liner.

**Depends on:** Phase 1.1 (need storage for calibration data).

---

## Phase 3 — Cloud Sync + Historical UI

### 3.1 Cloud Storage Sync  💡

Once local DuckDB is solid, add an optional background sync job:
- Export hourly aggregates to S3-compatible storage (Cloudflare R2 preferred for cost)
- Signed URLs, no plaintext credentials in config
- Frontend can optionally query cloud endpoint for cross-session / cross-device history

### 3.2 Historical Charts + Time Range Selector  💡

- Add date range picker to GPU Utilisation chart (already using Recharts)
- Wire to `/api/history` endpoint with auto-resolution selection
- "Live" mode = current SSE stream; "History" mode = DuckDB query result
- Zoom-in refines resolution automatically (same accordion tiers)

---

## Deferred / Backlog

| Item | Notes |
|------|-------|
| Hardware-derived node ID | Use `/etc/machine-id` (Linux), `IOPlatformUUID` (macOS), `MachineGuid` (Windows) — deterministic, survives reinstalls. Eliminates re-pairing after agent updates. |
| Keep-warm audit logs | Log every probe ping outcome; UI surfaceable in Observability tab |
| mTLS fabric UI | Visual representation of node-to-node trust graph |
| WASM binary upload flow | Scaffolding view work item |
| DuckDB-rs trace visualization | Enhanced query builder for trace records |

---

## Known Issues / Active Watch Items

| Issue | Status |
|-------|--------|
| Per-node cost shows `$0.00` for low-wattage Apple Silicon nodes | Expected — Mac at 1.5W / 44 tok/s is genuinely sub-cent per million tokens. Display needs `< $0.01` guard instead of `$0.00`. |
| `peakTpsMap` resets on page reload | Session-scoped by design; Phase 1.1 DuckDB baseline will persist this. |
| Probe interference on weak nodes | Addressed by MIN_COST_TPS; fully fixed by Phase 1.2 idle-only probing. |
| vLLM IDLE-SPD on DGX Spark shows IDLE-SPD even with no active requests | Correct — the probe runs every 30s when `vllm_requests_running == 0`. The displayed tok/s is real hardware throughput at idle. LIVE only lights when requests are actively running. |
