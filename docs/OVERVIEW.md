# Wicklee: Overview

**November 2026**

An overview for readers new to the project. `docs/STRATEGY.md` holds the full strategic reasoning; `docs/PHASE1_SPEC.md` holds the implementation detail.

**A note on status.** Wicklee is a working open-source agent today, and it is being rebuilt around the direction described here. This document marks clearly what exists and what is planned. Nothing in the planned column should be read as shipping.

---

## In one paragraph

Wicklee is the evidence layer for self-hosted AI inference. It runs on the machine serving your models, observes what is actually happening, and answers three questions that neither the inference runtime nor a general observability stack answers well: what is wrong right now, what can run safely at this moment, and did the change I made actually help. It is open source, local-first, and deliberately does not route traffic, schedule work or manage infrastructure.

---

## The problem

Managed model APIs hide the infrastructure. Self-hosted inference does not.

When you run your own models, a set of constraints appears that most AI tooling has no vocabulary for. Models compete for finite accelerator memory. Loading and unloading cost seconds. A context-length change silently alters a model's memory footprint, pushing part of it onto the CPU and cutting throughput by an order of magnitude. Several autonomous workflows contend for the same capacity, evicting each other's models in a loop that nobody is watching.

This is increasingly the normal case. Agents run many models rather than one. They run them in sequence, in parallel, and on hardware the operator owns.

The evidence for all of these conditions usually exists somewhere, scattered across runtime responses, system metrics and logs. What is missing is the translation from raw telemetry into what it means for a particular workload.

**Collecting metrics is not the same as understanding what those metrics mean.** A GPU utilization graph does not tell you that your agent's third step reloads a model every single run because the keep-alive is shorter than the gap between steps.

---

## What Wicklee does

### Find, fix, verify

The product experience is a loop, not a dashboard.

**Find.** `wicklee inspect` reports conditions it can support with evidence: a model running partly on the CPU and when that started, two models evicting each other repeatedly, a model reloading on every workflow run, a measured regression against a stored baseline.

**Fix.** Each finding carries a suggested change and, where possible, a reproducible test rather than an optimization claim.

**Verify.** `wicklee verify <finding>` runs that test, you change the configuration, and you run it again. Wicklee prints both runs with medians and ranges and says improved, no measurable change, or worse. "No measurable change" is a normal and frequent answer.

A healthy system produces no findings. That is a correct result, and the tool is built so that saying "nothing is wrong" is a success rather than a failure to justify itself.

### The evidence ladder

Every statement Wicklee makes carries one of three labels, and the labels are enforced in code rather than by editorial care:

- **Observed** — Wicklee saw it. Requires a concrete transition, sample or measurement behind it. Never states a cause.
- **Inferred** — a plausible explanation built on an observation. Must be hedged.
- **Verified** — confirmed by measurement, with the number and its range.

A finding with only inferred statements is never shown. A specific model is never named as the cause or victim of something unless the evidence names it. When a check could not run because the runtime does not expose the necessary field, the output says so rather than estimating.

This is the discipline that most AI infrastructure tooling skips, and it is the reason to trust the output enough to act on it.

### Readiness for agents

The second half of the product is what makes it worth keeping installed.

An agent about to run a step needs to know more than whether a model is installed. It needs to know whether using that model will stall for a load, or evict a model another workflow is actively using. Wicklee answers in four states — ready now, requires loading, may require eviction, cannot determine — plus whether the model itself is currently busy, how long loads have historically taken, and what would likely be displaced.

Crucially, it is honest about the limits of that last answer. Which model a runtime will evict is genuinely uncertain, so displacement carries three certainty levels, and a model is named only when runtime history or a single-candidate situation justifies it. Consumers must work correctly when the answer is "something will be evicted but I cannot tell you what."

Readiness is exposed over MCP as read-only tools, over HTTP for controllers, and on the command line.

### The four primitives underneath

| Primitive | Question |
| --- | --- |
| **State** | What is available and constrained right now? |
| **Quote** | What is this workload likely to require? |
| **Prepare** | What should be ready for upcoming work? |
| **Receipt** | What actually happened? |

State and Receipt are the first stage. Quote and Prepare — workload preflight and advisory model-residency planning — come later, once there is enough measured evidence to calibrate a prediction rather than guess at one.

Receipts come from three sources, preferring the least invasive: the calling application posting the runtime's own completion metadata back to Wicklee, Wicklee's own consented benchmark runs, or an optional metadata-only proxy. No prompt or response content is ever read or stored.

---

## Where it sits

```
Applications and agents     declare intent — which models are acceptable, what the work is
Resource controllers        decide and coordinate — apply policy, pick an option
Wicklee                     supply evidence — readiness, constraints, diagnoses, outcomes
Inference engines           serve and execute — Ollama, vLLM, Dynamo, SGLang
```

Wicklee occupies one layer and stays in it. It does not authorize workloads, reserve capacity, route requests or decide what a model is good for. The application decides which models are acceptable substitutes for a task; Wicklee never judges whether two models are equivalent in quality.

This boundary is a product decision, not modesty. It is what makes Wicklee usable alongside NVIDIA Dynamo, a Kubernetes operator or a bespoke gateway rather than in competition with them. Dynamo optimizes the inference it manages. Wicklee helps the software above it understand inference conditions across infrastructure that may span several independently managed runtimes.

---

## What exists today, and what is planned

| | Today | Planned |
| --- | --- | --- |
| **Agent** | Rust, ~15k lines, single binary, Linux and macOS. Polls Ollama every five seconds, reads model details, runs a throughput probe | Residency tracking per model with a transition log |
| **Storage** | Embedded DuckDB with tiered metrics, request traces and events | Transitions, receipts and findings tables |
| **Diagnostics** | Hardware pattern engine: thermal, swap and memory pressure | Inference-specific rules with evidence labels and finding IDs |
| **Readiness** | — | Four-state readiness with displacement certainty |
| **Measurement** | Optional metadata-only proxy capturing request traces | Receipts from callbacks, consented benchmarks and the proxy; `fingerprint` and `verify` |
| **Agent interface** | MCP server, six tools | Three read-only tools for state, readiness and findings |
| **Interface** | Embedded web dashboard, HTTP API | CLI subcommands as the primary surface; a minimal debug page replaces the embedded dashboard |
| **Runtimes** | Ollama, with partial vLLM and llama.cpp harvesting | Ollama first; additional adapters in a later stage |

The direction of travel is deliberate: away from a dashboard a human watches, toward a command and an API that a developer and an agent both consume. The embedded dashboard is being removed from the agent binary.

---

## How this gets validated

The project rests on three hypotheses, treated as independent. Failing one does not invalidate the others.

**Diagnostic usefulness.** Inference-specific evidence and reproducible verification help developers find and fix problems better than their existing tools. Tested by injecting known faults and checking detection accuracy, by running a healthy control system to measure false positives, and by requiring that each finding says something the runtime's own status command and a short script would not.

**Agent decision value.** Software makes better operational decisions with trusted readiness evidence. Tested with a reference controller against a meaningful baseline — not "no information", but a native loaded-model check, which is what a competent developer would write in a few lines. Wicklee only wins in cases that check cannot see. A result showing it rarely wins on a given class of hardware is a valid, publishable finding.

**Cross-runtime value.** Organizations running several independent serving environments benefit from one way to understand readiness and outcomes. Not yet tested; this is the enterprise thesis.

The validation standard is deliberately strict because the product's only asset is credibility about what it knows.

---

## Who it is for

**Initially:** developers and small platform teams running several self-hosted models on one to four inference hosts, where loading overhead, memory limits and residency contention are felt daily. Simple enough to experiment in, complex enough that infrastructure awareness changes decisions.

**Later:** enterprise AI platform teams, private agent-platform operators, and inference reliability teams running privately controlled inference across multiple runtimes, clusters or regions.

**Not the target:** teams consuming only public model APIs, single-model chat users, and large homogeneous clusters where existing serving and observability systems already answer these questions.

---

## Why now

Three things are converging.

Agent frameworks have moved from single-model chat to multi-model workflows, which is what turns model residency from a non-issue into the dominant cost. Capable open-weight models now run on hardware a small team can own, so self-hosting is a real choice rather than a research exercise. And the tooling around private inference is still built on the assumption that a human is watching a dashboard, at the moment when the consumer of that information is increasingly software.

The gap is a component that tells the software layer the truth about its hardware, with enough honesty about uncertainty to be trusted.

---

## Commercial posture

Wicklee is an adoption-first open-source project rather than a validated commercial business, and it is being run that way on purpose. Paid tiers introduced earlier this year have been withdrawn pending a monetization plan grounded in actual usage.

The agent is Apache 2.0. Hosted fleet components and the site carry a source-available license. Local use will never require a Wicklee-operated cloud service, and the planned coordination layer for multiple hosts is designed to be self-hostable.

Plausible future revenue sits in fleet coordination, enterprise administration, support and compliance-oriented operations — but the sequence matters. Commercial priorities should come from organizations already relying on the project, not from a pricing page written in advance of usage.

---

## Founder

Wicklee is built by Jeff Geiser and operated as a company separate from his employment.

His day job is at Zenlayer, where he works on enterprise inference with customers and is moving into the CTO role for the US and Europe from Head of Solutions Engineering. That work is the origin of the problem Wicklee addresses: enterprises deploying private inference consistently discover that their applications have no reliable way to understand what their own infrastructure can deliver, and that the gap shows up as unexplained latency and failed assumptions rather than as a clean monitoring alert.

Wicklee is developed independently of Zenlayer, on his own hardware and time, and is not a Zenlayer product.

---

## Links

- Repository and documentation: `github.com/jeffgeiser/Wicklee`
- Site: `wicklee.dev`
- Strategy: `docs/STRATEGY.md`
- Implementation specification: `docs/PHASE1_SPEC.md`
