---
title: Wicklee Fleet Demo
emoji: 🕯️
colorFrom: indigo
colorTo: gray
sdk: static
app_file: index.html
pinned: false
license: mit
short_description: Live demo of Wicklee — hardware-first observability for local AI fleets
tags:
  - observability
  - local-llm
  - ollama
  - vllm
  - gpu
---

# Wicklee — Fleet Demo

A synthetic six-node GPU fleet streaming live into the real Wicklee
dashboard: **WES** (tokens per watt, with a thermal penalty), thermal
throttling, model swaps, cost and $/1M-token chargeback, SLO error budgets.

Nothing here is mocked screenshots — it is the production dashboard bundle
running against a deterministic synthetic fleet, so every tab behaves the way
it does on real hardware.

| Node | What to watch |
|---|---|
| Studio · M4 Max | healthy Apple Silicon production inference |
| Rig A / Rig B · 4090 | `env:prod` pair; Rig B swaps models every ~2.5 min |
| DGX · H100 | large model, high throughput |
| Mini · M2 | thermally throttles every ~4 min — watch the WES penalty land |
| Edge · 4060 | drops offline for 40 s every 5 min |

Install on your own nodes:

```bash
curl -fsSL https://wicklee.dev/install.sh | bash
```

→ [wicklee.dev](https://wicklee.dev) · [Trust & data flow](https://wicklee.dev/trust) · [Design-partner program](https://wicklee.dev/design-partners)
