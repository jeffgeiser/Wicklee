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

### C3 — Binary Path Injection in Service Installer
**File:** `agent/src/main.rs` — `--install-service` handler (macOS plist / Linux systemd unit)

**Risk:** The binary path written into the plist/systemd unit is derived from `std::env::current_exe()` without sanitization. A binary installed at a path containing shell metacharacters (`;`, `&`, `$(...)`, etc.) could enable command injection when the service manager reloads the unit file.

**Status:** OPEN — not fixed this session. Mitigation: the installer already requires `sudo`; attack surface is limited to local privilege escalation, not remote. Fix: validate that the binary path contains only safe characters (`[a-zA-Z0-9/_.-]`) and reject with a clear error if not.

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

### H2 — No Connection Limits on SSE/WebSocket
**File:** `cloud/src/main.rs` — `handle_fleet_stream`; `agent/src/main.rs` — WS handler

**Risk:** No per-IP or total connection cap on SSE or WebSocket endpoints. A single IP can open thousands of connections, exhausting Tokio task memory and Railway's connection limit, causing denial-of-service for all users.

**Status:** OPEN. Fix: Tower middleware `ConcurrencyLimit` or a per-IP atomic counter in `AppState`. Planned for Phase 4A hardening sprint.

---

### H3 — `fleet_url` Unvalidated (SSRF)
**File:** `cloud/src/main.rs` — `handle_claim`

**Risk:** The agent supplies `fleet_url` during the pair/claim call and it is stored verbatim. If the cloud backend ever follows this URL (e.g., for health checks or webhook callbacks), an attacker can supply `http://169.254.169.254/latest/meta-data/` (AWS IMDS) or internal Railway service addresses — classic SSRF.

**Status:** OPEN. The current backend does not follow `fleet_url`, so no immediate exploit. Fix: validate that `fleet_url` matches `https://<railway-domain>` or reject non-HTTPS/non-allowlisted URLs at claim time.

---

### H4 — `innerHTML` in LandingPage.tsx
**File:** `src/components/LandingPage.tsx`

**Risk:** Uses `dangerouslySetInnerHTML` to render blog/marketing content. If the content source is ever user-controlled or fetched from an external URL, this becomes a stored XSS vector.

**Status:** OPEN. Content is currently static/hardcoded. Risk is low until dynamic content is added. Fix: replace `dangerouslySetInnerHTML` with a sanitized Markdown renderer (e.g., `react-markdown` with `rehype-sanitize`) before accepting any user-supplied content.

---

### H5 — Silent `catch {}` on Pairing API Calls
**File:** `src/components/AddNodeModal.tsx` — `handleSubmit`

**Risk:** Network errors and unexpected HTTP status codes are swallowed by bare `catch {}` blocks, surfacing "Unable to reach the cloud backend" for all error types including auth failures, 429 rate limiting, and 402 payment required. Users receive no actionable error message; security-relevant failures (e.g., rate limit hit) are invisible.

**Status:** PARTIALLY MITIGATED — the error message is shown in the UI. Fix: surface the HTTP status code in the error message for 401/402/429 cases.

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
| C3 | Critical | Binary path injection in service installer | ⏳ Open |
| C4 | Critical | Pairing code brute-force (no rate limit) | ✅ Hardened — rightmost XFF, ConnectInfo fallback, `Retry-After: 60` |
| H1 | High | quinn-proto CVE RUSTSEC-2026-0037 | ✅ Fixed |
| H2 | High | No connection limits on SSE/WS | ⏳ Open |
| H3 | High | `fleet_url` unvalidated (SSRF) | ⏳ Open |
| H4 | High | `dangerouslySetInnerHTML` in LandingPage | ⏳ Open |
| H5 | High | Silent catch on pairing API calls | ⏳ Partial |

---

*Audit conducted March 12, 2026. Next full audit: after Phase 4A ships.*
