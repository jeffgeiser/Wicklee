# W3 on the Mac mini with 1b-class models

2026-11-28. Part of `docs/FIVE_DAY_PLAN.md` (W3). Run this **on the Mac mini**, in
a Claude Code session on that machine or by hand. A cloud session cannot reach it.

## Why 1b models

With the 4B to 9B models the first run used, a second model loaded alongside the
first either fit with nothing to spare or evicted it. That is why two things could
not be produced on 16 GB (`docs/PHASE1_RESULTS.md`):

- `baseline_regression`: co-loading the larger model *busy* evicted the model being
  measured, so the warm test had nothing to run on.
- The `improved` and `worse` verify verdicts: unit-tested, never measured live,
  because a real regression over the 5% floor needs a second model contending
  for memory.

1b-class models are small enough to stay resident together, so one can be held
busy while another is measured. Whether they can also induce eviction (the
displacement question) is **not known in advance**: it needs the contexts large
enough that their KV caches add up. The harness reports a scenario it cannot
induce as such rather than passing it. That is a result, not a failure.

## Before you start

- Keep everything off the installed service. The scripts refuse `:11434` and
  `:7700`. Use a private runtime and agent on other ports, as below.
- Spend: none. All local.

## 1. A private runtime and agent

```bash
# Shares ~/.ollama/models, so nothing is downloaded twice.
OLLAMA_HOST=127.0.0.1:11999 ollama serve &

cd agent && cargo build          # clippy/test do NOT produce a runnable binary
PORT=7999 WICKLEE_OLLAMA_PORT=11999 WICKLEE_DATA_DIR=/tmp/wk-bench-1b \
  ./target/debug/wicklee-agent &
```

Check with `lsof -nP -i -a -p <pid>`: loopback only, nothing to `:11434`.

## 2. Pick three 1b-class models

Three distinct small models, e.g. `llama3.2:1b`, `gemma3:1b` and `qwen2.5:1.5b`
(use whatever is installed or quick to pull; the harness needs `small`, `large`
and `other`, with `large` the biggest of them). Pull them against the private
runtime:

```bash
OLLAMA_HOST=127.0.0.1:11999 ollama pull llama3.2:1b
```

## 3. Write the scenario file from measurements, not guesses

```bash
cp scripts/bench/scenarios.example.json scripts/bench/scenarios.json
node -p process.platform        # darwin: put it in host.platform
```

Edit it. Delete `_template`. For each model, load it at the context you will run
it at and read the **resident** size off the private runtime:

```bash
OLLAMA_HOST=127.0.0.1:11999 ollama run llama3.2:1b --keepalive 5m "hi" >/dev/null
OLLAMA_HOST=127.0.0.1:11999 ollama ps        # resident size at that context
```

Use GB, to one decimal. `/api/tags` file sizes are not the resident size.

Then find, on this machine:

- `contexts.fits`: a context where all three fit together comfortably.
- `contexts.eviction_context`: the smallest context at which two of them, loaded
  together, stop both staying resident. 1b KV caches are small, so this may need a
  very large context, and may not exist below the model's maximum. If you cannot
  find one, say so in `host.notes`; do not guess a number.
- `contexts.too_large_for_accelerator`: a context that clearly exceeds the budget.
- `host.accelerator_budget_gb`: how the agent sees the budget. On this Mac it is
  75% of RAM when `iogpu.wired_limit_mb` reads 0 (11.6 GB on 16 GB).

The harness refuses a file that still has the template marker, placeholder names,
or the wrong `host.platform`.

## 4. Run, in this order

Each script loads and unloads models on the private runtime. Run `--plan` first.

```bash
node scripts/bench/ollama-capabilities.mjs --base-url http://127.0.0.1:11999 \
  --out docs/bench-capabilities-m4-1b-$(date +%F).json

node scripts/bench/fault-inject.mjs --plan
node scripts/bench/fault-inject.mjs --yes \
  --out docs/bench-fault-inject-m4-1b-$(date +%F).json

node scripts/bench/headroom-margin.mjs --yes \
  --out docs/bench-headroom-m4-1b-$(date +%F).json

node scripts/bench/reference-controller.mjs --yes \
  --out docs/bench-controller-4policy-m4-1b-$(date +%F).json \
  --md docs/bench-controller-m4-1b-$(date +%F).md

node scripts/bench/acceptance.mjs --yes \
  --out docs/bench-acceptance-m4-1b-$(date +%F).json
```

`headroom-margin.mjs` exits non-zero on any optimistic prediction. That is the
finding, not a script error. Do not "fix" the exit code.

## 5. What to look for, and what to record

| Question | Where it shows |
| --- | --- |
| Is `baseline_regression` now inducible, and does it fire? | `fault-inject`, scenario `baseline_regression` |
| Can a verify verdict of `improved` or `worse` be produced live? | `fault-inject` and `acceptance`; run `wicklee verify` against the finding |
| Does readiness's displacement answer hold with small models? | `headroom-margin`: any optimistic row |
| Do `wicklee` and `smallest_first` still tie? | `reference-controller`, four policies, five runs each |
| Which acceptance rows can this host now answer? | `acceptance`, which names the rows it cannot |

Then, still on the Mac mini:

1. Commit the raw transcripts under `docs/`, named for the host, model class and
   date, exactly as the earlier M4 ones are. Do not edit them.
2. Add a "1b-class models, 2026-11-xx" section to `docs/PHASE1_RESULTS.md`: what
   was inducible, what fired, what did not, and any optimistic readiness rows,
   with the numbers. A scenario that could not be induced goes in as such.
3. **Do not change any threshold or readiness behaviour from this host's
   evidence.** One machine is not evidence for a constant that ships. Findings
   go to W4 (`docs/DISPLACEMENT_DECISION.md`).

## 6. Tidy up

```bash
pkill -f target/debug/wicklee-agent; pkill -f "ollama serve"
rm -rf /tmp/wk-bench-1b
```

Do not commit `scripts/bench/scenarios.json` (it is git-ignored). Do commit
`scripts/bench/scenarios.m4-1b.json`, a copy of what you used, so the run can be
reproduced.
