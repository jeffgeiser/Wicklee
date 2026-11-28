# Phase 1 results — `wicklee inspect`

> **Note, 2026-11-20.** The agent no longer has `/api/pair/*` routes or a `--no-cloud` flag; the fleet pairing code was removed. References to them below are a record of how the measurements were taken.

What was measured, on what, and what it found. Every number here came off real
hardware; the raw transcripts are committed beside this file so the tables can
be checked rather than taken on faith.

`docs/PHASE1_SPEC.md` is the implementation spec and holds the per-step
deviations. This file is the results write-up: method, numbers, and the one
prediction that turned out to be wrong.

**One host.** Everything below was measured on a single M4 Mac mini. That is
enough to find bugs and not enough to set a constant, which is why nothing here
was turned into a shipped threshold. `scripts/bench/acceptance.mjs` exists so a
second and third machine produce one comparable transcript instead of a prose
checklist.

---

## The host and the isolation

| | |
| --- | --- |
| Machine | M4 Mac mini, 16 GB unified memory, macOS 25.5.0, 10 cores |
| Runtime | Ollama 0.40.16 on a private `127.0.0.1:11999` |
| Agent | 0.14.0 + Phase 1 on `127.0.0.1:7999`, `--no-cloud`, own `WICKLEE_DATA_DIR` |
| Toolchain | rustc 1.94.1, all binary comparisons on this one toolchain |
| Models | `qwen3.5:4b` (3.37 GB resident), `llama3.1:8b` (5.95 GB), `qwen3.5:9b` (5.65 GB), all at context 8192 unless stated |

The installed service on that machine was never touched. Every script refuses
to run against `:11434` or `:7700` for that reason, and `lsof` was used to
confirm the test agent spoke only to its own two loopback ports. Teardown was
checked after each run: ports free, the shared runtime's loaded model
unchanged, the daemon's own store untouched.

Isolation recipe and how to fill in a scenario file for your own hardware:
[`scripts/bench/README.md`](../scripts/bench/README.md).

---

## Detection — do the rules catch what they claim to?

`fault-inject.mjs` creates each condition a diagnostic rule is meant to catch,
then asks the agent whether it caught it. Four outcomes: **fired**, **quiet**
(the healthy control, where no finding is the pass), **not_inducible** (a
result about the hardware, with the reason), **missed** (a failure).

| Scenario | Result |
| --- | --- |
| `context_reset` | **fired.** "qwen3.5:4b was reloaded at the default 4096-token context 4 times in the last 3 minutes, dropping from as high as 8192 tokens" |
| `eviction_churn` | **fired** at context 32768. "2 models were cleared 3 times in the last 5 minutes within 10 seconds of another model loading, each before its own keep-alive expired" |
| `expiry_reload` | **fired.** "expired and was loaded again within 10 minutes on 4 occasions in the last day — gaps from 5 seconds to 15 seconds" |
| `healthy` | **quiet** on a store with nothing open |
| `cpu_split` | **not inducible here.** `size_vram` equals `size` at 7,961,250,364 bytes even at context 131072. One memory pool, so there is no boundary for part of a model to fall outside of |
| `baseline_regression` | **not inducible on 16 GB.** Co-loading the larger model idle moved the measured rate **+4.7%** — a second set of weights competes for nothing while it is not decoding. Co-loading it busy evicted the model being measured, so the warm test had nothing to run on |

Three fired, one quiet, two not inducible, **none missed**. Each fired finding
pairs an observed measurement with a hedged inference and never states a cause
as fact, which is what the evidence rules are for.

Raw: [`bench-fault-inject-m4-2026-11-15.json`](bench-fault-inject-m4-2026-11-15.json),
including the full `/v1/inspect` body at the end of the run.

---

## Acceptance

| Row | Result |
| --- | --- |
| Reproducible | **pass.** Three fingerprints of one unchanged model all overlap; medians spread 0.7% |
| Evidence holds | **pass**, checked structurally rather than by opinion: every statement carries a basis, every finding carries an observed or verified statement, every inferred one hedges |
| No side effects | **pass.** `expires_at` unchanged across reads of `/v1/state`, `/v1/readiness`, `/v1/inspect` and `/v1/findings` |
| Detection | **partial.** Three of six scenarios fired on this hardware; two are not inducible here and one is below the rule's threshold |
| Overhead | **measured**, below. Not a pass or a fail — a number |
| Quiet across 24 hours | **not reached.** Needs a day of normal use with `wicklee inspect` read at the end |
| Fix confirmed | **not reached.** Needs an injected fault whose fix moves the generation rate by more than 5%. The only lever on this host is memory contention, and 16 GB cannot hold two models resident with one busy |
| Other hardware | **not reached.** Three machines with different configurations, which is other people |
| Decision changed, measured benefit | **not reached.** Blocked on the displacement prediction below |

Raw: [`bench-acceptance-m4-2026-11-15.json`](bench-acceptance-m4-2026-11-15.json).
A row with `pass: null` in that file is one this host cannot answer, named
rather than silently skipped.

---

## Overhead — Phase 1 adds nothing measurable at idle

Both builds with no store, same ports, five samples:

| | idle RSS | idle CPU |
| --- | --- | --- |
| 0.12.0 baseline, no store | 23 MB | 0.00% (peak 0.10%) |
| Phase 1, no store | 22 MB | 0.00% |
| Phase 1, with the DuckDB store | 83 MB | 0.10% |

The 1 MB difference is below what `ps` resolves, and Phase 1 reads *lower* than
the baseline, so the honest statement is no measurable change. The store is the
real cost at about 61 MB, and it is what makes history, receipts and
`baseline_regression` possible.

Inference throughput, agent running against agent stopped, four interleaved
blocks of four:

| | median | range | n |
| --- | --- | --- | --- |
| agent running | 27.36 tok/s | 27.04–27.98 | 8 |
| agent stopped | 27.73 tok/s | 25.97–28.11 | 8 |

−1.34% with the ranges overlapping, so no resolvable cost.

**Interleaving is why that is trustworthy.** A two-block A/B of the same
measurement said **−2.96% with the ranges disjoint by 0.02 tok/s**, which would
have been published as a real regression. It was thermal drift across the
session. Same trap the 5% `MIN_MEASURABLE_PCT` floor exists for, caught this
time by the design of the measurement instead.

Binary: **+5.27%** against a same-toolchain 0.12.0 (24,827,088 against
23,584,416 bytes).

---

## The prediction that is wrong

**Readiness's displacement answer is optimistic, and it cannot be fixed by
tuning a margin.** Six ordered pairs of three models, each loaded at context
8192, the first made recently-used so it reads as in use:

| First | Second | Predicted | Actual |
| --- | --- | --- | --- |
| `qwen3.5:4b` | `qwen3.5:9b` | requires_loading, nothing displaced | 4b evicted |
| `qwen3.5:4b` | `llama3.1:8b` | requires_loading, nothing displaced | 4b evicted |
| `qwen3.5:9b` | `qwen3.5:4b` | requires_loading, nothing displaced | 9b evicted |
| `qwen3.5:9b` | `llama3.1:8b` | requires_loading, nothing displaced | 9b evicted |
| `llama3.1:8b` | `qwen3.5:4b` | requires_loading, nothing displaced | **both resident** |
| `llama3.1:8b` | `qwen3.5:9b` | requires_loading, nothing displaced | 8b evicted |

Five optimistic, one correct. The decisive pair is `llama3.1:8b` with
`qwen3.5:4b`: in that order both stay resident at 9.32 GB total, and in the
opposite order the first is evicted. Same two models, same total, opposite
outcome, reproduced twice in each direction.

So the brackets cross — largest coexisting pair **9.32 GB**, smallest evicting
attempt **9.03 GB** — which means **eviction on this host is not a function of
total resident size.** The agent works from a 12.88 GB budget
(`apple_wired_limit`: 75% of 16 GB, because `iogpu.wired_limit_mb` reads 0 on
this M4), and no "budget minus a constant" reproduces the observed pattern.
Ollama's scheduler is deciding on accounting that `/api/ps` does not expose.

Three ways forward, none of them a margin tweak, all needing evidence from more
than one host:

1. Report co-residency as `may_require_eviction` whenever another model is
   resident and in use.
2. Carry the uncertainty in the answer rather than in a boolean.
3. Find a runtime signal that does predict it.

**Recorded, not chosen.** One machine is not evidence for a constant that
ships.

Raw: [`bench-headroom-m4-2026-11-15.json`](bench-headroom-m4-2026-11-15.json).
`headroom-margin.mjs` exits non-zero on any optimistic row, so this is a
failing check and not a note.

### How it hid itself

With `qwen3.5:9b` still only *estimated*, readiness answered
`may_require_eviction` and named the in-use victim — correctly. Once the 9B had
been measured at its real 5.65 GB the estimate went **down** and the answer
flipped to "fits". A conservative estimate was cancelling out a generous
budget. Measuring made the prediction worse, which is the kind of thing only a
run on real hardware finds.

### What it did to the agent demonstration

`reference-controller.mjs` runs three policies — `naive`, `loaded_check`,
`wicklee` — over randomised runs, with a deferral counted as cost rather than
as a win. The baseline that matters is `loaded_check`: any careful integration
already reads `/api/ps` before choosing, so beating `naive` proves nothing.

All three policies chose `qwen3.5:9b` on all five runs, and all fifteen runs
displaced the in-use model. The report says `tie`.

The `wicklee` policy did not avoid the displacement because readiness told it
the load would fit: 5.65 GB into 6.93 GB free with a 0.5 GB margin. **The right
answer existed** — `qwen3.5:4b` coexists with the held model — so this is not a
null result about readiness in principle. It is the same wrong prediction,
measured a second way.

Raw: [`bench-controller-m4-2026-11-15.md`](bench-controller-m4-2026-11-15.md).

### Re-run after the interim wording

The agent now marks a `requires_loading` answer `coexistence: "unverified"`
while another model is resident, and the `wicklee` policy treats that as a
displacement risk. Same host, same five runs per policy, randomised order:

| Policy | Chose | B step ms | A latency ms | A reloads | In-use displaced | Deferrals |
| --- | --- | --- | --- | --- | --- | --- |
| `naive` | qwen3.5:9b ×5 | 7167 (6965–7267) | 4207 (3929–4475) | 5/5 | **5/5** | 0 |
| `loaded_check` | qwen3.5:9b ×5 | 6709 (6667–7306) | 4205 (3996–4756) | 5/5 | **5/5** | 0 |
| `wicklee` | qwen3.5:4b ×5 | 34742 (34445–35075) | 519 (498–535) | 0/5 | **0/5** | 5 |

**The tie is gone and the direction is the one the measurement predicted.**
`wicklee` picked the model that actually coexists, displaced the in-use model
in none of five runs where both baselines displaced it in all five, and
workflow A's next request came back in 519 ms instead of 4,205 — it never had
to reload. Reading the unverified fit as a risk is what produced that; the
previous run read it as safe and lost the held model every time.

**The 28 extra seconds are the policy's, not the agent's, and they are a
finding about this wording.** Every acceptable option now reads unsafe, so the
policy has no way to say "least risky of the unverified": it defers, re-polls
until its 30 s timeout expires, and only then falls through to the
smallest-footprint fallback — which happens to be the right answer. The choice
was available immediately. A policy that ranked unverified fits by footprint
would have made it in milliseconds, and that is the next thing to try. Taken
literally, "unverified" collapses a ranking into a single bucket.

Raw: [`bench-controller-rerun-m4-2026-11-15.json`](bench-controller-rerun-m4-2026-11-15.json).

### Re-run with the ranking, against a cheap baseline

Two changes. The `wicklee` policy now ranks unverified fits by footprint and
chooses immediately instead of deferring — the ranking is the policy's, and
Wicklee's own output still orders nothing. And a fourth policy,
`smallest_first`, sorts `/api/tags` by installed size and takes the smallest,
which costs one request and no Wicklee at all. Five runs each, randomised, same
host:

| Policy | Chose | B step ms | A latency ms | A reloads | In-use displaced | Deferrals |
| --- | --- | --- | --- | --- | --- | --- |
| `naive` | qwen3.5:9b ×5 | 6951 (6704–7023) | 3927 (3915–4486) | 5/5 | **5/5** | 0 |
| `loaded_check` | qwen3.5:9b ×5 | 6948 (6604–7342) | 4196 (4161–4450) | 5/5 | **5/5** | 0 |
| `smallest_first` | qwen3.5:4b ×5 | 4655 (4409–4803) | 495 (481–528) | 0/5 | **0/5** | 0 |
| `wicklee` | qwen3.5:4b ×5 | 4390 (4353–5356) | 488 (485–528) | 0/5 | **0/5** | 0 |

**Against `smallest_first`, this is a tie, and it is the result worth
publishing.** Identical choices, identical displacement record, and the step
and latency medians differ by less than run-to-run variation — they chose the
same model, so they did the same work. **Sorting `/api/tags` by installed size
made the same decision as the whole readiness surface, in one request.** On
this host readiness changed nothing a one-line heuristic would not have.

The deferral is gone: 0 of 5 against 5 of 5 in the previous run, with the step
down from 34,742 ms to 4,390 ms. Ranking the unverified fits recovered
everything the 30-second wait was costing, which confirms the wait was the
policy's artifact and not the wording's price.

What the tie does and does not say. It does not say readiness was wrong — both
policies picked the model that genuinely coexists, and readiness said why while
the heuristic guessed. It does say the **routing** claim has no support on this
hardware: a controller that sorts by file size gets the same outcome for a
fraction of the work, and the honest statement of Stage 2's value here is that
it is unproven, not demonstrated.

What `smallest_first` cannot do is visible in its construction rather than in
these numbers, and is therefore not a claim: installed size is not the resident
footprint, it has no notion of what is in use, and nothing stops it choosing a
smallest option that still does not fit. A host where the smallest option is
not the one that coexists would separate the two. This one does not, and three
machines were already the open item.

Raw: [`bench-controller-4policy-m4-2026-11-15.json`](bench-controller-4policy-m4-2026-11-15.json).

---

## Two corrections to the record

**Every binary-size delta reported for steps 1, 4 and 5 was confounded.** They
compared against a pristine 0.12.0 figure of 24,411,328 bytes taken on an
unrecorded toolchain. Rebuilt from the v0.12.0 tag on rustc 1.94.1, the same
source produces 23,584,416 bytes. Same-toolchain Phase 1 growth is **+5.27%**,
not the +1.50% recorded at step 5. The earlier deltas were measuring the
toolchain as much as the code.

**An old agent restarted on a networked host does not stay old.** v0.12.0
predates `--no-cloud`, so starting it to measure the baseline ran its startup
update check and `self-replace` swapped the binary for the 0.14.0 release asset
within about five seconds: the file on disk went from 23,584,416 to 24,628,176
bytes and began reporting v0.14.0. The baseline above was measured with that
one call disabled. Worth knowing beyond this benchmark — the self-update is
one-shot at startup, so a daemon stays on an old version only for as long as it
is not restarted.

---

## Reproduce it

```bash
# A private runtime. Shares ~/.ollama/models, so nothing is downloaded.
OLLAMA_HOST=127.0.0.1:11999 ollama serve &

cd agent && cargo build
PORT=7999 WICKLEE_OLLAMA_PORT=11999 WICKLEE_DATA_DIR=/tmp/wk-bench \
  ./target/debug/wicklee-agent --no-cloud
```

```bash
cp scripts/bench/scenarios.example.json scripts/bench/scenarios.json   # then edit it
node scripts/bench/fault-inject.mjs --plan
node scripts/bench/fault-inject.mjs --yes
node scripts/bench/reference-controller.mjs --runs 5 --yes
node scripts/bench/headroom-margin.mjs --yes
node scripts/bench/acceptance.mjs --yes
```

Nothing in the scenario file is guessed from your machine, deliberately: model
names, resident footprints and which contexts do or do not fit are things only
you know, and a harness that assumed them would induce the wrong condition and
report a pass.

---

## What is not verified

- **`inspect` has never run against the installed service daemon.** Every
  verification above used a hand-started agent with its own fresh store. A
  fresh store proves the query, the rule and the output render; it cannot show
  what `inspect` looks like on a host that has been serving real traffic for a
  week. That check needs the daemon restarted onto a current binary, which
  needs root.
- **Four acceptance rows were not reached**, listed above with why.
- **`improved` and `worse` verify verdicts are unit-tested, not live.**
  Manufacturing a real 5% regression needs a second model contending for
  memory, which 16 GB cannot do while one of them is busy. With 1b-class
  models a live `worse` was produced on 2026-11-28; `improved` still was not
  (see "1b-class models on the M4" below).

---

## 1b-class models on the M4, 2026-11-28

W3 of [`FIVE_DAY_PLAN.md`](FIVE_DAY_PLAN.md), run by the runbook in
[`MAC_MINI_1B_RUN.md`](MAC_MINI_1B_RUN.md). Same machine as everything above,
with models small enough that one can be held busy while another is measured.
**Findings only.** Nothing here changed a threshold, readiness behaviour or
agent code: one machine is not evidence for a constant that ships, and these
go to W4.

| | |
| --- | --- |
| Machine | M4 Mac mini, 16 GB unified, macOS 26.5 |
| Runtime | Ollama 0.40.16 on a private `127.0.0.1:11999` |
| Agent | 0.16.0, debug build (rustc 1.100.1), `127.0.0.1:7999`, own `WICKLEE_DATA_DIR`, `WICKLEE_LLAMACPP_PORT=11998` (see below) |
| Models | `llama3.2:1b` (large, 1.73 GB resident at 8192), `qwen2.5:1.5b` (other, 1.37 GB), `gemma3:1b` (small, 0.96 GB). All three resident together at 8192 |
| Budget | 12.88 GB as the agent reports it (`apple_wired_limit`). The runbook and `scenarios.m4.json` say 11.6; the agent says 12.88 |
| Scenario file | [`scripts/bench/scenarios.m4-1b.json`](../scripts/bench/scenarios.m4-1b.json) |

Every size and context above came off `/api/ps` on the private runtime. The
installed service, the default Ollama on `:11434` and the agent on `:7700` were
not touched. `lsof` showed both private processes on loopback only, with nothing
to `:11434`. After teardown the default runtime's process and runner were
still running, unchanged.

### Isolation: the agent attached to Ollama's own runner

Started exactly as the runbook says, the private agent's process discovery
found a `llama-server` on `:51238` and connected to it as a llama.cpp runtime.
That process is **the default Ollama's own runner** (parent PID the app's
`ollama serve`, serving `llama3.1:8b` at `-c 4096`). Ollama 0.40 runs its models
through `llama-server`, and discovery matches any `llama-server` binary. In
about 15 seconds the agent sent only `GET /health` and `GET /slots` to it.
The llama.cpp idle probe, which sends completions, did not fire. The agent was
stopped and restarted with `WICKLEE_LLAMACPP_PORT=11998` (nothing listening),
which pins the port and disables that discovery. Every run below used that
setting. Without it the same discovery would also attach to the *private*
runtime's runners and measure Ollama's models twice, under a second runtime
label. The runbook and `scripts/bench/README.md` need that variable. The
discovery itself is a W4 item.

### Contexts, measured

| Model | 8192 | 32768 | 65536 | 131072 |
| --- | --- | --- | --- | --- |
| `llama3.2:1b` | 1.73 GB | 2.59 GB | 3.78–4.00 GB | 6.04–6.20 GB |
| `qwen2.5:1.5b` | 1.37 GB | 2.02–2.12 GB | clamped to 32768 | clamped to 32768 |
| `gemma3:1b` | 0.96 GB | 1.01 GB | clamped to 32768 | clamped to 32768 |

`qwen2.5:1.5b` and `gemma3:1b` top out at 32768. The runtime silently loads them
at 32768 whatever larger `num_ctx` is asked for, so no context makes the small
model exceed the budget here. `too_large_for_accelerator` is set to 131072 in
the scenario file, but for `gemma3:1b` that is a 1.01 GB load.

**The eviction boundary moved during the session.** Measured at 08:30 with
`llama3.2:1b` and `qwen2.5:1.5b` loaded together, both orders each time: both
resident at 65536 (twice each order), evicted at 69632, 73728, 81920, 98304 and
131072. The combined footprints do not bracket: 6.12 GB coexisted at 65536,
while 5.95 GB evicted at 69632. That was the same crossing as the larger models
above. Re-measured at about 09:05, the same pair **coexisted at 69632, 98304 and
131072 in both orders**, 8.32 GB together. Over that time free memory went from
214,485 pages (3.5 GB) to 351,777 (5.8 GB). The default runtime's runner was
unchanged, and swap stayed at about 7.4 of 8 GB used. So on this host, whether
two models co-reside followed **free system memory**, which the agent does not
read, and not their combined size against the agent's budget. That is an
observation from one session, not a demonstrated cause. `eviction_context` was set
to 69632 from the first measurement, before the move was seen.

### The five questions

**Is `baseline_regression` inducible, and does it fire?** No, on the
harness's induction. Both models stayed resident this time. The 16 GB eviction
that blocked it before did not happen. But the contention was too short to
matter: `gemma3:1b` measured 98.19 tok/s, then 94.85 with `llama3.2:1b`
generating, **−3.4%** against the rule's 20%. The harness's busy request is a
2048-token completion started 12 s before the fingerprint. At about 100 tok/s
it ends partway through the measurement. Sustained contention does slow the model
far past 20%; see the verify result next.

**Can `improved` or `worse` be produced live?** **`worse`: yes.** `wicklee
verify F-868ecd` took a baseline at 85.5 tok/s (70.5–101.2, n=6, `gemma3:1b`
and `llama3.2:1b` at 8192). Re-run while `qwen2.5:1.5b` decoded four 4096-token
completions back to back, it measured 52.9 tok/s (39.2–61.1, n=6), **−38.1%**,
verdict `worse`, "nothing Wicklee can see differed between the two runs".
**`improved`: not produced.** `F-81259c` with its baseline taken under the
same contention, 70.8 tok/s (53.3–96.1, n=9), then re-run clean, gave 96.5
tok/s (72.3–100.7, n=9), +36.3%. The verdict was `no measurable change` because
the ranges overlap. That verify measures all three models, including the busy
one, so the contended baseline spans fast and slow runs. One attempt, not
repeated. Both verdicts came from runs outside the harness: neither script calls
verify.

**Does readiness's displacement answer hold with small models?** **No
optimistic row, and that is not evidence it holds.** `headroom-margin` at 8192:
6 of 6 correct, exit 0, largest coexisting pair 3.1 GB. Re-run at 131072, the
context that had evicted earlier in the session: 6 of 6 correct, exit 0,
largest coexisting pair 8.22 GB. No pair evicted in either run, so every
`requires_loading, nothing displaced` was right because nothing was evicted. The
answer was never tested where it failed before. Two things in those rows:

- **Readiness's footprint is the last one measured, at whatever context.** At
  8192 it predicted `llama3.2:1b` at 6.2 GB, its 131072 footprint from earlier
  probing. At 131072 it predicted 1.73 GB, its 8192 footprint, for a load that
  came in at 6.2 GB. Those two predictions were wrong in opposite directions,
  and the outcome was right only because nothing was evicted.
- `/v1/readiness` takes no context. The live dispatch below shows what follows.

**Do `wicklee` and `smallest_first` still tie?** **Yes.** Five runs per
policy, randomised, held model `qwen2.5:1.5b`, acceptable `llama3.2:1b` then
`gemma3:1b`:

| Policy | Chose | B step ms | A latency ms | A reloads | In-use displaced | Deferrals |
| --- | --- | --- | --- | --- | --- | --- |
| `naive` | llama3.2:1b ×5 | 674 (667–696) | 97 (96–98) | 0/5 | 0/5 | 0 |
| `loaded_check` | llama3.2:1b ×5 | 674 (665–678) | 97 (95–98) | 0/5 | 0/5 | 0 |
| `smallest_first` | gemma3:1b ×5 | 608 (572–880) | 96 (94–97) | 0/5 | 0/5 | 0 |
| `wicklee` | gemma3:1b ×5 | 611 (589–1875) | 95 (93–103) | 0/5 | 0/5 | 0 |

Same choice and same displacement record. On a host where every option
coexists, `wicklee` ranks the unverified fits by footprint and so becomes
`smallest_first`. It differs from `loaded_check`, but nothing was displaced
under any policy, so the difference bought nothing. It also overrode the
operator's first preference.

**Which acceptance rows can this host now answer?**

| Row | Result |
| --- | --- |
| Reproducible | **pass.** Three `gemma3:1b` fingerprints overlap; medians spread 0.6% |
| Evidence holds | **pass.** 3 findings, all evidenced |
| No side effects | **pass.** `expires_at` unchanged across all four reads |
| Overhead | **reported, not judged.** RSS 84 MB, CPU 8.6% (peak 12.9%) idle, on a **debug** build, so not comparable with the release numbers above |
| Detection | **partial**, below |
| Fix confirmed | **half.** A live `worse` exists (−38.1%). A live `improved` was attempted once and not produced |
| Quiet across 24 hours, other hardware, decision changed | **not reached**, as before |

### Detection

| Scenario | Result |
| --- | --- |
| `context_reset` | **fired.** "gemma3:1b was reloaded at the default 4096-token context 2 times in the last 3 minutes, dropping from as high as 8192 tokens. The load cost of each reload is not measured." |
| `expiry_reload` | **fired.** "gemma3:1b expired and was loaded again within 10 minutes on 4 occasions in the last day — gaps from 5 seconds to 19 seconds. Neither the keep-alive duration nor the cold-load cost is reported by /api/ps, so neither is claimed here." |
| `healthy` | **quiet.** Raised nothing new; `context_reset` and `expiry_reload` still open from the injection |
| `cpu_split` | **not inducible here.** `size_vram` equals `size` (1,008,247,766 bytes): unified memory. `gemma3:1b` also cannot be made larger than the budget, because the runtime clamps its context to 32768 |
| `baseline_regression` | **not inducible here** with the harness's induction: −3.4% against 20%, above |
| `eviction_churn` | **missed in the transcript, most likely not induced.** "4 alternations between llama3.2:1b and qwen2.5:1.5b at context 69632 produced no finding." The script does not check that an eviction happened. Re-run by hand at 69632 straight afterwards, sampling `/api/ps` every 0.5 s, all three models stayed resident and every reload was warm (`load_duration` 1 ms). The boundary had moved (above) |

**`eviction_churn` then fired on the harness's own unloads.** After the
controller and acceptance runs, `wicklee inspect` showed F-047fb3: "3 models
were cleared 13 times in the last 8 minutes within 10 seconds of another model
loading, each before its own keep-alive expired: gemma3:1b, llama3.2:1b,
qwen2.5:1.5b", inferring "Memory contention may be causing the reloads". The
controller recorded 0 in-use displacements in all 20 runs, and it clears models
itself with `keep_alive: 0` between runs. In `/api/ps` an explicit unload looks
the same as an eviction, and only Wicklee's own `Probe` and `Fingerprint`
requests are excluded. That makes it a false positive for this rule under any
caller that unloads deliberately, and the hedge in the inferred statement is
doing real work.

### The dispatcher, live

```
$ node examples/dispatch.mjs --acceptable llama3.2:1b,gemma3:1b --num-ctx 4096 \
    --prompt "Say hello." --agent http://127.0.0.1:7999 --ollama http://127.0.0.1:11999
ask   llama3.2:1b: ready_now
decision  run llama3.2:1b — ready_now
ran   llama3.2:1b in 608 ms (load 541.018084 ms, 3 tokens)
receipt sent to Wicklee: HTTP 201

Hello.
```

`wicklee_readiness` over MCP answered **`ready_now`**. The receipt was
**accepted** (201). **The `ready_now` was wrong for this request.**
`llama3.2:1b` was resident at 8192 and the dispatch asked for 4096, so the
runtime reloaded it, 541 ms of load, and `ollama ps` afterwards showed it at
4096. Readiness has no context parameter, so it answers about the resident copy
whatever context the caller is about to use. That is the `context_reset` mistake
made by Wicklee's own consumer, after Wicklee said it was safe.

The stored receipt also lists `co_resident: gemma3:1b, llama3.1:8b,
qwen2.5:1.5b, qwen3.5:4b, qwen3.5:9b`, which includes three models that were
installed and not loaded. `ambient_from_states` in `agent/src/receipts.rs` adds
every tracked model state without checking residency. Recorded, not fixed.

### Smaller things

- `ollama-capabilities.mjs` defaults to `:11434` and, unlike the step 8 and 9
  scripts, does not refuse it. `examples/dispatch.mjs` defaults to `:7700` and
  `:11434`. Both were run with explicit private URLs.
- The runbook's tidy-up, `pkill -f "ollama serve"`, also matches the default
  Ollama app. The private processes were stopped by PID instead.
- `ollama-capabilities.mjs` was run with the private agent stopped, as its
  header asks, with `--model gemma3:1b --big-model llama3.2:1b`. V1 and V4 saw
  no split and no eviction at these sizes. V3 and V5 matched the earlier run.
  Its V8 answer is a static grep and was not re-checked.
- The `bandwidth_ceiling_reached` observation also appeared in `/v1/findings`
  during the hand-run alternation.

Raw:
[`bench-capabilities-m4-1b-2026-11-28.json`](bench-capabilities-m4-1b-2026-11-28.json),
[`bench-fault-inject-m4-1b-2026-11-28.json`](bench-fault-inject-m4-1b-2026-11-28.json),
[`bench-headroom-m4-1b-2026-11-28.json`](bench-headroom-m4-1b-2026-11-28.json),
[`bench-headroom-ctx131072-m4-1b-2026-11-28.json`](bench-headroom-ctx131072-m4-1b-2026-11-28.json),
[`bench-controller-4policy-m4-1b-2026-11-28.json`](bench-controller-4policy-m4-1b-2026-11-28.json),
[`bench-controller-m4-1b-2026-11-28.md`](bench-controller-m4-1b-2026-11-28.md),
[`bench-acceptance-m4-1b-2026-11-28.json`](bench-acceptance-m4-1b-2026-11-28.json).
The verify runs, the eviction bisection and the dispatcher run were done by hand
and are quoted here; they have no transcript.
