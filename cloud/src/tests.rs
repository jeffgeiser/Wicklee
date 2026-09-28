//! Cross-module unit tests.

use crate::*;

#[cfg(test)]
mod security_tests {
    use super::*;

    fn sign(secret: &str, ts: i64, body: &[u8]) -> String {
        use hmac::{Hmac, Mac};
        let mut mac = Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(format!("{ts}:").as_bytes());
        mac.update(body);
        hex::encode(mac.finalize().into_bytes())
    }

    #[test]
    fn paddle_signature_accepts_fresh_valid_and_rotated() {
        let body = br#"{"event_type":"subscription.activated"}"#;
        let now = 1_700_000_000;
        let good = sign("sec", now, body);
        assert!(verify_paddle_signature("sec", &format!("ts={now};h1={good}"), body, now));
        // Rotation: any h1 may match.
        let hdr = format!("ts={now};h1={};h1={good}", "0".repeat(64));
        assert!(verify_paddle_signature("sec", &hdr, body, now + 10));
    }

    #[test]
    fn paddle_signature_rejects_replay_tamper_and_malformed() {
        let body = br#"{"a":1}"#;
        let ts = 1_700_000_000;
        let sig = sign("sec", ts, body);
        let hdr = format!("ts={ts};h1={sig}");
        // Replayed outside the tolerance window, either direction.
        assert!(!verify_paddle_signature("sec", &hdr, body, ts + PADDLE_SIG_TOLERANCE_S + 1));
        assert!(!verify_paddle_signature("sec", &hdr, body, ts - PADDLE_SIG_TOLERANCE_S - 1));
        // Tampered body, wrong secret, missing parts, non-numeric ts.
        assert!(!verify_paddle_signature("sec", &hdr, br#"{"a":2}"#, ts));
        assert!(!verify_paddle_signature("other", &hdr, body, ts));
        assert!(!verify_paddle_signature("sec", &format!("h1={sig}"), body, ts));
        assert!(!verify_paddle_signature("sec", &format!("ts={ts}"), body, ts));
        assert!(!verify_paddle_signature("sec", &format!("ts=abc;h1={sig}"), body, ts));
        assert!(!verify_paddle_signature("sec", "", body, ts));
    }

    #[test]
    fn paddle_signature_covers_raw_non_utf8_bytes() {
        // A lossy UTF-8 re-encode would change these bytes and break the MAC.
        let body = b"{\"x\":\"\xff\xfe\"}";
        let ts = 1_700_000_000;
        let sig = sign("sec", ts, body);
        assert!(verify_paddle_signature("sec", &format!("ts={ts};h1={sig}"), body, ts));
    }

    #[test]
    fn paddle_action_by_status() {
        assert_eq!(paddle_action("active", Some("team_10")), PaddleAction::Grant("team_10"));
        assert_eq!(paddle_action("trialing", Some("team")), PaddleAction::Grant("team"));
        assert_eq!(paddle_action("active", None), PaddleAction::LinkOnly);
        assert_eq!(paddle_action("past_due", Some("team")), PaddleAction::Keep);
        assert_eq!(paddle_action("paused", Some("team")), PaddleAction::Revoke);
        assert_eq!(paddle_action("canceled", None), PaddleAction::Revoke);
        assert_eq!(paddle_action("something_new", Some("team")), PaddleAction::Keep);
    }

    #[test]
    fn paddle_status_falls_back_to_event_name() {
        let empty = serde_json::json!({});
        assert_eq!(paddle_status("subscription.canceled", &empty), "canceled");
        assert_eq!(paddle_status("subscription.paused", &empty), "paused");
        assert_eq!(paddle_status("subscription.past_due", &empty), "past_due");
        assert_eq!(paddle_status("subscription.activated", &empty), "active");
        // data.status wins: an `updated` event can carry past_due or canceled.
        let d = serde_json::json!({ "status": "canceled" });
        assert_eq!(paddle_status("subscription.updated", &d), "canceled");
    }

    #[test]
    fn paddle_tier_uses_first_recognized_item() {
        let prices = PaddlePrices {
            pro: String::new(), team10_monthly: "pri_t10".into(), team10_annual: String::new(),
            team_monthly: "pri_t25".into(), team_annual: String::new(), business: String::new(),
        };
        let d = serde_json::json!({ "items": [
            { "price": { "id": "pri_addon_unknown" } },
            { "price": { "id": "pri_t25" } },
        ]});
        assert_eq!(paddle_tier(&d, &prices), Some("team"));
        assert_eq!(paddle_tier(&serde_json::json!({ "items": [] }), &prices), None);
        assert_eq!(paddle_tier(&serde_json::json!({}), &prices), None);
    }

    #[test]
    fn client_ip_reads_proxy_appended_entry_not_client_supplied() {
        // Client spoofs "1.1.1.1"; our proxy appended the real peer last.
        assert_eq!(client_ip_from_xff(Some("1.1.1.1, 203.0.113.9"), 1), "203.0.113.9");
        // Two trusted hops: client is second from the right.
        assert_eq!(client_ip_from_xff(Some("1.1.1.1, 203.0.113.9, 10.0.0.2"), 2), "203.0.113.9");
        assert_eq!(client_ip_from_xff(Some("203.0.113.9"), 1), "203.0.113.9");
        assert_eq!(client_ip_from_xff(Some("203.0.113.9"), 3), "203.0.113.9");
        assert_eq!(client_ip_from_xff(Some(" , "), 1), "unknown");
        assert_eq!(client_ip_from_xff(None, 1), "unknown");
    }
}

#[cfg(test)]
mod outbound_and_token_tests {
    use super::*;
    use std::net::{IpAddr, SocketAddr};

    fn ip(s: &str) -> IpAddr { s.parse().unwrap() }

    #[test]
    fn public_ip_classification() {
        for bad in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254",
                    "100.64.0.1", "0.0.0.0", "255.255.255.255", "224.0.0.1", "198.18.0.1",
                    "::1", "::", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1",
                    "::ffff:169.254.169.254", "64:ff9b::a00:1"] {
            assert!(!is_public_ip(ip(bad)), "{bad} should be blocked");
        }
        for good in ["8.8.8.8", "1.1.1.1", "34.120.1.1", "2606:4700::1111", "::ffff:8.8.8.8"] {
            assert!(is_public_ip(ip(good)), "{good} should be allowed");
        }
    }

    #[test]
    fn outbound_url_parsing() {
        assert!(parse_outbound_url("ftp://example.com/x").is_err());
        assert!(parse_outbound_url("file:///etc/passwd").is_err());
        assert!(parse_outbound_url("not a url").is_err());
        let (_, h, port) = parse_outbound_url("https://hooks.slack.com/services/x").unwrap();
        assert!(matches!(h, OutboundHost::Name(ref n) if n == "hooks.slack.com"));
        assert_eq!(port, 443);
        let (_, h, port) = parse_outbound_url("http://[::1]:8080/").unwrap();
        assert!(matches!(h, OutboundHost::Ip(a) if a == ip("::1")));
        assert_eq!(port, 8080);
        let (_, h, _) = parse_outbound_url("http://169.254.169.254/latest/meta-data").unwrap();
        assert!(matches!(h, OutboundHost::Ip(_)));
    }

    #[test]
    fn outbound_addr_check_rejects_any_private_answer() {
        // Tests run without SELF_HOSTED / OUTBOUND_ALLOW_PRIVATE.
        let public: SocketAddr = "8.8.8.8:443".parse().unwrap();
        let private: SocketAddr = "10.0.0.5:443".parse().unwrap();
        assert!(check_outbound_addrs(vec![public]).is_ok());
        // One private record among public ones is enough to refuse (rebinding).
        assert!(check_outbound_addrs(vec![public, private]).is_err());
        assert!(check_outbound_addrs(vec![]).is_err());
    }

    #[tokio::test]
    async fn resolve_outbound_rejects_literal_internal_targets() {
        assert!(resolve_outbound("http://127.0.0.1:5432/").await.is_err());
        assert!(resolve_outbound("http://169.254.169.254/latest/meta-data").await.is_err());
        assert!(resolve_outbound("http://[::1]/").await.is_err());
        assert!(resolve_outbound("https://8.8.8.8/hook").await.is_ok());
    }

    #[test]
    fn node_token_hashing_and_legacy_plaintext() {
        let tok = "wk_0123456789abcdef";
        let stored = hash_node_token(tok);
        assert!(stored.starts_with("sha256:"));
        assert_eq!(node_token_check(&stored, tok), Some(false));
        assert_eq!(node_token_check(&stored, "wk_wrong"), None);
        // A presented value equal to the stored HASH must not authenticate.
        assert_eq!(node_token_check(&stored, &stored), None);
        // Legacy plaintext rows still work and are flagged for re-hashing.
        assert_eq!(node_token_check(tok, tok), Some(true));
        assert_eq!(node_token_check(tok, "wk_wrong"), None);
    }
}

#[cfg(test)]
mod perf_path_tests {
    use super::*;

    fn node(id: &str, name: Option<&str>, tags: Option<&str>) -> FleetStreamNode {
        FleetStreamNode { id: id.into(), display_name: name.map(Into::into), tags: tags.map(Into::into) }
    }

    fn entry(last_seen_ms: u64) -> MetricsEntry {
        MetricsEntry { last_seen_ms, metrics: None, snapshot_saved_ms: 0 }
    }

    #[test]
    fn fleet_frame_includes_only_live_tenant_nodes_and_restricts_by_pairing_order() {
        let nodes = vec![
            node("a", Some("alpha"), None),
            node("b", None, Some("env:prod")),
            node("offline", None, None), // no in-memory entry — omitted
            node("c", None, None),
        ];
        let mut metrics = HashMap::new();
        for (id, ts) in [("a", 1), ("b", 2), ("c", 3), ("other-tenant", 4)] {
            metrics.insert(id.to_string(), entry(ts));
        }

        // Limit 2 by pairing order: a, b allowed; "offline" and c are past it.
        let v: serde_json::Value = serde_json::from_str(&build_fleet_frame(&nodes, 2, &metrics)).unwrap();
        let list = v["nodes"].as_array().unwrap();
        let ids: Vec<&str> = list.iter().map(|n| n["node_id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["a", "b", "c"], "other tenants' nodes must never appear");
        assert_eq!(list[0]["restricted"], false);
        assert_eq!(list[1]["restricted"], false);
        assert_eq!(list[2]["restricted"], true);
        assert_eq!(list[0]["display_name"], "alpha");
        assert!(list[0].get("tags").is_none());
        assert_eq!(list[1]["tags"], "env:prod");
        assert!(list[1].get("display_name").is_none());
        assert_eq!(list[2]["last_seen_ms"], 3);
        assert!(list[2]["metrics"].is_null());
    }

    #[test]
    fn fleet_frame_empty_tenant_is_empty_list() {
        let v: serde_json::Value =
            serde_json::from_str(&build_fleet_frame(&[], usize::MAX, &HashMap::new())).unwrap();
        assert_eq!(v, serde_json::json!({ "nodes": [] }));
    }

    #[test]
    fn snapshot_persist_is_throttled_per_node() {
        assert!(snapshot_persist_due(0, 5), "first push after boot writes");
        assert!(!snapshot_persist_due(1_000, 1_000 + SNAPSHOT_PERSIST_MS - 1));
        assert!(snapshot_persist_due(1_000, 1_000 + SNAPSHOT_PERSIST_MS));
        // Clock stepping backwards must not panic or write.
        assert!(!snapshot_persist_due(10_000, 5_000));
    }

    #[test]
    fn prune_rate_limits_drops_idle_keys_and_trims_live_ones() {
        let now = 10 * RATE_LIMIT_WINDOW_MS;
        let mut map: HashMap<String, Vec<u64>> = HashMap::new();
        map.insert("idle".into(), vec![now - RATE_LIMIT_WINDOW_MS - 1]);
        map.insert("empty".into(), vec![]);
        map.insert("live".into(), vec![now - RATE_LIMIT_WINDOW_MS - 5, now - 10, now]);
        prune_rate_limits(&mut map, now);
        assert_eq!(map.len(), 1);
        assert_eq!(map["live"], vec![now - 10, now]);
    }

    #[test]
    fn unowned_sweep_never_reaches_a_redeemable_claim() {
        // activate accepts claims with paired_at >= now - PAIR_CODE_TTL_MS;
        // the sweep must only delete strictly older ones.
        const { assert!(UNOWNED_NODE_TTL_MS > PAIR_CODE_TTL_MS) };
    }
}
