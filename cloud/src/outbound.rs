//! Outbound HTTP: the shared first-party agent, the SSRF guard with DNS-pinned clients, and webhook delivery.

use crate::*;

/// Shared blocking HTTP agent for FIXED first-party endpoints (Clerk, Resend,
/// PagerDuty, Taarn, GitHub, Hugging Face). Bare `ureq::get/post` has no
/// timeouts, so one stalled upstream pinned a blocking-pool thread forever.
/// Customer-supplied URLs must NOT use this — they go through the SSRF-pinned
/// agents (pinned_ureq_agent / pinned_reqwest_client).
pub(crate) static HTTP_AGENT: std::sync::LazyLock<ureq::Agent> = std::sync::LazyLock::new(|| {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .build()
});

// ── Outbound URL guard (SSRF) ─────────────────────────────────────────────────
//
// Webhook, audit-drain, OTel and Slack URLs are customer-supplied, and the
// `/test` endpoints echo the receiver's status code. Unchecked, that turns the
// control plane into a probe of its own network (Railway internal services,
// cloud metadata at 169.254.169.254, localhost admin ports). Every outbound
// call to such a URL goes through `resolve_outbound*`, which:
//   - requires http(s) and a host,
//   - resolves the host and rejects any non-public address,
//   - returns the checked addresses so the client is PINNED to them (no DNS
//     rebinding between check and connect),
// and the clients built from it never follow redirects (a public receiver
// could otherwise 302 us to an internal address).
// Self-hosted installs deliver to their own private network by design, so
// private targets are allowed there (or with OUTBOUND_ALLOW_PRIVATE=true).

pub(crate) fn outbound_private_allowed() -> bool {
    static FLAG: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *FLAG.get_or_init(|| {
        is_self_hosted()
            || matches!(std::env::var("OUTBOUND_ALLOW_PRIVATE").as_deref(), Ok("true") | Ok("1"))
    })
}

pub(crate) fn is_public_ipv4(ip: std::net::Ipv4Addr) -> bool {
    let o = ip.octets();
    !(ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified()
        || ip.is_broadcast() || ip.is_multicast() || ip.is_documentation()
        || o[0] == 0                                  // 0.0.0.0/8
        || (o[0] == 100 && (o[1] & 0xc0) == 64)       // 100.64.0.0/10 CGNAT
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)    // 192.0.0.0/24
        || (o[0] == 198 && (o[1] & 0xfe) == 18)       // 198.18.0.0/15
        || o[0] >= 240)                               // reserved
}

pub(crate) fn is_public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => is_public_ipv4(v4),
        std::net::IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_ipv4(v4);
            }
            let seg = v6.segments();
            !(v6.is_loopback() || v6.is_unspecified() || v6.is_multicast()
                || (seg[0] & 0xfe00) == 0xfc00                 // fc00::/7 ULA
                || (seg[0] & 0xffc0) == 0xfe80                 // fe80::/10 link-local
                || (seg[0] == 0x0064 && seg[1] == 0xff9b)      // 64:ff9b::/96 NAT64
                || (seg[0] == 0x2001 && seg[1] == 0x0db8))     // documentation
        }
    }
}

/// A validated outbound destination: the parsed URL, its host as written,
/// and the resolved addresses a client must be pinned to.
pub(crate) struct OutboundTarget {
    pub(crate) url:   reqwest::Url,
    pub(crate) host:  String,
    pub(crate) addrs: Vec<std::net::SocketAddr>,
}

pub(crate) enum OutboundHost {
    Ip(std::net::IpAddr),
    Name(String),
}

pub(crate) fn parse_outbound_url(raw: &str) -> Result<(reqwest::Url, OutboundHost, u16), String> {
    let url = reqwest::Url::parse(raw.trim()).map_err(|_| "url is not a valid URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("url must be http(s)".into());
    }
    let host = url.host_str().filter(|h| !h.is_empty())
        .ok_or_else(|| "url must include a host".to_string())?
        .to_string();
    let port = url.port_or_known_default().ok_or_else(|| "url has no port".to_string())?;
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let h = match bare.parse::<std::net::IpAddr>() {
        Ok(ip) => OutboundHost::Ip(ip),
        Err(_) => OutboundHost::Name(host),
    };
    Ok((url, h, port))
}

pub(crate) fn check_outbound_addrs(addrs: Vec<std::net::SocketAddr>) -> Result<Vec<std::net::SocketAddr>, String> {
    if addrs.is_empty() {
        return Err("url host does not resolve".into());
    }
    if !outbound_private_allowed() && addrs.iter().any(|a| !is_public_ip(a.ip())) {
        return Err("url resolves to a private, loopback or link-local address, which is not allowed".into());
    }
    Ok(addrs)
}

/// Async validation + resolution (request handlers, reqwest delivery).
pub(crate) async fn resolve_outbound(raw: &str) -> Result<OutboundTarget, String> {
    let (url, host, port) = parse_outbound_url(raw)?;
    let (host, addrs) = match host {
        OutboundHost::Ip(ip) => (ip.to_string(), vec![std::net::SocketAddr::new(ip, port)]),
        OutboundHost::Name(name) => {
            let addrs: Vec<_> = tokio::net::lookup_host((name.as_str(), port)).await
                .map_err(|_| "url host does not resolve".to_string())?.collect();
            (name, addrs)
        }
    };
    Ok(OutboundTarget { url, host, addrs: check_outbound_addrs(addrs)? })
}

/// Blocking validation + resolution (ureq delivery inside spawn_blocking).
pub(crate) fn resolve_outbound_blocking(raw: &str) -> Result<OutboundTarget, String> {
    use std::net::ToSocketAddrs;
    let (url, host, port) = parse_outbound_url(raw)?;
    let (host, addrs) = match host {
        OutboundHost::Ip(ip) => (ip.to_string(), vec![std::net::SocketAddr::new(ip, port)]),
        OutboundHost::Name(name) => {
            let addrs: Vec<_> = (name.as_str(), port).to_socket_addrs()
                .map_err(|_| "url host does not resolve".to_string())?.collect();
            (name, addrs)
        }
    };
    Ok(OutboundTarget { url, host, addrs: check_outbound_addrs(addrs)? })
}

/// reqwest client pinned to the target's checked addresses, no redirects.
pub(crate) fn pinned_reqwest_client(t: &OutboundTarget, timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(&t.host, &t.addrs)
        .build().map_err(|e| e.to_string())
}

/// ureq agent pinned to the target's checked addresses, no redirects.
pub(crate) fn pinned_ureq_agent(t: &OutboundTarget, timeout: Duration) -> ureq::Agent {
    let addrs = t.addrs.clone();
    ureq::AgentBuilder::new()
        .redirects(0)
        .timeout(timeout)
        .resolver(move |_: &str| Ok(addrs.clone()))
        .build()
}

/// Sign + POST a webhook payload. Returns the receiver's HTTP status on
/// success or an error message on transport failure.  Fire-and-forget on
/// caller side — we don't retry; a 5xx receiver is the operator's problem.
pub(crate) async fn deliver_webhook(url: &str, secret: &str, payload: &serde_json::Value) -> Result<u16, String> {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let body = serde_json::to_string(payload).map_err(|e| e.to_string())?;
    type HmacSha256 = Hmac<Sha256>;
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).map_err(|e| e.to_string())?;
    mac.update(body.as_bytes());
    let sig = hex::encode(mac.finalize().into_bytes());

    let target = resolve_outbound(url).await?;
    let client = pinned_reqwest_client(&target, Duration::from_secs(5))?;
    let resp = client.post(target.url.clone())
        .header("Content-Type", "application/json")
        .header("X-Wicklee-Signature", format!("sha256={sig}"))
        .header("User-Agent", "Wicklee-Webhook/1.0")
        .body(body)
        .send().await.map_err(|e| e.to_string())?;
    Ok(resp.status().as_u16())
}
