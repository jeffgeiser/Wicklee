# Wicklee Security Audit — March 12, 2026

Full codebase audit conducted pre-Show HN. Four categories: dead code, performance, correctness, and security. Tools run: `cargo audit` (cloud + agent), `npm audit`.

**Audit results:**
- `npm audit`: 0 vulnerabilities
- `cargo audit` (cloud): 0 vulnerabilities
- `cargo audit` (agent): 1 CVE (quinn-proto 0.11.13, RUSTSEC-2026-0037, CVSS 8.7), 2 unmaintained warnings

---

## Severity Legend

| Level | Meaning |
|---|---|
| **CRITICAL** | Exploitable without auth; immediate production risk |
| **HIGH** | Exploitable with moderate effort; fix before public launch |
| **MEDIUM** | Real risk; fix within one sprint |
| **LOW** | Correctness / hygiene; fix opportunistically |

---

## Critical Findings

### C1 — `/api/telemetry` Unauthenticated ✅ HARDENED
**File:** `cloud/src/main.rs` — `handle_telemetry`, `handle_claim`

**Risk:** Any caller can POST metrics under any `node_id`, poisoning the in-memory metrics cache and the fleet display for all users. An attacker could impersonate a paired node, inject false thermal/throughput data, or displace real metrics.

**Fix v1 (prior session):** Existence check — unregistered `node_id` → 403 Forbidden.

**Fix v2 (this session — hardened):**
- `handle_claim` now generates a cryptographically random `telemetry_secret` (`Uuid::new_v4()`, 122 bits of OS CSPRNG entropy) and stores it in SQLite (`nodes.telemetry_secret TEXT`). Returned to the agent **once** in the claim response; never logged.
- `handle_telemetry` extracts `X-Wicklee-Token` from the request header and performs a **constant-time comparison** against the stored secret via `subtle::ConstantTimeEq` (crate v2.6 — prevents timing-side-channel byte probing).
- All failure paths (node unknown, token absent, token wrong) return **401 Unauthorized** with no body. The identical response prevents node-ID enumeration.
- `MetricsEntry` embeds the secret in the in-memory map so the hot path is a read-lock with no SQLite hit.
- **Backward compat:** nodes paired before this migration have `telemetry_secret = NULL`; they continue to be accepted without a token until they re-pair. On re-pair the old secret is replaced.
- **Agent update required:** the agent must read `telemetry_secret` from the `ClaimResponse` and send it as `X-Wicklee-Token` on every POST /api/telemetry.

---

### C2 — CORS Wildcard `*` ✅ HARDENED
**File:** `cloud/src/main.rs` — `cors()` middleware

**Risk:** `Access-Control-Allow-Origin: *` on every response, including authenticated endpoints. Any website can make credentialed cross-origin requests to the cloud backend from a logged-in user's browser, enabling CSRF-style attacks against `/api/fleet`, `/api/pair/activate`, etc.

**Fix v1 (prior session):** Replaced `*` with per-request exact-match against `ALLOWED_ORIGINS`; unknown origins receive no CORS header.

**Fix v2 (this session — hardened):**
- Confirmed matching uses `&[&str]::contains` which is **byte-level exact equality** — no prefix/suffix/contains risks.
- Added `Access-Control-Allow-Credentials: true` **only when the origin is in the allowlist**. Previously this header was absent entirely (safe but incomplete — browsers require it to forward cookies/Authorization with CORS requests). It is now explicitly omitted for unknown origins (sending `false` is unnecessary and exposes header presence).
- Agents (no `Origin` header) are a complete no-op — middleware returns without adding any CORS headers.
- Implementation is hand-rolled `tower::Layer` (no third-party CORS crate) so all invariants are visible in one function.

---

### C3 — Binary Path Injection in Service Installer ✅ FIXED
**File:** `agent/src/main.rs` — `--install-service` handler (macOS plist / Linux systemd unit)

**Risk:** The binary path written into the plist/systemd unit is derived from `std::env::current_exe()` without sanitization. A binary installed at a path containing shell metacharacters (`;`, `&`, `$(...)`, etc.) could enable command injection when the service manager reloads the unit file.

**Fix:**
- `validate_binary_path(path: &str) -> Result<(), String>` added directly above `install_service()`.
- **POSIX allowlist:** `[a-zA-Z0-9/_.-]` only — covers all normal Unix install paths; rejects spaces, shell metacharacters, XML-significant chars, and null bytes.
- **Windows allowlist:** drive letter + `:` + `[a-zA-Z0-9\\/._- ]` — spaces permitted (common in `Program Files` paths); colon only in the drive-letter position.
- `..` path traversal components rejected on all platforms regardless of where they appear.
- `install_service()` calls `validate_binary_path()` immediately after resolving the exe path. On failure: prints a clear error explaining the issue and the fix (move binary to a clean path), then returns without writing any file. Nothing is touched until the path is proven safe.
- Platform-conditional via `#[cfg]` so the correct character set is enforced per OS at compile time.

---

### C4 — Pairing Code Brute-Forceable ✅ HARDENED
**File:** `cloud/src/main.rs` — `handle_activate`, `client_ip`

**Risk:** 6-digit numeric code = 10^6 possibilities. No rate limiting on `/api/pair/activate`. A script can enumerate all codes in ~17 minutes at 1,000 req/s, taking ownership of any unpaired node.

**Fix v1 (prior session):** Per-IP sliding-window rate limiter (10 / 60 s → 429). `X-Forwarded-For` leftmost value used for IP — **this was exploitable** (client-controlled).

**Fix v2 (this session — hardened):**
- `client_ip()` now takes the **rightmost** comma-separated value from `X-Forwarded-For` — the entry appended by Railway's proxy (trustworthy). The leftmost values are client-supplied and must never be used for rate-limiting. Inline comment documents the invariant.
- Added `ConnectInfo<SocketAddr>` extractor to `handle_activate` as a fallback when `X-Forwarded-For` is absent (local dev / direct TLS). `axum::serve` updated to `into_make_service_with_connect_info::<SocketAddr>()`.
- **axum-client-ip evaluated and declined:** `SecureClientIpSource::RightmostXForwardedFor` would express the same intent but adds a dependency for a one-line parsing rule. Hand-rolled `split(',').last()` is simpler and equally auditable for a single-hop topology.
- Sliding-window cleanup (`retain`) runs on every request — no background timer needed.
- Rate-limit response now includes `Retry-After: 60` header so well-behaved clients (and the AddNodeModal) know exactly how long to wait.

---

## High Findings

### H1 — quinn-proto CVE (RUSTSEC-2026-0037) ✅ FIXED
**File:** `agent/Cargo.lock`

**Severity:** CVSS 8.7 (High)

**Risk:** quinn-proto 0.11.13 has a memory safety vulnerability in QUIC stream handling. The agent binary links this transitively via `reqwest`'s rustls-tls feature chain.

**Fix shipped:** `cargo update -p quinn-proto` in `agent/` → upgraded 0.11.13 → **0.11.14**.

---

### H2 — No Connection Limits on SSE/WebSocket ✅ FIXED
**File:** `cloud/src/main.rs` — `handle_fleet_stream`

**Risk:** No per-IP or total connection cap on SSE or WebSocket endpoints. A single IP can open thousands of connections, exhausting Tokio task memory and Railway's connection limit, causing denial-of-service for all users.

**Fix:**
- `SseConnStream<S>` — RAII wrapper struct that implements `Stream` (delegating `poll_next`) and `Drop` (decrementing both counters). Fires on clean stream completion **and** abrupt client disconnect via Axum task cancellation.
- `MAX_SSE_TOTAL = 1_000` — global atomic cap (`Arc<AtomicUsize>` in `AppState`). Uses `Relaxed` ordering; accuracy over time is sufficient, strict sequencing not required.
- `MAX_SSE_PER_IP = 10` — per-source-IP cap (`Arc<Mutex<HashMap<String, usize>>>` in `AppState`). Map entries evicted when count reaches zero to prevent unbounded growth. IP extracted via the existing `client_ip()` helper (rightmost XFF / ConnectInfo fallback — same as C4).
- On per-IP limit: **429 Too Many Requests** with descriptive message.
- On global limit: **503 Service Unavailable**.
- Per-IP incremented first; rolled back atomically if the global cap rejects the connection — no counter leakage.
- `handle_fleet_stream` now accepts `ConnectInfo<SocketAddr>` and `HeaderMap` for IP extraction (consistent with `handle_activate`).

---

### H3 — `fleet_url` Unvalidated (SSRF) ✅ FIXED
**File:** `cloud/src/main.rs` — `handle_claim`

**Risk:** The agent supplies `fleet_url` during the pair/claim call and it is stored verbatim. If the cloud backend ever follows this URL (e.g., for health checks or webhook callbacks), an attacker can supply `http://169.254.169.254/latest/meta-data/` (AWS IMDS) or internal Railway service addresses — classic SSRF.

**Fix:**
- `validate_fleet_url(url: &str) -> Result<(), &'static str>` added in `cloud/src/main.rs`.
- Scheme check: must be `http://` or `https://` — rejects `file://`, `ftp://`, `javascript:`, `data:`, and all other vectors at the parse stage.
- SSRF-dangerous IP ranges blocked: `169.254.x.x` (link-local / AWS IMDS / Railway metadata), `100.64.x.x` (IANA shared address space / CGN), `0.x.x.x` (reserved), `240–255.x.x.x` (reserved/experimental/broadcast).
- RFC-1918 private ranges (`10.x`, `172.16–31.x`, `192.168.x`) intentionally **not** blocked — agents legitimately run on LAN hosts and the URL is only opened in the operator's own browser.
- Max length 2048 bytes; null bytes and ASCII control characters rejected.
- `handle_claim` calls `validate_fleet_url()` before any DB write; invalid URLs → **400 Bad Request** with the specific rejection reason.
- `parse_ipv4_host()` helper does textual dotted-decimal parsing — no std dependency on `std::net::Ipv4Addr` to keep the code self-contained.

---

### H4 — Direct DOM Mutation in LandingPage.tsx ✅ FIXED
**File:** `src/components/LandingPage.tsx`

**Risk:** Copy buttons used `document.getElementById` + `btn.innerHTML = '<span>…SVG…</span>'` to show a "Copied!" confirmation. Although the injected HTML was hardcoded (not user-supplied), the pattern bypassed React's virtual DOM, created an XSS surface if the content ever became dynamic, and violated React's reconciliation model (direct mutation causes stale vdom state on the next render cycle).

**Fix:**
- Added `{ useState }` to the React import.
- Added `{ Check }` to the lucide-react import.
- Two `useState` hooks: `[copiedMac, setCopiedMac]` and `[copiedWin, setCopiedWin]` at the top of the `LandingPage` component.
- Click handlers: `setCopied*(true)` + `setTimeout(() => setCopied*(false), 2000)` — idiomatic React state pattern.
- Button content rendered from state: `{copied ? <><Check .../> Copied!</> : <><Copy .../> Copy</>}` — no DOM mutation, no XSS surface, correct reconciliation.
- `id="copy-install-btn"` and `id="copy-install-win-btn"` removed (no longer needed).

---

### H5 — Silent `catch {}` on Pairing API Calls ✅ FIXED
**File:** `src/components/AddNodeModal.tsx` — `handleSubmit`

**Risk:** Network errors and unexpected HTTP status codes were swallowed by bare `catch {}` blocks, surfacing "Unable to reach the cloud backend" for all error types including auth failures, 429 rate limiting, and 402 payment required. Users received no actionable error message; security-relevant failures (e.g., rate limit hit) were invisible. Additionally, `res.json()` was called before `!res.ok` — a non-JSON error body (nginx 502 HTML, Railway 503 page) would throw directly to the generic catch, bypassing the HTTP-status-aware path entirely.

**Fix:**
- `res.ok` is checked first. JSON parsing on the error path is wrapped in its own `try/catch` — non-JSON bodies (nginx error pages, Railway health pages) no longer throw to the outer catch.
- Status-specific, actionable error messages:
  - `429` → `"Too many attempts — try again in Xs."` (`Retry-After` header value read and surfaced to the user)
  - `401` → `"Session expired. Sign out and sign back in to continue."`
  - `402` → `"Node limit reached. Upgrade to Team Edition to pair unlimited nodes."`
  - `5xx` → `"Wicklee is temporarily unavailable. Please try again shortly."`
  - Other non-200 → server-supplied `data.error` message, or a safe fallback
- `catch (err)` now distinguishes error type: `TypeError` = network failure (fetch couldn't connect); anything else = Clerk session / runtime error. Two different messages, both actionable.
- JSON parse on the success path eliminated — the response body is unused on 200, so the parse was gratuitous.

---

## Low / Informational Findings

| ID | Location | Issue | Status |
|---|---|---|---|
| L1 | `cloud/src/main.rs` | `/api/auth/signup` and `/api/auth/login` are dead routes — Clerk handles auth. No rate limits on them, but they reject all calls. | Dead code; remove in cleanup sprint |
| L2 | `cloud/src/main.rs` | `stream_tokens` table cleanup runs every 5 min; no index on `expires_ms`. At scale (>10k tokens) this becomes a full table scan. | Add `CREATE INDEX idx_stream_tokens_expires ON stream_tokens(expires_ms)` |
| L3 | `cloud/src/main.rs` | `handle_fleet_stream` logs nothing on auth failure. Silent 401s make abuse detection impossible. | Add structured log line on auth failure |
| L4 | `agent/src/main.rs` | `--install-service` writes the launchd plist with `NSAllowsArbitraryLoads = false` but doesn't set `NSAppTransportSecurity` explicitly. Benign on macOS 11+ but worth documenting. | Documentation only |
| L5 | `src/utils/wes.ts` | `THERMAL_PENALTY` for `serious` and `critical` are both `2.0`. Planned WES v2 changes `serious` to `1.75`. This is a known tracked inconsistency. | Fix in WES v2 sprint |
| L6 | `src/components/Overview.tsx` | `console.log('[tok/W audit]...')` left in production code. | Remove before Show HN |
| L7 | `agent/Cargo.toml` | `self_update` 0.41 is listed as `default-features = false` but `quinn` is still in the lock file. Confirm whether QUIC is actually needed or if a lighter update crate would eliminate the dependency entirely. | Investigate in binary-size sprint |
| L8 | `cloud/src/main.rs` | JWT validation uses `Validation::new(Algorithm::RS256)` without setting `validate_exp = true` explicitly. Confirm the default includes expiry validation. | Audit jsonwebtoken defaults |
| L9 | `src/components/NodesList.tsx` | `allLive.filter(m => m.cpu_power_w != null)` used to detect Apple Silicon. Heuristic is fragile — `cpu_power_w` can be null on Linux too. | Use `chip_name` + `gpu_name` heuristic (already done in `NodeHardwarePanel`) |

---

## Dependency Audit Summary

| Ecosystem | Tool | Result |
|---|---|---|
| npm (frontend) | `npm audit` | **0 vulnerabilities** |
| Rust (cloud) | `cargo audit` | **0 vulnerabilities** |
| Rust (agent) | `cargo audit` | **1 CVE** — quinn-proto 0.11.13 (RUSTSEC-2026-0037, CVSS 8.7) ✅ fixed |
| Rust (agent) | `cargo audit` | 2 unmaintained warnings (non-CVE, informational) |

---

## Fix Status Summary

| ID | Severity | Description | Status |
|---|---|---|---|
| C1 | Critical | Unauthenticated `/api/telemetry` | ✅ Hardened — HMAC-style secret + constant-time compare; agent update required |
| C2 | Critical | CORS wildcard `*` | ✅ Hardened — exact-match allowlist + `Allow-Credentials` only on known origins |
| C3 | Critical | Binary path injection in service installer | ✅ Fixed — `validate_binary_path()` allowlist; aborts before writing any file |
| C4 | Critical | Pairing code brute-force (no rate limit) | ✅ Hardened — rightmost XFF, ConnectInfo fallback, `Retry-After: 60` |
| H1 | High | quinn-proto CVE RUSTSEC-2026-0037 | ✅ Fixed |
| H2 | High | No connection limits on SSE/WS | ✅ Fixed — `SseConnStream` RAII guard; 10/IP + 1000 total; 429/503 on breach |
| H3 | High | `fleet_url` unvalidated (SSRF) | ✅ Fixed — `validate_fleet_url()`; scheme + SSRF-IP checks; 400 on rejection |
| H4 | High | DOM mutation / XSS surface in LandingPage | ✅ Fixed — replaced `btn.innerHTML` with React `useState`; no DOM mutation |
| H5 | High | Silent catch on pairing API calls | ✅ Fixed — status-specific messages (429/401/402/5xx); `Retry-After` surfaced; TypeError vs auth error distinguished |

---

*Audit conducted March 12, 2026. C3/H2/H3/H4 fixed March 12, 2026. H5 fixed March 12, 2026. All High findings resolved. Next full audit: after Phase 4A ships.*
