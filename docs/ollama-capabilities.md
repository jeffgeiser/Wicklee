# Ollama Capabilities — Verified on a Real Host

Phase 1, step 0. Answers V1 to V9 from `docs/PHASE1_SPEC.md` against a real
Ollama install. Nothing here is taken from documentation: every answer below
came out of a response this host actually returned.

Re-run with:

```bash
node scripts/bench/ollama-capabilities.mjs --base-url http://127.0.0.1:11500 --model qwen3.5:4b --big-model qwen3.5:9b --yes
```

## Test environment

| Item | Value |
| --- | --- |
| Date | 2026-11-13 |
| Host | Mac16,10 · Apple M4 · 16 GB unified memory · Darwin 25.5.0 |
| `iogpu.wired_limit_mb` | `0` (unset — effective GPU budget is the system default, ~75% of RAM) |
| Ollama version | **0.40.16** (`GET /api/version`, confirmed identical on both instances) |
| Ollama binary | `/usr/local/bin/ollama`, app bundle at `/Applications/Ollama.app` |
| Installed models | `qwen3.5:4b` (3.39 GB), `llama3.1:8b` (4.92 GB), `qwen3.5:9b` (6.59 GB) — all Q4_K_M |
| Wicklee agent | **v0.11.1**, running as root via `/Library/LaunchDaemons/dev.wicklee.agent.plist` |
| Wicklee proxy | Off — no `[ollama_proxy]` section in `config.toml` |

### How Ollama was started

Two instances were involved. This matters for reading the results, so both are
recorded.

**The host's own instance, on `127.0.0.1:11434` — not used for measurement.**

Started by the Ollama desktop app at boot: `/Applications/Ollama.app/Contents/MacOS/Ollama`
(pid 904) spawns `/Applications/Ollama.app/Contents/Resources/ollama serve`
(pid 947) as the user `roamwild`. Its full environment, read from the live
process:

```
OLLAMA_NO_CLOUD=0
OLLAMA_MODELS=/Users/roamwild/.ollama/models
```

No `OLLAMA_HOST`, so it takes the default `127.0.0.1:11434`. No
`OLLAMA_KEEP_ALIVE`, so expiry is the 5-minute default. No
`OLLAMA_MAX_LOADED_MODELS` and no `OLLAMA_NUM_PARALLEL`.

A user LaunchAgent `~/Library/LaunchAgents/com.ollama.startup.plist` also exists
(`/usr/local/bin/ollama serve`, `KeepAlive`, `RunAtLoad`). It cannot bind 11434
because the app bundle's instance already holds it, so `launchctl list` shows it
with last exit status `1`. That crash-loop predates this work and was left alone.

**The measurement instance, on `127.0.0.1:11500` — where every V answer came from.**

```bash
OLLAMA_HOST=127.0.0.1:11500 \
OLLAMA_MODELS=/Users/roamwild/.ollama/models \
  ollama serve
```

Same binary, same model store, read-only use of it. One block of trials also set
`OLLAMA_MAX_LOADED_MODELS=3`, noted inline under V4 where it applies. This
instance was stopped at the end of the run, all its models unloaded first, and
the host was verified back to its starting state: one `ollama serve` (pid 947),
one listener on 11434, nothing on 11500.

### What was done about the Wicklee probe

**Neither of the two things the task asked for, because neither was possible in
this session. The probe was isolated instead.**

The agent runs as root from a LaunchDaemon, and its config lives at
`/Library/Application Support/Wicklee/config.toml`, owned `root:wheel` mode 644.
Stopping the daemon needs `launchctl bootout system/...` and setting
`[probe] enabled = false` needs a write to that file. Both need root, and
`sudo -n true` fails on this host — there is no passwordless sudo and no way to
answer a password prompt from here. So the agent was left running, untouched,
for the whole run.

What was done instead: **all measurements ran against the private instance on
11500, which the agent provably cannot discover.** The agent finds Ollama
through `process_discovery::RUNTIME_SPECS`, where the `ollama` entry declares
`port_arg: "--port"`. Ollama takes no `--port` flag — it reads `OLLAMA_HOST` —
so `RuntimeSpec::extract_port` always falls through to `default_port: 11434`
for every Ollama process it matches, whatever `OLLAMA_HOST` that process was
given. The agent therefore polls and probes 11434 and only 11434. The probe
cannot reach 11500.

Two consequences, both recorded rather than hidden:

1. **The agent kept probing 11434 throughout.** `/var/log/wicklee.log` shows a
   steady run of `[ollama] probe http://127.0.0.1:11434/api/generate → HTTP 200 OK`.
   That traffic never touched the measurement instance, but it did hold
   `llama3.1:8b` (5.28 GB) resident on a 16 GB machine for most of the run. V4
   is the one answer that memory confound reaches, and it is called out there
   with before-and-after numbers.
2. **The deployed agent is v0.11.1, not the v0.12.0 the spec describes.** Its
   probe has a fallback that the current code does not:
   `[ollama] probe fallback — no model in /api/ps, discovered: llama3.1:8b`.
   The 0.11.1 probe *loads a model when none is loaded*. Commit `0b10a92`
   ("perf(agent): stop idle probes from loading models") removed it, and
   `grep -rn 'probe fallback' agent/src/` finds nothing on `origin/main`. So the
   spec's statement that "the code already skips unloaded models" is true of
   `origin/main` and false of the binary actually running on this host. This is
   why unloading everything on 11434 was not a usable way to quiet the probe —
   the 0.11.1 fallback reloads a model within one probe interval.

## Answers

| # | Verdict |
| --- | --- |
| V1 | **Yes** — confirmed, with the arithmetic closing to the megabyte |
| V2 | **Yes** — `/api/ps` returns `context_length` |
| V3 | **Yes** — omitting `num_ctx` reloads the model at the server default. The current probe does exactly this |
| V4 | **Memory-gated, non-deterministic, and it evicts every resident model, not one victim** |
| V5 | **Yes** — per-model, every request, and unload lands within ~90 ms of `expires_at` |
| V6 | **No signal.** `prompt_eval_count` is not even clamped to the context |
| V7 | **Answered** — and it carries `details.context_length`, which removes an `/api/show` call |
| V8 | **No.** The agent cannot see a peer address at all |
| V9 | **Partly.** The blob is locatable via the manifest, page-cache state is not readable |

---

### V1 — Does `size` minus `size_vram` equal the part outside accelerator memory?

**Yes, on Apple Silicon, and the residue is the runtime footprint, not just weights.**

A fully-resident model reports the two fields as exactly equal, so no split is
visible until one is forced:

```
qwen3.5:4b  ctx=4096    size=3150257846  size_vram=3150257846  residue=0
qwen3.5:4b  ctx=32768   size=4324809767  size_vram=4324809767  residue=0
```

Note `size` grew by 1.17 GB when the context grew — **`size` includes the KV
cache**, not only weights.

Loading `llama3.1:8b` at its full 131072 context does not fit, and the split
appears:

```
llama3.1:8b  ctx=131072  size=23073149416  size_vram=11170134096
             residue=11903015320  (51.6% outside)
```

The runner log corroborates it exactly:

```
load_tensors: offloaded 16/33 layers to GPU
load_tensors:          CPU model buffer size =   282.34 MiB
load_tensors:   CPU_REPACK model buffer size =  2112.75 MiB
llama_kv_cache:        CPU KV buffer size =  8704.00 MiB
llama_context:        CPU  output buffer size =     0.49 MiB
sched_reserve:        CPU compute buffer size =   252.02 MiB
```

Those CPU-side buffers sum to 11351.60 MiB. The reported residue is
11903015320 bytes = 11351.57 MiB. They agree to 0.03 MiB.

**For `cpu_split`:** the rule is viable, and `size_vram` is meaningful on Apple
Silicon despite unified memory — it is the Metal allocation, not the whole
footprint. But the residue is weights **plus KV cache plus compute buffers**, so
the statement must say "of its runtime footprint" and not "of its memory". On
this host the dominant term was the KV cache (8.7 GB of 11.4 GB), which means a
`cpu_split` finding is usually a statement about context size, not model size.

### V2 — Does this install return `context_length` in `/api/ps`?

**Yes.** Every loaded model carried it. Full per-model key set observed:

```
name, model, size, digest, details, expires_at, size_vram, context_length, runner
```

`runner` (value `"llamacpp"`) is undocumented and not in the spec's field list.
Every field the spec's `RuntimeCaps` checks for was present:
`ps_size_vram`, `ps_context_length`, `ps_expires_at`, `ps_digest` all true here.

The running context was `4096` while `/api/show` reports a maximum of `262144`
for the same model. The spec's "running context is not read" gap is real and the
two numbers differ by 64x.

### V3 — Does a request omitting `num_ctx` reload the model at the default?

**Yes. This is the most consequential answer in the set.**

From a clean load, then an explicit larger context, then one request that omits
`num_ctx` entirely:

```
server default context, from a clean load : 4096
after explicit num_ctx=8192               : context_length=8192
after a request with no num_ctx           : context_length=4096
that request reported load_duration       : 2622 ms
```

A non-zero `load_duration` on a model that was already resident is the reload.
Reproduced a second time at 65536 → 4096 with `load_duration=2872 ms`.

**For the probe:** `probe_ollama_tps` in `agent/src/harvester.rs` sends
`options: { num_predict: 20 }` and no `num_ctx`. So on any host where a model is
loaded with a non-default context, **the existing probe silently reloads it at
4096 every probe interval** — a multi-second stall and a configuration change,
not the read-only measurement the comment claims. This is a live bug in 0.12.0,
not only a Phase 1 design constraint.

**For fingerprint and verify:** the spec already requires passing the running
`context_length` as `num_ctx`. That requirement is confirmed and is mandatory,
not defensive.

### V4 — Which model does Ollama unload, and what limits how many stay loaded?

**The gate is free memory, the outcome is not reproducible, and when a load does
not fit, every resident model is evicted — not one victim.**

Co-residency does happen. With 11434 drained and nothing else holding memory,
two models stayed loaded together:

```
after qwen3.5:4b  : qwen3.5:4b
after llama3.1:8b : llama3.1:8b, qwen3.5:4b     (3.15 + 5.28 = 8.43 GB)
```

Adding a third that does not fit removed **both**, not the least-recently-used one:

```
after qwen3.5:9b  : qwen3.5:9b
```

Reproduced twice, including a trial that deliberately touched `qwen3.5:4b` first
to make it most-recently-used. It was evicted anyway.

The same two-model sequence is not stable. Three later trials, measured with
reclaimable memory recorded before each load, never achieved co-residency:

| Trial | Reclaimable before | After `4b` | After `8b` |
| --- | --- | --- | --- |
| 1 | 6.74 GB | `qwen3.5:4b` | `llama3.1:8b` only |
| 2 | 6.46 GB | `qwen3.5:4b` | `llama3.1:8b` only |
| 3 | 6.53 GB | `qwen3.5:4b` | `llama3.1:8b` only |

It is not a count ceiling: `OLLAMA_MAX_LOADED_MODELS=3` changed nothing, and
single-residency still occurred under it. The variable that tracked the outcome
was free memory at load time, which on a 16 GB host moves with everything else
running — including the 5.28 GB the agent's own probe was holding on 11434.

Neither `OLLAMA_MAX_LOADED_MODELS` nor `OLLAMA_NUM_PARALLEL` nor the victim
policy is exposed anywhere in the HTTP API. There is no endpoint to read them.

**For readiness:** three separate corrections fall out of this, all of them
tightening claims the spec currently allows.

1. `Displacement::Confirmed` requires "unloaded the same model every time, at
   least twice, with the same set of loaded models". **Not reachable on this
   host** — the same sequence with the same resident set gave different
   outcomes minutes apart. The level should stay in the type, but a host like
   this one will never earn it, and nothing should be built assuming it will.
2. `would_displace` is typed `Vec<Victim>`, which is right, but the observed
   behaviour is *all* residents going at once. A `Likely` answer that names the
   single loaded model is correct; any answer on a multi-model host should be
   `UnknownVictim` and say the whole resident set is at risk.
3. `RequiresLoading` is defined as "footprint plus a safety margin fits in free
   memory". Fitting measured once does not predict fitting again here. The
   safety margin needs to be large, and the `valid_for_s` of two poll intervals
   is doing real work — a readiness answer on this host is a snapshot, not a
   forecast.

**For `eviction_churn`:** the rule's inferred statement is "memory contention
may be causing the reloads". On this host that is the correct cause, but it is
worth stating that a host with a low `OLLAMA_MAX_LOADED_MODELS` would produce
identical transitions from a concurrency ceiling instead, and Wicklee cannot
read that variable to tell the two apart. The inferred wording should stay at
"may", and should not assert memory specifically unless free memory was
observed to be low at the time.

### V5 — Does `expires_at` move on every request, and does unload follow it?

**Yes to both, and per model.**

Three consecutive requests, each moving the stamp:

```
request 1: 09:30:44.127687 → 09:30:46.035450  (moved)
request 2: 09:30:46.035450 → 09:30:47.619201  (moved)
request 3: 09:30:47.619201 → 09:30:49.202968  (moved)
```

Per-model independence confirmed: with two models resident, touching only
`qwen3.5:4b` moved that model's `expires_at` and left the other's alone.

Unload fidelity, via `keep_alive: 5` and a 500 ms poll: the model disappeared
from `/api/ps` **+82 ms** past its stated `expires_at` on the first run and
**+89 ms** on a repeat. Expiry is accurate enough to separate a keep-alive
unload from an eviction by timestamp alone.

**For `expiry_reload` and `eviction_churn`:** both are supported. An unload
within ~100 ms of a model's own `expires_at` is an expiry; an unload well before
it is an eviction. That is a clean discriminator and the spec's 10 s windows are
generous against a 90 ms reality.

### V6 — Is there any signal that a prompt was cut to fit the context?

**No, and the obvious proxy is worse than useless.**

A ~4000-word prompt into `num_ctx: 512`:

```
prompt_eval_count        = 1026
done_reason              = length
response keys            = model, created_at, response, thinking, done, done_reason,
                           context, total_duration, load_duration, prompt_eval_count,
                           prompt_eval_cached_count, prompt_eval_duration,
                           eval_count, eval_duration
```

No key matching `trunc|cut|drop|shift|discard|overflow`. And note
`prompt_eval_count = 1026` against `num_ctx = 512`: **the count is not clamped
to the context**, so the spec's proposed trigger — "`prompt_eval_count` is at
the running context length" — would not fire on an actually-truncated prompt.
The runner was started with `--context-shift`, which discards early tokens
silently by design.

`done_reason: "length"` refers to output hitting `num_predict`, not input
truncation.

**For `context_limit`:** do not build it. The spec makes it conditional on V6
finding a reliable signal. There is none, the one indirect proxy is
contradicted by measurement, and the rule should be dropped from Phase 1 rather
than shipped off-by-default — an off-by-default rule still carries code,
config surface and a `RuntimeCaps` flag for a signal that does not exist.

### V7 — What does `GET /api/tags` return per installed model?

Top-level keys per model:

```
name, model, modified_at, size, digest, details, capabilities
```

`details` keys:

```
parent_model, format, family, families, parameter_size,
quantization_level, context_length, embedding_length, runner
```

Observed values:

| Model | `size` (file) | `details.context_length` | `capabilities` |
| --- | --- | --- | --- |
| `llama3.1:8b` | 4920753328 | 131072 | completion, tools |
| `qwen3.5:4b` | 3389983735 | 262144 | completion, vision, tools, thinking |
| `qwen3.5:9b` | 6594474711 | 262144 | completion, vision, tools, thinking |

Two things the spec does not assume and should:

- **`details.context_length` is here**, so the model's maximum context for a
  never-loaded model needs no `/api/show` call. `tags_available` in
  `RuntimeCaps` is worth splitting to record this sub-field.
- **`size` is the installed file size** and it is *larger* than the `size`
  `/api/ps` reports for the same model loaded (`qwen3.5:4b`: 3.39 GB installed,
  3.15 GB resident at ctx 4096). The spec's footprint source 2 is "installed
  file size with the overhead estimate from `scoring.rs`" — adding overhead to
  a number that is already above the observed resident size will overestimate.
  Source 2 should be calibrated against source 1 before it is trusted.

### V8 — Do the agent's POST routes check the peer address?

**No. They cannot — the agent never asks for the peer address.**

```
$ grep -rnE 'ConnectInfo|into_make_service_with_connect_info|SocketAddr|peer_addr' agent/src/*.rs
(no matches)
```

`agent/src/main.rs:1058` serves `axum::serve(listener, app)` with no
`ConnectInfo` layer, so no handler can reach the client address even if it
wanted to. The existing POST routes — `/api/pair/generate`, `/api/pair/claim`,
`/api/pair/disconnect`, `/mcp`, `/api/insights/dismiss` — are reachable from
anywhere `bind_address` allows, with no authentication of any kind. There is no
token mechanism in `config.rs`: `session_token` is the *outbound* cloud
credential, not an inbound one.

**For Phase 1:** `axum::serve` must become
`app.into_make_service_with_connect_info::<SocketAddr>()` before the first
`/v1` POST ships, and the whole remote-access table in the spec (loopback,
token, `allow_unauthenticated`, refuse-to-start) is new code with no existing
foundation to extend. The spec is right that this is a behaviour change; it is
a larger one than "the POST routes check the peer address themselves" implies.

### V9 — Can the agent find a model's file and tell whether it is page-cached?

**The file is locatable, but not from `/api/tags` alone. Page-cache state is not
readable within the project's constraints.**

The `digest` in `/api/tags` is the **manifest** digest, not the weights blob.
Resolving it directly fails:

```
/api/tags digest for qwen3.5:4b : 2a654d98e6fb...4eefd
candidate blob                  : .../blobs/sha256-2a654d98e6fb...4eefd  (missing)
```

The real path needs the manifest file at
`~/.ollama/models/manifests/registry.ollama.ai/library/qwen3.5/4b`, whose
`layers` array gives the weights blob:

```
model    3389.97 MB  exists=True
license     0.01 MB  exists=True
params      0.00 MB  exists=True
```

So locating the file means reading Ollama's on-disk manifest layout — a
filesystem dependency on a private layout, not an API call. It also assumes the
agent can read `OLLAMA_MODELS`, which it can here but need not be true when
Ollama runs as another user or in a container.

Page-cache state has no usable route: macOS offers no `fincore` equivalent, and
`mincore(2)` is a libc call that needs `unsafe` FFI, which the project's "no
`unsafe` except NVML" rule forbids. Neither `fincore` nor `vmtouch` is installed.

**For cold receipts:** record `ColdUnknown`, exactly as the spec already allows.
`ColdCached` and `ColdUncached` should stay in the enum but nothing in Phase 1
should be built expecting to distinguish them. The "never average across start
states" rule still matters, because a cold load right after an unload is warm in
the page cache and one after a reboot is not — Wicklee just cannot tell which it
got.

## Capability record, as measured

What `RuntimeCaps` would be set to on this host:

```rust
RuntimeCaps {
    version:                      Some("0.40.16"),
    ps_size_vram:                 true,
    ps_context_length:            true,
    ps_expires_at:                true,
    ps_digest:                    true,
    gen_load_duration:            true,
    gen_prompt_eval_count:        true,
    gen_prompt_eval_cached_count: true,
    tags_available:               true,
}
```

Every documented field the spec depends on is present on this install. The
problems found in step 0 are not missing fields — they are fields that mean
something other than what a rule would assume.

## Undocumented fields worth typing

`ollama_client.rs` should carry these as optional, since they were observed but
are not in the documentation the spec checked:

| Endpoint | Field | Observed |
| --- | --- | --- |
| `/api/ps` | `runner` | `"llamacpp"` |
| `/api/tags` | `capabilities` | `["completion","vision","tools","thinking"]` |
| `/api/tags` | `details.context_length` | `131072`, `262144` |
| `/api/tags` | `details.embedding_length` | present |
| `/api/tags` | `details.runner` | `"ggml"` |
| `/api/generate` | `thinking` | present, non-null on thinking models |
| `/api/show` | `renderer`, `parser`, `template_source`, `requires`, `thinking` | present |

### `model_info` is architecture-namespaced — and the harvester gets it wrong

`/api/show` → `model_info` prefixes architecture keys with the model's own
architecture, not `llama`. `agent/src/harvester.rs` hardcodes `llama.*`:

| Key the harvester reads | `llama3.1:8b` | `qwen3.5:4b` |
| --- | --- | --- |
| `general.context_length` | **absent** | **absent** |
| `llama.context_length` | 131072 | **absent** |
| `llama.block_count` | 32 | **absent** |
| `llama.attention.head_count_kv` | 8 | **absent** |
| `llama.attention.head_count` | 32 | **absent** |
| `llama.embedding_length` | 4096 | **absent** |

`qwen3.5:4b` exposes the same information under `qwen35.*`
(`qwen35.block_count = 32`, `qwen35.context_length = 262144`,
`qwen35.embedding_length = 2560`). So on this host, every KV-cache and context
field in `MetricsPayload` is silently `None` for two of three installed models.
`general.context_length` is absent on both, meaning the first branch of the
harvester's `.or_else()` chain never fires on either model.

One further trap: `qwen35.attention.head_count_kv` is an **array**, not a scalar —
`[0,0,0,4,0,0,0,4, ...]`, per-layer KV heads for a hybrid-attention model. A
generic `<arch>.attention.head_count_kv` lookup with `as_u64()` would still
return `None`. `ollama_client.rs` must read the architecture from
`general.architecture` and build the key from it, and must handle both scalar
and array forms.

## Baseline measurements

Per the spec's cleanup rule 5.

| Measurement | Value |
| --- | --- |
| `agent/src` total | **15,250 lines** (22 files) — matches the spec's figure exactly |
| Largest modules | `store.rs` 2,031 · `observations.rs` 1,846 · `harvester.rs` 1,457 · `hardware.rs` 1,079 · `main.rs` 1,064 |
| `Cargo.toml` version | `0.12.0` |
| Release binary | **22.7 MB**, from the installed `~/.wicklee/bin/wicklee` — but that is **v0.11.1**, not 0.12.0. Superseded; see below |

The binary figure was the one weak number in this document. Step 0 is scoped to
exclude writing or building product code, so the only binary on the host was the
deployed 0.11.1 one, and the "before and after" the cleanup plan asks for would
have compared two different versions.

**Resolved in step 1.** `cargo build --release` was run on pristine
`origin/main` at `65fb3d9`, same host and toolchain (rustc 1.94.1,
aarch64-apple-darwin):

| Measurement | Value |
| --- | --- |
| **Phase 1 baseline — pristine 0.12.0 release binary** | **24,411,328 bytes (23.28 MB)** |
| `agent/src` at that commit | 15,250 lines |
| After step 1 | 24,477,808 bytes (23.34 MB), 17,219 lines |
| Delta | +66,480 bytes (+0.27%), +1,969 lines |

Use 24,411,328 bytes as the before-Phase-1 figure, not the 22.7 MB above.

## What changes in the spec

Collected here; the full list including non-capability findings is in
`docs/CLEANUP_AUDIT.md` under "Spec deviations".

| Spec item | Change | Why |
| --- | --- | --- |
| `context_limit` rule | **Drop from Phase 1** | V6: no signal exists, and `prompt_eval_count` is not clamped to the context, so the proposed trigger is wrong |
| `cpu_split` statement wording | "of its runtime footprint" not "of its memory" | V1: the residue is weights + KV cache + compute buffers, usually KV-dominated |
| Probe `num_ctx` | Probe must send the running `context_length` | V3: the current probe reloads any non-default context to 4096 on every interval |
| `Displacement::Confirmed` | Keep the level, expect it to be unreachable | V4: the same sequence and resident set gave different outcomes |
| `would_displace` on multi-model hosts | Prefer `UnknownVictim`; the whole resident set is at risk | V4: a non-fitting load evicted every resident model, twice, including the MRU one |
| Footprint source 2 | Calibrate against source 1 before trusting | V7: installed file size exceeds observed resident size, so adding overhead overestimates |
| `RuntimeCaps.tags_available` | Split out `tags_details_context_length` | V7: `details.context_length` removes an `/api/show` call for never-loaded models |
| `ollama_client.rs` `model_info` | Read `general.architecture`, build keys from it, accept scalar or array | Harvester's hardcoded `llama.*` keys are absent on `qwen3.5` |
| Remote-access rule | Larger than described — no `ConnectInfo`, no inbound token at all | V8: nothing exists to extend |
| Cold start state | `ColdUnknown` only | V9: no page-cache check without `unsafe` FFI |
