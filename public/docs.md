# Wicklee Documentation

> Sovereign GPU fleet monitor for local AI inference.
> One Rust binary per node, React dashboard at localhost:7700, fleet aggregation at wicklee.dev.

---

## Quick Start

```bash
# macOS & Linux
curl -fsSL https://wicklee.dev/install.sh | bash

# Windows (PowerShell as Administrator)
irm https://wicklee.dev/install.ps1 | iex
```

Dashboard opens at **http://localhost:7700**. Auto-starts on boot as a system service.

## CLI Reference

| Command | Description |
|---------|-------------|
| `sudo wicklee --install-service` | Install as system service (auto-start on boot) |
| `sudo wicklee --uninstall-service` | Remove service |
| `wicklee --status` | Health check (queries running agent) |
| `wicklee --pair` | Pair with fleet (interactive) |
| `wicklee --version` | Print version |

---

## WES Score

**Canonical formula:**

```
WES = tok/s ÷ (Watts × PUE × ThermalPenalty)
```

The "MPG for local AI" — a unitless score that collapses thermal throttling, power draw, and throughput into a single comparable number. Higher is better.

### Inputs (frozen — every WES surface uses these inputs)

| Input | Source | Notes |
|---|---|---|
| **Watts** | `getNodePowerW(node)` | **Raw board power** (NVIDIA → Apple SoC → CPU fallback). Never idle-subtracted: the `systemIdleW` per-node setting is for active-inference cost displays only, not WES. The frozen color scale was calibrated against raw watts. |
| **PUE** | `getNodeSettings(id).pue` (default 1.0) | Datacenter operators set PUE > 1.0 to factor in cooling overhead. Home labs leave it at 1.0. |
| **ThermalPenalty** | `thermal_state` from agent | See table below. |

All four WES surfaces — KPI hero (Intelligence), Fleet Status row, Model Fit Analysis (Insights → Performance), Summary Strip — read from a shared module-level smoothing buffer (`src/utils/sharedSmoothing.ts`, 4-sample moving average). Same node, same metric, identical value across every tab.

### Thermal Penalties

| State | Penalty | Effect |
|-------|---------|--------|
| Normal | 1.0x | No penalty |
| Fair | 1.25x | Mild throttling |
| Serious | 1.75x | Heavy throttling |
| Critical | 2.0x | Maximum penalty |

### Color Scale

| WES | Color | Rating |
|-----|-------|--------|
| > 10 | Emerald | Excellent |
| 3–10 | Green | Good |
| 1–3 | Yellow | Acceptable |
| < 1 | Red | Low |

### Why low WES isn't always a problem

Big-iron GPUs (H100, A100, DGX Spark / GB10) running batch=1 small workloads will show **persistently low WES** because their idle baseline power dominates per-token energy cost. A Spark drawing ~64W idle on a 32B FP8 model decoded at the memory-bandwidth ceiling produces tok/W ≈ 0.10 — that's physics, not a misconfiguration.

The `bandwidth_ceiling_reached` Pro pattern (#19) detects this case explicitly and fires an *info*-severity observation explaining *"you're at the physics ceiling for this hardware/quant pair."* The Model Fit Analysis fleet headline reflects the same nuance: low efficiency rows are tagged "informational" rather than "needs attention" — the latter is reserved for genuine memory risk (OOM / swap pressure).

---

## Model Fit Analysis

Model Fit Analysis scores each loaded model across two independent dimensions. A model can fit in memory but still run inefficiently — both dimensions matter.

### Dimension 1 — Memory Fit

Measures how much headroom remains after the model weights are loaded, on top of all other system memory use.

| Score | Condition | Meaning |
|-------|-----------|---------|
| **Good** | Headroom > 20% | Comfortable room for context and KV cache growth |
| **Fair** | Headroom 10–20% OR thermal Fair | Monitor closely under long contexts |
| **Poor** | Headroom < 10%, model exceeds capacity, OR thermal Serious/Critical | Risk of VRAM swapping or OOM |

Source: `src/utils/modelFit.ts :: computeModelFitScore`

### Dimension 2 — Efficiency (WES)

See [WES Score](#wes-score) above for the full formula. In Model Fit Analysis the WES thresholds map to:

| WES | Label | Meaning |
|-----|-------|---------|
| > 10 | Excellent | Exceptional throughput per watt — silicon is extremely well-matched |
| 3–10 | Good | Solid inference efficiency for this hardware class |
| 1–3 | Acceptable | Adequate — different quant or model size may improve tok/W |
| < 1 | Low | High energy cost per token — check thermal state |
| — | No data | No active inference measured yet; WES requires live tok/s and watt readings |

CPU-only nodes (no GPU/VRAM) show `—` for Efficiency until an inference probe completes. This is expected — it is not a negative rating.

### W/1K TKN

`(accelerator watts ÷ tok/s) × 1000`

Watts consumed per 1,000 tokens generated. Hardware-agnostic — lower is better. Useful for direct node-to-node comparisons regardless of model size.

### Quant Sweet Spot

A bandwidth-aware quantization recommendation computed from:
- Observed tok/s at the current quant
- Node chip memory bandwidth (from a chip lookup table)
- Model size in GB (from Ollama/vLLM metadata)
- Estimated speed change: scales tok/s by the inverse size ratio (memory-bandwidth-bound assumption)
- Quality delta: empirical KL divergence + perplexity data via the **Perplexity Tax** baseline (see below)

The recommendation upgrades quality when headroom allows, or downgrades when the node is memory-constrained.

### Perplexity Tax

Empirical quality cost for a given (model family, quant) pair, displayed alongside speed and memory tradeoffs in Model Fit Analysis. Replaces the hand-tuned quality-delta strings with measured KL divergence and perplexity data sourced from Unsloth Dynamic GGUF benchmarks and the llama.cpp perplexity discussions.

Single source of truth: `public/perplexity_baseline.json`. The cloud Rust binary embeds the same file at compile time so cloud-side fleet matching and frontend tiles agree on quality cost. Bands keyed off KLD:

| KLD | Band | Meaning |
|---|---|---|
| < 0.001 | Imperceptible | Empirically indistinguishable from FP16 in blind A/B tests |
| 0.001–0.01 | Mild | Small but measurable quality cost |
| 0.01–0.05 | Noticeable | Acceptable for many tasks; inspect output if quality matters |
| 0.05–0.15 | Severe | Substantial quality cost — coherence issues likely |
| > 0.15 | Unusable | Empirically unreliable for production |

`quant_quality_factor()` (cloud-side fleet score) and the Quant Sweet Spot recommender now read from this baseline, falling back to the legacy hand-tuned heuristic only when no entry exists. Curated coverage: Llama 3.1/3.2 (1B-70B), Qwen 2.5 (7B-72B), Mistral 7B, Mixtral 8x7B, Gemma 2 (9B-27B), Phi-3 Mini, DeepSeek-R1 distills.

**Source:** `public/perplexity_baseline.json` · `src/utils/perplexity.ts` · `cloud/src/main.rs :: lookup_kld()`

### Context Runway

Projects how much memory the KV cache will consume at each context-length milestone.

**Formula:** `2 × layers × KV-heads × head-dim × ctx-tokens × 2 bytes (FP16)`

When the model architecture is loaded from Ollama `/api/show`, values are exact. Otherwise they are estimated from parameter count (±30%) and labeled with `~`.

**Source:** `src/utils/kvCache.ts :: computeContextRunway`

### Quantization Compression Ratios

Used to estimate FP16-equivalent model size, VRAM savings, and weight-size projections for runtimes that don't expose explicit quant metadata.

| Quant family | Bits/weight avg | Size vs FP16 | Recognised tags |
|---|---|---|---|
| Q1 / IQ1 | ~1 | 12% | `Q1_K`, `IQ1_S`, `IQ1_M` |
| Q2 / IQ2 | ~2 | 17% | `Q2_K`, `Q2_K_L`, `IQ2_XXS`, `IQ2_XS`, `IQ2_M` |
| Q3 / IQ3 | ~3 | 22% | `Q3_K_S`, `Q3_K_M`, `Q3_K_L`, `IQ3_XXS`, `IQ3_XS`, `IQ3_M` |
| Q4 / IQ4 | ~4.5 (K-quant mixed) | 28% | `Q4_0`, `Q4_K_S`, `Q4_K_M`, `IQ4_XS`, `IQ4_NL` |
| Q5 | ~5 | 35% | `Q5_K_S`, `Q5_K_M` |
| Q6 | ~6 | 41% | `Q6_K` |
| Q8 / FP8 / INT8 | 8 | 50% | `Q8_0`, `FP8`, `INT8` |
| F16 / BF16 | 16 | 100% (baseline) | `F16`, `BF16`, `FP16` |
| F32 | 32 | 200% | `F32`, `FP32` |
| **AWQ** | 4-bit weights | 28% | `AWQ`, `AWQ-INT4`, `AWQ-4BIT` |
| **GPTQ** (4-bit) | 4-bit weights | 28% | `GPTQ`, `GPTQ-INT4`, `GPTQ-4BIT` |
| **GPTQ** (8-bit) | 8-bit weights | 50% | `GPTQ-INT8`, `GPTQ-8BIT` |
| **AQLM / HQQ-2bit** | 2-bit | 17% | `AQLM`, `AQLM-2BIT`, `HQQ-2BIT` |
| **HQQ** (4-bit) | 4-bit | 28% | `HQQ`, `HQQ-4BIT` |
| **BNB-4bit / NF4 / FP4** | 4-bit | 28% | `BNB-4BIT`, `NF4`, `FP4` |
| **BNB-8bit** | 8-bit | 50% | `BNB-8BIT` |

Ratios are approximate (±10%); actual values vary by model architecture (attention head count, MoE sparsity, K-quant mixed precision). The Unsloth `UD-` prefix is stripped before lookup so `UD-IQ2_M` is recognised as IQ2.

### Model size estimation chain

When a node doesn't report explicit model size, Wicklee estimates it via a priority chain (each step is strictly more accurate than the next):

1. **Ollama `/api/show` exact value** (`ollama_model_size_gb`) — exact, used when present
2. **Parameter-count × bytes-per-weight from the model name** (±10–20%) — the common path for vLLM and llama.cpp. Recognises `Llama-3.1-8B`, `qwen2.5-32b-FP8`, `Mixtral-8x7B-AWQ`, etc. When the quant tag can't be parsed, defaults to FP16/BF16 (vLLM's default dtype).
3. **`nvidia_vram_used_mb` proxy** — last resort. Inflated on vLLM (KV cache reservation), but better than nothing for un-tagged models.
4. **50 % of used system RAM** — CPU-only llama.cpp.

For vLLM/llama.cpp, the Memory Fit headroom uses `model_size + 10 %` as the "used" baseline rather than `nvidia_vram_used_mb` — answering *"does my model fit with room for context?"* not *"how much has the engine pre-allocated?"*

**Source:** `src/utils/quantSize.ts` (browser) · `agent/src/main.rs :: bytes_per_weight()` (Rust agent — kept in sync)
**GGUF spec reference:** https://github.com/ggerganov/llama.cpp/blob/master/docs/development/gguf.md

---

## Node States

The agent computes inference state once per second as a pure function from sensor readings. The `inference_state` field is the single source of truth — the dashboard displays it directly and never re-computes it.

| State | Meaning |
|-------|---------|
| **live** | Active inference detected |
| **idle-spd** | Model loaded, no active inference — probe baseline visible |
| **busy** | GPU active but no AI runtime detected (non-inference workload) |
| **idle** | No activity |

### Three-tier detection hierarchy (first match wins)

1. **Tier 1 — Exact runtime API:** vLLM and llama.cpp report active request/slot counts. If `requests_running > 0` or `slots_processing > 0`, the node is LIVE — zero ambiguity.

2. **Tier 2 — Ollama attribution:** When Ollama's `/api/ps` shows a model expiry change attributed to a user request (not the agent's probe), the node is LIVE for 15 seconds. A one-shot flag (`probe_caused_next_reset`) prevents the probe from being mistaken for user activity.

3. **Tier 3 — Physics / sensor fusion:** GPU utilization, SoC power, ANE power, and NVIDIA board power are read directly. If these exceed idle thresholds while a **model is loaded in VRAM**, the node is LIVE. A running runtime process (e.g. Ollama) with no model loaded will not trigger Tier 3 — everyday GPU activity from other apps cannot produce a false LIVE. A saturated-GPU override (≥75%) bypasses the post-probe cooldown window.

---

## Latency & TTFT

TTFT (Time to First Token) resolution priority:
1. **vLLM histogram** — production traffic (most accurate)
2. **Proxy rolling average** — real requests through optional proxy
3. **Ollama probe** — synthetic 20-token baseline (~30s cadence)

---

## Multi-Model Monitoring

Most inference deployments run multiple models concurrently. Wicklee always detects all loaded models and their VRAM — per-model throughput attribution depends on the runtime and whether the proxy is enabled.

**Per-model metrics (when attributed):** tok/s, VRAM allocation, average TTFT, average latency, request count, model size, and quantization level — all tracked independently for each loaded model.

**Wire format:** When 2+ models are loaded, the `active_models` array is included in the SSE/WebSocket payload. Single-model deployments omit the field (zero overhead). Existing singular fields (`ollama_active_model`, `ollama_tokens_per_second`) report the most-recently-active model for backwards compatibility.

### Ollama — proxy required for per-model throughput

The proxy intercepts every request and extracts per-request metrics from Ollama's done packet, accumulating statistics per model name. The harvester reads all loaded models from `/api/ps` every 2 seconds and merges VRAM data with proxy-derived performance stats.

**Without the proxy:** Wicklee detects all loaded models and their VRAM via `/api/ps`, but tok/s and latency come from the single-model probe. The Model Fit Efficiency column shows `—` for all models — throughput cannot be attributed to a specific model without request interception.

### vLLM — proxy optional, beneficial for multi-model setups

vLLM's Prometheus endpoint (`/metrics`) reports server-wide aggregate throughput — accurate for single-model WES but can't distinguish which model served which request. When running multiple models on one vLLM instance, a proxy reads the `"model"` field from each `/v1/chat/completions` request body to attribute tok/s, TTFT, and request counts per model.

**Without the proxy:** vLLM single-model deployments work fully (Prometheus gives exact throughput). Multi-model vLLM shows `—` for per-model efficiency in Model Fit Analysis — VRAM fit is still shown accurately.

**Per-model WES:** Each model gets its own efficiency score using proportional VRAM share for power attribution: `model_tok_s / (total_watts * vram_share * thermal_penalty)`. Answers "which model is most efficient on my hardware?" with live data.

**VRAM budget:** Stacked bar visualization showing each model's GPU memory allocation vs total budget. See exactly how your VRAM is divided across concurrent models.

**Model switching cost:** `GET /api/model-switches?hours=24` detects model transitions and reports swap frequency, idle gap per swap, and total overhead minutes. Helps quantify the cost of agent-driven model rotation.

**Per-model routing:** `GET /api/v1/route/best?model=qwen2.5:7b` filters to nodes that have the target model loaded and uses per-model WES for routing decisions. Enables model-aware fleet routing for agent runtimes.

---

## Model Discovery & Hardware Fit

"Is this model right for this hardware?" Wicklee fetches GGUF models from HuggingFace and scores each quantization variant against your hardware — before you download anything.

### Discovery Fit Score (0–100)

Four components, weighted to favor models that leave significant headroom for context scaling and KV cache growth:

| Component | Max | What it measures |
|---|---|---|
| VRAM headroom | 40 | Free VRAM/RAM after loading. Curve: 75%+ free → 40, 60% → 36, 45% → 32, 30% → 26, 15% → 20, 5% → 12, 0% → 6, won't fit → 0 |
| Thermal margin | 20 | Current thermal state: Normal (20), Fair (10), Serious (5), Critical (0) |
| Historical WES | 20 | Inference efficiency from similar models on this hardware; neutral (10) if no data |
| Power fraction | 20 | Model VRAM as fraction of total: <20% → 20, <35% → 16, <50% → 12, <70% → 8, <90% → 5, ≥90% → 2 |

**Labels:** Excellent (80+), Good (60–79), Tight (40–59), Marginal (<40), Won't Fit (insufficient VRAM).

**Memory pool:** NVIDIA nodes use VRAM; Apple Silicon and CPU-only nodes use system RAM (75% budget to leave headroom for the OS).

**Quant quality factor:** very low quants (IQ1, Q1, IQ2, Q2) get penalty multipliers (0.0–0.4) so a tiny quant of a huge model doesn't outscore a Q4 of a smaller one just because it leaves more VRAM headroom.

**Multi-part shard aggregation:** Large GGUF models published as multi-part shards (e.g. `model-Q4_K_M-00001-of-00003.gguf` + `00002-of-00003` + `00003-of-00003`) are aggregated into a single catalog variant with the **total** size summed across all shards. Without this, a 30 GB model split into 3 × 10 GB shards would score as three independent 10 GB variants and incorrectly appear to fit small hardware.

**Fleet "all nodes" filter:** the trending list defaults to showing only models scoring **Good (60+) on every online node**. Tight or marginal models are filtered out — users browsing the trending list expect models that will run well, not barely fit.

### Search behavior

- **No search term:** returns cached top-20 GGUF repos by HuggingFace downloads (24h TTL). Works offline after first cache fill.
- **With search term:** queries HuggingFace live — real search, not just filtering cached results. Scored in real time against your hardware.

### Ollama pull command

Every variant in the response includes a ready-to-run pull command:
```
"pull_cmd": "ollama pull hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M"
```
The Model Discovery panel shows a copy button; the raw command is also in the API response.

### Tiered access

| Tier | Feature | Endpoint |
|------|---------|----------|
| Community | Local discovery — scored against this machine | `GET /api/model-candidates` |
| Community | Fleet discovery — scored against every online node | `GET /api/fleet/model-candidates` (JWT) |
| Pro | Hardware simulation — "what if I had a 4090?" | `GET /api/v1/models/discover?simulate_hw=nvidia_4090` |
| Team | Fleet matching — which nodes can run this model? | `GET /api/v1/models/discover?fleet=true&model_id=` |

Available simulation profiles: `m4`, `m4_pro_24gb`, `m4_max_36gb`, `m4_max_64gb`, `m4_ultra_128gb`, `nvidia_4060`, `nvidia_4070`, `nvidia_4080`, `nvidia_4090`, `nvidia_a100_40gb`, `nvidia_a100_80gb`, `nvidia_h100`

---

## Where Model Fit Analysis Lives

The full **Model Fit Analysis** card is on the **Insights → Performance** tab — that's the canonical home, alongside the Inference Profiler, SLA Monitor, and Model Discovery surfaces it composes with for active investigation.

The **Intelligence** tab shows a 3-tile **Model Fit Summary Strip** (Model Fit · Quant Sweet Spot · Context Runway) directly under the KPI hero row. Each tile is a click-through that cross-tabs to Insights → Performance and scroll-locks to the full analysis. On fleet view the strip picks the highest-throughput active node and exposes a chip-row picker so operators can switch which node it summarises.

Within the full analysis, **fleet rows are clickable**: clicking any row drops into a per-node detail view with a "← Fleet" back link in the header.

### "Needs attention" semantics

The fleet headline at the top of the Model Fit Analysis card distinguishes two failure modes deliberately:

- **Needs attention** (red) — memory-poor only. Real OOM / swap risk. Action required.
- **Fair** (amber) — model fits but warrants a check (memory-fair OR efficiency-acceptable).
- **Optimal** (green) — both dimensions clean.
- **Low efficiency (informational)** (gray pill) — WES is low *but memory is fine*. Common on big-iron GPUs running batch=1 small workloads where idle baseline power dominates per-token energy cost. Not a fix-now signal — see the [`bandwidth_ceiling_reached`](#19-observation-patterns--6-fleet-alerts) Pro pattern, which fires when a node is at the physics ceiling for its hardware/quant pair.

### MCP tool: `get_model_fit`

The agent exposes `get_model_fit` for AI agents to query fit analysis programmatically:

```bash
curl -X POST http://localhost:7700/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_model_fit"},"id":1}'
```

Returns `memory_fit`, `efficiency`, `context_runway`, `quant_recommendation`, and a plain-English `summary` field.

---

## 20 Observation Patterns + 6 Fleet Alerts

### Agent-Evaluated (18 patterns, 10-min DuckDB buffer, every 10s)

**Community (9):** `thermal_drain`, `phantom_load`, `wes_velocity_drop`, `memory_trajectory`, `power_jitter`, `swap_io_pressure`, `clock_drift`, `nvidia_thermal_redline`, `vram_overcommit`

**Pro (9 agent-evaluated):** `power_gpu_decoupling`, `bandwidth_saturation`, `efficiency_drag`, `pcie_lane_degradation`, `vllm_kv_cache_saturation`, `ttft_regression`, `latency_spike`, `vllm_queue_saturation`, `bandwidth_ceiling_reached`

> **`pcie_lane_degradation`** — fires when the negotiated PCIe link width (e.g. x8) is below the card's rated maximum (e.g. x16), indicating a wrong-slot installation or failed lane. Detected via NVML `current_pcie_link_width` / `max_pcie_link_width` — **NVIDIA only, no root required**. Returns no data on virtualised GPUs (cloud instances, VMs) where PCIe info is unavailable.

> **`bandwidth_ceiling_reached`** *(severity: info)* — fires when a node sustains ≥65 % of its theoretical memory-bandwidth ceiling for the loaded model + quant, GPU utilisation is below 95 %, and the node has been live for ≥5 min. This explains a "Low" tok/W reading as **physics, not pathology**: at batch=1, fixed GPU baseline power dominates and per-token efficiency cannot improve without changing quant or batch size. Detected via `parameter_count × bytes_per_weight ÷ memory_bandwidth_gbps` per a per-chip lookup table (Apple M-series, NVIDIA H100/H200/A100/RTX, DGX Spark/GB10). The node is healthy — recommendation is informational: switch to a smaller GGUF quant for ~2× tok/s, or raise concurrent batch size to amortise baseline power.

### Cloud-Evaluated (2 patterns)

`fleet_load_imbalance` (Pro) — node WES > 20% below best healthy peer.

> **`wes_long_term_drift`** *(Pro, severity: warning)* — fires when penalized WES drops ≥15 % between the prior 6-day baseline and the most recent 24 hours. Detects gradual degradation that short-window patterns miss: dust accumulation in fans / heatsinks, thermal paste degradation on long-deployed hardware, driver / firmware regression after an OS update, or new background process load. Evaluated every 6 hours per Pro+ node against the 7-day Postgres rollup (`metrics_5min`). Requires ≥100 baseline samples (~8 h) and ≥30 recent samples (~2.5 h) before firing — sparse fleets won't trip false positives. Cooldown: 24 h. The 7-day WES history chart in Insights → Performance shows a matching drift annotation when the same condition is detected client-side, so chart and observation card stay in agreement.

### Fleet Alerts (6, all tiers, cloud, 60s cadence)
`zombied_engine`, `thermal_redline`, `oom_warning`, `wes_cliff`, `agent_version_mismatch`, `fleet_load_imbalance`

---

## Alerts & Notifications

When observations or fleet alerts fire, Wicklee delivers notifications to external channels.

| Channel | Configuration | Tier |
|---------|--------------|------|
| **Slack** | Incoming Webhook URL | Pro+ |
| **Email** | Any email address (via Resend) | Pro+ |
| **PagerDuty** | Integration Key (Routing Key) — Events API v2 with auto-resolve | Team+ |

Setup: Settings → Alerts → Add Channel → choose type → Test → Create Rules.

PagerDuty uses dedup keys (`wicklee-{node_id}-{event_type}`) for incident lifecycle — incidents auto-resolve when the condition clears.

Community tier: observations appear on the dashboard but no outbound notifications.

---

## Deep Intelligence

Wicklee uniquely has hardware telemetry, inference metrics, model identity, and per-request traces in the same DuckDB database. These endpoints leverage that combination:

### Inference Profiler
`GET /api/profile?minutes=60` — correlated timeline of TTFT, tok/s, KV cache %, queue depth, thermal penalty, and power on a single time axis. Resolution auto-scales (1s raw at 10min, 60s buckets at 24h).

### Inference SLA Monitor (Pro)
`GET /api/sla?window_min=60&target_ttft_ms=500&model=` — p50/p95/p99/max for TTFT, end-to-end latency, and TPOT computed via DuckDB `quantile_cont()` over the per-request `inference_traces` table. Compliance percentage against a configurable TTFT target, the 20 most-recent violations, and per-model breakdown. Window: 1–1440 minutes (24 h hard ceiling — that's the trace retention). Optional `model` filter narrows percentiles to one model.

Surfaced on the Performance tab as an SLA Monitor card with 1h / 6h / 24h windows, 250 ms / 500 ms / 1 s / 2 s target presets, color-coded compliance pill (≥99% emerald, ≥95% green, ≥90% yellow, <90% red), per-model p95 table, and a recent-violations list.

### Thermal Budget Calculator (Pro)
`GET /api/v1/thermal-budget?node_id=X` — predicts when pushing a node harder backfires. Walks the 7-day `metrics_5min` rollup, identifies sustained Normal-thermal blocks and Normal→Fair transitions, then computes:

- **`sustainable_tps`** — max tok/s observed during any Normal block ≥ 30 min long. The rate you can hold indefinitely.
- **`push_threshold_tps`** — median tok/s in the 10 min before any Normal→Fair transition. The load level that pushed you out of the Normal envelope.
- **`time_to_fair_min`** — average duration a Normal block lasted before transitioning. How long you have at push level.
- **`fair_penalized_tps`** — `push_threshold ÷ 1.25` (Fair thermal penalty). Effective throughput once Fair triggers.

Generates a plain-English advice string comparing 1-hour token output of "stay sustainable" vs "push then drop to penalized rate." When pushing yields fewer net tokens than the sustainable rate, the advice flags it as backfiring. Confidence levels (`insufficient` / `low` / `medium` / `high`) gate the analysis based on transitions observed and total samples — sparse fleets won't see false claims.

Surfaced on the Performance tab as the Thermal Budget card alongside the WES history chart and SLA Monitor.

### Cost Attribution Per Model
`GET /api/cost-by-model?hours=24` — per-model daily cost breakdown: model name, hours active, avg watts, cost USD. Uses power draw × model identity from DuckDB.

### "Why Was That Slow?" Explainer
`GET /api/explain-slowdown?ts_ms=N` — root cause analysis. Finds closest inference trace, reads ±30s hardware context, evaluates 6 factors (KV cache, thermal, queue, swap, memory, clock throttle), ranks by severity, generates natural-language summary.

### Model Comparison
`GET /api/model-comparison?hours=168` — side-by-side efficiency data for every model that has run on this node. Shows WES, tok/s, watts, TTFT, cost/hr. Answers "which model is most efficient on my hardware?" with real measured data.

Cloud MCP tools: `get_inference_profile` and `explain_slowdown` available for Team+ tier.

---

## Event Feeds

Wicklee has two distinct event surfaces that serve different purposes:

| | Live Activity | Recent Activity |
|---|---|---|
| **Location** | Intelligence page (scrollable feed) | Insights → Triage |
| **Data source** | Fleet events from SSE stream | Alert quartet latch system |
| **What it shows** | Connectivity, thermal transitions, model swaps, power anomalies, observation onset/resolved | Alert card lifecycle — when alerts fired and resolved, with duration |
| **Trigger** | Immediate — fires on every state transition | Delayed — fires after 15-second onset gate |
| **Persistence** | Current session only | sessionStorage — survives page refresh |
| **Purpose** | Real-time operational awareness | Post-incident review |

The Fleet Event Timeline on the Observability tab is a third, separate surface — it shows persisted `node_events` from Postgres (cloud) or DuckDB (localhost) with 30-day retention. This is the permanent audit record.

---

## Localhost API

Base URL: `http://localhost:7700`
Auth: None required.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/metrics | SSE stream — 1 Hz telemetry |
| GET | /ws | WebSocket — 1 Hz telemetry (same payload as SSE, fallback transport) |
| GET | /api/observations | 17 observation patterns with per-observation `routing_hint` (steer_away/reduce_batch/monitor) + node-level `routing_hint` + `routing_hint_source` |
| GET | /api/profile?minutes=60 | Inference Profiler — correlated TTFT/KV/queue/thermal/power timeline |
| GET | /api/sla?window_min=60&target_ttft_ms=500 | Inference SLA Monitor — p50/p95/p99 for TTFT/E2E/TPOT, compliance vs target, per-model breakdown, recent violations |
| GET | /api/v1/thermal-budget?node_id=X | Thermal Budget Calculator (Pro+, cloud) — predicts when pushing harder backfires. Sustainable rate, push threshold, time-to-Fair, penalized rate, plain-English advice |
| GET | /api/cost-by-model?hours=24 | Cost attribution per model — daily power cost breakdown |
| GET | /api/explain-slowdown?ts_ms=N | Root cause analysis for slow inference requests |
| GET | /api/model-comparison?hours=168 | Model comparison — side-by-side efficiency for all models |
| GET | /api/history?node_id=WK-XXXX | Metric history — 1h raw samples |
| GET | /api/traces | Proxy inference traces |
| GET | /api/events/history | Node event log |
| GET | /api/events/recent | Recent in-memory events |
| GET | /api/export?format=json\|csv | Data export |
| GET | /api/tags | Ollama model tags |
| GET | /api/pair/status | Pairing status |
| POST | /mcp | MCP JSON-RPC 2.0 endpoint |
| GET | /.well-known/mcp.json | MCP server manifest |

**Tip:** Discover your node ID with `curl -s http://localhost:7700/api/pair/status | jq .node_id` — use it for the `/api/history` endpoint:

```bash
NODE_ID=$(curl -s http://localhost:7700/api/pair/status | jq -r .node_id)
curl "http://localhost:7700/api/history?node_id=$NODE_ID" | jq '.samples | length'
```

---

## Fleet API v1

Base URL: `https://wicklee.dev/api/v1`
Auth: `X-API-Key: wk_live_...` header.

| Method | Endpoint | Description | Tier |
|--------|----------|-------------|------|
| GET | /api/v1/fleet | All nodes with full MetricsPayload | All |
| GET | /api/v1/fleet/wes | WES scores ranked | All |
| GET | /api/v1/nodes/{id} | Single node deep dive | All |
| GET | /api/v1/route/best | Routing recommendation | All |
| GET | /api/v1/insights/latest | Fleet intelligence snapshot | Team+ |
| GET | /metrics | Prometheus scrape endpoint | Team+ |
| GET | /api/otel/config | OTel export configuration | Team+ |
| PUT | /api/otel/config | Update OTel settings | Team+ |

---

## Teams & Organizations

Wicklee uses Clerk Organizations for shared fleet access. When you create an organization, every member sees the same fleet dashboard — nodes, observations, alerts, and history are all shared.

**Setup:** Create org → Invite members by email → Pair nodes while org is active → All members see the same fleet.

**Tier inheritance:** The org inherits the subscription tier of its creator. Upgrade to Team and all members benefit — no individual subscriptions needed.

**Solo users:** Organizations are optional. Community and Pro users can use Wicklee as a single-user dashboard with no changes.

---

## MCP Server

The agent exposes a local MCP (Model Context Protocol) server for AI agents. Available on all tiers, localhost only, no auth.

**Endpoint:** `POST http://localhost:7700/mcp` (JSON-RPC 2.0)

### Tools

| Tool | Description |
|------|-------------|
| get_node_status | Full hardware + inference metrics snapshot |
| get_inference_state | Live/idle/busy state with sensor context |
| get_active_models | Running models with context_length, parameter_count, quantization, tok/s |
| get_observations | 18 patterns with routing_hint per observation + node-level aggregate |
| get_metrics_history | 1-hour rolling telemetry buffer from DuckDB |
| get_model_fit | Three-dimensional fit analysis for the current model: Memory Fit, WES Efficiency, Context Runway, Quant Sweet Spot, and a plain-English summary |

### Resources

| URI | Description |
|-----|-------------|
| wicklee://node/metrics | Live MetricsPayload JSON |
| wicklee://node/thermal | Thermal state + WES penalty values |

### Connect to Claude Desktop

Open the config file in your terminal:

```bash
# macOS
nano "$HOME/Library/Application Support/Claude/claude_desktop_config.json"

# Linux
nano ~/.config/Claude/claude_desktop_config.json

# Windows (PowerShell)
notepad "$env:APPDATA\Claude\claude_desktop_config.json"
```

Add the `wicklee` entry inside `mcpServers` (create the file if it doesn't exist):

```json
{
  "mcpServers": {
    "wicklee": {
      "command": "/opt/homebrew/bin/npx",
      "args": ["-y", "mcp-remote", "http://localhost:7700/mcp"],
      "env": {
        "HOME": "/Users/YOUR_USERNAME",
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
      }
    }
  }
}
```

Requires Node.js. Use `which npx` to find the correct path for your system. Fully quit Claude Desktop (Cmd+Q) and relaunch after editing.

### Connect to Claude Code

```bash
claude mcp add -s user wicklee -- npx -y mcp-remote http://localhost:7700/mcp
```

### Cursor

Open the global config (or use `.cursor/mcp.json` for project-scoped):

```bash
nano ~/.cursor/mcp.json
```

Add the `wicklee` entry (create the file if it doesn't exist):

```json
{
  "mcpServers": {
    "wicklee": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:7700/mcp"]
    }
  }
}
```

If you already have other servers configured, add the `"wicklee"` entry inside the existing `mcpServers` object.

### Windsurf

Open the config:

```bash
nano ~/.codeium/windsurf/mcp_config.json
```

Add the `wicklee` entry (create the file if it doesn't exist):

```json
{
  "mcpServers": {
    "wicklee": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:7700/mcp"]
    }
  }
}
```

All setups require Node.js for the mcp-remote bridge. Restart your IDE after configuration changes.

### Test with curl

```bash
curl -X POST http://localhost:7700/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_node_status"},"id":1}'
```

### Cloud MCP Server (Team+)

Fleet-aggregated MCP at `POST wicklee.dev/mcp`. Clerk JWT auth. 8 tools + 2 resources:

| Tool | Description |
|------|-------------|
| get_fleet_status | All nodes with online status, inference state, WES, tok/s, thermal |
| get_fleet_wes | Compact WES scores for all fleet nodes |
| get_node_detail | Full MetricsPayload for a specific node (requires node_id) |
| get_best_route | Routing recommendation — best node by throughput and efficiency |
| get_fleet_insights | Fleet health summary — online/total, avg WES, fleet tok/s, observation count |
| get_fleet_observations | Active/resolved observations across the fleet (tier-filtered) |
| get_inference_profile | Correlated profiler snapshot for a node (TTFT, KV cache, thermal, power) |
| explain_slowdown | Hardware context for root cause analysis of slow requests |
| get_fleet_model_fit | Memory Fit + WES Efficiency + Quant Recommendation scored for every online fleet node |

**Resources:**

| URI | Description |
|-----|-------------|
| wicklee://fleet/status | Fleet summary: online count, total nodes, avg WES |
| wicklee://fleet/thermal | Per-node thermal states + WES penalty values |

### Using MCP Resources

Resources are read via the `resources/read` method. Unlike tools (which take arguments), resources return a fixed payload for a given URI:

```json
// Request: read a resource
{
  "jsonrpc": "2.0",
  "method": "resources/read",
  "params": { "uri": "wicklee://fleet/status" },
  "id": 1
}

// Response
{
  "jsonrpc": "2.0",
  "result": {
    "contents": [{
      "uri": "wicklee://fleet/status",
      "mimeType": "application/json",
      "text": "{\"online\": 3, \"total\": 5, \"avg_wes\": 8.4}"
    }]
  },
  "id": 1
}
```

Local resources (`wicklee://node/metrics`, `wicklee://node/thermal`) work the same way on `localhost:7700/mcp`. No auth needed.

### Using MCP Tools

Tools are called via the `tools/call` method with a `name` and optional `arguments`:

```json
// Request: call a tool
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "get_best_route",
    "arguments": {}
  },
  "id": 2
}

// Response
{
  "jsonrpc": "2.0",
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"latency\": {\"node\": \"WK-A1B2\", \"tok_s\": 45.2}, \"efficiency\": {\"node\": \"WK-C3D4\", \"wes\": 12.1}, \"default\": \"efficiency\"}"
    }]
  },
  "id": 2
}
```

Tools that require arguments (like `get_node_detail`):

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "get_node_detail",
    "arguments": { "node_id": "WK-A1B2" }
  },
  "id": 3
}
```

---

## Inline Proxy (Ollama)

By default, Wicklee monitors inference using a lightweight synthetic probe (20 tokens every ~30 seconds). The optional inline proxy intercepts real Ollama traffic to provide continuous, production-grade metrics with zero sampling gap.

### What the proxy adds

| Metric | Probe (default) | With Proxy |
|--------|-----------------|------------|
| tok/s | Synthetic baseline (~30s cadence) | Exact from real requests (continuous) |
| TTFT | Cold-start synthetic | Rolling average from production traffic |
| E2E Latency | — | Full request duration (prompt + generation) |
| Request Count | — | Cumulative total since agent start |

### How it works

The proxy binds to `localhost:11434` (Ollama's default port). Ollama is moved to a different port. All requests flow through Wicklee transparently — the proxy extracts timing metrics from done packets and forwards everything unmodified. Your clients (Cursor, Open WebUI, etc.) don't need any configuration changes.

### Setup

**Step 1 — Move Ollama to a different port:**

```bash
# macOS (Ollama desktop app — most common)
launchctl setenv OLLAMA_HOST 127.0.0.1:11435
# Quit Ollama from menu bar, then reopen it.
# Verify: curl -s http://127.0.0.1:11435/api/version

# macOS (Ollama via launchd service — if you have a plist)
# Edit ~/Library/LaunchAgents/com.ollama.startup.plist
# Add EnvironmentVariables with OLLAMA_HOST=127.0.0.1:11435
# Then: launchctl unload / load the plist

# Linux (systemd)
sudo systemctl edit ollama
# Add under [Service]:
#   Environment="OLLAMA_HOST=127.0.0.1:11435"
sudo systemctl restart ollama
```

**Step 2 — Enable the proxy in Wicklee config:**

```bash
# Open the config:
# macOS: sudo nano "/Library/Application Support/Wicklee/config.toml"
# Linux: sudo nano /etc/wicklee/config.toml

# Add at the bottom:
[ollama_proxy]
enabled     = true
ollama_port = 11435   # port where Ollama now listens
```

**Step 3 — Restart the Wicklee agent:**

```bash
curl -fsSL https://wicklee.dev/install.sh | bash
# or manually:
# macOS: sudo launchctl kickstart -k system/dev.wicklee.agent
# Linux: sudo systemctl restart wicklee
```

Verify the proxy is active — your dashboard will show `proxy: :11434 → :11435` in the Diagnostics rail.

### Tier note

The proxy works locally on all tiers (Community included). Proxy-derived metrics (E2E latency, request count, production tok/s) are visible in the fleet dashboard for **Pro tier and above**.

### Runtime coverage

| Runtime | Without proxy | With proxy |
|---------|--------------|------------|
| **Ollama** | Synthetic probe (30s cadence); `/api/ps` for inference detection | Exact continuous tok/s, TTFT, E2E latency, request count — attributed per model |
| **vLLM** | Live aggregate throughput from Prometheus `/metrics` (exact, no proxy needed for single-model) | Per-model tok/s in multi-model deployments — see below |
| **llama.cpp** | Synthetic probe | Not yet supported |

**Ollama** is where the proxy has the most impact. Ollama doesn't expose request-level timing or per-model throughput natively — the proxy is the only way to get exact, continuous metrics without the 30-second sampling gap.

**vLLM** already exposes aggregate throughput and TTFT histograms via its `/metrics` Prometheus endpoint, so a proxy isn't needed for accurate single-model monitoring. However, if you run multiple models on a single vLLM instance, the Prometheus endpoint reports server-wide aggregate throughput — it doesn't break down tok/s by model. A proxy in front of vLLM reads the `"model"` field from each `/v1/chat/completions` request body and attributes throughput, TTFT, and request counts per model, enabling per-model WES scores and accurate Model Fit efficiency data. Without the proxy, multi-model vLLM nodes show `—` for per-model efficiency.

---

## OpenTelemetry & Prometheus

**Team tier required.**

### OpenTelemetry Export

Cloud backend pushes OTLP JSON metrics to any OpenTelemetry-compatible collector. Configure in Settings.

8 gauges per node: `wicklee.gpu.utilization`, `wicklee.power.watts`, `wicklee.inference.tokens_per_second`, `wicklee.wes.score`, `wicklee.thermal.penalty`, `wicklee.memory.pressure`, `wicklee.inference.ttft_ms`, `wicklee.inference.state`

Resource attributes: `node.id`, `node.hostname`, `node.gpu.name`, `node.os`, `node.arch`

### Prometheus

```bash
curl -H "X-API-Key: wk_live_..." https://wicklee.dev/metrics
```

Returns standard Prometheus text format with 7 gauges per node, labeled by `node_id` and `hostname`.

---

## Configuration

Wicklee is zero-config by default. Optional settings:

**Config file:** `/Library/Application Support/Wicklee/config.toml` (macOS) or `/etc/wicklee/config.toml` (Linux)

| Setting | Default | Description |
|---------|---------|-------------|
| node_id | Auto-generated (WK-XXXX) | Stable node identifier |
| fleet_url | None | Cloud fleet URL (set by pairing) |
| bind_address | 127.0.0.1 | Set to 0.0.0.0 for LAN access |
| ollama_proxy.enabled | false | Enable [inline proxy](#inline-proxy-ollama) on :11434 |

---

## Sovereignty

Wicklee is sovereign by default:
- The agent runs entirely on your machine
- Nothing leaves until you explicitly pair with a fleet
- No outbound connections by default — structural guarantee
- Local dashboard at localhost:7700 works with zero configuration

---

## Platform Support

| Platform | GPU | Power | Thermal |
|----------|-----|-------|---------|
| macOS (Apple Silicon) | ioreg (sudoless) | powermetrics (root) | pmset/sysctl |
| macOS (Intel) | — | powermetrics (root) | pmset/sysctl |
| Linux (NVIDIA) | NVML (sudoless) | NVML | coretemp/clock_ratio |
| Linux (CPU only) | — | RAPL powercap | coretemp/cpufreq |
| Windows | NVML | NVML | WMI |

### Runtimes Detected

- Ollama (macOS, Linux, Windows)
- vLLM (Linux)
- llama.cpp / llama-box (macOS, Linux)

---

## Pricing

| | Community | Pro | Team | Business | Enterprise |
|---|---|---|---|---|---|
| Price | Free | $29/mo | $49/seat/mo | $499/mo | Contact Sales |
| Nodes | 3 | 10 | 25 (+$2/node over) | 100 (unlimited seats) | Unlimited |
| History | 24h | 7 days | 90 days | 365 days | Custom |
| Patterns | 9 | 18 | 18 | 18 | 18 |
| Local MCP | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cloud MCP | — | — | ✅ | ✅ | ✅ |
| OTel + Prometheus | — | — | ✅ | ✅ | ✅ |
| SSO / SAML | — | — | — | ✅ | ✅ |
| Audit Logging | — | — | — | ✅ | ✅ |
| Alerts | — | Slack, Email | + PagerDuty | + PagerDuty | All + SIEM |

---

*Full API schema: [openapi.json](https://wicklee.dev/openapi.json) · AI discovery: [llms.txt](https://wicklee.dev/llms.txt)*
