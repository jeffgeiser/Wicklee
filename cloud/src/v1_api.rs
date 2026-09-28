//! Agent API v1: API-key management and the /api/v1 fleet, WES, route and insights handlers.

use crate::*;

pub(crate) fn extract_api_key(headers: &HeaderMap) -> Option<String> {
    headers.get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_owned())
        .or_else(|| extract_bearer(headers))
}

// ── Agent API v1 types ────────────────────────────────────────────────────────

#[derive(Serialize)]
pub(crate) struct V1NodeInfo {
    pub(crate) node_id:      String,
    pub(crate) hostname:     Option<String>,
    pub(crate) online:       bool,
    pub(crate) last_seen_ms: u64,
    pub(crate) metrics:      Option<MetricsPayload>,
    pub(crate) wes:          Option<f32>,
}

#[derive(Serialize)]
pub(crate) struct V1FleetResponse {
    pub(crate) nodes: Vec<V1NodeInfo>,
}

#[derive(Serialize)]
pub(crate) struct V1WesNode {
    pub(crate) node_id: String,
    pub(crate) wes:     Option<f32>,
    pub(crate) online:  bool,
}

#[derive(Serialize)]
pub(crate) struct V1RouteCandidate {
    pub(crate) node:   String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tok_s:  Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) wes:    Option<f32>,
    pub(crate) reason: String,
}

#[derive(Serialize)]
pub(crate) struct V1RouteResponse {
    pub(crate) latency:    Option<V1RouteCandidate>,
    pub(crate) efficiency: Option<V1RouteCandidate>,
    pub(crate) default:    &'static str,
}

#[derive(Serialize)]
pub(crate) struct V1KeyInfo {
    pub(crate) key_id:       String,
    pub(crate) name:         String,
    pub(crate) created_at:   i64,
    pub(crate) last_used_ms: Option<i64>,
    /// "personal" (default) or "org" — org keys scope the V1 API to the
    /// org's whole fleet and are managed by org Admins.
    pub(crate) scope:        &'static str,
}

#[derive(Deserialize)]
pub(crate) struct V1CreateKeyRequest {
    pub(crate) name: String,
    /// "personal" (default) or "org". Org scope requires an active org in
    /// the session AND the Admin role.
    #[serde(default)]
    pub(crate) scope: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct V1CreateKeyResponse {
    pub(crate) key_id:     String,
    pub(crate) key:        String,
    pub(crate) name:       String,
    pub(crate) created_at: i64,
    pub(crate) scope:      &'static str,
}

// ── Agent API v1 handlers — key management ────────────────────────────────────

/// POST /api/v1/keys
pub(crate) async fn handle_v1_create_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<V1CreateKeyRequest>,
) -> impl IntoResponse {
    if body.name.trim().is_empty() {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "name is required" }))).into_response();
    }
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

    // Org-scoped keys: minted only by org Admins, bound to the verified org
    // claim. Personal keys (the default) keep the original per-user scope.
    let scope = body.scope.as_deref().unwrap_or("personal");
    let key_org: Option<String> = match scope {
        "personal" => None,
        "org" => {
            let Some(org) = org_id.clone() else {
                return (StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "error": "No active organization in session — switch to the org before minting an org key" }))).into_response();
            };
            if !role.is_admin() { return role_forbidden("admin"); }
            Some(org)
        }
        _ => return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "scope must be personal or org" }))).into_response(),
    };
    let scope_label: &'static str = if key_org.is_some() { "org" } else { "personal" };

    let name     = body.name.trim().to_owned();
    let raw_key  = format!("wk_live_{}", Uuid::new_v4().to_string().replace('-', ""));
    let key_hash = sha256_hex(&raw_key);
    let key_id   = Uuid::new_v4().to_string();
    let ts       = now_ms() as i64;

    let result = sqlx::query(
        "INSERT INTO api_keys (key_id, key_hash, user_id, name, created_at, org_id)
         VALUES ($1, $2, $3, $4, $5, $6)"
    ).bind(&key_id).bind(&key_hash).bind(&user_id).bind(&name).bind(ts).bind(&key_org)
    .execute(&state.pool).await;

    match result {
        Ok(_) => {
            audit(&state.pool, &user_id, &key_org, "api_key.created", &key_id,
                serde_json::json!({ "name": &name, "scope": scope_label }));
            (StatusCode::CREATED, Json(V1CreateKeyResponse {
                key_id, key: raw_key, name, created_at: ts, scope: scope_label,
            })).into_response()
        }
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal error" }))).into_response(),
    }
}

/// GET /api/v1/keys
pub(crate) async fn handle_v1_list_keys(
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

    // Personal keys (yours, org_id NULL) + the active org's keys (visible to
    // every member — they're shared infrastructure; only Admins mint/revoke).
    let keys: Vec<(String, String, i64, Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT key_id, name, created_at, last_used_ms, org_id
         FROM api_keys
         WHERE (user_id = $1 AND org_id IS NULL) OR ($2::text IS NOT NULL AND org_id = $2)
         ORDER BY created_at DESC"
    ).bind(&user_id).bind(&org_id).fetch_all(&state.pool).await.unwrap_or_default();

    let key_list: Vec<V1KeyInfo> = keys.into_iter().map(|(key_id, name, created_at, last_used_ms, korg)| {
        V1KeyInfo { key_id, name, created_at, last_used_ms,
                    scope: if korg.is_some() { "org" } else { "personal" } }
    }).collect();

    Json(serde_json::json!({ "keys": key_list })).into_response()
}

/// DELETE /api/nodes/:node_id
pub(crate) async fn handle_delete_node(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(node_id): Path<String>,
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

    // Org members can remove any node in the shared fleet; solo users only
    // their own. tenant_id on the metrics tables is the same scope column.
    let (tcol, tval) = tenant_scope(&user_id, &org_id);
    let result = sqlx::query(
        &format!("DELETE FROM nodes WHERE wk_id = $1 AND {tcol} = $2")
    ).bind(&node_id).bind(tval).execute(&state.pool).await;

    match result {
        Ok(r) if r.rows_affected() == 0 => {
            (StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "Node not found" }))).into_response()
        }
        Ok(_) => {
            // Purge stored metrics (tenant_id = org_id for org nodes).
            let _ = sqlx::query("DELETE FROM metrics_raw WHERE node_id = $1 AND tenant_id = $2")
                .bind(&node_id).bind(tval).execute(&state.pool).await;
            let _ = sqlx::query("DELETE FROM metrics_5min WHERE node_id = $1 AND tenant_id = $2")
                .bind(&node_id).bind(tval).execute(&state.pool).await;

            // Evict from in-memory cache.
            state.metrics.write().unwrap().remove(&node_id);
            audit(&state.pool, &user_id, &org_id, "node.removed", &node_id, serde_json::json!({}));
            StatusCode::NO_CONTENT.into_response()
        }
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal error" }))).into_response(),
    }
}

/// DELETE /api/v1/keys/:key_id
pub(crate) async fn handle_v1_delete_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(key_id): Path<String>,
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

    // Personal keys: owner deletes their own. Org keys: any Admin of the
    // key's org (checked against the verified claim, not ownership).
    let personal = sqlx::query(
        "DELETE FROM api_keys WHERE key_id = $1 AND user_id = $2 AND org_id IS NULL"
    ).bind(&key_id).bind(&user_id).execute(&state.pool).await;

    match personal {
        Ok(r) if r.rows_affected() > 0 => {
            audit(&state.pool, &user_id, &None, "api_key.deleted", &key_id,
                serde_json::json!({ "scope": "personal" }));
            return StatusCode::NO_CONTENT.into_response();
        }
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal error" }))).into_response(),
        Ok(_) => {} // not a personal key — fall through to the org path
    }

    if let Some(ref org) = org_id {
        let is_org_key: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM api_keys WHERE key_id = $1 AND org_id = $2)"
        ).bind(&key_id).bind(org).fetch_one(&state.pool).await.unwrap_or(false);
        if is_org_key {
            if !role.is_admin() { return role_forbidden("admin"); }
            let result = sqlx::query("DELETE FROM api_keys WHERE key_id = $1 AND org_id = $2")
                .bind(&key_id).bind(org).execute(&state.pool).await;
            return match result {
                Ok(r) if r.rows_affected() > 0 => {
                    audit(&state.pool, &user_id, &org_id, "api_key.deleted", &key_id,
                        serde_json::json!({ "scope": "org" }));
                    StatusCode::NO_CONTENT.into_response()
                }
                Ok(_) => (StatusCode::NOT_FOUND,
                    Json(serde_json::json!({ "error": "Key not found" }))).into_response(),
                Err(_) => (StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": "Internal error" }))).into_response(),
            };
        }
    }

    (StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "error": "Key not found" }))).into_response()
}

// ── Agent API v1 handlers — fleet data ────────────────────────────────────────

/// GET /api/v1/fleet
pub(crate) async fn handle_v1_fleet(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let raw_key = match extract_api_key(&headers) {
        Some(k) => k,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing API key" }))).into_response(),
    };

    let (_key_id, user_id, key_org, _tier) = match validate_api_key(&raw_key, &state.pool, &state.api_rate_limits).await {
        Some(r) => r,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid API key or rate limit exceeded" }))).into_response(),
    };
    let (tcol, tval) = tenant_scope(&user_id, &key_org);

    let persisted: Vec<(String, i64)> = sqlx::query_as(
        &format!("SELECT wk_id, last_seen FROM nodes WHERE {tcol} = $1 ORDER BY last_seen DESC")
    ).bind(tval).fetch_all(&state.pool).await.unwrap_or_default();

    let metrics_map = state.metrics.read().unwrap();
    let now = now_ms();
    let nodes: Vec<V1NodeInfo> = persisted.into_iter().map(|(node_id, last_seen_db)| {
        let (last_seen_ms, metrics) = metrics_map.get(&node_id)
            .map(|e| (e.last_seen_ms, e.metrics.clone()))
            .unwrap_or((last_seen_db as u64, None));
        let online   = now.saturating_sub(last_seen_ms) < ONLINE_THRESHOLD_MS;
        let wes      = metrics.as_ref().and_then(wes_for_payload);
        let hostname = metrics.as_ref().and_then(|m| m.hostname.clone());
        V1NodeInfo { node_id, hostname, online, last_seen_ms, metrics, wes }
    }).collect();

    Json(V1FleetResponse { nodes }).into_response()
}

/// GET /api/v1/fleet/wes
pub(crate) async fn handle_v1_fleet_wes(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let raw_key = match extract_api_key(&headers) {
        Some(k) => k,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing API key" }))).into_response(),
    };

    let (_key_id, user_id, key_org, _tier) = match validate_api_key(&raw_key, &state.pool, &state.api_rate_limits).await {
        Some(r) => r,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid API key or rate limit exceeded" }))).into_response(),
    };
    let (tcol, tval) = tenant_scope(&user_id, &key_org);

    let node_ids: Vec<String> = sqlx::query_scalar(
        &format!("SELECT wk_id FROM nodes WHERE {tcol} = $1")
    ).bind(tval).fetch_all(&state.pool).await.unwrap_or_default();

    let metrics_map = state.metrics.read().unwrap();
    let now = now_ms();
    let nodes: Vec<V1WesNode> = node_ids.into_iter().map(|node_id| {
        let entry        = metrics_map.get(&node_id);
        let last_seen_ms = entry.map(|e| e.last_seen_ms).unwrap_or(0);
        let online       = now.saturating_sub(last_seen_ms) < ONLINE_THRESHOLD_MS;
        let wes          = entry.and_then(|e| e.metrics.as_ref()).and_then(wes_for_payload);
        V1WesNode { node_id, wes, online }
    }).collect();

    Json(serde_json::json!({ "nodes": nodes })).into_response()
}

/// GET /api/v1/nodes/:id
pub(crate) async fn handle_v1_node(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(node_id): Path<String>,
) -> impl IntoResponse {
    let raw_key = match extract_api_key(&headers) {
        Some(k) => k,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing API key" }))).into_response(),
    };

    let (_key_id, user_id, key_org, _tier) = match validate_api_key(&raw_key, &state.pool, &state.api_rate_limits).await {
        Some(r) => r,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid API key or rate limit exceeded" }))).into_response(),
    };
    let (tcol, tval) = tenant_scope(&user_id, &key_org);

    let owned: bool = sqlx::query_scalar::<_, bool>(
        &format!("SELECT EXISTS(SELECT 1 FROM nodes WHERE wk_id = $1 AND {tcol} = $2)")
    ).bind(&node_id).bind(tval).fetch_one(&state.pool).await.unwrap_or(false);

    if !owned {
        return (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Node not found" }))).into_response();
    }

    let metrics_map = state.metrics.read().unwrap();
    let now = now_ms();

    match metrics_map.get(&node_id) {
        None => (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Node not found" }))).into_response(),
        Some(entry) => {
            let last_seen_ms = entry.last_seen_ms;
            let online   = now.saturating_sub(last_seen_ms) < ONLINE_THRESHOLD_MS;
            let wes      = entry.metrics.as_ref().and_then(wes_for_payload);
            let hostname = entry.metrics.as_ref().and_then(|m| m.hostname.clone());
            Json(V1NodeInfo {
                node_id, hostname, online, last_seen_ms,
                metrics: entry.metrics.clone(), wes,
            }).into_response()
        }
    }
}

/// GET /api/v1/route/best?model=qwen2.5:7b — routing recommendation.
/// Optional `model` param filters to nodes that have that model loaded and uses
/// per-model metrics (tok/s, WES) when available via active_models array.
pub(crate) async fn handle_v1_route_best(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let raw_key = match extract_api_key(&headers) {
        Some(k) => k,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing API key" }))).into_response(),
    };

    let (_key_id, user_id, key_org, _tier) = match validate_api_key(&raw_key, &state.pool, &state.api_rate_limits).await {
        Some(r) => r,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid API key or rate limit exceeded" }))).into_response(),
    };
    let (tcol, tval) = tenant_scope(&user_id, &key_org);

    let model_filter = params.get("model").cloned();

    let node_ids: Vec<String> = sqlx::query_scalar(
        &format!("SELECT wk_id FROM nodes WHERE {tcol} = $1")
    ).bind(tval).fetch_all(&state.pool).await.unwrap_or_default();

    let metrics_map = state.metrics.read().unwrap();
    let now = now_ms();

    struct NodeScore {
        node_id: String,
        tok_s:   Option<f32>,
        wes:     Option<f32>,
    }

    let candidates: Vec<NodeScore> = node_ids.into_iter().filter_map(|node_id| {
        let entry = metrics_map.get(&node_id)?;
        if now.saturating_sub(entry.last_seen_ms) >= ONLINE_THRESHOLD_MS { return None; }
        let m = entry.metrics.as_ref()?;

        // Per-model routing: when model param is specified, check if node has it loaded
        if let Some(ref target_model) = model_filter {
            // Check active_models array first (multi-model)
            if let Some(ref models) = m.active_models {
                if let Some(am) = models.iter().find(|am| &am.model == target_model) {
                    return Some(NodeScore { node_id, tok_s: am.tok_s, wes: am.wes });
                }
                return None; // Node doesn't have this model loaded
            }
            // Fallback to singular active model
            if m.ollama_active_model.as_deref() != Some(target_model) {
                return None;
            }
        }

        let tok_s = if m.vllm_running { m.vllm_tokens_per_sec } else { m.ollama_tokens_per_second };
        let wes   = wes_for_payload(m);
        Some(NodeScore { node_id, tok_s, wes })
    }).collect();

    let best_latency = candidates.iter()
        .filter_map(|c| c.tok_s.map(|t| (c, t)))
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(c, t)| V1RouteCandidate {
            node: c.node_id.clone(), tok_s: Some(t), wes: c.wes,
            reason: "Highest throughput".into(),
        });

    let best_efficiency = candidates.iter()
        .filter_map(|c| c.wes.map(|w| (c, w)))
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(c, w)| V1RouteCandidate {
            node: c.node_id.clone(), tok_s: c.tok_s, wes: Some(w),
            reason: "Highest WES".into(),
        });

    Json(V1RouteResponse {
        latency: best_latency, efficiency: best_efficiency, default: "efficiency",
    }).into_response()
}

// ── GET /api/v1/insights/latest ───────────────────────────────────────────────

#[derive(Serialize)]
pub(crate) struct V1InsightsFleet {
    pub(crate) online_count: usize,
    pub(crate) total_count:  usize,
    pub(crate) avg_wes:      Option<f32>,
    pub(crate) fleet_tok_s:  Option<f32>,
}

#[derive(Serialize)]
pub(crate) struct V1InsightFinding {
    pub(crate) node_id:  String,
    pub(crate) hostname: Option<String>,
    pub(crate) severity: &'static str,
    pub(crate) pattern:  &'static str,
    pub(crate) title:    String,
    pub(crate) detail:   String,
    pub(crate) value:    Option<f32>,
    pub(crate) unit:     Option<&'static str>,
}

#[derive(Serialize)]
pub(crate) struct V1InsightsResponse {
    pub(crate) generated_at_ms: u64,
    pub(crate) fleet:           V1InsightsFleet,
    pub(crate) findings:        Vec<V1InsightFinding>,
}

/// GET /api/v1/insights/latest
pub(crate) async fn handle_v1_insights_latest(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let raw_key = match extract_api_key(&headers) {
        Some(k) => k,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing API key" }))).into_response(),
    };

    let (_key_id, user_id, key_org, tier) = match validate_api_key(&raw_key, &state.pool, &state.api_rate_limits).await {
        Some(r) => r,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid API key or rate limit exceeded" }))).into_response(),
    };
    let (tcol, tval) = tenant_scope(&user_id, &key_org);

    // Insights API is Team+ only
    if !is_team_or_above(&tier) {
        return upgrade_required("Insights API", UpgradePlan::Team);
    }

    let node_ids: Vec<String> = sqlx::query_scalar(
        &format!("SELECT wk_id FROM nodes WHERE {tcol} = $1")
    ).bind(tval).fetch_all(&state.pool).await.unwrap_or_default();

    let metrics_map = state.metrics.read().unwrap();
    let now = now_ms();
    let total_count = node_ids.len();

    struct NodeSnap {
        node_id:  String,
        hostname: Option<String>,
        online:   bool,
        metrics:  Option<MetricsPayload>,
        wes:      Option<f32>,
        tok_s:    Option<f32>,
    }

    let snaps: Vec<NodeSnap> = node_ids.into_iter().map(|node_id| {
        let entry    = metrics_map.get(&node_id);
        let online   = entry.map(|e| now.saturating_sub(e.last_seen_ms) < ONLINE_THRESHOLD_MS).unwrap_or(false);
        let metrics  = entry.and_then(|e| e.metrics.clone());
        let wes      = metrics.as_ref().and_then(wes_for_payload);
        let tok_s    = metrics.as_ref().and_then(|m| {
            if m.vllm_running { m.vllm_tokens_per_sec } else { m.ollama_tokens_per_second }
        });
        let hostname = metrics.as_ref().and_then(|m| m.hostname.clone());
        NodeSnap { node_id, hostname, online, metrics, wes, tok_s }
    }).collect();

    let online_count = snaps.iter().filter(|s| s.online).count();
    let wes_vals: Vec<f32> = snaps.iter().filter_map(|s| if s.online { s.wes } else { None }).collect();
    let avg_wes = if wes_vals.is_empty() { None } else {
        Some((wes_vals.iter().sum::<f32>() / wes_vals.len() as f32 * 10.0).round() / 10.0)
    };
    let tok_vals: Vec<f32> = snaps.iter().filter_map(|s| if s.online { s.tok_s } else { None }).collect();
    let fleet_tok_s = if tok_vals.is_empty() { None } else {
        Some((tok_vals.iter().sum::<f32>() * 10.0).round() / 10.0)
    };

    let mut findings: Vec<V1InsightFinding> = Vec::new();

    if total_count > 0 && online_count == 0 {
        findings.push(V1InsightFinding {
            node_id: "fleet".into(), hostname: None, severity: "high",
            pattern: "fleet_offline",
            title: "Fleet offline".into(),
            detail: format!("All {total_count} registered nodes are unreachable (last telemetry > 30s ago)."),
            value: None, unit: None,
        });
    }

    for snap in &snaps {
        if !snap.online && total_count > 1 {
            findings.push(V1InsightFinding {
                node_id: snap.node_id.clone(), hostname: snap.hostname.clone(),
                severity: "moderate", pattern: "node_offline",
                title: format!("{} offline", snap.hostname.as_deref().unwrap_or(&snap.node_id)),
                detail: "Node has not reported telemetry in the last 30 seconds.".into(),
                value: None, unit: None,
            });
            continue;
        }

        let Some(ref m) = snap.metrics else { continue };

        match m.thermal_state.as_deref() {
            Some("Critical") => findings.push(V1InsightFinding {
                node_id: snap.node_id.clone(), hostname: snap.hostname.clone(),
                severity: "high", pattern: "thermal_stress",
                title: format!("Critical thermal state on {}", snap.hostname.as_deref().unwrap_or(&snap.node_id)),
                detail: "Thermal state: Critical — WES penalised 2×. Throughput may be severely throttled.".into(),
                value: snap.wes, unit: Some("WES"),
            }),
            Some("Serious") => findings.push(V1InsightFinding {
                node_id: snap.node_id.clone(), hostname: snap.hostname.clone(),
                severity: "moderate", pattern: "thermal_stress",
                title: format!("Thermal stress on {}", snap.hostname.as_deref().unwrap_or(&snap.node_id)),
                detail: "Thermal state: Serious — WES penalised 1.75×. Consider redistributing load.".into(),
                value: snap.wes, unit: Some("WES"),
            }),
            _ => {}
        }

        if let Some(mem_pct) = m.memory_pressure_percent {
            if mem_pct >= 90.0 {
                findings.push(V1InsightFinding {
                    node_id: snap.node_id.clone(), hostname: snap.hostname.clone(),
                    severity: "high", pattern: "memory_pressure",
                    title: format!("High memory pressure on {}", snap.hostname.as_deref().unwrap_or(&snap.node_id)),
                    detail: format!("Memory pressure: {mem_pct:.0}% — swap thrashing likely. Throughput may degrade."),
                    value: Some(mem_pct), unit: Some("%"),
                });
            } else if mem_pct >= 75.0 {
                findings.push(V1InsightFinding {
                    node_id: snap.node_id.clone(), hostname: snap.hostname.clone(),
                    severity: "moderate", pattern: "memory_pressure",
                    title: format!("Elevated memory pressure on {}", snap.hostname.as_deref().unwrap_or(&snap.node_id)),
                    detail: format!("Memory pressure: {mem_pct:.0}% — monitor for swap activity."),
                    value: Some(mem_pct), unit: Some("%"),
                });
            }
        }

        if online_count >= 2
            && let (Some(node_tok), Some(fleet_avg)) = (snap.tok_s, fleet_tok_s.map(|t| t / online_count as f32))
                && fleet_avg > 5.0 && node_tok < fleet_avg * 0.40 {
                    findings.push(V1InsightFinding {
                        node_id: snap.node_id.clone(), hostname: snap.hostname.clone(),
                        severity: "low", pattern: "low_throughput",
                        title: format!("Low throughput on {}", snap.hostname.as_deref().unwrap_or(&snap.node_id)),
                        detail: format!("{:.1} tok/s vs fleet average {:.1} tok/s — node is underperforming.", node_tok, fleet_avg),
                        value: Some(node_tok), unit: Some("tok/s"),
                    });
                }

        if online_count >= 2
            && let (Some(node_wes), Some(fleet_avg_wes)) = (snap.wes, avg_wes)
                && fleet_avg_wes > 1.0 && node_wes < fleet_avg_wes * 0.40 {
                    findings.push(V1InsightFinding {
                        node_id: snap.node_id.clone(), hostname: snap.hostname.clone(),
                        severity: "low", pattern: "wes_below_baseline",
                        title: format!("WES below fleet average on {}", snap.hostname.as_deref().unwrap_or(&snap.node_id)),
                        detail: format!("WES {:.1} vs fleet average {:.1} — check thermal state and power headroom.", node_wes, fleet_avg_wes),
                        value: Some(node_wes), unit: Some("WES"),
                    });
                }
    }

    let sev_ord = |s: &str| match s { "high" => 0u8, "moderate" => 1, _ => 2 };
    findings.sort_by(|a, b| {
        sev_ord(a.severity).cmp(&sev_ord(b.severity))
            .then_with(|| a.node_id.cmp(&b.node_id))
    });

    Json(V1InsightsResponse {
        generated_at_ms: now,
        fleet: V1InsightsFleet { online_count, total_count, avg_wes, fleet_tok_s },
        findings,
    }).into_response()
}
