# Wicklee Metrics Reference

> Every metric Wicklee surfaces — what it means, what to do about it.

---

## How Wicklee Works: Synchronous Observation

Wicklee is a sovereign Rust binary that observes your inference fleet without ever touching your private data. Unlike standard scrapers that pull static counters, Wicklee performs Synchronous Observation by merging two high-fidelity telemetry streams:

- **Hardware Harvester (10 Hz):** The agent queries your kernel and GPU drivers (NVML / IOReg / RAPL) at high frequency to capture micro-spikes in power, thermals, and utilization that 1-minute Prometheus scrapes miss.

- **Performance Probe (30 s):** Every 30 seconds, the agent fires a 20-token generation request to your local inference API to measure real-time throughput without intercepting actual user traffic. The probe is skipped when GPU utilization is ≥ 40% — at that point the scheduler is already under load and a probe reading would be depressed. Throughput estimation covers the gap (see below).

- **Local Interpretation:** By owning both hardware physics and runtime context, Wicklee triggers Conditional Insights — identifying "invisible" states like a Power Anomaly (high wattage vs. low GPU utilization) or Thermal Degradation (temperature spikes causing silent throughput drops).

- **Zero-Intercept Privacy:** Wicklee does not act as a proxy. It never sees your prompts or model responses — it only measures the hardware "effort" required to produce them, ensuring your data remains entirely within your sovereign boundary.

---

## Throughput Measurement

How Wicklee measures tok/s — differently per runtime, honestly labeled in the dashboard.

---

### Ollama — Scheduled Probe + Inference Detection

Every 30 seconds, the agent fires a 20-token generation request to `/api/generate` and measures `eval_count ÷ eval_duration` — the pure generation phase, isolated from prompt load time. This gives a clean per-node baseline independent of model context size.

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
- LIVE display shows exact tok/s (no `~`) — measured from `eval_count / eval_duration` in the final streaming packet
- No additional network round-trip — the proxy runs in-process on loopback

**Privacy guarantee:** The proxy reads only the `model` field from the request body (for model-swap tracking) and only `eval_count`, `eval_duration`, and `done` from the final response packet. It never reads, buffers, or logs `prompt`, `messages`, or `response` fields. All request and response bytes pass through verbatim.

**Configuration (`config.toml`):**
```toml
[ollama_proxy]
enabled = false         # opt-in, default off
listen_port = 11435     # point your Ollama client here instead of 11434
ollama_port  = 11434    # where real Ollama listens
```

When the proxy is disabled (default), Wicklee uses `/api/ps` detection. The proxy is purely additive — disabling it does not change any other metric behavior. vLLM does not need this option; its Prometheus endpoint already provides exact live throughput.

---

## Node Metrics

Per-node values derived from hardware telemetry and inference runtime.

---

### WES — Wicklee Efficiency Score

**Formula:** `tok/s ÷ (Watts × ThermalPenalty)`

The single number that captures true inference efficiency. WES is tok/watt made thermally honest — when a node is healthy, WES equals tok/watt. When it's throttling, WES is lower, and the gap is exactly how much efficiency heat is costing you.

**Ranges:**
- `> 50` 🟢 Excellent · Apple Silicon territory
- `10–50` 🟡 Good · efficient GPU at load
- `1–10` 🟠 Fair · high-power GPU or mild throttle
- `< 1` 🔴 Poor · CPU inference or thermal throttling

**If this is low / high:** Check thermal state first. If throttling, reduce load or improve airflow. If thermal is Normal, the hardware is simply less efficient per watt — compare models or quantizations.

---

### TOK/S — Tokens Per Second

Raw inference throughput. See **Three-State TOK/S Display** above for how the label (LIVE / IDLE-SPD / BUSY) tells you what the number means. Ollama: measured via a scheduled 20-token probe every 30 seconds, estimated during active inference. vLLM: live aggregate throughput from Prometheus, always exact.

**Ranges:**
- `> 50` 🟢 Fast · responsive for interactive use
- `10–50` 🟡 Moderate · usable, not snappy
- `< 10` 🔴 Slow · model may be too large for hardware

**If this is low / high:** Check memory headroom (model may be swapping), thermal state (throttling cuts tok/s 30–50%), and GPU utilization (low GPU% with low tok/s = runtime misconfiguration).

---

### TOK/W — Tokens Per Watt

**Formula:** `tok/s ÷ (Watts / 1000)`

Raw efficiency without thermal penalty — the energy cost of each token before thermal adjustment. When thermal is Normal, TOK/W ≈ WES. The gap between TOK/W and WES is your thermal cost. No universal range — compare nodes within your fleet. Higher is always better.

---

### WATTS — Board Power

Total power draw of the inference hardware in watts. Apple Silicon: CPU power via powermetrics (requires sudo). NVIDIA: board power via NVML (sudoless).

**Ranges:**
- `< 15W` 🟢 Low draw · Apple Silicon or idle GPU
- `15–150W` 🟡 Moderate · GPU under inference load
- `> 150W` 🔴 High draw · monitor for cost and thermals

**If this is low / high:** Check GPU utilization. High watts + low GPU% = power anomaly (background process consuming power without doing inference work).

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

Percentage of total system memory in use, combined with kernel memory pressure assessment. On Apple Silicon, unified memory serves both CPU and GPU — the model lives here alongside everything else.

**Ranges:**
- `< 60%` 🟢 Comfortable headroom
- `60–80%` 🟡 Monitor · approaching pressure zone
- `> 80%` 🔴 High pressure · swap risk, tok/s may drop

**If this is low / high:** The loaded model may be too large for this hardware. Wicklee's Model Fit Score will flag this before performance collapses.

---

### VRAM — GPU Memory Utilization

NVIDIA only. Percentage of dedicated GPU memory in use. Apple Silicon shows — · unified memory serves both roles and is covered by the MEMORY metric.

**Ranges:**
- `< 70%` 🟢 Comfortable headroom
- `70–90%` 🟡 Monitor · approaching limit
- `> 90%` 🔴 Near capacity · model eviction or OOM risk

---

### THERMAL STATE

The OS-level assessment of hardware thermal condition. macOS: read from pmset (sudoless). NVIDIA: inferred from GPU temperature via NVML.

**Ranges:**
- `Normal` 🟢 1.0× penalty — Hardware running within design limits
- `Fair` 🟡 1.25× penalty — Mild throttling beginning
- `Serious` 🔴 2.0× penalty — Active throttling · tok/s dropping
- `Critical` 🔴 2.0×+ penalty — Severe throttling · reduce load immediately

**If this is low / high:** Stop inference if possible. Check airflow, fan curve, and ambient temperature. A node at Serious thermal has already lost 30–50% of its tok/s invisibly.

---

### W/1K TKN — Wattage Per 1K Tokens

**Formula:** `(Watts / tok/s) × 1000`

**Unit:** W per (k·tok/s) — watts of sustained power draw per 1,000 tokens/second of throughput.

How much power the fleet sustains per unit of inference capacity. Lower is more efficient. The ratio `W / (tok/s)` is mathematically equivalent to J/tok (joules per token) — same number, power framing. The cost formula uses this equivalence to derive $/1M (see COST/1M TOKENS below).

---

### COST/1M TOKENS

**Formula:**
```
cost_per_1k_tok  = (J_per_1k_tok × kWh_rate) ÷ 3,600,000
cost_per_1M_tok  = cost_per_1k_tok × 1,000
```

**Why 3,600,000?** 1 kWh = 1,000 W × 3,600 s = 3,600,000 J. Dividing Joules by this converts to kWh. Multiplying by your kWh rate gives dollars.

**Example at current fleet values (36.1 W, 56.1 tok/s, $0.12/kWh):**
```
J/1k·tok         = (36.1 / 56.1) × 1000 = 643 J
cost/1k·tok      = 643 × 0.12 / 3,600,000 = $0.0000214
cost/1M·tok      = $0.0214
```

Shown per-million so you can compare directly against cloud API pricing (e.g. GPT-4o at ~$5/1M). Configure your electricity rate in Settings → Cost & Energy for accurate figures.

---

## Fleet Metrics

Aggregated across all paired nodes. Available in the cloud dashboard at wicklee.dev.

---

### FLEET AVG WES

Average WES score across all online nodes. Weighted equally — not by throughput. A useful fleet health signal but not a routing decision — use Best Route Now for routing.

---

### COST EFFICIENCY — $/1M Tokens

Fleet-level cost per million tokens at current draw and throughput. Uses per-node electricity rate and PUE multiplier from Settings. The sovereign fleet benchmark — compare to cloud API pricing to quantify your cost advantage.

---

### TOKENS PER WATT (Fleet)

**Formula:** `fleet_tok/s ÷ (total_fleet_watts / 1000)`

Fleet-wide energy efficiency. Rises when efficient nodes (Apple Silicon) are active, falls when power-hungry nodes dominate the fleet.

---

### FLEET HEALTH

Distribution of thermal states across all paired nodes. A node at Serious or Critical thermal state is already throttling — fleet health reflects how many nodes are in this condition simultaneously.

**Ranges:**
- `All Normal` 🟢 All nodes running within design limits
- `Any Fair` 🟡 Monitor · mild throttling on at least one node
- `Any Serious/Critical` 🔴 Active degradation · fleet efficiency is reduced

---

## Configuration

User-configured multipliers and scores that affect cost and efficiency calculations.

---

### PUE — Power Usage Effectiveness

A multiplier accounting for datacenter overhead beyond raw node wattage (cooling, power delivery losses). Configure in Settings → Cost & Energy.

**Typical values:**
- `1.0` — Home lab or direct plug measurement
- `1.1–1.2` — Hyperscale colocation
- `1.4–1.6` — Standard datacenter

---

### MODEL FIT SCORE

Correlates loaded model size against available memory and thermal state to assess whether this hardware is well-matched for this model. Appears in the Insights tab when a model is loaded.

**Ranges:**
- `Good` 🟢 Model fits with >20% memory headroom, Normal thermal
- `Fair` 🟡 Model fits but headroom is tight or thermal is Fair
- `Poor` 🔴 Model exceeds available memory or thermal is Serious

---

*Wicklee — sovereign GPU fleet intelligence · wicklee.dev*
