//! Billing: Paddle prices/webhooks, tier mapping, Clerk metadata sync.

use crate::*;

// ── Billing handlers ──────────────────────────────────────────────────────────

/// Paddle price IDs, read from the environment.
///
/// `team_annual` has no historical counterpart — the annual Team plan
/// ($2,000/yr) is advertised on /pricing, and without its own price ID an
/// annual subscription would arrive as an unrecognized price.
///
/// `pro` and `business` are retired plans but stay mapped so existing
/// (grandfathered) subscribers keep their tier on subscription.updated events.
pub(crate) struct PaddlePrices {
    pub(crate) pro:            String,
    pub(crate) team10_monthly: String,
    pub(crate) team10_annual:  String,
    pub(crate) team_monthly:   String,
    pub(crate) team_annual:    String,
    pub(crate) business:       String,
}

impl PaddlePrices {
    pub(crate) fn from_env() -> Self {
        let get = |k: &str| std::env::var(k).unwrap_or_default();
        Self {
            pro:            get("PADDLE_PRO_PRICE_ID"),
            team10_monthly: get("PADDLE_TEAM10_PRICE_ID"),
            team10_annual:  get("PADDLE_TEAM10_ANNUAL_PRICE_ID"),
            team_monthly:   get("PADDLE_TEAM_PRICE_ID"),
            team_annual:    get("PADDLE_TEAM_ANNUAL_PRICE_ID"),
            business:       get("PADDLE_BUSINESS_PRICE_ID"),
        }
    }

    /// A price ID is usable only if it is set and not one of the historical
    /// `pri_placeholder_*` defaults.
    pub(crate) fn is_real(id: &str) -> bool {
        !id.is_empty() && !id.starts_with("pri_placeholder")
    }

    /// True when at least one real Team price is configured. Checkout must stay
    /// closed until this holds, or the overlay would bill an unset/placeholder
    /// price.
    pub(crate) fn team_configured(&self) -> bool {
        [&self.team10_monthly, &self.team10_annual, &self.team_monthly, &self.team_annual]
            .iter().any(|id| Self::is_real(id))
    }
}

/// Map a Paddle price ID to a subscription tier.
///
/// Returns `None` when the price is not recognized — and callers MUST NOT
/// substitute a paid tier for `None`.
///
/// This deliberately fails closed. The previous form ended in `else { "pro" }`,
/// so any price ID the environment didn't know about silently granted Pro:
///   - With the env vars unset (`unwrap_or_default()` → ""), EVERY subscription
///     became Pro.
///   - After the three-tier repricing, a new $200 Team price whose ID hadn't
///     been wired to PADDLE_TEAM_PRICE_ID would land a paying customer on Pro —
///     a tier that is no longer sold and that fails `is_team_or_above`, locking
///     them out of chargeback, idle-waste, capacity planning and SLOs: exactly
///     what they had paid for. Silently, with nothing logged.
///
/// Granting nothing is recoverable (the customer says so, and the log names the
/// price); granting the wrong entitlements quietly is not.
pub(crate) fn tier_for_price_id(price_id: &str, prices: &PaddlePrices) -> Option<&'static str> {
    if !PaddlePrices::is_real(price_id) {
        return None;
    }
    // Compare only against configured values, so an unset env var (empty
    // string) can never match anything.
    let matches = |configured: &str| PaddlePrices::is_real(configured) && configured == price_id;

    if matches(&prices.team10_monthly) || matches(&prices.team10_annual) {
        Some("team_10")
    } else if matches(&prices.team_monthly) || matches(&prices.team_annual) {
        Some("team")
    } else if matches(&prices.business) {
        Some("business")
    } else if matches(&prices.pro) {
        Some("pro")
    } else {
        None
    }
}

/// Self-serve checkout is OFF unless explicitly switched on AND a real Team
/// price exists AND Paddle.js can initialise.
///
/// The kill switch is deliberate rather than inferred: a configured price ID
/// looks identical whether it points at the current $200 Team plan or the
/// retired $49 one, so the server cannot tell "correct" from "stale" on its
/// own. PADDLE_CHECKOUT_ENABLED=true is the operator asserting that Paddle
/// now holds products matching the published prices. Until then the frontend
/// shows the contact CTAs on /pricing instead of billing someone the wrong
/// amount.
///
/// Shared by /api/billing/config and the public /api/billing/status so the
/// two can never disagree. `flag` is the raw PADDLE_CHECKOUT_ENABLED value.
pub(crate) fn paddle_checkout_enabled(flag: &str, prices: &PaddlePrices, client_token: &str) -> bool {
    flag.eq_ignore_ascii_case("true")
        && prices.team_configured()
        && !client_token.is_empty()
}

/// GET /api/billing/status — PUBLIC, unauthenticated.
///
/// Lets /pricing decide, for signed-out visitors too, whether the Team card
/// shows a checkout button or the contact CTA. Returns only the boolean:
/// no client token, no price IDs, nothing user-specific. The overlay itself
/// still needs the authenticated /api/billing/config.
pub(crate) async fn handle_billing_status() -> impl IntoResponse {
    let client_token = std::env::var("PADDLE_CLIENT_TOKEN").unwrap_or_default();
    let enabled = paddle_checkout_enabled(
        &std::env::var("PADDLE_CHECKOUT_ENABLED").unwrap_or_default(),
        &PaddlePrices::from_env(),
        &client_token,
    );
    Json(serde_json::json!({ "checkout_enabled": enabled }))
}

/// GET /api/billing/config — returns Paddle client-side config for Paddle.js overlay
pub(crate) async fn handle_billing_config(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid session" }))).into_response(),
    };

    let email: Option<String> = sqlx::query_scalar(
        "SELECT email FROM users WHERE id = $1"
    ).bind(&user_id).fetch_optional(&state.pool).await.ok().flatten();

    let paddle_env = std::env::var("PADDLE_ENV").unwrap_or_else(|_| "sandbox".to_string());
    let paddle_client_token = std::env::var("PADDLE_CLIENT_TOKEN").unwrap_or_else(|_| "".to_string());
    let prices = PaddlePrices::from_env();

    let checkout_enabled = paddle_checkout_enabled(
        &std::env::var("PADDLE_CHECKOUT_ENABLED").unwrap_or_default(),
        &prices,
        &paddle_client_token,
    );

    Json(serde_json::json!({
        "environment": paddle_env,
        "client_token": paddle_client_token,
        "checkout_enabled": checkout_enabled,
        // Only Team is sellable. `pro` and `business` are intentionally absent:
        // existing subscriptions on those prices keep working through the
        // webhook, but nothing may start a new one.
        "prices": {
            "team_10":        prices.team10_monthly,
            "team_10_annual": prices.team10_annual,
            "team":           prices.team_monthly,
            "team_annual":    prices.team_annual,
        },
        "custom_data": { "user_id": user_id },
        "customer_email": email,
    })).into_response()
}

/// Update Clerk publicMetadata.tier so the frontend sees the tier change immediately.
/// Requires CLERK_SECRET_KEY env var (sk_live_... or sk_test_...).
/// Fire-and-forget — failure is logged but doesn't block the webhook response.
pub(crate) fn sync_tier_to_clerk(clerk_id: String, tier: String) {
    let secret = match std::env::var("CLERK_SECRET_KEY") {
        Ok(s) if !s.is_empty() => s,
        _ => { eprintln!("[clerk] CLERK_SECRET_KEY not set — skipping metadata sync"); return; }
    };
    tokio::task::spawn_blocking(move || {
        let url = format!("https://api.clerk.com/v1/users/{clerk_id}/metadata");
        let body = serde_json::json!({
            "public_metadata": { "tier": tier }
        });
        match HTTP_AGENT.request("PATCH", &url)
            .set("Authorization", &format!("Bearer {secret}"))
            .set("Content-Type", "application/json")
            .send_string(&body.to_string())
        {
            Ok(_) => println!("[clerk] synced tier={tier} for {clerk_id}"),
            Err(e) => eprintln!("[clerk] metadata sync failed for {clerk_id}: {e}"),
        }
    });
}

/// Reject Paddle webhooks whose signed timestamp is further than this from
/// now. Paddle's own SDKs use 5 s; this leaves room for clock skew and slow
/// delivery while still bounding how long a captured event can be replayed.
pub(crate) const PADDLE_SIG_TOLERANCE_S: i64 = 300;

/// Verify a `Paddle-Signature` header (`ts=<unix>;h1=<hex>[;h1=<hex>...]`).
///
/// - The HMAC covers `ts:` + the RAW body bytes, as Paddle signs them (not a
///   lossy UTF-8 re-encoding).
/// - `ts` must be within `PADDLE_SIG_TOLERANCE_S` of `now_s`; the timestamp is
///   inside the MAC, so this is what stops a captured event from being
///   replayed later (e.g. an old `activated` after a cancel).
/// - Any `h1` may match: Paddle sends one per active secret during rotation.
pub(crate) fn verify_paddle_signature(secret: &str, header: &str, body: &[u8], now_s: i64) -> bool {
    use hmac::{Hmac, Mac};
    let mut ts: Option<&str> = None;
    let mut sigs: Vec<&str> = Vec::new();
    for part in header.split(';').map(str::trim) {
        if let Some(v) = part.strip_prefix("ts=") { ts = Some(v); }
        else if let Some(v) = part.strip_prefix("h1=") { sigs.push(v); }
    }
    let Some(ts) = ts else { return false };
    let Ok(ts_num) = ts.parse::<i64>() else { return false };
    if (now_s - ts_num).abs() > PADDLE_SIG_TOLERANCE_S || sigs.is_empty() {
        return false;
    }
    let Ok(mut mac) = Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes()) else { return false };
    mac.update(ts.as_bytes());
    mac.update(b":");
    mac.update(body);
    let computed = hex::encode(mac.finalize().into_bytes());
    let mut ok = subtle::Choice::from(0u8);
    for sig in sigs {
        ok |= subtle::ConstantTimeEq::ct_eq(computed.as_bytes(), sig.as_bytes());
    }
    ok.into()
}

/// What a subscription event does to the user's entitlement.
#[derive(Debug, PartialEq)]
pub(crate) enum PaddleAction {
    /// Active or trialing on a recognized price.
    Grant(&'static str),
    /// Active on a price this deployment doesn't know. Link the subscription
    /// for manual repair, never guess a tier (see `tier_for_price_id`).
    LinkOnly,
    /// Paused or canceled — back to community.
    Revoke,
    /// No entitlement change (past_due: Paddle is retrying the payment and
    /// sends `canceled` or `paused` if dunning gives up).
    Keep,
}

pub(crate) fn paddle_action(status: &str, tier: Option<&'static str>) -> PaddleAction {
    match status {
        "active" | "trialing" => tier.map_or(PaddleAction::LinkOnly, PaddleAction::Grant),
        "paused" | "canceled" => PaddleAction::Revoke,
        _ => PaddleAction::Keep,
    }
}

/// Subscription status for an event: `data.status` when present, else implied
/// by the event name.
pub(crate) fn paddle_status<'a>(event_type: &str, data: &'a serde_json::Value) -> &'a str {
    data["status"].as_str().unwrap_or(match event_type {
        "subscription.canceled" => "canceled",
        "subscription.past_due" => "past_due",
        "subscription.paused"   => "paused",
        _                       => "active",
    })
}

/// Tier for a subscription: the first item whose price this deployment maps.
pub(crate) fn paddle_tier(data: &serde_json::Value, prices: &PaddlePrices) -> Option<&'static str> {
    data["items"].as_array()?.iter()
        .filter_map(|item| item["price"]["id"].as_str())
        .find_map(|id| tier_for_price_id(id, prices))
}

/// POST /api/webhooks/paddle — handles Paddle subscription lifecycle events.
/// Signature verification uses HMAC-SHA256 with PADDLE_WEBHOOK_SECRET and
/// fails closed when the secret is unset.
pub(crate) async fn handle_paddle_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let secret = match std::env::var("PADDLE_WEBHOOK_SECRET") {
        Ok(s) if !s.is_empty() => s,
        _ => {
            eprintln!("[billing] PADDLE_WEBHOOK_SECRET not set \u{2014} rejecting webhook");
            return (StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Webhook verification not configured" }))).into_response();
        }
    };
    let sig_header = headers.get("paddle-signature")
        .and_then(|v| v.to_str().ok()).unwrap_or("");
    if !verify_paddle_signature(&secret, sig_header, &body, (now_ms() / 1000) as i64) {
        return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid signature" }))).into_response();
    }

    let event: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => { eprintln!("[billing] webhook JSON parse failed: {e}");
            return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Invalid request body" }))).into_response() },
    };

    let event_type = event["event_type"].as_str().unwrap_or("");
    match event_type {
        "subscription.activated" | "subscription.updated" | "subscription.resumed"
        | "subscription.canceled" | "subscription.past_due" | "subscription.paused" => {
            apply_paddle_subscription_event(&state.pool, event_type, &event).await;
        }
        _ => {
            println!("[billing] paddle: unhandled event_type={event_type}");
        }
    }

    StatusCode::OK.into_response()
}

pub(crate) async fn apply_paddle_subscription_event(
    pool: &sqlx::PgPool,
    event_type: &str,
    event: &serde_json::Value,
) {
    let data            = &event["data"];
    let occurred_at     = event["occurred_at"].as_str();
    let customer_id     = data["customer_id"].as_str().unwrap_or("");
    let subscription_id = data["id"].as_str().unwrap_or("");
    let status          = paddle_status(event_type, data);
    let tier            = paddle_tier(data, &PaddlePrices::from_env());
    let action          = paddle_action(status, tier);

    // Whose subscription: `custom_data.user_id` (set at checkout) when it
    // names a real user, else whoever this subscription or customer is
    // already linked to.
    let custom_uid = data["custom_data"]["user_id"].as_str().unwrap_or("");
    let user_id: Option<String> = sqlx::query_scalar(
        "SELECT id FROM (
             SELECT id, 1 AS pref FROM users WHERE id = $1
             UNION ALL
             SELECT id, 2 FROM users WHERE $2 <> '' AND paddle_subscription_id = $2
             UNION ALL
             SELECT id, 3 FROM users WHERE $3 <> '' AND paddle_customer_id = $3
         ) c ORDER BY pref LIMIT 1"
    ).bind(custom_uid).bind(subscription_id).bind(customer_id)
    .fetch_optional(pool).await.ok().flatten();
    let Some(user_id) = user_id else {
        eprintln!("[billing] paddle: {event_type} status={status} for unknown user \
                   (custom user_id={custom_uid:?}, customer={customer_id}, sub={subscription_id}) — ignored");
        return;
    };

    // Every write below is conditional on this event not being older than
    // the last one applied (`paddle_event_at`). A missing `occurred_at`
    // applies unconditionally, as before.
    const NOT_STALE: &str =
        "($1::timestamptz IS NULL OR paddle_event_at IS NULL OR paddle_event_at <= $1::timestamptz)";
    let applied_tier: Option<&str> = match action {
        PaddleAction::Keep => {
            println!("[billing] paddle: {user_id} {event_type} status={status} \u{2014} entitlement unchanged");
            return;
        }
        PaddleAction::LinkOnly => {
            eprintln!(
                "[billing] paddle: UNRECOGNIZED price on {event_type} (user_id={user_id}, \
                 sub={subscription_id}) — tier NOT changed. Wire the price to a \
                 PADDLE_TEAM*_PRICE_ID variable and re-send the event, or set the tier manually."
            );
            let _ = sqlx::query(&format!(
                "UPDATE users SET paddle_customer_id = $2, paddle_subscription_id = $3
                 WHERE id = $4 AND {NOT_STALE}"
            )).bind(occurred_at).bind(customer_id).bind(subscription_id).bind(&user_id)
            .execute(pool).await;
            return;
        }
        PaddleAction::Grant(tier) => {
            let r = sqlx::query(&format!(
                "UPDATE users SET subscription_tier = $5, paddle_customer_id = $2,
                        paddle_subscription_id = $3,
                        paddle_event_at = COALESCE($1::timestamptz, paddle_event_at)
                 WHERE id = $4 AND {NOT_STALE}"
            )).bind(occurred_at).bind(customer_id).bind(subscription_id).bind(&user_id).bind(tier)
            .execute(pool).await;
            matches!(r, Ok(ref d) if d.rows_affected() > 0).then_some(tier)
        }
        PaddleAction::Revoke => {
            // Only the subscription the user is currently on can revoke: a
            // late cancel for a replaced subscription must not wipe the new one.
            let r = sqlx::query(&format!(
                "UPDATE users SET subscription_tier = 'community', paddle_subscription_id = NULL,
                        paddle_event_at = COALESCE($1::timestamptz, paddle_event_at)
                 WHERE id = $2 AND (paddle_subscription_id IS NULL OR paddle_subscription_id = $3)
                   AND {NOT_STALE}"
            )).bind(occurred_at).bind(&user_id).bind(subscription_id)
            .execute(pool).await;
            matches!(r, Ok(ref d) if d.rows_affected() > 0).then_some("community")
        }
    };
    let Some(tier) = applied_tier else {
        println!("[billing] paddle: {user_id} {event_type} occurred_at={occurred_at:?} \
                  is stale or for a replaced subscription \u{2014} skipped");
        return;
    };

    // Org the user owns shares the entitlement (shared fleet access).
    let _ = sqlx::query("UPDATE organizations SET subscription_tier = $1 WHERE created_by = $2")
        .bind(tier).bind(&user_id).execute(pool).await;
    println!("[billing] paddle: {user_id} \u{2192} {tier} ({event_type}, status={status}, sub={subscription_id})");

    // Sync tier to Clerk so the frontend sees the change immediately.
    let clerk_id: Option<String> = sqlx::query_scalar("SELECT clerk_id FROM users WHERE id = $1")
        .bind(&user_id).fetch_optional(pool).await.ok().flatten();
    match clerk_id {
        Some(cid) => sync_tier_to_clerk(cid, tier.to_string()),
        None => eprintln!("[billing] no clerk_id found for user_id={user_id} — cannot sync tier to Clerk"),
    }
    if tier == "community" {
        forward_to_taarn("subscription_canceled", serde_json::json!({
            "customer_id": customer_id, "user_id": &user_id,
        }));
    } else {
        forward_to_taarn("subscription_activated", serde_json::json!({
            "user_id": &user_id, "tier": tier,
            "subscription_id": subscription_id, "customer_id": customer_id,
        }));
    }
}

#[cfg(test)]
mod paddle_price_tests {
    use super::*;

    fn prices() -> PaddlePrices {
        PaddlePrices {
            pro:            "pri_pro_29".into(),
            team10_monthly: "pri_team10_99".into(),
            team10_annual:  "pri_team10_990".into(),
            team_monthly:   "pri_team_200".into(),
            team_annual:    "pri_team_2000".into(),
            business:       "pri_business_499".into(),
        }
    }

    #[test]
    fn maps_each_configured_price_to_its_tier() {
        let p = prices();
        assert_eq!(tier_for_price_id("pri_team10_99",    &p), Some("team_10"));
        assert_eq!(tier_for_price_id("pri_team10_990",   &p), Some("team_10"));
        assert_eq!(tier_for_price_id("pri_team_200",     &p), Some("team"));
        assert_eq!(tier_for_price_id("pri_team_2000",    &p), Some("team"));
        assert_eq!(tier_for_price_id("pri_business_499", &p), Some("business"));
        assert_eq!(tier_for_price_id("pri_pro_29",       &p), Some("pro"));
    }

    #[test]
    fn unknown_price_grants_nothing() {
        // The regression this guards: an unrecognized price used to fall through
        // to "pro", so a paying Team customer silently landed on a tier that
        // fails is_team_or_above.
        assert_eq!(tier_for_price_id("pri_brand_new_price", &prices()), None);
    }

    #[test]
    fn empty_price_id_never_matches_an_unset_env_var() {
        // Both sides empty must NOT compare equal — with the env vars unset this
        // was how every subscription became Pro.
        let unset = PaddlePrices {
            pro: String::new(), team10_monthly: String::new(), team10_annual: String::new(),
            team_monthly: String::new(), team_annual: String::new(), business: String::new(),
        };
        assert_eq!(tier_for_price_id("", &unset), None);
        assert_eq!(tier_for_price_id("pri_team_200", &unset), None);
        assert_eq!(tier_for_price_id("", &prices()), None);
    }

    #[test]
    fn placeholder_price_ids_are_not_real() {
        let placeholders = PaddlePrices {
            pro: "pri_placeholder_pro".into(),
            team10_monthly: String::new(),
            team10_annual: String::new(),
            team_monthly: "pri_placeholder_team".into(),
            team_annual: String::new(),
            business: "pri_placeholder_business".into(),
        };
        assert_eq!(tier_for_price_id("pri_placeholder_team", &placeholders), None);
        assert!(!placeholders.team_configured());
    }

    #[test]
    fn team_configured_needs_one_real_team_price() {
        let mut p = prices();
        assert!(p.team_configured());

        p.team_annual = String::new();
        assert!(p.team_configured(), "monthly alone is enough");

        p.team_monthly = String::new();
        assert!(p.team_configured(), "the 10-node prices still count as Team");

        p.team10_monthly = String::new();
        p.team10_annual  = String::new();
        assert!(!p.team_configured(), "no team price at all");

        p.team_annual = "pri_team_2000".into();
        assert!(p.team_configured(), "annual alone is enough");
    }

    #[test]
    fn checkout_needs_flag_team_price_and_client_token() {
        let p = prices();
        assert!(paddle_checkout_enabled("true", &p, "tok"));
        assert!(paddle_checkout_enabled("TRUE", &p, "tok"), "flag is case-insensitive");
        assert!(!paddle_checkout_enabled("", &p, "tok"), "flag unset");
        assert!(!paddle_checkout_enabled("1", &p, "tok"), "only \"true\" enables");
        assert!(!paddle_checkout_enabled("true", &p, ""), "no client token");

        let none = PaddlePrices {
            pro: "pri_pro_29".into(), team10_monthly: String::new(), team10_annual: String::new(),
            team_monthly: "pri_placeholder_team".into(), team_annual: String::new(),
            business: "pri_business_499".into(),
        };
        assert!(!paddle_checkout_enabled("true", &none, "tok"), "no real Team price");
    }

    #[test]
    fn both_team_sizes_are_team_for_feature_gates() {
        // The size changes the node cap, never the feature set.
        for t in ["team_10", "team"] {
            assert!(is_team_or_above(t), "{t} must pass Team gates");
            assert!(is_pro_or_above(t),  "{t} must pass Pro gates");
            assert!(!is_business_or_above(t), "{t} is not Business");
        }
    }

    #[test]
    fn node_limit_ladder() {
        assert_eq!(node_limit_for_tier("community",  false), 3);
        assert_eq!(node_limit_for_tier("pro",        false), 10);
        assert_eq!(node_limit_for_tier("team_10",    false), 10);
        assert_eq!(node_limit_for_tier("team",       false), 25);
        assert_eq!(node_limit_for_tier("business",   false), 100);
        assert_eq!(node_limit_for_tier("enterprise", false), usize::MAX);
        // Legacy users.is_pro / dev-account bypass lifts Community to the Pro cap
        // and never lowers a paid tier.
        assert_eq!(node_limit_for_tier("community", true), 10);
        assert_eq!(node_limit_for_tier("team",      true), 25);
        // Unknown strings fail closed to the free cap.
        assert_eq!(node_limit_for_tier("gold", false), 3);
    }

    #[test]
    fn plan_names_distinguish_the_two_team_sizes() {
        assert_eq!(plan_name_for_tier("team_10"), "Team (10 nodes)");
        assert_eq!(plan_name_for_tier("team"),    "Team (25 nodes)");
        assert_eq!(plan_name_for_tier("nope"),    "Community");
    }

    #[test]
    fn business_price_still_maps_so_existing_subscribers_are_grandfathered() {
        // Business is not sold any more, but existing subscriptions stay on
        // their original Paddle price. Dropping PADDLE_BUSINESS_PRICE_ID would
        // reclassify those customers on their next subscription.updated event.
        assert_eq!(tier_for_price_id("pri_business_499", &prices()), Some("business"));
    }
}
