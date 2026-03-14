# Wicklee Metrics Reference

> Every metric Wicklee surfaces — what it means, how it's calculated, what to do about it.

---

## How Wicklee Works: Synchronous Observation

Wicklee is a sovereign Rust binary that observes your inference fleet without ever touching your private data. Unlike standard scrapers that pull static counters, Wicklee performs Synchronous Observation by merging two high-fidelity telemetry streams:

- **Hardware Harvester (10 Hz):** The agent queries your kernel and GPU drivers (NVML / IOReg / RAPL) at high frequency to capture micro-spikes in power, thermals, and utilization that 1-minute Prometheus scrapes miss.

- **Performance Probe (30 s):** Every 30 seconds, the agent fires a 20-token generation request to your local inference API to measure real-time throughput without intercepting actual user traffic. The probe is skipped when GPU utilization is ≥ 40% — at that point the scheduler is already under load and a probe reading would be depressed. Throughput estimation covers the gap (see below).

- **Local Interpretation:** By owning both hardware physics and runtime context, Wicklee triggers Conditional Insights — identifying "invisible" states like a Power Anomaly (high wattage vs. low GPU utilization) or Thermal Degradation (temperature spikes causing silent throughput drops).

- **Zero-Intercept Privacy:** Wicklee does not act as a proxy. It never sees your prompts or model responses — it only measures the hardware "effort" required to produce them, ensuring your data remains entirely within your sovereign boundary.

---

## Visual Indicators at a Glance

Every colored dot, badge, and bar in the dashboard — explained in one place.

---

### Node Status Dot (NODE column)

| Appearance | Meaning | Logic |
|------------|---------|-------|
| Animated green ping + solid green fill | **Online** | Last telemetry received within 60 seconds |
| Gray outlined circle, no fill | **Offline** | No telemetry for > 60 seconds |
| Solid gray dot | **Pending** | Paired but no telemetry received yet |

A node is considered online if `Date.now() − lastSeen ≤ 60,000 ms`. Rolling-buffer smoothing is paused and cleared when a node goes offline.

---

### Model Fit Dot (MODEL column)

The small colored dot next to the loaded model name answers: *"Is this hardware well-matched for this model?"*

| Color | Score | When it appears |
|-------|-------|-----------------|
| 🟢 Green | **Good** | Model fits in available memory with **>20% headroom** AND thermal is Normal |
| 🟡 Amber | **Fair** | Model fits, but headroom is **10–20%** OR thermal is Fair |
| 🔴 Red | **Poor** | Model **exceeds** available memory, headroom **<10%**, OR thermal is Serious/Critical |

The dot only appears when Ollama is running with a model loaded. **Hover over it** for the exact reason (e.g. *"Model fits with 34% memory headroom · Normal thermal"* or *"Model size (13.0 GB) exceeds available memory (8.1 GB free)"*).

**Memory source:** NVIDIA nodes use dedicated VRAM (`nvidia_vram_total_mb`). Apple Silicon and CPU-only nodes use system RAM (`total_memory_mb − available_memory_mb`). The headroom percentage is free memory as a fraction of total capacity.

**Scoring priority (Poor → Fair → Good):**
1. **Poor** if: model doesn't fit in free memory, OR headroom < 10%, OR thermal is Serious/Critical
2. **Fair** if: model fits AND (headroom 10–20% OR thermal is Fair)
3. **Good** if: model fits AND headroom > 20% AND thermal is Normal (or unavailable)

*Source: `src/utils/modelFit.ts` → `computeModelFitScore()`*

---

### TOK/S Badges

| Badge | Color | Condition | Meaning |
|-------|-------|-----------|---------|
| **LIVE** | Green | `ollama_inference_active = true` OR `vllm_tokens_per_sec > 0` | Inference in progress |
| **IDLE-SPD** | Muted gray | `inference_active = false` AND GPU% < 15% | Probe ran at idle — hardware capability baseline |
| **BUSY** | Amber | `inference_active = false` AND GPU% ≥ 50% | GPU occupied by non-Ollama workload |

Ollama LIVE values are prefixed with `~` (estimated). vLLM LIVE values are exact. See **Throughput Measurement** for full detail.

---

### WES Color

| Color | Range | Meaning |
|-------|-------|---------|
| 🟢 Green | > 10 | Efficient — Apple Silicon territory |
| 🟡 Amber | 1–10 | Moderate — high-power GPU or mild throttle |
| 🔴 Red | < 1 | Poor — CPU inference or severe thermal throttling |

*Source: `src/utils/wes.ts` → `wesColorClass()`*

---

### Thermal Badges

| Color | State | macOS source | NVIDIA equivalent |
|-------|-------|-------------|-------------------|
| 🟢 Green | Normal | pmset nominal | GPU temp < 70°C |
| 🟡 Yellow | Fair / Elevated | pmset mild throttle | 70–83°C |
| 🟠 Orange | Serious / High | pmset active throttle | 83–90°C |
| 🔴 Red | Critical | pmset severe | ≥ 90°C |

For NVIDIA nodes without a native macOS `thermal_state`, temperature is inferred from `nvidia_gpu_temp_c`. *Source: `src/components/NodeHardwarePanel.tsx` → `derivedNvidiaThermal()`*

---

### Memory and VRAM Bars

| Bar color | Utilization | Meaning |
|-----------|-------------|---------|
| 🟢 Green | < 70% | Comfortable headroom |
| 🟡 Amber | 70–90% | Monitor — approaching pressure zone |
| 🔴 Red | ≥ 90% | Near capacity — swap risk or OOM risk |

---

### Cost/1M per Node

| Color | Value | Meaning |
|-------|-------|---------|
| 🟢 Green | < $0.01 | Very cheap — below display threshold |
| 🟡 Amber | $0.01–$0.05 | Moderate cost |
| 🔴 Red | > $0.05 | High cost — check power draw or electricity rate |

---

## Dashboard: Insight Tiles

Eight summary cards at the top of the dashboard. All displayed values pass through a rolling-average buffer (fleet metrics: 12-sample window; per-node metrics: 8-sample window) to suppress probe noise while keeping transitions live.

| # | Tile | Formula / Source | Notes |
|---|------|-----------------|-------|
| 1 | **Throughput** | `∑ estimateTps(tok/s, peakTps, GPU%, inferenceActive)` across active nodes | Sub-label: "live" (proxy active), "live estimate" (polling), "idle-spd baseline", or "sampling every 30s" |
| 2 | **Fleet Health** | `(# nodes with Normal or Fair thermal) ÷ (# nodes with thermal data) × 100` | 🟢 100%, 🟡 ≥75%, 🔴 <75% |
| 3 | **Total Fleet VRAM** | `∑ nvidia_vram_used_mb ÷ ∑ nvidia_vram_total_mb` | NVIDIA only — Apple Silicon unified memory is excluded |
| 4 | **Fleet Nodes** | Online node count / total paired node count | Online = telemetry within last 60s |
| 5 | **Avg WES** | Mean `tok/s ÷ (watts × PUE × ThermalPenalty)` across nodes with power data | Thermally penalized tok/watt |
| 6 | **W/1K Tkn** | `(totalPowerW ÷ fleetTps) × 1000` | Watts per 1,000 tok/s; equivalent to J/tok |
| 7 | **Cost/1M Tokens** | `wattPer1k × kWhRate ÷ 3,600,000 × 1,000,000` | Default $0.13/kWh; configure in Settings |
| 8 | **Fleet Power Cost/Day** | `∑ (watts_i × PUE_i) × 24 × (rate ÷ 1000)` | Always-on infrastructure cost — not filtered by inference activity |

*Source: `src/utils/efficiency.ts`, computed inline in `src/components/Overview.tsx`*

---

## Dashboard: Fleet Status Table

Ten columns in the main node table. Values update at up to 10 Hz but are smoothed over an 8-sample rolling window before display.

| Column | What it shows | Data source | Color logic |
|--------|--------------|-------------|-------------|
| **NODE** | Node ID + hostname + online dot | `node_id`, `hostname`, `timestamp_ms` | Online/offline/pending dot (see Visual Indicators) |
| **MEMORY** | Memory utilization % + bar | `memory_pressure_percent` (Apple) OR `used_memory_mb / total_memory_mb × 100` | Green <70%, Amber 70–90%, Red ≥90% |
| **VRAM** | NVIDIA VRAM % + bar | `nvidia_vram_used_mb / nvidia_vram_total_mb × 100` | Same thresholds; shows `—` on Apple Silicon |
| **MODEL** | Model name + **Fit Dot** + vLLM cache% | `ollama_active_model`, `vllm_model_name`, `vllm_cache_usage_perc` | Fit dot: Green/Amber/Red (see Visual Indicators) |
| **WES** | Wicklee Efficiency Score | `computeWES(tps, watts, thermal, pue)` | Green >10, Amber 1–10, Red <1 |
| **TOK/S** | Three-state throughput reading | `estimateTps()` with LIVE / IDLE-SPD / BUSY badge | See TOK/S Badges above |
| **TOK/W** | Tokens per watt | `tps ÷ (watts / 1000)` | No threshold — higher is always better |
| **WATTS** | Board power draw | `cpu_power_w + nvidia_power_draw_w` | No threshold coloring in table |
| **GPU%** | GPU utilization | `nvidia_gpu_utilization_percent` OR `gpu_utilization_percent` | No threshold coloring in table |
| **THERMAL** | Thermal state badge | `thermal_state` (macOS pmset / Linux) or inferred from `nvidia_gpu_temp_c` | Green / Yellow / Orange / Red (see Thermal Badges) |

---

## Dashboard: Fleet Intelligence Cards

Cards rendered below the Fleet Status table.

---

### Best Route Now

Picks the single best node for three routing strategies, using smoothed values:

- **Lowest Latency** — node with the highest current `tps` (fastest response)
- **Highest Efficiency** — node with the highest `wes` (best tok/watt)
- **Lowest Cost** — node with the lowest `costPer1m` (cheapest per 1M tokens; requires power data)

Use this when you want to direct a single request to the optimal node right now, rather than load-balancing across the fleet.

---

### Cost Efficiency Card

Fleet-level $/1M tokens broken down with per-node contribution. Same formula as Insight Tile 7 but shows how many nodes are contributing and their individual costs. Color: 🟢 green < $0.01, 🟡 amber $0.01–$0.05, 🔴 red > $0.05 per node.

---

### Tokens Per Watt Card

`fleetTps ÷ totalFleetWatts` — fleet-wide energy efficiency. Rises when efficient nodes (Apple Silicon, quantized models) are active; falls when power-hungry GPUs dominate the fleet.

---

### Thermal Diversity

Count of nodes per thermal state (Normal / Fair / Serious / Critical). A fleet where any node shows Serious or Critical is already losing throughput capacity silently.

---

### Display Smoothing

All numbers in the dashboard pass through a rolling-average (simple moving average) buffer before rendering. Raw unsmoothed values always drive alert thresholds so warnings fire without delay.

**Rolling-window sizes**

| Metric set | Window | At 1 Hz = |
|---|---|---|
| Per-node (tok/s, watts, GPU%) | 8 samples | ~8 seconds |
| Fleet aggregates (fleet tok/s, $/1M, WES, W/1k) | 12 samples | ~12 seconds |

**Localhost broadcast rate**

The local Wicklee agent broadcasts telemetry at **1 Hz** (once per second). This was intentionally throttled from an earlier 10 Hz rate: at 10 Hz the 8-sample window covered only ~800 ms, making metrics visibly jumpy. At 1 Hz the same window covers ~8 seconds, matching the effective smoothing depth of the cloud fleet dashboard and producing a consistent reading experience across both environments.

**Additional protections**

| Mechanism | What it does |
|---|---|
| Timestamp deduplication | Prevents double-counting during React re-renders |
| `MIN_COST_TPS = 0.1` | Gates cost samples when tok/s ≈ 0 to block Ollama startup spikes |
| Offline buffer reset | Clears per-node buffers immediately when a node goes offline |

*Source: `src/hooks/useRollingMetrics.ts` → `useRollingBuffer()`*

---

## Throughput Measurement

How Wicklee measures tok/s — differently per runtime, honestly labeled in the dashboard.

---

### Ollama — Scheduled Probe + Inference Detection

Every 30 seconds, the agent fires a 20-token generation request to `/api/generate` and measures `eval_count ÷ eval_duration` — the pure generation phase, isolated from prompt load time. This gives a clean per-node baseline independent of model context size.

**Keep Warm pings:** The Model Eviction insight card can fire a silent 1-token ping (`num_predict=1`) to reset Ollama's `keep_alive` timer before a model is evicted. This briefly trips `/api/ps` inference detection — the TOK/S badge may show LIVE for one poll cycle (~5 seconds) with a `~0` reading. The 8-sample rolling buffer absorbs the single sample; it does not alter your throughput baseline or WES.

**Dynamic scheduling:** When GPU utilization is ≥ 40%, the probe is skipped. Firing tokens into a loaded scheduler would queue behind the active job and return a depressed or failed reading. The agent writes `None` explicitly so the dashboard switches to the estimation value rather than carrying forward a stale reading. The 5-second `/api/ps` heartbeat continues regardless — keeping model presence and online status current.

**Inference detection via `/api/ps`:** The agent polls `/api/ps` every 5 seconds and watches the `expires_at` field. Ollama resets `expires_at` to `now + keep_alive` each time a request completes. When the agent sees `expires_at` change, it knows inference just finished and sets `inference_active = true` for the next 35 seconds (one probe interval). This is the primary signal driving the three-state TOK/S display — it tells the dashboard whether a probe reading is a live throughput measurement or an unloaded hardware baseline.

---

### vLLM — Passive Prometheus Scrape

Zero synthetic tokens. The agent scrapes `vllm:avg_generation_throughput_toks_per_s` from vLLM's Prometheus endpoint every 2 seconds. This gauge represents aggregate server throughput across all concurrent requests — the right signal for fleet monitoring, and better than a latency-inverse formula because vLLM only exposes inter-token latency as a histogram, not a scalar.

Because vLLM reports actual live throughput directly, no probe, no estimation, and no inference detection signal are needed — the metric is exact and the display shows it as **LIVE** whenever `vllm_tokens_per_sec > 0`.

---

### Three-State TOK/S Display

The dashboard labels every TOK/S reading so you know what you're looking at:

| Label | Condition | Color | Meaning |
|-------|-----------|-------|---------|
| **LIVE** | `inference_active = true` (Ollama) or `vllm_tokens_per_sec > 0` | Green | Inference in progress. Ollama value prefixed with `~` (estimate); vLLM value is exact. |
| **IDLE-SPD** | `inference_active = false` and GPU% < 15% | Muted gray | Hardware unloaded. Probe ran clean. This is the hardware capability baseline, not live throughput. |
| **BUSY** | `inference_active = false` and GPU% ≥ 50% | Amber | GPU occupied by a non-Ollama workload. Last known probe baseline shown — amber signals the number does not reflect current inference. |

**Why the IDLE-SPD / LIVE distinction matters:** A hardware capability baseline (probe at idle) and a live throughput reading (estimate during inference) are different numbers. Without this labeling, an idle Mac with GPU compositing at 8% would falsely report 43 tok/s. The label makes the difference explicit.

**Apple Silicon note:** `gpu_utilization_percent` on Apple Silicon captures all GPU work — display compositing, Metal apps, background tasks — not just ML inference. Below 15%, only macOS compositing is running and the probe is reliable. Above 50% without Ollama inference, something else is consuming the GPU. Wicklee uses `/api/ps` detection as the primary inference signal; GPU% serves only as a threshold check for the BUSY state.

---

### Estimation Gap

When an Ollama probe is skipped (or returns `null` due to inference lockup), Wicklee estimates throughput from the session peak and live GPU utilization:

```
// Probe returned a (possibly depressed) reading — add estimated background load
estimated_tps = raw_tps + (peak_tps × gpu_util_frac)

// Probe failed entirely (inference lockup) — infer from GPU load alone
estimated_tps = peak_tps × gpu_util_frac    if gpu_util > 0
estimated_tps = null                         if gpu_util = 0
```

**Peak TPS** is the session high-water mark for the current model on this node — the highest clean probe reading recorded since the session started or the last model swap. It resets automatically on model change so a new model's throughput doesn't inherit a stale baseline.

**Why GPU utilisation works as a proxy:** GPU utilisation is the load signal unaffected by the probe. If the GPU is 80% busy and the peak was 70 tok/s, the hardware is plausibly doing ~56 tok/s of background inference. The probe measurement (if any) captures any additional uncontested compute.

Estimated values are prefixed with `~` in the dashboard. Exact values (vLLM, or clean Ollama probe at idle) have no prefix.

---

### Optional Ollama Proxy (Upgrade Path)

By default, inference detection uses `/api/ps` `expires_at` — zero configuration, no request interception. For exact live tok/s during inference, Wicklee supports an opt-in transparent proxy:

**What the proxy adds:**
- `inference_active` flips to `true` the instant a request arrives — zero lag vs. the 5–35 second window from `/api/ps`
- Throughput tile sub-label changes from "live estimate" to "live" when proxy is active
- Exact tok/s measured from `eval_count / eval_duration` in the final streaming packet
- No additional network round-trip — the proxy runs in-process on loopback

**Privacy guarantee:** The proxy reads only the `model` field from the request body (for model-swap tracking) and only `eval_count`, `eval_duration`, and `done` from the final response packet. It never reads, buffers, or logs `prompt`, `messages`, or `response` fields. All request and response bytes pass through verbatim.

**Configuration (`~/.wicklee/config.toml`):**
```toml
[ollama_proxy]
enabled = true       # opt-in, default false
ollama_port = 11435  # where Ollama now listens (after you move it)
```

To enable: set `OLLAMA_HOST=127.0.0.1:11435` in Ollama's environment and restart it. The Wicklee agent binds `:11434` (the standard Ollama port) on startup. If it can't bind (Ollama still there), it logs a clear message and falls back to `/api/ps` polling automatically.

When the proxy is disabled (default), Wicklee uses `/api/ps` detection. The proxy is purely additive — disabling it does not change any other metric behavior. vLLM does not need this option; its Prometheus endpoint already provides exact live throughput.

---

## Node Metrics

Per-node values derived from hardware telemetry and inference runtime.

---

### WES — Wicklee Efficiency Score

**Formula:** `tok/s ÷ (Watts × PUE × ThermalPenalty)`

The single number that captures true inference efficiency. WES is tok/watt made thermally honest — when a node is healthy, WES equals tok/watt. When it's throttling, WES is lower, and the gap is exactly how much efficiency heat is costing you.

**Thermal penalties applied to the denominator:**

| State | Multiplier | Effect |
|-------|-----------|--------|
| Normal | 1.0× | No adjustment |
| Fair | 1.25× | WES = 80% of raw tok/watt |
| Serious | 2.0× | WES = 50% of raw tok/watt |
| Critical | 2.0× | WES = 50% of raw tok/watt |

**Color ranges:**
- `> 10` 🟢 Excellent · Apple Silicon territory
- `1–10` 🟡 Fair · high-power GPU or mild throttle
- `< 1` 🔴 Poor · CPU inference or thermal throttling

**If this is low:** Check thermal state first. If throttling, reduce load or improve airflow. If thermal is Normal, the hardware is simply less efficient per watt — compare models or quantizations.

*Source: `src/utils/wes.ts` → `computeWES()`*

---

### TOK/S — Tokens Per Second

Raw inference throughput. The badge (LIVE / IDLE-SPD / BUSY) tells you what the number means — see **Visual Indicators** above and **Three-State TOK/S Display** in Throughput Measurement. Ollama: measured via scheduled 20-token probe every 30 seconds, estimated during active inference. vLLM: live aggregate throughput from Prometheus, always exact.

**Ranges:**
- `> 50` 🟢 Fast · responsive for interactive use
- `10–50` 🟡 Moderate · usable, not snappy
- `< 10` 🔴 Slow · model may be too large for hardware

**If this is low:** Check memory headroom (model may be swapping), thermal state (throttling cuts tok/s 30–50%), and GPU utilization (low GPU% with low tok/s = runtime misconfiguration).

---

### TOK/W — Tokens Per Watt

**Formula:** `tok/s ÷ (Watts / 1000)`

Raw efficiency without thermal penalty — the energy cost of each token before thermal adjustment. When thermal is Normal, TOK/W ≈ WES. The gap between TOK/W and WES is your thermal cost. No universal range — compare nodes within your fleet. Higher is always better.

---

### WATTS — Board Power

Total power draw of the inference hardware in watts. Apple Silicon: CPU power via powermetrics. NVIDIA: board power via NVML (sudoless). Linux: CPU package power via RAPL.

**Ranges:**
- `< 15W` 🟢 Low draw · Apple Silicon or idle GPU
- `15–150W` 🟡 Moderate · GPU under inference load
- `> 150W` 🔴 High draw · monitor for cost and thermals

**If this is high with low GPU%:** Power anomaly — a background process is consuming power without doing inference work.

---

### GPU% — GPU Utilization

Percentage of GPU compute capacity currently in use. Apple Silicon: read from AGX accelerator via ioreg (sudoless). NVIDIA: read via NVML (sudoless).

**Ranges:**
- `60–95%` 🟢 Healthy inference load
- `95–100%` 🟡 Saturated · may queue requests
- `< 30%` 🟡 Underutilized · model may not be GPU-accelerated
- `0% during inference` 🔴 Runtime misconfiguration · inference running on CPU

**Apple Silicon note:** GPU% includes all GPU work, not only ML inference. Wicklee uses `/api/ps` inference detection as the primary signal and GPU% only for the BUSY threshold.

---

### MEMORY — System Memory Pressure

Percentage of total system memory in use. On Apple Silicon, unified memory serves both CPU and GPU — the model lives here alongside everything else. Color thresholds are reflected in the progress bar (see Visual Indicators).

**Ranges:**
- `< 70%` 🟢 Comfortable headroom
- `70–90%` 🟡 Monitor · approaching pressure zone
- `> 90%` 🔴 High pressure · swap risk, tok/s may drop

**If this is high:** The loaded model may be too large for this hardware. The Model Fit Dot in the MODEL column will flag this — check the hover tooltip for exact headroom figures.

---

### VRAM — GPU Memory Utilization

NVIDIA only. Percentage of dedicated GPU memory in use. Apple Silicon shows `—` — unified memory serves both roles and is covered by the MEMORY metric. Color thresholds are reflected in the progress bar.

**Ranges:**
- `< 70%` 🟢 Comfortable headroom
- `70–90%` 🟡 Monitor · approaching limit
- `> 90%` 🔴 Near capacity · model eviction or OOM risk

---

### THERMAL STATE

The OS-level assessment of hardware thermal condition. macOS: read from `pmset` (sudoless). NVIDIA: inferred from GPU temperature via NVML. See **Thermal Badges** in Visual Indicators for the color mapping.

**Ranges with WES impact:**
- `Normal` 🟢 1.0× penalty — Hardware running within design limits
- `Fair` 🟡 1.25× penalty — Mild throttling beginning
- `Serious` 🔴 2.0× penalty — Active throttling · tok/s dropping ~30–50%
- `Critical` 🔴 2.0×+ penalty — Severe throttling · reduce load immediately

**If Serious or Critical:** Stop inference if possible. Check airflow, fan curve, and ambient temperature. A node at Serious thermal has already lost 30–50% of its tok/s invisibly — WES captures this loss even when the tok/s number looks stable.

---

### W/1K TKN — Wattage Per 1K Tokens

**Formula:** `(Watts / tok/s) × 1000`

**Unit:** W per (k·tok/s) — watts of sustained power draw per 1,000 tokens/second of throughput.

How much power the fleet sustains per unit of inference capacity. Lower is more efficient. The ratio `W / (tok/s)` is mathematically equivalent to J/tok (joules per token) — same number, power framing. The cost formula uses this equivalence to derive $/1M (see COST/1M TOKENS below).

---

### QUANTIZATION LEVEL

The precision level at which a model's weights are stored and computed. Quantization is the single biggest lever on VRAM usage, tok/s, and WES — the **Quantization ROI** insight card shows a live snapshot for the currently loaded model.

| Level | VRAM vs Q8 | Tok/s delta | Quality |
|-------|-----------|-------------|---------|
| Q2    | ~75% less | faster      | Noticeable degradation — avoid coding/math tasks |
| Q3    | ~60% less | faster      | Variable by model |
| **Q4_K_M** | **~50% less** | **~10–15% faster** | **Recommended default — minimal quality loss** |
| Q5    | ~35% less | ~5–10% faster | Near-lossless with meaningful VRAM savings |
| Q6    | ~20% less | ~2–5% faster | Near-identical to Q8 in quality |
| Q8    | baseline  | baseline    | Maximum accuracy |
| F16   | ~2× Q8    | slower      | Full precision — production accuracy-critical workloads |
| F32   | ~4× Q8    | significantly slower | Double precision — rarely needed at inference |

**Effect on WES:** Net impact depends on your hardware. On memory-constrained Apple Silicon, Q4_K_M often *improves* WES by eliminating swap pressure that was silently depressing tok/s. On a GPU with ample VRAM, Q8 may edge out Q4_K_M since there's no memory penalty and accuracy is higher. Let the rolling buffer stabilize (~8 seconds) after a model swap before comparing WES readings across quants.

*Source: `src/components/insights/tier2/QuantizationROICard.tsx`*

---

### COST/1M TOKENS

**Formula:**
```
cost_per_1k_tok  = (J_per_1k_tok × kWh_rate) ÷ 3,600,000
cost_per_1M_tok  = cost_per_1k_tok × 1,000
```

**Why 3,600,000?** 1 kWh = 1,000 W × 3,600 s = 3,600,000 J. Dividing Joules by this converts to kWh. Multiplying by your kWh rate gives dollars.

**Example (36.1 W, 56.1 tok/s, $0.12/kWh):**
```
J/1k·tok    = (36.1 / 56.1) × 1000 = 643 J
cost/1k·tok = 643 × 0.12 / 3,600,000 = $0.0000214
cost/1M·tok = $0.0214
```

Shown per-million so you can compare directly against cloud API pricing (e.g. GPT-4o at ~$5/1M). Configure your electricity rate in Settings → Cost & Energy for accurate figures. Color: 🟢 < $0.01, 🟡 $0.01–$0.05, 🔴 > $0.05.

---

## Fleet Metrics

Aggregated across all paired nodes. Available in the cloud dashboard at wicklee.dev.

---

### FLEET AVG WES

Average WES score across all online nodes with power data. Weighted equally — not by throughput. A useful fleet health signal, but use Best Route Now for routing decisions.

---

### COST EFFICIENCY — $/1M Tokens

Fleet-level cost per million tokens at current draw and throughput. Uses per-node electricity rate and PUE multiplier from Settings. The sovereign fleet benchmark — compare to cloud API pricing to quantify your cost advantage.

---

### TOKENS PER WATT (Fleet)

**Formula:** `fleet_tok/s ÷ total_fleet_watts`

Fleet-wide energy efficiency. Rises when efficient nodes (Apple Silicon) are active, falls when power-hungry nodes dominate the fleet.

---

### FLEET HEALTH

Percentage of nodes with `thermal_state = Normal or Fair`. A node at Serious or Critical thermal state is already throttling — fleet health reflects how many nodes are in this condition simultaneously.

**Ranges:**
- `100%` 🟢 All nodes running within design limits
- `≥ 75%` 🟡 Monitor · mild throttling on at least one node
- `< 75%` 🔴 Active degradation · fleet efficiency is reduced

---

## Configuration

User-configured multipliers that affect cost and efficiency calculations.

---

### PUE — Power Usage Effectiveness

A multiplier accounting for datacenter overhead beyond raw node wattage (cooling, power delivery losses). Applies to cost-per-token and WES calculations. Configure in Settings → Cost & Energy.

**Typical values:**
- `1.0` — Home lab or direct plug measurement
- `1.1–1.2` — Hyperscale colocation
- `1.4–1.6` — Standard datacenter

---

### MODEL FIT SCORE

Correlates the loaded model's weight size against available memory (VRAM for NVIDIA, system RAM for Apple Silicon) and thermal state to assess whether this hardware is well-matched for this model.

**Scoring logic** (priority order: Poor → Fair → Good):

| Score | Condition |
|-------|-----------|
| **Poor** 🔴 | Model size exceeds free memory, OR headroom < 10%, OR thermal is Serious/Critical |
| **Fair** 🟡 | Model fits AND (headroom 10–20% OR thermal is Fair) |
| **Good** 🟢 | Model fits AND headroom > 20% AND thermal is Normal (or unavailable) |

The score appears as a colored dot next to the model name in the Fleet Status table (see **Model Fit Dot** in Visual Indicators). Hover the dot for the exact reason string.

*Source: `src/utils/modelFit.ts` → `computeModelFitScore()`*

---

### ELECTRICITY RATE

Default: `$0.13 USD/kWh`. Used in all cost calculations when no per-node rate is configured. Set your actual rate in Settings → Cost & Energy to make $/1M comparisons accurate.

---

*Wicklee — sovereign GPU fleet intelligence · wicklee.dev*
