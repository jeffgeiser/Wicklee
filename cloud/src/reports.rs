//! Team+ reports: chargeback, idle waste, weekly digest, capacity planner, migration advisor.

use crate::*;

// ── Chargeback / showback (Team+) ────────────────────────────────────────────

/// Shared base CTE for chargeback — see `energy::energy_base_cte`: per-row
/// energy/token integrals over each sample's real duration (rows land every
/// ~2 s, not 30 s), from the 5-min rollup UNION the not-yet-rolled-up raw
/// tail. $1 = tenant, $2 = window interval string ("30 days").
pub(crate) fn chargeback_base() -> String { energy_base_cte() }

/// Build one chargeback row: measured energy → cost at the given rate,
/// estimated tokens → $/1M tokens (the number nobody else can produce,
/// because nobody else has watts AND tokens in the same store).
pub(crate) fn chargeback_row(key: &str, energy_kwh: f64, tokens: f64, hours: f64, kwh_rate: f64) -> serde_json::Value {
    let cost_usd = energy_kwh * kwh_rate;
    let tokens_m = tokens / 1_000_000.0;
    let usd_per_mtok = if tokens_m > 0.0001 { Some(cost_usd / tokens_m) } else { None };
    serde_json::json!({
        "key": key, "energy_kwh": energy_kwh, "cost_usd": cost_usd,
        "tokens_m": tokens_m, "usd_per_mtok": usd_per_mtok, "hours_covered": hours,
    })
}

// ── Idle-waste & right-sizing report (Readiness Program item 10, Team+) ──────
//
// "Fleet burned $X idle last 30d; these N changes recover $Y." Phantom load =
// a model held in memory while the node is NOT inferring — power burned for
// nothing. Uses the same base CTE as chargeback (energy::energy_base_cte), so
// the two reports always agree on energy: idle = total − live, both
// integrated over real sample durations.

/// Compute the idle-waste report for one tenant. Shared by the HTTP handler
/// and the weekly digest task so both always agree.
pub(crate) async fn compute_idle_waste(
    pool: &sqlx::PgPool,
    tval: &str,
    days: i64,
    kwh_rate: f64,
) -> serde_json::Value {
    let window = format!("{days} days");

    // Per node × model: idle energy attributable to a loaded-but-idle model
    // (phantom load) vs idle with nothing loaded (baseline idle, context only).
    let rows_sql = format!("{base}
        SELECT node_id, model,
               SUM(energy_kwh - active_kwh)::float8, SUM(active_kwh)::float8,
               SUM(hours_covered - live_hours)::float8, SUM(hours_covered)::float8
        FROM base GROUP BY node_id, model", base = energy_base_cte());
    let rows: Vec<(String, String, f64, f64, f64, f64)> = sqlx::query_as(&rows_sql)
        .bind(tval).bind(&window)
        .fetch_all(pool).await.unwrap_or_default();

    let mut phantom_kwh = 0.0_f64;
    let mut baseline_idle_kwh = 0.0_f64;
    let mut active_kwh = 0.0_f64;
    let mut node_hours: HashMap<String, (f64, f64)> = HashMap::new(); // (idle_h, covered_h)
    let mut phantom_by_node_model: Vec<(&String, &String, f64, f64)> = Vec::new();
    for (node_id, model, idle, active, idle_h, covered_h) in &rows {
        active_kwh += active;
        if model == "(none)" { baseline_idle_kwh += idle; } else {
            phantom_kwh += idle;
            phantom_by_node_model.push((node_id, model, *idle, *idle_h));
        }
        let e = node_hours.entry(node_id.clone()).or_insert((0.0, 0.0));
        e.0 += idle_h;
        e.1 += covered_h;
    }
    let phantom_cost = phantom_kwh * kwh_rate;
    let total_kwh = phantom_kwh + baseline_idle_kwh + active_kwh;

    // Actions, largest recovery first. Monthly projection normalizes the
    // window so 7d and 30d reports advise consistently.
    let monthly = |cost_in_window: f64| cost_in_window * 30.0 / days as f64;
    phantom_by_node_model.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap());
    let mut actions: Vec<serde_json::Value> = phantom_by_node_model.iter()
        .filter(|(_, _, idle_kwh, idle_h)| idle_kwh * kwh_rate > 0.005 && *idle_h > 1.0)
        .take(10)
        .map(|(node_id, model, idle_kwh, idle_h)| serde_json::json!({
            "kind": "unload_idle_model",
            "node_id": node_id, "model": model,
            "idle_hours": (idle_h * 10.0).round() / 10.0,
            "recovers_usd_month": (monthly(idle_kwh * kwh_rate) * 100.0).round() / 100.0,
            "detail": format!("{model} sat loaded but idle for {:.0}h on {node_id} — unload when idle (or set a keep-alive timeout) to recover ~${:.2}/mo",
                idle_h, monthly(idle_kwh * kwh_rate)),
        })).collect();

    // Consolidation candidates: nodes that barely inferred at all.
    if node_hours.len() > 1 {
        for (node_id, (idle_h, covered_h)) in &node_hours {
            if *covered_h < 24.0 { continue; } // need a real observation window
            let duty_pct = (1.0 - idle_h / covered_h) * 100.0;
            if duty_pct < 10.0 {
                actions.push(serde_json::json!({
                    "kind": "consolidate",
                    "node_id": node_id,
                    "duty_pct": (duty_pct * 10.0).round() / 10.0,
                    "detail": format!("{node_id} was inferring only {:.1}% of the last {days}d — consider moving its models to a busier node and powering it down",
                        duty_pct),
                }));
            }
        }
    }

    let recovery: f64 = actions.iter()
        .filter_map(|a| a["recovers_usd_month"].as_f64())
        .sum();

    let by_node: Vec<serde_json::Value> = node_hours.iter().map(|(node_id, (idle_h, covered_h))| {
        let node_phantom: f64 = phantom_by_node_model.iter()
            .filter(|(n, ..)| *n == node_id).map(|(_, _, k, _)| k).sum();
        serde_json::json!({
            "node_id": node_id,
            "idle_hours": (idle_h * 10.0).round() / 10.0,
            "duty_pct": if *covered_h > 0.0 { ((1.0 - idle_h / covered_h) * 1000.0).round() / 10.0 } else { 0.0 },
            "phantom_cost_usd": (node_phantom * kwh_rate * 1000.0).round() / 1000.0,
        })
    }).collect();

    serde_json::json!({
        "days": days,
        "kwh_rate": kwh_rate,
        "totals": {
            "phantom_kwh": (phantom_kwh * 1000.0).round() / 1000.0,
            "phantom_cost_usd": (phantom_cost * 1000.0).round() / 1000.0,
            "baseline_idle_cost_usd": (baseline_idle_kwh * kwh_rate * 1000.0).round() / 1000.0,
            "active_cost_usd": (active_kwh * kwh_rate * 1000.0).round() / 1000.0,
            "idle_pct_of_energy": if total_kwh > 0.0 {
                (((phantom_kwh + baseline_idle_kwh) / total_kwh) * 1000.0).round() / 10.0
            } else { 0.0 },
            // recovers_usd_month values are already monthly-normalized.
            "projected_monthly_recovery_usd": (recovery * 100.0).round() / 100.0,
        },
        "by_node": by_node,
        "actions": actions,
    })
}

/// GET /api/v1/fleet/idle-waste?days=30&kwh_rate=0.16 (Team+, JWT) —
/// idle-waste & right-sizing report: phantom-load cost (model loaded while
/// not inferring) with per-node recovery actions. Quant-swap savings are a
/// follow-up (needs the agent's Quant Sweet Spot data on the wire).
pub(crate) async fn handle_idle_waste(
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
    if !is_team_or_above(&tier) {
        return upgrade_required("Idle-waste reports", UpgradePlan::Team);
    }
    let days: i64 = params.get("days").and_then(|s| s.parse().ok()).unwrap_or(30).clamp(1, 90);
    let kwh_rate: f64 = params.get("kwh_rate").and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_KWH_RATE_USD as f64).clamp(0.01, 2.0);
    let (_tcol, tval) = tenant_scope(&user_id, &org_id);

    Json(compute_idle_waste(&state.pool, tval, days, kwh_rate).await).into_response()
}

/// GET /api/digest — weekly idle-waste digest settings for this tenant.
pub(crate) async fn handle_get_digest(
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
    let (_tcol, tval) = tenant_scope(&user_id, &org_id);
    let row: Option<(String, bool, i64)> = sqlx::query_as(
        "SELECT email, enabled, last_sent_ms FROM digest_settings WHERE tenant_id = $1"
    ).bind(tval).fetch_optional(&state.pool).await.unwrap_or(None);
    match row {
        Some((email, enabled, last_sent_ms)) => Json(serde_json::json!({
            "email": email, "enabled": enabled, "last_sent_ms": last_sent_ms,
        })).into_response(),
        None => Json(serde_json::json!({ "email": "", "enabled": false, "last_sent_ms": 0 })).into_response(),
    }
}

/// PUT /api/digest — enable/disable the weekly idle-waste digest (Team+).
/// Body: { email, enabled }. Audited as digest.updated.
pub(crate) async fn handle_put_digest(
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
    let (user_id, org_id) = match require_user_and_org(&token, &state.pool, &clerk_keys).await {
        Some(v) => v,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };
    let tier = resolve_tier(&user_id, &org_id, &state.pool).await;
    if !is_team_or_above(&tier) {
        return upgrade_required("The weekly digest", UpgradePlan::Team);
    }
    let email = body.get("email").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let enabled = body.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
    if enabled && (email.is_empty() || !email.contains('@')) {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "A valid email is required to enable the digest" }))).into_response();
    }

    let (_tcol, tval) = tenant_scope(&user_id, &org_id);
    let result = sqlx::query(
        "INSERT INTO digest_settings (tenant_id, user_id, org_id, email, enabled, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id) DO UPDATE SET
           user_id = EXCLUDED.user_id, org_id = EXCLUDED.org_id,
           email = EXCLUDED.email, enabled = EXCLUDED.enabled"
    ).bind(tval).bind(&user_id).bind(&org_id).bind(&email).bind(enabled).bind(now_ms() as i64)
    .execute(&state.pool).await;

    match result {
        Ok(_) => {
            audit(&state.pool, &user_id, &org_id, "digest.updated", "",
                serde_json::json!({ "enabled": enabled, "email": &email }));
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Err(e) => { eprintln!("[digest] settings upsert failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" }))).into_response() }
    }
}

/// Weekly idle-waste digest task. Hourly tick; for each enabled tenant whose
/// last send is ≥7 days old, re-checks tier (subscription may have lapsed),
/// computes the 7-day report, and emails it via Resend. last_sent_ms advances
/// only on successful delivery so a Resend outage retries next tick.
pub(crate) async fn idle_digest_task(pool: sqlx::PgPool) {
    tokio::time::sleep(Duration::from_secs(120)).await; // let metrics settle after boot
    let mut interval = tokio::time::interval(Duration::from_secs(3600));
    loop {
        interval.tick().await;
        let week_ago = now_ms() as i64 - 7 * 24 * 3_600_000;
        let due: Vec<(String, String, Option<String>, String)> = sqlx::query_as(
            "SELECT tenant_id, user_id, org_id, email FROM digest_settings
             WHERE enabled AND last_sent_ms < $1"
        ).bind(week_ago).fetch_all(&pool).await.unwrap_or_default();

        for (tenant_id, user_id, org_id, email) in due {
            if !is_team_or_above(&resolve_tier(&user_id, &org_id, &pool).await) { continue; }
            let report = compute_idle_waste(&pool, &tenant_id, 7, DEFAULT_KWH_RATE_USD as f64).await;
            let t = &report["totals"];
            let (phantom, idle_pct, recovery) = (
                t["phantom_cost_usd"].as_f64().unwrap_or(0.0),
                t["idle_pct_of_energy"].as_f64().unwrap_or(0.0),
                t["projected_monthly_recovery_usd"].as_f64().unwrap_or(0.0),
            );
            let actions = report["actions"].as_array().cloned().unwrap_or_default();

            let subject = format!("Wicklee weekly: ${phantom:.2} burned idle · ${recovery:.2}/mo recoverable");
            let mut text = format!(
                "Your fleet burned ${phantom:.2} on idle loaded models in the last 7 days ({idle_pct:.0}% of fleet energy was idle).\n\n");
            let mut html_actions = String::new();
            if actions.is_empty() {
                text.push_str("No recovery actions this week — models are pulling their weight.\n");
                html_actions.push_str("<p>No recovery actions this week — models are pulling their weight.</p>");
            } else {
                text.push_str("Top recoveries:\n");
                html_actions.push_str("<ul>");
                for a in actions.iter().take(3) {
                    if let Some(d) = a["detail"].as_str() {
                        text.push_str(&format!("  • {d}\n"));
                        html_actions.push_str(&format!("<li style=\"margin-bottom:6px\">{d}</li>"));
                    }
                }
                html_actions.push_str("</ul>");
            }
            text.push_str("\nFull report: https://wicklee.dev (Insights → Performance → Idle Waste)\n");
            let html = format!(
                "<div style=\"font-family:ui-monospace,monospace;background:#0b0f17;color:#d1d5db;padding:24px;border-radius:12px\">\
                 <h2 style=\"color:#fff;margin-top:0\">Weekly idle-waste report</h2>\
                 <p>Your fleet burned <strong style=\"color:#f87171\">${phantom:.2}</strong> on idle loaded models \
                 in the last 7 days ({idle_pct:.0}% of fleet energy was idle). \
                 Estimated recoverable: <strong style=\"color:#34d399\">${recovery:.2}/mo</strong>.</p>\
                 {html_actions}\
                 <p style=\"color:#6b7280;font-size:12px\">Full report: Insights → Performance → Idle Waste on \
                 <a href=\"https://wicklee.dev\" style=\"color:#60a5fa\">wicklee.dev</a> · \
                 Unsubscribe in the same card.</p></div>");

            let sent = {
                let email = email.clone();
                tokio::task::spawn_blocking(move || send_email(&email, &subject, &text, &html))
                    .await.unwrap_or(false)
            };
            if sent {
                let _ = sqlx::query("UPDATE digest_settings SET last_sent_ms = $1 WHERE tenant_id = $2")
                    .bind(now_ms() as i64).bind(&tenant_id).execute(&pool).await;
                println!("[digest] sent weekly idle-waste digest for {tenant_id}");
            } else {
                eprintln!("[digest] send failed for {tenant_id} — will retry next tick");
            }
        }
    }
}

/// GET /api/v1/fleet/chargeback?days=30&kwh_rate=0.16[&format=csv&group=tag]
/// (Team+, JWT) — showback/chargeback report: cost and token attribution by
/// tag (team), model, and node, plus a daily trend. A node with multiple tags
/// counts fully under each tag — tag groupings overlap by design (showback,
/// not double-billing). CSV downloads are audited.
/// Hardware class for capacity projections — Apple unified memory vs discrete NVIDIA.
pub(crate) fn profile_class(profile: &str) -> &'static str {
    if profile.starts_with("m4") { "apple" } else { "nvidia" }
}

/// GET /api/v1/fleet/capacity — Fleet Capacity Planner with procurement
/// scenarios (Team+). "Reach 200 tok/s sustained: 2×4090 vs 1×H100" priced
/// from the fleet's own measured tok/W per hardware class — never vendor
/// benchmarks. Params: target_tok_s (default 2× current sustained),
/// kwh_rate, days (observation window, 1–90, default 7).
pub(crate) async fn handle_fleet_capacity(
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
    if !is_team_or_above(&tier) {
        return upgrade_required("Fleet Capacity Planner", UpgradePlan::Team);
    }

    let days: i64 = params.get("days").and_then(|s| s.parse().ok()).unwrap_or(7).clamp(1, 90);
    let kwh_rate: f64 = params.get("kwh_rate").and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_KWH_RATE_USD as f64).clamp(0.01, 2.0);
    let (_tcol, tval) = tenant_scope(&user_id, &org_id);
    let window = format!("{days} days");

    // Observed per-node averages: rollups for the window plus the raw
    // trailing day (rollup lags 24h — same convention as chargeback).
    let rows: Vec<(String, Option<f64>, Option<f64>)> = sqlx::query_as(
        "SELECT node_id,
                AVG(tok_s) FILTER (WHERE tok_s > 0)::float8,
                AVG(watts) FILTER (WHERE watts > 0)::float8
         FROM (
             SELECT node_id, tok_s_avg AS tok_s, watts_avg AS watts
             FROM metrics_5min WHERE tenant_id = $1 AND ts > NOW() - $2::interval
             UNION ALL
             SELECT node_id, tok_s, watts
             FROM metrics_raw WHERE tenant_id = $1 AND ts > NOW() - INTERVAL '1 day'
         ) s GROUP BY node_id"
    ).bind(tval).bind(&window).fetch_all(&state.pool).await.unwrap_or_default();

    // Classify nodes from the live cache (NVIDIA board power vs Apple SoC power).
    let cache = state.metrics.read().unwrap();
    let classify = |node_id: &str| -> &'static str {
        match cache.get(node_id).and_then(|e| e.metrics.as_ref()) {
            Some(m) if m.nvidia_power_draw_w.is_some() => "nvidia",
            Some(m) if m.apple_soc_power_w.is_some() || m.cpu_power_w.is_some() => "apple",
            _ => "unknown",
        }
    };

    let mut nodes = Vec::new();
    let mut sustained_tok_s = 0.0_f64;
    let mut total_watts = 0.0_f64;
    let mut eff_by_class: HashMap<&'static str, Vec<f64>> = HashMap::new();
    for (node_id, tok_s, watts) in &rows {
        let class = classify(node_id);
        let hostname = cache.get(node_id)
            .and_then(|e| e.metrics.as_ref())
            .and_then(|m| m.hostname.clone());
        if let (Some(t), Some(w)) = (tok_s, watts)
            && *t > 0.0 && *w > 0.0 {
                sustained_tok_s += t;
                total_watts += w;
                eff_by_class.entry(class).or_default().push(t / w);
            }
        nodes.push(serde_json::json!({
            "node_id": node_id, "hostname": hostname, "class": class,
            "avg_tok_s": tok_s, "avg_watts": watts,
        }));
    }
    drop(cache);

    let median = |mut v: Vec<f64>| -> Option<f64> {
        if v.is_empty() { return None; }
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        Some(v[v.len() / 2])
    };
    let apple_eff  = median(eff_by_class.remove("apple").unwrap_or_default());
    let nvidia_eff = median(eff_by_class.remove("nvidia").unwrap_or_default());
    let fleet_eff  = if total_watts > 0.0 { Some(sustained_tok_s / total_watts) } else { None };

    let target_tok_s: f64 = params.get("target_tok_s").and_then(|s| s.parse().ok())
        .unwrap_or((sustained_tok_s * 2.0).max(10.0))
        .clamp(1.0, 1_000_000.0);
    let deficit = (target_tok_s - sustained_tok_s).max(0.0);

    const PROFILES: &[(&str, &str)] = &[
        ("m4", "Mac Mini M4 16GB"), ("m4_pro_24gb", "M4 Pro 24GB"),
        ("m4_max_36gb", "M4 Max 36GB"), ("m4_max_64gb", "M4 Max 64GB"),
        ("m4_ultra_128gb", "M4 Ultra 128GB"),
        ("nvidia_4060", "RTX 4060"), ("nvidia_4070", "RTX 4070"),
        ("nvidia_4080", "RTX 4080"), ("nvidia_4090", "RTX 4090"),
        ("nvidia_a100_40gb", "A100 40GB"), ("nvidia_a100_80gb", "A100 80GB"),
        ("nvidia_h100", "H100 80GB"),
    ];

    // Procurement scenarios: how many units of each profile reach the target,
    // and what that costs per day at 24h duty. Anchored to the fleet's own
    // measured tok/W per class; each scenario states its basis.
    let mut scenarios: Vec<serde_json::Value> = PROFILES.iter().filter_map(|(profile, label)| {
        let (vram_mb, power_w) = hardware_profile(profile)?;
        let class = profile_class(profile);
        let (eff, basis) = match class {
            "apple" => apple_eff.map(|e| (e, "your Apple nodes' measured efficiency"))
                .or(fleet_eff.map(|e| (e, "fleet-wide measured efficiency")))?,
            _       => nvidia_eff.map(|e| (e, "your NVIDIA nodes' measured efficiency"))
                .or(fleet_eff.map(|e| (e, "fleet-wide measured efficiency")))?,
        };
        let unit_tok_s = eff * power_w as f64;
        if unit_tok_s <= 0.0 { return None; }
        let units = if deficit <= 0.0 { 0 } else { (deficit / unit_tok_s).ceil() as i64 };
        if units > 16 { return None; } // absurd scenario — not worth listing
        let added = unit_tok_s * units as f64;
        Some(serde_json::json!({
            "profile": profile, "label": label, "class": class,
            "vram_mb": vram_mb, "power_w": power_w,
            "units": units,
            "unit_tok_s": (unit_tok_s * 10.0).round() / 10.0,
            "est_added_tok_s": (added * 10.0).round() / 10.0,
            "est_cost_per_day": ((units as f64 * power_w as f64) * 24.0 / 1000.0 * kwh_rate * 100.0).round() / 100.0,
            "basis": format!("{basis} ({:.2} tok/W)", eff),
        }))
    }).collect();
    scenarios.sort_by(|a, b| {
        a["est_cost_per_day"].as_f64().partial_cmp(&b["est_cost_per_day"].as_f64()).unwrap()
            .then_with(|| a["units"].as_i64().cmp(&b["units"].as_i64()))
    });

    Json(serde_json::json!({
        "days": days,
        "kwh_rate": kwh_rate,
        "target_tok_s": (target_tok_s * 10.0).round() / 10.0,
        "target_met": deficit <= 0.0,
        "fleet": {
            "nodes": nodes,
            "sustained_tok_s": (sustained_tok_s * 10.0).round() / 10.0,
            "total_watts": (total_watts * 10.0).round() / 10.0,
            "cost_per_day": (total_watts * 24.0 / 1000.0 * kwh_rate * 100.0).round() / 100.0,
        },
        "scenarios": scenarios,
    })).into_response()
}

/// GET /api/v1/fleet/migration-advisor — Cross-Node Model Migration (Team+).
/// Compares each actively-inferring node's current WES against peers' 7-day
/// demonstrated efficiency and free memory, and recommends moves with the
/// estimated gain: "Llama on WK-A1B2 (WES 8.2) → WK-C3D4 (7d WES 12.1), +47%."
pub(crate) async fn handle_migration_advisor(
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
        return upgrade_required("Model Migration Advisor", UpgradePlan::Team);
    }

    // 7d demonstrated efficiency per node (rollups + raw trailing day).
    let (tcol, tval) = tenant_scope(&user_id, &org_id);
    let hist: Vec<(String, Option<f64>)> = sqlx::query_as(
        "SELECT node_id, AVG(wes)::float8 FROM (
             SELECT node_id, wes_penalized_avg AS wes FROM metrics_5min
             WHERE tenant_id = $1 AND ts > NOW() - INTERVAL '7 days' AND wes_penalized_avg IS NOT NULL
             UNION ALL
             SELECT node_id, wes_penalized FROM metrics_raw
             WHERE tenant_id = $1 AND ts > NOW() - INTERVAL '1 day' AND wes_penalized IS NOT NULL
         ) s GROUP BY node_id"
    ).bind(tval).fetch_all(&state.pool).await.unwrap_or_default();
    let hist_wes: HashMap<String, f64> = hist.into_iter()
        .filter_map(|(n, w)| w.map(|w| (n, w))).collect();

    let tenant_nodes: HashSet<String> =
        sqlx::query_scalar::<_, String>(&format!("SELECT wk_id FROM nodes WHERE {tcol} = $1"))
            .bind(tval).fetch_all(&state.pool).await.unwrap_or_default()
            .into_iter().collect();

    // Current placement snapshot from the live cache.
    struct Snap {
        hostname: Option<String>,
        model: Option<String>,
        model_size_mb: Option<f64>,
        wes: Option<f64>,
        free_mem_mb: f64,
        online: bool,
    }
    let now = now_ms();
    let cache = state.metrics.read().unwrap();
    let snaps: Vec<(String, Snap)> = tenant_nodes.iter().filter_map(|nid| {
        let e = cache.get(nid)?;
        let m = e.metrics.as_ref()?;
        let model = if m.vllm_running { m.vllm_model_name.clone() }
            else if m.llamacpp_running { m.llamacpp_model_name.clone() }
            else { m.ollama_active_model.clone() };
        let free_mem_mb = match (m.nvidia_vram_total_mb, m.nvidia_vram_used_mb) {
            (Some(t), Some(u)) => t.saturating_sub(u) as f64,
            _ => m.available_memory_mb as f64,   // Apple unified memory
        };
        Some((nid.clone(), Snap {
            hostname: m.hostname.clone(),
            model,
            model_size_mb: m.ollama_model_size_gb.map(|g| g as f64 * 1024.0),
            wes: wes_for_payload(m).map(|w| w as f64),
            free_mem_mb,
            online: now.saturating_sub(e.last_seen_ms) < ONLINE_THRESHOLD_MS,
        }))
    }).collect();
    drop(cache);

    let mut recommendations = Vec::new();
    for (from_id, from) in &snaps {
        let (Some(model), Some(from_wes)) = (&from.model, from.wes) else { continue };
        if !from.online || from_wes <= 0.0 { continue; }
        // Model footprint: reported size + 20% headroom; unknown size assumes 8 GB.
        let needed_mb = from.model_size_mb.unwrap_or(8192.0) * 1.2;
        for (to_id, to) in &snaps {
            if to_id == from_id || !to.online { continue; }
            let Some(&to_wes) = hist_wes.get(to_id) else { continue };
            if to_wes < from_wes * 1.2 { continue; }          // require ≥20% gain
            if to.free_mem_mb < needed_mb { continue; }       // must fit with headroom
            let gain_pct = (to_wes - from_wes) / from_wes * 100.0;
            recommendations.push(serde_json::json!({
                "model": model,
                "from_node": from_id, "from_hostname": from.hostname,
                "to_node": to_id, "to_hostname": to.hostname,
                "from_wes": (from_wes * 10.0).round() / 10.0,
                "to_wes_7d": (to_wes * 10.0).round() / 10.0,
                "est_gain_pct": gain_pct.round(),
                "to_free_mem_mb": to.free_mem_mb.round(),
                "model_size_mb": from.model_size_mb,
            }));
        }
    }
    recommendations.sort_by(|a, b| b["est_gain_pct"].as_f64().partial_cmp(&a["est_gain_pct"].as_f64()).unwrap());
    recommendations.truncate(10);

    Json(serde_json::json!({ "recommendations": recommendations })).into_response()
}

pub(crate) async fn handle_fleet_chargeback(
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
    if !is_team_or_above(&tier) {
        return upgrade_required("Chargeback reports", UpgradePlan::Team);
    }

    let days: i64 = params.get("days").and_then(|s| s.parse().ok()).unwrap_or(30).clamp(1, 90);
    let kwh_rate: f64 = params.get("kwh_rate").and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_KWH_RATE_USD as f64).clamp(0.01, 2.0);
    let (_tcol, tval) = tenant_scope(&user_id, &org_id);
    let window = format!("{days} days");

    let base = chargeback_base();
    // Tags overlap by design; empty-string fragments from stray commas fold
    // into (untagged) via NULLIF.
    let by_tag_sql = format!("{base}
        SELECT COALESCE(NULLIF(t.tag, ''), '(untagged)') AS key,
               SUM(b.energy_kwh), SUM(b.tokens), SUM(b.hours_covered)
        FROM base b
        LEFT JOIN LATERAL (
            SELECT unnest(string_to_array(replace(lower(n.tags), ' ', ''), ',')) AS tag
            FROM nodes n WHERE n.wk_id = b.node_id AND n.tags IS NOT NULL AND n.tags <> ''
        ) t ON true
        GROUP BY 1 ORDER BY 2 DESC LIMIT 100");
    let by_model_sql = format!("{base}
        SELECT model, SUM(energy_kwh), SUM(tokens), SUM(hours_covered)
        FROM base GROUP BY model ORDER BY 2 DESC LIMIT 100");
    let by_node_sql = format!("{base}
        SELECT node_id, SUM(energy_kwh), SUM(tokens), SUM(hours_covered)
        FROM base GROUP BY node_id ORDER BY 2 DESC LIMIT 100");
    let daily_sql = format!("{base}
        SELECT to_char(day, 'YYYY-MM-DD'), SUM(energy_kwh), SUM(tokens), SUM(hours_covered)
        FROM base GROUP BY day ORDER BY day ASC");

    let fetch = |sql: String| {
        let pool = state.pool.clone();
        let tval = tval.to_string();
        let window = window.clone();
        async move {
            sqlx::query_as::<_, (String, f64, f64, f64)>(&sql)
                .bind(&tval).bind(&window)
                .fetch_all(&pool).await.unwrap_or_default()
        }
    };
    let (by_tag, by_model, by_node, daily) = tokio::join!(
        fetch(by_tag_sql), fetch(by_model_sql), fetch(by_node_sql), fetch(daily_sql));

    let rows_of = |rows: &[(String, f64, f64, f64)]| -> Vec<serde_json::Value> {
        rows.iter().map(|(k, e, t, h)| chargeback_row(k, *e, *t, *h, kwh_rate)).collect()
    };

    // CSV path: one grouping, finance-ready, formula-injection-hardened.
    if params.get("format").map(|s| s.as_str()) == Some("csv") {
        let group = params.get("group").map(|s| s.as_str()).unwrap_or("tag");
        let rows = match group {
            "model" => &by_model,
            "node"  => &by_node,
            "daily" => &daily,
            _       => &by_tag,
        };
        let mut out = String::from("key,energy_kwh,cost_usd,tokens_m,usd_per_mtok,hours_covered\n");
        for (k, e, t, h) in rows {
            let cost = e * kwh_rate;
            let tm = t / 1_000_000.0;
            let upm = if tm > 0.0001 { format!("{:.4}", cost / tm) } else { String::new() };
            out.push_str(&format!("{},{:.4},{:.4},{:.3},{},{:.2}\n",
                csv_escape(k), e, cost, tm, upm, h));
        }
        audit(&state.pool, &user_id, &org_id, "chargeback.exported", group,
            serde_json::json!({ "days": days, "rows": rows.len() }));
        return (
            [
                ("Content-Type", "text/csv; charset=utf-8".to_string()),
                ("Content-Disposition", format!("attachment; filename=\"wicklee-chargeback-{group}-{days}d.csv\"")),
            ],
            out,
        ).into_response();
    }

    let (te, tt, th) = daily.iter().fold((0.0, 0.0, 0.0), |(e, t, h), r| (e + r.1, t + r.2, h + r.3));
    Json(serde_json::json!({
        "days": days,
        "kwh_rate": kwh_rate,
        "totals": chargeback_row("total", te, tt, th, kwh_rate),
        "by_tag": rows_of(&by_tag),
        "by_model": rows_of(&by_model),
        "by_node": rows_of(&by_node),
        "daily": rows_of(&daily),
    })).into_response()
}
