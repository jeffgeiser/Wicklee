//! Inbound authentication for the agent's HTTP surface.
//!
//! Step 0 verification item V8 found that the agent had **no** inbound
//! authentication and no peer-address plumbing at all: zero hits for
//! `ConnectInfo` or `SocketAddr` in `agent/src`. `session_token` in
//! `config.toml` is the *outbound* cloud credential, not an inbound one. With
//! `bind_address = "0.0.0.0"`, `/api/pair/claim` and `/mcp` were reachable by
//! anything on the network. This module is the fix.
//!
//! Two decisions live here, both as pure functions so they can be tested
//! without a runtime:
//!
//! * [`evaluate_startup`] implements the spec's Remote access table once, at
//!   boot, before the listener is bound. A non-loopback bind with no token
//!   refuses to start.
//! * [`authorize`] is the per-request check, called from one middleware layer
//!   rather than repeated in each handler. Handlers are unchanged.
//!
//! The agent's own CLI paths (`--status`, `--mcp-stdio`) all talk to
//! `127.0.0.1`, so they are loopback peers and are never challenged.

use std::net::{IpAddr, SocketAddr};

/// Config key an operator sets to allow authenticated remote access.
/// Named in the refusal message so the error is actionable.
pub(crate) const TOKEN_KEY: &str = "auth_token";
/// Config key for the deliberate "no authentication" override.
pub(crate) const OVERRIDE_KEY: &str = "allow_unauthenticated";

/// Inbound auth policy, decided once at startup and then immutable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AuthPolicy {
    /// True when the listener is bound to an address that non-local peers can
    /// reach. A loopback bind cannot be reached from another machine, so no
    /// request can ever fail the check and the token is irrelevant.
    pub(crate) non_loopback_bind: bool,
    /// Bearer token required from non-loopback peers. `None` = not configured.
    pub(crate) token: Option<String>,
    /// Operator override: serve non-loopback peers with no credential.
    pub(crate) allow_unauthenticated: bool,
}

impl AuthPolicy {
    /// A loopback-bound agent: every peer is local, nothing is challenged.
    #[cfg(test)]
    fn loopback() -> Self {
        Self { non_loopback_bind: false, token: None, allow_unauthenticated: false }
    }
}

/// What `main` should do after reading the config, before binding.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StartupDecision {
    /// Start normally.
    Proceed(AuthPolicy),
    /// Start, but print this warning on every startup.
    ProceedWithWarning(AuthPolicy, String),
    /// Do not start. The string is the operator-facing reason.
    Refuse(String),
}

/// True when `bind` names an address only this machine can reach.
///
/// Fails **closed**: an address that cannot be parsed is treated as
/// non-loopback, so an unexpected value demands a token rather than silently
/// serving the network. `"localhost"` is accepted by name because that is what
/// an operator writes and what the OS resolves to a loopback address.
pub(crate) fn bind_is_loopback(bind: &str) -> bool {
    let host = bind.trim();
    // Accept a bracketed IPv6 literal, with or without a port, and a bare
    // "host:port" — config holds a host today, but tolerate both spellings.
    let host = host.strip_prefix('[').and_then(|h| h.split(']').next()).unwrap_or(host);
    let host = match host.rsplit_once(':') {
        // Only strip a trailing :port when what remains still parses or is a
        // name — otherwise this is a bare IPv6 address full of colons.
        Some((h, p)) if !h.is_empty() && p.chars().all(|c| c.is_ascii_digit()) && !h.contains(':') => h,
        _ => host,
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(ip) => ip.is_loopback(),
        // Unparseable, or a DNS name we will not resolve here: fail closed.
        Err(_) => false,
    }
}

/// Apply the spec's Remote access table.
///
/// | Configuration | Behaviour |
/// | --- | --- |
/// | Loopback, no token | Allowed |
/// | Non-loopback, token configured | Allowed, token required from other machines |
/// | Non-loopback, no token | Refuses to start |
/// | Non-loopback, `allow_unauthenticated` | Allowed, with a warning every startup |
///
/// When a token *and* the override are both set, the token wins: the override
/// exists to permit an unauthenticated listener, not to disable a configured
/// credential. The warning says so rather than silently ignoring one of them.
pub(crate) fn evaluate_startup(
    bind: &str,
    token: Option<&str>,
    allow_unauthenticated: bool,
) -> StartupDecision {
    // An empty or whitespace-only token is a configuration mistake, not a
    // credential. Treat it as absent so it cannot become a guessable secret.
    let token = token.map(str::trim).filter(|t| !t.is_empty()).map(str::to_owned);

    if bind_is_loopback(bind) {
        return StartupDecision::Proceed(AuthPolicy {
            non_loopback_bind: false,
            token,
            allow_unauthenticated,
        });
    }

    match (token, allow_unauthenticated) {
        (Some(t), false) => StartupDecision::Proceed(AuthPolicy {
            non_loopback_bind: true,
            token: Some(t),
            allow_unauthenticated: false,
        }),
        (Some(t), true) => StartupDecision::ProceedWithWarning(
            AuthPolicy { non_loopback_bind: true, token: Some(t), allow_unauthenticated: true },
            format!(
                "both {TOKEN_KEY} and {OVERRIDE_KEY} are set — the token is enforced \
                 and {OVERRIDE_KEY} is ignored. Remove one to make the intent explicit."
            ),
        ),
        (None, true) => StartupDecision::ProceedWithWarning(
            AuthPolicy { non_loopback_bind: true, token: None, allow_unauthenticated: true },
            format!(
                "{OVERRIDE_KEY} is set and no {TOKEN_KEY} is configured. Every endpoint \
                 on this agent — hardware, loaded models, operating conditions — is \
                 readable by anything that can reach {bind}, and /api/pair/claim and \
                 /mcp accept writes. Set {TOKEN_KEY} instead."
            ),
        ),
        (None, false) => StartupDecision::Refuse(
            [
                format!("refusing to start: bind_address is not loopback and no {TOKEN_KEY} is set."),
                String::new(),
                "This agent reports hardware, loaded models and operating conditions, and".into(),
                "/api/pair/claim and /mcp accept writes. Binding it to the network without a".into(),
                "credential exposes all of that.".into(),
                String::new(),
                "Fix one of these in config.toml (both are top-level keys):".into(),
                String::new(),
                format!("    {TOKEN_KEY} = \"<a long random string>\"     # recommended"),
                String::new(),
                "or revert to loopback:".into(),
                String::new(),
                "    bind_address = \"127.0.0.1\"".into(),
                String::new(),
                "To serve the network with no authentication anyway, set".into(),
                format!("{OVERRIDE_KEY} = true. Do that only on a trusted private network."),
            ]
            .join("\n"),
        ),
    }
}

/// Outcome of the per-request check.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AuthOutcome {
    Allow,
    /// Reject with 401 and this `WWW-Authenticate`-style reason.
    Unauthorized(&'static str),
}

/// Constant-time equality over the content of two byte strings.
///
/// `==` on `[u8]` short-circuits at the first differing byte, which leaks the
/// length of the shared prefix to an attacker who can measure response
/// latency — enough to recover a token byte by byte. This folds every byte
/// into one accumulator so the work does not depend on where the first
/// difference is.
///
/// The loop runs over the longer of the two inputs and mixes the length
/// difference into the accumulator, so it never returns early. Token *length*
/// is not treated as a secret; token content is.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff: u8 = 0;
    let mut len_diff: usize = a.len() ^ b.len();
    let n = a.len().max(b.len());
    for i in 0..n {
        // Out-of-range on the shorter side folds in a fixed 0; a length
        // mismatch is already captured by `len_diff`, so this cannot make
        // two different-length inputs compare equal.
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= x ^ y;
    }
    // Collapse the length difference to a single bit without branching.
    while len_diff > 0 {
        diff |= (len_diff & 0xff) as u8;
        len_diff >>= 8;
    }
    diff == 0
}

/// Extract the credential from an `Authorization: Bearer <token>` header value.
///
/// The scheme is matched case-insensitively, as RFC 7235 requires. Returns
/// `None` for any other scheme so a `Basic` header cannot be mistaken for a
/// bearer token.
pub(crate) fn bearer_token(header: Option<&str>) -> Option<&str> {
    let raw = header?.trim();
    let (scheme, value) = raw.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let value = value.trim();
    if value.is_empty() { None } else { Some(value) }
}

/// Decide whether one request may proceed.
///
/// Loopback peers are always allowed: they are on this machine, the dashboard
/// and the agent's own CLI are loopback clients, and a loopback-bound listener
/// can see no other kind of peer. Everything else must present the token.
pub(crate) fn authorize(policy: &AuthPolicy, peer: IpAddr, bearer: Option<&str>) -> AuthOutcome {
    if peer.is_loopback() {
        return AuthOutcome::Allow;
    }
    match policy.token.as_deref() {
        Some(expected) => match bearer {
            Some(given) if constant_time_eq(given.as_bytes(), expected.as_bytes()) => {
                AuthOutcome::Allow
            }
            Some(_) => AuthOutcome::Unauthorized("invalid bearer token"),
            None => AuthOutcome::Unauthorized("missing bearer token"),
        },
        // No token configured. Only the explicit override permits this; without
        // it the agent would have refused to start on a non-loopback bind, so
        // reaching here at all means the operator opted in.
        None if policy.allow_unauthenticated => AuthOutcome::Allow,
        None => AuthOutcome::Unauthorized("remote access is not configured"),
    }
}

/// Peer address of a request, for the middleware.
///
/// Reads only the socket's own peer address. `X-Forwarded-For` and friends are
/// deliberately **not** consulted: they are attacker-controlled on a direct
/// connection, so trusting them would let any remote caller claim to be
/// loopback and bypass the whole check.
pub(crate) fn peer_ip(addr: &SocketAddr) -> IpAddr {
    // An IPv4-mapped IPv6 peer (::ffff:127.0.0.1) arrives when the listener is
    // a dual-stack socket. Unmap it so `is_loopback()` sees the real address.
    match addr.ip() {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6(v6),
        },
        ip => ip,
    }
}

/// The single middleware layer in front of every route on the agent's main
/// listener.
///
/// This is deliberately one layer rather than a check inside each handler:
/// there are ~30 routes today and `/v1` adds more, and a per-handler check is
/// one `fn` signature away from being forgotten on a new route. Handlers are
/// untouched by this change.
///
/// Not applied to the optional Ollama proxy on :11434 — that is a separate
/// listener with its own router, bound to a hardcoded `127.0.0.1`, and it is a
/// transparent pass-through for Ollama clients. Requiring a bearer token there
/// would break every Ollama SDK pointed at it, and its loopback-only bind
/// already means no remote peer can reach it.
pub(crate) async fn require_auth(
    axum::extract::State(policy): axum::extract::State<std::sync::Arc<AuthPolicy>>,
    connect_info: Option<axum::extract::ConnectInfo<SocketAddr>>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::response::IntoResponse;

    // Fail closed. A missing ConnectInfo means the router was not built with
    // `into_make_service_with_connect_info`, which is a wiring bug — denying is
    // the safe reading, and the message names the cause so it is diagnosable.
    let Some(axum::extract::ConnectInfo(addr)) = connect_info else {
        return unauthorized("peer address unavailable").into_response();
    };

    let bearer_header = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());

    match authorize(&policy, peer_ip(&addr), bearer_token(bearer_header)) {
        AuthOutcome::Allow => next.run(req).await,
        AuthOutcome::Unauthorized(reason) => unauthorized(reason).into_response(),
    }
}

/// 401 with a machine-readable body and the challenge header.
fn unauthorized(reason: &'static str) -> impl axum::response::IntoResponse {
    (
        axum::http::StatusCode::UNAUTHORIZED,
        [(
            axum::http::header::WWW_AUTHENTICATE,
            "Bearer realm=\"wicklee\"",
        )],
        axum::Json(serde_json::json!({
            "error": reason,
            "hint": format!(
                "this agent is bound to a non-loopback address; send \
                 `Authorization: Bearer <{TOKEN_KEY}>` from another machine"
            ),
        })),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    // ── bind_is_loopback ─────────────────────────────────────────────────────

    #[test]
    fn loopback_binds_are_recognised() {
        for b in ["127.0.0.1", "127.0.0.1:7700", "localhost", "LocalHost", "::1", "[::1]", "[::1]:7700", "127.1.2.3"] {
            assert!(bind_is_loopback(b), "{b} should be loopback");
        }
    }

    #[test]
    fn network_binds_are_recognised() {
        for b in ["0.0.0.0", "0.0.0.0:7700", "192.168.1.5", "::", "[::]", "10.0.0.1"] {
            assert!(!bind_is_loopback(b), "{b} should not be loopback");
        }
    }

    #[test]
    fn unparseable_bind_fails_closed() {
        // A DNS name we will not resolve must demand a token, not be assumed local.
        for b in ["example.com", "wicklee.local", "", "not an address"] {
            assert!(!bind_is_loopback(b), "{b:?} should fail closed to non-loopback");
        }
    }

    // ── evaluate_startup: the Remote access table ────────────────────────────

    #[test]
    fn loopback_without_token_is_allowed() {
        let d = evaluate_startup("127.0.0.1", None, false);
        match d {
            StartupDecision::Proceed(p) => {
                assert!(!p.non_loopback_bind);
                assert_eq!(p.token, None);
            }
            other => panic!("expected Proceed, got {other:?}"),
        }
    }

    #[test]
    fn non_loopback_with_token_is_allowed() {
        let d = evaluate_startup("0.0.0.0", Some("s3cret"), false);
        match d {
            StartupDecision::Proceed(p) => {
                assert!(p.non_loopback_bind);
                assert_eq!(p.token.as_deref(), Some("s3cret"));
            }
            other => panic!("expected Proceed, got {other:?}"),
        }
    }

    #[test]
    fn non_loopback_without_token_refuses_to_start() {
        let d = evaluate_startup("0.0.0.0", None, false);
        match d {
            StartupDecision::Refuse(msg) => {
                // The refusal must name the key to set, or it is not actionable.
                assert!(msg.contains(TOKEN_KEY), "refusal must name {TOKEN_KEY}: {msg}");
                assert!(msg.contains("bind_address"), "refusal should mention bind_address");
                // Both remedies, so the operator is not forced into the override.
                assert!(msg.contains("127.0.0.1"), "refusal should offer the loopback revert");
                assert!(msg.contains(OVERRIDE_KEY), "refusal should name the override");
                // No unrendered format placeholders left in the text.
                assert!(!msg.contains('{') && !msg.contains('}'), "unrendered placeholder: {msg}");
                println!("\n--- refusal message as an operator sees it ---\n{msg}\n---");
            }
            other => panic!("expected Refuse, got {other:?}"),
        }
    }

    #[test]
    fn non_loopback_with_override_warns_but_starts() {
        let d = evaluate_startup("0.0.0.0", None, true);
        match d {
            StartupDecision::ProceedWithWarning(p, msg) => {
                assert!(p.allow_unauthenticated);
                assert_eq!(p.token, None);
                assert!(msg.contains(OVERRIDE_KEY));
            }
            other => panic!("expected ProceedWithWarning, got {other:?}"),
        }
    }

    #[test]
    fn token_wins_over_override_and_says_so() {
        let d = evaluate_startup("0.0.0.0", Some("tok"), true);
        match d {
            StartupDecision::ProceedWithWarning(p, msg) => {
                assert_eq!(p.token.as_deref(), Some("tok"));
                assert!(msg.contains("ignored"), "warning should say the override is ignored: {msg}");
            }
            other => panic!("expected ProceedWithWarning, got {other:?}"),
        }
        // And the enforced policy really does challenge a remote peer.
        let p = AuthPolicy { non_loopback_bind: true, token: Some("tok".into()), allow_unauthenticated: true };
        assert_eq!(
            authorize(&p, IpAddr::V4(Ipv4Addr::new(10, 0, 0, 9)), None),
            AuthOutcome::Unauthorized("missing bearer token"),
        );
    }

    #[test]
    fn blank_token_is_not_a_credential() {
        // "" or "   " in config must refuse to start, not become a guessable secret.
        for t in [Some(""), Some("   ")] {
            assert!(matches!(evaluate_startup("0.0.0.0", t, false), StartupDecision::Refuse(_)));
        }
    }

    // ── authorize ────────────────────────────────────────────────────────────

    const V4_REMOTE: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 50));

    #[test]
    fn loopback_peer_is_always_allowed() {
        // The dashboard, `--status` and `--mcp-stdio` are all loopback clients.
        let strict = AuthPolicy { non_loopback_bind: true, token: Some("tok".into()), allow_unauthenticated: false };
        for ip in [
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
        ] {
            assert_eq!(authorize(&strict, ip, None), AuthOutcome::Allow, "{ip} should be allowed");
        }
        assert_eq!(authorize(&AuthPolicy::loopback(), IpAddr::V4(Ipv4Addr::LOCALHOST), None), AuthOutcome::Allow);
    }

    #[test]
    fn remote_peer_needs_the_right_token() {
        let p = AuthPolicy { non_loopback_bind: true, token: Some("correct-horse".into()), allow_unauthenticated: false };
        assert_eq!(authorize(&p, V4_REMOTE, Some("correct-horse")), AuthOutcome::Allow);
        assert_eq!(authorize(&p, V4_REMOTE, Some("wrong")), AuthOutcome::Unauthorized("invalid bearer token"));
        assert_eq!(authorize(&p, V4_REMOTE, None), AuthOutcome::Unauthorized("missing bearer token"));
        // A prefix of the real token must not pass.
        assert_eq!(authorize(&p, V4_REMOTE, Some("correct-hors")), AuthOutcome::Unauthorized("invalid bearer token"));
        // Nor a value that merely starts with it.
        assert_eq!(authorize(&p, V4_REMOTE, Some("correct-horsey")), AuthOutcome::Unauthorized("invalid bearer token"));
    }

    #[test]
    fn remote_peer_allowed_only_under_the_override() {
        let overridden = AuthPolicy { non_loopback_bind: true, token: None, allow_unauthenticated: true };
        assert_eq!(authorize(&overridden, V4_REMOTE, None), AuthOutcome::Allow);

        // Without the override and without a token the agent would have refused
        // to start; if it is ever reached, deny rather than serve.
        let misconfigured = AuthPolicy { non_loopback_bind: true, token: None, allow_unauthenticated: false };
        assert_eq!(
            authorize(&misconfigured, V4_REMOTE, None),
            AuthOutcome::Unauthorized("remote access is not configured"),
        );
    }

    // ── bearer_token ─────────────────────────────────────────────────────────

    #[test]
    fn bearer_parsing_is_case_insensitive_on_the_scheme() {
        assert_eq!(bearer_token(Some("Bearer abc")), Some("abc"));
        assert_eq!(bearer_token(Some("bearer abc")), Some("abc"));
        assert_eq!(bearer_token(Some("BEARER abc")), Some("abc"));
        assert_eq!(bearer_token(Some("  Bearer   abc  ")), Some("abc"));
    }

    #[test]
    fn non_bearer_schemes_are_not_tokens() {
        assert_eq!(bearer_token(Some("Basic abc")), None);
        assert_eq!(bearer_token(Some("abc")), None);
        assert_eq!(bearer_token(Some("Bearer")), None);
        assert_eq!(bearer_token(Some("Bearer ")), None);
        assert_eq!(bearer_token(None), None);
    }

    // ── constant_time_eq ─────────────────────────────────────────────────────

    #[test]
    fn constant_time_eq_matches_normal_equality() {
        let cases: &[(&[u8], &[u8])] = &[
            (b"", b""),
            (b"a", b"a"),
            (b"a", b"b"),
            (b"", b"a"),
            (b"a", b""),
            (b"abc", b"abd"),
            (b"abc", b"abcd"),
            (b"abcd", b"abc"),
            (b"\0", b""),
            (b"\0\0", b"\0"),
            (b"token-with-some-length", b"token-with-some-length"),
        ];
        for (a, b) in cases {
            assert_eq!(constant_time_eq(a, b), a == b, "{a:?} vs {b:?}");
        }
    }

    // ── peer_ip ──────────────────────────────────────────────────────────────

    #[test]
    fn ipv4_mapped_loopback_is_unmapped() {
        // A dual-stack listener reports ::ffff:127.0.0.1 for a local client.
        let mapped: SocketAddr = "[::ffff:127.0.0.1]:5555".parse().unwrap();
        assert!(peer_ip(&mapped).is_loopback(), "mapped loopback must read as loopback");

        // And a mapped *remote* address must not become loopback.
        let mapped_remote: SocketAddr = "[::ffff:192.168.1.50]:5555".parse().unwrap();
        assert!(!peer_ip(&mapped_remote).is_loopback());
    }

    // ── Full-stack wiring ────────────────────────────────────────────────────
    // The checks above are pure. This one drives a real listener through
    // `into_make_service_with_connect_info` and the real middleware, because
    // the regression that actually matters is the agent locking out its own
    // dashboard: every browser call, `--status` and `--mcp-stdio` is a loopback
    // peer, and all of them must pass even when a token is configured.
    //
    // `tower::ServiceExt::oneshot` would be the usual way to exercise a router
    // in-process, but `tower` is only a transitive dependency here and Phase 1
    // forbids new ones — so this uses a real socket and `reqwest`, both already
    // direct dependencies.
    async fn serve_probe_app(policy: AuthPolicy) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        let app = axum::Router::new()
            .route("/probe", axum::routing::get(|| async { "reached" }))
            .route("/probe", axum::routing::post(|| async { "posted" }))
            .layer(axum::middleware::from_fn_with_state(
                std::sync::Arc::new(policy),
                require_auth,
            ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });
        (addr, handle)
    }

    #[tokio::test]
    async fn loopback_requests_pass_through_the_real_stack() {
        // A token-configured, network-bound policy — the strictest case. A
        // loopback caller must still get through without any header.
        let policy = AuthPolicy {
            non_loopback_bind: true,
            token: Some("a-real-token".into()),
            allow_unauthenticated: false,
        };
        let (addr, handle) = serve_probe_app(policy).await;
        let client = reqwest::Client::new();

        let get = client.get(format!("http://{addr}/probe")).send().await.unwrap();
        assert_eq!(get.status(), 200, "loopback GET must not be challenged");
        assert_eq!(get.text().await.unwrap(), "reached");

        // POST too: /api/pair/claim and /mcp are POSTs, and the pairing flow
        // and MCP stdio bridge both call them over loopback.
        let post = client.post(format!("http://{addr}/probe")).send().await.unwrap();
        assert_eq!(post.status(), 200, "loopback POST must not be challenged");

        // A loopback caller that *does* send a wrong token is still fine —
        // loopback is decided by peer address, not by the header.
        let with_bad_token = client
            .get(format!("http://{addr}/probe"))
            .header("Authorization", "Bearer nonsense")
            .send()
            .await
            .unwrap();
        assert_eq!(with_bad_token.status(), 200);

        handle.abort();
    }

    #[tokio::test]
    async fn missing_connect_info_fails_closed() {
        // Without `into_make_service_with_connect_info` the middleware has no
        // peer address. That is a wiring bug, and it must deny rather than
        // wave everything through.
        let app = axum::Router::new()
            .route("/probe", axum::routing::get(|| async { "reached" }))
            .layer(axum::middleware::from_fn_with_state(
                std::sync::Arc::new(AuthPolicy::loopback()),
                require_auth,
            ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        // NOTE: plain `into_make_service()` — no connect info.
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let resp = reqwest::get(format!("http://{addr}/probe")).await.unwrap();
        assert_eq!(resp.status(), 401, "a missing peer address must fail closed");
        let body: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(body["error"], "peer address unavailable");

        handle.abort();
    }

    #[test]
    fn plain_addresses_pass_through() {
        let v4: SocketAddr = "192.168.1.50:80".parse().unwrap();
        assert_eq!(peer_ip(&v4), V4_REMOTE);
        let v6: SocketAddr = "[2001:db8::1]:80".parse().unwrap();
        assert!(!peer_ip(&v6).is_loopback());
    }
}
