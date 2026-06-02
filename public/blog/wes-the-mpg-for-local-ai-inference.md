---
title: "WES: The MPG for Local AI Inference"
date: "2026-03-15"
description: "tok/s tells you how fast. Watts tells you how hungry. WES tells you if the tradeoff is actually worth it."
tags: ["efficiency", "inference", "observability", "wes"]
---

# WES: The MPG for Local AI Inference

tok/s tells you how fast your model is running. Watts tells you how much power it's drawing. Neither of those numbers alone tells you whether the tradeoff is worth it.

WES — the Wicklee Efficiency Score — is the number that does.

## The Formula

```
WES = tok/s ÷ Watts
```

A node generating 45 tok/s at 180W scores **0.25 WES**. A node generating 180 tok/s at 120W scores **1.5 WES**. Same wall socket. Six times the useful throughput per watt.

That's the gap WES makes visible.

## Why Thermal State Changes Everything

Raw WES is a snapshot. **Penalized WES** is the honest number.

When hardware runs hot, silicon throttles. A GPU that normally produces 1.8 WES at normal thermal state can drop below 1.0 WES when it's serious or critical — even while drawing identical power. The throughput loss is real. The energy cost isn't lower. That delta is what we call **Thermal Cost %**:

```
Thermal Cost % = (Raw WES − Penalized WES) / Raw WES × 100
```

The penalty table:

| Thermal State | Penalty Multiplier | Effective Loss |
|---|---|---|
| Normal | 1.0× | 0% |
| Fair | 1.25× | ~20% |
| Serious | 1.75× | ~43% |
| Critical | 2.0× | 50% |

A node showing 40% Thermal Cost has lost nearly half its efficiency to heat — and it's still drawing full power. That's the real cost of an undersized cooling setup.

## Four Nodes, One Leaderboard

Here's what a typical heterogeneous fleet looks like after an hour of inference load:

| Node | Chip | tok/s | Watts | Thermal | WES |
|---|---|---|---|---|---|
| studio-01 | Apple M2 Ultra | 89 | 60W | Normal | **1.48** |
| devbox-02 | RTX 4090 | 180 | 340W | Fair | **0.42** |
| lab-03 | RTX 3080 | 92 | 220W | Serious | **0.24** |
| spare-04 | Intel i9 CPU | 12 | 95W | Normal | **0.13** |

The RTX 4090 produces more tokens per second than every other node combined. But the M2 Ultra delivers 3.5× better efficiency per watt — and does it silently, with no fan noise and no thermal throttle risk.

WES doesn't tell you which node to use. It tells you the tradeoff clearly enough that you can make the call yourself.

## The Academic Grounding

WES is derived from the **IPW (Inference Performance per Watt)** metric introduced in *"Benchmarking LLM Inference on Edge Devices"* (arXiv:2511.07885). The core formula — throughput normalized to power draw — was designed specifically for heterogeneous hardware comparisons where peak throughput numbers mislead by ignoring energy cost.

We added the thermal penalty layer because raw IPW assumes a steady state. Real hardware doesn't operate at steady state under sustained load.

## What Good Looks Like

| WES Range | Rating | Color |
|---|---|---|
| > 10 | Excellent | Emerald |
| 3–10 | Good | Green |
| 1–3 | Acceptable | Yellow |
| < 1 | Low | Red |

Apple Silicon M-series chips routinely score 10–20+ thanks to their ultra-low power draw (1–3W SoC power at idle inference). A well-cooled RTX 4090 at inference sits in the 1–3 range. CPU-only inference on high-wattage chips (EPYC, Xeon) typically scores below 3.

## Best-Node Selection with WES

`GET /api/v1/route/best` returns two candidates: the **latency** pick (highest tok/s) and the **efficiency** pick (highest penalized WES). The default recommendation is efficiency — the node that gives you the most output per watt.

For latency-critical paths, use the latency pick. For background batch jobs, the efficiency pick gives you the most output per dollar of electricity. Both are returned in every response — the tradeoff is always visible.

Wicklee tells you which node is best. You decide whether to route to it. We're never in your request path; we're the data source for the routing decisions your gateway or proxy actually makes.

## What's shipped since this post

A few things landed between the original WES design and now:

- **Multi-model WES** — when 2+ models are loaded concurrently in Ollama, each gets its own WES score using proportional VRAM share for power attribution. You can finally answer "is qwen2.5:7b faster than llama3.2:8b on this box?" with real numbers.
- **Inference Profiler** (`GET /api/profile`) — correlates TTFT, KV cache, queue depth, thermal, and power on a single timeline. Useful for diagnosing *why* WES dropped, not just *that* WES dropped.
- **Runtime Config Surface** (v0.9.0) — one click to inspect each node's exact launch parameters (context size, GPU layers, system prompt, quantization) across Ollama, vLLM, and llama.cpp. Diff configs across nodes when their WES diverges. [Read more →](/blog/runtime-config-surface)
- **Model Discovery with fit scoring** — type a HuggingFace model, see every GGUF quant ranked against *your* hardware's available VRAM. Pull command pre-filled.
- **Install simplification** (v0.8.x) — no sudo on install. The agent goes to `~/.wicklee/bin/wicklee` and you can try it before granting root.

## Try it

```bash
curl -fsSL https://wicklee.dev/install.sh | bash
~/.wicklee/bin/wicklee
```

No sudo. No account required. Local dashboard opens at `http://localhost:7700` with live WES values, the per-node leaderboard, and Thermal Cost % visible at a glance.

Want the agent to run on every boot?

```bash
sudo ~/.wicklee/bin/wicklee --install-service
```

That's the only step that needs root. WES, the leaderboard, multi-model WES, and Thermal Cost % are all available on the free Community tier — no upgrade required.

---

*WES scores update live from your fleet's SSE telemetry. Open source under FSL-1.1-Apache-2.0 (converts to Apache 2.0 after 4 years). See the [source code](https://github.com/jeffgeiser/Wicklee).*
