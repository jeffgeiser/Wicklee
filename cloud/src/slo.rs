//! SLOs with error budgets.

use crate::*;

// ── SLOs with error budgets (Team+) ──────────────────────────────────────────

/// The three SLIs computable from cloud-side metrics_raw samples — latency,
/// throughput, efficiency. (Per-request percentiles live agent-side in
/// inference_traces; these are sampled-telemetry SLIs, documented as such.)
pub(crate) const SLO_METRICS: &[&str] = &["ttft_p95_ms", "tok_s_p50", "wes_p50"];

/// Direction of goodness per metric: TTFT is "at most", the rest "at least".
pub(crate) fn sli_ok(metric: &str, sli: f64, threshold: f64) -> bool {
    match metric {
        "ttft_p95_ms" => sli <= threshold,
        _             => sli >= threshold,
    }
}

/// Aggregate expression + sample filter per metric. tok_s/wes filter to >0 —
/// idle samples measure nothing being served and must not violate an SLO.
pub(crate) fn slo_metric_sql(metric: &str) -> (&'static str, &'static str) {
    match metric {
        "ttft_p95_ms" => ("percentile_cont(0.95) WITHIN GROUP (ORDER BY m.ttft_ms)",
                          "m.ttft_ms IS NOT NULL"),
        "tok_s_p50"   => ("percentile_cont(0.5) WITHIN GROUP (ORDER BY m.tok_s)",
                          "m.tok_s IS NOT NULL AND m.tok_s > 0"),
        _             => ("percentile_cont(0.5) WITHIN GROUP (ORDER BY m.wes_penalized)",
                          "m.wes_penalized IS NOT NULL AND m.wes_penalized > 0"),
    }
}

/// SLO evaluation window size (ms). Time-slice SLO: one verdict per bucket.
pub(crate) const SLO_WINDOW_MS: i64 = 300_000;
/// Rolling budget horizon: 30 days.
pub(crate) const SLO_BUDGET_MS: i64 = 30 * 24 * 3_600_000;
pub(crate) const MAX_SLOS_PER_TENANT: i64 = 20;

#[derive(Deserialize)]
pub(crate) struct CreateSloBody {
    pub(crate) name:       String,
    #[serde(default)]
    pub(crate) tag:        Option<String>,
    #[serde(default)]
    pub(crate) node_id:    Option<String>,
    pub(crate) metric:     String,
    pub(crate) threshold:  f64,
    pub(crate) target_pct: f64,
}

/// POST /api/slo (Team+, Member+) — define an SLO.
pub(crate) async fn handle_create_slo(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateSloBody>,
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
    if !is_team_or_above(&tier) {
        return upgrade_required("SLOs", UpgradePlan::Team);
    }

    let name = body.name.trim();
    if name.is_empty() || name.len() > 64 {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "name must be 1-64 chars" }))).into_response();
    }
    if !SLO_METRICS.contains(&body.metric.as_str()) {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": format!("metric must be one of: {}", SLO_METRICS.join(", ")) }))).into_response();
    }
    if !(body.threshold > 0.0 && body.threshold.is_finite()) {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "threshold must be > 0" }))).into_response();
    }
    if !(50.0..=99.99).contains(&body.target_pct) {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "target_pct must be 50..99.99" }))).into_response();
    }
    if let Some(ref t) = body.tag
        && !valid_scope_tag(t) {
            return (StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "tag must be 1-64 chars: letters, digits, : - _ ." }))).into_response();
        }

    let (_tcol, tval) = tenant_scope(&user_id, &org_id);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM slo_definitions WHERE tenant_id = $1")
        .bind(tval).fetch_one(&state.pool).await.unwrap_or(0);
    if count >= MAX_SLOS_PER_TENANT {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": format!("SLO limit reached ({MAX_SLOS_PER_TENANT} per fleet)") }))).into_response();
    }

    let id = Uuid::new_v4().to_string();
    let result = sqlx::query(
        "INSERT INTO slo_definitions (id, tenant_id, user_id, name, tag, node_id, metric, threshold, target_pct, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)"
    ).bind(&id).bind(tval).bind(&user_id).bind(name)
    .bind(&body.tag).bind(&body.node_id).bind(&body.metric)
    .bind(body.threshold).bind(body.target_pct).bind(now_ms() as i64)
    .execute(&state.pool).await;

    match result {
        Ok(_) => {
            audit(&state.pool, &user_id, &org_id, "slo.created", &id,
                serde_json::json!({ "name": name, "metric": &body.metric,
                    "threshold": body.threshold, "target_pct": body.target_pct,
                    "tag": &body.tag, "node_id": &body.node_id }));
            (StatusCode::CREATED, Json(serde_json::json!({
                "id": id, "name": name, "metric": body.metric,
                "threshold": body.threshold, "target_pct": body.target_pct,
                "tag": body.tag, "node_id": body.node_id, "enabled": true,
            }))).into_response()
        }
        Err(e) => { eprintln!("[slo] insert failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" }))).into_response() }
    }
}

/// GET /api/slo — definitions with live budget status: 30d compliance,
/// error-budget burn, and the most recent SLI window.
pub(crate) async fn handle_list_slos(
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
    if !is_team_or_above(&tier) {
        return upgrade_required("SLOs", UpgradePlan::Team);
    }

    let (_tcol, tval) = tenant_scope(&user_id, &org_id);
    let defs: Vec<(String, String, Option<String>, Option<String>, String, f64, f64, bool, i64)> = sqlx::query_as(
        "SELECT id, name, tag, node_id, metric, threshold, target_pct, enabled, created_at
         FROM slo_definitions WHERE tenant_id = $1 ORDER BY created_at ASC"
    ).bind(tval).fetch_all(&state.pool).await.unwrap_or_default();

    let budget_cutoff = now_ms() as i64 - SLO_BUDGET_MS;
    let mut out = Vec::with_capacity(defs.len());
    for (id, name, tag, node_id, metric, threshold, target_pct, enabled, created_at) in defs {
        let (total, bad): (i64, i64) = sqlx::query_as(
            "SELECT COUNT(*) FILTER (WHERE ok IS NOT NULL), COUNT(*) FILTER (WHERE ok = false)
             FROM slo_windows WHERE slo_id = $1 AND ts > $2"
        ).bind(&id).bind(budget_cutoff).fetch_one(&state.pool).await.unwrap_or((0, 0));
        let latest: Option<(i64, Option<f64>, Option<bool>)> = sqlx::query_as(
            "SELECT ts, sli_value, ok FROM slo_windows WHERE slo_id = $1 ORDER BY ts DESC LIMIT 1"
        ).bind(&id).fetch_optional(&state.pool).await.ok().flatten();

        let allowed = total as f64 * (1.0 - target_pct / 100.0);
        let burn_pct = if allowed > 0.0 { (bad as f64 / allowed) * 100.0 }
                       else if bad > 0 { 200.0 } else { 0.0 };
        let compliance_pct = if total > 0 { (total - bad) as f64 / total as f64 * 100.0 } else { 100.0 };

        out.push(serde_json::json!({
            "id": id, "name": name, "tag": tag, "node_id": node_id,
            "metric": metric, "threshold": threshold, "target_pct": target_pct,
            "enabled": enabled, "created_at": created_at,
            "windows_30d": total, "bad_30d": bad,
            "compliance_pct": compliance_pct, "burn_pct": burn_pct,
            "latest": latest.map(|(ts, sli, ok)| serde_json::json!({ "ts": ts, "sli": sli, "ok": ok })),
        }));
    }

    Json(serde_json::json!({ "slos": out })).into_response()
}

/// DELETE /api/slo/:id (Member+) — remove an SLO and its window history.
pub(crate) async fn handle_delete_slo(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slo_id): Path<String>,
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

    let (_tcol, tval) = tenant_scope(&user_id, &org_id);
    let result = sqlx::query("DELETE FROM slo_definitions WHERE id = $1 AND tenant_id = $2")
        .bind(&slo_id).bind(tval).execute(&state.pool).await;

    match result {
        Ok(r) if r.rows_affected() > 0 => {
            let _ = sqlx::query("DELETE FROM slo_windows WHERE slo_id = $1")
                .bind(&slo_id).execute(&state.pool).await;
            audit(&state.pool, &user_id, &org_id, "slo.deleted", &slo_id, serde_json::json!({}));
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Ok(_) => (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "SLO not found" }))).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" }))).into_response(),
    }
}

/// SLO evaluator — every 5 minutes, writes one time-slice verdict per enabled
/// SLO for the just-completed window, then checks error-budget burn and fires
/// one notification per threshold crossing (50/90/100%) to the SLO creator's
/// channels. Tier re-checked at evaluation so downgraded tenants stop burning
/// evaluation cycles.
pub(crate) async fn slo_evaluator_task(pool: sqlx::PgPool) {
    let mut interval = tokio::time::interval(Duration::from_secs(300));
    loop {
        interval.tick().await;
        let now = now_ms() as i64;
        let window_end   = (now / SLO_WINDOW_MS) * SLO_WINDOW_MS;
        let window_start = window_end - SLO_WINDOW_MS;

        let defs: Vec<(String, String, String, String, Option<String>, Option<String>, String, f64, f64, i16)> = sqlx::query_as(
            "SELECT id, tenant_id, user_id, name, tag, node_id, metric, threshold, target_pct, last_burn_notified
             FROM slo_definitions WHERE enabled = true"
        ).fetch_all(&pool).await.unwrap_or_default();

        for (id, tenant_id, user_id, name, tag, node_id, metric, threshold, target_pct, last_notified) in defs {
            let org_id = if tenant_id != user_id { Some(tenant_id.clone()) } else { None };
            let tier = resolve_tier(&user_id, &org_id, &pool).await;
            if !is_team_or_above(&tier) { continue; }

            // ── Compute the SLI for the just-completed window ──
            let (agg, filter) = slo_metric_sql(&metric);
            let sql = format!(
                "SELECT ({agg})::float8 FROM metrics_raw m
                 WHERE m.tenant_id = $1
                   AND m.ts >= to_timestamp($2::float8 / 1000.0)
                   AND m.ts <  to_timestamp($3::float8 / 1000.0)
                   AND {filter}
                   AND ($4::text IS NULL OR m.node_id = $4)
                   AND ($5::text IS NULL OR EXISTS(
                         SELECT 1 FROM nodes n WHERE n.wk_id = m.node_id
                           AND (',' || replace(lower(COALESCE(n.tags,'')), ' ', '') || ',')
                               LIKE ('%,' || replace(lower($5), ' ', '') || ',%')))");
            let sli: Option<f64> = sqlx::query_scalar(&sql)
                .bind(&tenant_id).bind(window_start).bind(window_end)
                .bind(&node_id).bind(&tag)
                .fetch_one(&pool).await.ok().flatten();
            let ok = sli.map(|v| sli_ok(&metric, v, threshold));

            let _ = sqlx::query(
                "INSERT INTO slo_windows (slo_id, ts, sli_value, ok) VALUES ($1, $2, $3, $4)
                 ON CONFLICT (slo_id, ts) DO NOTHING"
            ).bind(&id).bind(window_end).bind(sli).bind(ok)
            .execute(&pool).await;

            // ── Error-budget burn check (rolling 30d) ──
            let (total, bad): (i64, i64) = sqlx::query_as(
                "SELECT COUNT(*) FILTER (WHERE ok IS NOT NULL), COUNT(*) FILTER (WHERE ok = false)
                 FROM slo_windows WHERE slo_id = $1 AND ts > $2"
            ).bind(&id).bind(now - SLO_BUDGET_MS).fetch_one(&pool).await.unwrap_or((0, 0));
            let allowed = total as f64 * (1.0 - target_pct / 100.0);
            let burn = if allowed > 0.0 { (bad as f64 / allowed) * 100.0 }
                       else if bad > 0 { 200.0 } else { 0.0 };

            let level: i16 = if burn >= 100.0 { 100 } else if burn >= 90.0 { 90 } else if burn >= 50.0 { 50 } else { 0 };
            if level > last_notified {
                let scope = node_id.clone()
                    .or_else(|| tag.clone().map(|t| format!("tag {t}")))
                    .unwrap_or_else(|| "fleet".into());
                let detail = format!(
                    "SLO \"{name}\": error budget {burn:.0}% consumed — {bad} bad of {allowed:.0} allowed 5-min windows in the last 30 days ({metric} vs {threshold}, target {target_pct}%).");
                let channels: Vec<(String, String)> = sqlx::query_as(
                    "SELECT channel_type, config_json::text FROM notification_channels WHERE user_id = $1"
                ).bind(&user_id).fetch_all(&pool).await.unwrap_or_default();
                for (ct, cj) in channels {
                    let (ni, dt) = (scope.clone(), detail.clone());
                    tokio::task::spawn_blocking(move || { deliver_alert(&ct, &cj, &ni, "slo_budget_burn", &dt, false); });
                }
                eprintln!("[slo] budget burn {burn:.0}% on \"{name}\" (level {level})");
            }
            // Persist the level (also resets to 0 once burn recovers below 25%
            // as the rolling window ages bad slices out).
            let new_level: i16 = if burn < 25.0 { 0 } else { level.max(last_notified) };
            if new_level != last_notified {
                let _ = sqlx::query("UPDATE slo_definitions SET last_burn_notified = $1 WHERE id = $2")
                    .bind(new_level).bind(&id).execute(&pool).await;
            }
        }
    }
}

#[cfg(test)]
mod slo_tests {
    use super::*;

    #[test]
    fn sli_direction_per_metric() {
        // TTFT: lower is better — at or under threshold passes.
        assert!(sli_ok("ttft_p95_ms", 450.0, 500.0));
        assert!(sli_ok("ttft_p95_ms", 500.0, 500.0));
        assert!(!sli_ok("ttft_p95_ms", 501.0, 500.0));
        // Throughput / efficiency: higher is better.
        assert!(sli_ok("tok_s_p50", 25.0, 20.0));
        assert!(!sli_ok("tok_s_p50", 19.9, 20.0));
        assert!(sli_ok("wes_p50", 8.0, 8.0));
        assert!(!sli_ok("wes_p50", 7.9, 8.0));
    }

    #[test]
    fn every_metric_has_sql_and_appears_in_the_valid_set() {
        for m in SLO_METRICS {
            let (agg, filter) = slo_metric_sql(m);
            assert!(agg.contains("percentile_cont"), "{m} aggregate");
            assert!(filter.contains("IS NOT NULL"), "{m} filter");
        }
        // Creation validates membership, so unknown metric strings can't
        // reach slo_metric_sql's fallback arm at runtime.
        assert_eq!(SLO_METRICS.len(), 3);
    }
}
