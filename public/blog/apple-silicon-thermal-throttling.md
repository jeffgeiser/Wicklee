---
title: "Apple Silicon Thermal Throttling: What Other Monitors Miss"
date: "2026-05-28"
description: "Your M2 Max is throttling and you don't know it. Activity Monitor shows green. Wicklee reads the same IOKit classes Apple itself uses — here's how, and why it matters for local AI inference."
tags: ["apple-silicon", "thermal", "inference", "monitoring", "macOS"]
---

# Apple Silicon Thermal Throttling: What Other Monitors Miss

You're running Llama 3.2 8B on your M2 Max in a fanless studio enclosure. The dashboard says GPU utilization is at 84%, memory looks fine, and tokens-per-second is hovering around 32. Four hours into a long generation task, latency creeps up. You check Activity Monitor — everything is green. You check `top` — nothing obvious. You check the temperature using `iStat` or `Stats` — chip temperature is 78°C, "warm but not hot."

The model is still running. The numbers look fine. But it's slower than it was three hours ago.

What you can't see, from any of those tools: the silicon is already throttling. It crossed `Normal` thermal state into `Fair` about 90 minutes ago. Apple's own firmware classified the workload as exceeding sustained-load thresholds and dialed back clock speeds to manage heat. Your real available throughput is now about 75% of what it was at startup. The benchmarks you ran when you first set this node up don't apply anymore.

This isn't a hardware bug. It's how Apple Silicon is supposed to work. The problem is that nothing you're looking at tells you it's happening.

## How Apple Silicon actually reports thermal state

macOS exposes thermal state through a system framework called IOKit. The relevant interface is `IOPMCopyCPUPowerStatus`, which returns a dictionary including a key called `CPU_Speed_Limit` — an integer where `100` means "running at full rated clock" and lower values indicate throttling to manage thermal or power constraints.

But more importantly for our purposes, the OS classifies the *overall* thermal pressure as one of four states:

| State | What it means | Performance impact |
|---|---|---|
| **Normal** | Sustained workload within thermal envelope | Full rated performance |
| **Fair** | Workload approaching sustained-load limits | ~10-20% throttle starting |
| **Serious** | Sustained throttling active | ~30-45% throttle |
| **Critical** | Aggressive throttling to prevent damage | 50%+ throttle |

This classification is *the chip's own assessment*. It's not a generic threshold; it's the same signal Apple's own software uses internally to manage workload scheduling. iOS uses it to defer background tasks. macOS uses it to slow Spotlight indexing under load. It's authoritative.

You can read it from the command line:

```bash
pmset -g therm
```

Output looks like:

```
CPU_Scheduler_Limit  = 100
CPU_Available_CPUs   = 12
CPU_Speed_Limit      = 100
```

When the chip is under sustained inference load and the enclosure can't shed heat fast enough, `CPU_Speed_Limit` drops below 100 and the thermal state moves from Normal into Fair, Serious, or Critical.

## Why your existing tools don't show this

**Activity Monitor** doesn't surface IOKit thermal classes at all. It shows you process-level CPU and memory usage. It has no concept of "the silicon is throttling."

**`iStat` / `Stats` / similar** show you raw temperature sensor readings. That's useful but incomplete — temperature alone doesn't tell you whether the chip is throttling. A well-cooled M2 Max can run at 82°C and stay in Normal state. A poorly-cooled one can throttle at 71°C if the ambient is warm or the workload pattern triggers sustained-load detection.

**`powermetrics`** is the closest thing — Apple's own diagnostic tool that exposes detailed power and thermal telemetry. It requires root. It outputs an enormous stream of data including thermal state. But it's not designed for continuous monitoring; it's designed for diagnostic snapshots. Most monitoring tools that integrate with macOS don't bother with it because it requires the agent to run as root.

**Datadog, Grafana Cloud, and other generic observability tools** either don't collect macOS-specific thermal state at all, or surface it as a single temperature reading that misses the throttling classification.

## What this means for local AI inference

Apple Silicon is genuinely excellent for local inference. The unified memory architecture means you can load larger models than the VRAM number would suggest on a discrete GPU. The SoC efficiency is striking — an M2 Ultra can hit 1.5 WES (tokens per watt) on Llama 3.2 8B Q4 where an RTX 4090 might only hit 0.4 WES on the same workload.

But it's also thermally constrained in a way most users don't appreciate until they hit it. Macs are designed for *bursty* workloads — compile a project, render a video clip, play a 30-minute game. Sustained inference for hours is different. Apple Silicon will protect the chip by throttling, and unless you're explicitly watching for it, you won't notice until the latency degradation becomes obvious to your end users.

The signal you want is: **WES dropped by 35% over the past 90 minutes** AND **thermal state moved from Normal to Fair around the time the drop started**. That correlation tells you it's a thermal problem, not a model-loading problem or a power-supply problem or a kernel scheduling issue.

## How Wicklee surfaces this

Wicklee runs as a LaunchDaemon (root, because `powermetrics` requires it) and samples thermal state every 2 seconds. The data flows into:

- A **thermal penalty multiplier** applied to the WES calculation. Normal multiplies by 1.0, Fair by 1.25, Serious by 1.75, Critical by 2.0. The "Penalized WES" you see in the dashboard is the honest number — it already accounts for throttling losses.
- A **Thermal Cost %** that quantifies "how much efficiency are you losing to heat right now?" A node showing 40% Thermal Cost has lost nearly half its potential throughput to throttling, even though it's still drawing full power.
- **Patterns** that fire when thermal state degrades. The agent watches for sustained `Fair` or worse over a 5-minute window and emits a `thermal_drain` observation. You see the alert before the user-facing latency does.

In practice, here's what a throttling event looks like through Wicklee's eyes:

```
T+0:00  Normal | WES 12.8 | tok/s 32 | SoC 2.5W
T+0:30  Normal | WES 12.7 | tok/s 32 | SoC 2.6W
T+1:00  Normal | WES 12.5 | tok/s 31 | SoC 2.7W
T+1:30  Fair   | WES 10.1 | tok/s 31 | SoC 3.1W   ← thermal state flipped
T+2:00  Fair   | WES  9.4 | tok/s 28 | SoC 3.1W
T+2:30  Fair   | WES  9.2 | tok/s 27 | SoC 3.0W
```

At T+1:30, the chip transitioned to Fair. Throughput hasn't visibly dropped yet — tok/s is still 31. But WES has fallen significantly because the penalty multiplier kicked in. By T+2:00, you can see tok/s starting to actually drop. By T+2:30, the workload is producing 16% less throughput than at the start, drawing 20% more power.

If you're watching tok/s alone, the slowdown looks gradual and ambiguous. If you're watching WES with thermal awareness, the cause is immediate and obvious — and you have a 30-second lead time on the user-visible degradation.

## Practical implications

If you're running an M2/M3/M4 Mac as a serious local inference node, three things help:

1. **Improve cooling.** A passive aluminum heatsink case helps. A small USB fan blowing across the chassis helps more. A fanless studio enclosure in a warm room is the worst combination.
2. **Watch for sustained-load thresholds.** Apple Silicon enters Fair faster under continuous load than under bursty load. If your inference traffic is steady, you'll see throttling sooner than your benchmark numbers suggest.
3. **Use a monitoring tool that actually reads thermal state.** This is the part most monitors get wrong.

## Try it on your Mac

Wicklee installs in 60 seconds. No sudo for the install itself; only the optional service registration requires root (to read `powermetrics`).

```bash
curl -fsSL https://wicklee.dev/install.sh | bash
sudo ~/.wicklee/bin/wicklee --install-service
```

Open `http://localhost:7700`. The dashboard shows current thermal state, Penalized WES, and Thermal Cost % live. If you've never looked at thermal data for your Mac under sustained inference load, the numbers will probably surprise you.

---

*Wicklee is open source under FSL-1.1-Apache-2.0 (converts to Apache 2.0 after 4 years). Source on [GitHub](https://github.com/jeffgeiser/Wicklee).*
