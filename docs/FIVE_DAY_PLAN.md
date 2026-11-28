# Five-day plan: Stage 2 and the displacement decision

2026-11-25. Source: `docs/ROADMAP.md` Stage 2 and `docs/PHASE1_RESULTS.md`.

The goal of these five days is to move Stage 2 ("agent decision value") from
*built, unproven* to a result, and to settle what readiness is allowed to
promise about displacement. Either outcome of Stage 2 is publishable
(`docs/STRATEGY.md` §13): "readiness adds little beyond a loaded-model check on
this class of hardware" is a finding, not a failure.

Nothing here changes what the website claims until a result exists.

## Work items

| # | Item | Owner | Depends on | Done when |
| --- | --- | --- | --- | --- |
| W1 | Make the bench harness host-neutral — **done 2026-11-25** | Claude Code | Nothing | `scripts/bench/scenarios.json` is no longer the M4's values committed as the default (the M4's become `scenarios.m4.json`; the default is generated from `scenarios.example.json` and ignored by git). `scripts/bench/README.md` and `fault-inject.mjs` no longer tell anyone to pass `--no-cloud`, which the agent ignores now. A fresh checkout runs the harness against a scenarios file you wrote, and refuses to run on the M4's |
| W2 | Pick and provision the second host | **Maintainer** | Nothing | A machine with a discrete NVIDIA GPU and enough VRAM that two models of different sizes can coexist (24 GB or more recommended), Ollama installed, a spend cap agreed, and a way for Claude Code to run on it (a Claude Code session on that host, or you run the scripts and commit the transcripts). The DGX Spark is the third host, if it is free |
| W3 | Run the full bench on the second host (the Mac mini with 1b-class models can go first: [`MAC_MINI_1B_RUN.md`](MAC_MINI_1B_RUN.md)) | Claude Code (on that host) | W1, W2 | Raw transcripts committed under `docs/` for `ollama-capabilities`, `headroom-margin` (every ordered pair), `fault-inject`, `reference-controller` (all four policies) and `acceptance`, each named for the host and date |
| W4 | Host comparison and the displacement write-up | Claude Code | W3 | A host comparison in `docs/PHASE1_RESULTS.md` and a new `docs/DISPLACEMENT_DECISION.md` that sets out the three options with evidence from both hosts and **does not choose one** |
| W5 | Decide, then fix readiness | **Maintainer decides**, then Claude Code | W4 | The chosen option is recorded in `docs/DISPLACEMENT_DECISION.md`; the change is implemented; `headroom-margin.mjs` exits zero on both hosts, or `coexistence: "unverified"` stays and the page says why |
| W6 | A real agent integration for Stage 2 — **consumer done 2026-11-28; the two-host re-run waits on W3** | Claude Code | W1 | A small consumer that does what the landing page describes: an agent or script that calls `wicklee_readiness` before dispatching a job, in `examples/` with a README. `reference-controller` is re-run on both hosts. The result, win or tie, goes in `docs/PHASE1_RESULTS.md` and `docs/ROADMAP.md` |
| W7 | A tested multi-node fan-out example — **done 2026-11-25** | Claude Code | Nothing | `examples/fanout.mjs` asks several nodes `/v1/readiness` with a bearer token and prints the answers side by side. Tested against two local agents with `bind_address` and `auth_token` set. This is the code behind the "Across your machines" card on the home page |
| W8 | Finish the v0.16.0 release | **Maintainer** | Nothing | Release assets are the four binaries plus `SHA256SUMS`; the "v0.16.0 — Local only" notes are in the release body; `install.sh` upgrades a v0.15.0 machine to v0.16.0 and `wicklee --version` agrees |

### What W1 and W7 delivered

- **W1:** `scripts/bench/lib/scenarios.mjs` is a shared loader that refuses an
  unfilled template, placeholder names, a file written for another platform
  (`host.platform`) and missing keys. The M4's values moved to
  `scenarios.m4.json`; `scenarios.example.json` is now placeholders marked
  `_template`; `scenarios.json` is git-ignored. `--no-cloud` is gone from the
  harness docs. Tested with `node --test scripts/bench/lib/scenarios.test.mjs`.
- **W6 (consumer):** `examples/dispatch.mjs` speaks MCP, applies an
  operator-written rule (first `ready_now`, else defer; `requires_loading` not
  treated as safe unless opted in), always sends `num_ctx`, runs the job and posts
  an allowlisted receipt. Tests pin the rule, the timeout behaviour and that the
  prompt and output never reach the agent. Checked over real MCP against a real
  agent with no runtime behind it. Still open: running it, and the
  `reference-controller`, on a live host; that is what produces the Stage 2
  result, win or tie.
- **W7:** `examples/fanout.mjs` with a README and tests. Auth and failure paths
  were checked against two real agents on a non-loopback address; the readiness
  answers themselves have not been exercised against a live Ollama host, which
  is W3.

## Suggested order

| Day | Work |
| --- | --- |
| 1 | W8 (you), W1 (Claude Code), W2 decision and provisioning (you) |
| 2 | W3 begins on the second host; W7 in parallel on the Mac mini |
| 3 | W3 finishes; W4 written; W6 started |
| 4 | You read `DISPLACEMENT_DECISION.md` and decide (W5); the fix lands |
| 5 | W6 re-run on both hosts and written up; website and roadmap updated only for what now has a result |

## Risks to watch

- **A second GPU host may not separate readiness from the size-sorting
  heuristic either.** That is a valid result. Report it as one.
- **Discrete VRAM has different eviction behaviour from unified memory.** Do not
  carry a constant from the M4 to the new host, or the other way round. The M4
  result is the reason nothing was patched from one machine's evidence.
- **Cost.** A rented GPU bills while it idles between sessions. Agree the cap in
  W2 and stop the instance at the end of each day.
- **The harness loads and unloads models.** Never point it at a runtime your
  installed agent is watching; the scripts refuse `:11434` and `:7700`.
