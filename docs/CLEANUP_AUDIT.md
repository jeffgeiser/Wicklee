# Cleanup Audit

Phase 1, step 0. Required by cleanup rule 1 in `docs/PHASE1_SPEC.md`: "Audit
before deleting. For each candidate it lists the callers, the routes the
frontend still uses, and the cloud consumers. Nothing is deleted on a guess."

**Nothing is deleted in this step.** This document is the inventory that later
steps act on. Every path below was produced by grep over `agent/src`,
`cloud/src`, `src` and `public` at commit `213e967`.

## Baseline

| Area | Lines | Spec's figure |
| --- | --- | --- |
| `agent/src` | 15,250 | 15,250 — exact |
| `cloud/src` | 13,382 | ~13,400 |
| `src` (frontend) | 40,131 | ~40,100 |
| — `src/components` | 17,955 | ~18,000 (embedded dashboard) |
| — `src/cloud` | 6,876 | 6,900 |
| — `src/site` | 5,616 | 5,600 |
| — `src/demo` | 750 | — |
| Release binary | 22.7 MB | — (measured from the installed **v0.11.1**, not 0.12.0) |

The binary number needs replacing with a `cargo build --release` of
`origin/main` at the start of step 1. Step 0 does not build product code, so the
only binary on this host is the deployed 0.11.1 one.

## Candidate 1 — Model discovery (`model_fit.rs`, catalog table, `/api/model-candidates`)

Spec decision, 2026-11-12: **remove everywhere**, including dashboard card,
fleet view, demo and docs page. Order of work: step 0.

**Not removed here** — the task for this step excludes deleting. The audit below
is what step 1 should act on.

### Agent

| Path | What |
| --- | --- |
| `agent/src/model_fit.rs` | Whole module, 422 lines |
| `agent/src/main.rs:56` | `mod model_fit;` |
| `agent/src/main.rs:79` | `use model_fit::*;` |
| `agent/src/main.rs:953` | `.route("/api/model-candidates", get(handle_model_candidates))` |
| `agent/src/main.rs:251` | `--status` box prints "model-candidates, sla, profile," in the store-failure hint |
| `agent/src/model_fit.rs:276` | `refresh_model_catalog` — **a 24 h background task**, so removal also removes a polling loop |
| `agent/src/store.rs:525` | `CREATE TABLE model_catalog` |
| `agent/src/store.rs:563` | `ALTER TABLE model_catalog ... likes` migration |
| `agent/src/store.rs:1778` | `write_catalog` |
| `agent/src/store.rs:1794` | `catalog_is_fresh` |
| `agent/src/store.rs:1809` | `query_catalog` |
| `agent/src/store.rs:2016` | test `write_catalog_batches_in_one_transaction` |
| `agent/src/http_api.rs:610` | comment referencing the `model_catalog.likes` migration incident |
| `agent/src/http_api.rs:624` | `/api/model-candidates` in the route-health list |
| `agent/src/mcp.rs:100,406` | MCP tool `get_model_fit` — see candidate 2 |

### Cloud — **not a clean removal**

The cloud has its own parallel catalog that does **not** depend on the agent's:

| Path | What |
| --- | --- |
| `cloud/src/catalog.rs:381,392` | `GET /api/fleet/model-candidates`, JWT-authenticated |
| `cloud/src/main.rs:1113` | route registration |
| `cloud/src/main.rs:1017–1028` | **startup task** that populates `model_catalog` and refreshes it |
| `cloud/src/maintenance.rs:134` | `refresh_cloud_model_catalog` in the nightly task |
| `cloud/src/migrations.rs:620–647` | Postgres `model_catalog` table, a schema guard that `DROP TABLE`s it, and the `likes` migration |
| `cloud/src/mcp.rs:102,251` | MCP tool `get_fleet_model_fit` |
| `cloud/src/mcp.rs:355` | a note pointing agents at "the agent's `get_model_fit` tool on each node" |

`cloud/` is **frozen** per the spec. So removing the agent side leaves
`cloud/src/mcp.rs:355` pointing at a tool that no longer exists, and
`get_fleet_model_fit` alive in the cloud. **Open question for the maintainer:**
the decision said "remove everywhere", but "everywhere" collides with the
freeze on `cloud/`. Either the freeze gets an exception for these six sites, or
the cloud keeps a feature the agent no longer has.

### Frontend

| Path | What |
| --- | --- |
| `src/components/insights/ModelDiscoveryCard.tsx:510` | fetches `/api/model-candidates` — the dashboard card |
| `src/cloud/insights/FleetModelDiscovery.tsx:532` | fetches `${CLOUD_URL}/api/fleet/model-candidates` — fleet view |
| `src/components/insights/tier2/ModelFitAnalysis.tsx:33` | references `get_model_fit` in a comment |
| `src/demo/demoApi.ts:301,356` | demo stub for `/api/fleet/model-candidates` |
| `src/demo/__tests__/demoApi.test.ts:18` | asserts the demo route — **a test that will fail on removal** |

### Docs and discovery files

`public/llms.txt:70,88` · `public/llms-full.txt:142` · `public/api.md:23` ·
`public/openapi.json:19` · `public/docs.md:399–406,814,931` ·
`src/site/DocsPage.tsx:1134,1139,1769,1218,2103,2228`

Per `CLAUDE.md`, all AI-discovery files must be updated together. That is nine
files plus `docs/progress.md` and `CLAUDE.md` itself.

### Verdict

Agent-side removal is self-contained (one module, one route, four store methods,
one table, one background task, one test). The cloud and frontend sides are
not — they need the frozen-cloud question answered first, and they break one
existing test. **Recommend: remove the agent side in step 1 as its own commit;
raise the cloud/frontend scope with the maintainer before touching it.**

## Candidate 2 — MCP tools `get_model_fit` and `get_observations`

Spec: replaced by `wicklee_readiness` and `wicklee_inspect`. Remove with the MCP
step (step 7).

The agent exposes six tools (`agent/src/mcp.rs`): `get_node_status`,
`get_inference_state`, `get_active_models`, `get_observations`,
`get_metrics_history`, `get_model_fit`, plus two resources. The spec's "six
tools" count is correct.

| Tool | Declaration | Dispatch | Other references |
| --- | --- | --- | --- |
| `get_observations` | `mcp.rs:82` | `mcp.rs:371` | `src/site/LandingPage.tsx:798`, `public/api.md:51`, `public/llms.txt:68`, `public/llms-full.txt:264`, `public/docs.md:812`, `public/openapi.json:19`, `src/site/DocsPage.tsx:2101` |
| `get_model_fit` | `mcp.rs:100` | `mcp.rs:406` | as candidate 1 |

No frontend code *calls* either tool — MCP is consumed by external agents. The
references are all documentation and marketing copy. `src/site/` is frozen but
`LandingPage.tsx:798` and `DocsPage.tsx:2101` advertise a tool that will not
exist; those two lines need editing despite the freeze, or the site lies.

**Note:** retiring `get_observations` while `GET /api/observations` stays (it
feeds `src/hooks/useLocalObservations.ts`) is fine — the spec retires the *tool*,
not the route.

## Candidate 3 — `query_model_switches` (switch detection)

Spec: replaced by the transition log. The route stays and reads the new table.
With the tracker step (step 2).

| Path | What |
| --- | --- |
| `agent/src/store.rs:1717` | `query_model_switches` — derives switches from the primary-model column of `metrics_raw` |
| `agent/src/http_api.rs:545–552` | `handle_model_switches`, the only caller |
| `agent/src/main.rs:952` | `.route("/api/model-switches", ...)` — **stays** |

**Frontend caller:** `src/components/ModelsPage.tsx:440` picks between
`/api/model-switches?hours=24` (local) and
`${CLOUD_URL}/api/v1/fleet/model-switches?hours=24` (fleet). The response shape
must stay compatible or `ModelsPage.tsx` breaks.

**Cloud consumer:** `cloud/src/fleet.rs:110–178` implements
`/api/v1/fleet/model-switches` independently, with a `LAG` window function over
Postgres `metrics_raw` (`cloud/src/migrations.rs:467` documents this). It does
**not** call the agent, so it is unaffected — but it will now disagree with the
agent, which reads true residency while the cloud still infers from a column.
That divergence is worth stating in the release notes.

**Verdict:** safe to re-point. The constraint is the JSON shape, set by
`ModelsPage.tsx`. Record the current response shape before changing the
implementation.

## Candidate 4 — Single-model expiry and probe-reset flags

Spec: replaced by per-model tracking. With the tracker step (step 2).

| Path | What |
| --- | --- |
| `agent/src/metrics.rs:98` | `probe_caused_next_reset: bool` — one flag for the whole host |
| `agent/src/metrics.rs:91` | `last_user_request_ts: Option<Instant>` |
| `agent/src/harvester.rs:301` | `prev_expires: Option<String>` — **first model only** |
| `agent/src/harvester.rs:478–486` | reads `ps_models.first()` for the expiry change |
| `agent/src/harvester.rs:207–215` | `attribute_expires_change` — the pure attribution function |
| `agent/src/harvester.rs:551–562` | consumes the flag, sets `last_user_request_ts` |
| `agent/src/harvester.rs:729` | probe sets the flag |

**Consumers — this is load-bearing for inference state:**

- `agent/src/inference.rs:62,134–137` — Tier 2 of `compute_inference_state`
  reads `last_user_request_ts` and classifies the node LIVE for 15 s.
- `agent/src/inference.rs:211,338,348` and `harvester.rs:1452` — unit tests.

**CLAUDE.md explicitly protects this**: "The `probe_caused_next_reset` one-shot
flag ... is what distinguishes probe-caused resets from user requests ... Do not
replace this with a time-based blackout (that was the Dead Zone bug)."

Documented publicly at `src/site/DocsPage.tsx:757,2557` and
`public/docs.md:222`, both naming the flag.

**Verdict:** the *mechanism* must survive, per-model. Widening
`Option<String>` → `HashMap<String, String>` and `bool` →
`HashMap<String, bool>` keeps the one-shot semantics. Do not change
`attribute_expires_change`'s logic; it already has four tests. Step 0 found an
independent reason this matters: `/api/ps` expiry is per-model and moves
independently (V5), so the current first-model-only read is simply wrong on a
multi-model host.

## Candidate 5 — Raw JSON parsing of `/api/ps` in the harvester

Spec: replaced by `ollama_client.rs` types. With the client step (step 1).

`agent/src/harvester.rs:420–520` indexes `serde_json::Value` directly:
`entry["name"]`, `entry["size"]`, `entry["details"]["quantization_level"]`,
`entry["size_vram"]`, `first["expires_at"]`. Also `harvester.rs:60–64`
(`ps_lists_model`) and `harvester.rs:70–79` (`ollama_model_resident`).

Step 0 found two concrete defects this rewrite must fix:

1. **`context_length` is returned but never read** (V2). It is present on every
   loaded model here; the harvester parses `size`, `size_vram`, `details` and
   `expires_at` and skips it. Confirmed live: the agent reports
   `ollama_context_length = 131072` (the `/api/show` maximum) while the model is
   actually running at `4096`. A 32x error in a field the dashboard displays.
2. **`model_info` keys are hardcoded to `llama.*`** (`harvester.rs:430–445`).
   They are absent for non-llama architectures. For `qwen3.5:4b`, every one of
   `ollama_context_length`, `ollama_num_layers`, `ollama_kv_heads`,
   `ollama_num_heads`, `ollama_embedding_dim` is `None`; the same fields
   populate correctly for `llama3.1:8b`. Two of three models installed on this
   host are affected. Details and the array-valued `head_count_kv` trap are in
   `docs/ollama-capabilities.md`.

**Verdict:** worth doing, and it fixes two live bugs rather than only tidying.
Also add the undocumented fields step 0 observed (`runner`, `capabilities`,
`details.context_length`) as optional.

## Candidate 6 — `routing_hint`

Spec: remove in step 4. "It issues instructions such as 'steer away' with no
evidence and no workload context, which the findings model replaces. The audit
must first list what reads it, including the cloud push and any outside
consumer."

| Path | What |
| --- | --- |
| `agent/src/observations.rs:40–45` | `Observation::routing_hint()` |
| `agent/src/observations.rs:47–58` | `routing_hint_for(pattern_id, severity)` — the mapping |
| `agent/src/observations.rs:1718` | injects `routing_hint` per observation |
| `agent/src/observations.rs:1723–1738` | node-level aggregate: `routing_hint` + `routing_hint_source` |
| `agent/src/cloud_push.rs:120–125` | **re-computes it** for the telemetry payload |

### Who reads it

- **Cloud push** — `cloud_push.rs:124` inserts it into the pushed observation
  JSON. No `cloud/src` file reads `routing_hint` back: grep finds zero hits in
  `cloud/src`. It is pushed and dropped.
- **Frontend** — zero hits in `src/components`, `src/cloud`, `src/hooks`,
  `src/types`. Nothing renders it.
- **Documented for outside consumers** — `public/api.md:12`,
  `public/docs.md:692`, `public/llms.txt:68`, `public/llms-full.txt:264`,
  `src/site/DocsPage.tsx:1738`. This is the real exposure: it is advertised to
  AI agents as part of `/api/observations` and the `get_observations` tool.

### Do not confuse with `action_id`

`reduce_batch_size` at `observations.rs:648,876,1096,1161` is a different
field — `action_id`, part of the suggested-action surface, typed at
`src/types/observations.ts:25` and rendered by
`src/components/insights/ObservationCard.tsx:59`. **It is not `routing_hint`
and must not be removed with it.**

**Verdict:** clean removal inside the agent — no code anywhere reads it back.
The cost is an advertised API field disappearing for any external agent that
adopted it. Treat as a breaking change to `/api/observations` and say so in the
release notes. This also supports the spec's controller-neutral principle:
`steer_away` is exactly the kind of instruction over infrastructure the spec
says Wicklee should not issue.

## Candidate 7 — Embedded dashboard

Spec decision: remove from the agent binary, serve a minimal debugging page.
After step 4.

| Path | What |
| --- | --- |
| `agent/src/http_api.rs:8–10` | `#[derive(RustEmbed)] #[folder = "frontend/dist"] pub(crate) struct StaticAssets;` |
| `agent/src/main.rs:23` | `use rust_embed::RustEmbed;` |
| `agent/src/main.rs:960` | `r.fallback(static_handler)` |

`agent/frontend/dist/` currently holds `index.html`, `assets/`, `blog/`,
`.well-known/`, and the discovery files (`llms.txt`, `llms-full.txt`,
`openapi.json`, `api.md`, `docs.md`, `metrics.md`, `robots.txt`), plus
`install.sh` / `install.ps1`.

**The discovery files are served from the same embed as the dashboard.** Removing
the dashboard must keep `/.well-known/`, `llms.txt`, `llms-full.txt`,
`openapi.json`, `api.md` and `robots.txt` reachable, or the AI-discovery surface
that `CLAUDE.md` requires maintaining goes offline. The minimal debugging page
is not a full replacement for this embed.

`src/components` (17,955 lines) stays in the repository for the hosted fleet
view, which is frozen. This removal is a *binary size* change, not a code
deletion.

## Candidate 8 — Dashboard-only agent routes

Spec decision: remove with the dashboard, once the audit confirms nothing else
calls them.

| Route | Handler | Frontend caller | Other consumer |
| --- | --- | --- | --- |
| `/api/cost-by-model` | `http_api.rs` → `store.rs:1406` | `src/components/Overview.tsx:1338` | none |
| `/api/sla` | `http_api.rs` → `store.rs:979` | `src/components/AIInsights.tsx:640` | none |
| `/api/profile` | `http_api.rs` → `store.rs:1353` | `src/components/AIInsights.tsx:499` | none |
| `/api/export` | `http_api.rs` → `store.rs:1850` | `src/components/TracesView.tsx:1088,1097` (CSV + JSON download links) | none |
| `/api/model-comparison` | `http_api.rs` → `store.rs:1634` | `src/utils/modelHistory.ts:44`, `src/components/ModelsPage.tsx:325` | none |
| `/api/explain-slowdown` | `http_api.rs:507` → `store.rs:1478` | **none** | `cloud/src/mcp.rs:223,248` — the cloud MCP tool `explain_slowdown` tells agents to "query the agent directly: `GET http://<node>:7700/api/explain-slowdown?ts_ms=N`" |

**Confirmed:** five of the six are called by exactly one or two frontend files
and nothing else. `/api/explain-slowdown` is the exception — it has **no**
frontend caller but the frozen cloud MCP tool points external agents at it.
Removing it silently breaks that instruction at `cloud/src/mcp.rs:248`.

Each removal also deletes its `store.rs` query method and should drop the route
from the health list at `http_api.rs:623–624` and the `--status` hint at
`main.rs:250–252`.

**Verdict:** the five dashboard routes are safe to remove with the dashboard.
`/api/explain-slowdown` needs a decision: keep it as an agent-facing route
(it has no UI cost) or remove it and edit the frozen cloud tool.

## Candidate 9 — Stale documents

Spec: remove in step 0. **Not removed** — this step does not delete.

| File | Lines | Spec says |
| --- | --- | --- |
| `docs/GTM.md` | 119 | Remove — strategy the v3.2 brief replaced |
| `docs/NEXT_STEPS.md` | 93 | Remove — same |
| `docs/CODE_REVIEW.md` | 77 | Remove — same |
| `docs/progress.md` | 2,718 | Remove — a journal; git history holds the same record |
| `docs/ROADMAP.md` | 481 | **Rewrite** to match v3.2 in the final step. Do not delete |

The first three total **289 lines**, matching the spec exactly.

Two files the spec's table does not mention, found in `docs/`:

- `docs/progress-archive.md`, 1,831 lines — the same kind of journal as
  `progress.md`. If `progress.md` goes for being a journal, this should too.
  **Not listed in the spec; needs a decision.**
- `docs/leaderboard-charter.md`, 168 lines — this is the "WES leaderboard
  charter" the spec lists as "keep if that idea continues". Filename differs
  from the spec's description.

Enterprise docs, which the spec says follow the cloud-code decision (frozen):
`SSO.md` 107 · `MODEL_GOVERNANCE.md` 108 · `TERRAFORM.md` 104 ·
`SELF_HOSTING.md` 157 · `BILLING.md` 161 = **637 lines**, matching the spec.

**Caveat on `progress.md`:** `CLAUDE.md` lists it under "AI/Agent Discovery
Files (keep in sync)" and requires updating it when endpoints or metrics change.
Deleting it contradicts a standing instruction in `CLAUDE.md`, so `CLAUDE.md`
must be edited in the same commit.

## Candidate 10 — Paid tiers (precondition, not a removal)

Spec decision: "paid tiers are withdrawn until there is a monetization plan ...
take down the pricing page and turn checkout off first. Confirm there are no
active subscriptions, and cancel and refund any that exist, before removing
anything they pay for."

Checkout is Paddle. Files involved: `src/site/PricingPage.tsx`,
`src/cloud/utils/loadPaddle.ts`, `src/types/paddle.d.ts`, `src/App.tsx`,
`src/hooks/usePermissions.ts`, `src/cloud/SignUpPage.tsx`,
`src/cloud/SignInPage.tsx`, `src/site/LegalPage.tsx`.

**This is a billing action against live customers and is not Claude Code's to
perform.** Nothing here touches it. Flagged only so the dependency is visible:
no cloud paid-tier code can be removed until the maintainer has confirmed the
subscription state in Paddle.

---

# Spec deviations

Every place where `docs/PHASE1_SPEC.md`'s assumptions do not hold on this host
or in this code. Capability findings are detailed in
`docs/ollama-capabilities.md`; this is the complete list, including the
non-capability ones.

## 1. The stdout banner breaks `--json`

`agent/src/main.rs:143–147`:

```rust
async fn main() {
    println!("wicklee-agent v{}", env!("CARGO_PKG_VERSION"));
```

This runs on **every** invocation, on **stdout**, before any argument is
examined. The comment says that is deliberate: "CLI tools, daemon startup, and
sudo install/uninstall all benefit from an immediate 'which build is this?'
confirmation."

The spec requires `wicklee inspect [--json]`, `wicklee ready [MODEL] [--json]`
and `wicklee findings`, and says "CLI, HTTP and MCP call the same functions and
return the same JSON." With the banner in place, `wicklee ready --json | jq .`
fails: the first line of stdout is `wicklee-agent v0.12.0`, not JSON.

It also already dirties `--status`, which prints its box to stdout after the
banner.

**Required change:** move the banner to `eprintln!`, or emit it only when no
subcommand and no `--json` was given. Either way this is a behaviour change to
existing output, which the spec's "existing agent behaviour stays the same
unless this spec changes it" constraint means must be called out. The spec does
not mention it. **It blocks step 3**, which is where the first `--json`
subcommand ships.

Related, smaller: flags are matched with `std::env::args().any(|a| a == "...")`
anywhere in the command line, and a positional argument is currently ignored in
silence. The spec's "a first argument that does not start with `--` is a
subcommand" needs real dispatch, and `wicklee inspect --status` would today hit
the `--status` branch regardless of the subcommand.

## 2. The proxy port is hardcoded and conflicts with Ollama

The spec treats the proxy as an available option — step 5 emits proxy receipts,
the `context_limit` rule needs "proxy on", and readiness's `in_use` signal lists
"a proxied request when the proxy is on" as one of two sources.

On this host the proxy **cannot run at all**:

- `agent/src/main.rs:343` binds `"127.0.0.1:11434"` as a string literal. Only
  the *upstream* port is configurable (`proxy_cfg.ollama_port`, default `11435`,
  `config.rs:25`). `main.rs:474` repeats the literal `11434u16`. An operator
  cannot move the proxy's own listener.
- Ollama already owns `127.0.0.1:11434`. Its live environment is
  `OLLAMA_NO_CLOUD=0` and `OLLAMA_MODELS=...` — no `OLLAMA_HOST`. It is started
  by the Ollama desktop app bundle (`/Applications/Ollama.app/.../ollama serve`),
  which offers no supported way to set `OLLAMA_HOST`. The documented workaround
  in `config.rs:11` — "requires the user to move Ollama to ollama_port
  (`OLLAMA_HOST=127.0.0.1:11435`)" — means abandoning the desktop app for a
  hand-managed `ollama serve`.
- Accordingly `config.toml` has no `[ollama_proxy]` section, so the proxy is
  off, and the live agent reports `ollama_proxy_active` unset.

The failure is graceful (`main.rs:386–390` logs and falls back), so this is not
a crash. It is that **the proxy-dependent half of Phase 1 is unreachable on a
default macOS Ollama install**, which is the most common configuration for the
audience the spec targets.

**Consequences for the spec:**

| Spec item | Effect |
| --- | --- |
| Step 5 proxy receipts | Not exercisable here. `ReceiptSource::Proxy` will have no samples; only `Fingerprint` receipts exist |
| Widening `TraceRow` with `load_duration_ns`, `prompt_eval_count`, `prompt_eval_cached_count` | Code is fine, but no traces are produced on this host |
| `context_limit` rule | Already dropped for V6; proxy unavailability is a second, independent reason |
| Readiness `in_use` | Falls back to `expires_at` resets only. V5 confirms those are reliable and per-model, so `in_use` still works — but it cannot distinguish a user request from the agent's own probe without the per-model attribution of candidate 4 |
| Acceptance test "Other hardware ... three outside machines" | If those machines run the Ollama desktop app, none will exercise the proxy path |

**Recommendation:** make the proxy listen port configurable (a two-line change)
and treat "proxy off" as the default assumption for every Phase 1 rule, rather
than an exception. Do not let any headline feature depend on it.

## 3. The deployed agent is not the version the spec describes

The spec says "The agent is at version 0.12.0". `Cargo.toml` agrees and
`origin/main` is 0.12.0. The binary **running on this host** is **v0.11.1**
(`/Users/roamwild/.wicklee/bin/wicklee --version`, and `/api/health` reports
`"agent_version":"0.11.1"`).

The difference is not cosmetic. The 0.11.1 probe has a fallback that loads a
model when none is loaded:

```
[ollama] probe fallback — no model in /api/ps, discovered: llama3.1:8b
```

Commit `0b10a92` ("perf(agent): stop idle probes from loading models") removed
it; `grep -rn 'probe fallback' agent/src/` finds nothing on `origin/main`.

So the spec's statement that "the code already skips unloaded models and sends
no `keep_alive` value" is **true of `origin/main` and false of the deployed
binary**. Any step-0-era measurement taken against the live agent describes
0.11.1 behaviour. It is also why the probe could not be quieted by unloading
models — the fallback reloads one within an interval.

**Recommendation:** update the host to 0.12.0 before step 1
(`curl -fsSL https://wicklee.dev/install.sh | bash`, per `CLAUDE.md`), and take
the overhead baseline the spec asks for in step 9 against 0.12.0, not 0.11.1.

## 4. The existing probe reloads any non-default context (V3)

`probe_ollama_tps` (`harvester.rs:95–112`) sends
`options: { num_predict: 20 }` and no `num_ctx`. V3 shows that a request
omitting `num_ctx` **reloads the model at the server default** — measured twice,
65536 → 4096 and 8192 → 4096, each with a multi-second `load_duration` on an
already-resident model.

The spec frames this as a constraint on new test requests ("the request passes
the model's running `context_length` as `num_ctx` so the test does not change
the loaded configuration (see V3)"). V3's answer makes it more than that: the
**existing** probe is already doing this, every probe interval, on any host
where a model runs at a non-default context. The probe's doc comment claims it
only "resets the expiry to the server default"; it also silently resets the
context.

**Not in the spec's gap list. Belongs there, and in the release notes.**

## 5. The remote-access rule has nothing to build on (V8)

The spec presents a four-row table (loopback/token/refuse-to-start/override) as
a startup rule, and says the `/v1` POST routes "check the peer address
themselves".

Neither half exists in any form:

- `grep -rnE 'ConnectInfo|into_make_service_with_connect_info|SocketAddr|peer_addr' agent/src/*.rs`
  returns **nothing**. `main.rs:1058` is `axum::serve(listener, app)`, so no
  handler can obtain a peer address.
- There is no inbound authentication anywhere. `config.rs` has `session_token`,
  but that is the *outbound* cloud credential. No bearer-token check, no
  constant-time comparison, no `allow_unauthenticated` key.
- Today, with `bind_address = "0.0.0.0"`, the existing POST routes
  (`/api/pair/generate`, `/api/pair/claim`, `/api/pair/disconnect`, `/mcp`,
  `/api/insights/dismiss`) are reachable from any host on the network with no
  authentication. CORS (`main.rs:895–903`) does not help: it only blocks
  cross-origin browser JS, not `curl`.

The spec is right that this is a behaviour change. It is a larger piece of work
than "the routes check the peer address", and it is a **pre-existing security
gap**, not just a Phase 1 requirement. It gates step 3.

## 6. `cpu_split` describes the runtime footprint, not the model (V1)

V1 confirms `size - size_vram` is exact on Apple Silicon — the residue matched
the runner's CPU-side buffers to 0.03 MiB. But those buffers are mostly **KV
cache**: 8704 of 11352 MiB in the measured case. `size` also grows with context
(3.15 → 4.32 GB for the same model from ctx 4096 → 32768).

The spec's observed statement is "coder:14b has had 38% of its memory outside
the GPU". That reads as weights. It should read "of its runtime footprint", and
the inferred statement's context-change explanation is usually the *whole*
story, not one candidate cause.

## 7. `Displacement::Confirmed` is not reachable, and evictions are not single-victim (V4)

Two separate problems with the displacement model:

- **`Confirmed` requires** "the same model unloaded every time, at least twice,
  with the same set of loaded models". On this host the same sequence with the
  same resident set gave **different outcomes minutes apart** (co-residency
  once, single-residency on three later trials, tracking free memory). The level
  can stay in the type, but nothing should be designed assuming it will ever be
  earned on a 16 GB machine.
- **Evictions removed every resident model**, not a minimal victim set —
  reproduced twice, including a trial that deliberately made the smaller model
  most-recently-used. So `would_displace` naming one model is right only when
  exactly one is loaded (`Likely`). On a multi-model host the honest answer is
  `UnknownVictim` with a statement that the whole resident set is at risk, which
  the current `Vec<Victim>` shape allows but the spec's prose does not describe.

Also: `RequiresLoading` is "footprint plus a safety margin fits in free memory".
Fitting once did not predict fitting again here. The margin must be generous and
`valid_for_s` is doing real work.

## 8. `eviction_churn`'s inferred cause may be wrong

The rule's inferred statement is "memory contention may be causing the
reloads". On this host that is correct. But a host with a low
`OLLAMA_MAX_LOADED_MODELS` produces **identical transitions** from a
concurrency ceiling instead, and V4 confirms that variable is exposed nowhere in
the HTTP API — Wicklee cannot read it to tell the two apart.

The "may" keeps the statement defensible, but it should not name memory
specifically unless low free memory was observed at the time. Otherwise the rule
asserts a cause it cannot distinguish.

## 9. `context_limit` should be dropped, not shipped off by default (V6)

The spec makes the rule conditional on V6 finding a reliable signal and says it
is "off by default". V6 found no signal, and found the proposed trigger is
actively wrong: `prompt_eval_count = 1026` against `num_ctx = 512`, so the count
is **not clamped to the context** and would not fire on a truncated prompt. The
runner uses `--context-shift`, which discards early tokens silently by design.

An off-by-default rule still costs a `RuntimeCaps` flag, a config key, rule code
and test surface for a signal that does not exist. **Drop it from Phase 1
entirely** rather than shipping it disabled.

## 10. Footprint source 2 will overestimate (V7)

The spec's footprint fallback is "the installed file size with the overhead
estimate from `scoring.rs`". But the installed file size is **larger** than the
observed resident size: `qwen3.5:4b` is 3.39 GB installed and 3.15 GB resident
at ctx 4096. Adding overhead to a number already above the target overestimates
and will push models into `MayRequireEviction` that would have loaded fine.

Also, `/api/tags` already returns `details.context_length`, so the maximum
context of a never-loaded model needs no `/api/show` call. Worth a separate
`RuntimeCaps` field.

## 11. `model_info` architecture namespace (candidate 5)

Covered above and in `docs/ollama-capabilities.md`. Summarised here because it
is a spec-relevant typing requirement: `ollama_client.rs` must read
`general.architecture` and build `model_info` keys from it, and must accept both
scalar and array values for `<arch>.attention.head_count_kv`. The spec's
instruction to treat "the keys of `model_info`" as optional is right but not
sufficient — the *key names themselves* vary by model.

## 12. Latent risk: the llama.cpp spec matches Ollama's own runner

Not a spec claim, found while auditing. `RUNTIME_SPECS`
(`process_discovery.rs:157–163`) declares the `llamacpp` runtime as
`exact_binary: ["llama-server"]`. Ollama spawns exactly that binary as its
runner: `/Applications/Ollama.app/Contents/Resources/llama-server --model ... --port 49617`.

So one Ollama install can match two runtime specs. The log shows an attempt
(`[llamacpp] connected on :8080`), but the live agent currently reports
`llamacpp_running = false` — the harvester's `/health?include_slots` check on
the resolved port fails, so no phantom runtime is reported. **This is a latent
risk, not an active bug**, and the spec freezes llama.cpp harvesting for Phase
5. Recording it so Phase 5 does not rediscover it.

## 13. One thing the spec gets exactly right, for the record

Every documented field Phase 1 depends on **is** present on this install:
`ps_size_vram`, `ps_context_length`, `ps_expires_at`, `ps_digest`,
`gen_load_duration`, `gen_prompt_eval_count`, `gen_prompt_eval_cached_count`,
`tags_available` — all true. The spec's caution about capability gating is well
placed, but on this host no rule switches off for a missing field. The problems
found are fields that mean something other than a rule would assume, which
capability flags do not protect against. The evidence-label discipline does.

Line counts in the spec's module table and cleanup plan match the repository
exactly (15,250 agent lines; 289 lines of stale strategy docs; 637 lines of
enterprise docs).

---

## Summary of what step 0 changes

| Action | Items |
| --- | --- |
| **Drop from Phase 1** | `context_limit` rule (deviations 9) |
| **Fix before step 3** | stdout banner (1), remote-access foundation (5) |
| **Fix in step 1** | probe `num_ctx` (4), `model_info` architecture keys (11), running `context_length` (candidate 5) |
| **Reword** | `cpu_split` statements (6), `eviction_churn` inferred cause (8) |
| **Tighten** | displacement model (7), footprint source 2 (10) |
| **Make configurable** | proxy listen port (2) |
| **Needs a maintainer decision** | cloud-side model discovery vs the `cloud/` freeze (candidate 1); `/api/explain-slowdown` vs the frozen cloud MCP tool (candidate 8); `docs/progress-archive.md` (candidate 9); updating the host to 0.12.0 (3) |
| **Blocked, not Claude Code's to do** | paid-tier takedown (candidate 10) |
