---
title: "Hardware-Aware Observability for Self-Hosted AI"
date: "2026-05-28"
description: "Generic observability stops at 'GPU at 80%.' Self-hosted AI needs to see deeper — SoC power, thermal penalties, per-model VRAM, inference state. Here's what hardware-aware means and why it matters."
tags: ["observability", "architecture", "positioning", "manifesto"]
---

# Hardware-Aware Observability for Self-Hosted AI

It's Tuesday afternoon. Your customer-facing LLM is slow. Latency is up 40% on the production endpoint. You open your observability tool — the one you pay $X,000 a month for.

It tells you the GPU is at 78%. CPU at 23%. Memory looks fine.

So why is the model slow?

## What generic observability sees

Datadog, Grafana Cloud, New Relic, Honeycomb — all excellent tools. They were built for a world of stateless web services and Kubernetes pods. They report what they were designed to report:

- **GPU utilization percentage** — a single number, averaged over an interval
- **GPU memory used vs total** — coarse-grained
- **CPU and host memory** — the same primitives they collect for any workload
- **Process counts and restart events**

These metrics answer a specific class of question: *is the system up and roughly using its capacity?* They were never designed for: *why is this LLM slow right now, on this specific hardware, with this model loaded?*

## What hardware-aware observability sees

That second question requires seeing several things generic tools structurally can't:

**Combined SoC power on Apple Silicon.** A Mac Studio doesn't have discrete GPU power telemetry the way an NVIDIA card does. The chip is one piece of silicon with CPU + GPU + ANE cores sharing a power budget. The relevant number is the combined SoC power, reported via `powermetrics` (which requires root). Without it, you can't compute tokens-per-watt for any Apple Silicon node. Generic tools either don't collect this or surface it generically as "CPU power" which is wildly wrong for inference workloads where the GPU portion dominates.

**Thermal state classification, not raw temperature.** Apple Silicon, NVIDIA, and modern Intel CPUs all report a *thermal state* — `Normal`, `Fair`, `Serious`, `Critical` — that classifies whether silicon is currently throttling clock speeds to manage heat. This is hardware-level intelligence the chip's own firmware computes. A node showing 75°C might be Normal (no throttling) or Serious (already losing 40% throughput) depending on context, cooling, sustained load. Surface area, ambient temperature, prior workload — all factor in. Hardware tells you the answer; generic tools throw away the answer and show you 75°C.

**Per-model VRAM attribution.** When you load two models concurrently in Ollama — say a 7B chat model and a 1.5B embedding model — Datadog sees "GPU memory at 14 GB / 24 GB." That's true and useless. You want to know that the chat model takes 12 GB and the embedding model takes 2 GB, so when chat latency degrades, you know whether the embedding model is a contributor (it's not) or whether your context is just growing (it is). This requires understanding the runtime's `/api/ps` output, watching memory allocation events, attributing power draw by VRAM share.

**Inference state machine.** Is the GPU at 80% because real inference is happening, or because a maintenance probe is running, or because the runtime is loading a model into memory? These are three completely different states with three completely different responses. Wicklee classifies them as `live`, `idle-spd`, `busy`, `idle` — and the classification uses *attribution*, not just thresholds (e.g., distinguishing a user request from the agent's own 20-token probe).

**Multi-runtime understanding.** Ollama, vLLM, and llama.cpp all expose telemetry differently. vLLM exposes Prometheus-format metrics including queue depth, KV cache utilization, and per-request histograms. Ollama exposes none of that natively. llama.cpp has yet a third surface. A generic monitor either treats them all as "a process called X" or requires you to build custom integrations per runtime. Hardware-aware means: detect the runtime, parse its native telemetry, surface the same metrics consistently regardless of which one you're running.

## Why generic tools structurally can't see this

It's not that Datadog *couldn't* add these features. It's that Datadog serves 50+ workload types — Postgres, Kubernetes, Lambda, microservices — and the cost of going deep on AI-inference-specific telemetry is enormous relative to the slice of their customer base that runs self-hosted AI.

Their architecture is also wrong for this. Datadog's agent reports metrics on a 10-second interval. That's fine for most workloads but inadequate for inference: thermal events happen in 2-3 second windows, queue spikes resolve in under a second, and TTFT regressions need millisecond-level histograms to be useful.

Self-hosted AI doesn't fit their model. It fits a specialized model.

## What hardware-aware looks like in practice

A specialized agent that:

- Reads `powermetrics` on macOS, NVML on NVIDIA, RAPL on Intel/AMD Linux — the real hardware sources, requiring the right capabilities (`cap_sys_ptrace`, `LaunchDaemon`-as-root)
- Polls runtime-specific APIs every 5 seconds — `/api/ps` for Ollama, `/metrics` for vLLM, `/props` for llama-server
- Computes derived metrics that have no native equivalent — WES (tokens per watt with thermal penalty), per-model VRAM share, inference state classification
- Runs as a single small binary with minimal dependencies, on the actual node — not as a sampled SaaS that proxies metrics from a 10-second window

Then exposes that data through standard interfaces:

- **OpenTelemetry exporter** — feeds Datadog, Grafana, Honeycomb, New Relic without replacing them
- **Prometheus scrape endpoint** — drops into existing Prometheus stacks unchanged
- **REST + Webhooks** — for custom dashboards, alerting, automation
- **MCP server** — for AI agents (Cursor, Claude Desktop) to query node state

The model isn't "replace your observability." It's "specialize narrowly, integrate everywhere." Your stack stays standard; you just give it eyes for the hardware layer everyone else ignores.

## What this means for buyers

If you're running self-hosted AI in production today, you probably have *one* of three observability stories:

1. **You haven't set up dedicated monitoring yet.** Your team SSHes into nodes and runs `nvidia-smi` or `top`. This works at 1-3 nodes and falls apart at 4+.
2. **You're stretching a generic tool to fit.** You set up Datadog and watch GPU% climb, but can't answer "why is inference slow" when it does.
3. **You bought a specialized AI observability platform.** Your bill is meaningful. The vendor focuses on prompt-level observability (cost per token, model latency by API endpoint) and treats hardware as a black box.

Hardware-aware observability is the fourth option: deep visibility into the physical layer your AI runs on, fed through the standard interfaces your existing tools already understand. You get the specialized depth without abandoning your stack or paying twice for overlapping coverage.

## Try it

Wicklee runs as a single Rust binary on each node. No agent fleet to manage, no cloud account required for local use.

```bash
curl -fsSL https://wicklee.dev/install.sh | bash
~/.wicklee/bin/wicklee
```

The dashboard opens at `http://localhost:7700`. WES, thermal state, per-model VRAM, inference state machine, and multi-runtime detection are all available on the free Community tier.

For multi-node fleets, the cloud dashboard at `wicklee.dev` aggregates everything across paired nodes. The OpenTelemetry exporter and Prometheus scrape endpoint are available on Team+ tiers for feeding into your existing observability stack.

---

*Wicklee is open source under FSL-1.1-Apache-2.0 (converts to Apache 2.0 after 4 years). Source on [GitHub](https://github.com/jeffgeiser/Wicklee).*
