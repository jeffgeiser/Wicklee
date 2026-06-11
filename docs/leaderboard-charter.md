# WES Leaderboard & Deployment Intelligence — Charter

> **Status:** proposed (pre-build). Owner: founder. Last updated: 2026-06.
> This document is the reference a build session works against. If a feature
> decision isn't answered here, answer it here first, then build.

---

## The one-paragraph charter

**Goal:** build the authoritative *empirical* dataset of local-AI inference
performance, efficiency, and cost across `model architecture × hardware × quant`.
The **WES Leaderboard** is the public growth-and-credibility surface that makes
that dataset grow (gamified, hardware-ranked, measured-only, frictionless to
submit and share) and makes WES — tok/W, "MPG for local AI inference" — a
category-defining metric. The **Deployment Planner** is a separate, later,
logged-in surface built on the *same* dataset that answers enterprise
questions ("deploy model X on what hardware, which quant, how many nodes,
what $/Mtok?"). The **"State of Local Inference" report** is the periodic
aggregate that turns the dataset into PR and analyst credibility.

---

## Why this exists / strategic bet

- **The open lane is efficiency, not speed.** Existing local-LLM leaderboards
  (e.g. LocalScore) and informal r/LocalLLaMA threads measure tok/s. WES = tok/W
  is differentiated *and* hard to fake — it needs real power measurement, which
  is exactly the agent's deep-metal advantage. Lead with the metric others can't
  cheaply replicate.
- **Nobody owns self-hosted deployment guidance.** Artificial Analysis owns
  *hosted-API* model comparison; the "I'm deploying on my own hardware — what do
  I buy and how do I size it" question is unoccupied. That's the planner's lane.
- **Methodology transparency is the entire moat.** UserBenchmark was a
  crowdsourced benchmark the community came to distrust over perceived bias.
  r/LocalLLaMA *will* audit the WES formula in public. Publish it, show the math,
  measured-not-synthetic, and invite scrutiny. This is a feature, not a risk, if
  we get ahead of it.

---

## The boundary that keeps this from failing

The single biggest execution risk is scope creep collapsing the two surfaces
into one. A leaderboard built for enterprise decision-support (filters, workload
modeling, TCO tables) is too heavy to go viral; a viral rank-my-rig page is too
shallow to close enterprise. **They are two projections of one dataset and must
ship in sequence, not together.**

**The test that keeps it honest:**
> The leaderboard's only job is to grow the dataset and the brand. The moment a
> feature serves an enterprise *decision* rather than an enthusiast's
> *curiosity*, it belongs in the Planner, not the Leaderboard.

---

## Measured vs. synthetic — the inviolable rule

- **The Leaderboard is measured-only.** Never seed or fill it with synthetic
  (theoretical-bandwidth) numbers. The entire differentiation from "can you run
  this LLM?" calculators is that ours is *real*. One enthusiast whose real 4090
  doesn't match a synthetic 4090 entry torches the credibility we're staking the
  category on.
- **The Planner may use synthetic fill — clearly labeled — for the long tail.**
  The existing theoretical estimator (`bandwidth × INFERENCE_EFFICIENCY(0.40) /
  model_size_GB`) answers combos nobody has measured yet, so a planning tool can
  always respond. Measured and estimated values are visually distinct and never
  silently mixed.
- **Seeding the leaderboard is real measurement, not synthetic.** ~30–50 launch
  entries from a few hours of rented cloud GPUs (RunPod / Lambda / vast.ai),
  borrowed Apple Silicon / consumer cards, and friendly enthusiasts. A board with
  4 entries looks dead; seed it populated, then let submissions scale it.

---

## Specialized / fine-tuned models — what we can and cannot claim

Enterprises run fine-tunes and niche domain models no enthusiast will benchmark.
The dataset still serves them because of a clean decomposition:

- **Speed / efficiency / fit / cost are functions of architecture + parameter
  count + quant + hardware — NOT the specific weights.** A customer's fine-tuned
  Llama-3-8B at Q4 on an A100 performs ~identically to base Llama-3-8B-Q4. So
  leaderboard data **transfers** to specialized models: "your custom 8B at Q4 on
  this card will do roughly *this*." This is a real, defensible answer we give
  for free.
- **Quality does NOT transfer.** A fine-tune's task quality is theirs to eval.
  The leaderboard/planner must never claim to predict it. (The Perplexity Tax
  data covers quant-quality *delta* vs FP16 — a different axis from absolute task
  quality.)
- **The honest pitch:** "We'll tell you exactly how fast, efficient, and
  expensive your specialized model will be on any hardware, and right-size the
  fleet — because efficiency is architecture-driven and we've measured the
  architectures. We can't tell you if your model is *good* at your task; only
  your eval can." That precision is itself trust-building.

---

## Sequencing

1. **Dataset + Leaderboard (public, first).** Measured-only, WES-ranked by
   hardware class, 60-second submit, shareable result (URL + image). Reuses the
   build-time prerender/SEO machinery — ranking pages are ideal static,
   crawlable, shareable artifacts.
2. **Deployment Planner (logged-in, later).** Same dataset + labeled synthetic
   fill. Answers "deploy model X → recommended hardware / quant / node-count /
   $Mtok." Powers the roadmap's Fleet Capacity Planner, Cross-Node Model
   Migration, and Model-Hardware Fit Score — i.e. this is not new scope, it's
   those features fed by accumulated cross-fleet data instead of only the
   customer's own telemetry.
3. **"State of Local Inference" report.** Periodic anonymized aggregate. PR
   engine + analyst bait + the durable awareness moat.

---

## Hard requirements for the build (the public-write-endpoint surface)

This is a **public, unauthenticated write endpoint** — the same class of surface
as the pairing endpoint where the security review found a fleet-wide-DoS bug.
Build it with a threat model first, like the security passes.

- **Anti-abuse:** rate-limit submissions; dedup; reject implausible numbers
  (a "4060 @ 900 tok/s" must be caught — reuse the plausibility-bound discipline
  from `shared/scoring.rs`); resist flooding (no 10,000 fake entries skewing a
  ranking).
- **Anonymization is a one-way door.** Decide explicitly what fields leave the
  agent. No hostname, no node_id, no IP, no fleet identifiers in anything that
  becomes public. "Anonymized" must be verified, not asserted.
- **Statistical correctness IS the product.** Aggregation must not mix
  incomparable batch sizes / quant levels / context lengths. Wrong published
  numbers on the headline metric is the calculation-audit failure mode, in
  public, under our brand.
- **Methodology page ships with it.** The WES formula, the measurement protocol,
  and the comparability rules are public and linkable from day one.

**Model guidance for the build:** the endpoint + schema + anonymization +
anti-abuse + aggregation are Fable/Opus work (judgment-heavy, security-and-stats
critical, design-before-code with adversarial tests). The public ranking page
rendering, once the data contract is frozen, is fine for a smaller model and
should reuse the existing prerender pipeline. This is the last feature to
economize the model on.

---

## Open questions to resolve before / during build

1. **Will privacy-conscious local-AI users even submit?** Validate with a
   "would you submit your rig to a measured tok/W leaderboard?" post in
   r/LocalLLaMA *before* committing the build. That thread also seeds the launch
   audience. If the answer is no, the flywheel doesn't exist and this plan
   changes.
2. **Confirm the competitive gap is still open** — re-check LocalScore and any
   post-2026-01 local tok/W leaderboard before building (knowledge-cutoff risk).
3. **Submission method:** opt-in flag in the existing agent vs. a standalone
   one-shot benchmark binary (lower commitment, Blender-Open-Data style)?
4. **Comparability axes:** which dimensions define a "fair" ranking bucket —
   (model arch, param count, quant, batch size, context length, runtime)? The
   ranking is only credible if buckets are apples-to-apples.

---

## Non-goals (for now)

- Predicting fine-tune task quality.
- Hosted/cloud-API model comparison (that's Artificial Analysis's lane).
- Enterprise filters/workload-modeling on the *public leaderboard* (that's the
  Planner).
- Any synthetic data on the public leaderboard.
