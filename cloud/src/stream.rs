//! Fleet SSE stream.

use crate::*;

/// GET /api/fleet/stream — SSE stream pushing fleet snapshots every 2 s.
pub(crate) async fn handle_fleet_stream(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let stream_token = match params.get("token") {
        Some(t) if !t.is_empty() => t.clone(),
        _ => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing stream token" }))).into_response(),
    };

    let now = now_ms() as i64;
    let token_row = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT user_id, org_id FROM stream_tokens WHERE token = $1 AND expires_ms > $2"
    ).bind(&stream_token).bind(now).fetch_one(&state.pool).await;
    let (user_id, org_id) = match token_row {
        Ok(r) => r,
        Err(_) => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired stream token" }))).into_response(),
    };

    // Frames are produced by a per-connection task feeding a small channel.
    // The old stream closure ran its DB refreshes through block_in_place +
    // block_on, parking a runtime worker for every refresh of every open
    // dashboard. When the client disconnects the receiver drops, the next
    // send fails, and the task exits.
    let (tx, rx) = mpsc::channel::<Result<Event, Infallible>>(4);
    tokio::spawn(fleet_stream_task(state, user_id, org_id, tx));

    Sse::new(tokio_stream::wrappers::ReceiverStream::new(rx))
        .keep_alive(KeepAlive::default()).into_response()
}

/// One tenant node as the fleet stream sees it, in `paired_at` order.
pub(crate) struct FleetStreamNode {
    pub(crate) id:           String,
    pub(crate) display_name: Option<String>,
    pub(crate) tags:         Option<String>,
}

/// Fleet stream refresh cadence, in 2 s frames (= 60 s).
pub(crate) const FLEET_STREAM_REFRESH_TICKS: u32 = 30;

/// The tenant's nodes (ids + label metadata) oldest-paired first, in ONE
/// query — this replaces separate node-set, ordered-set, and metadata
/// queries. `tcol` comes from tenant_scope() (a fixed literal, never caller
/// data). None on DB error so the caller can keep its last good set.
pub(crate) async fn load_fleet_stream_nodes(
    tcol: &str,
    tval: &str,
    pool: &sqlx::PgPool,
) -> Option<Vec<FleetStreamNode>> {
    sqlx::query_as::<_, (String, Option<String>, Option<String>)>(
        &format!("SELECT wk_id, display_name, tags FROM nodes WHERE {tcol} = $1 ORDER BY paired_at ASC")
    ).bind(tval).fetch_all(pool).await.ok().map(|rows| {
        rows.into_iter()
            .map(|(id, display_name, tags)| FleetStreamNode { id, display_name, tags })
            .collect()
    })
}

/// Serialize one fleet frame: `{"nodes":[...]}` holding each tenant node that
/// has a live in-memory entry. Looks up only the tenant's own ids — the old
/// loop scanned the entire global metrics map on every frame of every stream.
/// Nodes past the tier's limit (by pairing order) are marked `restricted`.
pub(crate) fn build_fleet_frame(
    nodes: &[FleetStreamNode],
    node_limit: usize,
    metrics: &HashMap<String, MetricsEntry>,
) -> String {
    let node_list: Vec<serde_json::Value> = nodes.iter().enumerate()
        .filter_map(|(idx, node)| {
            let entry = metrics.get(&node.id)?;
            let mut obj = serde_json::json!({
                "node_id":      node.id,
                "last_seen_ms": entry.last_seen_ms,
                "metrics":      entry.metrics,
                "restricted":   idx >= node_limit,
            });
            if let Some(name) = &node.display_name {
                obj["display_name"] = serde_json::Value::String(name.clone());
            }
            if let Some(tags) = &node.tags {
                obj["tags"] = serde_json::Value::String(tags.clone());
            }
            Some(obj)
        })
        .collect();
    serde_json::to_string(&serde_json::json!({ "nodes": node_list }))
        .unwrap_or_else(|_| r#"{"nodes":[]}"#.to_string())
}

/// Per-connection producer for GET /api/fleet/stream: a frame every 2 s, with
/// the node set and tier refreshed every FLEET_STREAM_REFRESH_TICKS frames.
pub(crate) async fn fleet_stream_task(
    state:   AppState,
    user_id: String,
    org_id:  Option<String>,
    tx:      mpsc::Sender<Result<Event, Infallible>>,
) {
    // The stream token is checked only at connect (it expires in 60 s), so a
    // logout revocation must also end streams already open: each 60 s refresh
    // checks the user's revocation time against when this stream started.
    let stream_started_ms = now_ms() as i64;
    let (tcol, tval) = tenant_scope(&user_id, &org_id);

    let mut nodes = load_fleet_stream_nodes(tcol, tval, &state.pool).await.unwrap_or_default();
    let mut tier  = resolve_tier(&user_id, &org_id, &state.pool).await;

    let mut interval = tokio::time::interval(Duration::from_secs(2));
    // A slow client shouldn't get a burst of catch-up frames.
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut tick: u32 = 0;

    loop {
        interval.tick().await;
        tick = tick.wrapping_add(1);
        if tick.is_multiple_of(FLEET_STREAM_REFRESH_TICKS) {
            let revoked_ms: i64 = sqlx::query_scalar::<_, Option<i64>>(
                "SELECT streams_revoked_ms FROM users WHERE id = $1"
            ).bind(&user_id).fetch_optional(&state.pool).await
                .ok().flatten().flatten().unwrap_or(0);
            if revoked_ms >= stream_started_ms {
                return; // dropping tx ends the SSE response
            }
            // Keep the last good set on a transient DB error rather than
            // blanking the dashboard until the next refresh.
            if let Some(fresh) = load_fleet_stream_nodes(tcol, tval, &state.pool).await {
                nodes = fresh;
            }
            tier = resolve_tier(&user_id, &org_id, &state.pool).await;
        }

        let data = {
            let metrics_map = state.metrics.read().unwrap();
            build_fleet_frame(&nodes, node_limit_for_tier(&tier, false), &metrics_map)
        };
        if tx.send(Ok(Event::default().data(data))).await.is_err() {
            return; // client disconnected
        }
    }
}
