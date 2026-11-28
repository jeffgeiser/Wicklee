# Examples

Small, dependency-free programs (Node 18+) that show how to consume Wicklee.
Nothing here ships in the agent binary.

## `fanout.mjs` — ask every node the same question

Wicklee has no aggregator: each node answers for itself, and the caller fans out
across them. This is that caller.

```bash
# On each node, once: let it be reached from the network, with a token.
#   config.toml:  bind_address = "0.0.0.0"
#                 auth_token   = "<a long random string>"
# The agent refuses to start on a non-loopback address without a token.

export WICKLEE_TOKEN=<the token>
node examples/fanout.mjs --nodes gpu-01,gpu-02,gpu-03:7800 --model llama3.1:8b
```

```
NODE           MODEL         READINESS                     HEADROOM  NOTE
gpu-01:7700    llama3.1:8b   ready_now                     18.2 GB   41 ms
gpu-02:7700    llama3.1:8b   requires_loading (unverified) 9.1 GB    38 ms
gpu-03:7800    -             -                             -         unreachable (ECONNREFUSED)
```

(Illustrative layout; the numbers are not from a run.)

- `--nodes-file nodes.txt` takes one `host[:port]` per line, `#` comments allowed.
- Omit `--model` to get every model each node knows about.
- `--json` prints the per-node results plus `example_policy_choice`.
- Exit status is 0 if every node answered, 1 if any did not.
- A failing node is a row in the table, not a crash: unreachable, timed out,
  needs a token, rejected the token, or model not installed there.

**The "example policy" line is not Wicklee's.** It picks the best-ranked answer
so the output has something to show. Wicklee publishes evidence and does not
route or schedule; replace it with your own rule. An answer marked
`(unverified)` fits by accounting only and may still displace a resident model,
which is the known readiness issue described in `docs/PHASE1_RESULTS.md`.

**The token authenticates you and does not encrypt anything.** Over plain http it
crosses the network readable, and the script says so when it sends one to a
non-loopback host. Use a trusted network or put the nodes behind TLS.

Tests: `node --test examples/fanout.test.mjs`. They use local fake nodes; the
auth paths were also checked by hand against two real agents bound to a
non-loopback address with a token. The answer rendering has not been exercised
against a live Ollama host yet.

## `dispatch.mjs` — ask before you load a model

The Stage 2 consumer: a job dispatcher that would otherwise just call Ollama,
and instead reads readiness first. It speaks MCP (JSON-RPC over HTTP, the same
`wicklee_readiness` tool an editor or agent framework calls), runs the job on
the model it chose, and sends the completion metadata back as a receipt.

```bash
# Decide only. Sends nothing to the runtime.
node examples/dispatch.mjs --acceptable llama3.1:8b,qwen3.5:4b --dry-run

# Decide, run, and report.
node examples/dispatch.mjs --acceptable llama3.1:8b,qwen3.5:4b \
  --num-ctx 8192 --prompt "Summarise this changelog: ..."
```

```
ask   llama3.1:8b: may_require_eviction; qwen3.5:4b: ready_now
decision  run qwen3.5:4b — ready_now
ran   qwen3.5:4b in 1180 ms (load 6 ms, 212 tokens)
receipt sent to Wicklee: HTTP 200
```

(Illustrative layout; the numbers are not from a run.)

**The rule is yours.** Wicklee answers `ready_now`, `requires_loading`,
`may_require_eviction` or `cannot_determine` per model; it does not choose. The
rule in the file is: run the first acceptable model that is `ready_now`;
otherwise wait and ask again; after `--defer-timeout` seconds either run nothing
(`--on-timeout fail`, the default, exit 3) or run the first model anyway
(`--on-timeout proceed`, recorded as an override). Replace it with your own.

**`requires_loading` is not treated as safe.** While another model is resident
the answer carries `coexistence: "unverified"`, and on the one host measured the
runtime evicted a resident model in 5 of 6 such cases
(`docs/PHASE1_RESULTS.md`). `--accept-unverified` opts in, and the decision
record says that you did.

**`--num-ctx` is required.** Leaving it out reloads the model at the runtime's
4096 default, which is the finding `context_reset`; the example refuses to run
without it.

**Your prompt and the output stay between you and your runtime.** The receipt is
built from an allowlist of numeric fields. Ollama's reply also contains
`response` and `context`, which Wicklee's receipts route refuses; they are never
copied, and a test asserts neither the prompt nor the output reaches the agent.

Tests: `node --test examples/dispatch.test.mjs` (a fake agent that speaks MCP and
a fake runtime). The MCP calls were also checked by hand against a real agent with
no runtime behind it, where every model is `cannot_determine` and the dispatcher
waits, times out and runs nothing. **It has not been run against a live Ollama
host**, so there is no measurement yet of avoided reloads; that is W3 and the
`reference-controller` re-run.
