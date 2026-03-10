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

> Memory pressure is currently only available on Apple Silicon. Linux and Windows nodes report memory used/available instead.

---

## GPU Utilization %

**What it is:** The percentage of GPU compute capacity currently in use. On Apple Silicon, read directly from the AGX accelerator via `ioreg` — no sudo required. On NVIDIA, read via NVML — also no sudo required.

**Why it matters for inference:** This is the most direct signal of whether your inference workload is actually running on the GPU. Low GPU utilization during inference means the model isn't GPU-accelerated, or the runtime is bottlenecked elsewhere.

**Action:** During active inference, GPU utilization should be 60–100%. If it's consistently below 20% while requests are being processed, check your runtime configuration.

---

## VRAM Used / Total

**What it is:** The amount of dedicated GPU memory in use and total available, reported in GB. Available on NVIDIA GPUs via NVML.

**Why it matters for inference:** VRAM is the hard constraint for NVIDIA-based inference. If VRAM is exhausted, the model spills to system RAM — and inference throughput collapses. Unlike Apple Silicon's unified memory pool, NVIDIA VRAM is a fixed, isolated resource.

**Action:** Keep VRAM usage below 90% for stable inference. If you're consistently near the limit, try a more aggressively quantized model (Q4 instead of Q8) or a smaller parameter count.

> On Apple Silicon, VRAM and RAM are the same unified pool — use Memory Used / Available and Memory Pressure % instead.

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

**What it is:** The hardware's thermal management status on Apple Silicon. Reports one of: **Normal**, **Fair**, **Serious**, or **Critical**.

**Why it matters for inference:** When a node reaches Serious or Critical thermal state, the CPU and GPU are already throttling — silently reducing their clock speeds to manage heat. Your tokens-per-second has dropped 30–50% and you won't see it in CPU/GPU utilization numbers alone.

**Action:**
- Normal: Healthy. No action needed.
- Fair: Mild throttling beginning. Consider reducing load.
- Serious: Active throttling. Route inference requests to another node.
- Critical: Severe throttling. Stop inference on this node immediately. Check cooling.

> Linux thermal state reporting (for NVIDIA nodes) is coming in Phase 3B.

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

> Wicklee's **Thermal Degradation Correlation** insight card automatically tracks the relationship between thermal state transitions and tok/s change over a session, so you don't have to watch both numbers manually.

---

## Wattage / 1K Tokens

**What it is:** The electricity cost per 1,000 tokens generated, calculated from power draw divided by tokens-per-second throughput.

**Why it matters for inference:** This is the true cost of local inference — a metric cloud providers never show you because they don't want you doing the math. At $0.12/kWh, a node drawing 300W generating 50 tokens/sec costs roughly $0.0002 per 1K tokens in electricity. Compare that to $0.90–$15.00 per 1K tokens for GPT-4o or Claude.

**Action:** Use the [Wattage-per-Token Calculator](https://hf.co/spaces/Wicklee/Wattage-per-token) to model your fleet's cost against cloud API pricing. The crossover point — where local inference becomes cheaper — is typically around 500K–2M tokens/month depending on your hardware.

---

## WES — Wicklee Efficiency Score

**What it is:** A single unitless score that captures true inference efficiency — accounting for thermal throttling, not just raw power draw. Calculated as:

```
WES = tok/s ÷ (Watts_adjusted × ThermalPenalty)
```

**ThermalPenalty lookup:**

| Thermal State | Penalty |
|---|---|
| Normal | 1.0 |
| Fair | 1.25 |
| Serious | 2.0 |
| Critical | 2.0+ |

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

**Action:** Use WES to compare nodes across heterogeneous hardware. Don't compare a 4090 to an M2 on raw tok/s — compare their WES scores. A thermally stressed high-end node often has a lower WES than a clean mid-range node. The **Fleet WES Leaderboard** in the Fleet Intelligence panel ranks all nodes live.

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

## A note on Apple Silicon vs. NVIDIA

Wicklee is designed to work across both platforms without compromise:

| Metric | Apple Silicon | NVIDIA (Linux/Windows) |
|---|---|---|
| CPU usage | ✅ sudoless | ✅ sudoless |
| Memory used / available | ✅ sudoless | ✅ sudoless |
| Memory pressure | ✅ sudoless | — |
| GPU utilization | ✅ sudoless (AGX via ioreg) | ✅ sudoless (NVML) |
| VRAM used / total | — (unified memory) | ✅ sudoless (NVML) |
| GPU temperature | — | ✅ sudoless (NVML) |
| GPU power draw | — | ✅ sudoless (NVML) |
| Thermal state | ✅ sudoless | 🔜 Phase 3B |
| CPU power draw | ⚠️ requires sudo | ⚠️ requires sudo |
| Active model (Ollama) | ✅ sudoless | ✅ sudoless |
| Tokens per second | ✅ sudoless | ✅ sudoless |

---

*Have a question about a metric not covered here? [Open an issue on GitHub](https://github.com/Wicklee/wicklee/issues).*
