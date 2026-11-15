# Phase 1 results — `wicklee inspect`

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
  memory, which 16 GB cannot do while one of them is busy.
