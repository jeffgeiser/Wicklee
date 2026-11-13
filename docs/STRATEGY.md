# Wicklee: Strategy and Architecture

**Strategic reference · November 2026 · Jeff Geiser**

**Status:** This document is the strategic source of truth for Wicklee. It supersedes the v3.2 brief, `docs/GTM.md` and `docs/NEXT_STEPS.md`. Product capabilities described below include planned functionality and should not all be represented as currently available. `docs/OVERVIEW.md` is the shareable summary of this document. `docs/PHASE1_SPEC.md` is the implementation specification for the first stage.

---

## What changed in this revision

This revision tightens positioning and corrects four things that the v3.2 brief and the Phase 1 spec got wrong or left implicit.

| Change | Was | Now |
| --- | --- | --- |
| Category | Led with "agent-native inference intelligence" as a new category | Leads with the problems solved. The category is *inference evidence and readiness intelligence*; "agent-native" is a descriptive term only |
| Command surface | `inspect`, `fingerprint`, `preflight`, `diff`, `models plan`, `verify` | Stage 1 is `inspect`, `ready`, `findings`, `fingerprint`, `verify`. Preflight and residency planning are Stage 3. `diff` is absorbed into `verify` |
| Receipt sources | Fingerprint runs and the optional proxy | Caller callbacks first, then consented fingerprint runs, then the optional proxy. Aggregate passive observation is labelled separately and is not a receipt |
| Readiness output | Loaded or not, plus what would be displaced | Also reports whether the model itself is busy or contended, separately from whether it is loaded |
| Validation structure | One Phase 1 gate covering diagnostics and agent decisions together | Three independent hypotheses. Failing one does not invalidate the others |

---

## 1. Mission

**Make self-hosted AI inference understandable to the software that depends on it.**

AI applications increasingly operate autonomously, but the infrastructure supporting their models remains largely opaque to the applications themselves.

An agent knows what work it needs to accomplish. An inference engine knows how to execute model requests. But applications and their orchestrators often lack a consistent, evidence-based understanding of what the underlying infrastructure can actually deliver.

Which models are ready? What resources are constrained? Will loading another model disrupt an active workload? What execution performance can reasonably be expected? Why did performance deteriorate?

**Wicklee exists to answer these questions.**

The long-term vision is to become the trusted source of inference readiness, constraints and performance evidence for applications, autonomous agents and infrastructure controllers operating privately managed AI models.

Wicklee is not another inference engine, another agent framework or another infrastructure scheduler.

**It is the evidence layer for self-hosted AI inference.**

---

## 2. Positioning

### Primary product statement

**Know what your inference infrastructure can deliver.**

Wicklee provides evidence-based diagnostics, model readiness, workload assessments and performance verification for self-hosted AI inference.

It helps developers understand what is happening, helps agents anticipate execution constraints, and helps infrastructure controllers make better decisions.

**Open source. Local-first. Controller-neutral.**

### Developer-facing message

**Stop guessing why your local AI is slow.**

Discover inference bottlenecks, understand what your hardware can handle, and verify which changes actually improve performance.

### Agent-facing message

**Your agent has a plan. Is your infrastructure ready?**

Give autonomous applications reliable awareness of model readiness, memory constraints and execution conditions before they start work.

### Enterprise-facing message

**Your inference engines know how to serve models. Does your application know what the infrastructure can deliver?**

Wicklee aims to provide a consistent understanding of inference readiness and performance across independently managed private inference environments.

### Product category

**Inference evidence and readiness intelligence.**

"Agent-native inference intelligence" may be used as a descriptive term, but marketing should lead with the problems solved rather than inventing a category that customers must first learn. This is a change from earlier drafts, which led with the category.

---

## 3. The problem

Self-hosted inference introduces constraints that managed model APIs largely hide.

Models compete for finite memory. Loading and unloading create delays. Context configurations change memory requirements. CPU offload or hardware pressure can alter performance. Multiple autonomous applications can compete for shared inference capacity.

These problems are often visible somewhere in runtime metrics, logs or telemetry.

But the evidence may be fragmented, runtime-specific, or difficult to connect to a particular operational decision.

**Collecting metrics is not the same as understanding what those metrics mean for a workload.**

Wicklee translates available inference and hardware evidence into useful answers:

- What is happening?
- What can execute under current conditions?
- What might disrupt an existing workload?
- What is worth changing?
- Did the change actually improve the outcome?

The goal is not to eliminate all infrastructure uncertainty. The goal is to make that uncertainty explicit, measurable and actionable.

---

## 4. The initial product wedge: find, fix, verify

The initial reason someone installs Wicklee is to understand and improve their local inference environment.

### Find

`wicklee inspect` identifies meaningful, evidence-backed conditions such as:

- Repeated model loading and unloading.
- CPU/GPU execution placement problems.
- Memory pressure and model-residency constraints.
- Performance regressions against measured baselines.
- Known runtime constraints affecting workload readiness.

Every finding carries one label:

**Observed:** directly supported by collected evidence.

**Inferred:** a plausible explanation supported by available observations.

**Verified:** confirmed through sufficiently precise measurement or controlled testing.

A healthy system may correctly produce no findings. "No significant issues found" is a successful result, not a failure of the tool.

### Fix

Wicklee recommends specific changes worth evaluating.

Recommendations are advisory and must distinguish known facts from uncertainty. Wherever possible a finding includes a reproducible test rather than an unsupported optimization claim.

### Verify

Wicklee measures the result of a change against a prior baseline.

`wicklee fingerprint` establishes reproducible performance measurements.

`wicklee verify <finding>` repeats the controlled experiment attached to that finding and prints both runs side by side.

Receipts provide the measured outcomes that power Verify, creating the evidence needed to determine whether a fix improved execution.

This find–fix–verify loop is the first product experience that must be genuinely useful. Everything else depends on it.

### The Stage 1 command surface

| Command | Purpose |
| --- | --- |
| `wicklee inspect` | Findings, readiness and suggested changes |
| `wicklee ready [model]` | Readiness only |
| `wicklee findings` | List findings, including resolved ones |
| `wicklee fingerprint [model]` | Consented tests that establish a baseline |
| `wicklee verify <id>` | Run a finding's test and compare against the previous run |

Preflight and model-residency planning are Stage 3 capabilities and are not part of this surface. There is no separate `diff` command; before-and-after comparison is what `verify` does.

---

## 5. The recurring value: infrastructure readiness

A troubleshooting utility may be installed once and forgotten.

Wicklee's continuing value comes from helping software understand what infrastructure can support before it starts work.

A model being installed does not mean it is currently ready. Wicklee distinguishes whether a model:

- Is already loaded and available.
- Requires loading.
- May require displacing another model.
- Cannot be assessed reliably with current evidence.

It also reports, separately from residency, whether the model is busy or contended. A loaded model saturated by another workload is not the same as an idle loaded model, and a caller needs both facts.

For an agent or controller, the important question is not simply whether a model exists. It is whether using that model could interfere with other work or violate an execution requirement.

**Readiness is useful only when it can change an execution decision for the better.**

An agent querying Wicklee and continuing unchanged is evidence of integration, not evidence of value. An agent using Wicklee to avoid a disruptive model swap, an unnecessary reload or an infeasible execution plan demonstrates value.

This distinction governs technical validation. The benchmark baseline is therefore not "no information" but a native loaded-model check, which is what a competent developer would write in a few lines.

Readiness answers are time-limited and are not reservations. A cached readiness answer does not hold capacity and does not prevent overcommitment. A controller consuming readiness remains responsible for reconciling competing intentions.

---

## 6. The four foundational primitives

Wicklee's architecture revolves around four primitives. They are the internal foundation, not necessarily the features to lead with in marketing.

| Primitive | Question | Product value |
| --- | --- | --- |
| **State** | What is available and constrained right now? | Readiness and diagnostic awareness |
| **Quote** | What is this workload likely to require? | Workload preflight and prediction |
| **Prepare** | What should be ready for upcoming work? | Advisory model-residency planning |
| **Receipt** | What actually happened? | Verification, calibration and evidence of improvement |

### State

Reports model residency, memory conditions, relevant runtime state, recent performance, measurement provenance and freshness.

It must distinguish observations from estimates. Every answer carries when it was observed and how long it can reasonably be trusted.

### Quote

Evaluates a declared workload against available infrastructure. It can estimate model-loading overhead, execution latency and generation performance using measured evidence and uncertainty ranges.

Quotes are advisory, time-limited and are not capacity reservations.

### Prepare

Evaluates upcoming model requirements and recommends preparation strategies. For example, it may identify that warming another model would displace an existing active workload.

Preparation is advisory by default. Authorized runtime controllers retain control over actual loading and unloading.

### Receipt

Records measurable execution outcomes using precise request metadata where available.

Receipts come from three sources, in order of preference:

| Source | How it works | Requires |
| --- | --- | --- |
| **Caller callback** | The application posts the runtime's own final-response metadata to Wicklee after a request completes | A small change in the caller. No interception |
| **Consented benchmark** | Wicklee runs its own synthetic test and records exact timings | Operator consent on every run |
| **Metadata-only proxy** | Wicklee sits in the request path and reads response metadata only | The operator choosing to enable it |

Callbacks are the preferred path because they require no proxy and no synthetic load. The proxy remains optional: passive operation must stay useful without intercepting inference requests.

Aggregate passive observations are identified separately and do not constitute exact per-request receipts. No prompt or response content is read or stored by any path.

Receipts support two essential capabilities:

**Verification:** did the recommended change improve performance?

**Calibration:** are Wicklee's predictions becoming more reliable?

The feedback loop is **observe → assess → recommend → measure → improve**.

---

## 7. The evidence discipline

The evidence ladder is the product's core claim to trustworthiness, so it is enforced in code rather than left to authorial discipline.

| Label | Means | Requires | Wording |
| --- | --- | --- | --- |
| **Observed** | Wicklee saw it | At least one transition, sample or receipt in the statement's basis | States the fact with counts and times. Never a cause |
| **Inferred** | A likely cause or effect | An observed statement it builds on | Must be hedged: "may", "likely" |
| **Verified** | Confirmed by measurement | Exact receipts from a benchmark or verify run | States the measured number and its range |

Rules that follow from this:

1. A statement cannot be constructed without a basis that satisfies its label.
2. A finding must contain at least one observed statement. Inference alone is not shown to the user.
3. A cause is never labelled observed.
4. A before-and-after claim is verified only when both runs exist, each has enough samples, and their ranges do not overlap. Otherwise the answer is "no measurable change."
5. A specific model is named as affected only when evidence in the basis names that model.
6. When evidence is missing, the output says what was not checked. It never fills the gap with an estimate.

Three kinds of knowledge are kept apart in the data model, because conflating them is how a diagnostic tool loses credibility:

| Kind | Example | Treatment |
| --- | --- | --- |
| Observed | Which models are loaded and the memory they occupy | Reported as fact |
| Estimated | Whether another model fits in free memory | Carries the basis: measured or estimated |
| Uncertain | Which model, if any, the runtime will unload | No model named without runtime evidence |

Displacement therefore has three certainty levels — confirmed by repeated history, likely when only one other model is loaded, and unknown victim — and consumers must work correctly with the unknown case.

Runtime capabilities are detected from real responses, never assumed from a version number. A rule whose required capability is absent does not run, and the output lists it as not checked.

---

## 8. The enterprise reference architecture

Enterprise AI systems should separate application execution, resource coordination and infrastructure intelligence. Wicklee must remain independent of orchestration frameworks.

### Layer 1 — Applications and agents

**Responsibility: define the work.**

An application declares its requirements: approved model or model alternatives, context and workload size, performance objectives, execution location or policy constraints, and requirements to avoid disrupting active work.

The application owns its business logic and execution objectives. Critically, the application — not Wicklee — decides which models are acceptable substitutes for a task. Wicklee never judges whether two models are equivalent in quality.

### Layer 2 — Resource controllers

**Responsibility: decide and coordinate.**

A resource controller combines workload requirements, infrastructure evidence, existing commitments and enterprise policy. A controller could be implemented today as an API or inference gateway, a Kubernetes operator, a lightweight deterministic application-side selection service, or a component of an agent platform's orchestration.

Routine decisions should generally be deterministic and should not require an LLM invocation on every inference request.

Resource controllers remain responsible for coordination, admission decisions where supported, and policy enforcement.

A future Agentic Resource Protocol (ARP) could standardize the expression and exchange of workload intent, resource decisions and related operational information. **ARP is a potential interoperability contract, not a required Wicklee dependency.**

### Layer 3 — Wicklee infrastructure intelligence

**Responsibility: provide evidence.**

Wicklee observes the inference environment and provides model readiness, memory and hardware constraints, operational diagnoses, execution-performance estimates, historical performance evidence, and verified outcomes with their uncertainty.

It does not independently authorize workloads, reserve capacity or make network-routing decisions.

### Execution plane — existing inference engines

**Responsibility: serve and execute.**

NVIDIA Dynamo, vLLM, Ollama, SGLang and other serving environments retain responsibility for their own execution, scheduling, caching and internal resource management. Wicklee does not replace these capabilities.

**The separation:** applications declare intent. Controllers apply policy and make decisions. Wicklee supplies evidence. Serving engines execute.

---

## 9. Three consumption models

Wicklee should be useful without assuming every autonomous agent directly invokes it.

### Model A — Direct agent access

**Audience:** individual developers and small local workflows.

An agent consults Wicklee through MCP to understand readiness, diagnose a problem or evaluate an upcoming workload. This is the simplest demonstration and adoption path, and it is what Stage 1 targets.

Read-only tools only. An agent cannot trigger a model load or a benchmark through Wicklee, because those change runtime state and require operator consent.

### Model B — Shared resource controller

**Audience:** enterprise agent platforms and fleets of private bots.

A deterministic controller consumes Wicklee State over HTTP, maintains an appropriately fresh view, and combines it with workload intent and policy. Applications receive eligible execution options without each making an LLM-based infrastructure decision.

A push or event interface would reduce polling for this model. It is deliberately deferred: Stage 1 ships freshness metadata on every answer so a controller can poll correctly, and an event stream is considered in Stage 2 only if polling proves insufficient.

The controller must manage competing resource intentions where relevant. Wicklee's cached readiness alone does not reserve capacity or prevent overcommitment.

### Model C — Infrastructure operations agents

**Audience:** platform engineering, SRE and AI infrastructure operations.

Dedicated operations agents consume Wicklee findings and performance history. They can investigate regressions, propose remediations, assess capacity and assist with deployment-change validation.

They operate primarily outside the latency-sensitive execution path. Changes to production systems remain subject to explicit permissions, policies and appropriate authorization.

**One intelligence provider. Multiple consumers.**

---

## 10. Relationship to NVIDIA Dynamo

NVIDIA Dynamo is a sophisticated inference-serving system with routing, scheduling, caching and performance-management capabilities. Wicklee does not attempt to reproduce them.

The proposed differentiation is the boundary between independently operated inference environments and the applications or infrastructure controllers depending on them.

**Dynamo optimizes the inference it manages. Wicklee helps applications and operators understand inference conditions, constraints and outcomes across the infrastructure they control.**

This includes the possibility of consuming information from Dynamo-managed deployments as well as other runtimes.

The enterprise opportunity is not to normalize metrics that existing observability platforms already collect. It is to normalize **operational meaning**: readiness, constraints, execution expectations, diagnostic evidence and workload suitability.

Where existing serving infrastructure already provides sufficient answers, Wicklee should not duplicate those capabilities without demonstrable value.

---

## 11. Target market

### Initial audience

Developers and small AI platform teams running multiple self-hosted models on one to four inference hosts.

These users experience model-loading overhead, limited memory, residency contention and variability across agent workflows. Their environment is simple enough to support early experimentation, but complex enough that infrastructure awareness can change decisions.

### Enterprise expansion

Organizations operating privately controlled inference across multiple runtimes, applications, clusters or regions. The most promising prospective users are enterprise AI platform teams, private agent-platform operators, inference reliability and SRE teams, and teams operating mixed self-hosted inference environments.

### Not the initial target

- Users consuming only public model APIs.
- Single-model chat users without meaningful operational constraints.
- Large, homogeneous, mature inference clusters where existing serving and observability systems already meet the need.

Wicklee targets infrastructure the operator can observe and influence, whether deployed on-premises or on self-managed cloud GPUs.

---

## 12. Product and engineering boundaries

These principles exist to prevent scope creep.

**Wicklee is not a router.** It may report eligible execution options, but it does not manage inference request routing.

**Wicklee is not a scheduler.** It does not own admissions, reservations or workload allocation.

**Wicklee is not an agent framework.** It operates outside application-agent containers and does not manage their reasoning or tools.

**Wicklee is not a required request proxy.** Passive operation must remain useful without intercepting inference requests.

**Wicklee is not a public-API monitoring service.** Its focus is privately controlled inference infrastructure.

**Wicklee is not a mandatory hosted service.** Local use and the planned self-hostable coordination model must not require Wicklee-operated cloud infrastructure.

**Wicklee is controller-neutral.** It publishes evidence and operational recommendations without embedding the policies of a particular controller. It gives advice about inference conditions, such as "a longer keep-alive may reduce repeated loading." It does not issue instructions over infrastructure, such as "route requests to node B." Translation into another system's schema belongs in that system or in a separate adapter, never in Wicklee's core types.

**Wicklee must remain honest about uncertainty.** Findings and predictions identify their source, freshness, evidence and limitations.

The core should remain lightweight, explainable and useful independently.

---

## 13. Roadmap and validation

Development progresses through demonstrated value rather than architectural ambition. Each stage has a build, a claim to prove and a measurement.

### Stage 1 — Prove local diagnostic value

**Build:** Ollama State, passive Inspect, model readiness, consented Fingerprint, finding IDs and Verify.

**Prove:** Wicklee identifies real problems, produces trustworthy findings, and measures whether a remediation helped.

**Measure:** detection accuracy on deliberately introduced faults, false positives on healthy systems, reproducibility, usefulness, and performance overhead.

### Stage 2 — Prove agent decision value

**Build:** a minimal reference controller or real agent integration consuming Wicklee readiness.

**Prove:** a workload makes a materially better decision using Wicklee than using native model-loaded status alone.

**Measure:** avoided model reloads, execution disruption, and end-to-end workflow completion time.

An independent external integration is an adoption milestone, distinct from proving the reference implementation works. A result showing that readiness adds little beyond a loaded-model check on a given class of hardware is a valid and publishable finding.

### Stage 3 — Prove predictive value

**Build:** workload-aware Quote, empirical calibration, operational Preflight and advisory Prepare.

**Prove:** predictions and recommendations improve execution decisions beyond simple readiness heuristics.

**Measure:** forecast calibration, meaningful decision improvements, and the contribution of hardware evidence.

### Stage 4 — Prove enterprise interoperability

**Build:** additional runtime adapters, stable evidence schemas, and an optional self-hostable fleet coordinator.

**Prove:** Wicklee provides useful operational understanding across independently managed inference systems.

**Measure:** diagnostic investigation time, decision quality, integration effort, and improvements over native tools.

### Stage 5 — Prove independent-controller value

**Build:** reference integrations with external application or infrastructure controllers.

**Prove:** a controller makes better decisions when consuming Wicklee evidence.

A potential example is Consensus-NRO, but this is not a required dependency or a committed integration.

### Stages and phases

Implementation phases do not map one-to-one onto stages. Phase 1, specified in `docs/PHASE1_SPEC.md`, delivers all of Stage 1 plus the reference implementation that Stage 2 requires, because the diagnostic loop and the readiness decision share the same residency tracking and are cheaper to build together. The two results are reported and judged separately.

---

## 14. Commercial strategy

Wicklee is currently an adoption-first open-source project, not a validated commercial business.

Its foundational utility should not be compromised to create speculative subscription tiers. Paid tiers introduced earlier have been withdrawn pending a monetization plan grounded in actual usage.

Potential future offerings include managed or self-hostable fleet coordination, enterprise administration, support, compliance-oriented operations, or integration services. Commercial priorities should emerge from organizations already relying on Wicklee.

The running infrastructure follows that decision. The Stage 1 product is a single binary reached over localhost, so it needs a static site and a binary distribution channel and nothing else. The hosted backend, its database and the payment integration exist to serve a product that has been withdrawn, and they are being shut down rather than left running — a frozen codebase and a running service are separate decisions. `docs/PHASE1_SPEC.md` holds the component-by-component sequence.

**The immediate objective is meaningful usage, measurable technical value and external adoption, not short-term revenue.**

---

## 15. How to judge new feature ideas

Every proposed feature is evaluated against five questions.

**Does it solve a recognizable problem?** The feature should address an operational need users already experience or can clearly understand.

**Does it provide information or a capability beyond native runtime tools?** Reformatting existing telemetry is insufficient unless doing so measurably reduces work or improves decisions. In practice: a feature must say something the runtime's own status command and a short script would not.

**Does it lead to a useful action or decision?** A metric, API response or agent tool call is not inherently valuable. The decision it informs should be nameable.

**Can its value be demonstrated?** Prefer features whose impact can be measured through controlled tests, verified findings or improved workload outcomes.

**Does it preserve Wicklee's responsibility boundary?** If implementing the feature turns Wicklee into a scheduler, router, agent framework or generic observability platform, it probably belongs elsewhere.

---

## 16. Core hypotheses

Wicklee is built around three hypotheses that must be tested rather than assumed.

**Hypothesis 1 — Diagnostic usefulness.** Inference-specific evidence and reproducible verification can help developers identify and fix problems more effectively than their existing tools.

**Hypothesis 2 — Agent and controller decision value.** Autonomous applications or controllers can make better operational decisions when supplied with trusted readiness and execution evidence.

**Hypothesis 3 — Cross-runtime value.** Organizations operating multiple independent serving environments benefit from a common way to understand workload readiness, constraints and performance outcomes.

These hypotheses are related but independent. Failure to demonstrate one does not automatically invalidate the others, and no phase gate should bundle two of them into a single pass-or-fail condition.

---

## 17. Long-term vision

AI applications will increasingly depend on inference infrastructure that is heterogeneous, distributed and privately controlled. The systems making application-level decisions need a way to understand the capabilities and constraints of that infrastructure.

Wicklee aims to provide that understanding through an independent, evidence-based interface.

Its role is deliberately narrow. It does not decide what an application should accomplish. It does not replace the systems executing inference. It does not need to become the controller coordinating all autonomous agents.

**It makes the underlying inference environment understandable so the software making those decisions can act with better information.**

### Guiding statement

**Wicklee is the evidence layer for self-hosted AI inference, helping developers diagnose problems, agents understand readiness, and infrastructure controllers make better decisions.**

### Product promise

**Know what's happening. Know what will run. Know what to change. Prove what helped.**

### Architectural principle

**Applications declare intent. Controllers make decisions. Wicklee supplies evidence. Inference engines execute.**
