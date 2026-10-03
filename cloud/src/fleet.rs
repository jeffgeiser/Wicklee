//! Dashboard fleet analytics: model aggregation, export, WES/metrics history, thermal budget, duty cycle, node naming and fleet config.

use crate::*;

// ── Fleet model aggregation endpoints (v0.9.0+) ─────────────────────────────
//
// These mirror the localhost `/api/model-comparison`, `/api/model-switches`,
// and `/api/cost-by-model` endpoints but aggregate across every node owned
// by the authenticated tenant. Response shapes match the localhost shape
// exactly so the frontend can re-use rendering logic verbatim.
//
// All three filter on `ollama_active_model IS NOT NULL`, so they will return
// empty arrays until new telemetry has been ingested under the new schema.

// Keep in sync with the frontend's ELECTRICITY_RATE_USD_PER_KWH
// (src/utils/efficiency.ts) and the agent's kwh_rate defaults — all 0.16.
pub(crate) const DEFAULT_KWH_RATE_USD: f32 = 0.16;

/// GET /api/v1/fleet/model-comparison?hours=168
/// Per-model rollup over the past N hours. Sourced from metrics_5min for the
/// long 7-day window (metrics_raw at 30s granularity is too heavy).
pub(crate) async fn handle_fleet_model_comparison(
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
    // metrics rows are keyed by tenant (org id for org fleets) — binding the
    // bare user_id returned permanently-empty responses for org users.
    let tenant_id = tenant_scope(&user_id, &org_id).1.to_string();

    let hours: i32 = params.get("hours")
        .and_then(|v| v.parse().ok())
        .unwrap_or(168)
        .clamp(1, 720); // 30 days max
    let kwh_rate = DEFAULT_KWH_RATE_USD;

    // Each 5-min bucket = 5/60 hours. Cost = avg_watts * hours_active * kwh_rate / 1000.
    let interval = format!("{hours} hours");
    let rows: Vec<(String, Option<f32>, Option<f32>, Option<f32>, Option<f64>, i64)> = sqlx::query_as(
        "SELECT
            ollama_active_model,
            AVG(tok_s_avg)::REAL          AS avg_tok_s,
            AVG(watts_avg)::REAL          AS avg_watts,
            AVG(wes_penalized_avg)::REAL  AS wes,
            (COUNT(*) * 5.0 / 60.0)::DOUBLE PRECISION AS hours_active,
            COUNT(*)::BIGINT              AS sample_count
         FROM metrics_5min
         WHERE tenant_id = $1
           AND ts > NOW() - $2::INTERVAL
           AND ollama_active_model IS NOT NULL
         GROUP BY ollama_active_model
         ORDER BY wes DESC NULLS LAST"
    )
    .bind(&tenant_id).bind(&interval)
    .fetch_all(&state.pool).await.unwrap_or_default();

    // TTFT lives in metrics_raw only; pull a side query for the rolling window
    // we still have raw data for (last 24h). For older windows TTFT will be null.
    let ttft_rows: Vec<(String, Option<f32>)> = sqlx::query_as(
        "SELECT ollama_active_model, AVG(ttft_ms)::REAL
         FROM metrics_raw
         WHERE tenant_id = $1
           AND ts > NOW() - INTERVAL '24 hours'
           AND ollama_active_model IS NOT NULL
           AND ttft_ms IS NOT NULL
         GROUP BY ollama_active_model"
    )
    .bind(&tenant_id)
    .fetch_all(&state.pool).await.unwrap_or_default();
    let ttft_map: HashMap<String, Option<f32>> = ttft_rows.into_iter().collect();

    let models: Vec<serde_json::Value> = rows.into_iter().map(|(model, tok_s, watts, wes, hours_active, samples)| {
        let hours_active = hours_active.unwrap_or(0.0);
        let total_cost = match watts {
            Some(w) if w > 0.0 => Some((w as f64) * hours_active * (kwh_rate as f64) / 1000.0),
            _ => None,
        };
        let cost_per_hour = match watts {
            Some(w) if w > 0.0 => Some((w as f64) * (kwh_rate as f64) / 1000.0),
            _ => None,
        };
        let avg_ttft = ttft_map.get(&model).copied().unwrap_or(None);
        serde_json::json!({
            "model":         model,
            "hours_active":  (hours_active * 100.0).round() / 100.0,
            "avg_tok_s":     tok_s,
            "avg_watts":     watts,
            "wes":           wes,
            "avg_ttft_ms":   avg_ttft,
            "cost_per_hour": cost_per_hour,
            "total_cost":    total_cost,
            "sample_count":  samples,
        })
    }).collect();

    Json(serde_json::json!({ "models": models })).into_response()
}

/// GET /api/v1/fleet/model-switches?hours=24
/// Model swap events across all nodes in the past N hours.
pub(crate) async fn handle_fleet_model_switches(
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
    // metrics rows are keyed by tenant (org id for org fleets) — binding the
    // bare user_id returned permanently-empty responses for org users.
    let tenant_id = tenant_scope(&user_id, &org_id).1.to_string();

    let hours: i32 = params.get("hours")
        .and_then(|v| v.parse().ok())
        .unwrap_or(24)
        .clamp(1, 168);
    let interval = format!("{hours} hours");

    // NOTE on typing: `to_model` is the un-cast `ollama_active_model` column
    // which Postgres considers nullable TEXT, so sqlx will refuse to decode
    // it into `String` even though the CTE filter guarantees NOT NULL at runtime.
    // We type it as Option<String> to satisfy sqlx, then unwrap unconditionally
    // at the json! step since the filter still applies. The prior version
    // failed silently because .unwrap_or_default() swallowed the decode error
    // and returned an empty Vec.
    let rows_result = sqlx::query_as::<_, (i64, String, Option<String>, Option<String>, Option<f64>)>(
        "WITH model_changes AS (
            SELECT
              ts,
              node_id,
              ollama_active_model AS to_model,
              LAG(ollama_active_model) OVER (PARTITION BY node_id ORDER BY ts) AS from_model,
              -- EXTRACT(EPOCH FROM interval) returns NUMERIC in modern Postgres;
              -- explicit cast to DOUBLE PRECISION so sqlx can decode into f64.
              (EXTRACT(EPOCH FROM ts - LAG(ts) OVER (PARTITION BY node_id ORDER BY ts)) * 1000)::DOUBLE PRECISION AS gap_ms
            FROM metrics_raw
            WHERE tenant_id = $1
              AND ts > NOW() - $2::INTERVAL
              AND ollama_active_model IS NOT NULL
         )
         SELECT
            (EXTRACT(EPOCH FROM ts) * 1000)::BIGINT AS ts_ms,
            node_id,
            from_model,
            to_model,
            gap_ms
         FROM model_changes
         WHERE from_model IS NOT NULL
           AND from_model <> to_model
         ORDER BY ts DESC
         LIMIT 200"
    )
    .bind(&tenant_id).bind(&interval)
    .fetch_all(&state.pool).await;

    let rows = match rows_result {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[fleet-model-switches] sqlx error: {e}");
            Vec::new()
        }
    };

    let total_swaps = rows.len() as i64;
    let total_gap_ms: f64 = rows.iter().filter_map(|(_, _, _, _, g)| *g).sum();
    let swaps: Vec<serde_json::Value> = rows.into_iter().map(|(ts_ms, node_id, from_model, to_model, gap_ms)| {
        serde_json::json!({
            "ts_ms":      ts_ms,
            "node_id":    node_id,
            "from_model": from_model,
            "to_model":   to_model.unwrap_or_default(),
            "gap_ms":     gap_ms.unwrap_or(0.0),
        })
    }).collect();

    Json(serde_json::json!({
        "swaps":            swaps,
        "total_swaps":      total_swaps,
        "total_gap_ms":     total_gap_ms,
        "total_gap_minutes": (total_gap_ms / 60_000.0 * 10.0).round() / 10.0,
    })).into_response()
}

/// Per-model cost over metrics_raw. Rows land every ~2 s (agent push
/// cadence), not 30 s: weight each row by its real duration (energy::raw_dt_sql) — dt is computed before the
/// model filter so a model's last row still sees the node's next row.
pub(crate) fn cost_by_model_sql() -> String {
    format!(
        "WITH raw AS (
            SELECT ollama_active_model, tok_s, watts, {dt} AS dt_s
            FROM metrics_raw
            WHERE tenant_id = $1
              AND ts > NOW() - $2::INTERVAL
         )
         SELECT
            ollama_active_model,
            AVG(tok_s)::REAL  AS tok_s_avg,
            AVG(watts)::REAL  AS avg_watts,
            (SUM(dt_s) / 3600.0)::DOUBLE PRECISION AS hours_active,
            (SUM(COALESCE(watts, 0) * dt_s) / 3600.0)::DOUBLE PRECISION AS energy_wh,
            COUNT(*)::BIGINT  AS sample_count
         FROM raw
         WHERE ollama_active_model IS NOT NULL
         GROUP BY ollama_active_model
         ORDER BY hours_active DESC",
        dt = raw_dt_sql())
}

/// GET /api/v1/fleet/cost-by-model?hours=24
/// Per-model cost rollup over the past N hours. Uses metrics_raw for
/// short windows (24h × ~12 nodes is manageable).
pub(crate) async fn handle_fleet_cost_by_model(
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
    // metrics rows are keyed by tenant (org id for org fleets) — binding the
    // bare user_id returned permanently-empty responses for org users.
    let tenant_id = tenant_scope(&user_id, &org_id).1.to_string();

    let hours: i32 = params.get("hours")
        .and_then(|v| v.parse().ok())
        .unwrap_or(24)
        .clamp(1, 168);
    let kwh_rate = DEFAULT_KWH_RATE_USD;
    let interval = format!("{hours} hours");

    let sql = cost_by_model_sql();
    let rows: Vec<(String, Option<f32>, Option<f32>, Option<f64>, Option<f64>, i64)> = sqlx::query_as(&sql)
    .bind(&tenant_id).bind(&interval)
    .fetch_all(&state.pool).await.unwrap_or_default();

    let mut total_cost_usd: f64 = 0.0;
    let models: Vec<serde_json::Value> = rows.into_iter().map(|(model, tok_s, watts, hours_active, energy_wh, samples)| {
        let hours_active = hours_active.unwrap_or(0.0);
        let cost_usd = energy_wh.unwrap_or(0.0).max(0.0) / 1000.0 * (kwh_rate as f64);
        total_cost_usd += cost_usd;
        serde_json::json!({
            "model":        model,
            "hours_active": (hours_active * 100.0).round() / 100.0,
            "avg_watts":    watts,
            "cost_usd":     cost_usd,
            "tok_s_avg":    tok_s,
            "sample_count": samples,
        })
    }).collect();

    Json(serde_json::json!({
        "models":         models,
        "total_cost_usd": total_cost_usd,
    })).into_response()
}

/// GET /api/fleet/export
pub(crate) async fn handle_fleet_export(
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

    // Export is Team+ only
    // Org-aware: org members are entitled by the org subscription.
    let tier = resolve_tier(&user_id, &org_id, &state.pool).await;
    if !is_team_or_above(&tier) {
        return upgrade_required("CSV/JSON export", UpgradePlan::Team);
    }

    let now_ms_val = now_ms() as i64;
    let from_ms: i64 = params.get("from").and_then(|v| v.parse().ok()).unwrap_or(now_ms_val - 24 * 60 * 60 * 1000);
    let to_ms: i64   = params.get("to").and_then(|v| v.parse().ok()).unwrap_or(now_ms_val);
    let limit: i64   = params.get("limit").and_then(|v| v.parse().ok()).unwrap_or(10_000).min(50_000);
    let format        = params.get("format").map(|s| s.as_str()).unwrap_or("csv").to_string();
    let node_filter   = params.get("node_id").cloned();

    let base = "SELECT (EXTRACT(EPOCH FROM ts) * 1000)::bigint AS ts_ms, node_id, level, event_type, message
                FROM node_events WHERE tenant_id = $1 AND ts >= to_timestamp($2::float8 / 1000.0) AND ts <= to_timestamp($3::float8 / 1000.0)";

    let events: Vec<(i64, String, String, Option<String>, String)> = match &node_filter {
        Some(nid) => {
            let sql = format!("{base} AND node_id = $4 ORDER BY ts DESC LIMIT $5");
            sqlx::query_as(&sql).bind(tenant_scope(&user_id, &org_id).1).bind(from_ms).bind(to_ms).bind(nid).bind(limit)
                .fetch_all(&state.pool).await.unwrap_or_default()
        }
        None => {
            let sql = format!("{base} ORDER BY ts DESC LIMIT $4");
            sqlx::query_as(&sql).bind(tenant_scope(&user_id, &org_id).1).bind(from_ms).bind(to_ms).bind(limit)
                .fetch_all(&state.pool).await.unwrap_or_default()
        }
    };

    if format == "json" {
        let json_events: Vec<serde_json::Value> = events.iter().map(|(ts_ms, node_id, level, event_type, message)| {
            let ts_str = format!("{}.{:03}", ts_ms / 1000, ts_ms % 1000);
            serde_json::json!({
                "ts_ms": ts_ms, "timestamp": ts_str, "record_type": "event",
                "node_id": node_id, "level": level, "event_type": event_type, "message": message,
            })
        }).collect();
        let body = serde_json::to_string_pretty(&json_events).unwrap_or_default();
        (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "application/json"),
             (axum::http::header::CONTENT_DISPOSITION, "attachment; filename=\"wicklee-fleet-export.json\"")],
            body,
        ).into_response()
    } else {
        let mut csv = String::from("timestamp,record_type,node_id,level,event_type,message\n");
        for (ts_ms, node_id, level, event_type, message) in &events {
            let ts_str = format!("{}.{:03}", ts_ms / 1000, ts_ms % 1000);
            csv.push_str(&format!("{},{},{},{},{},{}\n",
                ts_str, "event", node_id, level,
                event_type.as_deref().unwrap_or(""),
                message.replace(',', ";"),
            ));
        }
        (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "text/csv; charset=utf-8"),
             (axum::http::header::CONTENT_DISPOSITION, "attachment; filename=\"wicklee-fleet-export.csv\"")],
            csv,
        ).into_response()
    }
}

/// Helper for converting range to epoch-based bucket seconds (stock Postgres compatible).
pub(crate) fn time_bucket_for_range(range: &str) -> (i64, &str, bool) {
    // Returns (bucket_seconds, lookback_interval, use_raw)
    // Using epoch-based bucketing instead of TimescaleDB time_bucket()
    // so it works on stock Postgres without TimescaleDB extension.
    match range {
        "1h"  => (60,     "1 hour",   true),
        "24h" => (300,    "24 hours",  true),
        "7d"  => (1800,   "7 days",   false),
        "30d" => (7200,   "30 days",  false),
        "90d" => (21600,  "90 days",  false),
        _     => (300,    "24 hours",  true),
    }
}

/// GET /api/fleet/wes-history
pub(crate) async fn handle_wes_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let range = params.get("range").map(|s| s.as_str()).unwrap_or("24h").to_string();
    let node_id_filter = params.get("node_id").cloned();
    let (bucket_secs, lookback_interval, use_raw) = time_bucket_for_range(&range);

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let (user_id, org_id) = match require_user_and_org(&token, &state.pool, &clerk_keys).await {
        Some(v) => v,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    // Tier enforcement
    // Org-aware: org members are entitled by the org subscription.
    let tier = resolve_tier(&user_id, &org_id, &state.pool).await;

    // Was `match tier { "team" | "enterprise" => true, .. }`, which left
    // Business out of 30d/90d and would have left team_10 out too.
    let allowed = if is_team_or_above(&tier) { true }
        else if tier == "pro" { !matches!(range.as_str(), "30d" | "90d") }
        else { matches!(range.as_str(), "1h" | "24h") };
    if !allowed {
        return upgrade_required(&format!("Range '{range}'"), UpgradePlan::Team);
    }

    // Enumerate user's nodes
    let (tcol, tval) = tenant_scope(&user_id, &org_id);
    let node_rows: Vec<(String, Option<String>)> = sqlx::query_as(
        &format!("SELECT wk_id, hostname FROM nodes WHERE {tcol} = $1 ORDER BY last_seen DESC")
    ).bind(tval).fetch_all(&state.pool).await.unwrap_or_default();

    if node_rows.is_empty() {
        return Json(serde_json::json!({ "range": range, "nodes": [] })).into_response();
    }

    // Enrich hostnames from live cache
    let node_rows: Vec<(String, Option<String>)> = {
        let metrics_map = state.metrics.read().unwrap();
        node_rows.into_iter().map(|(nid, stored_hostname)| {
            let live_hostname = metrics_map.get(&nid)
                .and_then(|e| e.metrics.as_ref())
                .and_then(|m| m.hostname.clone());
            (nid, live_hostname.or(stored_hostname))
        }).collect()
    };

    let target_nodes: Vec<(String, Option<String>)> = match node_id_filter {
        Some(ref id) => {
            let found: Vec<_> = node_rows.into_iter().filter(|(nid, _)| nid == id).collect();
            if found.is_empty() {
                return (StatusCode::NOT_FOUND,
                    Json(serde_json::json!({ "error": "Node not found" }))).into_response();
            }
            found
        }
        None => node_rows,
    };

    let mut nodes_data: Vec<serde_json::Value> = Vec::new();

    for (node_id, hostname) in &target_nodes {
        let points: Vec<serde_json::Value> = if use_raw {
            let sql = format!(
                "SELECT (floor(EXTRACT(EPOCH FROM ts) / {bucket_secs}) * {bucket_secs} * 1000)::bigint AS bucket_ms,
                        AVG(wes_raw)       AS raw_wes,
                        AVG(wes_penalized) AS penalized_wes,
                        MAX(CASE thermal_state
                            WHEN 'Critical' THEN 3
                            WHEN 'Serious'  THEN 2
                            WHEN 'Fair'     THEN 1
                            ELSE 0 END)     AS thermal_rank
                 FROM metrics_raw
                 WHERE tenant_id = $1 AND node_id = $2 AND ts >= NOW() - INTERVAL '{lookback}'
                 GROUP BY bucket_ms ORDER BY bucket_ms",
                bucket_secs = bucket_secs, lookback = lookback_interval
            );
            sqlx::query_as::<_, (i64, Option<f64>, Option<f64>, Option<i32>)>(&sql)
                .bind(tval).bind(node_id)
                .fetch_all(&state.pool).await.unwrap_or_default()
                .into_iter().map(|(ts, rw, pw, tr)| {
                    let thermal = match tr { Some(3) => "Critical", Some(2) => "Serious", Some(1) => "Fair", _ => "Normal" };
                    serde_json::json!({ "ts_ms": ts, "raw_wes": rw, "penalized_wes": pw, "thermal_state": thermal })
                }).collect()
        } else {
            // metrics_5min only holds buckets older than 24h (run_rollup's
            // cutoff), so reading it alone left a permanent 24-hour hole at
            // the right edge of every 7d/30d/90d chart. UNION the raw tail
            // for the trailing day. Only the boundary bucket can mix
            // pre-averaged 5-min rows with raw rows (slight weighting skew
            // there — accepted vs. a missing day).
            let sql = format!(
                "SELECT (floor(EXTRACT(EPOCH FROM ts) / {bucket_secs}) * {bucket_secs} * 1000)::bigint AS bucket_ms,
                        AVG(raw)  AS raw_wes,
                        AVG(pen)  AS penalized_wes,
                        MAX(tr)   AS thermal_rank
                 FROM (
                     SELECT ts, wes_raw_avg AS raw, wes_penalized_avg AS pen,
                            CASE thermal_state_worst
                                WHEN 'Critical' THEN 3
                                WHEN 'Serious'  THEN 2
                                WHEN 'Fair'     THEN 1
                                ELSE 0 END AS tr
                     FROM metrics_5min
                     WHERE tenant_id = $1 AND node_id = $2 AND ts >= NOW() - INTERVAL '{lookback}'
                     UNION ALL
                     SELECT ts, wes_raw, wes_penalized,
                            CASE thermal_state
                                WHEN 'Critical' THEN 3
                                WHEN 'Serious'  THEN 2
                                WHEN 'Fair'     THEN 1
                                ELSE 0 END
                     FROM metrics_raw
                     WHERE tenant_id = $1 AND node_id = $2 AND ts >= NOW() - INTERVAL '24 hours'
                 ) u
                 GROUP BY bucket_ms ORDER BY bucket_ms",
                bucket_secs = bucket_secs, lookback = lookback_interval
            );
            sqlx::query_as::<_, (i64, Option<f64>, Option<f64>, Option<i32>)>(&sql)
                .bind(tval).bind(node_id)
                .fetch_all(&state.pool).await.unwrap_or_default()
                .into_iter().map(|(ts, rw, pw, tr)| {
                    let thermal = match tr { Some(3) => "Critical", Some(2) => "Serious", Some(1) => "Fair", _ => "Normal" };
                    serde_json::json!({ "ts_ms": ts, "raw_wes": rw, "penalized_wes": pw, "thermal_state": thermal })
                }).collect()
        };

        let display_hostname = hostname.clone().unwrap_or_else(|| node_id.clone());
        nodes_data.push(serde_json::json!({ "node_id": node_id, "hostname": display_hostname, "points": points }));
    }

    Json(serde_json::json!({ "range": range, "nodes": nodes_data })).into_response()
}

/// GET /api/v1/thermal-budget?node_id=X
///
/// Thermal Budget Calculator (Pro+).  Predicts when increased load
/// backfires — i.e. when pushing harder triggers a thermal transition
/// that lowers effective throughput more than the extra load gained.
///
/// Walks the 7-day metrics_5min rollup for the requested node, identifies
/// sustained Normal blocks and Normal→Fair/Serious transitions, and
/// computes:
///
///   sustainable_tps   — max tok/s held during any Normal block ≥ 30 min
///   push_threshold_tps — median tok/s during the 10-min window before
///                        any Normal→Fair transition
///   time_to_fair_min  — mean duration of Normal blocks that transitioned
///   fair_penalized_tps — push_threshold × 0.8 (1.25x thermal penalty)
///
/// Plus a plain-English advice string summarising whether pushing harder
/// produces more or fewer net tokens over a 1-hour window.
pub(crate) async fn handle_thermal_budget(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };
    let node_id = match params.get("node_id") {
        Some(id) if !id.is_empty() => id.clone(),
        _ => return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "node_id query param required" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let (user_id, org_id) = match require_user_and_org(&token, &state.pool, &clerk_keys).await {
        Some(v) => v,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    // Pro+ tier gate (uses 7-day Postgres history Pro tier buys).
    // Org-aware: org members are entitled by the org subscription.
    let tier = resolve_tier(&user_id, &org_id, &state.pool).await;
    if !is_pro_or_above(&tier) {
        return upgrade_required("Thermal Budget", UpgradePlan::Team);
    }

    // Verify ownership.
    let owns = node_in_tenant(&node_id, &user_id, &org_id, &state.pool).await;
    if !owns {
        return (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Node not found" }))).into_response();
    }

    // Tenant scope from the NODE row — the same rule telemetry writes with.
    // (The previous query selected org_id from `users`, a column that table
    // doesn't have; it errored on every call and fell back to user_id,
    // returning empty windows for org-paired nodes.)
    let tenant_id: String = node_tenant_id(&node_id, &state.pool).await
        .unwrap_or_else(|| user_id.clone());

    // Pull last 7 days of 5-min rollups in chronological order.
    let rows: Vec<(i64, Option<f32>, Option<f32>, Option<String>)> = sqlx::query_as(
        "SELECT (EXTRACT(EPOCH FROM ts) * 1000)::bigint AS ts_ms,
                tok_s_avg, watts_avg, thermal_state_worst
         FROM metrics_5min
         WHERE tenant_id = $1 AND node_id = $2
           AND ts >= NOW() - INTERVAL '7 days'
         ORDER BY ts ASC"
    ).bind(&tenant_id).bind(&node_id)
      .fetch_all(&state.pool).await.unwrap_or_default();

    if rows.len() < 12 {
        // Need at least ~1 hour of data to compute anything useful.
        return Json(serde_json::json!({
            "node_id": node_id,
            "samples_analyzed": rows.len(),
            "confidence": "insufficient",
            "advice": "Need at least 1 hour of telemetry across varying load to compute a thermal budget. Check back after the node has been running for a while.",
        })).into_response();
    }

    // Walk the samples to identify:
    //   - Sustained Normal blocks (≥6 consecutive samples = 30 min)
    //   - Normal→Fair/Serious/Critical transitions
    //
    // For each Normal block that ended in a transition, capture the median
    // tok/s of the trailing 2 samples (10 min) — that's the load level that
    // pushed the node into thermal trouble.
    #[derive(Default)]
    struct Block {
        end_idx: usize,
        len:     usize,
    }

    let mut sustained_normal_max_tps: f32 = 0.0;
    let mut sustained_normal_max_watts: f32 = 0.0;
    let mut transitions: Vec<(f32, f32, usize)> = Vec::new(); // (push_tps, push_watts, block_len_samples)
    let mut cur = Block::default();
    let mut in_normal = false;

    for (i, (_ts, tps, watts, thermal)) in rows.iter().enumerate() {
        let is_normal = thermal.as_deref().unwrap_or("Normal") == "Normal";
        if is_normal {
            if !in_normal {
                cur = Block { end_idx: i, len: 1 };
                in_normal = true;
            } else {
                cur.end_idx = i;
                cur.len += 1;
            }
            // Track sustainable_tps over Normal blocks ≥ 30 min.
            if cur.len >= 6 {
                if let Some(t) = tps && *t > sustained_normal_max_tps { sustained_normal_max_tps = *t; }
                if let Some(w) = watts && *w > sustained_normal_max_watts { sustained_normal_max_watts = *w; }
            }
        } else {
            // Non-Normal sample. If we were in a Normal block, this is a
            // transition. Capture the load level that pushed us out.
            if in_normal && cur.len >= 2 {
                // Median tok/s of the trailing 2 samples (10 min before transition).
                let tail_start = cur.end_idx.saturating_sub(1);
                let tail: Vec<f32> = rows[tail_start..=cur.end_idx]
                    .iter()
                    .filter_map(|(_t, tps, _w, _th)| *tps)
                    .collect();
                let tail_w: Vec<f32> = rows[tail_start..=cur.end_idx]
                    .iter()
                    .filter_map(|(_t, _tps, w, _th)| *w)
                    .collect();
                if !tail.is_empty() && !tail_w.is_empty() {
                    let push_tps = tail.iter().sum::<f32>() / tail.len() as f32;
                    let push_w   = tail_w.iter().sum::<f32>() / tail_w.len() as f32;
                    transitions.push((push_tps, push_w, cur.len));
                }
            }
            in_normal = false;
        }
    }

    let transitions_n = transitions.len();
    let push_threshold_tps: Option<f32> = if !transitions.is_empty() {
        let sum: f32 = transitions.iter().map(|(t, _, _)| *t).sum();
        Some(sum / transitions.len() as f32)
    } else { None };
    let push_threshold_watts: Option<f32> = if !transitions.is_empty() {
        let sum: f32 = transitions.iter().map(|(_, w, _)| *w).sum();
        Some(sum / transitions.len() as f32)
    } else { None };
    // Block length is in 5-min samples; convert to minutes.
    let time_to_fair_min: Option<f32> = if !transitions.is_empty() {
        let sum: usize = transitions.iter().map(|(_, _, l)| *l).sum();
        Some((sum as f32 / transitions.len() as f32) * 5.0)
    } else { None };

    let fair_penalized_tps: Option<f32> = push_threshold_tps.map(|t| t / 1.25);

    // Confidence — heuristic based on transitions observed and samples.
    let confidence = if transitions_n >= 4 && rows.len() >= 200 { "high" }
                     else if transitions_n >= 2 && rows.len() >= 100 { "medium" }
                     else if rows.len() >= 50 { "low" }
                     else { "insufficient" };

    // Generate advice. Compares 1-hour token output of "stay sustainable"
    // vs "push then drop to penalized" once a transition happens.
    let advice: String = match (push_threshold_tps, fair_penalized_tps, time_to_fair_min, sustained_normal_max_tps > 0.0) {
        (Some(push), Some(fair), Some(ttf), true) if ttf < 60.0 => {
            // Tokens over 1 hour at sustainable rate.
            let sustained_tokens = sustained_normal_max_tps as f64 * 3600.0;
            // Tokens over 1 hour pushing: push_tps for ttf min, then fair_penalized for remainder.
            let push_seconds = (ttf as f64 * 60.0).min(3600.0);
            let fair_seconds = (3600.0 - push_seconds).max(0.0);
            let push_tokens = push as f64 * push_seconds + fair as f64 * fair_seconds;
            let backfires = push_tokens < sustained_tokens;
            let pct_diff = ((push_tokens - sustained_tokens) / sustained_tokens) * 100.0;
            if backfires {
                format!(
                    "Sustainable rate: {:.0} tok/s indefinitely at Normal thermal. Pushing to {:.0} tok/s triggers Fair thermal within ~{:.0} min, dropping effective throughput to {:.0} tok/s. Net over 1 hour: pushing yields {:.0}% fewer tokens than holding the sustainable rate.",
                    sustained_normal_max_tps, push, ttf, fair, pct_diff.abs()
                )
            } else {
                format!(
                    "Sustainable rate: {:.0} tok/s indefinitely at Normal thermal. Pushing to {:.0} tok/s triggers Fair thermal within ~{:.0} min (drops to {:.0} tok/s). Over 1 hour, pushing still yields ~{:.0}% more tokens — but coherence and tail latency degrade with thermal Fair, so use cautiously.",
                    sustained_normal_max_tps, push, ttf, fair, pct_diff
                )
            }
        }
        (None, _, _, true) => format!(
            "Sustainable rate: {:.0} tok/s indefinitely at Normal thermal. No thermal transitions observed in the last 7 days — your workload stays comfortably below the budget ceiling.",
            sustained_normal_max_tps
        ),
        _ => "Insufficient data: need varied load (some Normal blocks, some thermal transitions) over the last 7 days to compute a budget.".to_string(),
    };

    Json(serde_json::json!({
        "node_id":              node_id,
        "samples_analyzed":     rows.len(),
        "transitions_detected": transitions_n,
        "confidence":           confidence,
        "sustainable_tps":      sustained_normal_max_tps,
        "sustainable_watts":    sustained_normal_max_watts,
        "push_threshold_tps":   push_threshold_tps,
        "push_threshold_watts": push_threshold_watts,
        "time_to_fair_min":     time_to_fair_min,
        "fair_penalized_tps":   fair_penalized_tps,
        "advice":               advice,
    })).into_response()
}

/// GET /api/fleet/metrics-history
pub(crate) async fn handle_metrics_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let range          = params.get("range").map(|s| s.as_str()).unwrap_or("24h").to_string();
    let node_id_filter = params.get("node_id").cloned();
    let (bucket_secs, lookback_interval, use_raw) = time_bucket_for_range(&range);

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let (user_id, org_id) = match require_user_and_org(&token, &state.pool, &clerk_keys).await {
        Some(v) => v,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    // Tier enforcement
    // Org-aware: org members are entitled by the org subscription.
    let tier = resolve_tier(&user_id, &org_id, &state.pool).await;

    // Was `match tier { "team" | "enterprise" => true, .. }`, which left
    // Business out of 30d/90d and would have left team_10 out too.
    let allowed = if is_team_or_above(&tier) { true }
        else if tier == "pro" { !matches!(range.as_str(), "30d" | "90d") }
        else { matches!(range.as_str(), "1h" | "24h") };
    if !allowed {
        return upgrade_required(&format!("Range '{range}'"), UpgradePlan::Team);
    }

    let (tcol, tval) = tenant_scope(&user_id, &org_id);
    let node_rows: Vec<(String, Option<String>)> = sqlx::query_as(
        &format!("SELECT wk_id, hostname FROM nodes WHERE {tcol} = $1 ORDER BY last_seen DESC")
    ).bind(tval).fetch_all(&state.pool).await.unwrap_or_default();

    if node_rows.is_empty() {
        return Json(serde_json::json!({ "range": range, "nodes": [] })).into_response();
    }

    let node_rows: Vec<(String, Option<String>)> = {
        let metrics_map = state.metrics.read().unwrap();
        node_rows.into_iter().map(|(nid, stored_hostname)| {
            let live_hostname = metrics_map.get(&nid)
                .and_then(|e| e.metrics.as_ref())
                .and_then(|m| m.hostname.clone());
            (nid, live_hostname.or(stored_hostname))
        }).collect()
    };

    let target_nodes: Vec<(String, Option<String>)> = match node_id_filter {
        Some(ref id) => {
            let found: Vec<_> = node_rows.into_iter().filter(|(nid, _)| nid == id).collect();
            if found.is_empty() {
                return (StatusCode::NOT_FOUND,
                    Json(serde_json::json!({ "error": "Node not found" }))).into_response();
            }
            found
        }
        None => node_rows,
    };

    let mut nodes_data: Vec<serde_json::Value> = Vec::new();

    for (node_id, hostname) in &target_nodes {
        let points: Vec<serde_json::Value> = if use_raw {
            let sql = format!(
                "SELECT (floor(EXTRACT(EPOCH FROM ts) / {bucket_secs}) * {bucket_secs} * 1000)::bigint AS bucket_ms,
                        AVG(tok_s)            AS tok_s,
                        NULL::float8          AS tok_s_p95,
                        AVG(watts)            AS watts,
                        AVG(gpu_pct)          AS gpu_pct,
                        AVG(mem_pressure_pct) AS mem_pct,
                        (SUM(CASE WHEN inference_state = 'live' THEN 1 ELSE 0 END)::float8 / NULLIF(COUNT(*), 0)::float8 * 100.0) AS duty_pct,
                        AVG(cpu_pct)          AS cpu_pct,
                        AVG(swap_write)       AS swap_write,
                        AVG(ttft_ms)          AS ttft_ms,
                        AVG(avg_latency_ms)   AS e2e_latency_ms,
                        AVG(wes_penalized)    AS wes_score
                 FROM metrics_raw
                 WHERE tenant_id = $1 AND node_id = $2 AND ts >= NOW() - INTERVAL '{lookback}'
                 GROUP BY bucket_ms ORDER BY bucket_ms",
                bucket_secs = bucket_secs, lookback = lookback_interval
            );
            sqlx::query_as::<_, (i64, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>)>(&sql)
                .bind(tval).bind(node_id)
                .fetch_all(&state.pool).await.unwrap_or_default()
                .into_iter().map(|(ts, toks, toksp95, w, gpu, mem, duty, cpu, swap, ttft, e2e, wes)| {
                    serde_json::json!({ "ts_ms": ts, "tok_s": toks, "tok_s_p95": toksp95, "watts": w, "gpu_pct": gpu, "mem_pct": mem, "duty_pct": duty, "cpu_pct": cpu, "swap_write": swap, "ttft_ms": ttft, "e2e_latency_ms": e2e, "wes_score": wes })
                }).collect()
        } else {
            // metrics_5min only holds buckets older than 24h (run_rollup's
            // cutoff) — UNION the raw tail so 7d/30d/90d charts don't have a
            // permanent 24-hour hole at the right edge. See handle_wes_history
            // for the boundary-bucket weighting caveat.
            let sql = format!(
                "SELECT (floor(EXTRACT(EPOCH FROM ts) / {bucket_secs}) * {bucket_secs} * 1000)::bigint AS bucket_ms,
                        AVG(tok_s)      AS tok_s,
                        AVG(tok_s_p95)  AS tok_s_p95,
                        AVG(watts)      AS watts,
                        AVG(gpu_pct)    AS gpu_pct,
                        AVG(mem_pct)    AS mem_pct,
                        AVG(duty_pct)   AS duty_pct,
                        NULL::float8    AS cpu_pct,
                        AVG(swap_write) AS swap_write,
                        NULL::float8    AS ttft_ms,
                        NULL::float8    AS e2e_latency_ms,
                        AVG(wes)        AS wes_score
                 FROM (
                     SELECT ts, tok_s_avg AS tok_s, tok_s_p95, watts_avg AS watts,
                            gpu_pct_avg AS gpu_pct, mem_pressure_pct_avg AS mem_pct,
                            inference_duty_pct AS duty_pct, swap_write_avg AS swap_write,
                            wes_penalized_avg AS wes
                     FROM metrics_5min
                     WHERE tenant_id = $1 AND node_id = $2 AND ts >= NOW() - INTERVAL '{lookback}'
                     UNION ALL
                     SELECT ts, tok_s, NULL::float8, watts,
                            gpu_pct, mem_pressure_pct,
                            (CASE WHEN inference_state = 'live' THEN 100.0 ELSE 0.0 END)::float8,
                            swap_write, wes_penalized
                     FROM metrics_raw
                     WHERE tenant_id = $1 AND node_id = $2 AND ts >= NOW() - INTERVAL '24 hours'
                 ) u
                 GROUP BY bucket_ms ORDER BY bucket_ms",
                bucket_secs = bucket_secs, lookback = lookback_interval
            );
            sqlx::query_as::<_, (i64, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>)>(&sql)
                .bind(tval).bind(node_id)
                .fetch_all(&state.pool).await.unwrap_or_default()
                .into_iter().map(|(ts, toks, toksp95, w, gpu, mem, duty, cpu, swap, ttft, e2e, wes)| {
                    serde_json::json!({ "ts_ms": ts, "tok_s": toks, "tok_s_p95": toksp95, "watts": w, "gpu_pct": gpu, "mem_pct": mem, "duty_pct": duty, "cpu_pct": cpu, "swap_write": swap, "ttft_ms": ttft, "e2e_latency_ms": e2e, "wes_score": wes })
                }).collect()
        };

        let display_hostname = hostname.clone().unwrap_or_else(|| node_id.clone());
        nodes_data.push(serde_json::json!({ "node_id": node_id, "hostname": display_hostname, "points": points }));
    }

    Json(serde_json::json!({ "range": range, "nodes": nodes_data })).into_response()
}

/// GET /api/fleet/duty
pub(crate) async fn handle_fleet_duty(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let range = params.get("range").map(|s| s.as_str()).unwrap_or("24h").to_string();
    let (_bucket, lookback_interval, use_raw) = time_bucket_for_range(&range);

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let (user_id, org_id) = match require_user_and_org(&token, &state.pool, &clerk_keys).await {
        Some(v) => v,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid token" }))).into_response(),
    };

    let (tcol, tval) = tenant_scope(&user_id, &org_id);
    let target_nodes: Vec<(String, Option<String>)> = sqlx::query_as(
        &format!("SELECT wk_id, hostname FROM nodes WHERE {tcol} = $1")
    ).bind(tval).fetch_all(&state.pool).await.unwrap_or_default();

    if target_nodes.is_empty() {
        return Json(serde_json::json!({ "range": range, "duty_pct": null, "total_samples": 0, "live_samples": 0, "nodes": [] })).into_response();
    }

    let mut per_node = Vec::new();
    let mut total_all: i64 = 0;
    let mut live_all: i64 = 0;

    for (nid, hostname) in &target_nodes {
        let (total, live): (i64, i64) = if use_raw {
            let sql = format!(
                "SELECT COUNT(*) AS total,
                        SUM(CASE WHEN inference_state = 'live' THEN 1 ELSE 0 END) AS live_count
                 FROM metrics_raw
                 WHERE tenant_id = $1 AND node_id = $2 AND ts >= NOW() - INTERVAL '{lookback}'",
                lookback = lookback_interval
            );
            sqlx::query_as::<_, (i64, i64)>(&sql)
                .bind(tval).bind(nid)
                .fetch_one(&state.pool).await.unwrap_or((0, 0))
        } else {
            let sql = format!(
                "SELECT COALESCE(SUM(sample_count), 0) AS total,
                        COALESCE(SUM((inference_duty_pct * sample_count / 100.0)::bigint), 0) AS live_count
                 FROM metrics_5min
                 WHERE tenant_id = $1 AND node_id = $2 AND ts >= NOW() - INTERVAL '{lookback}'",
                lookback = lookback_interval
            );
            sqlx::query_as::<_, (i64, i64)>(&sql)
                .bind(tval).bind(nid)
                .fetch_one(&state.pool).await.unwrap_or((0, 0))
        };

        let duty_pct = if total > 0 { Some((live as f64 / total as f64) * 100.0) } else { None };
        let display_hostname = hostname.clone().unwrap_or_else(|| nid.clone());
        per_node.push(serde_json::json!({
            "node_id": nid, "hostname": display_hostname,
            "duty_pct": duty_pct.map(|d| (d * 10.0).round() / 10.0),
        }));
        total_all += total;
        live_all  += live;
    }

    let fleet_duty = if total_all > 0 {
        Some(((live_all as f64 / total_all as f64) * 1000.0).round() / 10.0)
    } else { None };

    Json(serde_json::json!({
        "range": range, "duty_pct": fleet_duty,
        "total_samples": total_all, "live_samples": live_all, "nodes": per_node,
    })).into_response()
}

// ── Node naming (Pro+) ───────────────────────────────────────────────────────

#[derive(Deserialize)]
pub(crate) struct UpdateNodeRequest {
    pub(crate) display_name: Option<String>,
    pub(crate) tags: Option<String>,
    /// Desired deployment profile ("sovereign_dev" | "dedicated_server" |
    /// "production_fleet"; empty string clears → agent keeps local choice).
    pub(crate) desired_profile: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct FleetConfigBody {
    pub(crate) tag:             String,
    /// Empty string clears the desired profile for the matched nodes.
    pub(crate) desired_profile: String,
}

/// POST /api/fleet/config (Team+, Member+) — apply a desired deployment
/// profile to every node bearing a tag. The natural bulk form of the
/// per-node PATCH: "all env:prod nodes run production_fleet."
pub(crate) async fn handle_fleet_config_apply(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<FleetConfigBody>,
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
        return upgrade_required("Fleet config management", UpgradePlan::Team);
    }

    if !valid_scope_tag(&body.tag) {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "tag must be 1-64 chars: letters, digits, : - _ ." }))).into_response();
    }
    let dp = body.desired_profile.trim();
    if !dp.is_empty()
        && !matches!(dp, "sovereign_dev" | "dedicated_server" | "production_fleet") {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "desired_profile must be sovereign_dev, dedicated_server, production_fleet, or empty to clear" }))).into_response();
    }
    let val = if dp.is_empty() { None } else { Some(dp.to_string()) };

    let (tcol, tval) = tenant_scope(&user_id, &org_id);
    let sql = format!(
        "UPDATE nodes SET desired_profile = $1
         WHERE {tcol} = $2
           AND (',' || replace(lower(COALESCE(tags,'')), ' ', '') || ',')
               LIKE ('%,' || replace(lower($3), ' ', '') || ',%')");
    let result = sqlx::query(&sql).bind(&val).bind(tval).bind(&body.tag)
        .execute(&state.pool).await;

    match result {
        Ok(r) => {
            let count = r.rows_affected();
            audit(&state.pool, &user_id, &org_id, "fleet_config.applied", &body.tag,
                serde_json::json!({ "desired_profile": &val, "nodes_affected": count }));
            Json(serde_json::json!({ "nodes_affected": count, "tag": body.tag, "desired_profile": val })).into_response()
        }
        Err(e) => { eprintln!("[fleet-config] update failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" }))).into_response() }
    }
}

/// PATCH /api/nodes/:node_id — update display name and/or tags (Pro+ only)
pub(crate) async fn handle_update_node(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(node_id): axum::extract::Path<String>,
    Json(body): Json<UpdateNodeRequest>,
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
        return upgrade_required("Node naming", UpgradePlan::Team);
    }

    // Verify the node belongs to this user
    let owns = node_in_tenant(&node_id, &user_id, &org_id, &state.pool).await;
    if !owns {
        return (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Node not found" }))).into_response();
    }

    if let Some(ref name) = body.display_name {
        let trimmed = name.trim();
        if trimmed.len() > 64 {
            return (StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "Display name must be 64 characters or fewer" }))).into_response();
        }
        let val = if trimmed.is_empty() { None } else { Some(trimmed.to_string()) };
        let _ = sqlx::query("UPDATE nodes SET display_name = $1 WHERE wk_id = $2")
            .bind(&val).bind(&node_id).execute(&state.pool).await;
    }
    if let Some(ref tags) = body.tags {
        let trimmed = tags.trim();
        let val = if trimmed.is_empty() { None } else { Some(trimmed.to_string()) };
        let _ = sqlx::query("UPDATE nodes SET tags = $1 WHERE wk_id = $2")
            .bind(&val).bind(&node_id).execute(&state.pool).await;
    }
    if let Some(ref dp) = body.desired_profile {
        let trimmed = dp.trim();
        if !trimmed.is_empty()
            && !matches!(trimmed, "sovereign_dev" | "dedicated_server" | "production_fleet") {
            return (StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "desired_profile must be sovereign_dev, dedicated_server, production_fleet, or empty to clear" }))).into_response();
        }
        let val = if trimmed.is_empty() { None } else { Some(trimmed.to_string()) };
        let _ = sqlx::query("UPDATE nodes SET desired_profile = $1 WHERE wk_id = $2")
            .bind(&val).bind(&node_id).execute(&state.pool).await;
    }

    // Return updated node info
    let row: Option<(String, Option<String>, Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT wk_id, hostname, display_name, tags, desired_profile FROM nodes WHERE wk_id = $1"
    ).bind(&node_id).fetch_optional(&state.pool).await.ok().flatten();

    match row {
        Some((wk_id, hostname, display_name, tags, desired_profile)) => {
            audit(&state.pool, &user_id, &org_id, "node.updated", &node_id,
                serde_json::json!({ "display_name": &display_name, "tags": &tags, "desired_profile": &desired_profile }));
            Json(serde_json::json!({
                "node_id": wk_id,
                "hostname": hostname,
                "display_name": display_name,
                "tags": tags,
                "desired_profile": desired_profile,
            })).into_response()
        }
        None => (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Node not found" }))).into_response(),
    }
}
