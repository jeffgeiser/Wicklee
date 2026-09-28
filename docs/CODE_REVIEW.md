# Code Review — September 28, 2026

Full-repo review (frontend, cloud, agent). Baseline: `tsc`, `vitest` (96/96), `vite build`, and
`cargo clippy` on cloud and agent are all clean; ESLint has 0 errors and 74 warnings. Line numbers are as of
commit `9b70cb5`. Effort: S = under an hour, M = half a day to a day, L = several days.

## Priority 1 — Security (fix before Paddle goes live)

**Status:** S1–S4 and B1 fixed in PR #61. S5–S9 fixed in the follow-up PR (S9 takes effect from the first release published with `SHA256SUMS`).

| # | Where | Issue | Fix | Effort |
|---|---|---|---|---|
| S1 | cloud `resolve_clerk_user` (~1273) | If exactly one user has `clerk_id IS NULL`, the next **new** Clerk sign-in is linked to that account. The public legacy `POST /api/auth/signup` creates such users, so someone can register with a password and capture the next stranger's Clerk account. | Remove the auto-link, or restrict it to a one-time migration by verified email. Retire the legacy signup and login routes. | S |
| S2 | cloud Paddle webhook (~10150) | (a) `ts` is never checked, so a signed event can be replayed forever. (b) The HMAC runs over a `from_utf8_lossy` copy instead of the raw bytes. (c) Only the first `h1=` is checked, which breaks secret rotation. (It already failed closed when the secret was unset; the first report said otherwise, which was wrong.) | Reject events where \|now−ts\| > 5 min. HMAC the raw body. Accept any matching `h1`. | S |
| S3 | cloud `client_ip` (~2004) | Trusts the first `X-Forwarded-For` entry, which the client controls. That makes the auth rate limiter (the only brake on guessing 6-digit pairing codes) bypassable. | Use the proxy-appended last hop. Add a per-user limit on activate. | S |
| S4 | cloud activate (~5125) | The node-limit `COUNT` runs before the claim `UPDATE`, which is racy. `nodes.code` is not unique, so one activate can claim several nodes. | Add a unique partial index on `nodes(code) WHERE code IS NOT NULL`. Do the count and the claim in one transaction. | S |
| S5 | cloud webhook, drain, OTel and alert URLs (~1746, 4642) | Only the `http(s)://` prefix is validated, which allows SSRF. The `/test` endpoints echo upstream status, so they work as an internal port scanner. | Resolve the host. Block loopback, private, link-local and metadata ranges. | M |
| S6 | cloud `tenant_scope` (~1402) | Solo scope is `user_id = $1` without `org_id IS NULL`, so org nodes stay visible after the user is removed from the org. | Add `AND org_id IS NULL`. | S |
| S7 | cloud boot migration (~1050) | Every boot assigns every unowned node to the sole user. | Delete it, or gate it behind a flag. | S |
| S8 | cloud tokens | SSE is checked only at connect. Legacy sessions never expire. The node token is compared with `!=` and stored in plaintext. Signing up with `DEV_ACCOUNT_EMAIL` grants Pro without email verification. `RESET_NODES` wipes nodes on every boot while it is set. | Fix each one. | S–M |
| S9 | agent auto-update (~6952) | Downloads and replaces the binary with no checksum or signature check, and without requiring https. | Publish a sha256 or minisign signature and verify it before `self_replace`. | M |

## Priority 2 — Correctness bugs

**Status:** B1 fixed in PR #61; B2–B10 fixed in the follow-up bug-fix PR.

| # | Where | Issue | Effort |
|---|---|---|---|
| B1 | cloud Paddle state machine (~10183) | `subscription.paused` is unhandled. `updated` with status past_due, paused or canceled keeps the paid tier. There is no protection against out-of-order events. past_due downgrades before dunning finishes. Only `items[0]` is read. There is no `paddle_customer_id` fallback. | M |
| B2 | frontend `Overview.tsx:1476` | The local WebSocket reconnects after unmount. `onclose` schedules a retry after cleanup has run, so every tab switch leaks another socket. | S |
| B3 | frontend `FleetStreamContext.tsx:414`, `App.tsx:285` | Switching orgs or signing out leaves the previous org's nodes, metrics and events on screen. | S |
| B4 | agent proxy (`main.rs:7252`, `proxy.rs:246`, `:62`) | A 300 s total timeout kills long generations. Passthrough bodies over 16 MB are sent as **empty** (blob uploads). The 1 MB cap on generate and chat rejects multimodal prompts. | S–M |
| B5 | agent `cloud_push.rs:150` | After a 410, telemetry push stops permanently until restart, even if the user re-pairs. | S |
| B6 | agent `supervisor.rs` vs `panic = "abort"` | Panic recovery can't work in release builds. | S |
| B7 | agent runtime-config pollers (~7419) | They rescan processes themselves and ignore `[runtime_ports]` overrides. | S |
| B8 | agent remediation text (~4012) | Suggests `curl /api/metrics \| jq .wes_score`, but that endpoint is SSE and has no such field. | S |
| B9 | frontend: 7 hardcoded `http://localhost:7700` URLs; ModelsPage fleet calls ignore `CLOUD_URL` | Breaks on 127.0.0.1, a LAN IP or a custom port. | S |
| B10 | agent: two quant tables disagree (`main.rs:5095` vs `scoring.rs`) | Model-fit results differ depending on which path runs. | S |

## Priority 3 — Performance

**Agent (overhead on the customer's host, which matters most for the product claim)**
- **Idle probes send a real 20-token generation every 30 s.** If no model is loaded, the probe loads one, and each probe resets Ollama's keep_alive timer, so the GPU never idles down. Probe only when the baseline is stale, never load a model to probe, and add a `probe = false` option. (M)
- The Apple harvester runs on Linux and Windows and spawns failing subprocesses every 2 s. On macOS it spawns 4–5 subprocesses every 2 s. Blocking `wmic` runs in async code. Gate it with `cfg`, stream `powermetrics -i`, and use `host_statistics64`. (M)
- `/api/metrics` builds a separate sampler for each client plus `System::new_all()`, and duplicates about 150 lines of the broadcaster (the copies have drifted). Subscribe to `broadcast_tx` instead. (S)
- Replace `System::new_all()` with `new()` + `refresh_memory()` in 5 places. Move the process scan to `spawn_blocking` with specific refreshes. (S)
- DuckDB writes block tokio workers. Use a single writer thread, `prepare_cached`, and batched Appender writes. Wrap `write_catalog` in a transaction. `CHECKPOINT` after the prune. Aggregation runs twice at startup. (M)
- A new reqwest `Client` is built every tick in the harvesters. (S)

**Cloud**
- Each SSE connection walks the global metrics map every 2 s, and `block_in_place` ties up a worker thread. Use per-connection lookups and one refresh query. (M)
- Ingest runs 6+N queries per push, including N+1 on `alert_events`, a full JSONB write each time, and no backpressure. (M)
- These maps never evict: rate-limit maps, the `metrics` map, and unowned claimed nodes. (S)
- Missing indexes: `nodes(code)`, `users(paddle_customer_id)`, `organizations(created_by)`. (S)
- A new `reqwest::Client` is built per webhook. `ureq` has no read timeout. Every JWT request runs a failed `sessions` lookup and an `eprintln!`. (S)

**Frontend**
- The whole dashboard re-renders on every SSE frame because `handleNodesSnapshot` always returns a new array. (S)
- `paddle.js` loads on every page. Inject it only when checkout opens. (S)
- `/api/metrics` SSE is opened separately in 4 components. Share one local stream hook, which also fixes B2. ModelsPage polls `/api/fleet` every 3 s alongside the fleet SSE. The Traces spinner flickers on every poll. (M)

## Priority 4 — Dead code and cleanup

- **Frontend:** unreachable tabs (Scaffolding, AIProviders, Team, Profile, Security, Preferences, Pricing views plus their App cases, about 980 LOC). About 40 unused locals and components flagged by lint. Unused props (Overview `isPro`/`getToken`/`onUpgrade`, etc.). Unused exports `getCachedPerplexityBaseline` and `qualityMultiplier`. Duplicated helpers: 5× `CopyButton`, 4× `fmtAgo` (inconsistent output), the discovery-card helpers, `RANGE_CONFIG`, `TIER_STYLE`, 5× `IS_DEMO`/`IS_AGENT` despite `buildTarget.ts`.
- **Cloud:** the unused deps `tower-http` and `futures-util`. The `ureq` + `reqwest` overlap (standardize on reqwest). `once_cell` → `LazyLock`. Retired Pro and Business price IDs still wired (keep them for grandfathered subscribers but document an end date). "requires Pro tier" 403s where other gates return 402. Dead `stripe_*` columns, `ObsSeverity`, `ppl_delta_pct`, and `is_pro`. Obsolete DuckDB and cmake lines in `cloud/Dockerfile`.
- **Agent:** replace `self_update` with `self-replace` (drops indicatif, quick-xml, regex, semver and tempfile). Trim tokio `full`. Fix the "10 Hz" comment (the actual rate is 1 Hz). `cargo clippy` in agent/ fails without `frontend/dist`; add a stub dir or a build.rs guard so Rust CI can run on its own.
- **Structure:** split cloud `main.rs` (11.6k lines) into modules (auth, billing, ingest, sse, alerts, webhooks, migrations, v1_api, mcp). Add an `AuthCtx` extractor (repeated in about 60 handlers) and a single `require_tier` helper that returns a consistent 402. Do the same for agent `main.rs` (8k lines).

## Feature ideas surfaced by the review
- A Prometheus exporter **on the agent** (`/metrics` from the latest broadcast frame), so free and self-hosted users can use Grafana without the Team-tier cloud endpoint.
- A one-shot `GET /api/metrics/snapshot` JSON endpoint on the agent (fixes B8 and makes scripting easy).
- Stream proxy bodies instead of buffering them (fixes B4, enables multimodal prompts and blob uploads).
- A dunning-aware Paddle lifecycle (grace period on past_due, a paused state) as part of B1.
