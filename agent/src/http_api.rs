//! Localhost HTTP API handlers: history/traces/events/export/dismiss, intelligence endpoints, tags/health/metrics SSE, static assets.
//! Split out of main.rs; items are pub(crate) and re-exported at the crate root.

use super::*;

// ── Embedded Frontend ─────────────────────────────────────────────────────────

#[derive(RustEmbed)]
#[folder = "frontend/dist"]
pub(crate) struct StaticAssets;

// ── Response Types ────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub(crate) struct TagsResponse { pub(crate) models: Vec<ModelInfo> }

#[derive(Serialize)]
pub(crate) struct ModelInfo { pub(crate) name: String, pub(crate) size: u64 }

/// GET /api/deployment-profile — current profile + the selectable set with
/// the coherent tuning each applies. Localhost/agent-only (no auth).
pub(crate) async fn handle_get_deployment_profile(
    axum::extract::Extension(profile): axum::extract::Extension<Arc<Mutex<DeploymentProfile>>>,
) -> Json<serde_json::Value> {
    let current = profile.lock().map(|p| *p).unwrap_or(DeploymentProfile::DedicatedServer);
    let describe = |p: DeploymentProfile| {
        let t = p.tuning();
        serde_json::json!({
            "id": p.as_str(),
            "density_scale": t.density_scale,
            "evidence_ratio": t.evidence_ratio,
            "min_confidence": t.min_confidence,
        })
    };
    Json(serde_json::json!({
        "profile": current.as_str(),
        "available": [
            describe(DeploymentProfile::SovereignDev),
            describe(DeploymentProfile::DedicatedServer),
            describe(DeploymentProfile::ProductionFleet),
        ],
    }))
}

#[derive(Deserialize)]
pub(crate) struct SetProfileBody { pub(crate) profile: String }

/// PUT /api/deployment-profile — switch the active profile. Validates against
/// the known set, updates the shared state (the 10 s evaluator picks it up on
/// its next tick), and persists to config.toml so it survives restart.
pub(crate) async fn handle_put_deployment_profile(
    axum::extract::Extension(profile): axum::extract::Extension<Arc<Mutex<DeploymentProfile>>>,
    Json(body): Json<SetProfileBody>,
) -> impl axum::response::IntoResponse {
    let valid = matches!(body.profile.as_str(),
        "sovereign_dev" | "dedicated_server" | "production_fleet");
    if !valid {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "error": "profile must be sovereign_dev, dedicated_server, or production_fleet",
        }))).into_response();
    }
    let next = DeploymentProfile::from_config(Some(&body.profile));
    if let Ok(mut p) = profile.lock() { *p = next; }
    let persisted = next.as_str().to_string();
    update_config(|cfg| { cfg.deployment_profile = Some(persisted); });
    Json(serde_json::json!({ "profile": next.as_str() })).into_response()
}

// ── API Handlers ──────────────────────────────────────────────────────────────

// ── /api/history ─────────────────────────────────────────────────────────────
// Returns historical metric samples from the local DuckDB store.
//
// Query parameters:
//   node_id    — required; the node to query
//   from       — Unix ms; default = now - 1h
//   to         — Unix ms; default = now
//   resolution — "raw" | "1min" | "1hr" | "auto" (default)
//
// Resolution "auto" picks the best tier for the window width:
//   < 2h  → raw (1-Hz samples)
//   < 7d  → 1-minute aggregates
//   else  → 1-hour aggregates
//
// Not available on musl targets (DuckDB bundled C++ unsupported there).

#[cfg(not(target_env = "musl"))]
#[derive(serde::Deserialize)]
pub(crate) struct HistoryQuery {
    pub(crate) node_id:    Option<String>,
    pub(crate) from:       Option<i64>,
    pub(crate) to:         Option<i64>,
    pub(crate) resolution: Option<String>,
}

#[cfg(not(target_env = "musl"))]
pub(crate) async fn handle_history(
    axum::extract::Query(q): axum::extract::Query<HistoryQuery>,
    axum::extract::Extension(store): axum::extract::Extension<store::Store>,
) -> impl IntoResponse {
    use axum::http::StatusCode;

    let node_id = match q.node_id {
        Some(n) if !n.is_empty() => n,
        _ => return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "node_id query parameter is required" })),
        ).into_response(),
    };

    let now    = now_ms() as i64;
    let from   = q.from.unwrap_or(now - 3_600_000);  // default: last hour
    let to     = q.to.unwrap_or(now);

    // Parse resolution; "auto" and unknown strings both fall back to auto.
    let res = q.resolution
        .as_deref()
        .filter(|s| *s != "auto")
        .and_then(|s| s.parse::<store::Resolution>().ok())
        .unwrap_or_else(|| store::Resolution::auto(from, to));

    match tokio::task::spawn_blocking(move || store.query_history(&node_id, from, to, res)).await {
        Ok(Ok(resp))  => Json(resp).into_response(),
        Ok(Err(e))    => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        ).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        ).into_response(),
    }
}

// ── /api/traces ──────────────────────────────────────────────────────────────
// Returns recent inference traces from the local DuckDB store.
// Query parameters: node_id (optional), limit (optional, default 100, max 500).

#[cfg(not(target_env = "musl"))]
#[derive(serde::Deserialize)]
pub(crate) struct TracesQuery {
    pub(crate) node_id: Option<String>,
    pub(crate) limit: Option<i64>,
}

#[cfg(not(target_env = "musl"))]
pub(crate) async fn handle_traces(
    axum::extract::Query(q): axum::extract::Query<TracesQuery>,
    axum::extract::Extension(store): axum::extract::Extension<store::Store>,
) -> impl IntoResponse {
    use axum::http::StatusCode;

    let limit = q.limit.unwrap_or(100).min(500);
    let node_id_owned = q.node_id;
    match tokio::task::spawn_blocking(move || store.query_traces(node_id_owned.as_deref(), limit)).await {
        Ok(Ok(traces)) => Json(traces).into_response(),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("trace query failed: {e}"),
        ).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("task join failed: {e}"),
        ).into_response(),
    }
}

// ── Event history endpoint ────────────────────────────────────────────────────
//
// GET /api/events/history — paginated, persisted Live Activity events from DuckDB.

#[cfg(not(target_env = "musl"))]
#[derive(Deserialize)]
pub(crate) struct EventHistoryQuery {
    pub(crate) limit:      Option<i64>,
    pub(crate) before:     Option<i64>,
    pub(crate) event_type: Option<String>,
}

#[cfg(not(target_env = "musl"))]
pub(crate) async fn handle_events_history(
    axum::extract::Query(q): axum::extract::Query<EventHistoryQuery>,
    axum::extract::Extension(store): axum::extract::Extension<store::Store>,
) -> impl IntoResponse {
    use axum::http::StatusCode;

    let limit = q.limit.unwrap_or(50).min(200);
    let before = q.before;
    let event_type = q.event_type;
    match tokio::task::spawn_blocking(move || {
        store.query_events(limit, before, event_type.as_deref())
    }).await {
        Ok(Ok(events)) => Json(serde_json::json!({ "events": events })).into_response(),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("event query failed: {e}"),
        ).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("task join failed: {e}"),
        ).into_response(),
    }
}

// ── Audit Log Export ─────────────────────────────────────────────────────────
//
// GET /api/export — download a unified audit log (events + traces + dismissals)
// as CSV or JSON. Joins all three DuckDB audit tables into flat records.

#[cfg(not(target_env = "musl"))]
#[derive(Deserialize)]
pub(crate) struct ExportQuery {
    pub(crate) format: Option<String>,   // "csv" (default) or "json"
    pub(crate) from:   Option<i64>,      // start ts_ms (default: 24h ago)
    pub(crate) to:     Option<i64>,      // end ts_ms (default: now)
    pub(crate) limit:  Option<i64>,      // max records (default: 10000, max: 50000)
}

#[cfg(not(target_env = "musl"))]
pub(crate) async fn handle_export(
    axum::extract::Query(q): axum::extract::Query<ExportQuery>,
    axum::extract::Extension(store): axum::extract::Extension<store::Store>,
) -> impl IntoResponse {
    use axum::http::{StatusCode, header};

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let from_ms = q.from.unwrap_or(now_ms - 24 * 60 * 60 * 1000);
    let to_ms   = q.to.unwrap_or(now_ms);
    let limit   = q.limit.unwrap_or(10_000).min(50_000);
    let format  = q.format.as_deref().unwrap_or("csv");

    let records = match tokio::task::spawn_blocking(move || {
        store.export_audit_log(from_ms, to_ms, limit)
    }).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            let msg = format!("{e}");
            if msg.contains("Permission denied") {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({
                        "error": "Database access denied. Run: sudo chown -R $USER /etc/wicklee/"
                    })),
                ).into_response();
            }
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("Export failed: {msg}") })),
            ).into_response();
        }
        Err(e) => return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("Task join failed: {e}") })),
        ).into_response(),
    };

    let node_id = System::host_name().unwrap_or_else(|| "node".to_string());
    // Correct civil date (UTC) from system time — no chrono needed.
    // Howard Hinnant's days-from-epoch → y/m/d algorithm; exact across leap years.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = (secs / 86400) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;                                   // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y_civil = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);             // [0, 365]
    let mp = (5 * doy + 2) / 153;                                  // [0, 11]
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;               // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;          // [1, 12]
    let y = if m <= 2 { y_civil + 1 } else { y_civil };
    let date = format!("{y}-{m:02}-{day:02}");
    let filename = format!("wicklee-audit-{node_id}-{date}");

    if format == "json" {
        let body = serde_json::to_string_pretty(&records).unwrap_or_default();
        (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "application/json"),
                (header::CONTENT_DISPOSITION, &format!("attachment; filename=\"{filename}.json\"")),
            ],
            body,
        ).into_response()
    } else {
        // CSV
        let mut csv = String::from("timestamp,record_type,node_id,level,event_type,message,model,latency_ms,ttft_ms,tpot_ms\n");
        for r in &records {
            csv.push_str(&format!(
                "{},{},{},{},{},{},{},{},{},{}\n",
                r.timestamp,
                r.record_type,
                csv_escape(&r.node_id),
                r.level,
                r.event_type.as_deref().unwrap_or(""),
                csv_escape(&r.message),
                r.model.as_deref().unwrap_or(""),
                r.latency_ms.map(|v| format!("{v:.1}")).unwrap_or_default(),
                r.ttft_ms.map(|v| format!("{v:.1}")).unwrap_or_default(),
                r.tpot_ms.map(|v| format!("{v:.1}")).unwrap_or_default(),
            ));
        }
        (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "text/csv; charset=utf-8"),
                (header::CONTENT_DISPOSITION, &format!("attachment; filename=\"{filename}.csv\"")),
            ],
            csv,
        ).into_response()
    }
}

/// Escape a string for CSV: wrap in double quotes if it contains commas,
/// quotes, or newlines. Double any existing double quotes.
#[cfg(not(target_env = "musl"))]
pub(crate) fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

// ── Insight dismiss endpoints ─────────────────────────────────────────────────
//
// POST /api/insights/dismiss  — persist a dismiss decision for a pattern.
// GET  /api/insights/dismissed — return all active (non-expired) dismissals.
//
// Both are gated on `#[cfg(not(target_env = "musl"))]` because they require
// the DuckDB store.  musl builds (e.g., ARM Linux static) use localStorage-
// only dismissals and never call these endpoints.

#[cfg(not(target_env = "musl"))]
#[derive(serde::Deserialize)]
pub(crate) struct DismissRequest {
    /// Pattern identifier, e.g. "bandwidth_saturation".
    pub(crate) pattern_id:    String,
    /// Node-scoped dismissal. Pass null/omit for fleet-wide suppression.
    pub(crate) node_id:       Option<String>,
    /// Epoch ms at which this dismissal expires.  Default: now + 24 h.
    pub(crate) expires_at_ms: Option<i64>,
    /// Optional operator note ("resolved by restarting ollama", etc.)
    pub(crate) note:          Option<String>,
}

#[cfg(not(target_env = "musl"))]
pub(crate) async fn handle_dismiss(
    axum::extract::Extension(store): axum::extract::Extension<store::Store>,
    axum::extract::Json(body): axum::extract::Json<DismissRequest>,
) -> impl IntoResponse {
    use axum::http::StatusCode;

    if body.pattern_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "pattern_id is required" })),
        ).into_response();
    }

    let now_ms       = now_ms() as i64;
    let expires_at   = body.expires_at_ms.unwrap_or(now_ms + 24 * 60 * 60 * 1_000);
    let node_id      = body.node_id.unwrap_or_default();
    let pattern_id   = body.pattern_id;
    let note         = body.note;

    match tokio::task::spawn_blocking(move || {
        store.record_dismiss(
            &pattern_id,
            &node_id,
            now_ms,
            expires_at,
            note.as_deref(),
        )
    }).await {
        Ok(Ok(())) => (
            StatusCode::ACCEPTED,
            Json(serde_json::json!({ "ok": true, "expires_at_ms": expires_at })),
        ).into_response(),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        ).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        ).into_response(),
    }
}

#[cfg(not(target_env = "musl"))]
pub(crate) async fn handle_dismissed_list(
    axum::extract::Extension(store): axum::extract::Extension<store::Store>,
) -> impl IntoResponse {
    use axum::http::StatusCode;

    let now_ms = now_ms() as i64;

    match tokio::task::spawn_blocking(move || store.query_active_dismissals(now_ms)).await {
        Ok(Ok(dismissals)) => Json(serde_json::json!({ "dismissals": dismissals })).into_response(),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        ).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        ).into_response(),
    }
}

// ── Inference Intelligence endpoints (Pro+) ─────────────────────────────────

/// GET /api/sla?window_min=60&model=&target_ttft_ms=500 — Inference SLA Monitor.
///
/// Aggregates per-request inference traces from DuckDB into p50/p95/p99/max
/// percentiles for TTFT, end-to-end latency, and TPOT.  Computes compliance
/// against a configurable TTFT target and returns the 20 most-recent
/// violations plus a per-model breakdown.
///
/// Window: 1–1440 minutes (24 h hard ceiling — that's the inference_traces
/// retention).  `model` filters to a specific model name; `target_ttft_ms`
/// defaults to 500.
///
/// Tier policy: localhost endpoint open (local data, local user — same as
/// `/api/observations`).  The Pro gate sits on the frontend SLA Monitor card.
#[cfg(not(target_env = "musl"))]
pub(crate) async fn handle_sla(
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
    axum::extract::Extension(store): axum::extract::Extension<store::Store>,
    axum::extract::Extension(node_id_ext): axum::extract::Extension<NodeId>,
) -> impl IntoResponse {
    let window_min: i64 = params.get("window_min")
        .and_then(|v| v.parse().ok())
        .unwrap_or(60)
        .clamp(1, 1440);
    let target_ttft_ms: i64 = params.get("target_ttft_ms")
        .and_then(|v| v.parse().ok())
        .unwrap_or(500)
        .max(1);
    let model = params.get("model").cloned().filter(|s| !s.is_empty());
    let node_id = node_id_ext.0.as_str().to_owned();

    let result = tokio::task::spawn_blocking(move || {
        store.query_sla(&node_id, window_min, model.as_deref(), target_ttft_ms)
    }).await;

    match result {
        Ok(Ok(summary)) => Json(summary).into_response(),
        Ok(Err(e)) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        ).into_response(),
        Err(e) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        ).into_response(),
    }
}

/// GET /api/profile?minutes=60 — correlated inference profiler timeline.
#[cfg(not(target_env = "musl"))]
pub(crate) async fn handle_profile(
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
    axum::extract::Extension(store): axum::extract::Extension<store::Store>,
    axum::extract::Extension(node_id_ext): axum::extract::Extension<NodeId>,
) -> impl IntoResponse {
    let minutes: i64 = params.get("minutes").and_then(|v| v.parse().ok()).unwrap_or(60).min(1440);
    let node_id = node_id_ext.0.as_str().to_owned();
    let result = tokio::task::spawn_blocking(move || store.query_profile(&node_id, minutes)).await;
    match result {
        Ok(Ok(samples)) => {
            let resolution_s = if minutes <= 10 { 1 } else if minutes <= 60 { 10 } else if minutes <= 360 { 30 } else { 60 };
            Json(serde_json::json!({ "node_id": node_id_ext.0.as_str(), "range_minutes": minutes, "resolution_s": resolution_s, "samples": samples })).into_response()
        }
        Ok(Err(e)) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
        Err(e) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

/// GET /api/cost-by-model?hours=24&kwh_rate=0.16 — cost attribution per model.
#[cfg(not(target_env = "musl"))]
pub(crate) async fn handle_cost_by_model(
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
    axum::extract::Extension(store): axum::extract::Extension<store::Store>,
    axum::extract::Extension(node_id_ext): axum::extract::Extension<NodeId>,
) -> impl IntoResponse {
    let hours: i64 = params.get("hours").and_then(|v| v.parse().ok()).unwrap_or(24).min(720);
    let kwh_rate: f64 = params.get("kwh_rate").and_then(|v| v.parse().ok()).unwrap_or(0.16);
    let node_id = node_id_ext.0.as_str().to_owned();
    let result = tokio::task::spawn_blocking(move || store.query_cost_by_model(&node_id, hours, kwh_rate)).await;
    match result {
        Ok(Ok(data)) => Json(data).into_response(),
        Ok(Err(e)) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
        Err(e) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

/// GET /api/explain-slowdown?ts_ms=1234567890 — root cause analysis for a slow request.
#[cfg(not(target_env = "musl"))]
pub(crate) async fn handle_explain_slowdown(
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
    axum::extract::Extension(store): axum::extract::Extension<store::Store>,
    axum::extract::Extension(node_id_ext): axum::extract::Extension<NodeId>,
) -> impl IntoResponse {
    let ts_ms: i64 = match params.get("ts_ms").and_then(|v| v.parse().ok()) {
        Some(ts) => ts,
        None => return (axum::http::StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "ts_ms parameter required" }))).into_response(),
    };
    let node_id = node_id_ext.0.as_str().to_owned();
    let result = tokio::task::spawn_blocking(move || store.query_explain_slowdown(&node_id, ts_ms)).await;
    match result {
        Ok(Ok(data)) => Json(data).into_response(),
        Ok(Err(e)) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
        Err(e) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

/// GET /api/model-comparison?hours=168&kwh_rate=0.16 — side-by-side model efficiency data.
#[cfg(not(target_env = "musl"))]
pub(crate) async fn handle_model_comparison(
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
    axum::extract::Extension(store): axum::extract::Extension<store::Store>,
    axum::extract::Extension(node_id_ext): axum::extract::Extension<NodeId>,
) -> impl IntoResponse {
    let hours: i64 = params.get("hours").and_then(|v| v.parse().ok()).unwrap_or(168).min(720);
    let kwh_rate: f64 = params.get("kwh_rate").and_then(|v| v.parse().ok()).unwrap_or(0.16);
    let node_id = node_id_ext.0.as_str().to_owned();
    let result = tokio::task::spawn_blocking(move || store.query_model_comparison(&node_id, hours, kwh_rate)).await;
    match result {
        Ok(Ok(models)) => Json(serde_json::json!({ "node_id": node_id_ext.0.as_str(), "range_hours": hours, "kwh_rate": kwh_rate, "models": models })).into_response(),
        Ok(Err(e)) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
        Err(e) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

/// GET /api/model-switches?hours=24 — model swap frequency and overhead.
#[cfg(not(target_env = "musl"))]
pub(crate) async fn handle_model_switches(
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
    axum::extract::Extension(store): axum::extract::Extension<store::Store>,
    axum::extract::Extension(node_id_ext): axum::extract::Extension<NodeId>,
) -> impl IntoResponse {
    let hours: i64 = params.get("hours").and_then(|v| v.parse().ok()).unwrap_or(24).min(720);
    let node_id = node_id_ext.0.as_str().to_owned();
    let result = tokio::task::spawn_blocking(move || store.query_model_switches(&node_id, hours)).await;
    match result {
        Ok(Ok(data)) => Json(data).into_response(),
        Ok(Err(e)) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
        Err(e) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

/// Returns the last 20 lifecycle events from the recent_events_log ring buffer,
/// filtered to those within the last 5 minutes. Used by the frontend to seed
/// the Live Activity feed on every fresh WS connect — catches the startup event
/// and any lifecycle activity that fired before the browser was opened.
pub(crate) async fn handle_events_recent(
    axum::extract::Extension(log): axum::extract::Extension<
        Arc<Mutex<std::collections::VecDeque<LiveActivityEvent>>>
    >,
) -> axum::Json<Vec<LiveActivityEvent>> {
    let cutoff = now_ms().saturating_sub(5 * 60 * 1_000); // 5-minute window
    let events: Vec<LiveActivityEvent> = log.lock().unwrap()
        .iter()
        .filter(|e| e.timestamp_ms >= cutoff)
        .cloned()
        .collect();
    axum::Json(events)
}

/// GET /api/tags — Ollama model tags, proxied from the local Ollama
/// instance (matching the public docs). Empty list when Ollama isn't
/// running. Replaces a leftover demo stub that served three hardcoded
/// fake models as if they were real.
pub(crate) async fn handle_tags(port_rx: tokio::sync::watch::Receiver<Option<u16>>) -> Json<TagsResponse> {
    let port = match *port_rx.borrow() {
        Some(p) => p,
        None => return Json(TagsResponse { models: vec![] }),
    };
    let models = async {
        let resp = local_http_client()
            .get(format!("http://127.0.0.1:{port}/api/tags"))
            .timeout(Duration::from_secs(3))
            .send().await.ok()?;
        let json: serde_json::Value = resp.json().await.ok()?;
        let models = json["models"].as_array()?.iter().filter_map(|m| {
            Some(ModelInfo {
                name: m["name"].as_str()?.to_string(),
                size: m["size"].as_u64().unwrap_or(0),
            })
        }).collect::<Vec<_>>();
        Some(models)
    }.await.unwrap_or_default();
    Json(TagsResponse { models })
}

/// Health snapshot — operator-facing diagnostic for "are the API routes I
/// expect actually live?". Reports agent version, build target, DuckDB
/// store state (healthy / disabled), and which feature surface that gates.
///
/// When `store_healthy=false`, the routes listed under `routes_unavailable`
/// will silently return the SPA fallback HTML instead of JSON — same class
/// of failure that caused #1d95124 (the `model_catalog.likes` migration
/// killing every store-gated route).
#[derive(Clone, Copy)]
pub(crate) struct StoreHealth(pub bool);

pub(crate) async fn handle_health(
    axum::extract::Extension(store_healthy): axum::extract::Extension<StoreHealth>,
) -> Json<serde_json::Value> {
    // Routes that depend on the DuckDB store. Kept in sync with the
    // store-gated block in the router builder below.
    const STORE_GATED_ROUTES: &[&str] = &[
        "/api/history", "/api/traces", "/api/events/history", "/api/export",
        "/api/insights/dismiss", "/api/insights/dismissed", "/api/observations",
        "/api/profile", "/api/sla", "/api/cost-by-model", "/api/explain-slowdown",
        "/api/model-comparison", "/api/model-switches", "/api/model-candidates",
    ];
    Json(serde_json::json!({
        "ok":             true,
        "agent_version":  env!("CARGO_PKG_VERSION"),
        "build_target":   std::env::consts::OS.to_string() + "-" + std::env::consts::ARCH,
        "store_healthy":  store_healthy.0,
        "routes_available": if store_healthy.0 { STORE_GATED_ROUTES } else { &[] },
        "routes_unavailable": if store_healthy.0 { &[] as &[&str] } else { STORE_GATED_ROUTES },
        "store_failure_hint": if store_healthy.0 {
            serde_json::Value::Null
        } else {
            serde_json::json!(
                "DuckDB store init failed on startup — check the agent log for [store] lines. \
                 Common causes: schema migration error, disk space, file permission on the db path."
            )
        },
        "ts_ms": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64).unwrap_or(0),
    }))
}

/// Shared client for short loopback calls from request handlers (MCP tools,
/// /api/tags). Built once instead of per request so the connection pool and
/// client setup are reused; 5 s default timeout, overridable per request.
pub(crate) fn local_http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_default()
    })
}

/// Immutable proxy port config, set once at startup.
#[derive(Clone)]
pub(crate) struct ProxyPorts {
    pub(crate) listen: Option<u16>,
    pub(crate) target: Option<u16>,
}

/// `GET /api/metrics` — SSE fallback for clients that can't open the WebSocket.
///
/// Relays the frames the 1 Hz broadcaster already serialised (same path as
/// `ws_session`) instead of re-sampling sensors and rebuilding MetricsPayload
/// per client — one construction site keeps the two transports identical.
pub(crate) async fn handle_metrics(
    axum::extract::Extension(tx): axum::extract::Extension<broadcast::Sender<String>>,
) -> Sse<ReceiverStream<Result<Event, Infallible>>> {
    let (out_tx, out_rx) = tokio::sync::mpsc::channel::<Result<Event, Infallible>>(4);
    let mut rx = tx.subscribe();

    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(json) => {
                    if out_tx.send(Ok(Event::default().data(json))).await.is_err() {
                        break; // client disconnected
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue, // skip stale frames
                Err(broadcast::error::RecvError::Closed)    => break,
            }
        }
    });

    Sse::new(ReceiverStream::new(out_rx))
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

// ── Runtime Config (v0.9.0) ──────────────────────────────────────────────────
// GET /api/runtime-config?model=<name> — returns the cached RuntimeConfig for
// the named model. Available across Ollama, vLLM, and llama.cpp. Reads from
// the in-memory cache populated by the harvesters; never blocks on I/O.
pub(crate) async fn handle_runtime_config(
    axum::extract::Extension(cache): axum::extract::Extension<runtime_config::RuntimeConfigCache>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> axum::response::Response {
    let Some(model) = q.get("model") else {
        return (StatusCode::BAD_REQUEST, "missing ?model= query param").into_response();
    };
    let guard = cache.lock().unwrap();
    match guard.get(model) {
        Some(config) => (StatusCode::OK, Json(config.clone())).into_response(),
        None => (StatusCode::NOT_FOUND, "no cached config for this model").into_response(),
    }
}

// ── Static Asset Serving ──────────────────────────────────────────────────────

pub(crate) async fn static_handler(uri: Uri) -> impl IntoResponse {
    let raw = uri.path().trim_start_matches('/');
    serve_asset(if raw.is_empty() { "index.html" } else { raw })
}

pub(crate) fn serve_asset(path: &str) -> Response<Body> {
    if let Some(content) = StaticAssets::get(path) {
        let mime = from_path(path).first_or_octet_stream();
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime.as_ref())
            .body(Body::from(content.data.into_owned()))
            .unwrap();
    }
    if let Some(index) = StaticAssets::get("index.html") {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .body(Body::from(index.data.into_owned()))
            .unwrap();
    }
    Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header(header::CONTENT_TYPE, "text/plain")
        .body(Body::from(
            "Frontend assets not embedded.\n\
             Run `npm run build` from the repo root, then recompile the agent.",
        ))
        .unwrap()
}

#[cfg(test)]
mod metrics_sse_tests {
    use super::*;
    use tokio_stream::StreamExt;

    #[tokio::test]
    async fn sse_relays_broadcast_frames_verbatim() {
        let (tx, _) = broadcast::channel::<String>(4);
        let resp = handle_metrics(axum::extract::Extension(tx.clone())).await.into_response();
        let mut body = resp.into_body().into_data_stream();

        tx.send(r#"{"inference_state":"idle"}"#.into()).unwrap();
        let chunk = tokio::time::timeout(Duration::from_secs(2), body.next())
            .await.expect("frame within 2s").expect("stream open").unwrap();
        assert_eq!(&chunk[..], b"data: {\"inference_state\":\"idle\"}\n\n");
    }
}
