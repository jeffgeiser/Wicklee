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
