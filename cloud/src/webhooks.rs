//! Threshold webhooks: subscription CRUD/test and the per-telemetry-tick evaluator.

use crate::*;

// ── Threshold Webhooks (Pro+) ────────────────────────────────────────────────
//
// CRUD + test endpoints for user-registered webhook subscriptions. The
// evaluator that fires actual webhooks runs inside the telemetry-push
// path so every SSE update is checked against subscriptions in-line.

pub(crate) const SUPPORTED_WEBHOOK_EVENTS: &[&str] = &[
    "thermal_state_changed",
    "inference_state_changed",
    "wes_below",
    "wes_above",
];

#[derive(serde::Deserialize)]
pub(crate) struct CreateWebhookBody {
    pub(crate) url:        String,
    pub(crate) event_type: String,
    /// Optional — when None, fires for any node owned by the user.
    pub(crate) node_id:    Option<String>,
    /// Optional tag scope — fires only for nodes bearing this tag.
    #[serde(default)]
    pub(crate) tag:        Option<String>,
    /// Required for `wes_below` / `wes_above`; ignored for state-changed types.
    pub(crate) threshold:  Option<f32>,
    /// Min seconds between fires for the same (subscription, node) pair.
    /// Defaults to 60 if omitted.
    pub(crate) cooldown_s: Option<i32>,
}

/// POST /api/v1/webhooks (Pro+) — register a new subscription.
pub(crate) async fn handle_webhook_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateWebhookBody>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let (user_id, org_id, role) = match require_user_org_role(&token, &state.pool, &clerk_keys).await {
        Some(v) => v,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };
    if !role.can_mutate() { return role_forbidden("member"); }
    // Org-aware: org members are entitled by the org subscription.
    let tier = resolve_tier(&user_id, &org_id, &state.pool).await;
    if !is_pro_or_above(&tier) {
        return upgrade_required("Threshold Webhooks", UpgradePlan::Team);
    }

    // Validate body.
    if let Err(e) = resolve_outbound(&body.url).await {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": e }))).into_response();
    }
    if !SUPPORTED_WEBHOOK_EVENTS.contains(&body.event_type.as_str()) {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("Unsupported event_type. Supported: {}", SUPPORTED_WEBHOOK_EVENTS.join(", "))
            }))).into_response();
    }
    if matches!(body.event_type.as_str(), "wes_below" | "wes_above") && body.threshold.is_none() {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "threshold required for wes_below / wes_above" }))).into_response();
    }
    let cooldown_s = body.cooldown_s.unwrap_or(60).max(10);

    // If a node_id is supplied, verify the user owns it.
    if let Some(ref nid) = body.node_id {
        let owns = node_in_tenant(nid, &user_id, &org_id, &state.pool).await;
        if !owns {
            return (StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "Node not found in your fleet" }))).into_response();
        }
    }

    if let Some(ref t) = body.tag
        && !valid_scope_tag(t) {
            return (StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "tag must be 1-64 chars: letters, digits, : - _ ." }))).into_response();
        }

    let id = uuid::Uuid::new_v4().to_string();
    // 32-byte HMAC secret, hex-encoded → 64 chars. Returned ONCE on creation.
    let secret_bytes: [u8; 32] = std::array::from_fn(|_| rand::random());
    let secret = hex::encode(secret_bytes);
    let tenant_id: String = tenant_scope(&user_id, &org_id).1.to_string();

    let _ = sqlx::query(
        "INSERT INTO webhook_subscriptions
         (id, user_id, tenant_id, url, secret, event_type, node_id, threshold, cooldown_s, enabled, tag)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10)"
    )
    .bind(&id).bind(&user_id).bind(&tenant_id)
    .bind(&body.url).bind(&secret)
    .bind(&body.event_type).bind(&body.node_id)
    .bind(body.threshold).bind(cooldown_s).bind(&body.tag)
    .execute(&state.pool).await;

    audit(&state.pool, &user_id, &org_id, "webhook.created", &id,
        serde_json::json!({ "event_type": &body.event_type, "url": &body.url }));

    Json(serde_json::json!({
        "id":         id,
        "url":        body.url,
        "event_type": body.event_type,
        "node_id":    body.node_id,
        "tag":        body.tag,
        "threshold":  body.threshold,
        "cooldown_s": cooldown_s,
        "secret":     secret,  // shown ONCE — receiver uses for HMAC verification
        "enabled":    true,
    })).into_response()
}

/// GET /api/v1/webhooks (Pro+) — list user's subscriptions (no secrets).
pub(crate) async fn handle_webhook_list(
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
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let rows: Vec<(String, String, String, Option<String>, Option<f32>, i32, bool, Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT id, url, event_type, node_id, threshold, cooldown_s, enabled, last_fired_ms, tag
         FROM webhook_subscriptions
         WHERE user_id = $1
         ORDER BY created_at DESC"
    ).bind(&user_id).fetch_all(&state.pool).await.unwrap_or_default();

    let subs: Vec<serde_json::Value> = rows.into_iter().map(|(id, url, event_type, node_id, threshold, cooldown_s, enabled, last_fired_ms, tag)| {
        serde_json::json!({
            "id":            id,
            "url":           url,
            "event_type":    event_type,
            "node_id":       node_id,
            "tag":           tag,
            "threshold":     threshold,
            "cooldown_s":    cooldown_s,
            "enabled":       enabled,
            "last_fired_ms": last_fired_ms,
        })
    }).collect();

    Json(serde_json::json!({ "subscriptions": subs })).into_response()
}

/// DELETE /api/v1/webhooks/:id (Pro+).
pub(crate) async fn handle_webhook_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let (user_id, _org_id, role) = match require_user_org_role(&token, &state.pool, &clerk_keys).await {
        Some(v) => v,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };
    if !role.can_mutate() { return role_forbidden("member"); }

    let res = sqlx::query(
        "DELETE FROM webhook_subscriptions WHERE id = $1 AND user_id = $2"
    ).bind(&id).bind(&user_id).execute(&state.pool).await;
    match res {
        Ok(r) if r.rows_affected() > 0 => {
            // Drop state rows alongside.
            let _ = sqlx::query("DELETE FROM webhook_state WHERE subscription_id = $1")
                .bind(&id).execute(&state.pool).await;
            Json(serde_json::json!({ "deleted": id })).into_response()
        }
        _ => (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Subscription not found" }))).into_response(),
    }
}

/// POST /api/v1/webhooks/:id/test — fire a synthetic payload to test the URL
/// without waiting for a real condition to trigger.
pub(crate) async fn handle_webhook_test(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let (user_id, _org_id, role) = match require_user_org_role(&token, &state.pool, &clerk_keys).await {
        Some(v) => v,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };
    if !role.can_mutate() { return role_forbidden("member"); }

    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT url, secret, event_type FROM webhook_subscriptions
         WHERE id = $1 AND user_id = $2"
    ).bind(&id).bind(&user_id).fetch_optional(&state.pool).await.unwrap_or(None);
    let (url, secret, event_type) = match row {
        Some(r) => r,
        None => return (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Subscription not found" }))).into_response(),
    };

    let payload = serde_json::json!({
        "event_type":     event_type,
        "test":           true,
        "node_id":        "WK-TEST",
        "node_hostname":  "test-node",
        "ts_ms":          now_ms(),
        "previous_state": "Normal",
        "current_state":  "Fair",
        "context":        { "note": "This is a synthetic test payload. Verify HMAC, then disregard." }
    });

    match deliver_webhook(&url, &secret, &payload).await {
        Ok(status) => Json(serde_json::json!({
            "delivered": true,
            "status":    status,
        })).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "error": format!("Delivery failed: {e}") }))).into_response(),
    }
}

// ── Threshold Webhooks — per-telemetry-tick evaluator ───────────────────────
//
// Runs on every /api/telemetry POST.  Loads enabled subscriptions for this
// tenant and node, compares against the previous-tick state stored in
// `webhook_state`, fires the webhook when a transition or crossing matches.
//
// State semantics:
//   thermal_state_changed   — fires when prev_value (string) != current
//   inference_state_changed — same, on inference_state field
//   wes_below               — fires when prev_value_num was >= threshold
//                             and current is < threshold (crossing in)
//   wes_above               — fires when prev_value_num was <= threshold
//                             and current is > threshold (crossing out)
//
// Cooldown is enforced via last_fired_ms in webhook_state — even if a
// crossing happens repeatedly (flapping), no fire within cooldown_s.

pub(crate) async fn evaluate_webhooks(
    tenant_id: &str,
    node_id:   &str,
    metrics:   &MetricsPayload,
    pool:      &sqlx::PgPool,
) {
    // Pull all enabled subscriptions for this tenant that target either
    // any node or this specific node.
    let subs: Vec<(String, String, String, String, Option<String>, Option<f32>, i32, Option<i64>)> =
        sqlx::query_as(
            "SELECT id, url, secret, event_type, node_id, threshold, cooldown_s, last_fired_ms
             FROM webhook_subscriptions ws
             WHERE tenant_id = $1 AND enabled = true
               AND (node_id IS NULL OR node_id = $2)
               AND (ws.tag IS NULL OR EXISTS(
                     SELECT 1 FROM nodes n WHERE n.wk_id = $2
                       AND (',' || replace(lower(COALESCE(n.tags,'')), ' ', '') || ',')
                           LIKE ('%,' || replace(lower(ws.tag), ' ', '') || ',%')))
               AND NOT EXISTS(
                     SELECT 1 FROM alert_silences s
                     WHERE s.tenant_id = $1
                       AND $3 >= s.starts_at AND $3 < s.ends_at
                       AND (s.node_id IS NULL OR s.node_id = $2)
                       AND (s.event_type IS NULL OR s.event_type = ws.event_type)
                       AND (s.tag IS NULL OR EXISTS(
                             SELECT 1 FROM nodes n3 WHERE n3.wk_id = $2
                               AND (',' || replace(lower(COALESCE(n3.tags,'')), ' ', '') || ',')
                                   LIKE ('%,' || replace(lower(s.tag), ' ', '') || ',%'))))"
        ).bind(tenant_id).bind(node_id).bind(now_ms() as i64).fetch_all(pool).await.unwrap_or_default();

    if subs.is_empty() { return; }

    let now = now_ms() as i64;
    let cur_thermal   = metrics.thermal_state.clone().unwrap_or_else(|| "Normal".into());
    let cur_inference = metrics.inference_state.clone().unwrap_or_else(|| "idle".into());
    // Compute current WES the same way the agent + frontend do:
    //   tok/s ÷ (watts × thermal_penalty)
    let cur_wes: Option<f32> = {
        let tps = metrics.ollama_tokens_per_second.or(metrics.vllm_tokens_per_sec)
            .filter(|v| *v > 0.0);
        let watts = metrics.apple_soc_power_w
            .or(metrics.nvidia_power_draw_w)
            .or(metrics.cpu_power_w)
            .filter(|v| *v > 0.0);
        match (tps, watts) {
            (Some(t), Some(w)) => {
                let penalty: f32 = match cur_thermal.to_lowercase().as_str() {
                    "fair" => 1.25, "serious" => 1.75, "critical" => 2.0, _ => 1.0,
                };
                Some(t / (w * penalty))
            }
            _ => None,
        }
    };

    for (sub_id, url, secret, event_type, _sub_node, threshold, cooldown_s, _last_fired) in subs {
        // Read prev state for THIS (sub, node) pair.
        let prev: Option<(Option<String>, Option<f32>, Option<i64>)> = sqlx::query_as(
            "SELECT prev_value, prev_value_num, last_fired_ms
             FROM webhook_state
             WHERE subscription_id = $1 AND node_id = $2"
        ).bind(&sub_id).bind(node_id).fetch_optional(pool).await.unwrap_or(None);
        let (prev_value, prev_value_num, last_fired_ms) = prev.unwrap_or((None, None, None));

        // Cooldown check — same condition won't refire within cooldown_s.
        if let Some(lf) = last_fired_ms
            && now.saturating_sub(lf) < (cooldown_s as i64) * 1_000 {
                // Still update prev_value so we don't miss an actual crossing
                // when cooldown ends, but skip the fire.
                let _ = update_webhook_state_no_fire(&sub_id, node_id, &event_type, &cur_thermal, &cur_inference, cur_wes, pool).await;
                continue;
            }

        // Detect the firing condition per event type.
        let (fired, payload) = match event_type.as_str() {
            "thermal_state_changed" => {
                let prev_t = prev_value.as_deref().unwrap_or(&cur_thermal);
                if prev_t != cur_thermal {
                    (true, build_state_payload(&event_type, node_id, metrics, prev_t, &cur_thermal))
                } else { (false, serde_json::Value::Null) }
            }
            "inference_state_changed" => {
                let prev_i = prev_value.as_deref().unwrap_or(&cur_inference);
                if prev_i != cur_inference {
                    (true, build_state_payload(&event_type, node_id, metrics, prev_i, &cur_inference))
                } else { (false, serde_json::Value::Null) }
            }
            "wes_below" => {
                let thr = threshold.unwrap_or(0.0);
                match (prev_value_num, cur_wes) {
                    (Some(p), Some(c)) if p >= thr && c < thr => (true,
                        build_threshold_payload(&event_type, node_id, metrics, p as f64, c as f64, thr as f64)),
                    _ => (false, serde_json::Value::Null),
                }
            }
            "wes_above" => {
                let thr = threshold.unwrap_or(0.0);
                match (prev_value_num, cur_wes) {
                    (Some(p), Some(c)) if p <= thr && c > thr => (true,
                        build_threshold_payload(&event_type, node_id, metrics, p as f64, c as f64, thr as f64)),
                    _ => (false, serde_json::Value::Null),
                }
            }
            _ => (false, serde_json::Value::Null),
        };

        // Update state row regardless of fire — keeps prev_value fresh.
        let _ = update_webhook_state_no_fire(&sub_id, node_id, &event_type, &cur_thermal, &cur_inference, cur_wes, pool).await;

        if fired {
            let url_clone    = url.clone();
            let secret_clone = secret.clone();
            let sub_id_clone = sub_id.clone();
            let node_id_clone = node_id.to_string();
            let pool_clone   = pool.clone();
            // Fire-and-forget delivery so the telemetry-push response isn't
            // blocked by a slow webhook receiver.
            tokio::spawn(async move {
                match deliver_webhook(&url_clone, &secret_clone, &payload).await {
                    Ok(s) => {
                        let _ = sqlx::query(
                            "UPDATE webhook_state SET last_fired_ms = $1
                             WHERE subscription_id = $2 AND node_id = $3"
                        ).bind(now).bind(&sub_id_clone).bind(&node_id_clone)
                          .execute(&pool_clone).await;
                        let _ = sqlx::query(
                            "UPDATE webhook_subscriptions SET last_fired_ms = $1 WHERE id = $2"
                        ).bind(now).bind(&sub_id_clone).execute(&pool_clone).await;
                        if !(200..300).contains(&s) {
                            eprintln!("[webhook] {sub_id_clone} → {url_clone}: HTTP {s}");
                        }
                    }
                    Err(e) => eprintln!("[webhook] {sub_id_clone} delivery error: {e}"),
                }
            });
        }
    }
}

pub(crate) fn build_state_payload(
    event_type: &str,
    node_id: &str,
    metrics: &MetricsPayload,
    previous: &str,
    current: &str,
) -> serde_json::Value {
    serde_json::json!({
        "event_type":     event_type,
        "node_id":        node_id,
        "node_hostname":  metrics.hostname,
        "ts_ms":          now_ms(),
        "previous_state": previous,
        "current_state":  current,
        "context": {
            "tok_s":          metrics.ollama_tokens_per_second.or(metrics.vllm_tokens_per_sec),
            "watts":          metrics.apple_soc_power_w.or(metrics.nvidia_power_draw_w),
            "thermal_state":  metrics.thermal_state,
            "inference_state": metrics.inference_state,
            "active_model":   metrics.ollama_active_model.clone().or(metrics.vllm_model_name.clone()),
        }
    })
}

pub(crate) fn build_threshold_payload(
    event_type: &str,
    node_id: &str,
    metrics: &MetricsPayload,
    previous: f64,
    current: f64,
    threshold: f64,
) -> serde_json::Value {
    serde_json::json!({
        "event_type":     event_type,
        "node_id":        node_id,
        "node_hostname":  metrics.hostname,
        "ts_ms":          now_ms(),
        "previous_value": previous,
        "current_value":  current,
        "threshold":      threshold,
        "context": {
            "tok_s":          metrics.ollama_tokens_per_second.or(metrics.vllm_tokens_per_sec),
            "watts":          metrics.apple_soc_power_w.or(metrics.nvidia_power_draw_w),
            "thermal_state":  metrics.thermal_state,
            "inference_state": metrics.inference_state,
            "active_model":   metrics.ollama_active_model.clone().or(metrics.vllm_model_name.clone()),
        }
    })
}

pub(crate) async fn update_webhook_state_no_fire(
    sub_id: &str,
    node_id: &str,
    event_type: &str,
    cur_thermal: &str,
    cur_inference: &str,
    cur_wes: Option<f32>,
    pool: &sqlx::PgPool,
) -> Result<(), sqlx::Error> {
    let (prev_value, prev_value_num) = match event_type {
        "thermal_state_changed"   => (Some(cur_thermal.to_string()),   None),
        "inference_state_changed" => (Some(cur_inference.to_string()), None),
        "wes_below" | "wes_above" => (None, cur_wes),
        _ => (None, None),
    };
    sqlx::query(
        "INSERT INTO webhook_state (subscription_id, node_id, prev_value, prev_value_num)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (subscription_id, node_id) DO UPDATE SET
           prev_value     = EXCLUDED.prev_value,
           prev_value_num = EXCLUDED.prev_value_num"
    ).bind(sub_id).bind(node_id).bind(&prev_value).bind(prev_value_num)
      .execute(pool).await?;
    Ok(())
}
