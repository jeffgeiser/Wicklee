//! Alerting: channels, rules, notification delivery, evaluators, silences.

use crate::*;

// ── Alerting — structs ────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub(crate) struct AlertChannel {
    pub(crate) id:           String,
    pub(crate) channel_type: String,
    pub(crate) name:         String,
    pub(crate) config_json:  String,
    pub(crate) verified:     bool,
    pub(crate) created_at:   i64,
}

#[derive(Serialize, Clone)]
pub(crate) struct AlertRule {
    pub(crate) id:              String,
    pub(crate) node_id:         Option<String>,
    pub(crate) event_type:      String,
    pub(crate) threshold_value: Option<f64>,
    pub(crate) urgency:         String,
    pub(crate) channel_id:      String,
    pub(crate) enabled:         bool,
    pub(crate) created_at:      i64,
    pub(crate) tag:             Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct CreateChannelRequest {
    pub(crate) channel_type: String,
    pub(crate) name:         String,
    pub(crate) config_json:  String,
}

#[derive(Deserialize)]
pub(crate) struct CreateRuleRequest {
    pub(crate) node_id:         Option<String>,
    pub(crate) event_type:      String,
    pub(crate) threshold_value: Option<f64>,
    pub(crate) urgency:         Option<String>,
    pub(crate) channel_id:      String,
    /// Optional tag scope — the rule fires only for nodes bearing this tag.
    /// Composes with node_id (both must match when both are set).
    #[serde(default)]
    pub(crate) tag:             Option<String>,
}

// ── Alerting — notification delivery ─────────────────────────────────────────

pub(crate) fn send_slack(webhook_url: &str, blocks_json: &str) -> bool {
    let body = format!(r#"{{"blocks":{blocks_json}}}"#);
    let target = match resolve_outbound_blocking(webhook_url) {
        Ok(t) => t,
        Err(e) => { eprintln!("[slack] refusing webhook url: {e}"); return false; }
    };
    match pinned_ureq_agent(&target, Duration::from_secs(10)).post(target.url.as_str())
        .set("Content-Type", "application/json")
        .send_string(&body)
    {
        Ok(_)  => true,
        Err(e) => { eprintln!("[slack] delivery failed: {e}"); false }
    }
}

pub(crate) fn send_email(to: &str, subject: &str, text: &str, html: &str) -> bool {
    let api_key = match std::env::var("RESEND_API_KEY") {
        Ok(k) => k,
        Err(_) => { eprintln!("[email] RESEND_API_KEY not set"); return false; }
    };
    let from = std::env::var("FROM_EMAIL")
        .unwrap_or_else(|_| "Wicklee Alerts <alerts@wicklee.dev>".to_string());
    let payload = serde_json::json!({
        "from": from, "to": [to], "subject": subject, "text": text, "html": html,
    });
    match HTTP_AGENT.post("https://api.resend.com/emails")
        .set("Authorization", &format!("Bearer {api_key}"))
        .set("Content-Type", "application/json")
        .send_string(&payload.to_string())
    {
        Ok(_)  => true,
        Err(e) => { eprintln!("[email] Resend delivery failed: {e}"); false }
    }
}

/// Send a PagerDuty Events API v2 trigger or resolve event.
/// Uses the Events API v2 endpoint (https://events.pagerduty.com/v2/enqueue).
/// The routing_key is an integration key from the PagerDuty service configuration.
pub(crate) fn send_pagerduty(routing_key: &str, node_id: &str, event_type: &str, detail: &str, resolved: bool) -> bool {
    let (event_action, severity) = if resolved {
        ("resolve", "info")
    } else {
        ("trigger", match event_type {
            "zombied_engine" | "thermal_redline" | "oom_warning" => "critical",
            "wes_cliff" | "wes_drop" | "thermal_serious" => "error",
            _ => "warning",
        })
    };
    // dedup_key ensures PagerDuty links trigger + resolve for the same incident.
    let dedup_key = format!("wicklee-{node_id}-{event_type}");
    let payload = serde_json::json!({
        "routing_key": routing_key,
        "event_action": event_action,
        "dedup_key": dedup_key,
        "payload": {
            "summary": format!("Wicklee {event_type} on {node_id}: {detail}"),
            "source": node_id,
            "severity": severity,
            "component": "wicklee-agent",
            "group": "inference-fleet",
            "custom_details": {
                "node_id": node_id,
                "event_type": event_type,
                "detail": detail,
            }
        }
    });
    match HTTP_AGENT.post("https://events.pagerduty.com/v2/enqueue")
        .set("Content-Type", "application/json")
        .send_string(&payload.to_string())
    {
        Ok(r) if r.status() == 202 => true,
        Ok(r) => { eprintln!("[pagerduty] unexpected status: {}", r.status()); false }
        Err(e) => { eprintln!("[pagerduty] delivery failed: {e}"); false }
    }
}

pub(crate) fn slack_alert_blocks(node_id: &str, event_type: &str, detail: &str, resolved: bool) -> String {
    let (icon, color_word) = if resolved {
        ("\u{2705}", "Recovered")
    } else {
        match event_type {
            "thermal_critical"      => ("\u{1F525}", "Critical"),
            "thermal_serious"       => ("\u{26A0}\u{FE0F}",  "Warning"),
            "thermal_drain"         => ("\u{1F321}\u{FE0F}",  "Thermal Drain"),
            "memory_pressure_high"  => ("\u{1F4BE}", "Warning"),
            "memory_trajectory"     => ("\u{1F4C8}", "Memory Trajectory"),
            "wes_drop"              => ("\u{1F4C9}", "Warning"),
            "wes_velocity_drop"     => ("\u{1F4C9}", "WES Declining"),
            "phantom_load"          => ("\u{26A1}", "Phantom Load"),
            "node_offline"          => ("\u{1F534}", "Offline"),
            _                       => ("\u{26A1}", "Alert"),
        }
    };
    let title = if resolved {
        format!("{icon} {node_id} \u{2014} Recovered ({event_type})")
    } else {
        format!("{icon} {node_id} \u{2014} {color_word}")
    };
    serde_json::json!([
        { "type": "section", "text": { "type": "mrkdwn", "text": format!("*{title}*") } },
        { "type": "section", "text": { "type": "mrkdwn", "text": detail } },
        { "type": "context", "elements": [{ "type": "mrkdwn", "text": "Wicklee \u{00B7} <https://wicklee.dev|View Dashboard>" }] }
    ]).to_string()
}

pub(crate) fn email_alert_body(node_id: &str, event_type: &str, detail: &str, resolved: bool) -> (String, String) {
    // ── Plain text version ────────────────────────────────────────────────
    let status_label = if resolved { "Resolved" } else { "Detected" };
    let text = format!(
        "Wicklee Alert — {status_label}\n\
         Node: {node_id}\n\
         Pattern: {event_type}\n\n\
         {detail}\n\n\
         View in dashboard: https://wicklee.dev\n\
         Manage alerts: https://wicklee.dev (Settings → Alerts)"
    );

    // ── HTML version — matches Wicklee's Hardware-Centric Dark design ────
    let (accent, accent_bg, status_text, status_icon) = if resolved {
        ("#4ade80", "rgba(74,222,128,0.08)", "Resolved", "\u{2705}")
    } else {
        ("#f97316", "rgba(249,115,22,0.08)", "Detected", "\u{26A0}\u{FE0F}")
    };

    // Human-readable pattern name: thermal_drain → Thermal Drain
    let pattern_display: String = event_type.split('_')
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                None => String::new(),
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ");

    let html = format!(
        r##"<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">
<title>Wicklee Alert</title></head>
<body style="margin:0;padding:0;background-color:#030712;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,sans-serif;-webkit-text-size-adjust:100%">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#030712">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">

<!-- Logo + Wordmark -->
<tr><td style="padding:0 0 24px 0">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.02em">wicklee</td>
    <td style="padding-left:8px;font-size:10px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.1em;vertical-align:middle">inference observability</td>
  </tr></table>
</td></tr>

<!-- Status Badge -->
<tr><td style="padding:0 0 20px 0">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="background-color:{accent_bg};border:1px solid {accent}33;border-radius:20px;padding:4px 14px 4px 10px">
      <span style="font-size:11px;font-weight:700;color:{accent};text-transform:uppercase;letter-spacing:0.08em">{status_icon}&nbsp; {status_text}</span>
    </td>
  </tr></table>
</td></tr>

<!-- Main Card -->
<tr><td style="background-color:#0a0f1a;border:1px solid #1f2937;border-radius:16px;padding:28px 24px">

  <!-- Node + Pattern -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="font-size:10px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.1em;padding-bottom:4px">Node</td></tr>
    <tr><td style="font-size:18px;font-weight:700;color:#ffffff;padding-bottom:16px;font-family:'JetBrains Mono',monospace">{node_id}</td></tr>
    <tr><td style="font-size:10px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.1em;padding-bottom:4px">Pattern</td></tr>
    <tr><td style="font-size:14px;font-weight:600;color:{accent};padding-bottom:20px">{pattern_display}</td></tr>
  </table>

  <!-- Divider -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="border-top:1px solid #1f2937;padding-top:16px"></td></tr>
  </table>

  <!-- Detail -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="font-size:10px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.1em;padding-bottom:8px">Detail</td></tr>
    <tr><td style="background-color:#111827;border-radius:8px;padding:14px 16px">
      <p style="margin:0;font-size:13px;line-height:1.6;color:#d1d5db;font-family:'JetBrains Mono',monospace;white-space:pre-wrap">{detail}</p>
    </td></tr>
  </table>

  <!-- CTA Button -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="padding-top:24px" align="center">
      <a href="https://wicklee.dev" target="_blank" style="display:inline-block;background-color:#2563eb;color:#ffffff;font-size:13px;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:10px">
        View in Dashboard
      </a>
    </td></tr>
  </table>

</td></tr>

<!-- Footer -->
<tr><td style="padding:24px 0 0 0;text-align:center">
  <p style="margin:0 0 4px 0;font-size:11px;color:#4b5563">
    Wicklee — sovereign GPU fleet monitoring for local AI inference
  </p>
  <p style="margin:0;font-size:11px;color:#374151">
    <a href="https://wicklee.dev" style="color:#6366f1;text-decoration:none">Dashboard</a>
    &nbsp;&middot;&nbsp;
    <a href="https://wicklee.dev/docs" style="color:#6366f1;text-decoration:none">Docs</a>
    &nbsp;&middot;&nbsp;
    <a href="https://wicklee.dev" style="color:#6366f1;text-decoration:none">Manage Alerts</a>
  </p>
</td></tr>

</table>
</td></tr>
</table>
</body></html>"##,
    );
    (text, html)
}

// ── Alerting — core evaluation (async) ──────────────────────────────────────

pub(crate) async fn evaluate_alerts(
    user_id:  &str,
    node_id:  &str,
    metrics:  &MetricsPayload,
    pool:     &sqlx::PgPool,
) {
    // Load enabled rules for this user + node.
    let rules: Vec<(String, String, Option<f64>, String, String, String)> = sqlx::query_as(
        "SELECT ar.id, ar.event_type, ar.threshold_value, ar.urgency,
                nc.channel_type, nc.config_json::text
         FROM   alert_rules ar
         JOIN   notification_channels nc ON nc.id = ar.channel_id
         WHERE  ar.user_id  = $1
           AND  ar.enabled  = 1
           AND  (ar.node_id IS NULL OR ar.node_id = $2)
           AND  (ar.tag IS NULL OR EXISTS(
                  SELECT 1 FROM nodes n WHERE n.wk_id = $2
                    AND (',' || replace(lower(COALESCE(n.tags,'')), ' ', '') || ',')
                        LIKE ('%,' || replace(lower(ar.tag), ' ', '') || ',%')))
           AND  NOT EXISTS(
                  SELECT 1 FROM alert_silences s
                  WHERE s.tenant_id = (SELECT COALESCE(n2.org_id, n2.user_id) FROM nodes n2 WHERE n2.wk_id = $2)
                    AND $3 >= s.starts_at AND $3 < s.ends_at
                    AND (s.node_id IS NULL OR s.node_id = $2)
                    AND (s.event_type IS NULL OR s.event_type = ar.event_type)
                    AND (s.tag IS NULL OR EXISTS(
                          SELECT 1 FROM nodes n3 WHERE n3.wk_id = $2
                            AND (',' || replace(lower(COALESCE(n3.tags,'')), ' ', '') || ',')
                                LIKE ('%,' || replace(lower(s.tag), ' ', '') || ',%'))))"
    ).bind(user_id).bind(node_id).bind(now_ms() as i64)
    .fetch_all(pool).await.unwrap_or_default();

    if rules.is_empty() { return; }

    // Newest open event per rule for this node, loaded in ONE query rather
    // than one per rule on every telemetry push. Same row the old per-rule
    // `ORDER BY triggered_at DESC LIMIT 1` picked; a failed load reads as "no
    // open event", exactly as the per-rule query's error did.
    let rule_ids: Vec<&str> = rules.iter().map(|r| r.0.as_str()).collect();
    let mut open_events: HashMap<String, (String, Option<i64>)> =
        sqlx::query_as::<_, (String, String, Option<i64>)>(
            "SELECT DISTINCT ON (rule_id) rule_id, id, quiet_until_ms FROM alert_events
             WHERE node_id = $1 AND rule_id = ANY($2) AND resolved_at IS NULL
             ORDER BY rule_id, triggered_at DESC"
        ).bind(node_id).bind(&rule_ids).fetch_all(pool).await.unwrap_or_default()
        .into_iter().map(|(rid, id, quiet)| (rid, (id, quiet))).collect();

    let now = now_ms();

    for (rule_id, event_type, threshold_value_opt, urgency, channel_type, config_json) in &rules {
        let threshold_value = threshold_value_opt.unwrap_or(0.0);

        let firing = match event_type.as_str() {
            "thermal_serious"  => matches!(metrics.thermal_state.as_deref(), Some("Serious") | Some("Critical")),
            "thermal_critical" => matches!(metrics.thermal_state.as_deref(), Some("Critical")),
            "memory_pressure_high" => {
                let threshold = if threshold_value > 0.0 { threshold_value as f32 } else { 85.0 };
                metrics.memory_pressure_percent.map(|p| p > threshold).unwrap_or(false)
            }
            "wes_drop" => {
                let threshold = if threshold_value > 0.0 { threshold_value as f32 } else { 5.0 };
                wes_for_payload(metrics).map(|w| w < threshold).unwrap_or(false)
            }
            "thermal_drain" => {
                let threshold = if threshold_value > 0.0 { threshold_value as f32 } else { 6.0 };
                let is_throttled = matches!(metrics.thermal_state.as_deref(), Some("Fair") | Some("Serious") | Some("Critical"));
                is_throttled && wes_for_payload(metrics).map(|w| w < threshold).unwrap_or(false)
            }
            "phantom_load" => {
                let watts_threshold = if threshold_value > 0.0 { threshold_value as f32 } else { 15.0 };
                let watts = metrics.nvidia_power_draw_w.or(metrics.cpu_power_w).unwrap_or(0.0);
                let tok_s = if metrics.vllm_running { metrics.vllm_tokens_per_sec } else { metrics.ollama_tokens_per_second };
                let model_loaded = metrics.nvidia_vram_used_mb.map(|v| v >= 1024).unwrap_or(false) || metrics.ollama_active_model.is_some();
                watts > watts_threshold && model_loaded && tok_s.map(|t| t < 0.5).unwrap_or(true)
            }
            "wes_velocity_drop" => {
                let threshold = if threshold_value > 0.0 { threshold_value as f32 } else { 7.0 };
                let not_thermal = !matches!(metrics.thermal_state.as_deref(), Some("Serious") | Some("Critical"));
                not_thermal && wes_for_payload(metrics).map(|w| w < threshold).unwrap_or(false)
            }
            "memory_trajectory" => {
                let lo_threshold = if threshold_value > 0.0 { threshold_value as f32 } else { 65.0 };
                metrics.memory_pressure_percent.map(|p| p >= lo_threshold && p < 80.0).unwrap_or(false)
            }
            "ttft_regression" => {
                let threshold = if threshold_value > 0.0 { threshold_value as f32 } else { 500.0 };
                let ttft = metrics.vllm_avg_ttft_ms.or(metrics.ollama_proxy_avg_ttft_ms).or(metrics.ollama_ttft_ms);
                let is_active = matches!(metrics.inference_state.as_deref(), Some("live") | Some("idle-spd"));
                is_active && ttft.map(|t| t > threshold).unwrap_or(false)
            }
            "throughput_low" => {
                let threshold = if threshold_value > 0.0 { threshold_value as f32 } else { 5.0 };
                let tok_s = if metrics.vllm_running { metrics.vllm_tokens_per_sec } else { metrics.ollama_tokens_per_second };
                let is_live = matches!(metrics.inference_state.as_deref(), Some("live"));
                is_live && tok_s.map(|t| t < threshold).unwrap_or(false)
            }
            _ => continue,
        };

        let open_event: Option<(String, Option<i64>)> = open_events.remove(rule_id);

        let debounce_ms: u64 = match urgency.as_str() {
            "debounce_5m"  => 5 * 60_000,
            "debounce_15m" => 15 * 60_000,
            _              => 0,
        };

        if firing {
            if let Some((_, Some(quiet_until))) = &open_event
                && now < *quiet_until as u64 { continue; }
            if open_event.is_some() { continue; }

            if debounce_ms > 0 {
                let last_resolved_at: Option<i64> = sqlx::query_scalar(
                    "SELECT MAX(resolved_at) FROM alert_events
                     WHERE rule_id = $1 AND node_id = $2 AND resolved_at IS NOT NULL"
                ).bind(rule_id).bind(node_id).fetch_one(pool).await.ok().flatten();
                if let Some(last_res) = last_resolved_at
                    && now < (last_res as u64).saturating_add(debounce_ms) { continue; }
            }

            let detail = match event_type.as_str() {
                "thermal_serious" | "thermal_critical" => format!(
                    "Thermal state: *{}*\nWES: {:.1} \u{00B7} Watts: {:.1}W",
                    metrics.thermal_state.as_deref().unwrap_or("\u{2014}"),
                    wes_for_payload(metrics).unwrap_or(0.0),
                    metrics.nvidia_power_draw_w.or(metrics.cpu_power_w).unwrap_or(0.0),
                ),
                "memory_pressure_high" => format!(
                    "Memory pressure: *{:.0}%*  (threshold: {:.0}%)\n{:.1} GB used / {:.1} GB total",
                    metrics.memory_pressure_percent.unwrap_or(0.0),
                    if threshold_value > 0.0 { threshold_value } else { 85.0 },
                    metrics.used_memory_mb as f64 / 1024.0,
                    metrics.total_memory_mb as f64 / 1024.0,
                ),
                "wes_drop" => format!(
                    "WES: *{:.1}*  (threshold: {:.1})\nTok/s: {:.1}  Watts: {:.1}W  Thermal: {}",
                    wes_for_payload(metrics).unwrap_or(0.0),
                    if threshold_value > 0.0 { threshold_value } else { 5.0 },
                    metrics.ollama_tokens_per_second.or(metrics.vllm_tokens_per_sec).unwrap_or(0.0),
                    metrics.nvidia_power_draw_w.or(metrics.cpu_power_w).unwrap_or(0.0),
                    metrics.thermal_state.as_deref().unwrap_or("\u{2014}"),
                ),
                "thermal_drain" => {
                    let penalty = thermal_penalty_for(metrics.thermal_state.as_deref());
                    format!(
                        "Thermal: *{}*  (penalty \u{00D7}{:.2})\nWES: {:.1}  Tok/s: {:.1}  Watts: {:.1}W\nRoute requests away to preserve throughput.",
                        metrics.thermal_state.as_deref().unwrap_or("\u{2014}"), penalty,
                        wes_for_payload(metrics).unwrap_or(0.0),
                        metrics.ollama_tokens_per_second.or(metrics.vllm_tokens_per_sec).unwrap_or(0.0),
                        metrics.nvidia_power_draw_w.or(metrics.cpu_power_w).unwrap_or(0.0),
                    )
                }
                "phantom_load" => {
                    let watts = metrics.nvidia_power_draw_w.or(metrics.cpu_power_w).unwrap_or(0.0);
                    let vram  = metrics.nvidia_vram_used_mb.unwrap_or(0);
                    let model = metrics.ollama_active_model.as_deref().unwrap_or("unknown");
                    format!("Drawing *{:.0}W* with {:.1} GB VRAM allocated \u{2014} no inference activity.\nModel: {}  |  Tok/s: 0\nUnload the idle model to reclaim VRAM and reduce power draw.",
                        watts, vram as f64 / 1024.0, model)
                }
                "wes_velocity_drop" => format!(
                    "WES: *{:.1}*  (early-warning threshold: {:.1})\nTok/s: {:.1}  Watts: {:.1}W  Thermal: {}\nEfficiency is declining \u{2014} check for thermal buildup or competing processes.",
                    wes_for_payload(metrics).unwrap_or(0.0),
                    if threshold_value > 0.0 { threshold_value } else { 7.0 },
                    metrics.ollama_tokens_per_second.or(metrics.vllm_tokens_per_sec).unwrap_or(0.0),
                    metrics.nvidia_power_draw_w.or(metrics.cpu_power_w).unwrap_or(0.0),
                    metrics.thermal_state.as_deref().unwrap_or("Normal"),
                ),
                "memory_trajectory" => format!(
                    "Memory pressure: *{:.0}%*  (warning threshold: {:.0}%  |  critical: 85%)\n{:.1} GB used / {:.1} GB total\nPressure is rising \u{2014} unload models or stop background processes now.",
                    metrics.memory_pressure_percent.unwrap_or(0.0),
                    if threshold_value > 0.0 { threshold_value } else { 65.0 },
                    metrics.used_memory_mb as f64 / 1024.0,
                    metrics.total_memory_mb as f64 / 1024.0,
                ),
                _ => String::new(),
            };

            let fired = tokio::task::spawn_blocking({
                let ct = channel_type.clone();
                let cj = config_json.clone();
                let ni = node_id.to_owned();
                let et = event_type.clone();
                let dt = detail.clone();
                move || deliver_alert(&ct, &cj, &ni, &et, &dt, false)
            }).await.unwrap_or(false);

            if fired {
                let event_id = Uuid::new_v4().to_string();
                let _ = sqlx::query(
                    "INSERT INTO alert_events (id, rule_id, node_id, triggered_at)
                     VALUES ($1, $2, $3, $4)"
                ).bind(&event_id).bind(rule_id).bind(node_id).bind(now as i64)
                .execute(pool).await;
                println!("[alerts] fired {}/{node_id} \u{2192} {}", event_type, channel_type);
            }
        } else {
            if let Some((event_id, _)) = open_event {
                let quiet_until = (now + ALERT_QUIET_PERIOD_MS) as i64;
                let _ = sqlx::query(
                    "UPDATE alert_events SET resolved_at = $1, quiet_until_ms = $2 WHERE id = $3"
                ).bind(now as i64).bind(quiet_until).bind(&event_id)
                .execute(pool).await;

                if urgency == "immediate" || urgency == "debounce_5m" {
                    let ct = channel_type.clone();
                    let cj = config_json.clone();
                    let ni = node_id.to_owned();
                    let et = event_type.clone();
                    tokio::task::spawn_blocking(move || {
                        deliver_alert(&ct, &cj, &ni, &et, "Condition has cleared.", true);
                    });
                }
                println!("[alerts] resolved {}/{node_id}", event_type);
            }
        }
    }
}

pub(crate) fn deliver_alert(channel_type: &str, config_json: &str, node_id: &str, event_type: &str, detail: &str, resolved: bool) -> bool {
    let cfg: serde_json::Value = serde_json::from_str(config_json).unwrap_or_default();
    match channel_type {
        "slack" => {
            let url = match cfg.get("webhook_url").and_then(|v| v.as_str()) {
                Some(u) => u.to_owned(),
                None => { eprintln!("[alerts] slack channel missing webhook_url"); return false; }
            };
            let blocks = slack_alert_blocks(node_id, event_type, detail, resolved);
            send_slack(&url, &blocks)
        }
        "email" => {
            let addr = match cfg.get("address").and_then(|v| v.as_str()) {
                Some(a) => a.to_owned(),
                None => { eprintln!("[alerts] email channel missing address"); return false; }
            };
            // Human-readable pattern name for subject line
            let pattern_label: String = event_type.split('_')
                .map(|w| { let mut c = w.chars(); match c.next() { None => String::new(), Some(f) => f.to_uppercase().collect::<String>() + c.as_str() } })
                .collect::<Vec<_>>().join(" ");
            let subject = if resolved {
                format!("\u{2705} Resolved: {pattern_label} on {node_id}")
            } else {
                format!("Wicklee: {pattern_label} detected on {node_id}")
            };
            let (text, html) = email_alert_body(node_id, event_type, detail, resolved);
            send_email(&addr, &subject, &text, &html)
        }
        "pagerduty" => {
            let routing_key = match cfg.get("routing_key").and_then(|v| v.as_str()) {
                Some(k) => k.to_owned(),
                None => { eprintln!("[alerts] pagerduty channel missing routing_key"); return false; }
            };
            send_pagerduty(&routing_key, node_id, event_type, detail, resolved)
        }
        _ => { eprintln!("[alerts] unknown channel_type: {channel_type}"); false }
    }
}

// ── Node offline alert task ──────────────────────────────────────────────────

pub(crate) async fn node_offline_alert_task(state: AppState) {
    let mut known_offline: HashSet<String> = HashSet::new();

    // Pre-populate known_offline from Postgres so a redeploy doesn't fire
    // "came online" for every node. Any node whose last_seen is already stale
    // at startup is assumed to be offline — matching the steady-state that
    // existed before the restart.
    let offline_threshold_ms = 5 * 60_000_u64;
    {
        let boot_now = now_ms();
        let seed_nodes: Vec<(String, i64)> = sqlx::query_as(
            "SELECT wk_id, last_seen FROM nodes WHERE user_id IS NOT NULL"
        ).fetch_all(&state.pool).await.unwrap_or_default();
        for (nid, last_seen) in seed_nodes {
            if boot_now.saturating_sub(last_seen as u64) >= offline_threshold_ms {
                known_offline.insert(nid);
            }
        }
        if !known_offline.is_empty() {
            println!("[alerts] seeded {} node(s) as offline from DB on startup", known_offline.len());
        }
    }

    let mut interval = tokio::time::interval(Duration::from_secs(60));
    interval.tick().await;
    loop {
        interval.tick().await;
        let now = now_ms();

        // user_id keys the owner's alert rules; tenant keys events and
        // observations (org_id for org-shared fleets — writing these under
        // user_id made every cloud-generated observation invisible to
        // org-scoped reads).
        let nodes: Vec<(String, String, i64, String)> = sqlx::query_as(
            "SELECT user_id, wk_id, last_seen, COALESCE(org_id, user_id)
             FROM nodes WHERE user_id IS NOT NULL"
        ).fetch_all(&state.pool).await.unwrap_or_default();

        let mut went_offline: Vec<(String, String, String, u64)> = Vec::new();
        let mut came_online:  Vec<(String, String, String)> = Vec::new();

        for (user_id, node_id, last_seen, tenant) in &nodes {
            let elapsed = now.saturating_sub(*last_seen as u64);
            if elapsed >= offline_threshold_ms {
                if !known_offline.contains(node_id) {
                    went_offline.push((user_id.clone(), node_id.clone(), tenant.clone(), elapsed));
                    known_offline.insert(node_id.clone());
                }
            } else if known_offline.remove(node_id) {
                came_online.push((user_id.clone(), node_id.clone(), tenant.clone()));
            }
        }

        // Fire alerts for nodes that just went offline.
        for (user_id, node_id, tenant, elapsed) in &went_offline {
            println!("[alerts] node_offline: {node_id} went offline (elapsed {elapsed}ms, user_id={user_id})");
            // Org-aware: org-paired nodes are entitled by the ORG subscription.
            let tier = resolve_node_tier(node_id, &state.pool).await;
            if !is_pro_or_above(&tier) {
                println!("[alerts] node_offline: skipped — tier={tier} (requires Pro+)");
                continue;
            }

            let rules: Vec<(String, String, String)> = sqlx::query_as(
                "SELECT ar.id, nc.channel_type, nc.config_json::text
                 FROM alert_rules ar
                 JOIN notification_channels nc ON nc.id = ar.channel_id
                 WHERE ar.user_id = $1 AND ar.event_type = 'node_offline' AND ar.enabled = 1
                   AND (ar.node_id IS NULL OR ar.node_id = $2)"
            ).bind(user_id).bind(node_id).fetch_all(&state.pool).await.unwrap_or_default();
            println!("[alerts] node_offline: found {} matching rules for {node_id}", rules.len());

            for (rule_id, channel_type, config_json) in rules {
                let open: Option<String> = sqlx::query_scalar(
                    "SELECT id FROM alert_events WHERE rule_id = $1 AND node_id = $2 AND resolved_at IS NULL LIMIT 1"
                ).bind(&rule_id).bind(node_id).fetch_optional(&state.pool).await.ok().flatten();
                if open.is_some() {
                    println!("[alerts] node_offline: skipped — open alert_event already exists for rule {rule_id}");
                    continue;
                }

                let minutes = elapsed / 60_000;
                let detail  = format!("Node has not reported telemetry in *{minutes} minutes*.");
                let ct = channel_type.clone();
                let cj = config_json.clone();
                let ni = node_id.clone();
                let fired = tokio::task::spawn_blocking(move || deliver_alert(&ct, &cj, &ni, "node_offline", &detail, false))
                    .await.unwrap_or(false);
                if fired {
                    let event_id = Uuid::new_v4().to_string();
                    let _ = sqlx::query("INSERT INTO alert_events (id, rule_id, node_id, triggered_at) VALUES ($1, $2, $3, $4)")
                        .bind(&event_id).bind(&rule_id).bind(node_id).bind(now as i64)
                        .execute(&state.pool).await;
                    println!("[alerts] node_offline fired for {node_id}");
                }
            }

            // Dedup check before writing event.
            let cutoff = (now as i64) - 3_600_000;
            let already_exists: bool = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM node_events WHERE tenant_id = $1 AND node_id = $2 AND event_type = 'node_offline' AND ts > to_timestamp($3::float8 / 1000.0))"
            ).bind(tenant).bind(node_id).bind(cutoff as f64).fetch_one(&state.pool).await.unwrap_or(false);

            if !already_exists {
                let minutes = elapsed / 60_000;
                let _ = state.events_tx.try_send(EventRow {
                    ts_ms: now as i64, node_id: node_id.clone(), tenant_id: tenant.clone(),
                    level: "error".into(), event_type: Some("node_offline".into()),
                    message: format!("Node offline \u{2014} no telemetry received for {minutes}m"),
                });

                // Write fleet observation.
                let obs_id = Uuid::new_v4().to_string();
                let minutes = elapsed / 60_000;
                let _ = sqlx::query(
                    "INSERT INTO fleet_observations (id, tenant_id, node_id, alert_type, severity, state, title, detail, context_json, fired_at_ms)
                     VALUES ($1, $2, $3, 'node_offline', 'critical', 'open', 'Node Offline', $4, $5, $6)
                     ON CONFLICT DO NOTHING"
                ).bind(&obs_id).bind(tenant).bind(node_id)
                .bind(format!("Node has not reported telemetry in {minutes} minutes."))
                .bind(serde_json::json!({"elapsed_minutes": minutes}))
                .bind(now as i64)
                .execute(&state.pool).await;
            }
        }

        // Resolve alerts for nodes that came back online.
        for (_user_id, node_id, tenant) in &came_online {
            let tier = resolve_node_tier(node_id, &state.pool).await;
            if !is_pro_or_above(&tier) { continue; }

            // Deliver resolved notification to the same channels that fired
            // the offline alert. Scoped to node_offline rules — without the
            // event_type filter this selected (and below, resolved) EVERY
            // open alert for the node, e.g. an active thermal_critical, which
            // then re-fired and re-notified.
            let open_rules: Vec<(String, String, String)> = sqlx::query_as(
                "SELECT ae.rule_id, nc.channel_type, nc.config_json::text
                 FROM alert_events ae
                 JOIN alert_rules ar ON ar.id = ae.rule_id
                 JOIN notification_channels nc ON nc.id = ar.channel_id
                 WHERE ae.node_id = $1 AND ae.resolved_at IS NULL
                   AND ar.event_type = 'node_offline'"
            ).bind(node_id).fetch_all(&state.pool).await.unwrap_or_default();
            for (_rule_id, channel_type, config_json) in open_rules {
                let ct = channel_type.clone();
                let cj = config_json.clone();
                let ni = node_id.clone();
                tokio::task::spawn_blocking(move || {
                    deliver_alert(&ct, &cj, &ni, "node_offline", "Node is back online — telemetry resumed.", true);
                });
            }

            let _ = sqlx::query(
                "UPDATE alert_events SET resolved_at = $1
                 WHERE node_id = $2 AND resolved_at IS NULL
                   AND rule_id IN (SELECT id FROM alert_rules WHERE event_type = 'node_offline')"
            ).bind(now as i64).bind(node_id).execute(&state.pool).await;

            let _ = state.events_tx.try_send(EventRow {
                ts_ms: now as i64, node_id: node_id.clone(), tenant_id: tenant.clone(),
                level: "info".into(), event_type: Some("node_online".into()),
                message: "Node back online \u{2014} telemetry resumed".into(),
            });

            let _ = sqlx::query(
                "UPDATE fleet_observations SET state = 'resolved', resolved_at_ms = $1
                 WHERE tenant_id = $2 AND node_id = $3 AND alert_type = 'node_offline' AND state = 'open'"
            ).bind(now as i64).bind(tenant).bind(node_id).execute(&state.pool).await;

            println!("[alerts] node_online \u{2014} resolved alerts for {node_id}");
        }
    }
}

// ── Fleet Alert Evaluator (Essential Four + Agent Version Mismatch) ───────────

pub(crate) struct NodeRingBuffer {
    pub(crate) entries: Vec<(u64, Option<String>, Option<String>, Option<f32>, Option<f32>)>,
    pub(crate) head: usize,
    pub(crate) len: usize,
}

impl NodeRingBuffer {
    pub(crate) fn new(capacity: usize) -> Self {
        Self { entries: vec![(0, None, None, None, None); capacity], head: 0, len: 0 }
    }

    pub(crate) fn push(&mut self, ts_ms: u64, inf_state: Option<String>, thermal: Option<String>, mem_pct: Option<f32>, wes: Option<f32>) {
        self.entries[self.head] = (ts_ms, inf_state, thermal, mem_pct, wes);
        self.head = (self.head + 1) % self.entries.len();
        if self.len < self.entries.len() { self.len += 1; }
    }

    pub(crate) fn consecutive_ticks<F: Fn(&(u64, Option<String>, Option<String>, Option<f32>, Option<f32>)) -> bool>(&self, pred: F) -> usize {
        let mut count = 0;
        for i in 0..self.len {
            let idx = (self.head + self.entries.len() - 1 - i) % self.entries.len();
            if pred(&self.entries[idx]) { count += 1; } else { break; }
        }
        count
    }
}

pub(crate) enum ObsSeverity { Warning, Critical }
impl ObsSeverity {
    pub(crate) fn as_str(&self) -> &'static str {
        match self { Self::Warning => "warning", Self::Critical => "critical" }
    }
}

/// WES Long-Term Drift Evaluator (Pattern #20, Pro+).
///
/// Extends `wes_velocity_drop` (10-minute window) into a 7-day analysis that
/// detects gradual degradation: thermal paste aging, dust accumulation,
/// driver regression, background process creep. Runs every 6 hours per node.
///
/// Logic:
///   baseline_avg = AVG(wes_penalized_avg) over [now-7d .. now-24h]
///   recent_avg   = AVG(wes_penalized_avg) over [now-24h .. now]
///   drop_pct     = (baseline_avg - recent_avg) / baseline_avg * 100
///   if drop_pct >= 15% AND baseline samples >= 100 AND recent samples >= 30:
///     fire `wes_long_term_drift` observation (severity: warning)
///
/// Cooldown: 24h via the existing fleet_observations open-state check.
pub(crate) async fn wes_long_term_drift_evaluator_task(state: AppState) {
    // Wait 60s after boot so the rollup task has a chance to populate
    // metrics_5min before the first pass — avoids no-data false negatives.
    tokio::time::sleep(Duration::from_secs(60)).await;
    let mut interval = tokio::time::interval(Duration::from_secs(6 * 3600));
    interval.tick().await;
    loop {
        interval.tick().await;
        let now = now_ms();

        // All Pro+ nodes with telemetry in the last 24h, with the tenant the
        // node's data is stored under (org id for org fleets). Tier comes
        // from the org subscription when org-paired, else the owner's.
        let nodes: Vec<(String, String)> = sqlx::query_as(
            "SELECT n.wk_id, COALESCE(n.org_id, n.user_id)
             FROM nodes n
             LEFT JOIN users u         ON u.id = n.user_id
             LEFT JOIN organizations o ON o.org_id = n.org_id
             WHERE COALESCE(o.subscription_tier, u.subscription_tier)
                   IN ('pro', 'team', 'business', 'enterprise')
               AND n.user_id IS NOT NULL
               AND n.last_seen >= $1"
        ).bind(now.saturating_sub(86_400_000) as i64 )
         .fetch_all(&state.pool).await.unwrap_or_default();

        for (node_id, tenant_id) in &nodes {
            // Baseline: 6-day window ending 24h ago.
            let baseline: Option<(Option<f64>, i64)> = sqlx::query_as(
                "SELECT AVG(wes_penalized_avg)::DOUBLE PRECISION, COUNT(*)::BIGINT
                 FROM metrics_5min
                 WHERE node_id = $1
                   AND ts >= NOW() - INTERVAL '7 days'
                   AND ts <  NOW() - INTERVAL '24 hours'
                   AND wes_penalized_avg IS NOT NULL
                   AND wes_penalized_avg > 0"
            ).bind(node_id).fetch_one(&state.pool).await.ok();

            // Recent: last 24 hours — from metrics_RAW, bucketed to 5-min
            // units so the r_n threshold below keeps its meaning. The rollup
            // only populates metrics_5min for data OLDER than 24h, so the
            // previous metrics_5min read here always counted ~0 recent
            // samples and the drift observation could never fire.
            let recent: Option<(Option<f64>, i64)> = sqlx::query_as(
                "SELECT AVG(bucket_avg)::DOUBLE PRECISION, COUNT(*)::BIGINT
                 FROM (
                     SELECT floor(EXTRACT(EPOCH FROM ts) / 300) AS bucket,
                            AVG(wes_penalized) AS bucket_avg
                     FROM metrics_raw
                     WHERE node_id = $1
                       AND ts >= NOW() - INTERVAL '24 hours'
                       AND wes_penalized IS NOT NULL
                       AND wes_penalized > 0
                     GROUP BY bucket
                 ) b"
            ).bind(node_id).fetch_one(&state.pool).await.ok();

            let (Some((Some(b_avg), b_n)), Some((Some(r_avg), r_n))) = (baseline, recent) else { continue };
            // Need at least 100 baseline samples (~8h of 5-min buckets) and
            // 30 recent samples (~2.5h of 5-min buckets) before firing.
            // Avoids false positives on sparse intermittent fleets.
            if b_n < 100 || r_n < 30 { continue; }
            if b_avg <= 0.0 { continue; }
            let drop_pct = (b_avg - r_avg) / b_avg * 100.0;
            if drop_pct < 15.0 { continue; }

            // 24h cooldown: skip if an open `wes_long_term_drift` already
            // exists for this node, OR if any was fired+resolved within 24h.
            let recent_open: Option<i64> = sqlx::query_scalar(
                "SELECT fired_at_ms FROM fleet_observations
                 WHERE tenant_id = $1 AND node_id = $2 AND alert_type = 'wes_long_term_drift'
                   AND fired_at_ms >= $3
                 ORDER BY fired_at_ms DESC LIMIT 1"
            ).bind(tenant_id).bind(node_id).bind((now.saturating_sub(86_400_000)) as i64)
              .fetch_optional(&state.pool).await.ok().flatten();
            if recent_open.is_some() { continue; }

            let id = uuid::Uuid::new_v4().to_string();
            let title = "WES Long-Term Drift".to_string();
            let detail = format!(
                "Penalized WES has drifted from a 7-day baseline of {b_avg:.2} \
                 to a 24-hour average of {r_avg:.2} — a {drop_pct:.0}% degradation. \
                 Common causes (in rough order of likelihood): dust accumulation \
                 in fans / heatsinks, thermal paste degradation on long-deployed \
                 hardware, driver / firmware regression after an OS update, or \
                 a new background process crowding the GPU. Inspect thermal \
                 history first — sustained Fair-or-worse since the drift began \
                 points to cooling. If thermal looks normal, suspect a software change."
            );
            let context = serde_json::json!({
                "baseline_avg":  b_avg,
                "baseline_n":    b_n,
                "recent_avg":    r_avg,
                "recent_n":      r_n,
                "drop_pct":      drop_pct,
                "window_days":   7,
                "recommendation":   "Inspect thermal history for the past 48-72h. If thermal_state shows persistent Fair/Serious since the drift began, check fans + thermal paste. If thermal is unchanged, audit recent driver / OS / background process changes.",
                "action_id":        "investigate_wes_drift",
            });

            let _ = sqlx::query(
                "INSERT INTO fleet_observations
                 (id, tenant_id, node_id, alert_type, severity, state, title, detail, context_json, fired_at_ms, source)
                 VALUES ($1, $2, $3, 'wes_long_term_drift', 'warning', 'open', $4, $5, $6::jsonb, $7, 'cloud')
                 ON CONFLICT (id) DO NOTHING"
            )
            .bind(&id).bind(tenant_id).bind(node_id)
            .bind(&title).bind(&detail).bind(context.to_string())
            .bind(now as i64)
            .execute(&state.pool).await;

            println!("[wes-drift] fired wes_long_term_drift for {node_id}: baseline={b_avg:.2} recent={r_avg:.2} drop={drop_pct:.0}%");
        }
    }
}

pub(crate) async fn fleet_alert_evaluator_task(state: AppState) {
    let mut ring_buffers: HashMap<String, NodeRingBuffer> = HashMap::new();
    let mut open_observations: HashMap<(String, String), String> = HashMap::new();
    let mut wes_baselines: HashMap<String, f32> = HashMap::new();
    let mut baseline_refresh_counter: u32 = 0;

    // Hysteresis tick counters — fire only after condition persists for N ticks,
    // resolve only after condition clears for M ticks. Prevents single-tick noise.
    //
    // fleet_load_imbalance: WES-poor condition (no thermal component — that already
    //   uses consecutive_ticks from the ring buffer). Require 3 ticks firing, 2 clear.
    //
    // agent_version_mismatch: Require 5 consecutive mismatch ticks before firing (handles
    //   rolling updates where each node is briefly the minority version), 2 ticks to resolve.
    let mut wes_poor_ticks:      HashMap<String, u32> = HashMap::new(); // node_id → consecutive ticks WES-poor
    let mut ver_mismatch_ticks:  HashMap<String, u32> = HashMap::new(); // node_id → consecutive ticks mismatched
    let mut wes_poor_clear_ticks: HashMap<String, u32> = HashMap::new(); // node_id → consecutive clear ticks
    let mut ver_match_ticks:     HashMap<String, u32> = HashMap::new();  // node_id → consecutive match ticks

    let mut interval = tokio::time::interval(Duration::from_secs(60));
    interval.tick().await;
    tokio::time::sleep(Duration::from_secs(120)).await;

    loop {
        interval.tick().await;
        let now = now_ms();

        // Refresh 24h WES baselines every 10 min.
        baseline_refresh_counter += 1;
        if baseline_refresh_counter >= 10 || wes_baselines.is_empty() {
            baseline_refresh_counter = 0;
            let baselines: Vec<(String, f64)> = sqlx::query_as(
                "SELECT node_id, AVG(wes_penalized)::float8 FROM metrics_raw
                 WHERE ts > NOW() - INTERVAL '24 hours' AND wes_penalized IS NOT NULL
                 GROUP BY node_id"
            ).fetch_all(&state.pool).await.unwrap_or_default();
            wes_baselines.clear();
            for (nid, avg) in baselines {
                wes_baselines.insert(nid, avg as f32);
            }
        }

        // Snapshot current metrics.
        let snapshot: Vec<(String, MetricsPayload)> = {
            let cache = state.metrics.read().unwrap();
            cache.iter()
                .filter_map(|(nid, entry)| {
                    if now.saturating_sub(entry.last_seen_ms) > 300_000 { return None; }
                    entry.metrics.as_ref().map(|m| (nid.clone(), m.clone()))
                })
                .collect()
        };

        struct PendingObs {
            node_id: String, alert_type: String, severity: ObsSeverity,
            title: String, detail: String, context: serde_json::Value,
        }
        let mut to_fire: Vec<PendingObs> = Vec::new();
        let mut to_resolve: Vec<(String, String)> = Vec::new();
        // (node_id, alert_type, new_detail, new_context_json) — refreshes stale open observations.
        let mut to_update: Vec<(String, String, String, String)> = Vec::new();

        for (node_id, m) in &snapshot {
            let ring = ring_buffers.entry(node_id.clone()).or_insert_with(|| NodeRingBuffer::new(15));
            let mem_pct = m.memory_pressure_percent;
            let wes = {
                let watts = m.nvidia_power_draw_w.or(m.apple_soc_power_w).or(m.cpu_power_w);
                let tok_s = if m.vllm_running { m.vllm_tokens_per_sec } else { m.ollama_tokens_per_second };
                match (tok_s, watts) {
                    (Some(t), Some(w)) if w > 0.0 => Some(t / (w * thermal_penalty_for(m.thermal_state.as_deref()))),
                    _ => None,
                }
            };
            ring.push(now, m.inference_state.clone(), m.thermal_state.clone(), mem_pct, wes);

            // 1. Zombied Engine
            {
                let alert_type = "zombied_engine";
                let busy_ticks = ring.consecutive_ticks(|e| e.1.as_deref() == Some("busy"));
                let is_firing = busy_ticks >= 10;
                let is_open = open_observations.contains_key(&(node_id.clone(), alert_type.into()));
                if is_firing && !is_open {
                    to_fire.push(PendingObs { node_id: node_id.clone(), alert_type: alert_type.into(),
                        severity: ObsSeverity::Critical, title: "Zombied Engine Detected".into(),
                        detail: format!("Inference state has been 'busy' for >{} minutes without completing.", busy_ticks),
                        context: serde_json::json!({"inference_state": "busy", "sustained_minutes": busy_ticks, "active_model": m.ollama_active_model.as_deref().or(m.vllm_model_name.as_deref())}),
                    });
                } else if !is_firing && is_open { to_resolve.push((node_id.clone(), alert_type.into())); }
            }
            // 2. Thermal Redline
            {
                let alert_type = "thermal_redline";
                let critical_ticks = ring.consecutive_ticks(|e| e.2.as_deref() == Some("Critical"));
                let is_firing = critical_ticks >= 2;
                let is_open = open_observations.contains_key(&(node_id.clone(), alert_type.into()));
                if is_firing && !is_open {
                    to_fire.push(PendingObs { node_id: node_id.clone(), alert_type: alert_type.into(),
                        severity: ObsSeverity::Critical, title: "Thermal Redline \u{2014} Critical Temperature".into(),
                        detail: format!("Thermal state has been Critical for >{} minutes.", critical_ticks),
                        context: serde_json::json!({"thermal_state": "Critical", "sustained_minutes": critical_ticks, "gpu_temp_c": m.nvidia_gpu_temp_c}),
                    });
                } else if !is_firing && is_open { to_resolve.push((node_id.clone(), alert_type.into())); }
            }
            // 3. OOM Warning
            {
                let alert_type = "oom_warning";
                let oom_ticks = ring.consecutive_ticks(|e| e.3.is_some_and(|p| p > 95.0));
                let is_firing = oom_ticks >= 2; // require sustained pressure, not single-tick spike
                let is_open = open_observations.contains_key(&(node_id.clone(), alert_type.into()));
                if is_firing && !is_open {
                    let pct = mem_pct.unwrap_or(0.0);
                    to_fire.push(PendingObs { node_id: node_id.clone(), alert_type: alert_type.into(),
                        severity: ObsSeverity::Warning, title: "Memory Pressure Critical \u{2014} OOM Risk".into(),
                        detail: format!("Memory pressure at {:.1}%.", pct),
                        context: serde_json::json!({"memory_pressure_pct": pct, "used_memory_mb": m.used_memory_mb, "total_memory_mb": m.total_memory_mb}),
                    });
                } else if !is_firing && is_open { to_resolve.push((node_id.clone(), alert_type.into())); }
            }
            // 4. WES Cliff — only fires during active inference, with a minimum floor
            // to avoid noise from idle-state WES fluctuations.
            {
                let alert_type = "wes_cliff";
                if let (Some(current_wes), Some(&baseline)) = (wes, wes_baselines.get(node_id)) {
                    let is_active = matches!(m.inference_state.as_deref(), Some("live") | Some("idle-spd"));
                    let wes_floor = 3.0_f32; // Don't fire if WES is still in "Good" range
                    let is_firing = is_active && baseline > 0.0 && current_wes < baseline * 0.35 && current_wes < wes_floor;
                    let is_open = open_observations.contains_key(&(node_id.clone(), alert_type.into()));
                    if is_firing && !is_open {
                        to_fire.push(PendingObs { node_id: node_id.clone(), alert_type: alert_type.into(),
                            severity: ObsSeverity::Warning, title: "WES Cliff \u{2014} Efficiency Collapse".into(),
                            detail: format!("WES dropped to {:.1} (24h baseline: {:.1}). Active inference detected — this is not an idle fluctuation.", current_wes, baseline),
                            context: serde_json::json!({"current_wes": current_wes, "baseline_wes_24h": baseline, "thermal_state": m.thermal_state, "inference_state": m.inference_state}),
                        });
                    } else if !is_firing && is_open { to_resolve.push((node_id.clone(), alert_type.into())); }
                }
            }
        }

        // 5. Agent Version Mismatch
        // Hysteresis: require 5 consecutive mismatch ticks (≈5 min) before firing.
        // This prevents noise from rolling updates where each node is briefly the
        // minority version before the rest of the fleet catches up.
        // Resolution: require 2 consecutive clean ticks so a re-update doesn't flip
        // the observation immediately.
        {
            let mut version_counts: HashMap<String, u32> = HashMap::new();
            for (_, m) in &snapshot {
                if let Some(ref v) = m.agent_version { *version_counts.entry(v.clone()).or_insert(0) += 1; }
            }
            let majority_version = version_counts.iter().max_by_key(|(_, c)| *c).map(|(v, _)| v.clone());
            if let Some(ref majority) = majority_version {
                let total_versioned = version_counts.values().sum::<u32>();
                if total_versioned > 1 {
                    for (node_id, m) in &snapshot {
                        let alert_type = "agent_version_mismatch";
                        if let Some(ref node_ver) = m.agent_version {
                            let is_mismatched = node_ver != majority;
                            let is_open = open_observations.contains_key(&(node_id.clone(), alert_type.into()));

                            if is_mismatched {
                                // Increment mismatch tick counter, reset clear counter.
                                let mm = ver_mismatch_ticks.entry(node_id.clone()).or_insert(0);
                                *mm += 1;
                                ver_match_ticks.remove(node_id.as_str());

                                // Fire only after sustained mismatch (5 ticks ≈ 5 min).
                                if *mm >= 5 && !is_open {
                                    to_fire.push(PendingObs { node_id: node_id.clone(), alert_type: alert_type.into(),
                                        severity: ObsSeverity::Warning, title: "Agent Version Mismatch".into(),
                                        detail: format!("Running v{} while fleet majority is v{} ({} nodes). Mismatch persisted for {} min.", node_ver, majority, total_versioned, *mm),
                                        context: serde_json::json!({"node_version": node_ver, "fleet_majority": majority, "mismatch_ticks": *mm}),
                                    });
                                }
                            } else {
                                // Reset mismatch counter, increment clear counter.
                                ver_mismatch_ticks.remove(node_id.as_str());
                                let mc = ver_match_ticks.entry(node_id.clone()).or_insert(0);
                                *mc += 1;

                                // Resolve only after 2 clean ticks.
                                if is_open && *mc >= 2 {
                                    to_resolve.push((node_id.clone(), alert_type.into()));
                                }
                            }
                        }
                    }
                } else {
                    // Fleet dropped to 1 versioned node — clear any open mismatch observations.
                    for (node_id, _) in &snapshot {
                        let alert_type = "agent_version_mismatch";
                        if open_observations.contains_key(&(node_id.clone(), alert_type.into())) {
                            to_resolve.push((node_id.clone(), alert_type.into()));
                        }
                        ver_mismatch_ticks.remove(node_id.as_str());
                        ver_match_ticks.remove(node_id.as_str());
                    }
                }
            }
        }

        // 6. Fleet Load Imbalance (Pattern E)
        // A node is thermally stressed or significantly WES-poor while at least one
        // healthier peer with Normal thermal is available — a routing opportunity exists.
        // Requires ≥2 active nodes. Only fires when the stressed node has active inference.
        //
        // Hysteresis (WES-poor leg only):
        //   Fire:    condition persists for ≥3 consecutive ticks (≈3 min)
        //   Resolve: condition clear  for ≥2 consecutive ticks (≈2 min)
        // Thermal-stress leg already requires hot_ticks ≥ 2 from the ring buffer.
        if snapshot.len() >= 2 {
            // Build a fleet-wide WES map for the current tick (live MetricsPayload values).
            let live_wes: HashMap<&str, f32> = snapshot.iter()
                .filter_map(|(nid, m)| {
                    let watts = m.nvidia_power_draw_w.or(m.apple_soc_power_w).or(m.cpu_power_w);
                    let tok_s = if m.vllm_running { m.vllm_tokens_per_sec } else { m.ollama_tokens_per_second };
                    match (tok_s, watts) {
                        (Some(t), Some(w)) if w > 0.0 => Some((nid.as_str(), t / w)),
                        _ => None,
                    }
                })
                .collect();

            for (node_id, m) in &snapshot {
                let alert_type = "fleet_load_imbalance";

                // Inference must be active to be relevant
                let is_active = matches!(m.inference_state.as_deref(), Some("live") | Some("idle-spd"));
                if !is_active {
                    // Clear tick counters and resolve open observation.
                    wes_poor_ticks.remove(node_id.as_str());
                    wes_poor_clear_ticks.remove(node_id.as_str());
                    if open_observations.contains_key(&(node_id.clone(), alert_type.into())) {
                        to_resolve.push((node_id.clone(), alert_type.into()));
                    }
                    continue;
                }

                // Thermal stress: 2+ consecutive 60s ticks with non-Normal thermal state
                let hot_ticks = ring_buffers.get(node_id.as_str())
                    .map(|r| r.consecutive_ticks(|e| e.2.as_deref().map(|t| t != "Normal").unwrap_or(false)))
                    .unwrap_or(0);
                let is_thermally_stressed = hot_ticks >= 2;

                // Best healthy peer: highest WES among Normal-thermal peers
                let this_wes = live_wes.get(node_id.as_str()).copied();
                let best_peer = snapshot.iter()
                    .filter(|(pid, pm)| {
                        pid.as_str() != node_id.as_str()
                            && pm.thermal_state.as_deref() == Some("Normal")
                            && live_wes.contains_key(pid.as_str())
                    })
                    .max_by(|(a, _), (b, _)| {
                        let wa = live_wes.get(a.as_str()).copied().unwrap_or(0.0);
                        let wb = live_wes.get(b.as_str()).copied().unwrap_or(0.0);
                        wa.partial_cmp(&wb).unwrap_or(std::cmp::Ordering::Equal)
                    });

                let wes_gap_pct = match (this_wes, best_peer.as_ref().and_then(|(pid, _)| live_wes.get(pid.as_str()).copied())) {
                    (Some(this), Some(best)) if best > 0.0 => (best - this) / best * 100.0,
                    _ => 0.0,
                };
                let is_wes_poor_raw = wes_gap_pct >= 20.0;

                // Update WES-poor hysteresis counters.
                let wes_poor_sustained = if is_wes_poor_raw {
                    let ct = wes_poor_ticks.entry(node_id.clone()).or_insert(0);
                    *ct += 1;
                    wes_poor_clear_ticks.remove(node_id.as_str());
                    *ct >= 3  // require 3 consecutive ticks before treating as sustained
                } else {
                    wes_poor_ticks.remove(node_id.as_str());
                    false
                };

                let is_wes_poor = wes_poor_sustained;
                let is_firing = best_peer.is_some() && (is_thermally_stressed || is_wes_poor);
                let is_open = open_observations.contains_key(&(node_id.clone(), alert_type.into()));

                // For resolution: require 2 consecutive clean ticks if open (debounce).
                if !is_firing && is_open {
                    let cc = wes_poor_clear_ticks.entry(node_id.clone()).or_insert(0);
                    *cc += 1;
                    if *cc < 2 {
                        // Not yet stable — skip this tick, don't resolve yet.
                        continue;
                    }
                    wes_poor_clear_ticks.remove(node_id.as_str());
                }

                // Build detail + context once, reused for both fire and update paths.
                let sustained_ticks = wes_poor_ticks.get(node_id.as_str()).copied().unwrap_or(0);
                let build_detail_ctx = |best_id: &str, best_wes: f32| -> (String, serde_json::Value) {
                    let this_host = m.hostname.as_deref().unwrap_or(node_id.as_str());
                    let best_host = snapshot.iter()
                        .find(|(id, _)| id.as_str() == best_id)
                        .and_then(|(_, bm)| bm.hostname.as_deref().map(|s: &str| s.to_owned()))
                        .unwrap_or_else(|| best_id.to_owned());

                    // Root-cause clause: explain WHY WES is lower, not just that it is.
                    let why = if is_thermally_stressed {
                        format!("thermal state is non-Normal for {} min", hot_ticks)
                    } else if is_wes_poor {
                        format!("{:.0}% below fleet-peak WES for {} min", wes_gap_pct, sustained_ticks)
                    } else {
                        "capacity constrained".to_owned()
                    };

                    let detail = format!(
                        "{} is routing inference while {} has better capacity (WES {:.1} vs {:.1}). Cause: {}.",
                        this_host,
                        best_host,
                        this_wes.unwrap_or(0.0),
                        best_wes,
                        why,
                    );
                    let ctx = serde_json::json!({
                        "thermal_state":         m.thermal_state,
                        "hot_ticks":             hot_ticks,
                        "current_wes":           this_wes,
                        "best_peer_wes":         best_wes,
                        "wes_gap_pct":           wes_gap_pct,
                        "wes_poor_ticks":        sustained_ticks,
                        "inference_state":       m.inference_state,
                        "cause":                 if is_thermally_stressed { "thermal" } else { "wes_gap" },
                    });
                    (detail, ctx)
                };

                if is_firing && !is_open {
                    let (best_id, _) = best_peer.unwrap();
                    let best_wes = live_wes.get(best_id.as_str()).copied().unwrap_or(0.0);
                    let (detail, context) = build_detail_ctx(best_id, best_wes);
                    to_fire.push(PendingObs {
                        node_id: node_id.clone(),
                        alert_type: alert_type.into(),
                        severity: ObsSeverity::Warning,
                        title: "Fleet Load Imbalance".into(),
                        detail,
                        context,
                    });
                } else if is_firing && is_open {
                    // Refresh stale detail/context (best peer may have changed since first fire).
                    let (best_id, _) = best_peer.unwrap();
                    let best_wes = live_wes.get(best_id.as_str()).copied().unwrap_or(0.0);
                    let (detail, context) = build_detail_ctx(best_id, best_wes);
                    let ctx_str = serde_json::to_string(&context).unwrap_or_default();
                    to_update.push((node_id.clone(), alert_type.into(), detail, ctx_str));
                } else if !is_firing && is_open {
                    to_resolve.push((node_id.clone(), alert_type.into()));
                }
            }
        }

        // Write observations.
        if !to_fire.is_empty() || !to_resolve.is_empty() || !to_update.is_empty() {
            let affected_nodes: HashSet<String> = to_fire.iter().map(|o| o.node_id.clone())
                .chain(to_resolve.iter().map(|(nid, _)| nid.clone()))
                .chain(to_update.iter().map(|(nid, _, _, _)| nid.clone()))
                .collect();

            // node_id → (tenant_id, owner user_id). Observations/events are
            // stored per-TENANT (org id for org fleets — writing them under
            // user_id hid them from org-scoped reads); alert rules + tier
            // delivery are keyed by the owning USER.
            let mut tenant_map: HashMap<String, (String, String)> = HashMap::new();
            for nid in &affected_nodes {
                if let Ok(row) = sqlx::query_as::<_, (String, String)>(
                    "SELECT COALESCE(org_id, user_id), user_id FROM nodes WHERE wk_id = $1 AND user_id IS NOT NULL"
                ).bind(nid).fetch_one(&state.pool).await {
                    tenant_map.insert(nid.clone(), row);
                }
            }

            // Cooldown: skip firing if the same (node, alert_type) was recently
            // resolved or acknowledged. WES cliff gets a longer cooldown (4h) to
            // prevent hourly fire/resolve churn from natural WES fluctuations.
            let default_cooldown_ms: i64 = 3_600_000; // 1 hour
            let wes_cliff_cooldown_ms: i64 = 14_400_000; // 4 hours

            for obs in &to_fire {
                let (tenant_id, owner_id) = match tenant_map.get(&obs.node_id) { Some(t) => t.clone(), None => continue };

                // Check cooldown: was this (node, alert_type) recently resolved/acknowledged?
                let cooldown = if obs.alert_type == "wes_cliff" { wes_cliff_cooldown_ms } else { default_cooldown_ms };
                let cooldown_cutoff = (now as i64) - cooldown;
                let recently_settled: bool = sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM fleet_observations
                     WHERE tenant_id = $1 AND node_id = $2 AND alert_type = $3
                       AND state IN ('resolved', 'acknowledged')
                       AND COALESCE(resolved_at_ms, ack_at_ms) > $4"
                ).bind(&tenant_id).bind(&obs.node_id).bind(&obs.alert_type).bind(cooldown_cutoff)
                .fetch_one(&state.pool).await.unwrap_or(0) > 0;

                if recently_settled {
                    let hours = cooldown / 3_600_000;
                    eprintln!("[evaluator] cooldown: skipping {} for {} (settled <{}h ago)", obs.alert_type, obs.node_id, hours);
                    continue;
                }

                let obs_id = Uuid::new_v4().to_string();
                let context_str = serde_json::to_string(&obs.context).unwrap_or_default();

                let _ = sqlx::query(
                    "INSERT INTO fleet_observations (id, tenant_id, node_id, alert_type, severity, state, title, detail, context_json, fired_at_ms)
                     VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8::jsonb, $9)
                     ON CONFLICT DO NOTHING"
                ).bind(&obs_id).bind(&tenant_id).bind(&obs.node_id).bind(&obs.alert_type)
                .bind(obs.severity.as_str()).bind(&obs.title).bind(&obs.detail)
                .bind(&context_str).bind(now as i64)
                .execute(&state.pool).await;

                let _ = state.events_tx.try_send(EventRow {
                    ts_ms: now as i64, node_id: obs.node_id.clone(), tenant_id: tenant_id.clone(),
                    level: if matches!(obs.severity, ObsSeverity::Critical) { "error" } else { "warning" }.into(),
                    event_type: Some(obs.alert_type.clone()), message: obs.title.clone(),
                });

                // Deliver to notification channels.
                let pool2 = state.pool.clone();
                let node_id3 = obs.node_id.clone();
                let alert_type3 = obs.alert_type.clone();
                let detail3 = obs.detail.clone();
                let owner_id2 = owner_id.clone();
                tokio::spawn(async move {
                    // Org-aware tier; rules are matched by the OWNER (rules
                    // are created per-user — tenant_id is an org id for org
                    // fleets and matches no rules).
                    let tier = resolve_node_tier(&node_id3, &pool2).await;
                    if !is_team_or_above(&tier) { return; }

                    let rules: Vec<(String, String)> = sqlx::query_as(
                        "SELECT nc.channel_type, nc.config_json::text
                         FROM alert_rules ar JOIN notification_channels nc ON nc.id = ar.channel_id
                         WHERE ar.user_id = $1 AND ar.event_type = $2 AND ar.enabled = 1
                           AND (ar.node_id IS NULL OR ar.node_id = $3)"
                    ).bind(&owner_id2).bind(&alert_type3).bind(&node_id3)
                    .fetch_all(&pool2).await.unwrap_or_default();

                    for (ch_type, config_json) in rules {
                        let ni = node_id3.clone();
                        let at = alert_type3.clone();
                        let dt = detail3.clone();
                        tokio::task::spawn_blocking(move || { deliver_alert(&ch_type, &config_json, &ni, &at, &dt, false); });
                    }
                });

                open_observations.insert((obs.node_id.clone(), obs.alert_type.clone()), obs_id);
                println!("[evaluator] fired {} for {}", obs.alert_type, obs.node_id);
            }

            for (node_id, alert_type) in &to_resolve {
                if let Some(obs_id) = open_observations.remove(&(node_id.clone(), alert_type.clone())) {
                    let _ = sqlx::query(
                        "UPDATE fleet_observations SET state = 'resolved', resolved_at_ms = $1 WHERE id = $2 AND state = 'open'"
                    ).bind(now as i64).bind(&obs_id).execute(&state.pool).await;

                    if let Some((tenant_id, _owner)) = tenant_map.get(node_id) {
                        let _ = state.events_tx.try_send(EventRow {
                            ts_ms: now as i64, node_id: node_id.clone(), tenant_id: tenant_id.clone(),
                            level: "info".into(), event_type: Some(format!("{alert_type}_resolved")),
                            message: format!("{} condition cleared", alert_type.replace('_', " ")),
                        });
                    }
                    println!("[evaluator] resolved {} for {}", alert_type, node_id);
                }
            }

            // Refresh open observations whose detail/context may have gone stale
            // (e.g. fleet_load_imbalance best-peer changed since the alert first fired).
            for (node_id, alert_type, detail, ctx_str) in &to_update {
                if let Some(obs_id) = open_observations.get(&(node_id.clone(), alert_type.clone())) {
                    let _ = sqlx::query(
                        "UPDATE fleet_observations SET detail = $1, context_json = $2::jsonb WHERE id = $3 AND state = 'open'"
                    ).bind(detail).bind(ctx_str).bind(obs_id).execute(&state.pool).await;
                }
            }
        }

        // ── Staleness reaper: auto-resolve observations for offline nodes ────
        // If a node hasn't been seen in 5+ minutes, resolve ALL its open
        // observations (both agent-pushed and cloud-generated).
        //
        // IMPORTANT: also clear these nodes from the in-memory open_observations map.
        // Without this, if a node goes offline (DB observations resolved by the reaper)
        // and then comes back online, the evaluator still sees is_open = true from the
        // stale in-memory entry — so conditions never re-fire on reconnect.
        {
            let stale_cutoff = (now as i64) - 300_000; // 5 minutes

            // Query stale node IDs first so we can evict them from in-memory tracking.
            let stale_node_ids: Vec<String> = sqlx::query_scalar(
                "SELECT wk_id FROM nodes WHERE last_seen < $1"
            ).bind(stale_cutoff).fetch_all(&state.pool).await.unwrap_or_default();

            if !stale_node_ids.is_empty() {
                let _ = sqlx::query(
                    "UPDATE fleet_observations SET state = 'resolved', resolved_at_ms = $1 \
                     WHERE state = 'open' \
                     AND node_id IN ( \
                       SELECT wk_id FROM nodes WHERE last_seen < $2 \
                     )"
                )
                .bind(now as i64).bind(stale_cutoff)
                .execute(&state.pool).await;

                // Remove stale entries from in-memory map so alerts re-fire if the node returns.
                open_observations.retain(|(nid, _), _| !stale_node_ids.contains(nid));
            }
        }
    }
}

// ── Alerting — CRUD handlers ──────────────────────────────────────────────────

/// POST /api/alerts/channels
pub(crate) async fn handle_create_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateChannelRequest>,
) -> impl IntoResponse {
    if !matches!(body.channel_type.as_str(), "slack" | "email" | "pagerduty") {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "channel_type must be 'slack', 'email', or 'pagerduty'" }))).into_response();
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

    // Org-aware: org members are entitled by the org subscription.
    let tier = resolve_tier(&user_id, &org_id, &state.pool).await;
    if !is_pro_or_above(&tier) {
        return upgrade_required("Alerting", UpgradePlan::Team);
    }
    if body.channel_type == "pagerduty" && !is_team_or_above(&tier) {
        return upgrade_required("PagerDuty alerts", UpgradePlan::Team);
    }
    if body.channel_type == "slack" {
        let cfg: serde_json::Value = serde_json::from_str(&body.config_json).unwrap_or_default();
        let url = cfg.get("webhook_url").and_then(|v| v.as_str()).unwrap_or("");
        if let Err(e) = resolve_outbound(url).await {
            return (StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": format!("webhook_url: {e}") }))).into_response();
        }
    }

    let id = Uuid::new_v4().to_string();
    let ts = now_ms() as i64;
    let result = sqlx::query(
        "INSERT INTO notification_channels (id, user_id, channel_type, name, config_json, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)"
    ).bind(&id).bind(&user_id).bind(&body.channel_type).bind(&body.name).bind(&body.config_json).bind(ts)
    .execute(&state.pool).await;

    match result {
        Ok(_) => {
            audit(&state.pool, &user_id, &org_id, "alert_channel.created", &id,
                serde_json::json!({ "channel_type": &body.channel_type, "name": &body.name }));
            (StatusCode::CREATED, Json(AlertChannel {
                id, channel_type: body.channel_type, name: body.name,
                config_json: body.config_json, verified: false, created_at: ts,
            })).into_response()
        }
        Err(e) => { eprintln!("[alerts] channel insert failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" }))).into_response() },
    }
}

/// GET /api/alerts/channels
pub(crate) async fn handle_list_channels(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let rows: Vec<(String, String, String, String, i32, i64)> = sqlx::query_as(
        "SELECT id, channel_type, name, config_json::text, verified, created_at
         FROM notification_channels WHERE user_id = $1 ORDER BY created_at DESC"
    ).bind(&user_id).fetch_all(&state.pool).await.unwrap_or_default();

    let channels: Vec<AlertChannel> = rows.into_iter().map(|(id, ct, name, cj, v, ca)| {
        AlertChannel { id, channel_type: ct, name, config_json: cj, verified: v != 0, created_at: ca }
    }).collect();

    Json(serde_json::json!({ "channels": channels })).into_response()
}

/// DELETE /api/alerts/channels/:id
pub(crate) async fn handle_delete_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(channel_id): Path<String>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let (user_id, _org_id, role) = match require_user_org_role(&token, &state.pool, &clerk_keys).await {
        Some(v) => v,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };
    if !role.can_mutate() { return role_forbidden("member"); }

    let result = sqlx::query("DELETE FROM notification_channels WHERE id = $1 AND user_id = $2")
        .bind(&channel_id).bind(&user_id).execute(&state.pool).await;

    match result {
        Ok(r) if r.rows_affected() > 0 => Json(serde_json::json!({ "ok": true })).into_response(),
        Ok(_) => (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "Channel not found" }))).into_response(),
        Err(e) => { eprintln!("[alerts] channel delete failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Internal server error" }))).into_response() },
    }
}

/// POST /api/alerts/rules
pub(crate) async fn handle_create_rule(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateRuleRequest>,
) -> impl IntoResponse {
    const VALID_TYPES: &[&str] = &[
        "thermal_serious", "thermal_critical", "memory_pressure_high", "wes_drop", "node_offline",
        "ttft_regression", "throughput_low",
    ];
    if !VALID_TYPES.contains(&body.event_type.as_str()) {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "invalid event_type" }))).into_response();
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

    // Org-aware: org members are entitled by the org subscription.
    let tier = resolve_tier(&user_id, &org_id, &state.pool).await;
    if !is_pro_or_above(&tier) {
        return upgrade_required("Alerting", UpgradePlan::Team);
    }

    // Verify channel belongs to user.
    let channel_owner: Option<String> = sqlx::query_scalar(
        "SELECT user_id FROM notification_channels WHERE id = $1"
    ).bind(&body.channel_id).fetch_optional(&state.pool).await.ok().flatten();
    if channel_owner.as_deref() != Some(&user_id) {
        return (StatusCode::PAYMENT_REQUIRED,
            Json(serde_json::json!({ "error": "Alerting requires Team tier or channel not found" }))).into_response();
    }

    if let Some(ref t) = body.tag
        && !valid_scope_tag(t) {
            return (StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "tag must be 1-64 chars: letters, digits, : - _ ." }))).into_response();
        }

    let id      = Uuid::new_v4().to_string();
    let urgency = body.urgency.as_deref().unwrap_or("immediate").to_string();
    let ts      = now_ms() as i64;

    let result = sqlx::query(
        "INSERT INTO alert_rules (id, user_id, node_id, event_type, threshold_value, urgency, channel_id, created_at, tag)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)"
    ).bind(&id).bind(&user_id).bind(&body.node_id).bind(&body.event_type)
    .bind(body.threshold_value).bind(&urgency).bind(&body.channel_id).bind(ts).bind(&body.tag)
    .execute(&state.pool).await;

    match result {
        Ok(_) => {
            audit(&state.pool, &user_id, &org_id, "alert_rule.created", &id,
                serde_json::json!({ "event_type": &body.event_type, "node_id": &body.node_id, "urgency": &urgency, "tag": &body.tag }));
            (StatusCode::CREATED, Json(AlertRule {
                id, node_id: body.node_id, event_type: body.event_type,
                threshold_value: body.threshold_value, urgency, channel_id: body.channel_id,
                enabled: true, created_at: ts, tag: body.tag,
            })).into_response()
        }
        Err(e) => { eprintln!("[alerts] rule insert failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" }))).into_response() },
    }
}

/// GET /api/alerts/rules
pub(crate) async fn handle_list_rules(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let rows: Vec<(String, Option<String>, String, Option<f64>, String, String, i32, i64, Option<String>)> = sqlx::query_as(
        "SELECT id, node_id, event_type, threshold_value, urgency, channel_id, enabled, created_at, tag
         FROM alert_rules WHERE user_id = $1 ORDER BY created_at DESC"
    ).bind(&user_id).fetch_all(&state.pool).await.unwrap_or_default();

    let rules: Vec<AlertRule> = rows.into_iter().map(|(id, nid, et, tv, u, cid, en, ca, tag)| {
        AlertRule { id, node_id: nid, event_type: et, threshold_value: tv, urgency: u,
            channel_id: cid, enabled: en != 0, created_at: ca, tag }
    }).collect();

    Json(serde_json::json!({ "rules": rules })).into_response()
}

/// DELETE /api/alerts/rules/:id
pub(crate) async fn handle_delete_rule(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(rule_id): Path<String>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let (user_id, _org_id, role) = match require_user_org_role(&token, &state.pool, &clerk_keys).await {
        Some(v) => v,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };
    if !role.can_mutate() { return role_forbidden("member"); }

    let result = sqlx::query("DELETE FROM alert_rules WHERE id = $1 AND user_id = $2")
        .bind(&rule_id).bind(&user_id).execute(&state.pool).await;

    match result {
        Ok(r) if r.rows_affected() > 0 => Json(serde_json::json!({ "ok": true })).into_response(),
        Ok(_) => (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "Rule not found" }))).into_response(),
        Err(e) => { eprintln!("[alerts] rule delete failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Internal server error" }))).into_response() },
    }
}

// ── Alert silences & maintenance windows ─────────────────────────────────────

/// Event types a silence may target — the union of the alert-rule and
/// threshold-webhook vocabularies (a silence suppresses both systems).
pub(crate) const SILENCEABLE_EVENTS: &[&str] = &[
    "thermal_serious", "thermal_critical", "memory_pressure_high", "wes_drop", "node_offline",
    "ttft_regression", "throughput_low",
    "thermal_state_changed", "inference_state_changed", "wes_below", "wes_above",
];

/// Longest allowed silence: 30 days. Anything longer is "delete the rule."
pub(crate) const MAX_SILENCE_MIN: i64 = 30 * 24 * 60;

#[derive(Deserialize)]
pub(crate) struct CreateSilenceBody {
    /// NULL = all nodes.
    pub(crate) node_id:      Option<String>,
    /// NULL = no tag filter; otherwise nodes bearing this tag.
    pub(crate) tag:          Option<String>,
    /// NULL = all event types; otherwise one of SILENCEABLE_EVENTS.
    pub(crate) event_type:   Option<String>,
    #[serde(default)]
    pub(crate) reason:       Option<String>,
    /// Unix ms. Omitted = starts now. Future = scheduled maintenance window.
    pub(crate) starts_at:    Option<i64>,
    pub(crate) duration_min: i64,
}

/// POST /api/alerts/silences (Pro+, Member+) — create a silence or a
/// scheduled maintenance window.
pub(crate) async fn handle_create_silence(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateSilenceBody>,
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
    if !is_pro_or_above(&tier) {
        return upgrade_required("Alert silences", UpgradePlan::Team);
    }

    if body.duration_min < 1 || body.duration_min > MAX_SILENCE_MIN {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "duration_min must be 1..43200 (30 days)" }))).into_response();
    }
    if let Some(ref t) = body.tag
        && !valid_scope_tag(t) {
            return (StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "tag must be 1-64 chars: letters, digits, : - _ ." }))).into_response();
        }
    if let Some(ref et) = body.event_type
        && !SILENCEABLE_EVENTS.contains(&et.as_str()) {
            return (StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": format!("event_type must be one of: {}", SILENCEABLE_EVENTS.join(", ")) }))).into_response();
        }
    let now = now_ms() as i64;
    let starts_at = body.starts_at.unwrap_or(now).max(now - 60_000); // small clock-skew grace
    if starts_at > now + 90 * 24 * 3_600_000 {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "starts_at must be within 90 days" }))).into_response();
    }
    let ends_at = starts_at + body.duration_min * 60_000;
    let reason: String = body.reason.unwrap_or_default().chars().take(200).collect();

    let id = Uuid::new_v4().to_string();
    let tenant_id = tenant_scope(&user_id, &org_id).1.to_string();
    let result = sqlx::query(
        "INSERT INTO alert_silences (id, tenant_id, user_id, node_id, tag, event_type, reason, starts_at, ends_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)"
    ).bind(&id).bind(&tenant_id).bind(&user_id)
    .bind(&body.node_id).bind(&body.tag).bind(&body.event_type).bind(&reason)
    .bind(starts_at).bind(ends_at).bind(now)
    .execute(&state.pool).await;

    match result {
        Ok(_) => {
            audit(&state.pool, &user_id, &org_id, "alert_silence.created", &id,
                serde_json::json!({ "node_id": &body.node_id, "tag": &body.tag,
                    "event_type": &body.event_type, "reason": &reason,
                    "starts_at": starts_at, "ends_at": ends_at }));
            (StatusCode::CREATED, Json(serde_json::json!({
                "id": id, "node_id": body.node_id, "tag": body.tag,
                "event_type": body.event_type, "reason": reason,
                "starts_at": starts_at, "ends_at": ends_at,
            }))).into_response()
        }
        Err(e) => { eprintln!("[silences] insert failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" }))).into_response() }
    }
}

/// GET /api/alerts/silences — active + upcoming silences for the tenant
/// (expired ones age out of the list; the table keeps them for the record).
pub(crate) async fn handle_list_silences(
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
    let now = now_ms() as i64;
    let rows: Vec<(String, Option<String>, Option<String>, Option<String>, String, i64, i64, i64)> = sqlx::query_as(
        "SELECT id, node_id, tag, event_type, reason, starts_at, ends_at, created_at
         FROM alert_silences WHERE tenant_id = $1 AND ends_at > $2
         ORDER BY starts_at ASC"
    ).bind(tval).bind(now).fetch_all(&state.pool).await.unwrap_or_default();

    let silences: Vec<serde_json::Value> = rows.into_iter()
        .map(|(id, node_id, tag, event_type, reason, starts_at, ends_at, created_at)| serde_json::json!({
            "id": id, "node_id": node_id, "tag": tag, "event_type": event_type,
            "reason": reason, "starts_at": starts_at, "ends_at": ends_at,
            "created_at": created_at, "active": starts_at <= now,
        })).collect();

    Json(serde_json::json!({ "silences": silences })).into_response()
}

/// DELETE /api/alerts/silences/:id — end a silence early (Member+).
pub(crate) async fn handle_delete_silence(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(silence_id): Path<String>,
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
    let result = sqlx::query("DELETE FROM alert_silences WHERE id = $1 AND tenant_id = $2")
        .bind(&silence_id).bind(tval).execute(&state.pool).await;

    match result {
        Ok(r) if r.rows_affected() > 0 => {
            audit(&state.pool, &user_id, &org_id, "alert_silence.deleted", &silence_id,
                serde_json::json!({}));
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Ok(_) => (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Silence not found" }))).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" }))).into_response(),
    }
}

/// POST /api/alerts/channels/:id/test
pub(crate) async fn handle_test_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(channel_id): Path<String>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let (user_id, _org_id, role) = match require_user_org_role(&token, &state.pool, &clerk_keys).await {
        Some(v) => v,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session or channel not found" }))).into_response(),
    };
    if !role.can_mutate() { return role_forbidden("member"); }

    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT channel_type, config_json::text FROM notification_channels WHERE id = $1 AND user_id = $2"
    ).bind(&channel_id).bind(&user_id).fetch_optional(&state.pool).await.ok().flatten();

    match row {
        None => (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session or channel not found" }))).into_response(),
        Some((ct, cfg)) => {
            let ok = tokio::task::spawn_blocking(move || {
                deliver_alert(&ct, &cfg, "WK-TEST", "test",
                    "This is a test notification from Wicklee. Your alert channel is working correctly.", false)
            }).await.unwrap_or(false);
            if ok {
                Json(serde_json::json!({ "ok": true, "message": "Test notification sent" })).into_response()
            } else {
                (StatusCode::BAD_GATEWAY,
                    Json(serde_json::json!({ "error": "Delivery failed \u{2014} check webhook URL or email address" }))).into_response()
            }
        }
    }
}
