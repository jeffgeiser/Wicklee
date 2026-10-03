//! Audit log (read/export/drains) and model governance (policies, violations, per-tick evaluation).

use crate::*;

/// Record an audit event. Fire-and-forget — never delays or fails the request.
/// Events are recorded for every tier; reading them is gated to Business+.
/// org_id must come from the verified JWT claim (require_user_and_org), never
/// a client header. The actor email is resolved here so callers only pass ids.
pub(crate) fn audit(
    pool: &sqlx::PgPool,
    user_id: &str,
    org_id: &Option<String>,
    action: &'static str,
    target: &str,
    details: serde_json::Value,
) {
    let pool = pool.clone();
    let user_id = user_id.to_owned();
    let org_id = org_id.clone();
    let target = target.to_owned();
    tokio::spawn(async move {
        let email: String = sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
            .bind(&user_id).fetch_one(&pool).await.unwrap_or_default();
        if let Err(e) = sqlx::query(
            "INSERT INTO audit_log (ts, user_id, org_id, actor_email, action, target, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)"
        ).bind(now_ms() as i64).bind(&user_id).bind(&org_id).bind(&email)
        .bind(action).bind(&target).bind(details.to_string())
        .execute(&pool).await {
            eprintln!("[audit] write failed for {action}: {e}");
        }
    });
}

/// GET /api/audit-log — immutable audit trail, Business+ tier.
/// Query params: limit (default 50, max 200), before (ts_ms cursor),
/// action (exact-match filter). Org members see the whole org trail.
pub(crate) async fn handle_audit_log(
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
    if !is_business_or_above(&tier) {
        return upgrade_required("Audit logging", UpgradePlan::Enterprise);
    }

    let limit: i64 = params.get("limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(50).clamp(1, 200);
    let before: i64 = params.get("before")
        .and_then(|s| s.parse().ok())
        .unwrap_or(i64::MAX);
    let action = params.get("action").cloned();

    let (tcol, tval) = tenant_scope(&user_id, &org_id);
    let mut sql = format!(
        "SELECT id, ts, user_id, org_id, actor_email, action, target, COALESCE(details::text, '{{}}')
         FROM audit_log WHERE {tcol} = $1 AND ts < $2");
    if action.is_some() { sql.push_str(" AND action = $4"); }
    sql.push_str(" ORDER BY ts DESC LIMIT $3");

    let mut q = sqlx::query_as::<_, (i64, i64, String, Option<String>, String, String, String, String)>(&sql)
        .bind(tval).bind(before).bind(limit);
    if let Some(ref a) = action { q = q.bind(a); }
    let rows = q.fetch_all(&state.pool).await.unwrap_or_default();

    let entries: Vec<serde_json::Value> = rows.into_iter()
        .map(|(id, ts, uid, oid, email, action, target, details)| serde_json::json!({
            "id": id, "ts": ts, "user_id": uid, "org_id": oid,
            "actor_email": email, "action": action, "target": target,
            "details": serde_json::from_str::<serde_json::Value>(&details)
                .unwrap_or(serde_json::json!({})),
        })).collect();

    let next_before = entries.last().and_then(|e| e["ts"].as_i64());
    Json(serde_json::json!({ "entries": entries, "next_before": next_before })).into_response()
}

/// Escape a value for CSV: RFC-4180 quoting (quotes, commas, newlines) plus
/// spreadsheet formula-injection hardening — cells starting with = + - @ get
/// a leading apostrophe so Excel/Sheets treat them as text, not formulas.
/// (Audit fields like `target` and `details` can carry client-influenced
/// strings, e.g. node display names.)
pub(crate) fn csv_escape(s: &str) -> String {
    let s = if s.starts_with(['=', '+', '-', '@']) {
        format!("'{s}")
    } else {
        s.to_string()
    };
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s
    }
}

/// GET /api/audit-log/export?format=csv|json&action=&from=&to= — full-history
/// audit export, Business+ tier. Same tenant scoping as /api/audit-log.
/// Chronological (ts ASC), capped at 100k rows. The export itself is audited.
pub(crate) async fn handle_audit_log_export(
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
    if !is_business_or_above(&tier) {
        return upgrade_required("Audit logging", UpgradePlan::Enterprise);
    }

    let format = params.get("format").map(|s| s.as_str()).unwrap_or("json");
    if !matches!(format, "json" | "csv") {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "format must be json or csv" }))).into_response();
    }
    let from: i64 = params.get("from").and_then(|s| s.parse().ok()).unwrap_or(0);
    let to:   i64 = params.get("to").and_then(|s| s.parse().ok()).unwrap_or(i64::MAX);
    let action = params.get("action").cloned();

    let (tcol, tval) = tenant_scope(&user_id, &org_id);
    let mut sql = format!(
        "SELECT id, ts, user_id, org_id, actor_email, action, target, COALESCE(details::text, '{{}}')
         FROM audit_log WHERE {tcol} = $1 AND ts >= $2 AND ts <= $3");
    if action.is_some() { sql.push_str(" AND action = $4"); }
    sql.push_str(" ORDER BY ts ASC LIMIT 100000");

    let mut q = sqlx::query_as::<_, (i64, i64, String, Option<String>, String, String, String, String)>(&sql)
        .bind(tval).bind(from).bind(to);
    if let Some(ref a) = action { q = q.bind(a); }
    let rows = q.fetch_all(&state.pool).await.unwrap_or_default();
    let row_count = rows.len();

    audit(&state.pool, &user_id, &org_id, "audit_log.exported", "",
        serde_json::json!({ "format": format, "rows": row_count }));

    let stamp = now_ms();
    if format == "csv" {
        let mut out = String::from("id,ts,actor_email,user_id,org_id,action,target,details\n");
        for (id, ts, uid, oid, email, action, target, details) in rows {
            out.push_str(&format!("{},{},{},{},{},{},{},{}\n",
                id, ts,
                csv_escape(&email), csv_escape(&uid), csv_escape(oid.as_deref().unwrap_or("")),
                csv_escape(&action), csv_escape(&target), csv_escape(&details)));
        }
        (
            [
                ("Content-Type", "text/csv; charset=utf-8".to_string()),
                ("Content-Disposition", format!("attachment; filename=\"wicklee-audit-{stamp}.csv\"")),
            ],
            out,
        ).into_response()
    } else {
        let entries: Vec<serde_json::Value> = rows.into_iter()
            .map(|(id, ts, uid, oid, email, action, target, details)| serde_json::json!({
                "id": id, "ts": ts, "user_id": uid, "org_id": oid,
                "actor_email": email, "action": action, "target": target,
                "details": serde_json::from_str::<serde_json::Value>(&details)
                    .unwrap_or(serde_json::json!({})),
            })).collect();
        (
            [
                ("Content-Type", "application/json".to_string()),
                ("Content-Disposition", format!("attachment; filename=\"wicklee-audit-{stamp}.json\"")),
            ],
            serde_json::json!({ "entries": entries, "count": row_count }).to_string(),
        ).into_response()
    }
}

/// GET /api/audit-log/drain — current SIEM drain status (no secret). Business+.
pub(crate) async fn handle_get_audit_drain(
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
    if !is_business_or_above(&tier) {
        return upgrade_required("Audit logging", UpgradePlan::Enterprise);
    }

    let (_tcol, tval) = tenant_scope(&user_id, &org_id);
    let row: Option<(String, bool, i32, Option<i64>, i64)> = sqlx::query_as(
        "SELECT url, enabled, failures, last_delivery_ms, created_at FROM audit_drains WHERE tenant_id = $1"
    ).bind(tval).fetch_optional(&state.pool).await.ok().flatten();

    match row {
        Some((url, enabled, failures, last_delivery_ms, created_at)) => Json(serde_json::json!({
            "configured": true, "url": url, "enabled": enabled,
            "failures": failures, "last_delivery_ms": last_delivery_ms, "created_at": created_at,
        })).into_response(),
        None => Json(serde_json::json!({ "configured": false })).into_response(),
    }
}

#[derive(Deserialize)]
pub(crate) struct PutDrainBody { pub(crate) url: String }

/// PUT /api/audit-log/drain — create or replace the tenant's SIEM drain.
/// Admin-only + Business+. Returns the HMAC secret ONCE (re-PUT rotates it).
/// The delivery cursor starts at the tenant's current max audit id — the
/// drain streams new events; history backfill is the export endpoint's job.
pub(crate) async fn handle_put_audit_drain(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PutDrainBody>,
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
    if !role.is_admin() { return role_forbidden("admin"); }
    let tier = resolve_tier(&user_id, &org_id, &state.pool).await;
    if !is_business_or_above(&tier) {
        return upgrade_required("Audit logging", UpgradePlan::Enterprise);
    }
    if let Err(e) = resolve_outbound(&body.url).await {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": format!("{e} (https strongly recommended)") }))).into_response();
    }

    let secret_bytes: [u8; 32] = std::array::from_fn(|_| rand::random());
    let secret = hex::encode(secret_bytes);
    let (tcol, tval) = tenant_scope(&user_id, &org_id);

    // Start the cursor at the tenant's current max id so only NEW events flow.
    let start_sql = format!("SELECT COALESCE(MAX(id), 0) FROM audit_log WHERE {tcol} = $1");
    let start_id: i64 = sqlx::query_scalar(&start_sql)
        .bind(tval).fetch_one(&state.pool).await.unwrap_or(0);

    let result = sqlx::query(
        "INSERT INTO audit_drains (tenant_id, user_id, org_id, url, secret, enabled, last_id, failures, created_at)
         VALUES ($1, $2, $3, $4, $5, true, $6, 0, $7)
         ON CONFLICT (tenant_id) DO UPDATE SET
           url = EXCLUDED.url, secret = EXCLUDED.secret, enabled = true,
           failures = 0, user_id = EXCLUDED.user_id, org_id = EXCLUDED.org_id"
    ).bind(tval).bind(&user_id).bind(&org_id).bind(&body.url).bind(&secret)
    .bind(start_id).bind(now_ms() as i64)
    .execute(&state.pool).await;

    match result {
        Ok(_) => {
            audit(&state.pool, &user_id, &org_id, "audit_drain.created", &body.url,
                serde_json::json!({}));
            Json(serde_json::json!({
                "url": body.url, "enabled": true,
                "secret": secret,  // shown ONCE — verify X-Wicklee-Signature with it
            })).into_response()
        }
        Err(e) => { eprintln!("[audit-drain] upsert failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal error" }))).into_response() }
    }
}

/// DELETE /api/audit-log/drain — remove the tenant's SIEM drain. Admin-only.
pub(crate) async fn handle_delete_audit_drain(
    State(state): State<AppState>,
    headers: HeaderMap,
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
    if !role.is_admin() { return role_forbidden("admin"); }

    let (_tcol, tval) = tenant_scope(&user_id, &org_id);
    let result = sqlx::query("DELETE FROM audit_drains WHERE tenant_id = $1")
        .bind(tval).execute(&state.pool).await;

    match result {
        Ok(r) if r.rows_affected() == 0 => (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "No drain configured" }))).into_response(),
        Ok(_) => {
            audit(&state.pool, &user_id, &org_id, "audit_drain.deleted", "", serde_json::json!({}));
            StatusCode::NO_CONTENT.into_response()
        }
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal error" }))).into_response(),
    }
}

/// SIEM drain delivery loop — every 60s, ships each enabled drain's new audit
/// events (id > cursor) as an HMAC-signed batch via `deliver_webhook`. Tier is
/// re-checked at delivery time so downgraded tenants stop draining. A drain
/// auto-disables after 20 consecutive failures so a dead endpoint can't spin
/// forever; re-PUT re-enables it.
pub(crate) async fn audit_drain_task(pool: sqlx::PgPool) {
    let mut interval = tokio::time::interval(Duration::from_secs(60));
    loop {
        interval.tick().await;
        let drains: Vec<(String, String, Option<String>, String, String, i64, i32)> = sqlx::query_as(
            "SELECT tenant_id, user_id, org_id, url, secret, last_id, failures
             FROM audit_drains WHERE enabled = true"
        ).fetch_all(&pool).await.unwrap_or_default();

        for (tenant_id, user_id, org_id, url, secret, last_id, failures) in drains {
            let tier = resolve_tier(&user_id, &org_id, &pool).await;
            if !is_business_or_above(&tier) { continue; }

            let (tcol, tval) = tenant_scope(&user_id, &org_id);
            let sql = format!(
                "SELECT id, ts, user_id, org_id, actor_email, action, target, COALESCE(details::text, '{{}}')
                 FROM audit_log WHERE {tcol} = $1 AND id > $2 ORDER BY id ASC LIMIT 500");
            let rows: Vec<(i64, i64, String, Option<String>, String, String, String, String)> =
                sqlx::query_as(&sql).bind(tval).bind(last_id)
                    .fetch_all(&pool).await.unwrap_or_default();
            if rows.is_empty() { continue; }

            let max_id = rows.last().map(|r| r.0).unwrap_or(last_id);
            let events: Vec<serde_json::Value> = rows.into_iter()
                .map(|(id, ts, uid, oid, email, action, target, details)| serde_json::json!({
                    "id": id, "ts": ts, "user_id": uid, "org_id": oid,
                    "actor_email": email, "action": action, "target": target,
                    "details": serde_json::from_str::<serde_json::Value>(&details)
                        .unwrap_or(serde_json::json!({})),
                })).collect();
            let count = events.len();
            let payload = serde_json::json!({
                "type": "audit.batch", "tenant_id": tenant_id, "events": events,
            });

            match deliver_webhook(&url, &secret, &payload).await {
                Ok(status) if (200..300).contains(&status) => {
                    let _ = sqlx::query(
                        "UPDATE audit_drains SET last_id = $1, failures = 0, last_delivery_ms = $2
                         WHERE tenant_id = $3"
                    ).bind(max_id).bind(now_ms() as i64).bind(&tenant_id)
                    .execute(&pool).await;
                    eprintln!("[audit-drain] delivered {count} events to tenant {tenant_id}");
                }
                outcome => {
                    let f = failures + 1;
                    let disable = f >= 20;
                    let _ = sqlx::query(
                        "UPDATE audit_drains SET failures = $1, enabled = $2 WHERE tenant_id = $3"
                    ).bind(f).bind(!disable).bind(&tenant_id)
                    .execute(&pool).await;
                    eprintln!("[audit-drain] delivery failed for tenant {tenant_id} ({outcome:?}, failure {f}{})",
                        if disable { " — DISABLED after 20 consecutive failures" } else { "" });
                }
            }
        }
    }
}

// ── Model governance API (Enterprise) ────────────────────────────────────────

#[derive(serde::Deserialize)]
pub(crate) struct CreateModelPolicyBody {
    /// Model name, or a trailing-`*` prefix pattern (e.g. "llama3.1:8b*").
    pub(crate) model: String,
    /// Node tag this entry applies to. Omit for fleet-wide.
    pub(crate) tag:   Option<String>,
    pub(crate) note:  Option<String>,
}

/// Shared auth for the governance endpoints. Returns the resolved
/// (user_id, org_id, role, tenant_id) or the response to send back.
pub(crate) async fn governance_auth(
    state:   &AppState,
    headers: &HeaderMap,
) -> Result<(String, Option<String>, OrgRole, String), axum::response::Response> {
    let token = match extract_bearer(headers) {
        Some(t) => t,
        None => return Err((StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response()),
    };
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let (user_id, org_id, role) = match require_user_org_role(&token, &state.pool, &clerk_keys).await {
        Some(v) => v,
        None => return Err((StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response()),
    };
    let tier = resolve_tier(&user_id, &org_id, &state.pool).await;
    if !is_business_or_above(&tier) {
        return Err(upgrade_required("Model governance", UpgradePlan::Enterprise));
    }
    let tenant_id = tenant_scope(&user_id, &org_id).1.to_string();
    Ok((user_id, org_id, role, tenant_id))
}

/// GET /api/model-policy (Enterprise) — the allow-list, plus whether any scope
/// is actually governed.
pub(crate) async fn handle_model_policy_list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let (_uid, _oid, _role, tenant_id) = match governance_auth(&state, &headers).await {
        Ok(v) => v, Err(resp) => return resp,
    };

    let rows: Vec<(String, String, Option<String>, Option<String>, i64)> = sqlx::query_as(
        "SELECT id, model, tag, note, created_at FROM model_policies
         WHERE tenant_id = $1 ORDER BY COALESCE(tag,''), lower(model)"
    ).bind(&tenant_id).fetch_all(&state.pool).await.unwrap_or_default();

    let entries: Vec<serde_json::Value> = rows.iter().map(|(id, model, tag, note, created_at)| {
        serde_json::json!({
            "id": id, "model": model, "tag": tag, "note": note, "created_at": created_at
        })
    }).collect();

    Json(serde_json::json!({
        // No entries = nothing is governed. Surfaced explicitly so the UI can
        // say so rather than showing an empty list that looks like "all blocked".
        "active":  !entries.is_empty(),
        "entries": entries,
    })).into_response()
}

/// POST /api/model-policy (Enterprise, Admin) — add an allow-list entry.
pub(crate) async fn handle_model_policy_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateModelPolicyBody>,
) -> impl IntoResponse {
    let (user_id, org_id, role, tenant_id) = match governance_auth(&state, &headers).await {
        Ok(v) => v, Err(resp) => return resp,
    };
    // Admin-only: an allow-list is a security control, so editing it matches
    // the bar for node removal rather than day-to-day ops.
    if !matches!(role, OrgRole::Admin) { return role_forbidden("admin"); }

    let model = body.model.trim().to_string();
    if model.is_empty() || model.len() > 200 {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "model must be 1-200 chars" }))).into_response();
    }
    // A bare "*" would allow every model, silently turning governance off for
    // the scope while looking configured. Reject it explicitly.
    if model == "*" {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "'*' would allow every model. Remove the entries for this scope instead to stop governing it."
            }))).into_response();
    }
    if let Some(ref t) = body.tag
        && !valid_scope_tag(t) {
            return (StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "tag must be 1-64 chars: letters, digits, : - _ ." }))).into_response();
        }

    let id = uuid::Uuid::new_v4().to_string();
    let res = sqlx::query(
        "INSERT INTO model_policies (id, tenant_id, model, tag, note, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)"
    ).bind(&id).bind(&tenant_id).bind(&model).bind(&body.tag)
     .bind(&body.note).bind(&user_id).bind(now_ms() as i64)
     .execute(&state.pool).await;

    if let Err(e) = res {
        // Unique index on (tenant, model, coalesce(tag,'')).
        if e.to_string().contains("idx_model_policies_uniq") {
            return (StatusCode::CONFLICT,
                Json(serde_json::json!({ "error": "That model is already allowed for this scope" }))).into_response();
        }
        eprintln!("[governance] policy insert failed: {e}");
        return (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Could not save policy" }))).into_response();
    }

    audit(&state.pool, &user_id, &org_id, "model_policy.created", &id,
        serde_json::json!({ "model": &model, "tag": &body.tag }));

    Json(serde_json::json!({
        "id": id, "model": model, "tag": body.tag, "note": body.note
    })).into_response()
}

/// DELETE /api/model-policy/:id (Enterprise, Admin) — remove an entry.
pub(crate) async fn handle_model_policy_delete(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let (user_id, org_id, role, tenant_id) = match governance_auth(&state, &headers).await {
        Ok(v) => v, Err(resp) => return resp,
    };
    if !matches!(role, OrgRole::Admin) { return role_forbidden("admin"); }

    let affected = sqlx::query(
        "DELETE FROM model_policies WHERE id = $1 AND tenant_id = $2"
    ).bind(&id).bind(&tenant_id).execute(&state.pool).await
     .map(|r| r.rows_affected()).unwrap_or(0);

    if affected == 0 {
        return (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Policy not found" }))).into_response();
    }

    audit(&state.pool, &user_id, &org_id, "model_policy.deleted", &id, serde_json::json!({}));
    Json(serde_json::json!({ "deleted": id })).into_response()
}

/// GET /api/model-policy/violations (Enterprise) — recent violations.
pub(crate) async fn handle_model_policy_violations(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let (_uid, _oid, _role, tenant_id) = match governance_auth(&state, &headers).await {
        Ok(v) => v, Err(resp) => return resp,
    };
    let limit: i64 = params.get("limit").and_then(|v| v.parse().ok()).unwrap_or(50).clamp(1, 200);

    let rows: Vec<(i64, String, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT v.id, v.node_id, v.model, v.scope, v.ts_ms
         FROM model_policy_violations v
         WHERE v.tenant_id = $1
         ORDER BY v.ts_ms DESC
         LIMIT $2"
    ).bind(&tenant_id).bind(limit).fetch_all(&state.pool).await.unwrap_or_default();

    let violations: Vec<serde_json::Value> = rows.iter()
        .map(|(id, node_id, model, scope, ts_ms)| serde_json::json!({
            "id": id, "node_id": node_id, "model": model, "scope": scope, "ts_ms": ts_ms
        })).collect();

    Json(serde_json::json!({ "violations": violations })).into_response()
}

// ── Model governance evaluation ──────────────────────────────────────────────

/// One allow-list entry. `tag: None` = fleet-wide.
#[derive(Debug, Clone)]
pub(crate) struct ModelPolicy {
    pub(crate) model: String,
    pub(crate) tag:   Option<String>,
}

/// Split a node's `tags` column into normalized tags.
///
/// Matches the comma/lowercase/space-stripping convention the alert-rule and
/// webhook tag filters use in SQL, so a tag scopes governance the same way it
/// scopes everything else.
pub(crate) fn normalize_tags(tags: Option<&str>) -> Vec<String> {
    tags.unwrap_or("")
        .split(',')
        .map(|t| t.trim().to_lowercase().replace(' ', ""))
        .filter(|t| !t.is_empty())
        .collect()
}

/// Does an allow-list pattern admit this model name?
///
/// Exact, case-insensitive match, with one concession to how model names
/// actually look in the wild: a trailing `*` matches by prefix, so
/// `llama3.1:8b*` admits `llama3.1:8b-instruct-q4_K_M`. Matching is done here
/// in Rust rather than with SQL LIKE so a pattern can never be interpreted as
/// SQL, and `%`/`_` in a model name carry no special meaning.
pub(crate) fn model_matches(pattern: &str, model: &str) -> bool {
    let p = pattern.trim().to_lowercase();
    let m = model.trim().to_lowercase();
    if p.is_empty() || m.is_empty() {
        return false;
    }
    match p.strip_suffix('*') {
        // A bare "*" would allow everything, which defeats the point of an
        // allow-list — treat it as matching nothing rather than silently
        // disabling governance for the scope.
        Some("") => false,
        Some(prefix) => m.starts_with(prefix),
        None => p == m,
    }
}

/// Decide whether a model running on a node violates policy.
///
/// Returns `None` when compliant or ungoverned, or `Some(scope)` naming the
/// scope that governs the node ("fleet" or the tag) when it isn't.
///
/// A node is governed only if at least one policy applies to it — fleet-wide,
/// or carrying a tag some policy scopes to. That is what makes an empty
/// allow-list a no-op instead of a fleet-wide alarm.
pub(crate) fn model_policy_violation(
    model:    &str,
    tags:     &[String],
    policies: &[ModelPolicy],
) -> Option<String> {
    let applicable: Vec<&ModelPolicy> = policies.iter()
        .filter(|p| match &p.tag {
            None => true,
            Some(t) => {
                let t = t.trim().to_lowercase().replace(' ', "");
                tags.contains(&t)
            }
        })
        .collect();

    if applicable.is_empty() {
        return None; // ungoverned
    }
    if applicable.iter().any(|p| model_matches(&p.model, model)) {
        return None; // allowed
    }
    // Name the narrowest governing scope for the message: a tag if one governs
    // this node, otherwise the fleet-wide rule.
    let scope = applicable.iter()
        .find_map(|p| p.tag.clone())
        .unwrap_or_else(|| "fleet".to_string());
    Some(scope)
}

/// Check the node's active model against the tenant's allow-list.
///
/// Runs inside the telemetry push path next to evaluate_webhooks, so a
/// violation is caught on the frame the model appears rather than whenever a
/// report is next run. Flags once per (node, model) — see model_policy_state.
pub(crate) async fn evaluate_model_policy(
    tenant_id: &str,
    node_id:   &str,
    metrics:   &MetricsPayload,
    events_tx: &mpsc::Sender<EventRow>,
    pool:      &sqlx::PgPool,
) {
    let model = metrics.ollama_active_model.clone()
        .or_else(|| metrics.vllm_model_name.clone())
        .or_else(|| metrics.llamacpp_model_name.clone())
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty());

    let Some(model) = model else { return }; // nothing loaded — nothing to govern

    let policies: Vec<ModelPolicy> = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT model, tag FROM model_policies WHERE tenant_id = $1"
    ).bind(tenant_id).fetch_all(pool).await.unwrap_or_default()
     .into_iter().map(|(model, tag)| ModelPolicy { model, tag }).collect();

    if policies.is_empty() { return; } // governance not configured — fail safe

    let tags: Option<String> = sqlx::query_scalar("SELECT tags FROM nodes WHERE wk_id = $1")
        .bind(node_id).fetch_optional(pool).await.ok().flatten();
    let tags = normalize_tags(tags.as_deref());

    let verdict = model_policy_violation(&model, &tags, &policies);

    // Previously flagged model for this node, used to fire once per offence.
    let prev: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT last_model, last_flagged FROM model_policy_state WHERE tenant_id = $1 AND node_id = $2"
    ).bind(tenant_id).bind(node_id).fetch_optional(pool).await.unwrap_or(None);
    let (_last_model, last_flagged) = prev.unwrap_or((None, None));

    let now = now_ms() as i64;

    match verdict {
        Some(scope) => {
            let already = last_flagged.as_deref() == Some(model.as_str());
            if !already {
                let _ = sqlx::query(
                    "INSERT INTO model_policy_violations (tenant_id, node_id, model, scope, ts_ms)
                     VALUES ($1, $2, $3, $4, $5)"
                ).bind(tenant_id).bind(node_id).bind(&model).bind(&scope).bind(now)
                .execute(pool).await;

                let _ = events_tx.try_send(EventRow {
                    ts_ms:      now,
                    node_id:    node_id.to_string(),
                    tenant_id:  tenant_id.to_string(),
                    level:      "warn".to_string(),
                    event_type: Some("model_policy_violation".to_string()),
                    message:    format!("unapproved model '{model}' (scope: {scope})"),
                });
                println!("[governance] {node_id}: unapproved model {model:?} scope={scope}");
            }
            let _ = sqlx::query(
                "INSERT INTO model_policy_state (tenant_id, node_id, last_model, last_flagged, last_flagged_ms)
                 VALUES ($1, $2, $3, $3, $4)
                 ON CONFLICT (tenant_id, node_id) DO UPDATE
                   SET last_model = $3, last_flagged = $3, last_flagged_ms = $4"
            ).bind(tenant_id).bind(node_id).bind(&model).bind(now).execute(pool).await;
        }
        None => {
            // Compliant: clear last_flagged so a return to the unapproved model
            // is treated as a fresh offence.
            let _ = sqlx::query(
                "INSERT INTO model_policy_state (tenant_id, node_id, last_model, last_flagged, last_flagged_ms)
                 VALUES ($1, $2, $3, NULL, NULL)
                 ON CONFLICT (tenant_id, node_id) DO UPDATE
                   SET last_model = $3, last_flagged = NULL, last_flagged_ms = NULL"
            ).bind(tenant_id).bind(node_id).bind(&model).execute(pool).await;
        }
    }
}

#[cfg(test)]
mod model_governance_tests {
    use super::*;

    fn pol(model: &str, tag: Option<&str>) -> ModelPolicy {
        ModelPolicy { model: model.into(), tag: tag.map(|t| t.into()) }
    }

    #[test]
    fn empty_allowlist_governs_nothing() {
        // The fail-safe that makes this feature opt-in: with no policies, no
        // model is ever a violation.
        assert_eq!(model_policy_violation("anything:7b", &normalize_tags(Some("env:prod")), &[]), None);
    }

    #[test]
    fn fleet_wide_entry_governs_every_node() {
        let p = vec![pol("llama3.1:8b", None)];
        assert_eq!(model_policy_violation("llama3.1:8b", &[], &p), None);
        assert_eq!(model_policy_violation("mistral:7b", &[], &p), Some("fleet".into()));
    }

    #[test]
    fn tag_scoped_entry_leaves_untagged_nodes_ungoverned() {
        let p = vec![pol("llama3.1:8b", Some("env:prod"))];
        // Node carries the tag -> governed.
        assert_eq!(
            model_policy_violation("mistral:7b", &normalize_tags(Some("env:prod")), &p),
            Some("env:prod".into())
        );
        // Node does not -> untouched. A dev box must not inherit prod policy.
        assert_eq!(model_policy_violation("mistral:7b", &normalize_tags(Some("env:dev")), &p), None);
        assert_eq!(model_policy_violation("mistral:7b", &[], &p), None);
    }

    #[test]
    fn allowed_set_is_the_union_of_fleet_and_matching_tags() {
        let p = vec![pol("llama3.1:8b", None), pol("mistral:7b", Some("env:prod"))];
        let prod = normalize_tags(Some("env:prod"));
        assert_eq!(model_policy_violation("llama3.1:8b", &prod, &p), None, "fleet entry applies");
        assert_eq!(model_policy_violation("mistral:7b",  &prod, &p), None, "tag entry applies");
        assert!(model_policy_violation("qwen2.5:32b", &prod, &p).is_some());
        // On an untagged node only the fleet entry applies, so the prod-only
        // model is NOT allowed there.
        assert_eq!(model_policy_violation("mistral:7b", &[], &p), Some("fleet".into()));
    }

    #[test]
    fn matching_is_case_and_whitespace_insensitive() {
        assert!(model_matches("Llama3.1:8B", "llama3.1:8b"));
        assert!(model_matches("  llama3.1:8b  ", "llama3.1:8b"));
    }

    #[test]
    fn trailing_star_matches_by_prefix() {
        // Real fleets swap quants, so exact-only would be unusable.
        assert!(model_matches("llama3.1:8b*", "llama3.1:8b-instruct-q4_K_M"));
        assert!(model_matches("llama3.1:8b*", "llama3.1:8b"));
        assert!(!model_matches("llama3.1:8b*", "llama3.1:70b"));
    }

    #[test]
    fn bare_star_matches_nothing() {
        // Otherwise a single "*" row would quietly disable governance for the
        // scope while the UI still showed it as configured.
        assert!(!model_matches("*", "anything"));
        let p = vec![pol("*", None)];
        assert_eq!(model_policy_violation("anything", &[], &p), Some("fleet".into()));
    }

    #[test]
    fn sql_wildcards_in_model_names_are_literal() {
        // Matching happens in Rust, not via LIKE, so % and _ are not patterns.
        assert!(!model_matches("llama%", "llama3.1:8b"));
        assert!(!model_matches("llama_.1:8b", "llama3.1:8b"));
        assert!(model_matches("weird%name", "weird%name"));
    }

    #[test]
    fn empty_pattern_or_model_never_matches() {
        assert!(!model_matches("", "llama3.1:8b"));
        assert!(!model_matches("llama3.1:8b", ""));
        assert!(!model_matches("   ", "llama3.1:8b"));
    }

    #[test]
    fn tags_normalize_like_the_sql_filters_do() {
        assert_eq!(normalize_tags(Some("env:prod, Team:ML ,, ")), vec!["env:prod", "team:ml"]);
        assert_eq!(normalize_tags(None), Vec::<String>::new());
        assert_eq!(normalize_tags(Some("")), Vec::<String>::new());
        // Spaces inside a tag are stripped, matching replace(lower(tags),' ','').
        assert_eq!(normalize_tags(Some("env: prod")), vec!["env:prod"]);
    }

    #[test]
    fn tag_scope_matching_tolerates_spacing_in_the_policy() {
        let p = vec![pol("llama3.1:8b", Some("env: PROD "))];
        assert_eq!(
            model_policy_violation("mistral:7b", &normalize_tags(Some("env:prod")), &p),
            Some("env: PROD ".into()),
            "policy tag should match the node tag despite case/spacing"
        );
    }
}

#[cfg(test)]
mod csv_escape_tests {
    use super::*;

    #[test]
    fn plain_values_pass_through_unquoted() {
        assert_eq!(csv_escape("node.paired"), "node.paired");
        assert_eq!(csv_escape("WK-1a2b3c4d"), "WK-1a2b3c4d");
        assert_eq!(csv_escape(""), "");
    }

    #[test]
    fn rfc4180_quoting_for_commas_quotes_newlines() {
        assert_eq!(csv_escape("a,b"), "\"a,b\"");
        assert_eq!(csv_escape("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_escape("line1\nline2"), "\"line1\nline2\"");
        assert_eq!(csv_escape("cr\rhere"), "\"cr\rhere\"");
    }

    #[test]
    fn formula_injection_is_neutralized() {
        // A node display name like "=HYPERLINK(...)" must not execute when
        // the export is opened in Excel/Sheets.
        assert_eq!(csv_escape("=1+2"), "'=1+2");
        assert_eq!(csv_escape("+SUM(A1)"), "'+SUM(A1)");
        assert_eq!(csv_escape("-2+3"), "'-2+3");
        assert_eq!(csv_escape("@cmd"), "'@cmd");
        // Formula prefix + comma → apostrophe AND quoting compose.
        assert_eq!(csv_escape("=cmd,arg"), "\"'=cmd,arg\"");
    }
}
