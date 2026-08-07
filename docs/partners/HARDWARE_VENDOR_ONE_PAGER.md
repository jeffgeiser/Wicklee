# Wicklee × Hardware Partners — One-Pager

> Outreach copy for vendors and integrators selling local-AI hardware
> (DGX/Spark-class boxes, workstation builders, Apple-focused MSPs).
> Paste-ready; trim to taste per recipient.

---

## Every box you sell ships with a fleet dashboard

Your customers buy hardware to run AI privately. The first question after
unboxing is "is it working, and is it worth what we paid?" — and today the
answer is `nvidia-smi` in a terminal. Wicklee turns the box you sell into a
monitored, benchmarked, cost-accounted fleet node in one command:

```bash
curl -fsSL https://wicklee.dev/install.sh | bash
```

One Rust binary. Apple Silicon and NVIDIA. Ollama, vLLM, and llama.cpp
detected automatically. Dashboard on the customer's own machine in under a
minute — no account required until they want fleet aggregation.

## What your customers see

- **WES — "the MPG for local AI":** tokens per watt with thermal penalty, so
  they can prove the box delivers. Measured, not vendor benchmarks.
- **Live hardware + inference telemetry:** power, thermals, throughput, TTFT,
  model fit — per node and per model.
- **Cost governance:** $/1M tokens from measured watts, chargeback by team,
  idle-waste recovery. The numbers a CFO asks for after the purchase.
- **Enterprise controls** (Business tier): SSO/SAML, RBAC, append-only audit
  with SIEM streaming, SLOs with error budgets, self-hosted control plane for
  air-gapped environments. Posture: wicklee.dev/trust.

## Why bundle it

- **Your sale gets stronger:** "it ships monitored" answers the ops objection
  in the deal, and the WES numbers let the customer verify the hardware
  performs as sold — with your box looking good on a public, measured scale.
- **Sovereign by architecture:** hardware telemetry only; prompts, responses,
  and templates never leave the node — structurally. Safe to put in front of
  your regulated customers (full data-flow: wicklee.dev/trust).
- **Zero integration work:** the installer handles service registration; a
  pairing code connects the node to the customer's fleet. Nothing for your
  imaging pipeline beyond one line.

## The partnership

- Bundle or pre-image the agent on shipped systems; we co-publish the
  benchmark story for your hardware ("measured tok/s, watts, and $/1M tokens
  on <your box>").
- Margin on Team ($49/seat/mo) and Business ($499/mo) subscriptions
  originating from your boxes.
- Your logo on wicklee.dev; joint case study with a launch customer.

**Contact:** sales@wicklee.dev · live demo without installing: see the demo
fleet linked from wicklee.dev
