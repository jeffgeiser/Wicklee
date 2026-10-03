//! OpenTelemetry export and Prometheus scrape endpoint.

use crate::*;

// ── OpenTelemetry Export (Team+ tier) ─────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct OtelConfig {
    pub(crate) enabled: bool,
    pub(crate) endpoint_url: String,
    pub(crate) auth_headers: String,   // JSON string: {"Authorization": "Bearer xxx"}
    pub(crate) export_interval_s: i32,
}

pub(crate) async fn handle_get_otel_config(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Missing auth token"}))).into_response(),
    };
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let (user_id, org_id) = match require_user_and_org(&token, &state.pool, &clerk_keys).await {
        Some(v) => v,
        None => return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Invalid session"}))).into_response(),
    };
    // Org-aware: org members are entitled by the org subscription.
    let tier = resolve_tier(&user_id, &org_id, &state.pool).await;
    if !is_team_or_above(&tier) {
        return upgrade_required("OpenTelemetry export", UpgradePlan::Team);
    }
    let row: Option<(bool, String, String, i32)> = sqlx::query_as(
        "SELECT enabled, endpoint_url, auth_headers, export_interval_s FROM otel_config WHERE user_id = $1"
    ).bind(&user_id).fetch_optional(&state.pool).await.unwrap_or(None);
    match row {
        Some((enabled, endpoint_url, auth_headers, interval)) => {
            Json(serde_json::json!({ "enabled": enabled, "endpoint_url": endpoint_url, "auth_headers": auth_headers, "export_interval_s": interval })).into_response()
        }
        None => Json(serde_json::json!({ "enabled": false, "endpoint_url": "", "auth_headers": "{}", "export_interval_s": 30 })).into_response(),
    }
}

pub(crate) async fn handle_put_otel_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<OtelConfig>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Missing auth token"}))).into_response(),
    };
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let (user_id, org_id, role) = match require_user_org_role(&token, &state.pool, &clerk_keys).await {
        Some(v) => v,
        None => return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Invalid session"}))).into_response(),
    };
    if !role.can_mutate() { return role_forbidden("member"); }
    // Org-aware: org members are entitled by the org subscription.
    let tier = resolve_tier(&user_id, &org_id, &state.pool).await;
    if !is_team_or_above(&tier) {
        return upgrade_required("OpenTelemetry export", UpgradePlan::Team);
    }
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
    if body.enabled && !body.endpoint_url.trim().is_empty()
        && let Err(e) = resolve_outbound(&body.endpoint_url).await
    {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": format!("endpoint_url: {e}")}))).into_response();
    }
    let interval = body.export_interval_s.clamp(15, 300);
    sqlx::query("
        INSERT INTO otel_config (user_id, enabled, endpoint_url, auth_headers, export_interval_s, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $6)
        ON CONFLICT (user_id) DO UPDATE SET enabled = $2, endpoint_url = $3, auth_headers = $4, export_interval_s = $5, updated_at = $6
    ").bind(&user_id).bind(body.enabled).bind(&body.endpoint_url).bind(&body.auth_headers).bind(interval).bind(now_ms)
    .execute(&state.pool).await.ok();
    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}

/// Background task: reads enabled OTel configs and POSTs OTLP JSON to configured endpoints.
pub(crate) async fn otel_exporter_task(state: AppState) {
    // Wait for metrics to populate before starting exports.
    tokio::time::sleep(Duration::from_secs(60)).await;

    let mut interval = tokio::time::interval(Duration::from_secs(30));
    loop {
        interval.tick().await;

        // Load all enabled configs.
        let configs: Vec<(String, String, String, i32)> = sqlx::query_as(
            "SELECT user_id, endpoint_url, auth_headers, export_interval_s FROM otel_config WHERE enabled = true AND endpoint_url != ''"
        ).fetch_all(&state.pool).await.unwrap_or_default();

        if configs.is_empty() { continue; }

        for (user_id, endpoint_url, auth_headers_json, _interval) in &configs {
            // Find this user's nodes.
            let node_ids: Vec<String> = sqlx::query_scalar(
                "SELECT wk_id FROM nodes WHERE user_id = $1"
            ).bind(user_id).fetch_all(&state.pool).await.unwrap_or_default();

            if node_ids.is_empty() { continue; }

            // Read metrics from in-memory cache.
            let cache = state.metrics.read().unwrap();
            let mut resource_metrics = Vec::new();

            for nid in &node_ids {
                let entry = match cache.get(nid) {
                    Some(e) => e,
                    None => continue,
                };
                let m = match &entry.metrics {
                    Some(m) => m,
                    None => continue,
                };

                // Resolve power: NVIDIA > SoC > CPU
                let watts = m.nvidia_power_draw_w.or(m.apple_soc_power_w).or(m.cpu_power_w);
                let tok_s = m.ollama_tokens_per_second.or(m.vllm_tokens_per_sec);
                let wes = match (tok_s, watts, m.penalty_avg) {
                    (Some(t), Some(w), Some(p)) if w > 0.0 && p > 0.0 => Some(t / (w * p)),
                    _ => None,
                };
                let ttft = m.vllm_avg_ttft_ms.or(m.ollama_proxy_avg_ttft_ms).or(m.ollama_ttft_ms);

                let time_ns = format!("{}", m.timestamp_ms * 1_000_000);

                let mut data_points = Vec::new();
                let mut add_gauge = |name: &str, unit: &str, value: Option<f64>| {
                    if let Some(v) = value {
                        data_points.push(serde_json::json!({
                            "name": name,
                            "unit": unit,
                            "gauge": { "dataPoints": [{ "asDouble": v, "timeUnixNano": &time_ns }] }
                        }));
                    }
                };

                add_gauge("wicklee.gpu.utilization", "%",
                    m.gpu_utilization_percent.map(|v| v as f64)
                        .or(m.nvidia_gpu_utilization_percent.map(|v| v as f64)));
                add_gauge("wicklee.power.watts", "W", watts.map(|v| v as f64));
                add_gauge("wicklee.inference.tokens_per_second", "tok/s", tok_s.map(|v| v as f64));
                add_gauge("wicklee.wes.score", "score", wes.map(|v| v as f64));
                add_gauge("wicklee.thermal.penalty", "ratio", m.penalty_avg.map(|v| v as f64));
                add_gauge("wicklee.memory.pressure", "%", m.memory_pressure_percent.map(|v| v as f64));
                add_gauge("wicklee.inference.ttft_ms", "ms", ttft.map(|v| v as f64));

                // Add inference_state as a special data point with string attribute
                data_points.push(serde_json::json!({
                    "name": "wicklee.inference.state",
                    "unit": "1",
                    "gauge": { "dataPoints": [{
                        "asDouble": match m.inference_state.as_deref() { Some("live") => 3.0, Some("busy") => 2.0, Some("idle-spd") => 1.0, _ => 0.0 },
                        "timeUnixNano": &time_ns,
                        "attributes": [{ "key": "state", "value": { "stringValue": m.inference_state.as_deref().unwrap_or("unknown") } }]
                    }]}
                }));

                resource_metrics.push(serde_json::json!({
                    "resource": {
                        "attributes": [
                            { "key": "node.id", "value": { "stringValue": nid } },
                            { "key": "node.hostname", "value": { "stringValue": &m.hostname } },
                            { "key": "node.gpu.name", "value": { "stringValue": m.gpu_name.as_deref().unwrap_or("") } },
                            { "key": "node.os", "value": { "stringValue": &m.os } },
                            { "key": "node.arch", "value": { "stringValue": &m.arch } },
                            { "key": "service.name", "value": { "stringValue": "wicklee" } },
                            { "key": "service.version", "value": { "stringValue": &m.agent_version } },
                        ]
                    },
                    "scopeMetrics": [{
                        "scope": { "name": "wicklee", "version": &m.agent_version },
                        "metrics": data_points
                    }]
                }));
            }
            drop(cache);

            if resource_metrics.is_empty() { continue; }

            let payload = serde_json::json!({ "resourceMetrics": resource_metrics });
            let endpoint = endpoint_url.clone();
            let headers_str = auth_headers_json.clone();

            // Fire-and-forget: POST to OTLP endpoint using ureq in a blocking task.
            tokio::task::spawn_blocking(move || {
                let target = match resolve_outbound_blocking(&format!("{}/v1/metrics", endpoint.trim_end_matches('/'))) {
                    Ok(t) => t,
                    Err(e) => { eprintln!("[otel] refusing endpoint: {e}"); return; }
                };
                let mut req = pinned_ureq_agent(&target, Duration::from_secs(10))
                    .post(target.url.as_str())
                    .set("Content-Type", "application/json");

                // Parse auth headers JSON and apply them.
                if let Ok(hdrs) = serde_json::from_str::<HashMap<String, String>>(&headers_str) {
                    for (k, v) in &hdrs {
                        req = req.set(k, v);
                    }
                }

                match req.send_json(&payload) {
                    Ok(resp) => {
                        if resp.status() >= 400 {
                            eprintln!("[otel] export failed: HTTP {}", resp.status());
                        }
                    }
                    Err(e) => eprintln!("[otel] export error: {e}"),
                }
            });
        }
    }
}

// ── Prometheus Scrape Endpoint (Team+ tier, API key auth) ────────────────────

pub(crate) async fn handle_prometheus_metrics(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    // Validate API key through the same path as the V1 endpoints — the
    // previous inline query referenced an `expires_at` column that doesn't
    // exist on api_keys, so it errored on every call and this endpoint
    // returned 401 unconditionally. validate_api_key also brings the
    // per-key rate limit and `last_used_ms` bookkeeping for free.
    let api_key = match extract_api_key(&headers) {
        Some(k) if !k.is_empty() => k,
        _ => return (StatusCode::UNAUTHORIZED, "X-API-Key required").into_response(),
    };
    let (user_id, key_org, tier) = match validate_api_key(&api_key, &state.pool, &state.api_rate_limits).await {
        Some((_key_id, uid, korg, t)) => (uid, korg, t),
        None => return (StatusCode::UNAUTHORIZED, "Invalid API key or rate limit exceeded").into_response(),
    };

    // Tier gate — Team and above (was `!= "team" && != "enterprise"`, which
    // wrongly locked Business out of a feature its tier includes).
    if !is_team_or_above(&tier) {
        return upgrade_required("Prometheus metrics", UpgradePlan::Team);
    }

    // Build Prometheus text format from the tenant's nodes (org fleet for
    // org keys, personal nodes otherwise).
    let (tcol, tval) = tenant_scope(&user_id, &key_org);
    let node_ids: Vec<String> = sqlx::query_scalar(&format!("SELECT wk_id FROM nodes WHERE {tcol} = $1"))
        .bind(tval).fetch_all(&state.pool).await.unwrap_or_default();

    let cache = state.metrics.read().unwrap();
    let mut output = String::with_capacity(4096);

    let gauges = [
        ("wicklee_gpu_utilization", "GPU utilization percentage", "%"),
        ("wicklee_power_watts", "Power draw in watts", "W"),
        ("wicklee_inference_tokens_per_second", "Inference throughput", "tok/s"),
        ("wicklee_wes_score", "Wicklee Efficiency Score", "score"),
        ("wicklee_thermal_penalty", "Thermal penalty multiplier", "ratio"),
        ("wicklee_memory_pressure", "Memory pressure percentage", "%"),
        ("wicklee_inference_ttft_ms", "Time to first token", "ms"),
    ];

    for (name, help, _unit) in &gauges {
        output.push_str(&format!("# HELP {name} {help}\n# TYPE {name} gauge\n"));
        for nid in &node_ids {
            if let Some(entry) = cache.get(nid)
                && let Some(m) = &entry.metrics {
                    let hostname = m.hostname.as_deref().unwrap_or("");
                    let val = match *name {
                        "wicklee_gpu_utilization" => m.gpu_utilization_percent.map(|v| v as f64)
                            .or(m.nvidia_gpu_utilization_percent.map(|v| v as f64)),
                        "wicklee_power_watts" => m.nvidia_power_draw_w.or(m.apple_soc_power_w).or(m.cpu_power_w).map(|v| v as f64),
                        "wicklee_inference_tokens_per_second" => m.ollama_tokens_per_second.or(m.vllm_tokens_per_sec).map(|v| v as f64),
                        "wicklee_wes_score" => {
                            let tok = m.ollama_tokens_per_second.or(m.vllm_tokens_per_sec);
                            let w = m.nvidia_power_draw_w.or(m.apple_soc_power_w).or(m.cpu_power_w);
                            match (tok, w, m.penalty_avg) {
                                (Some(t), Some(w), Some(p)) if w > 0.0 && p > 0.0 => Some((t / (w * p)) as f64),
                                _ => None,
                            }
                        }
                        "wicklee_thermal_penalty" => m.penalty_avg.map(|v| v as f64),
                        "wicklee_memory_pressure" => m.memory_pressure_percent.map(|v| v as f64),
                        "wicklee_inference_ttft_ms" => m.vllm_avg_ttft_ms.or(m.ollama_proxy_avg_ttft_ms).or(m.ollama_ttft_ms).map(|v| v as f64),
                        _ => None,
                    };
                    if let Some(v) = val {
                        output.push_str(&format!("{name}{{node_id=\"{nid}\",hostname=\"{hostname}\"}} {v}\n"));
                    }
                }
        }
    }

    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")], output).into_response()
}
