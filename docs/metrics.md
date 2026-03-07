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

---

## GPU Utilization %

**What it is:** The percentage of GPU compute capacity currently in use. On Apple Silicon, read directly from the AGX accelerator via `ioreg` — no sudo required.

**Why it matters for inference:** This is the most direct signal of whether your inference workload is actually running on the GPU. Low GPU utilization during inference means the model isn't GPU-accelerated, or the runtime is bottlenecked elsewhere.

**Action:** During active inference, GPU utilization should be 60–100%. If it's consistently below 20% while requests are being processed, check your runtime configuration.

---

## Thermal State

**What it is:** The hardware's thermal management status. Reports one of: **Normal**, **Fair**, **Serious**, or **Critical**.

**Why it matters for inference:** When a node reaches Serious or Critical thermal state, the CPU and GPU are already throttling — silently reducing their clock speeds to manage heat. Your tokens-per-second has dropped 30–50% and you won't see it in CPU/GPU utilization numbers alone.

**Action:**
- Normal: Healthy. No action needed.
- Fair: Mild throttling beginning. Consider reducing load.
- Serious: Active throttling. Route inference requests to another node.
- Critical: Severe throttling. Stop inference on this node immediately. Check cooling.

> Phase 3 Sentinel will automatically reroute traffic away from thermally-stressed nodes before you have to intervene manually.

---

## CPU Power Draw (W)

**What it is:** The total power draw of the CPU in watts, read via `powermetrics`. Requires `sudo wicklee` on macOS — the kernel does not expose power data to unprivileged processes.

**Why it matters for inference:** Power draw tells you if a node is actually working hard, independent of utilization percentages. A node at 25% CPU utilization but 18W draw is under real sustained load. A node at 25% CPU utilization at 0.8W is nearly idle.

**Action:** Use CPU power draw alongside GPU utilization to understand true node load. High power draw with low utilization often indicates thermal throttling — the node is drawing power but delivering less compute.

> On Linux, GPU power draw is available via NVML without root and is a more useful inference metric than CPU power draw.

---

## Wattage / 1K Tokens

**What it is:** The electricity cost per 1,000 tokens generated, calculated from power draw and tokens-per-second throughput.

**Why it matters for inference:** This is the true cost of local inference — a metric cloud providers never show you because they don't want you doing the math. At $0.12/kWh, a node drawing 300W generating 50 tokens/sec costs roughly $0.0002 per 1K tokens in electricity. Compare that to $0.90–$15.00 per 1K tokens for GPT-4o or Claude.

**Action:** Use the [Wattage-per-Token Calculator](https://huggingface.co/spaces/Wicklee/Wattage-per-token) to model your fleet's cost against cloud API pricing. The crossover point — where local inference becomes cheaper — is typically around 500K–2M tokens/month depending on your hardware.

---

## Fleet Nodes

**What it is:** The number of active nodes currently paired with your Wicklee fleet.

**Action:** Community Edition supports up to 5 nodes. Team Edition (coming soon) removes this limit and adds cross-node Sentinel rerouting, 90-day metric history, and alert integrations.

---

## A note on Apple Silicon vs. NVIDIA

Wicklee is designed to work on both platforms without compromise:

| Metric | Apple Silicon | NVIDIA (Linux) |
|---|---|---|
| CPU usage | ✅ sudoless | ✅ sudoless |
| Memory | ✅ sudoless | ✅ sudoless |
| Memory pressure | ✅ sudoless | — |
| GPU utilization | ✅ sudoless | ✅ via NVML, sudoless |
| Thermal state | ✅ sudoless | 🔜 Phase 3 |
| VRAM used / total | — | ✅ via NVML, sudoless |
| GPU power draw | — | ✅ via NVML, sudoless |
| CPU power draw | ⚠️ requires sudo | ⚠️ requires sudo |

---

*Have a question about a metric not covered here? [Open an issue on GitHub](https://github.com/Wicklee/wicklee/issues).*
