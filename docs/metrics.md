# Understanding Your Wicklee Metrics

Wicklee surfaces hardware signals that standard monitoring tools miss — especially signals that matter for local AI inference. Here's what each metric means, why it matters, and what to do when something looks off.

---

## CPU Usage %

**What it is:** The percentage of CPU capacity currently in use across all cores.

**Why it matters for inference:** Most inference work happens on the GPU, not the CPU. If CPU usage is consistently above 80% during inference, something is wrong — you may be running a model without GPU offloading, or a background process is competing for resources.

**Action:** If CPU is pegged but GPU utilization is low, check that your inference runtime (Ollama, vLLM) is correctly configured to use the GPU.

---

## Memory Used / Available

**What it is:** How much of your system RAM is actively in use vs. available.

**Why it matters for inference:** On Apple Silicon, CPU and GPU share the same unified memory pool. A large model loaded into GPU memory reduces the RAM available to everything else. Running out of available memory forces the OS to swap — destroying inference performance.

**Action:** If available memory drops below ~10% of total while running inference, consider a smaller quantized model or reducing batch size.

---

## Memory Pressure %

**What it is:** The kernel's own assessment of memory stress — not just how much is used, but how hard the OS is working to satisfy memory requests. Calculated from wired + active memory pages.

**Why it matters for inference:** This is the metric standard tools miss. A machine can show "6.2 GB used of 8 GB" and appear fine — but if memory pressure is at 85%, the kernel is actively compressing and evicting pages, and inference performance is already degraded.

**Action:**
- 0–60%: Healthy. No action needed.
- 60–80%: Elevated. Monitor closely under sustained load.
- 80%+: Critical. Expect degraded token generation speed. Quantize down or add RAM.

> Memory pressure is available on **Apple Silicon only** (IOKit/powermetrics). Linux and Windows nodes report memory used/available instead — `memory_pressure_percent` is the reliable Apple Silicon platform detector used throughout Wicklee's fleet aggregation logic.

> **Pattern link:** **Pattern F — Memory Pressure Trajectory** detects a rising pressure trend and projects the ETA to the 85% critical threshold using linear regression over 10 minutes of localStorage history. Fires when ETA < 30 minutes — before the threshold-crossing alert ever triggers.

---

## GPU Utilization %

**What it is:** The percentage of GPU compute capacity currently in use. On Apple Silicon, read directly from the AGX accelerator via `ioreg` — no sudo required. On NVIDIA, read via NVML — also no sudo required.

**Why it matters for inference:** This is the most direct signal of whether your inference workload is actually running on the GPU. Low GPU utilization during inference means the model isn't GPU-accelerated, or the runtime is bottlenecked elsewhere.

**Action:** During active inference, GPU utilization should be 60–100%. If it's consistently below 20% while requests are being processed, check your runtime configuration.

---

## VRAM Used / Total

**What it is:** The amount of GPU memory in use and total available, reported in GB. Available on NVIDIA GPUs via NVML. Displayed as `X.X/Y GB` in the Fleet Status VRAM column.

**Why it matters for inference:** VRAM is the hard constraint for GPU-based inference. If VRAM is exhausted, the model spills to system RAM — and inference throughput collapses.

**NVIDIA discrete GPUs (RTX, A-series, H-series):** VRAM is a fixed, isolated resource. Wicklee reads `nvidia_vram_used_mb` and `nvidia_vram_total_mb` via NVML — sudoless, available immediately after install.

**NVIDIA GB10 Grace Blackwell (DGX Spark and similar SoCs):** The GB10 uses a **unified memory pool** — CPU and GPU share the same physical memory, with no discrete VRAM framebuffer. Wicklee detects this automatically (`vram_total_mb ≥ system_ram × 90%` heuristic) and switches to **process residency accounting**: `nvidia_vram_used_mb` = sum of `nvmlDeviceGetComputeRunningProcesses()` used bytes. The Fleet Status VRAM column shows "Unified" in the MEMORY cell and the actual used/total in the VRAM cell (e.g., `78.5/122`).

**Apple Silicon:** GPU and system memory are the same unified pool. Wicklee reports `gpu_wired_limit_mb` (the OS's GPU wired memory budget from `sysctl iogpu`) as the "VRAM budget" and wired memory usage as "used". Displayed as `X.X/Y GB` in the VRAM column — directly comparable to NVIDIA's display format.

**Action:** Keep VRAM usage below 90% for stable inference on discrete GPUs. For unified memory nodes (Grace Blackwell, Apple Silicon), watch Memory Pressure % as the more sensitive signal — it reflects OS-level memory stress before throughput visibly degrades.

> **Pattern link:** **Pattern F — Memory Pressure Trajectory** fires when `memory_pressure_percent` is rising at a rate that projects to critical within 30 minutes. Uses localStorage 24h history — available on all tiers without cloud history.

---

## GPU Temperature (°C)

**What it is:** The current die temperature of the GPU in degrees Celsius, reported via NVML on NVIDIA hardware.

**Why it matters for inference:** Sustained high GPU temperature triggers thermal throttling — the GPU reduces its clock speed to manage heat, directly cutting tokens-per-second. Temperature is the leading indicator; by the time you see throughput drop, throttling is already underway.

**Action:**
- Below 75°C: Healthy range for sustained inference load.
- 75–85°C: Monitor closely. Consider reducing concurrent requests or improving airflow.
- Above 85°C: Active throttling likely. Reduce load or address cooling. Check if the fan curve is configured correctly.

> See also: **Thermal State** (Apple Silicon) and the **Thermal Degradation Correlation** insight card, which surfaces the relationship between temperature trend and tok/s drop over a session.

---

## Thermal State

**What it is:** The hardware's thermal management status. Reports one of: **Normal**, **Fair**, **Serious**, or **Critical**.

- **Apple Silicon:** Read from IOKit via `powermetrics` — maps the kernel's internal thermal pressure state.
- **NVIDIA (Linux):** NVML throttle reason bitmask. Multi-reason → Critical (2.5×). `HW_THERMAL` → Serious (2.0×). `SW_THERMAL`/`HW_SLOWDOWN` → Fair (1.25×). Pre-throttle (>90°C, no bits set) → Fair (1.1×). Source tag: `nvml` — hardware-authoritative.
- **Linux (non-NVIDIA):** `/sys/class/thermal` zone scan — maps max zone temp to state. AMD nodes use k10temp + clock ratio: ≥95% → Normal, ≥80% → Fair, ≥60% → Serious, <60% → Critical. Tdie >85°C tie-breaker bumps to at least Serious. Source tag: `clock_ratio`.

**Why it matters for inference:** When a node reaches Serious or Critical thermal state, the CPU and GPU are already throttling — silently reducing their clock speeds to manage heat. Your tokens-per-second has dropped 30–50% and you won't see it in CPU/GPU utilization numbers alone. See **Thermal Cost %** above for how to quantify the impact.

**Action:**
- Normal: Healthy. No action needed.
- Fair: Mild throttling beginning. Consider reducing load.
- Serious: Active throttling. Route inference requests to another node.
- Critical: Severe throttling. Stop inference on this node immediately. Check cooling.

> **Pattern link:** **Pattern A — Thermal Performance Drain** fires after 5 minutes of sustained degradation vs. the node's own Normal-thermal baseline. Unlike this state label, Pattern A quantifies exactly how many tok/s are being lost.

---

## CPU Power Draw (W)

**What it is:** The total power draw of the CPU in watts, read via `powermetrics`. Requires `sudo wicklee` on macOS — the kernel does not expose power data to unprivileged processes.

**Why it matters for inference:** Power draw tells you if a node is actually working hard, independent of utilization percentages. A node at 25% CPU utilization but 18W draw is under real sustained load. A node at 25% CPU utilization at 0.8W is nearly idle.

**Action:** Use CPU power draw alongside GPU utilization to understand true node load. High power draw with low utilization often indicates thermal throttling — the node is drawing power but delivering less compute.

> On Linux, GPU power draw is available via NVML without root and is a more useful inference metric than CPU power draw.

---

## GPU Power Draw (W)

**What it is:** The total power draw of the GPU in watts, reported via NVML on NVIDIA hardware. No sudo required.

**Why it matters for inference:** GPU power draw is the raw fuel consumption of your inference workload. Combined with tokens-per-second, it's the basis for the **Wattage / 1K Tokens** efficiency metric. A GPU drawing 400W at 30% utilization is usually a sign of thermal throttling or a misconfigured runtime — the node is consuming power but not delivering proportional compute.

**Action:** Correlate GPU power draw with GPU utilization and tok/s. Power draw should scale roughly with utilization. A large gap between high power draw and low utilization or throughput is a diagnostic signal worth investigating.

---

## Active Model

**What it is:** The name of the model currently loaded in Ollama, along with its quantization level (e.g., `llama3.1:8b Q4_K_M`) and size on disk in GB.

**Why it matters for inference:** Knowing what's loaded tells you the memory footprint committed on this node and directly informs the **Model-to-Hardware Fit Score** — whether this node has enough headroom to run this model efficiently without pressure-induced degradation.

**Action:** If the active model is close to the node's total memory (unified on Apple Silicon, VRAM on NVIDIA), consider switching to a lower quantization to create headroom.

---

## Tokens Per Second (tok/s)

**What it is:** The measured generation throughput of the active model, sampled from Ollama's response stream over a 30-second probe window.

**Why it matters for inference:** Tok/s is the direct measure of inference quality that users experience. It is the output side of every hardware signal Wicklee collects — thermal throttling, memory pressure, VRAM saturation, and CPU/GPU bottlenecks all ultimately show up as a degraded tok/s number.

**Action:** Establish a baseline tok/s for each model/hardware combination. A drop of more than 15–20% from baseline during sustained operation is a signal to investigate thermal state, memory pressure, or competing processes.

**Historical baseline:** Wicklee stores tok/s in DuckDB alongside WES and power. The Performance History chart surfaces P95 tok/s as a dashed reference line on 24h+ time ranges — giving you a statistically grounded ceiling to compare current throughput against rather than relying on memory.

> **Pattern links:**
> - **Thermal Degradation Correlation** insight card fires immediately when `thermal_state` transitions to Serious/Critical, quantifying the tok/s drop.
> - **Pattern A — Thermal Performance Drain** fires after 5 minutes of sustained tok/s degradation vs. Normal-thermal baseline — more specific and quantified than the threshold-crossing card.
> - **Pattern C — WES Velocity Drop** detects falling efficiency before tok/s visibly drops — the early warning signal.

---

## W/1K Tokens — Primary Efficiency Standard

**What it is:** Watts consumed per 1,000 tokens generated — the universal hardware efficiency metric across all inference runtimes and platforms. Calculated as:

```
W/1K = (Power Draw in Watts) / (tok/s) × 1000
```

**Lower is always better.** A lower W/1K means the hardware is producing more tokens for the same electrical input. This is the primary column in the Fleet Status table and the headline in the "WATTAGE / 1K TKN" summary card — chosen over raw watts or raw tok/s because it normalizes for both dimensions simultaneously.

**Why it matters for inference:** This is the true cost of local inference — a metric cloud providers never show you because they don't want you doing the math. At $0.12/kWh, a node drawing 300W generating 50 tokens/sec costs roughly $0.0002 per 1K tokens in electricity. Compare that to $0.90–$15.00 per 1K tokens for GPT-4o or Claude.

**Interpreting values:**
- `< 50 W/1K` — Excellent. Apple Silicon in this range.
- `50–200 W/1K` — Good. Efficient NVIDIA workstation GPUs.
- `200–500 W/1K` — Acceptable for high-throughput NVIDIA inference.
- `> 500 W/1K` — Poor. CPU-only inference or severe thermal throttle.

**Action:** Use W/1K to compare nodes doing the same work. A node at 90.3 W/1K and another at 684.7 W/1K on the same model class — the first is 7.5× more power-efficient regardless of whether one is Apple Silicon and the other is x86.

---

## WES — Wicklee Efficiency Score

**What it is:** A single unitless score that captures true inference efficiency — accounting for thermal throttling, not just raw power draw. Calculated as:

```
WES = tok/s ÷ (Watts_adjusted × ThermalPenalty)
```

**ThermalPenalty lookup (WES v2):**

| Thermal State | Penalty | Notes |
|---|---|---|
| Normal | 1.0 | Hardware running at full capability |
| Fair | 1.25 | Mild throttling beginning |
| Serious | 1.75 | Active throttle — hardware below ceiling |
| Critical | 2.0 | Severe throttle — workload should be moved |

> WES v2 refined the Serious penalty from 2.0 → 1.75 to better reflect measured throttling ratios. Benchmarks taken before v0.4.x should be re-run against the new baseline.

**Why thermal penalty matters:** A node at 89°C running 40 tok/s at 30W looks efficient on paper. But the same node at Normal thermal state would be running 55–60 tok/s at the same power draw — the true efficiency is roughly half what the raw numbers suggest. WES applies the penalty at calculation time so the score reflects what the hardware is actually capable of at its current thermal condition.

**Why it matters for inference:** Wattage/1K Tokens tells you cost per token right now. WES tells you how efficiently the hardware is being used relative to its thermal-adjusted capability. A node with WES 180 and a node with WES 12 are not comparable on the same task — the first is Apple Silicon running cleanly, the second is a CPU-only node under thermal stress.

**Real measurements from the Wicklee fleet:**

| Hardware | Model | tok/s | Watts | Thermal | WES |
|---|---|---|---|---|---|
| Apple M2 | llama3.1:8b | 108.9 | 0.6W | Normal | **181.5** |
| Ryzen 9 7950X | llama3.1:8b | 17.3 | 32.5W (idle probe) | Normal | **0.53** |
| Ryzen 9 7950X | llama3.1:8b | 17.1 | 121.2W (load) | Normal | **0.14** |

Apple Silicon is approximately 340× more WES-efficient than CPU-only inference on the same model.

**Display:** Wicklee shows WES as a unitless score to one decimal place — e.g., "WES 181.5". When tok/s or power data is unavailable, the score displays as "—". Higher is always better.

**Academic grounding:** WES is Wicklee's coined fleet efficiency standard, conceptually aligned with the Stanford / Together AI "Intelligence per Watt" framework (arXiv:2511.07885, Nov 2025), which proposes normalizing AI output quality by energy consumed. WES applies the same lens at the operator layer — measuring real tokens on real hardware under real thermal conditions.

**Historical baseline:** Wicklee stores 90 days of WES samples in DuckDB (cloud backend) and 24h in agent-local `metrics.db`. The WES Trend chart shows penalized WES as a filled area and raw WES (hardware ceiling) as a dashed reference line — the gap between them is **Thermal Cost %** made visual. P95 WES over the selected window is available as a reference line on 24h+ ranges.

**Action:** Use WES to compare nodes across heterogeneous hardware. Don't compare a 4090 to an M2 on raw tok/s — compare their WES scores. A thermally stressed high-end node often has a lower WES than a clean mid-range node. The **Fleet WES Leaderboard** in the Fleet Intelligence panel ranks all nodes live.

> **Pattern link:** A falling WES slope over 10 minutes triggers **Pattern C — WES Velocity Drop**, surfaced as an Observation in the Triage tab before any thermal state transition occurs.

---

## Thermal Cost %

**What it is:** The percentage of potential performance being consumed by heat — expressed as a thermal "tax" on efficiency. Calculated from:

```
Thermal Cost % = (Penalized WES − Raw WES) / Raw WES × 100
```

Or equivalently: `TC% = (1 − 1/ThermalPenalty) × 100`

| Thermal State | Penalty | Thermal Cost % |
|---|---|---|
| Normal | 1.0 | 0% |
| Fair | 1.25 | 20% |
| Serious | 1.75 | ~43% |
| Critical | 2.0 | 50% |

**Why it matters:** It converts the abstract ThermalPenalty into a number that reads like a tax rate. "This node is paying a 43% thermal tax" is immediately legible to any operator. Raw WES is the hardware ceiling — what the node would score if cooling were perfect. Penalized WES is what you're actually getting. TC% is the gap.

**Display:** Amber `-N% thermal` badge in the Fleet Status table when TC% > 0. Hidden when the node is at Normal thermal state. Full breakdown visible in the WES tooltip.

**Action:**
- TC% 0%: No action needed.
- TC% 10–25%: Monitor. Consider reducing load or improving airflow.
- TC% >25%: Significant throttle. Route workloads to a cooler node. Check fan curve and ambient temperature.
- TC% >40%: Critical. The node is delivering less than 60% of its hardware capability.

> **Pattern link:** `ThermalCostAlertCard` fires in Triage at TC% >10% (Info), >25% (Warning), >40% (Critical). Rate-of-change escalation: a rise of ≥15pp in 30 frames bumps severity one level.

---

## Cost / 1K Tokens ($)

**What it is:** The dollar cost per 1,000 tokens generated, derived from Wattage / 1K Tokens and your configured electricity rate ($/kWh) in Settings. Defaults to $0.12/kWh if not set.

**Why it matters for inference:** Wattage/1K tokens is hardware-agnostic. Cost/1K tokens is what you actually pay. The same wattage means different dollars depending on whether you're in a home lab in Texas or a colo facility in Singapore. Setting your local kWh rate makes the cost metric precise rather than approximate.

**Action:** Set your electricity rate in **Settings → kWh Rate** to make this metric accurate for your location. If you're running nodes in a datacenter, also set your **PUE Multiplier** (see below) to account for facility overhead.

---

## Idle Fleet Cost / Day

**What it is:** The estimated daily electricity cost of all fleet nodes at idle — when no inference is running but nodes are powered on and available.

**Why it matters for inference:** Idle GPUs still consume 15–80W depending on hardware. Across a multi-node fleet, idle costs accumulate invisibly. This metric makes idle cost explicit so you can decide when it's worth spinning down underutilized nodes.

**Action:** Review the **Idle Fleet Cost** card in the Fleet Intelligence panel. If idle cost exceeds your budget for overnight or weekend periods, consider a scheduled shutdown policy for lightly-used nodes.

---

## PUE Multiplier

**What it is:** Power Usage Effectiveness — a multiplier that accounts for datacenter overhead (cooling, power delivery losses) beyond the raw node wattage. Configured in **Settings → PUE Multiplier**. Defaults to `1.0` (home lab or direct power measurement).

**Why it matters for inference:** A node drawing 100W in a datacenter with PUE 1.4 actually costs 140W of billed power — the extra 40% goes to cooling, UPS losses, and power distribution. Without this adjustment, Idle Fleet Cost and Cost/1K Tokens are understated for colo and cloud bare-metal deployments.

**Typical values:**
- `1.0`: Home lab or measured-at-plug power.
- `1.2–1.4`: Modern hyperscale datacenter.
- `1.4–1.6`: Standard colocation facility.
- `1.6–2.0`: Older or less efficient facilities.

**Action:** Set your PUE in **Settings** if you're running nodes in a datacenter or colocation environment. All cost metrics in the fleet panel update automatically.

---

## Fleet Nodes

**What it is:** The number of active nodes currently paired with your Wicklee fleet.

**Action:** Community Edition supports up to 3 nodes. Team Edition removes this limit and adds cross-node alert integrations, 90-day metric history, and the **Keep Warm** operator feature.

---

## Enterprise Contextual Metrics *(Phase 5)*

These metrics are computed from existing telemetry + operator-configured context. No new agent instrumentation required.

---

### Cost Allocation

**What it is:** Actual electricity cost attributed to a node over a time window, broken down by model and workload type.

**Formula:**
```
Cost($) = kWh_consumed × electricity_rate
        = (watts × hours / 1000) × $/kWh × PUE

Per-token cost = Cost($) / tokens_generated

WES-normalized cost = Cost($) / WES    // lower = more efficient per efficiency unit
```

**Why it matters:** At fleet scale, idle vs. active power draw diverges significantly across hardware generations. A 4090 idle at 50W costs more per hour than an M2 running inference at full throughput. Cost Allocation makes this explicit — operators can charge back inference cost per department, per model, or per time window.

**Data sources:** `watts` from live telemetry × configured `kWh_rate` × `pue_multiplier` from node settings. Token count from `ollama_tokens_per_second` accumulated over the session.

---

### Departmental Multi-tenancy Isolation

**What it is:** Per-department fleet segmentation — each department sees only their assigned nodes' metrics, costs, and alerts. Fleet-wide aggregates visible only to fleet owners.

**Why it matters:** Enterprise teams share inference infrastructure across departments (ML research, product, internal tooling). Without isolation, one team's thermal incident shows up in another team's dashboard. With isolation, each department operates in a clean data boundary: their WES scores, their cost allocation, their alert history.

**Implementation shape:**
- Nodes tagged with `department_id` in Wicklee fleet config
- Clerk organization roles gate which `department_id` values a session can query
- Fleet API responses filtered by `department_id` claim in JWT
- Cost allocation breakdowns grouped by `department_id` in DuckDB aggregates

---

## Prometheus Schema *(Enterprise — Phase 5)*

Wicklee exposes a `/metrics` endpoint in [Prometheus exposition format](https://prometheus.io/docs/instrumenting/exposition_formats/) when `WICKLEE_PROMETHEUS_ENABLED=true`. All metrics are labeled by `node_id`, `hostname`, and `fleet_id`.

### Gauge metrics (current value)

```
# HELP wicklee_wes_penalized Wicklee Efficiency Score with thermal penalty applied
# TYPE wicklee_wes_penalized gauge
wicklee_wes_penalized{node_id="WK-1EFC",hostname="GeiserM2",fleet_id="fl_abc"} 181.5

# HELP wicklee_wes_raw Wicklee Efficiency Score without thermal penalty (hardware ceiling)
# TYPE wicklee_wes_raw gauge
wicklee_wes_raw{node_id="WK-1EFC",hostname="GeiserM2",fleet_id="fl_abc"} 181.5

# HELP wicklee_thermal_cost_pct Percentage of WES lost to thermal throttling
# TYPE wicklee_thermal_cost_pct gauge
wicklee_thermal_cost_pct{node_id="WK-1EFC",hostname="GeiserM2",fleet_id="fl_abc"} 0.0

# HELP wicklee_tokens_per_second Current sampled inference throughput
# TYPE wicklee_tokens_per_second gauge
wicklee_tokens_per_second{node_id="WK-1EFC",hostname="GeiserM2",fleet_id="fl_abc"} 108.9

# HELP wicklee_power_watts Total board power draw in watts
# TYPE wicklee_power_watts gauge
wicklee_power_watts{node_id="WK-1EFC",hostname="GeiserM2",fleet_id="fl_abc"} 0.6

# HELP wicklee_gpu_utilization_percent GPU compute utilization percentage
# TYPE wicklee_gpu_utilization_percent gauge
wicklee_gpu_utilization_percent{node_id="WK-1EFC",hostname="GeiserM2",fleet_id="fl_abc"} 87.0

# HELP wicklee_vram_used_mb VRAM in use in megabytes (NVIDIA only)
# TYPE wicklee_vram_used_mb gauge
wicklee_vram_used_mb{node_id="WK-C133",hostname="GeiserBMC",fleet_id="fl_abc"} 18432.0

# HELP wicklee_vram_total_mb Total VRAM in megabytes (NVIDIA only)
# TYPE wicklee_vram_total_mb gauge
wicklee_vram_total_mb{node_id="WK-C133",hostname="GeiserBMC",fleet_id="fl_abc"} 24576.0

# HELP wicklee_memory_pressure_percent Kernel memory pressure score (Apple Silicon only)
# TYPE wicklee_memory_pressure_percent gauge
wicklee_memory_pressure_percent{node_id="WK-1EFC",hostname="GeiserM2",fleet_id="fl_abc"} 32.0

# HELP wicklee_thermal_penalty Current thermal penalty multiplier (1.0=Normal to 2.0=Critical)
# TYPE wicklee_thermal_penalty gauge
wicklee_thermal_penalty{node_id="WK-1EFC",hostname="GeiserM2",fleet_id="fl_abc"} 1.0
```

### State label metrics

```
# HELP wicklee_thermal_state_info Thermal state as a label (info metric, value always 1)
# TYPE wicklee_thermal_state_info gauge
wicklee_thermal_state_info{node_id="WK-1EFC",hostname="GeiserM2",thermal_state="normal"} 1

# HELP wicklee_node_status_info Node online/offline status (1=online, 0=offline)
# TYPE wicklee_node_status_info gauge
wicklee_node_status_info{node_id="WK-1EFC",hostname="GeiserM2"} 1
```

### Scrape configuration example

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'wicklee'
    static_configs:
      - targets: ['wicklee.your-infra.internal:7700']  # self-hosted control plane
    bearer_token: '<enterprise_api_key>'
    scrape_interval: 15s
    metrics_path: /metrics
```

> Pre-built Grafana dashboard JSON available at `docs/grafana-dashboard.json` (Phase 5).

---

## Platform Coverage

Wicklee is designed to work across all major inference platforms without compromise:

| Metric | Apple Silicon | NVIDIA Discrete | NVIDIA GB10 (Grace Blackwell) | AMD / Intel Linux |
|---|---|---|---|---|
| CPU usage | ✅ sudoless | ✅ sudoless | ✅ sudoless | ✅ sudoless |
| Memory used / available | ✅ sudoless | ✅ sudoless | ✅ sudoless | ✅ sudoless |
| Memory pressure | ✅ IOKit | — | — | — |
| GPU utilization | ✅ AGX via ioreg | ✅ NVML | ✅ NVML | — |
| VRAM used / total | ✅ wired budget (iogpu) | ✅ NVML | ✅ process residency | — |
| GPU temperature | — | ✅ NVML | ✅ NVML | — |
| GPU power draw | — | ✅ NVML | ✅ NVML | — |
| Thermal state | ✅ IOKit | ✅ NVML bitmask | ✅ NVML bitmask | ✅ clock ratio / sysfs |
| CPU power draw | ⚠️ sudo | ⚠️ sudo | ✅ NVML SoC power | ✅ RAPL sudoless |
| Active model (Ollama/vLLM) | ✅ sudoless | ✅ sudoless | ✅ sudoless | ✅ sudoless |
| Tokens per second | ✅ sudoless | ✅ sudoless | ✅ sudoless | ✅ sudoless |
| WES | ✅ full | ✅ full | ✅ full | ✅ full (RAPL power) |
| Thermal Cost % | ✅ | ✅ | ✅ | ✅ |

---

*Have a question about a metric not covered here? [Open an issue on GitHub](https://github.com/Wicklee/wicklee/issues).*
