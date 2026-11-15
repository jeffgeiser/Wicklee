# Benchmark and fault-injection harness

Phase 1, steps 0, 8 and 9. Node scripts with no dependencies, Node 18+. Nothing
here ships in the agent binary.

| Script | What it does |
| --- | --- |
| `ollama-capabilities.mjs` | Step 0. Records real Ollama responses and answers V1–V9 from `docs/PHASE1_SPEC.md` |
| `fault-inject.mjs` | Step 8. Creates each condition the diagnostic rules are meant to catch, then asks the agent whether it caught it |
| `reference-controller.mjs` | Step 8. Three policies choose a model for a workflow step; measures whether reading readiness changed the decision and whether that was worth anything |
| `headroom-margin.mjs` | Step 9. Loads every ordered pair of declared models and records whether both stayed resident, against what readiness predicted. Exits non-zero on any optimistic prediction |
| `acceptance.mjs` | Step 9. Runs the acceptance rows that fit one pass — reproducible, evidence, no side effects, overhead — and names the rows this host cannot answer rather than skipping them |

Results from the maintainer's M4, with method and raw transcripts:
[`docs/PHASE1_RESULTS.md`](../../docs/PHASE1_RESULTS.md).

## Set up a host you can disturb

Every script except `--passive` and `--plan` loads and unloads models. Do not
point them at the runtime your installed service is watching: that agent's
probe resets `expires_at`, which it attributes to a real caller, and the
transitions the harness is trying to create would be mixed in with its own.
Both step 8 scripts refuse to run against `:11434` or `:7700` for that reason.

```bash
# A private runtime. Shares ~/.ollama/models, so nothing is downloaded.
OLLAMA_HOST=127.0.0.1:11999 ollama serve &

# An agent pinned to it, with its own store and the fleet switched off.
cd agent && cargo build        # clippy/test do NOT produce a runnable binary
PORT=7999 WICKLEE_OLLAMA_PORT=11999 WICKLEE_DATA_DIR=/tmp/wk-bench \
  ./target/debug/wicklee-agent --no-cloud
```

Both halves are load-bearing. Without `WICKLEE_OLLAMA_PORT` the harvester
falls back to `:11434`; without `WICKLEE_DATA_DIR` the agent cannot create its
store under the root-owned config directory and every rule reads an empty
window. Check with `lsof -nP -i -a -p <pid>`: loopback only, nothing to
`:11434`.

## Fill in a scenario file

```bash
cp scripts/bench/scenarios.example.json scripts/bench/scenarios.json
```

Then edit it. Nothing in it is guessed from your machine, deliberately: model
names, resident footprints and which contexts do or do not fit are things only
you know, and a harness that assumed them would induce the wrong condition and
report a pass. Read the footprints off `ollama ps` while each model is loaded —
the file size in `/api/tags` is not the resident size.

## Run

```bash
node scripts/bench/fault-inject.mjs --plan            # what it would do
node scripts/bench/fault-inject.mjs --yes             # all six scenarios
node scripts/bench/fault-inject.mjs --only healthy --yes

node scripts/bench/reference-controller.mjs --plan
node scripts/bench/reference-controller.mjs --runs 5 --yes
```

Both write a raw JSON transcript; the controller also writes a Markdown summary
with medians and ranges, and records the hardware, models, Ollama version and
agent version alongside the numbers.

## How to read the results

`fault-inject.mjs` reports one of four outcomes per scenario, and prints the
statement each finding produced so the words can be read rather than trusted:

- **fired** — the condition was induced and the expected rule caught it.
- **quiet** — for the healthy control, where no finding is the pass.
- **not_inducible** — this hardware cannot produce the condition, with the
  reason. A result about the hardware, not a skipped test. `cpu_split` is the
  usual one: on unified memory the runtime reports `size_vram` equal to `size`,
  so no part of the footprint is outside the accelerator and there is no split
  to find.
- **missed** — induced, and nothing caught it. A failure. The transcript holds
  the whole `/v1/inspect` body so it can be worked out without re-running.

`reference-controller.mjs` compares three policies, and the baseline that
matters is `loaded_check`, not `naive`. Any careful integration already reads
`/api/ps` before choosing, so beating `naive` proves nothing. Readiness should
win only where `/api/ps` cannot see the answer: when no acceptable option is
loaded, and one choice would evict the model the other workflow is using while
another would fit beside it.

**A tie is a real result.** On a host with room for every option, all three
policies choose the same model and the report says `tie`. The spec is explicit
that this demonstration does not gate the release: a null result is a finding
about whether readiness adds anything beyond a loaded-model check on that
hardware, and it says nothing about whether the diagnostics are useful. Those
are separate hypotheses, judged separately.

A deferral is counted as cost, not as a win. When the `wicklee` policy waits,
the wait is added to the step's end-to-end time, so a policy that avoids every
displacement by always waiting does not come out ahead for free.

**An unverified fit counts as a risk.** Step 9 measured what the first version
of the `wicklee` policy assumed: a `requires_loading` answer means the model
fits by memory accounting, and on the one host tested the runtime still evicted
a resident model in five of six such cases. The agent now marks those answers
`coexistence: "unverified"`, and the policy treats one as unsafe while anything
in use is resident. That is a harder bar than the first run cleared, and it can
turn a choice into a deferral — which is the trade the numbers are there to
show.
