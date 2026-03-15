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

| WES Range | Interpretation |
|---|---|
| > 10 | Excellent — efficient hardware, low thermal draw |
| 1–10 | Good — typical GPU workload |
| 0.1–1 | Fair — throttling or heavy CPU inference |
| < 0.1 | Poor — thermal runaway or severely underpowered |

Apple Silicon M-series chips tend to land in the 1–5 range. A well-cooled RTX 4090 at inference sits in 0.3–0.8. CPU-only inference typically scores below 0.2.

## Routing With WES

`GET /api/v1/route/best` returns the node with the highest penalized WES score that can accept the requested model. Not the fastest. Not the most available. The most efficient that can actually serve the request.

For latency-critical paths you might prefer the fastest node. For background batch jobs, the highest WES node gives you the most output per dollar of electricity. Both are valid choices — but only when you can see the tradeoff.

That's what WES is for.

---

*WES scores update live from your fleet's SSE telemetry. Penalized WES and Thermal Cost % are available on all Wicklee tiers — no upgrade required. Try it at [wicklee.dev](https://wicklee.dev).*
