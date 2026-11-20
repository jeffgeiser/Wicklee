# Wicklee Documentation

> The evidence layer for self-hosted AI inference.
> One Rust binary per host, reached over localhost. It answers what is happening with your local inference, what will run right now, and what to change and how to verify it helped.
> There are no paid plans and no account.

---

## Quick Start

```bash
# macOS & Linux — installs to ~/.wicklee/bin/wicklee, no sudo
curl -fsSL https://wicklee.dev/install.sh | bash

# Run on every boot (the only sudo step)
sudo ~/.wicklee/bin/wicklee --install-service

# Windows (PowerShell as Administrator)
irm https://wicklee.dev/install.ps1 | iex
```

Dashboard opens at **http://localhost:7700**. The `--install-service` step copies the binary to `/usr/local/bin/wicklee` and registers the LaunchDaemon (macOS) / systemd unit (Linux). Skip it if you only want to try the agent in the foreground (`~/.wicklee/bin/wicklee`).

## CLI Reference

**Diagnostics.** Five subcommands over the `/v1` routes of a running agent.
Add `--json` to any of them for the route's body verbatim.

| Command | Description |
|---------|-------------|
| `wicklee inspect [--since 24h]` | Findings, readiness and what to change, in one report |
| `wicklee ready [MODEL]` | Readiness only: `ready_now`, `requires_loading`, `would_displace` or `cannot_determine` |
| `wicklee findings [--all]` | Findings alone; `--all` includes resolved ones |
| `wicklee fingerprint MODEL [--cold]` | A consented measurement run that establishes a baseline |
| `wicklee verify FINDING_ID` | Re-run a finding's own test and compare against the first run |

**Service and status.**

| Command | Description |
|---------|-------------|
| `sudo wicklee --install-service` | Install as system service (auto-start on boot) |
| `sudo wicklee --uninstall-service` | Remove service |
| `wicklee --status` | Health check (queries running agent) |
| `wicklee --version` | Print version |

`PORT`, `WICKLEE_OLLAMA_PORT` and `WICKLEE_DATA_DIR` move the listener, the
runtime it talks to and the metrics store, which is how you run a second agent
without disturbing an installed one.

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

All the WES surfaces — KPI hero (Intelligence), Model Fit Analysis (Insights → Performance), Summary Strip — read from a shared module-level smoothing buffer (`src/utils/sharedSmoothing.ts`, 4-sample moving average). Same node, same metric, identical value across every tab.

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

The `bandwidth_ceiling_reached` pattern (#19) detects this case explicitly and fires an *info*-severity observation explaining *"you're at the physics ceiling for this hardware/quant pair."* The Model Fit Analysis fleet headline reflects the same nuance: low efficiency rows are tagged "informational" rather than "needs attention" — the latter is reserved for genuine memory risk (OOM / swap pressure).

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

### Quantization Advisor

The Quantization Advisor is delivered by the composition of two features. **Quant Sweet Spot** projects the speed and memory delta of moving up or down a quant level; **Perplexity Tax** quantifies the empirical quality cost. Together they answer the three-axis tradeoff:

> *"Q6_K fits in headroom (+1.4 GB) at +0.10% PPL — near-lossless. ~13 tok/s (–31% speed)."*

You'll see this combined recommendation in the Quant Sweet Spot tile on the Model Fit Summary Strip (Intelligence) and the Model Fit Analysis card (Insights → Performance).

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

Single source of truth: `public/perplexity_baseline.json`. The dashboard fetches this file as a static asset. Bands keyed off KLD:

| KLD | Band | Meaning |
|---|---|---|
| < 0.001 | Imperceptible | Empirically indistinguishable from FP16 in blind A/B tests |
| 0.001–0.01 | Mild | Small but measurable quality cost |
| 0.01–0.05 | Noticeable | Acceptable for many tasks; inspect output if quality matters |
| 0.05–0.15 | Severe | Substantial quality cost — coherence issues likely |
| > 0.15 | Unusable | Empirically unreliable for production |

The Quant Sweet Spot recommender reads from this baseline, falling back to the legacy hand-tuned heuristic only when no entry exists. Curated coverage: Llama 3.1/3.2 (1B-70B), Qwen 2.5 (7B-72B), Mistral 7B, Mixtral 8x7B, Gemma 2 (9B-27B), Phi-3 Mini, DeepSeek-R1 distills.

**Source:** `public/perplexity_baseline.json` · `src/utils/perplexity.ts`

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
| Q2 | ~3.2 (K-quant mixed) | 20% | `Q2_K`, `Q2_K_L` |
| IQ2 | ~2.7 | 17% | `IQ2_XXS`, `IQ2_XS`, `IQ2_M` |
| Q3 / IQ3 | ~3 | 22% | `Q3_K_S`, `Q3_K_M`, `Q3_K_L`, `IQ3_XXS`, `IQ3_XS`, `IQ3_M` |
| Q4 | ~4.85 (K-quant mixed) | 30% | `Q4_0`, `Q4_K_S`, `Q4_K_M` |
| IQ4 | ~4.5 | 28% | `IQ4_XS`, `IQ4_NL` |
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
2. **Parameter-count × bytes-per-weight from the model name** (±10–20%) — the common path for vLLM and llama.cpp. Recognises `Llama-3.1-8B`, `qwen2.5-32b-FP8`, `Mixtral-8x7B-AWQ`, etc. When the quant tag can't be parsed, vLLM/llama.cpp names default to FP16/BF16 (vLLM's default dtype); Ollama names default to Q4_K_M (Ollama's default quant for un-tagged pulls).
3. **`nvidia_vram_used_mb` proxy** — last resort. Inflated on vLLM (KV cache reservation), but better than nothing for un-parseable models. When this path is taken, the working-set overhead below is *not* added on top — the measurement already includes it.
4. **50 % of used system RAM** — CPU-only llama.cpp.

For vLLM, the Memory Fit headroom uses `model_size + 30 %` (512 MB minimum) as the "used" baseline rather than `nvidia_vram_used_mb` — answering *"does my model fit with room for context?"* not *"how much has the engine pre-allocated?"*. The 30 % working-set figure matches the agent's `estimate_vram_mb()`: KV cache at a typical 8K context (~15 %), activation buffers (~5 %), framework overhead (~10 %). llama.cpp does not eagerly reserve VRAM, so its measured `nvidia_vram_used_mb` is used directly.

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
3. **Ollama probe** — synthetic 20-token baseline (at most every 10 min, only against an already-loaded model)

---

## Multi-Model Monitoring

Most inference deployments run multiple models concurrently. Wicklee always detects all loaded models and their VRAM — per-model throughput attribution depends on the runtime and whether the proxy is enabled.

**Where things live in the dashboard** — the three main tabs split by axis, not by feature:

| Tab | Axis | Answers |
|-----|------|---------|
| **Intelligence** | now | Live tiles and live hardware — what is this machine doing this second? |
| **Models** | the model | What's loaded (all runtimes), what each model ran and cost (comparison, swap activity), what could you add (discovery). |
| **Insights → Performance** | efficiency & money over time | Model fit, WES trends, the inference profiler and SLA monitor. |

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

**Context-length picker (Discovery v2):** 2K / 4K / 8K (default) / 16K / 32K / 128K. Each variant's VRAM requirement and fit score re-calculate when changed, using architecture-aware KV cache estimates per parameter class. Lets you compare "this model at 8K context" vs "this model at 32K" without leaving the page.

**Quant quality tooltips + sweet-spot badge (Discovery v2):** every quant label hovers a quality tooltip from the QUANT_QUALITY map (e.g. *"Q4_K_M: ~97% quality. Standard sweet spot for most models."*). The sweet-spot quant for each model family carries a `[Rec]` badge so newcomers don't end up downloading Q8 by accident.

### Tok/s Projection Methodology

Every Discovery row carries a projected tok/s number. There is no empty state — even on a fresh node with zero telemetry, the value renders from a four-tier fallback stack. The tooltip on each row tells you which tier produced its number.

**The physics.** LLM inference at batch=1 is memory-bandwidth-bound. To generate one token, the engine must stream every weight from VRAM through the GPU once. So the theoretical ceiling is:

```
max_tps ≈ memory_bandwidth_GB_s / model_size_GB
```

Real-world tok/s lands at ~30–45% of that ceiling because of activation memory traffic, KV cache reads, framework overhead, and sub-optimal kernel scheduling for single-stream GGUF inference. Wicklee uses **0.40** as a conservative efficiency factor — the middle of the observed range.

**Four-tier fallback (first tier that produces a number wins):**

| Tier | When it fires | Range | Source |
|---|---|---|---|
| 1 · `cohort` | ≥2 historical models within ±40% of the candidate's file size and same quant family | empirical min/max | your telemetry |
| 2 · `sample` | 1 historical model within ±40% of candidate size | point estimate ±10% | your telemetry |
| 3 · `bandwidth` | Any historical observation, any size class | `baseline_tps × (baseline_size / candidate_size)` ±15% | scaled from your telemetry |
| 4 · `theoretical` | Always available when the chip is in the lookup table | `bandwidth × 0.40 / size` ±0%/+0% | chip spec sheet |

The Phase 3 `theoretical` tier is the day-one answer — it kicks in when no telemetry exists yet. It uses the chip's published memory bandwidth from a lookup covering every Apple M1/M2/M3/M4 variant (M1: 68–800 GB/s, M4 Pro: 273 GB/s, M2 Ultra: 800 GB/s) and NVIDIA H100/H200/A100/L40/L4/A40, RTX 30/40/50 consumer cards, and RTX A-series workstation cards.

Theoretical rows render in italicized gray and the tooltip carries an amber accent so the spec-derived origin is unmissable. As telemetry accumulates, candidates near your historical sizes promote to higher-fidelity tiers automatically.

### Cost-per-Million-Tokens Methodology

Cost is only displayed when the user has explicitly set their `$/kWh` rate in **Settings** (a non-default value, persisted to localStorage). Showing a confident dollar number based on the system default would be misleading.

Formula:

```
cost_per_M = avg_watts × $/kWh ÷ (3600 × tok_s) × 1M
```

- `avg_watts` — this machine's measured average power draw during inference, computed from telemetry. Without telemetry there is no cost projection (the watts term has no value).
- `$/kWh` — your configured power rate.
- `tok_s` — same projection used for the speed column, including theoretical fallback.

Cost-per-M is highly correlated with tok/s on the same hardware (watts is roughly constant during inference; the divisor does the work). It's shown for users who care about the dollars framing — the comparison against commercial APIs ($0.50/M Claude Haiku, $3/M GPT-4o) is what makes it independently useful. Users who don't want it can leave the kWh rate unset and the column disappears.

### Why fit and tok/s use different signal sources

A row may show `Excellent fit · ≈45 tok/s (spec estimate)`. That's intentional and honest:

- **Fit** is fully telemetry-driven — VRAM headroom (measured), thermal state (measured), WES history (measured), power-fraction-of-budget (measured). It always reflects your actual hardware.
- **Tok/s** uses telemetry when available and falls back to the chip's bandwidth spec when not. The tier label in the hover tooltip tells you which.

Both numbers are accurate; they just come from different places. The page-level Discovery banner that used to over-claim "uses telemetry from N models you've run" was removed — per-row hovers now carry that information per-row at the right granularity.

### Search behavior

- **No search term:** returns cached top-20 GGUF repos by HuggingFace downloads (24h TTL). Works offline after first cache fill.
- **With search term:** queries HuggingFace live — real search, not just filtering cached results. Scored in real time against your hardware.

### Ollama pull command

Every variant in the response includes a ready-to-run pull command:
```
"pull_cmd": "ollama pull hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M"
```
The Model Discovery panel shows a copy button; the raw command is also in the API response.

### Where discovery runs

| Scope | Feature | Endpoint |
|------|---------|----------|
| This machine | Local discovery — scored against this machine | `GET /api/model-candidates` |

Available simulation profiles: `m4`, `m4_pro_24gb`, `m4_max_36gb`, `m4_max_64gb`, `m4_ultra_128gb`, `nvidia_4060`, `nvidia_4070`, `nvidia_4080`, `nvidia_4090`, `nvidia_a100_40gb`, `nvidia_a100_80gb`, `nvidia_h100`

---

## Where Model Fit Analysis Lives

The full **Model Fit Analysis** card is on the **Insights → Performance** tab — that's the canonical home, alongside the Inference Profiler, SLA Monitor, and Model Discovery surfaces it composes with for active investigation.

The **Intelligence** tab shows a 3-tile **Model Fit Summary Strip** (Model Fit · Quant Sweet Spot · Context Runway) directly under the KPI hero row. Each tile is a click-through that cross-tabs to Insights → Performance and scroll-locks to the full analysis.

### "Needs attention" semantics

The headline at the top of the Model Fit Analysis card distinguishes two failure modes deliberately:

- **Needs attention** (red) — memory-poor only. Real OOM / swap risk. Action required.
- **Fair** (amber) — model fits but warrants a check (memory-fair OR efficiency-acceptable).
- **Optimal** (green) — both dimensions clean.
- **Low efficiency (informational)** (gray pill) — WES is low *but memory is fine*. Common on big-iron GPUs running batch=1 small workloads where idle baseline power dominates per-token energy cost. Not a fix-now signal — see the [`bandwidth_ceiling_reached`](#20-observation-patterns--5-fleet-alerts) pattern, which fires when a node is at the physics ceiling for its hardware/quant pair.

### MCP

`get_model_fit` is retired: use `wicklee_readiness` (same JSON as `GET /v1/readiness`). It still answers, with `-32601` and the name of its replacement.

---

## Hardware Observation Patterns

### 18 patterns, 10-min DuckDB buffer, evaluated every 10s

All eighteen are evaluated on every host; there is no gating.

**Nine:** `thermal_drain`, `phantom_load`, `wes_velocity_drop`, `memory_trajectory`, `power_jitter`, `swap_io_pressure`, `clock_drift`, `pcie_lane_degradation`, `vram_overcommit`

**Nine more:** `power_gpu_decoupling`, `bandwidth_saturation`, `efficiency_drag`, `nvidia_thermal_redline`, `vllm_kv_cache_saturation`, `ttft_regression`, `latency_spike`, `vllm_queue_saturation`, `bandwidth_ceiling_reached`

> **`pcie_lane_degradation`** — fires when the negotiated PCIe link width (e.g. x8) is below the card's rated maximum (e.g. x16), indicating a wrong-slot installation or failed lane. Detected via NVML `current_pcie_link_width` / `max_pcie_link_width` — **NVIDIA only, no root required**. Returns no data on virtualised GPUs (cloud instances, VMs) where PCIe info is unavailable.

> **`bandwidth_ceiling_reached`** *(severity: info)* — fires when a node sustains ≥65 % of its theoretical memory-bandwidth ceiling for the loaded model + quant, GPU utilisation is below 95 %, and the node has been live for ≥5 min. This explains a "Low" tok/W reading as **physics, not pathology**: at batch=1, fixed GPU baseline power dominates and per-token efficiency cannot improve without changing quant or batch size. Detected via `parameter_count × bytes_per_weight ÷ memory_bandwidth_gbps` per a per-chip lookup table (Apple M-series, NVIDIA H100/H200/A100/RTX, DGX Spark/GB10). The node is healthy — recommendation is informational: switch to a smaller GGUF quant for ~2× tok/s, or raise concurrent batch size to amortise baseline power.

---

## Deployment Profiles

A single intent selector that coherently shifts how sensitively a node's local observation patterns fire — instead of exposing a knob per pattern. Set it in Settings → Deployment Profile on the localhost dashboard; the agent applies it within ~10 seconds and persists it to `config.toml` (`deployment_profile`). Node-local: it governs which observations *this node* raises, not fleet-wide alert rules.

| Profile | Intent | Evidence window | Sustained gate | Confidence floor |
|---------|--------|-----------------|----------------|------------------|
| **Sovereign Dev** | Laptop/workstation running inference alongside other work — high bar so mixed-use noise stays quiet | ×1.15 (more) | 0.85 | 0.50 |
| **Dedicated Server** *(default)* | Single-purpose inference node — the baseline patterns were tuned for | ×1.00 | 0.70 | none |
| **Production Fleet** | Serving real users where latency matters — aggressive early warning | ×0.65 (less) | 0.55 | none |

The three levers move together: `density_scale` multiplies the evidence-window density every pattern derives from, `evidence_ratio` is the sustained-fraction gate a ratio-gated pattern must clear, and `min_confidence` drops low-confidence observations before they surface. `dedicated_server` reproduces the original pre-profile behavior exactly.

**API (localhost, no auth):** `GET /api/deployment-profile` returns the active profile plus the selectable set with each one's tuning; `PUT /api/deployment-profile` with `{ "profile": "sovereign_dev" | "dedicated_server" | "production_fleet" }` switches it.

## Deep Intelligence

Wicklee uniquely has hardware telemetry, inference metrics, model identity, and per-request traces in the same DuckDB database. These endpoints leverage that combination:

### Inference Profiler
`GET /api/profile?minutes=60` — correlated timeline of TTFT, tok/s, KV cache %, queue depth, thermal penalty, and power on a single time axis. Resolution auto-scales (1s raw at 10min, 60s buckets at 24h).

### Inference SLA Monitor
`GET /api/sla?window_min=60&target_ttft_ms=500&model=` — p50/p95/p99/max for TTFT, end-to-end latency, and TPOT computed via DuckDB `quantile_cont()` over the per-request `inference_traces` table. Compliance percentage against a configurable TTFT target, the 20 most-recent violations, and per-model breakdown. Window: 1–1440 minutes (24 h hard ceiling — that's the trace retention). Optional `model` filter narrows percentiles to one model.

Surfaced on the Performance tab as an SLA Monitor card with 1h / 6h / 24h windows, 250 ms / 500 ms / 1 s / 2 s target presets, color-coded compliance pill (≥99% emerald, ≥95% green, ≥90% yellow, <90% red), per-model p95 table, and a recent-violations list.

### Cost Attribution Per Model
`GET /api/cost-by-model?hours=24` — per-model daily cost breakdown: model name, hours active, avg watts, cost USD. Uses power draw × model identity from DuckDB.

### "Why Was That Slow?" Explainer
`GET /api/explain-slowdown?ts_ms=N` — root cause analysis. Finds closest inference trace, reads ±30s hardware context, evaluates 6 factors (KV cache, thermal, queue, swap, memory, clock throttle), ranks by severity, generates natural-language summary.

### Model Comparison
`GET /api/model-comparison?hours=168` — side-by-side efficiency data for every model that has run on this node. Shows WES, tok/s, watts, TTFT, cost/hr. Answers "which model is most efficient on my hardware?" with real measured data.


### Runtime Config Surface (v0.9.0)
`GET /api/runtime-config?model=<name>` — returns the cached launch-time configuration for a model across all three supported runtimes:

- **Ollama** — parsed from `POST /api/show` whenever the active model changes. Captures `context_length`, `parameter_count`, `quantization`, plus the prompt `template` and `system_prompt`.
- **vLLM** — a 5-minute poller first tries `GET /v1/server_info` (vLLM 0.5.0+), then falls back to parsing `ps aux` for the vLLM process command line. Captures `process_args` and best-effort common fields.
- **llama.cpp / llama-server** — same pattern: `GET /props` first, then `ps aux` fallback.

The full payload is fetched on demand to keep the 1 Hz SSE stream small — `MetricsPayload.runtime_config_available: bool` flips to true once the cache has any entry, so the frontend knows whether to render the "Config" affordance.

**Privacy:** templates and system prompts can carry proprietary content. They live in the agent's local cache and are served only by this localhost endpoint. Nothing leaves the machine.

**Response codes:** 200 with the JSON `RuntimeConfig`, 400 when `?model=` is missing, 404 when no config has been cached yet (cold start or a model that's never been loaded).

**Frontend surfaces:** a "Config" pill in the Diagnostics rail (single-model nodes) plus a per-row link in the Active Models panel (multi-model nodes). Both open the same `RuntimeConfigModal` — Esc / backdrop / X to close, Copy-as-Markdown button.

### Models Tab
The dashboard now has a top-level **Models** tab (between Intelligence and Insights — `DashboardTab.MODELS`). Three sections:

- **Loaded** — what's resident in memory right now. Columns: Node, Model, Quant, Memory (VRAM if available, RAM with `size_gb` fallback), Status (Active ● = currently inferring vs Idle ○ = loaded but not active). This is a *model-state* view — for inference-state telemetry (live / idle-spd / busy / idle) see the Intelligence tab.
- **Browse** — HuggingFace GGUF catalog discovery, scored against your actual hardware (details in [Model Discovery & Hardware Fit](#model-discovery--hardware-fit) below).
- **Past activity** — collapsible footer with the model comparison (`/api/model-comparison`) and swap activity (`/api/model-switches`).

The page header reads *"What's loaded on this machine, and what could you add. Inference performance lives on the Intelligence tab."*

---

## Event Feeds

Wicklee has two distinct event surfaces that serve different purposes:

| | Live Activity | Recent Activity |
|---|---|---|
| **Location** | Intelligence page (scrollable feed) | Insights → Triage |
| **Data source** | Live events from the agent's SSE stream | Alert quartet latch system |
| **What it shows** | Connectivity, thermal transitions, model swaps, power anomalies, observation onset/resolved | Alert card lifecycle — when alerts fired and resolved, with duration |
| **Trigger** | Immediate — fires on every state transition | Delayed — fires after 15-second onset gate |
| **Persistence** | Current session only | sessionStorage — survives page refresh |
| **Purpose** | Real-time operational awareness | Post-incident review |

The event timeline on the Observability tab is a third, separate surface — it shows persisted events from the local DuckDB store with 30-day retention. This is the permanent audit record.

---

## Localhost API

Base URL: `http://localhost:7700`
Auth: none on a loopback bind. A non-loopback `bind_address` refuses to start
without an inbound token, and the refusal names the key to set.

### `/v1` — what is loaded, what can run, what is wrong

Every statement these return carries the evidence behind it and a label saying
what kind of claim it is: `observed` (Wicklee saw it), `inferred` (a likely
cause, always hedged) or `verified` (measured, with a range). Where something
could not be checked they say so, instead of returning an empty result that
reads like a clean bill of health.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /v1/state | Every installed model: residency, the context it is running at, measured footprint, whether any of it sits outside accelerator memory, when a real caller last used it, plus a capability record of which fields this runtime actually returns |
| GET | /v1/readiness?model=X | `ready_now`, `requires_loading`, `would_displace` or `cannot_determine` per model, with headroom and what the answer rests on. `requires_loading` plus `coexistence: "unverified"` fits by accounting only — measurement has shown that is not the same as safe |
| GET | /v1/inspect?since=24h | Findings, readiness and what was not checked. Nine rules plus the nineteen hardware patterns through one evidence-labelled view |
| GET | /v1/findings?all=true | The findings alone. Resolution is observed, not scheduled: a finding resolves because an evaluation ran and did not produce it |
| GET | /v1/receipts?model=X | Stored per-request measurements with a median and range |
| POST | /v1/receipts | Hand back your runtime's own final-response metadata as a receipt. **Refuses any payload containing `prompt`, `response`, `messages` or `context` with a 400 naming the field** — metadata only |
| POST | /v1/fingerprint | A consented test run: warm, cold or a sequence. Fixed prompt, temperature zero, fixed seed, always passing the model's running `num_ctx`. No `"consent": true`, no run |
| POST | /v1/verify | Re-runs a finding's test and compares: medians, ranges, what differed, and one of `improved`, `worse` or `no measurable change`. A verdict needs non-overlapping ranges, three receipts a side and a 5% difference in the medians |

### Telemetry and history

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/metrics | SSE stream — 1 Hz telemetry |
| GET | /ws | WebSocket — 1 Hz telemetry (same payload as SSE, fallback transport) |
| GET | /api/observations | 18 observation patterns with per-observation `routing_hint` (steer_away/reduce_batch/monitor) + node-level `routing_hint` + `routing_hint_source` |
| GET | /api/profile?minutes=60 | Inference Profiler — correlated TTFT/KV/queue/thermal/power timeline |
| GET | /api/sla?window_min=60&target_ttft_ms=500 | Inference SLA Monitor — p50/p95/p99 for TTFT/E2E/TPOT, compliance vs target, per-model breakdown, recent violations |
| GET | /api/cost-by-model?hours=24 | Cost attribution per model — daily power cost breakdown |
| GET | /api/explain-slowdown?ts_ms=N | Root cause analysis for slow inference requests |
| GET | /api/model-comparison?hours=168 | Model comparison — side-by-side efficiency for all models |
| GET | /api/model-switches?hours=24 | Model swap frequency + idle gap per transition |
| GET | /api/model-candidates?search=llama | Discovery — HuggingFace GGUF catalog scored against local hardware |
| GET | /api/runtime-config?model=X | Runtime Config Surface (v0.9.0) — cached launch-time config for the named model |
| GET | /api/history?node_id=WK-XXXX | Metric history — 1h raw samples |
| GET | /api/traces | Proxy inference traces |
| GET | /api/events/history | Node event log |
| GET | /api/events/recent | Recent in-memory events |
| GET | /api/export?format=json\|csv | Data export |
| GET | /api/tags | Ollama model tags |
| POST | /mcp | MCP JSON-RPC 2.0 endpoint |
| GET | /.well-known/mcp.json | MCP server manifest |

**Tip:** Discover your node ID with `curl -s http://localhost:7700/api/health | jq .node_id` — use it for the `/api/history` endpoint:

```bash
NODE_ID=$(curl -s http://localhost:7700/api/health | jq -r .node_id)
curl "http://localhost:7700/api/history?node_id=$NODE_ID" | jq '.samples | length'
```

---

## MCP Server

The agent exposes a local MCP (Model Context Protocol) server for AI agents. Localhost only, no auth.

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

### Using MCP Resources

Resources are read via the `resources/read` method. Unlike tools (which take arguments), resources return a fixed payload for a given URI. The agent serves `wicklee://node/metrics` and `wicklee://node/thermal` on `localhost:7700/mcp`. No auth needed on a loopback bind.

```json
{
  "jsonrpc": "2.0",
  "method": "resources/read",
  "params": { "uri": "wicklee://node/thermal" },
  "id": 1
}
```

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

By default, Wicklee measures a baseline with a lightweight synthetic probe (20 tokens, at most every 10 minutes, only against a model that is already loaded — it never loads one). The optional inline proxy intercepts real Ollama traffic to provide continuous, production-grade metrics with zero sampling gap.

### What the proxy adds

| Metric | Probe (default) | With Proxy |
|--------|-----------------|------------|
| tok/s | Synthetic baseline (≤ every 10 min) | Exact from real requests (continuous) |
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
# macOS
sudo launchctl kickstart -k system/dev.wicklee.agent

# Linux
sudo systemctl restart wicklee
```

Verify the proxy is active — your dashboard will show `proxy: :11434 → :11435` in the Diagnostics rail.

### Where the proxy's numbers show up

The proxy works locally on any install, and its metrics (E2E latency, request
count, production tok/s) are on the local dashboard and in the telemetry a
the agent records. `POST /v1/receipts` is the other way to get exact
per-request numbers without a proxy, and on a default macOS install it is the
only one that works, because the proxy cannot bind 11434 while Ollama holds
it.

### Runtime coverage

| Runtime | Without proxy | With proxy |
|---------|--------------|------------|
| **Ollama** | Synthetic probe (≤ every 10 min); `/api/ps` for inference detection | Exact continuous tok/s, TTFT, E2E latency, request count — attributed per model |
| **vLLM** | Live aggregate throughput from Prometheus `/metrics` (exact, no proxy needed for single-model) | Per-model tok/s in multi-model deployments — see below |
| **llama.cpp** | Synthetic probe | Not yet supported |

**Ollama** is where the proxy has the most impact. Ollama doesn't expose request-level timing or per-model throughput natively — the proxy is the only way to get exact, continuous metrics without the gaps between synthetic probes.

**vLLM** already exposes aggregate throughput and TTFT histograms via its `/metrics` Prometheus endpoint, so a proxy isn't needed for accurate single-model monitoring. However, if you run multiple models on a single vLLM instance, the Prometheus endpoint reports server-wide aggregate throughput — it doesn't break down tok/s by model. A proxy in front of vLLM reads the `"model"` field from each `/v1/chat/completions` request body and attributes throughput, TTFT, and request counts per model, enabling per-model WES scores and accurate Model Fit efficiency data. Without the proxy, multi-model vLLM nodes show `—` for per-model efficiency.

---

## Configuration

Wicklee is zero-config by default. Optional settings:

**Config file:** `/Library/Application Support/Wicklee/config.toml` (macOS) or `/etc/wicklee/config.toml` (Linux)

**Synthetic probe.** When no proxy is active, the agent measures a baseline tok/s by sending a 20-token request to a model that is *already loaded* (it never loads one), at most every `interval_minutes`. Turn it off entirely with:

```toml
[probe]
enabled = false          # default true
interval_minutes = 10    # default 10, minimum 1
```

| Setting | Default | Description |
|---------|---------|-------------|
| node_id | Auto-generated (WK-XXXX) | Stable node identifier |
| bind_address | 127.0.0.1 | Set to 0.0.0.0 for LAN access |
| ollama_proxy.enabled | false | Enable [inline proxy](#inline-proxy-ollama) on :11434 |

---

## Sovereignty

Wicklee is sovereign by default:
- The agent runs entirely on your machine
- Nothing leaves the machine: there is no fleet, no account and no cloud
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

## Licensing

- Agent and local dashboard (`agent/`, the `localhost:7700` UI, metric calculations including WES): open source, Apache 2.0.
- Website source (`src/site/`): source-available, FSL-1.1-Apache-2.0 — free to read, run and modify except to offer a competing product; each release converts to Apache 2.0 after four years.
- "Wicklee" and the logo are trademarks, not covered by either licence.
- Map: https://github.com/jeffgeiser/Wicklee/blob/main/LICENSING.md

## Pricing

There are no paid plans and no account. The agent is open source under Apache 2.0.

---

*Full API schema: [openapi.json](https://wicklee.dev/openapi.json) · AI discovery: [llms.txt](https://wicklee.dev/llms.txt)*
