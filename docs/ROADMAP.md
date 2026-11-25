# Wicklee Roadmap

> The evidence layer for self-hosted AI inference.

`docs/STRATEGY.md` is the strategic source of truth, and its §13 defines the
five stages this file tracks. `docs/PHASE1_SPEC.md` is the implementation spec
for Stage 1; `docs/PHASE1_RESULTS.md` is what running Stage 1 on real hardware
found and beats both on anything measured there. Implementation phases do not
map one-to-one onto stages: Phase 1 delivered all of Stage 1 plus the reference
implementation Stage 2 needs, because the diagnostic loop and the readiness
decision share the same residency tracking.

---

## What Wicklee is today

One Rust binary on one host. It answers three questions about local inference
over the CLI, HTTP and MCP: what is happening, what will run right now, and
what could I change and how do I verify it helped.

```bash
curl -fsSL https://wicklee.dev/install.sh | bash
wicklee inspect
```

Five commands — `inspect`, `ready`, `findings`, `fingerprint`, `verify`, each
with `--json`. No account, no tier, no network call you did not ask for.

## What was withdrawn

The paid tiers are withdrawn (`docs/STRATEGY.md` §14) pending a monetization
plan grounded in actual usage. The hosted backend, its database and the payment
integration served that product, and they were shut down on 2026-11-20. The
code behind them was deleted the same day and is in git history;
`docs/TRANSITION_PLAN.md` holds the order and the owner of each step.

This file used to be 613 lines, most of them a dashboard, a hosted fleet view,
a tier ladder and the GTM and enterprise-readiness programs built around them.
That material is a record of what was built, not of what is on sale, and it is
in git history: `git show 77e9185:docs/ROADMAP.md`. The release table below is
kept because it is the index to the tags.

### Release history

Agent versions are tagged by hand; `install.sh` serves the nightly build of
`main`. There is no self-update; re-run the install script to upgrade.

| Version | Date | Content |
| --- | --- | --- |
| v0.15.0 | 2026-11-16 | Phase 1 steps 5 to 10, the musl build repaired, the tiers removed from the public docs. See `docs/RELEASE_NOTES.md` |
| v0.14.0 | 2026-11-14 | Phase 1 steps 0 to 4 |
| v0.13.1 | 2026-11-14 | ARM64 NVIDIA self-update fix — `agent_platform()` had no aarch64 NVML branch, so those builds reported a name that did not match the asset they were published as. **Correction, 2026-11-14:** the original note said those nodes "lost GPU metrics silently." They did not. `nvml-wrapper` is target-gated, so both Linux assets per arch are the same build under different names. The fix is naming correctness, not a capability repair |
| v0.13.0 | 2026-11-14 | Phase 1 steps 0 to 3. Release pipeline repairs: macOS runner pin, both NVIDIA Linux assets moved to the glibc 2.31 floor, musl build added to CI |
| v0.12.0 | 2026-10-03 | `main.rs` split into modules on both agent and cloud; Apache 2.0 for the agent and local dashboard; the report energy/token integration fix |
| v0.11.1 | 2026-07-16 | Self-hosted control plane, Helm chart, idle-waste report, capacity planner and migration advisor |
| v0.11.0 | 2026-07-04 | RBAC, audit export and SIEM drain, org-wide API keys, SLOs with error budgets, fleet config management, chargeback |
| v0.10.0 | 2026-06-17 | Security and calculation review passes, SEO prerendering, harvester supervision, React error boundary |

**No release published between 2026-10-11 and 2026-11-14.** GitHub withdrew the
arm64 image behind the `macos-14` runner label, so `build-macos` cancelled in
about a second with no steps run. Both publish jobs carry it in `needs:`, and a
*cancelled* dependency makes a dependent job **skip** rather than fail — so
every release run built five assets, published none, and reported success.
`curl | bash` served the 2026-10-11 binary for five weeks while `Cargo.toml`
sat at 0.12.0, and nothing anywhere said so. Fixed by pinning `macos-15`. The
failure mode is invisible by construction: if a build job is ever added to
`needs:`, check that its cancellation would fail the publish rather than skip
it.

---

## Stage 1 — Prove local diagnostic value

**Build:** Ollama State, passive Inspect, model readiness, consented
Fingerprint, finding IDs and Verify.

**Prove:** Wicklee identifies real problems, produces trustworthy findings, and
measures whether a remediation helped.

**Measure:** detection accuracy on deliberately introduced faults, false
positives on healthy systems, reproducibility, usefulness, and performance
overhead.

### Where it stands

**Built and on `main`.** All ten Phase 1 steps are merged; v0.15.0 is the
release that carries steps 5 to 10. 248 tests on the no-store build, clippy
clean at `-D warnings` on every commit and on both targets.

| | |
| --- | --- |
| CLI | `wicklee inspect`, `ready`, `findings`, `fingerprint`, `verify`, each with `--json` |
| HTTP | `GET /v1/state`, `/v1/readiness`, `/v1/inspect`, `/v1/findings`, `/v1/receipts`; `POST /v1/receipts`, `/v1/fingerprint`, `/v1/verify` |
| MCP | `wicklee_state`, `wicklee_readiness`, `wicklee_inspect`, each calling the same handler its route calls |
| Agent modules | `ollama_client`, `caps`, `residency`, `readiness`, `findings`, `receipts`, `fingerprint`, `cli`, `auth` |
| Rules | `cpu_split`, `context_reset`, `eviction_churn`, `expiry_reload`, `baseline_regression`, plus the nineteen hardware patterns adapted through the observations bridge |
| Harness | `scripts/bench/`: capability recording, fault injection, a reference controller, headroom margin, acceptance |

**Three fixes to shipping behaviour came out of building it, and one is
breaking:**

- **Inbound authentication did not exist at all.** `session_token` is the
  outbound cloud credential, not an inbound one, so with
  `bind_address = "0.0.0.0"` both `/api/pair/claim` and `/mcp` were reachable
  by anything on the network. **Breaking: a non-loopback bind with no token now
  refuses to start**, and the refusal names the key to set.
- **The throughput probe was silently reloading models at 4096.** It sent no
  `num_ctx`, so every interval took a 65536-context model down to the default:
  2,626 ms of reload, measured, against 3 ms after the fix.
- **`model_info` keys were hardcoded to `llama.*`**, which nulled context and
  KV-cache for every non-llama model. They resolve from the model's own family
  now.

**What the live runs changed**, which is the point of having them. Full numbers
and method in `docs/PHASE1_RESULTS.md`:

- **A non-overlap is not a measurement.** Two runs of the same test on an idle
  host, nothing changed between them, reported "worse" at 1.5% — two tight
  ranges that happen not to touch. A verdict now also needs the medians to
  differ by at least 5%.
- **Interleave the blocks.** A two-block A/B said the agent cost −2.96% of
  throughput with disjoint ranges; interleaved, the same measurement is −1.34%
  and overlapping. The first was thermal drift.
- **Overhead at idle is nothing measurable**: 22 MB RSS against the baseline's
  23 MB, 0.00% CPU both. The DuckDB store is the real cost at about 61 MB, and
  it is what makes history, receipts and `baseline_regression` possible.
- **Every binary-size delta reported before step 8 was confounded** by an
  unrecorded toolchain. Same-toolchain Phase 1 growth is +5.27%, not +1.50%.
- **An old agent restarted on a networked host does not stay old.** Starting
  0.12.0 to measure a baseline had `self-replace` swap it for the 0.14.0 asset
  in about five seconds.

**Three design rules that must not be relaxed**, each enforced by construction
rather than by review:

- **Evidence labels.** A `Statement` is built only through a constructor that
  rejects a basis not meeting its label. `observed` needs a transition, sample
  or receipt and never states a cause; `inferred` must hedge and must build on
  something observed or verified; `verified` needs exact receipts. A finding
  with only inferred statements is not shown.
- **`num_ctx` on every request, never guessed.** Omitting it reloads the model
  at 4096. An unknown running context refuses the run rather than assuming one.
- **A receipt never carries content.** `POST /v1/receipts` refuses `prompt`,
  `response`, `messages` or `context` with a 400 naming the field, rather than
  storing the body minus them.

---

## Stage 2 — Prove agent decision value

**Build:** a minimal reference controller or real agent integration consuming
Wicklee readiness.

**Prove:** a workload makes a materially better decision using Wicklee than
using native model-loaded status alone.

**Measure:** avoided model reloads, execution disruption, and end-to-end
workflow completion time.

### Where it stands

**Built, and unproven on this hardware.** `scripts/bench/reference-controller.mjs`
runs four policies over the same workload: `naive`, `loaded_only` (the native
check a competent developer would write), `smallest_first` (sort `/api/tags` by
file size, never call Wicklee) and `wicklee`.

On the M4, `wicklee` and `smallest_first` **tie**. Both chose the model that
genuinely coexists, neither displaced anything in five runs, and the medians sit
inside run-to-run variation. Readiness said *why* and the heuristic guessed, but
the routing claim has no support here: a controller that sorts by file size gets
the same outcome for a fraction of the work.

That is a publishable finding rather than a failure — §13 says so explicitly —
and it is the reason Stage 2 stays open. What `smallest_first` cannot do is
visible in its construction, not in these numbers: installed size is not the
resident footprint, it has no notion of what is in use, and nothing stops it
choosing a smallest option that still does not fit. A host where the smallest
option is not the one that coexists would separate the two. The Mac mini is not
that host.

**Readiness's displacement answer is known wrong, and no margin fixes it.**
Five of six ordered model pairs on the M4 evicted an in-use model where
readiness said the load would fit, and the decisive pair coexists at 9.32 GB in
one load order while evicting in the other. The brackets cross, so eviction on
that host is not a function of total resident size. Three ways forward are
written down in `docs/PHASE1_RESULTS.md`; **none is chosen on one host's
evidence, and nothing should be patched from one host.** Until then
`/v1/readiness` carries `coexistence: "unverified"` on exactly the answers
where this applies, and says so in words.

---

## Stage 3 — Prove predictive value

**Build:** workload-aware Quote, empirical calibration, operational Preflight
and advisory Prepare.

**Prove:** predictions and recommendations improve execution decisions beyond
simple readiness heuristics.

**Measure:** forecast calibration, meaningful decision improvements, and the
contribution of hardware evidence.

**Where it stands:** not started. Preflight and model-residency planning are
deliberately absent from the Stage 1 command surface. Stage 3 is also where the
displacement question gets a real answer, because predicting what a load will
do is the same problem as predicting what it will evict.

---

## Stage 4 — Prove enterprise interoperability

**Build:** additional runtime adapters, stable evidence schemas, and an
optional self-hostable fleet coordinator.

**Prove:** Wicklee provides useful operational understanding across
independently managed inference systems.

**Measure:** diagnostic investigation time, decision quality, integration
effort, and improvements over native tools.

**Where it stands:** not started. vLLM and llama.cpp harvesters exist from the
pre-revision product, but only Ollama has the `/v1` surface. The coordinator is
optional by design: local use must never require Wicklee-operated
infrastructure.

---

## Stage 5 — Prove independent-controller value

**Build:** reference integrations with external application or infrastructure
controllers.

**Prove:** a controller makes better decisions when consuming Wicklee evidence.

**Where it stands:** not started, and gated on Stage 2 producing a result on a
host where readiness beats a cheap heuristic. Consensus-NRO is a potential
example, not a committed integration.

---

## Open items

Each of these is blocked on something outside the code. The next five days of work on the first two are laid out in [`FIVE_DAY_PLAN.md`](FIVE_DAY_PLAN.md).

| Open item | Needs |
| --- | --- |
| The displacement decision | Evidence from more than one host before changing what readiness promises. `docs/TRANSITION_PLAN.md` step 8 |
| Stage 2's result | A host where the smallest model is not the one that coexists — a rented NVIDIA GPU with discrete VRAM, or 1b-class models on the Mac mini |
| `inspect` against the installed service daemon | A daemon restart onto a current binary, which needs root. Everything verified so far used a hand-started agent with a fresh store, which proves the query and the render but not what a week of real traffic looks like |
| Four acceptance rows | A day of normal use, a >5% fix lever that 16 GB cannot provide, and three other machines |
| `baseline_regression` on the musl build | The rule reads the store, and musl has none. The in-memory receipt buffer added in v0.15.0 could carry it; `inspect` currently reports it as not checked, with the reason |

---

## Contributing

Issues welcome; pull requests are not accepted at this time (see
[CONTRIBUTING](../CONTRIBUTING.md)). See the [README](../README.md) for build
instructions.
