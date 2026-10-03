//! Cloud MCP server.

use crate::*;

// ── Cloud MCP Server (Team+ tier) ─────────────────────────────────────────────

pub(crate) async fn handle_cloud_mcp_manifest() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "schema_version": "2024-11-05",
        "name":           "wicklee-cloud",
        "version":        env!("CARGO_PKG_VERSION"),
        "description":    "Fleet-aggregated GPU monitor — multi-node status, routing, observations, and efficiency scores for AI inference fleets.",
        "transport":      { "type": "http", "url": "/mcp" },
        "capabilities":   { "tools": true, "resources": true }
    }))
}

pub(crate) fn mcp_ok(id: &serde_json::Value, r: serde_json::Value) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "jsonrpc":"2.0", "result": r, "id": id }))
}
pub(crate) fn mcp_err(id: &serde_json::Value, c: i32, m: &str) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "jsonrpc":"2.0", "error":{"code":c,"message":m}, "id": id }))
}
pub(crate) fn mcp_tool(id: &serde_json::Value, v: serde_json::Value) -> Json<serde_json::Value> {
    mcp_ok(id, serde_json::json!({ "content":[{"type":"text","text": serde_json::to_string_pretty(&v).unwrap_or_default()}] }))
}

pub(crate) async fn handle_cloud_mcp(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> Json<serde_json::Value> {
    let req: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => return Json(serde_json::json!({ "jsonrpc":"2.0", "error":{"code":-32700,"message":"Parse error"}, "id": null })),
    };

    let req_id = req.get("id").cloned().unwrap_or(serde_json::Value::Null);

    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return mcp_err(&req_id, -32000, "Missing auth token"),
    };
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let (user_id, org_id) = match require_user_and_org(&token, &state.pool, &clerk_keys).await {
        Some(v) => v,
        None => return mcp_err(&req_id, -32000, "Invalid or expired session"),
    };
    // Org-aware: org members are entitled by the org subscription.
    let tier = resolve_tier(&user_id, &org_id, &state.pool).await;
    if !is_team_or_above(&tier) {
        return mcp_err(&req_id, -32000, "Cloud MCP requires Team tier or above");
    }

    // Rate limit: sliding window (600 req/60s, same as Team-tier API)
    {
        let now_rate = now_ms();
        let window_ms = 60_000u64;
        let mut limits = state.api_rate_limits.lock().unwrap();
        let timestamps = limits.entry(format!("mcp:{user_id}")).or_insert_with(Vec::new);
        timestamps.retain(|&ts| now_rate.saturating_sub(ts) < window_ms);
        if timestamps.len() >= API_RATE_TEAM {
            return mcp_err(&req_id, -32000, "Rate limit exceeded (600 req/min)");
        }
        timestamps.push(now_rate);
    }

    let method = req.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or(serde_json::json!({}));
    let (tcol, tval) = tenant_scope(&user_id, &org_id);
    let node_ids: Vec<String> = sqlx::query_scalar(
        &format!("SELECT wk_id FROM nodes WHERE {} = $1", tcol)
    ).bind(tval).fetch_all(&state.pool).await.unwrap_or_default();
    let now = now_ms();

    // Snapshot metrics into owned data so no RwLockReadGuard crosses an await point.
    let metrics_snapshot: HashMap<String, MetricsEntry> = {
        let map = state.metrics.read().unwrap();
        node_ids.iter().filter_map(|nid| {
            let e = map.get(nid)?;
            Some((nid.clone(), e.clone()))
        }).collect()
    };

    match method {
        "initialize" => mcp_ok(&req_id, serde_json::json!({
            "protocolVersion": "2024-11-05",
            "serverInfo": { "name": "wicklee-cloud", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": { "tools": {}, "resources": {} }
        })),
        "notifications/initialized" => mcp_ok(&req_id, serde_json::json!({})),

        "tools/list" => mcp_ok(&req_id, serde_json::json!({ "tools": [
            { "name": "get_fleet_status",       "description": "All nodes with online status, metrics, and WES.",              "inputSchema": { "type": "object", "properties": {} } },
            { "name": "get_fleet_wes",          "description": "Compact WES scores for all fleet nodes.",                      "inputSchema": { "type": "object", "properties": {} } },
            { "name": "get_node_detail",        "description": "Full metrics for a specific node.",                            "inputSchema": { "type": "object", "properties": { "node_id": { "type": "string" } }, "required": ["node_id"] } },
            { "name": "get_best_route",         "description": "Routing recommendation: best node by throughput and WES.",     "inputSchema": { "type": "object", "properties": {} } },
            { "name": "get_fleet_insights",     "description": "Fleet health summary with active observation count.",          "inputSchema": { "type": "object", "properties": {} } },
            { "name": "get_fleet_observations", "description": "Active and resolved observations across the fleet.",           "inputSchema": { "type": "object", "properties": { "state": { "type": "string", "enum": ["open","all"], "default": "open" } } } },
            { "name": "get_inference_profile",  "description": "Correlated inference timeline: TTFT, tok/s, KV cache, queue depth, thermal, power on one time axis. Chrome DevTools for inference.", "inputSchema": { "type": "object", "properties": { "node_id": { "type": "string" }, "minutes": { "type": "integer", "default": 60 } }, "required": ["node_id"] } },
            { "name": "explain_slowdown",       "description": "Root cause analysis for a slow inference request. Correlates TTFT spike with KV cache, thermal, queue, swap to explain why.", "inputSchema": { "type": "object", "properties": { "node_id": { "type": "string" }, "ts_ms": { "type": "integer", "description": "Timestamp of the slow request in Unix milliseconds" } }, "required": ["node_id", "ts_ms"] } },
            { "name": "get_fleet_model_fit",    "description": "Analyzes model fit across all fleet nodes — Memory Fit (is there safe VRAM/RAM headroom?), Efficiency (WES score), and Quant Recommendation. Returns per-node fit scores and a fleet-level summary answering 'which nodes are running their models well?'", "inputSchema": { "type": "object", "properties": {} } },
        ] })),

        "tools/call" => {
            let tool = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(serde_json::json!({}));

            match tool {
                "get_fleet_status" => {
                    let map = &metrics_snapshot;
                    let nodes: Vec<serde_json::Value> = node_ids.iter().map(|nid| {
                        let e = map.get(nid);
                        let on = e.map(|e| now.saturating_sub(e.last_seen_ms) < ONLINE_THRESHOLD_MS).unwrap_or(false);
                        let m  = e.and_then(|e| e.metrics.as_ref());
                        serde_json::json!({
                            "node_id": nid, "hostname": m.and_then(|p| p.hostname.as_deref()), "online": on,
                            "inference_state": m.and_then(|p| p.inference_state.as_deref()),
                            "wes": m.and_then(wes_for_payload),
                            "tok_s": m.and_then(|p| if p.vllm_running { p.vllm_tokens_per_sec } else { p.ollama_tokens_per_second }),
                            "thermal_state": m.and_then(|p| p.thermal_state.as_deref()),
                        })
                    }).collect();
                    let c = nodes.len();
                    mcp_tool(&req_id, serde_json::json!({ "nodes": nodes, "count": c }))
                }
                "get_fleet_wes" => {
                    let map = &metrics_snapshot;
                    let nodes: Vec<serde_json::Value> = node_ids.iter().filter_map(|nid| {
                        let e = map.get(nid)?; let m = e.metrics.as_ref()?; let w = wes_for_payload(m)?;
                        Some(serde_json::json!({ "node_id": nid, "wes": w, "online": now.saturating_sub(e.last_seen_ms) < ONLINE_THRESHOLD_MS }))
                    }).collect();
                    mcp_tool(&req_id, serde_json::json!({ "nodes": nodes }))
                }
                "get_node_detail" => {
                    let target = args.get("node_id").and_then(|v| v.as_str()).unwrap_or("");
                    if target.is_empty() { return mcp_err(&req_id, -32602, "node_id required"); }
                    if !node_ids.contains(&target.to_string()) { return mcp_err(&req_id, -32602, "Node not in your fleet"); }
                    let map = &metrics_snapshot;
                    let e = map.get(target);
                    let on = e.map(|e| now.saturating_sub(e.last_seen_ms) < ONLINE_THRESHOLD_MS).unwrap_or(false);
                    let m  = e.and_then(|e| e.metrics.as_ref());
                    mcp_tool(&req_id, serde_json::json!({ "node_id": target, "online": on, "metrics": m.map(|p| serde_json::to_value(p).unwrap_or_default()) }))
                }
                "get_best_route" => {
                    let map = &metrics_snapshot;
                    let (mut bt, mut bw): (Option<(String, f32)>, Option<(String, f32)>) = (None, None);
                    for nid in &node_ids {
                        let e = match map.get(nid) { Some(e) => e, None => continue };
                        if now.saturating_sub(e.last_seen_ms) >= ONLINE_THRESHOLD_MS { continue; }
                        let m = match e.metrics.as_ref() { Some(m) => m, None => continue };
                        if let Some(t) = if m.vllm_running { m.vllm_tokens_per_sec } else { m.ollama_tokens_per_second }
                            && bt.as_ref().is_none_or(|(_, b)| t > *b) { bt = Some((nid.clone(), t)); }
                        if let Some(w) = wes_for_payload(m)
                            && bw.as_ref().is_none_or(|(_, b)| w > *b) { bw = Some((nid.clone(), w)); }
                    }
                    mcp_tool(&req_id, serde_json::json!({
                        "latency": bt.map(|(n, t)| serde_json::json!({ "node": n, "tok_s": t })),
                        "efficiency": bw.map(|(n, w)| serde_json::json!({ "node": n, "wes": w })),
                        "default": "efficiency"
                    }))
                }
                "get_fleet_insights" => {
                    let map = &metrics_snapshot;
                    let online = node_ids.iter().filter(|n| map.get(*n).map(|e| now.saturating_sub(e.last_seen_ms) < ONLINE_THRESHOLD_MS).unwrap_or(false)).count();
                    let wv: Vec<f32> = node_ids.iter().filter_map(|n| { let e = map.get(n)?; if now.saturating_sub(e.last_seen_ms) >= ONLINE_THRESHOLD_MS { return None; } wes_for_payload(e.metrics.as_ref()?) }).collect();
                    let avg = if wv.is_empty() { None } else { Some((wv.iter().sum::<f32>() / wv.len() as f32 * 10.0).round() / 10.0) };
                    let tv: Vec<f32> = node_ids.iter().filter_map(|n| { let e = map.get(n)?; if now.saturating_sub(e.last_seen_ms) >= ONLINE_THRESHOLD_MS { return None; } let m = e.metrics.as_ref()?; if m.vllm_running { m.vllm_tokens_per_sec } else { m.ollama_tokens_per_second } }).collect();
                    let ftps = if tv.is_empty() { None } else { Some((tv.iter().sum::<f32>() * 10.0).round() / 10.0) };
                    // tval, not user_id — observations are keyed by tenant
                    // (org id for org sessions; node listing above already
                    // scopes by tval).
                    let obs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM fleet_observations WHERE tenant_id = $1 AND state = 'open'")
                        .bind(tval).fetch_one(&state.pool).await.unwrap_or(0);
                    mcp_tool(&req_id, serde_json::json!({ "fleet": { "online": online, "total": node_ids.len(), "avg_wes": avg, "fleet_tok_s": ftps }, "active_observations": obs }))
                }
                "get_fleet_observations" => {
                    let obs_state = args.get("state").and_then(|v| v.as_str()).unwrap_or("open");
                    let allowed = allowed_patterns_for_tier(&tier);
                    let sql = if obs_state == "all" {
                        "SELECT id, node_id, alert_type, severity, state, title, detail, context_json::text, fired_at_ms, resolved_at_ms FROM fleet_observations WHERE tenant_id = $1 AND alert_type = ANY($2) ORDER BY fired_at_ms DESC LIMIT 50"
                    } else {
                        "SELECT id, node_id, alert_type, severity, state, title, detail, context_json::text, fired_at_ms, resolved_at_ms FROM fleet_observations WHERE tenant_id = $1 AND alert_type = ANY($2) AND state = 'open' ORDER BY fired_at_ms DESC LIMIT 50"
                    };
                    let rows: Vec<(String, String, String, String, String, String, String, Option<String>, i64, Option<i64>)> =
                        sqlx::query_as(sql).bind(tval).bind(&allowed).fetch_all(&state.pool).await.unwrap_or_default();
                    let obs: Vec<serde_json::Value> = rows.into_iter().map(|(id, nid, at, sev, st, t, d, ctx, f, r)| {
                        serde_json::json!({ "id": id, "node_id": nid, "alert_type": at, "severity": sev, "state": st, "title": t, "detail": d, "context": ctx, "fired_at_ms": f, "resolved_at_ms": r })
                    }).collect();
                    let c = obs.len();
                    mcp_tool(&req_id, serde_json::json!({ "observations": obs, "count": c }))
                }
                "get_inference_profile" => {
                    let target = args.get("node_id").and_then(|v| v.as_str()).unwrap_or("");
                    if target.is_empty() { return mcp_err(&req_id, -32602, "node_id required"); }
                    if !node_ids.contains(&target.to_string()) { return mcp_err(&req_id, -32602, "Node not in your fleet"); }
                    let minutes = args.get("minutes").and_then(|v| v.as_i64()).unwrap_or(60);
                    let map = &metrics_snapshot;
                    let e = map.get(target);
                    let m = e.and_then(|e| e.metrics.as_ref());
                    // Return current snapshot as a profile point + guidance to use the agent's local /api/profile endpoint for full history
                    let current = m.map(|p| serde_json::json!({
                        "ts_ms": p.timestamp_ms,
                        "model": p.ollama_active_model.as_deref().or(p.vllm_model_name.as_deref()),
                        "tok_s": if p.vllm_running { p.vllm_tokens_per_sec } else { p.ollama_tokens_per_second },
                        "ttft_ms": p.vllm_avg_ttft_ms.or(p.ollama_proxy_avg_ttft_ms).or(p.ollama_ttft_ms),
                        "latency_ms": p.vllm_avg_e2e_latency_ms.or(p.ollama_proxy_avg_latency_ms),
                        "queue_depth": p.vllm_requests_waiting,
                        "kv_cache_pct": p.vllm_cache_usage_perc,
                        "power_w": p.nvidia_power_draw_w.or(p.apple_soc_power_w).or(p.cpu_power_w),
                        "thermal_state": p.thermal_state.as_deref(),
                        "thermal_penalty": p.penalty_avg,
                        "gpu_util_pct": p.nvidia_gpu_utilization_percent.or(p.gpu_utilization_percent),
                        "gpu_temp_c": p.nvidia_gpu_temp_c,
                    }));
                    mcp_tool(&req_id, serde_json::json!({
                        "node_id": target,
                        "range_minutes": minutes,
                        "current_snapshot": current,
                        "note": "For full historical profiler timeline, query the agent directly: GET http://<node>:7700/api/profile?minutes=N",
                    }))
                }
                "explain_slowdown" => {
                    let target = args.get("node_id").and_then(|v| v.as_str()).unwrap_or("");
                    let ts = args.get("ts_ms").and_then(|v| v.as_i64()).unwrap_or(0);
                    if target.is_empty() { return mcp_err(&req_id, -32602, "node_id required"); }
                    if ts == 0 { return mcp_err(&req_id, -32602, "ts_ms required (Unix milliseconds of the slow request)"); }
                    if !node_ids.contains(&target.to_string()) { return mcp_err(&req_id, -32602, "Node not in your fleet"); }
                    // Cloud doesn't have per-request traces — return current hardware context + guidance
                    let map = &metrics_snapshot;
                    let e = map.get(target);
                    let m = e.and_then(|e| e.metrics.as_ref());
                    let context = m.map(|p| serde_json::json!({
                        "current_thermal_state": p.thermal_state,
                        "current_thermal_penalty": p.penalty_avg,
                        "current_ttft_ms": p.vllm_avg_ttft_ms.or(p.ollama_proxy_avg_ttft_ms).or(p.ollama_ttft_ms),
                        "current_queue_depth": p.vllm_requests_waiting,
                        "current_kv_cache_pct": p.vllm_cache_usage_perc,
                        "current_power_w": p.nvidia_power_draw_w.or(p.apple_soc_power_w).or(p.cpu_power_w),
                        "current_gpu_temp_c": p.nvidia_gpu_temp_c,
                        "current_swap_write_mb_s": p.swap_write_mb_s,
                        "current_memory_pressure_pct": p.memory_pressure_percent,
                    }));
                    mcp_tool(&req_id, serde_json::json!({
                        "node_id": target,
                        "ts_ms": ts,
                        "current_hardware_context": context,
                        "note": "For full root-cause analysis with per-request trace correlation, query the agent directly: GET http://<node>:7700/api/explain-slowdown?ts_ms=N",
                    }))
                }
                "get_fleet_model_fit" => {
                    let map = &metrics_snapshot;
                    let mut node_fits: Vec<serde_json::Value> = Vec::new();
                    let mut good_count = 0usize;
                    let mut poor_count = 0usize;

                    for nid in &node_ids {
                        let e = match map.get(nid) { Some(e) => e, None => continue };
                        let online = now.saturating_sub(e.last_seen_ms) < ONLINE_THRESHOLD_MS;
                        if !online { continue; }
                        let m = match e.metrics.as_ref() { Some(m) => m, None => continue };

                        let model_name = m.ollama_active_model.as_deref()
                            .or(m.vllm_model_name.as_deref())
                            .or(m.llamacpp_model_name.as_deref());
                        if model_name.is_none() { continue; }

                        let model_gb = m.ollama_model_size_gb.map(|v| v as f64);
                        let quant    = m.ollama_quantization.as_deref().unwrap_or("").to_string();
                        let tps      = if m.vllm_running { m.vllm_tokens_per_sec } else { m.ollama_tokens_per_second };

                        // Memory pool: VRAM for NVIDIA, RAM otherwise
                        let (pool_label, pool_total_gb, pool_avail_gb) = if let (Some(vt), Some(vu)) = (m.nvidia_vram_total_mb, m.nvidia_vram_used_mb) {
                            let t = vt as f64 / 1024.0;
                            let a = (vt.saturating_sub(vu)) as f64 / 1024.0;
                            ("VRAM", t, a)
                        } else {
                            let t = m.total_memory_mb as f64 / 1024.0;
                            let a = m.available_memory_mb as f64 / 1024.0;
                            ("RAM", t, a)
                        };

                        // Memory Fit
                        let (mem_score, mem_reason) = match model_gb {
                            Some(mgb) => {
                                let pct = if pool_total_gb > 0.0 { pool_avail_gb / pool_total_gb * 100.0 } else { 0.0 };
                                if pct >= 20.0 {
                                    good_count += 1;
                                    ("good", format!("{mgb:.1} GB model, {pool_avail_gb:.1} GB {pool_label} headroom ({pct:.0}%)"))
                                } else if pct >= 8.0 {
                                    ("fair", format!("{mgb:.1} GB model, {pool_avail_gb:.1} GB {pool_label} headroom ({pct:.0}%) — tight under long context"))
                                } else {
                                    poor_count += 1;
                                    ("poor", format!("{mgb:.1} GB model, only {pool_avail_gb:.1} GB {pool_label} headroom ({pct:.0}%) — KV cache will swap"))
                                }
                            }
                            None => ("unknown", "Model size unavailable".into()),
                        };

                        // Efficiency (WES)
                        let power_w = m.nvidia_power_draw_w.or(m.apple_soc_power_w).or(m.cpu_power_w).map(|w| w as f64);
                        let penalty = m.penalty_avg.map(|p| p as f64).unwrap_or(1.0).max(0.01);
                        let (wes_val, wes_level) = match (tps, power_w) {
                            (Some(t), Some(w)) if w > 0.0 => {
                                let v = t as f64 / (w * penalty);
                                let level = if v > 10.0 { "excellent" } else if v > 3.0 { "good" } else if v > 1.0 { "acceptable" } else { "low" };
                                (Some(v), level)
                            }
                            _ => (None, "unknown"),
                        };

                        // Quant Recommendation (same logic as agent)
                        let bits: Option<u32> = if quant.starts_with('F') || quant.starts_with('f') {
                            if quant.contains("16") { Some(16) } else if quant.contains("32") { Some(32) } else { None }
                        } else {
                            quant.chars().find(|c| c.is_ascii_digit()).and_then(|c| c.to_digit(10))
                        };
                        let quant_kind = match bits {
                            Some(b) if b >= 8 => if pool_avail_gb < model_gb.unwrap_or(0.0) * 0.25 { "downgrade" } else { "lossless" },
                            Some(b) if b <= 3 => if pool_avail_gb > model_gb.unwrap_or(0.0) * (4.0 / b as f64) * 0.3 { "upgrade" } else { "sweet-spot" },
                            Some(4) | Some(5) | Some(6) => "sweet-spot",
                            _ => "none",
                        };

                        node_fits.push(serde_json::json!({
                            "node_id": nid,
                            "hostname": m.hostname,
                            "model": model_name,
                            "quant": quant,
                            "model_gb": model_gb,
                            "memory_pool": pool_label,
                            "pool_available_gb": pool_avail_gb,
                            "memory_fit": mem_score,
                            "memory_reason": mem_reason,
                            "wes": wes_val.map(|v| (v * 100.0).round() / 100.0),
                            "efficiency": wes_level,
                            "quant_recommendation": quant_kind,
                        }));
                    }

                    let total = node_fits.len();
                    let fleet_summary = if total == 0 {
                        "No nodes have models loaded.".to_string()
                    } else if poor_count == 0 && good_count == total {
                        format!("All {total} active node(s) have comfortable memory headroom.")
                    } else if poor_count > 0 {
                        format!("{poor_count} of {total} node(s) are memory-constrained — KV cache may swap under long context. {good_count} node(s) are comfortable.")
                    } else {
                        { let fair = total - good_count; format!("{good_count} of {total} node(s) have good memory fit; {fair} are fair.") }
                    };

                    mcp_tool(&req_id, serde_json::json!({
                        "nodes": node_fits,
                        "fleet_summary": fleet_summary,
                        "note": "Context Runway requires architecture fields from /api/show — available via the agent's get_model_fit tool on each node."
                    }))
                }

                _ => mcp_err(&req_id, -32602, "Unknown tool"),
            }
        }

        "resources/list" => mcp_ok(&req_id, serde_json::json!({ "resources": [
            { "uri": "wicklee://fleet/status",  "name": "Fleet Status Summary",  "mimeType": "application/json" },
            { "uri": "wicklee://fleet/thermal", "name": "Fleet Thermal States",  "mimeType": "application/json" },
        ] })),

        "resources/read" => {
            let uri = params.get("uri").and_then(|v| v.as_str()).unwrap_or("");
            let map = &metrics_snapshot;
            match uri {
                "wicklee://fleet/status" => {
                    let on = node_ids.iter().filter(|n| map.get(*n).map(|e| now.saturating_sub(e.last_seen_ms) < ONLINE_THRESHOLD_MS).unwrap_or(false)).count();
                    let wv: Vec<f32> = node_ids.iter().filter_map(|n| { let e = map.get(n)?; if now.saturating_sub(e.last_seen_ms) >= ONLINE_THRESHOLD_MS { return None; } wes_for_payload(e.metrics.as_ref()?) }).collect();
                    let avg = if wv.is_empty() { None } else { Some(wv.iter().sum::<f32>() / wv.len() as f32) };
                    mcp_ok(&req_id, serde_json::json!({ "contents": [{ "uri": uri, "mimeType": "application/json", "text": serde_json::json!({ "online": on, "total": node_ids.len(), "avg_wes": avg }).to_string() }] }))
                }
                "wicklee://fleet/thermal" => {
                    let nodes: Vec<serde_json::Value> = node_ids.iter().filter_map(|n| {
                        let m = map.get(n)?.metrics.as_ref()?;
                        Some(serde_json::json!({ "node_id": n, "thermal_state": m.thermal_state, "penalty_avg": m.penalty_avg, "penalty_peak": m.penalty_peak, "thermal_source": m.thermal_source }))
                    }).collect();
                    mcp_ok(&req_id, serde_json::json!({ "contents": [{ "uri": uri, "mimeType": "application/json", "text": serde_json::json!({ "nodes": nodes }).to_string() }] }))
                }
                _ => mcp_err(&req_id, -32602, "Unknown resource URI"),
            }
        }

        _ => mcp_err(&req_id, -32601, &format!("Method not found: {method}")),
    }
}
