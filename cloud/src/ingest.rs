//! Telemetry ingest, node pairing (claim/activate), observations, and the batched Postgres writers.

use crate::*;

/// POST /api/pair/claim
pub(crate) async fn handle_claim(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ClaimRequest>,
) -> impl IntoResponse {
    if body.code.len() != 6 || !body.code.chars().all(|c| c.is_ascii_digit()) {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "code must be exactly 6 ASCII digits" }))).into_response();
    }

    let ip = client_ip(&headers);
    if !check_auth_rate_limit(&ip, &state.auth_rate_limits) {
        return (StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({ "error": "Too many attempts. Try again in a minute." }))).into_response();
    }
    if body.node_id.is_empty() || body.fleet_url.is_empty() {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "node_id and fleet_url are required" }))).into_response();
    }

    let existing_owner = sqlx::query_scalar::<_, Option<String>>(
        "SELECT user_id FROM nodes WHERE wk_id = $1"
    ).bind(&body.node_id).fetch_optional(&state.pool).await.unwrap_or(None);
    if matches!(existing_owner, Some(Some(_))) {
        return (StatusCode::CONFLICT, Json(serde_json::json!({
            "error": "This node is already paired to an account. Remove it from that fleet before re-pairing."
        }))).into_response();
    }

    let fresh_after = now_ms().saturating_sub(PAIR_CODE_TTL_MS) as i64;
    let code_taken: bool = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM nodes
         WHERE code = $1 AND user_id IS NULL AND paired_at >= $2 AND wk_id <> $3)"
    ).bind(&body.code).bind(fresh_after).bind(&body.node_id)
    .fetch_one(&state.pool).await.unwrap_or(true);
    if code_taken {
        return (StatusCode::CONFLICT, Json(serde_json::json!({
            "error": "Pairing code collision. Restart pairing to get a new code."
        }))).into_response();
    }

    let token   = mint_node_token(&body.node_id);
    let ts      = now_ms() as i64;
    let node_id = body.node_id.clone();

    let _ = sqlx::query(
        "INSERT INTO nodes (wk_id, fleet_url, session_token, code, paired_at, last_seen)
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT(wk_id) DO UPDATE SET
           fleet_url     = EXCLUDED.fleet_url,
           session_token = EXCLUDED.session_token,
           code          = EXCLUDED.code,
           -- Refresh on re-claim so the activate-side code TTL measures the
           -- LATEST code issuance, not the first-ever claim. Only unowned
           -- nodes reach this path (owned ones are rejected above).
           paired_at     = EXCLUDED.paired_at,
           last_seen     = EXCLUDED.last_seen"
    ).bind(&node_id).bind(&body.fleet_url).bind(hash_node_token(&token)).bind(&body.code).bind(ts)
    .execute(&state.pool).await;

    state.metrics.write().unwrap()
        .entry(node_id.clone())
        .or_insert(MetricsEntry { last_seen_ms: now_ms(), metrics: None, snapshot_saved_ms: 0 });

    forward_to_taarn("node_paired", serde_json::json!({
        "node_id": &node_id, "fleet_url": &body.fleet_url, "ts": ts,
    }));

    (StatusCode::OK, Json(ClaimResponse { session_token: token, node_id })).into_response()
}

pub(crate) fn forward_to_taarn(event_type: &str, payload: serde_json::Value) {
    let url = match std::env::var("TAARN_WEBHOOK_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => return,
    };
    let secret = std::env::var("TAARN_EVENT_SECRET").unwrap_or_default();
    let body = serde_json::json!({ "type": event_type, "payload": payload });

    tokio::task::spawn_blocking(move || {
        let result = HTTP_AGENT.post(&url)
            .set("Authorization", &format!("Bearer {secret}"))
            .set("Content-Type", "application/json")
            .send_string(&body.to_string());
        match result {
            Ok(_) => println!("[taarn] forwarded {}", body["type"]),
            Err(e) => eprintln!("[taarn] forward failed: {e}"),
        }
    });
}

#[derive(Deserialize)]
pub(crate) struct InstallEvent {
    pub(crate) os: String,
    pub(crate) arch: String,
    #[serde(default)]
    pub(crate) version: String,
    #[serde(default)]
    pub(crate) nvidia: bool,
    #[serde(default)]
    pub(crate) upgrade: bool,
}

/// POST /api/telemetry/install — anonymous install ping from install.sh.
/// No auth required. Rate-limited by IP (handled at infra layer).
/// Records the install and optionally forwards to Taarn.
pub(crate) async fn handle_install_telemetry(
    State(state): State<AppState>,
    Json(body): Json<InstallEvent>,
) -> StatusCode {
    let ts = now_ms() as i64;
    let os = &body.os;
    let arch = &body.arch;
    let version = if body.version.is_empty() { "unknown" } else { &body.version };
    let nvidia = body.nvidia;
    let upgrade = body.upgrade;

    let _ = sqlx::query(
        "INSERT INTO installs (ts, os, arch, version, nvidia, upgrade) VALUES (to_timestamp($1::float8 / 1000.0), $2, $3, $4, $5, $6)"
    ).bind(ts).bind(os).bind(arch).bind(version).bind(nvidia).bind(upgrade)
    .execute(&state.pool).await;

    let kind = if upgrade { "install_upgrade" } else { "install_complete" };
    println!("[install] {kind}: {os}/{arch} v{version} nvidia={nvidia}");

    forward_to_taarn(kind, serde_json::json!({
        "os": os, "arch": arch, "version": version,
        "nvidia": nvidia, "upgrade": upgrade, "ts": ts,
    }));

    StatusCode::OK
}

#[derive(Deserialize)]
pub(crate) struct EventPollQuery {
    /// Unix ms cursor — return events after this timestamp. Defaults to last 5 minutes.
    pub(crate) since_ms: Option<i64>,
    /// Max events to return. Defaults to 100, max 500.
    pub(crate) limit: Option<i64>,
}

/// GET /api/events/poll — Taarn polls this for new install/pairing/subscription events.
/// Auth: Bearer {TAARN_EVENT_SECRET}. Returns JSON array of events sorted by timestamp.
pub(crate) async fn handle_event_poll(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<EventPollQuery>,
) -> impl IntoResponse {
    let expected = std::env::var("TAARN_EVENT_SECRET").unwrap_or_default();
    if expected.is_empty() {
        return (StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "Event polling not configured" }))).into_response();
    }
    let bearer = headers.get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "));
    let auth_ok: bool = bearer.is_some_and(|b|
        subtle::ConstantTimeEq::ct_eq(b.as_bytes(), expected.as_bytes()).into()
    );
    if !auth_ok {
        return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or missing authorization" }))).into_response();
    }

    let since_ms = q.since_ms.unwrap_or_else(|| now_ms() as i64 - 5 * 60 * 1000);
    let limit = q.limit.unwrap_or(100).min(500);

    let installs: Vec<(i64, String, String, String, bool, bool)> = sqlx::query_as(
        "SELECT EXTRACT(EPOCH FROM ts)::bigint * 1000, os, arch, version, nvidia, upgrade
         FROM installs WHERE ts > to_timestamp($1::float8 / 1000.0) ORDER BY ts LIMIT $2"
    ).bind(since_ms).bind(limit).fetch_all(&state.pool).await.unwrap_or_default();

    let pairings: Vec<(String, i64)> = sqlx::query_as(
        "SELECT wk_id, paired_at FROM nodes WHERE paired_at > $1 ORDER BY paired_at LIMIT $2"
    ).bind(since_ms).bind(limit).fetch_all(&state.pool).await.unwrap_or_default();

    let mut events: Vec<serde_json::Value> = Vec::new();

    for (ts, os, arch, version, nvidia, upgrade) in &installs {
        let kind = if *upgrade { "install_upgrade" } else { "install_complete" };
        events.push(serde_json::json!({
            "type": kind, "ts": ts,
            "payload": { "os": os, "arch": arch, "version": version, "nvidia": nvidia }
        }));
    }
    for (node_id, paired_at) in &pairings {
        events.push(serde_json::json!({
            "type": "node_paired", "ts": paired_at,
            "payload": { "node_id": node_id }
        }));
    }

    events.sort_by_key(|e| e["ts"].as_i64().unwrap_or(0));

    Json(serde_json::json!({
        "events": events,
        "cursor_ms": events.last().and_then(|e| e["ts"].as_i64()).unwrap_or(since_ms),
    })).into_response()
}

/// Minimum spacing between `nodes.last_telemetry_json` writes per node.
pub(crate) const SNAPSHOT_PERSIST_MS: u64 = 60_000;

/// True when a node's persisted snapshot is due for a refresh. `saved_ms` 0
/// means never written this process lifetime, so the first push writes.
pub(crate) fn snapshot_persist_due(saved_ms: u64, now: u64) -> bool {
    saved_ms == 0 || now.saturating_sub(saved_ms) >= SNAPSHOT_PERSIST_MS
}

/// POST /api/telemetry
pub(crate) async fn handle_telemetry(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<MetricsPayload>,
) -> axum::response::Response {
    let node_id       = payload.node_id.clone();
    let node_hostname = payload.hostname.clone();
    let ts            = now_ms();

    let bearer = headers.get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "));
    let bearer = match bearer {
        Some(t) => t.to_string(),
        None => return StatusCode::UNAUTHORIZED.into_response(),
    };

    type NodeRow = (String, Option<String>, Option<String>, Option<String>, String);
    let node_row: Option<NodeRow> = sqlx::query_as(
        "SELECT n.session_token, n.desired_profile,
                COALESCE(n.org_id, n.user_id), n.user_id,
                COALESCE(o.subscription_tier, u.subscription_tier, 'community')
         FROM nodes n
         LEFT JOIN users u         ON u.id = n.user_id
         LEFT JOIN organizations o ON o.org_id = n.org_id
         WHERE n.wk_id = $1"
    ).bind(&node_id).fetch_optional(&state.pool).await.unwrap_or(None);

    let (desired_profile, tenant, tier) = match node_row {
        None => return StatusCode::GONE.into_response(),
        Some((stored, dp, tenant_id, owner_id, tier)) => match node_token_check(&stored, &bearer) {
            None => return StatusCode::UNAUTHORIZED.into_response(),
            Some(needs_rehash) => {
                if needs_rehash {
                    let _ = sqlx::query(
                        "UPDATE nodes SET session_token = $1 WHERE wk_id = $2 AND session_token = $3"
                    ).bind(hash_node_token(&bearer)).bind(&node_id).bind(&stored)
                    .execute(&state.pool).await;
                }
                let tier = if is_self_hosted() { "enterprise".to_string() } else { tier };
                (dp, tenant_id.zip(owner_id), tier)
            }
        },
    };

    let duck_row = metrics_row_from_payload(&payload, ts);
    let live_activities = payload.live_activities.clone();
    let agent_observations = payload.observations.clone();
    let metrics_snap: Option<MetricsPayload> = Some(payload.clone());

    let persist_snapshot = {
        let mut map = state.metrics.write().unwrap();
        let entry = map.entry(node_id.clone()).or_insert(MetricsEntry {
            last_seen_ms: ts, metrics: None, snapshot_saved_ms: 0,
        });
        entry.last_seen_ms = ts;
        entry.metrics      = Some(payload);
        let due = snapshot_persist_due(entry.snapshot_saved_ms, ts);
        if due { entry.snapshot_saved_ms = ts; }
        due
    };
    let payload_json: Option<serde_json::Value> = if persist_snapshot {
        metrics_snap.as_ref().and_then(|m| serde_json::to_value(m).ok())
    } else {
        None
    };

    let pool       = state.pool.clone();
    let metrics_tx = state.metrics_tx.clone();
    let events_tx  = state.events_tx.clone();
    let nid        = node_id.clone();

    tokio::spawn(async move {
        let _ = sqlx::query(
            "UPDATE nodes SET last_seen = $1,
                    hostname = COALESCE($2, hostname),
                    last_telemetry_json = COALESCE($3, last_telemetry_json)
             WHERE wk_id = $4"
        ).bind(ts as i64).bind(&node_hostname).bind(&payload_json).bind(&nid)
        .execute(&pool).await;

        if let Some((tenant_id, owner_id)) = tenant {
            let row = MetricsRow { tenant_id: tenant_id.clone(), ..duck_row };
            if let Err(e) = metrics_tx.try_send(row) {
                eprintln!("[telemetry] metrics_tx send failed for {nid}: {e}");
            }

            for ev in &live_activities {
                let _ = events_tx.try_send(EventRow {
                    ts_ms:      ev.timestamp_ms as i64,
                    node_id:    nid.clone(),
                    tenant_id:  tenant_id.clone(),
                    level:      if ev.level.is_empty() { "info".to_string() } else { ev.level.clone() },
                    event_type: ev.event_type.clone(),
                    message:    ev.message.clone(),
                });
            }

            if is_pro_or_above(&tier)
                && let Some(ref metrics_snapshot) = metrics_snap {
                    evaluate_alerts(&owner_id, &nid, metrics_snapshot, &pool).await;
                    evaluate_webhooks(&tenant_id, &nid, metrics_snapshot, &pool).await;
                }

            if is_business_or_above(&tier)
                && let Some(ref metrics_snapshot) = metrics_snap {
                    evaluate_model_policy(&tenant_id, &nid, metrics_snapshot, &events_tx, &pool).await;
                }

            if !agent_observations.is_empty() {
                upsert_agent_observations(&tenant_id, &nid, &agent_observations, ts, &pool).await;
            }
        }
    });

    Json(serde_json::json!({ "desired_profile": desired_profile })).into_response()
}

/// GET /api/fleet
pub(crate) async fn handle_fleet(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let (user_id, org_id) = match require_user_and_org(&token, &state.pool, &clerk_keys).await {
        Some(v) => v,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let tier = resolve_tier(&user_id, &org_id, &state.pool).await;

    let (tcol, tval) = tenant_scope(&user_id, &org_id);
    let persisted: Vec<(String, String, i64)> = sqlx::query_as(
        &format!("SELECT wk_id, fleet_url, paired_at FROM nodes WHERE {} = $1 ORDER BY paired_at ASC", tcol)
    ).bind(tval).fetch_all(&state.pool).await.unwrap_or_default();

    let tier_limit = node_limit_for_tier(&tier, false);
    let restricted: HashSet<String> = persisted.iter()
        .skip(tier_limit)
        .map(|(id, _, _)| id.clone())
        .collect();

    let metrics_map = state.metrics.read().unwrap();
    let nodes: Vec<NodeSummary> = persisted.into_iter().map(|(node_id, fleet_url, last_seen_db)| {
        let (last_seen_ms, metrics) = metrics_map.get(&node_id)
            .map(|e| (e.last_seen_ms, e.metrics.clone()))
            .unwrap_or((last_seen_db as u64, None));
        let is_restricted = restricted.contains(&node_id);
        NodeSummary { node_id, fleet_url, last_seen_ms, metrics, restricted: is_restricted }
    }).collect();

    Json(FleetResponse { nodes }).into_response()
}

/// GET /api/fleet/events/history
pub(crate) async fn handle_fleet_events_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let (user_id, org_id) = match require_user_and_org(&token, &state.pool, &clerk_keys).await {
        Some(v) => v,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let limit: i64 = params.get("limit")
        .and_then(|v| v.parse().ok())
        .unwrap_or(50)
        .min(200);
    let default_before = (now_ms() + 86_400_000) as i64;
    let before: i64 = params.get("before")
        .and_then(|v| v.parse().ok())
        .unwrap_or(default_before);
    let node_id_filter = params.get("node_id").cloned();
    let event_type_filter = params.get("event_type").cloned();

    let base = "SELECT (EXTRACT(EPOCH FROM ts) * 1000)::bigint AS ts_ms, node_id, level, event_type, message FROM node_events WHERE tenant_id = $1 AND ts < to_timestamp($2::float8 / 1000.0)";

    let events: Vec<serde_json::Value> = match (&node_id_filter, &event_type_filter) {
        (Some(nid), Some(et)) => {
            let sql = format!("{base} AND node_id = $3 AND event_type = $4 ORDER BY ts DESC LIMIT $5");
            sqlx::query_as::<_, (i64, String, String, Option<String>, String)>(&sql)
                .bind(tenant_scope(&user_id, &org_id).1).bind(before).bind(nid).bind(et).bind(limit)
                .fetch_all(&state.pool).await.unwrap_or_default()
                .into_iter().map(|(ts_ms, node_id, level, event_type, message)| {
                    serde_json::json!({ "ts_ms": ts_ms, "node_id": node_id, "level": level, "event_type": event_type, "message": message })
                }).collect()
        }
        (Some(nid), None) => {
            let sql = format!("{base} AND node_id = $3 ORDER BY ts DESC LIMIT $4");
            sqlx::query_as::<_, (i64, String, String, Option<String>, String)>(&sql)
                .bind(tenant_scope(&user_id, &org_id).1).bind(before).bind(nid).bind(limit)
                .fetch_all(&state.pool).await.unwrap_or_default()
                .into_iter().map(|(ts_ms, node_id, level, event_type, message)| {
                    serde_json::json!({ "ts_ms": ts_ms, "node_id": node_id, "level": level, "event_type": event_type, "message": message })
                }).collect()
        }
        (None, Some(et)) => {
            let sql = format!("{base} AND event_type = $3 ORDER BY ts DESC LIMIT $4");
            sqlx::query_as::<_, (i64, String, String, Option<String>, String)>(&sql)
                .bind(tenant_scope(&user_id, &org_id).1).bind(before).bind(et).bind(limit)
                .fetch_all(&state.pool).await.unwrap_or_default()
                .into_iter().map(|(ts_ms, node_id, level, event_type, message)| {
                    serde_json::json!({ "ts_ms": ts_ms, "node_id": node_id, "level": level, "event_type": event_type, "message": message })
                }).collect()
        }
        (None, None) => {
            let sql = format!("{base} ORDER BY ts DESC LIMIT $3");
            sqlx::query_as::<_, (i64, String, String, Option<String>, String)>(&sql)
                .bind(tenant_scope(&user_id, &org_id).1).bind(before).bind(limit)
                .fetch_all(&state.pool).await.unwrap_or_default()
                .into_iter().map(|(ts_ms, node_id, level, event_type, message)| {
                    serde_json::json!({ "ts_ms": ts_ms, "node_id": node_id, "level": level, "event_type": event_type, "message": message })
                }).collect()
        }
    };

    Json(serde_json::json!({ "events": events })).into_response()
}

/// Upsert agent-pushed observations into fleet_observations.
/// For each observation in the payload:
///   - If an open observation with the same (tenant_id, node_id, alert_type, source='agent')
///     already exists, update its detail and context_json.
///   - Otherwise, INSERT a new row.
///
/// Any previously-open agent observations for this node that are NOT in the current
/// payload are auto-resolved (the agent no longer sees the condition).
pub(crate) async fn upsert_agent_observations(
    tenant_id: &str,
    node_id: &str,
    observations: &[AgentObservationPayload],
    ts: u64,
    pool: &sqlx::PgPool,
) {
    let now_ms = ts as i64;

    let active_ids: std::collections::HashSet<&str> =
        observations.iter().map(|o| o.pattern_id.as_str()).collect();

    for obs in observations {
        let context = serde_json::json!({
            "confidence":       obs.confidence,
            "confidence_ratio": obs.confidence_ratio,
            "action_id":        obs.action_id,
            "resolution_steps": obs.resolution_steps,
            "hook":             obs.hook,
        });

        let existing: Option<String> = sqlx::query_scalar(
            "SELECT id FROM fleet_observations \
             WHERE tenant_id = $1 AND node_id = $2 AND alert_type = $3 \
             AND source = 'agent' AND state = 'open' \
             LIMIT 1"
        )
        .bind(tenant_id).bind(node_id).bind(&obs.pattern_id)
        .fetch_optional(pool).await.ok().flatten();

        if let Some(obs_id) = existing {
            let _ = sqlx::query(
                "UPDATE fleet_observations SET detail = $1, context_json = $2, \
                 title = $3, severity = $4 \
                 WHERE id = $5"
            )
            .bind(&obs.body).bind(&context)
            .bind(&obs.title).bind(&obs.severity)
            .bind(&obs_id)
            .execute(pool).await;
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            let _ = sqlx::query(
                "INSERT INTO fleet_observations \
                 (id, tenant_id, node_id, alert_type, severity, state, title, detail, \
                  context_json, fired_at_ms, source) \
                 VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8, $9, 'agent')"
            )
            .bind(&id).bind(tenant_id).bind(node_id)
            .bind(&obs.pattern_id).bind(&obs.severity)
            .bind(&obs.title).bind(&obs.body).bind(&context)
            .bind(now_ms)
            .execute(pool).await;
        }
    }

    if let Ok(open_rows) = sqlx::query_as::<_, (String, String)>(
        "SELECT id, alert_type FROM fleet_observations \
         WHERE tenant_id = $1 AND node_id = $2 AND source = 'agent' AND state = 'open'"
    )
    .bind(tenant_id).bind(node_id)
    .fetch_all(pool).await
    {
        for (obs_id, alert_type) in &open_rows {
            if !active_ids.contains(alert_type.as_str()) {
                let _ = sqlx::query(
                    "UPDATE fleet_observations SET state = 'resolved', resolved_at_ms = $1 WHERE id = $2"
                )
                .bind(now_ms).bind(obs_id)
                .execute(pool).await;
            }
        }
    }
}

/// GET /api/fleet/observations
pub(crate) async fn handle_fleet_observations(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let (user_id, org_id) = match require_user_and_org(&token, &state.pool, &clerk_keys).await {
        Some(v) => v,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let tier = resolve_tier(&user_id, &org_id, &state.pool).await;
    let allowed = allowed_patterns_for_tier(&tier);

    let limit: i64 = params.get("limit").and_then(|v| v.parse().ok()).unwrap_or(50).min(200);
    let state_filter = params.get("state").cloned().unwrap_or_else(|| "open".into());
    let node_id_filter = params.get("node_id").cloned();

    let base = "SELECT id, node_id, alert_type, severity, state, title, detail, context_json::text, fired_at_ms, resolved_at_ms, ack_at_ms, acknowledged_by FROM fleet_observations WHERE tenant_id = $1 AND alert_type = ANY($2)";

    let rows: Vec<(String, String, String, String, String, String, String, Option<String>, i64, Option<i64>, Option<i64>, Option<String>)> = match (state_filter.as_str(), &node_id_filter) {
        ("all", Some(nid)) => {
            let sql = format!("{base} AND node_id = $3 ORDER BY fired_at_ms DESC LIMIT $4");
            sqlx::query_as(&sql).bind(tenant_scope(&user_id, &org_id).1).bind(&allowed).bind(nid).bind(limit)
                .fetch_all(&state.pool).await.unwrap_or_default()
        }
        ("all", None) => {
            let sql = format!("{base} ORDER BY fired_at_ms DESC LIMIT $3");
            sqlx::query_as(&sql).bind(tenant_scope(&user_id, &org_id).1).bind(&allowed).bind(limit)
                .fetch_all(&state.pool).await.unwrap_or_default()
        }
        (st, Some(nid)) => {
            let sql = format!("{base} AND state = $3 AND node_id = $4 ORDER BY fired_at_ms DESC LIMIT $5");
            sqlx::query_as(&sql).bind(tenant_scope(&user_id, &org_id).1).bind(&allowed).bind(st).bind(nid).bind(limit)
                .fetch_all(&state.pool).await.unwrap_or_default()
        }
        (st, None) => {
            let sql = format!("{base} AND state = $3 ORDER BY fired_at_ms DESC LIMIT $4");
            sqlx::query_as(&sql).bind(tenant_scope(&user_id, &org_id).1).bind(&allowed).bind(st).bind(limit)
                .fetch_all(&state.pool).await.unwrap_or_default()
        }
    };

    let observations: Vec<serde_json::Value> = rows.into_iter().map(|r| {
        serde_json::json!({
            "id": r.0, "node_id": r.1, "alert_type": r.2, "severity": r.3,
            "state": r.4, "title": r.5, "detail": r.6, "context_json": r.7,
            "fired_at_ms": r.8, "resolved_at_ms": r.9, "ack_at_ms": r.10,
            "acknowledged_by": r.11,
        })
    }).collect();

    Json(serde_json::json!({ "observations": observations })).into_response()
}

/// POST /api/fleet/observations/:id/acknowledge
pub(crate) async fn handle_acknowledge_observation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(obs_id): Path<String>,
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

    let now = now_ms() as i64;
    let result = sqlx::query(
        "UPDATE fleet_observations SET state = 'acknowledged', ack_at_ms = $1, acknowledged_by = $4
         WHERE id = $2 AND tenant_id = $3 AND state = 'open'"
    ).bind(now).bind(&obs_id).bind(tenant_scope(&user_id, &org_id).1).bind(&user_id)
    .execute(&state.pool).await;

    match result {
        Ok(r) if r.rows_affected() > 0 => Json(serde_json::json!({ "ok": true })).into_response(),
        Ok(_) => (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Observation not found or already resolved" }))).into_response(),
        Err(e) => { eprintln!("[observations] update failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" }))).into_response() },
    }
}

/// POST /api/fleet/observations — submit client-side pattern detections (Pro+)
pub(crate) async fn handle_submit_observation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
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

    let tier = resolve_tier(&user_id, &org_id, &state.pool).await;
    if tier == "community" {
        return upgrade_required("Persistent insights", UpgradePlan::Team);
    }

    let node_id    = body["node_id"].as_str().unwrap_or_default().to_string();
    let alert_type = body["alert_type"].as_str().unwrap_or_default().to_string();
    let severity   = body["severity"].as_str().unwrap_or("warning").to_string();
    let title      = body["title"].as_str().unwrap_or_default().to_string();
    let detail     = body["detail"].as_str().unwrap_or_default().to_string();
    let context    = body.get("context").cloned().unwrap_or(serde_json::json!({}));

    if node_id.is_empty() || alert_type.is_empty() || title.is_empty() {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "node_id, alert_type, and title are required" }))).into_response();
    }

    let owns = node_in_tenant(&node_id, &user_id, &org_id, &state.pool).await;
    let tenant = tenant_scope(&user_id, &org_id).1.to_string();
    if !owns {
        return (StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Node not found or not owned by you" }))).into_response();
    }

    let already_open: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM fleet_observations WHERE tenant_id = $1 AND node_id = $2 AND alert_type = $3 AND state = 'open'"
    ).bind(&tenant).bind(&node_id).bind(&alert_type).fetch_one(&state.pool).await.unwrap_or(0) > 0;
    if already_open {
        return Json(serde_json::json!({ "ok": true, "dedup": true, "message": "Already open" })).into_response();
    }

    let now = now_ms() as i64;
    let obs_id = Uuid::new_v4().to_string();
    let context_str = serde_json::to_string(&context).unwrap_or_default();

    let _ = sqlx::query(
        "INSERT INTO fleet_observations (id, tenant_id, node_id, alert_type, severity, state, title, detail, context_json, fired_at_ms)
         VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8::jsonb, $9)
         ON CONFLICT DO NOTHING"
    ).bind(&obs_id).bind(&tenant).bind(&node_id).bind(&alert_type)
    .bind(&severity).bind(&title).bind(&detail)
    .bind(&context_str).bind(now)
    .execute(&state.pool).await;

    let _ = state.events_tx.try_send(EventRow {
        ts_ms: now, node_id: node_id.clone(), tenant_id: tenant.clone(),
        level: if severity == "critical" { "error" } else { "warning" }.into(),
        event_type: Some(alert_type.clone()), message: title.clone(),
    });

    Json(serde_json::json!({ "ok": true, "id": obs_id })).into_response()
}

/// POST /api/fleet/observations/:id/resolve — mark an observation as resolved from frontend
pub(crate) async fn handle_resolve_observation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(obs_id): Path<String>,
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

    let now = now_ms() as i64;
    let result = sqlx::query(
        "UPDATE fleet_observations SET state = 'resolved', resolved_at_ms = $1
         WHERE id = $2 AND tenant_id = $3 AND state = 'open'"
    ).bind(now).bind(&obs_id).bind(tenant_scope(&user_id, &org_id).1)
    .execute(&state.pool).await;

    match result {
        Ok(r) if r.rows_affected() > 0 => Json(serde_json::json!({ "ok": true })).into_response(),
        Ok(_) => (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Observation not found or already resolved" }))).into_response(),
        Err(e) => { eprintln!("[observations] resolve failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" }))).into_response() },
    }
}

/// POST /api/pair/activate
#[derive(Deserialize)]
pub(crate) struct ActivateRequest {
    pub(crate) code: String,
}

pub(crate) async fn handle_activate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ActivateRequest>,
) -> impl IntoResponse {
    if body.code.len() != 6 || !body.code.chars().all(|c| c.is_ascii_digit()) {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "code must be exactly 6 ASCII digits" }))).into_response();
    }

    let ip = client_ip(&headers);
    if !check_auth_rate_limit(&ip, &state.auth_rate_limits) {
        return (StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({ "error": "Too many attempts. Try again in a minute." }))).into_response();
    }

    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_info = require_user_info(&token, &state.pool, &clerk_keys).await;

    let (user_id, email, is_pro_db, org_id, role) = match user_info {
        Some(info) => info,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };
    if !role.can_mutate() { return role_forbidden("member"); }

    if !check_auth_rate_limit(&format!("activate:{user_id}"), &state.auth_rate_limits) {
        return (StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({ "error": "Too many attempts. Try again in a minute." }))).into_response();
    }

    let is_pro = is_pro_db != 0 || is_dev_account(&email);
    let tier = resolve_tier(&user_id, &org_id, &state.pool).await;
    let node_limit = node_limit_for_tier(&tier, is_pro);
    let internal = || (StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "error": "Internal error" }))).into_response();

    let (tcol, tval) = tenant_scope(&user_id, &org_id);
    let mut tx = match state.pool.begin().await {
        Ok(t) => t,
        Err(_) => return internal(),
    };
    if sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("activate:{tcol}:{tval}"))
        .execute(&mut *tx).await.is_err()
    {
        return internal();
    }
    {
        let count: i64 = match sqlx::query_scalar::<_, i64>(
            &format!("SELECT COUNT(*) FROM nodes WHERE {} = $1", tcol)
        ).bind(tval).fetch_one(&mut *tx).await {
            Ok(c) => c,
            Err(_) => return internal(),
        };
        if count as usize >= node_limit {
            let plan = plan_name_for_tier(&tier);
            let next = match tier.as_str() {
                "team_10" => "Move to Team (25 nodes) to add more.",
                "team"    => "Above 25 nodes, talk to us about Enterprise.",
                _         => "Team plans cover 10 or 25 nodes — see Pricing.",
            };
            return (StatusCode::PAYMENT_REQUIRED,
                Json(serde_json::json!({
                    "error": format!("{plan} limit reached ({node_limit} nodes). {next}"),
                    "tier": tier,
                    "node_limit": node_limit,
                }))).into_response();
        }
    }

    let fresh_after = now_ms().saturating_sub(PAIR_CODE_TTL_MS) as i64;
    let row = match sqlx::query_as::<_, (String, String)>(
        "UPDATE nodes SET user_id = $1, org_id = $2, code = NULL
         WHERE wk_id = (
             SELECT wk_id FROM nodes
             WHERE code = $3 AND user_id IS NULL AND paired_at >= $4
             ORDER BY paired_at DESC
             LIMIT 1
             FOR UPDATE SKIP LOCKED
         ) AND user_id IS NULL
         RETURNING wk_id, fleet_url"
    ).bind(&user_id).bind(&org_id).bind(&body.code).bind(fresh_after)
    .fetch_optional(&mut *tx).await {
        Ok(r) => r,
        Err(_) => return internal(),
    };
    if row.is_some() && tx.commit().await.is_err() {
        return internal();
    }

    match row {
        None => (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Code not found, expired, or already used. Make sure the agent is running and try again." }))).into_response(),
        Some((node_id, fleet_url)) => {
            if let Some(ref oid) = org_id {
                let _ = sqlx::query(
                    "INSERT INTO organizations (org_id, subscription_tier, created_by, created_at) \
                     VALUES ($1, (SELECT subscription_tier FROM users WHERE id = $2), $2, $3) \
                     ON CONFLICT DO NOTHING"
                ).bind(oid).bind(&user_id).bind(now_ms() as i64)
                .execute(&state.pool).await;
            }
            audit(&state.pool, &user_id, &org_id, "node.paired", &node_id,
                serde_json::json!({ "fleet_url": &fleet_url }));
            (StatusCode::OK, Json(serde_json::json!({ "node_id": node_id, "fleet_url": fleet_url }))).into_response()
        }
    }
}

pub(crate) fn metrics_row_from_payload(m: &MetricsPayload, ts_ms: u64) -> MetricsRow {
    let tok_s   = if m.vllm_running { m.vllm_tokens_per_sec } else { m.ollama_tokens_per_second };
    let watts   = m.nvidia_power_draw_w.or(m.apple_soc_power_w).or(m.cpu_power_w);
    let penalty = thermal_penalty_for(m.thermal_state.as_deref());

    let wes_raw = match (tok_s, watts) {
        (Some(t), Some(w)) if t > 0.0 && w > 0.0 =>
            Some(((t / w) * 10.0).round() / 10.0),
        _ => None,
    };
    let wes_penalized = match (tok_s, watts) {
        (Some(t), Some(w)) if t > 0.0 && w > 0.0 =>
            Some(((t / (w * penalty)) * 10.0).round() / 10.0),
        _ => None,
    };
    let gpu_pct = m.gpu_utilization_percent.or(m.nvidia_gpu_utilization_percent);

    MetricsRow {
        node_id:          m.node_id.clone(),
        ts_ms:            ts_ms as i64,
        tenant_id:        String::new(),
        tok_s,
        watts,
        wes_raw,
        wes_penalized,
        thermal_cost_pct: m.penalty_avg.and_then(|p| if p > 1.0 { Some(((p - 1.0) / p) * 100.0) } else { None }),
        thermal_penalty:  Some(penalty),
        thermal_state:    m.thermal_state.clone(),
        vram_used_mb:     m.nvidia_vram_used_mb.map(|v| v as i32),
        vram_total_mb:    m.nvidia_vram_total_mb.map(|v| v as i32),
        mem_pressure_pct: m.memory_pressure_percent,
        gpu_pct,
        cpu_pct:          Some(m.cpu_usage_percent),
        inference_state:  m.inference_state.clone(),
        wes_version:      m.wes_version.unwrap_or(1),
        swap_write:       m.swap_write_mb_s,
        ttft_ms:          m.vllm_avg_ttft_ms.or(m.ollama_proxy_avg_ttft_ms).or(m.ollama_ttft_ms),
        avg_latency_ms:   m.vllm_avg_e2e_latency_ms.or(m.ollama_proxy_avg_latency_ms),
        queue_depth:      m.vllm_requests_waiting.map(|v| v as i32),
        ollama_active_model: m.ollama_active_model.clone().or(m.vllm_model_name.clone()),
    }
}

pub(crate) async fn flush_batch(pool: &sqlx::PgPool, batch: &[MetricsRow]) {
    if batch.is_empty() { return; }

    for chunk in batch.chunks(1000) {
        let ts_values:   Vec<f64>            = chunk.iter().map(|r| r.ts_ms as f64).collect();
        let node_ids:    Vec<&str>           = chunk.iter().map(|r| r.node_id.as_str()).collect();
        let tenant_ids:  Vec<&str>           = chunk.iter().map(|r| r.tenant_id.as_str()).collect();
        let tok_s:       Vec<Option<f32>>    = chunk.iter().map(|r| r.tok_s).collect();
        let watts:       Vec<Option<f32>>    = chunk.iter().map(|r| r.watts).collect();
        let wes_raw:     Vec<Option<f32>>    = chunk.iter().map(|r| r.wes_raw).collect();
        let wes_pen:     Vec<Option<f32>>    = chunk.iter().map(|r| r.wes_penalized).collect();
        let therm_cost:  Vec<Option<f32>>    = chunk.iter().map(|r| r.thermal_cost_pct).collect();
        let therm_pen:   Vec<Option<f32>>    = chunk.iter().map(|r| r.thermal_penalty).collect();
        let therm_state: Vec<Option<&str>>   = chunk.iter().map(|r| r.thermal_state.as_deref()).collect();
        let vram_used:   Vec<Option<i32>>    = chunk.iter().map(|r| r.vram_used_mb).collect();
        let vram_total:  Vec<Option<i32>>    = chunk.iter().map(|r| r.vram_total_mb).collect();
        let mem_pct:     Vec<Option<f32>>    = chunk.iter().map(|r| r.mem_pressure_pct).collect();
        let gpu_pct:     Vec<Option<f32>>    = chunk.iter().map(|r| r.gpu_pct).collect();
        let cpu_pct:     Vec<Option<f32>>    = chunk.iter().map(|r| r.cpu_pct).collect();
        let inf_state:   Vec<Option<&str>>   = chunk.iter().map(|r| r.inference_state.as_deref()).collect();
        let wes_ver:     Vec<i16>            = chunk.iter().map(|r| r.wes_version as i16).collect();
        let swap_write:  Vec<Option<f32>>    = chunk.iter().map(|r| r.swap_write).collect();
        let ttft:        Vec<Option<f32>>    = chunk.iter().map(|r| r.ttft_ms).collect();
        let avg_lat:     Vec<Option<f32>>    = chunk.iter().map(|r| r.avg_latency_ms).collect();
        let q_depth:     Vec<Option<i32>>    = chunk.iter().map(|r| r.queue_depth).collect();
        let active_mdl:  Vec<Option<&str>>   = chunk.iter().map(|r| r.ollama_active_model.as_deref()).collect();

        let _ = sqlx::query(
            "INSERT INTO metrics_raw (ts, node_id, tenant_id, tok_s, watts, wes_raw, wes_penalized,
                thermal_cost_pct, thermal_penalty, thermal_state, vram_used_mb, vram_total_mb,
                mem_pressure_pct, gpu_pct, cpu_pct, inference_state, wes_version, swap_write,
                ttft_ms, avg_latency_ms, queue_depth, ollama_active_model)
             SELECT to_timestamp(unnest($1::float8[]) / 1000.0),
                    unnest($2::text[]), unnest($3::text[]),
                    unnest($4::real[]), unnest($5::real[]), unnest($6::real[]), unnest($7::real[]),
                    unnest($8::real[]), unnest($9::real[]), unnest($10::text[]),
                    unnest($11::int[]), unnest($12::int[]),
                    unnest($13::real[]), unnest($14::real[]), unnest($15::real[]),
                    unnest($16::text[]), unnest($17::smallint[]), unnest($18::real[]),
                    unnest($19::real[]), unnest($20::real[]), unnest($21::int[]),
                    unnest($22::text[])
             ON CONFLICT DO NOTHING"
        )
        .bind(&ts_values).bind(&node_ids).bind(&tenant_ids)
        .bind(&tok_s).bind(&watts).bind(&wes_raw).bind(&wes_pen)
        .bind(&therm_cost).bind(&therm_pen).bind(&therm_state)
        .bind(&vram_used).bind(&vram_total)
        .bind(&mem_pct).bind(&gpu_pct).bind(&cpu_pct)
        .bind(&inf_state).bind(&wes_ver).bind(&swap_write)
        .bind(&ttft).bind(&avg_lat).bind(&q_depth)
        .bind(&active_mdl)
        .execute(pool).await;
    }
}

/// Background task: drain the metrics channel and flush every 30 s.
/// (30 s is the batch FLUSH interval only — each row is one agent push,
/// ~2 s apart. Never treat a metrics_raw row as a 30 s sample; integrate
/// with energy::raw_dt_sql.)
pub(crate) async fn metrics_writer_task(mut rx: mpsc::Receiver<MetricsRow>, pool: sqlx::PgPool) {
    let mut buffer: Vec<MetricsRow> = Vec::with_capacity(256);
    let mut flush_interval = tokio::time::interval(Duration::from_secs(30));
    flush_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    flush_interval.tick().await;

    loop {
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    None => break,
                    Some(row) => {
                        buffer.push(row);
                        if buffer.len() >= 512 {
                            let batch = std::mem::take(&mut buffer);
                            flush_batch(&pool, &batch).await;
                        }
                    }
                }
            }
            _ = flush_interval.tick() => {
                if !buffer.is_empty() {
                    let batch = std::mem::take(&mut buffer);
                    flush_batch(&pool, &batch).await;
                }
            }
        }
    }

    if !buffer.is_empty() {
        flush_batch(&pool, &buffer).await;
    }
}

/// Background task: drain the events channel and write immediately.
pub(crate) async fn events_writer_task(mut rx: mpsc::Receiver<EventRow>, pool: sqlx::PgPool) {
    while let Some(ev) = rx.recv().await {
        let _ = sqlx::query(
            "INSERT INTO node_events (ts, node_id, tenant_id, level, event_type, message)
             VALUES (to_timestamp($1::float8 / 1000.0), $2, $3, $4, $5, $6)
             ON CONFLICT DO NOTHING"
        ).bind(ev.ts_ms as f64).bind(&ev.node_id).bind(&ev.tenant_id)
        .bind(&ev.level).bind(&ev.event_type).bind(&ev.message)
        .execute(&pool).await;
    }
}
