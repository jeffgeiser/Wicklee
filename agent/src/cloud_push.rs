use crate::PairingState;
use std::sync::{Arc, Mutex};

/// Default cloud URL for telemetry push. Points directly to the Railway backend
/// to avoid consuming Cloudflare Worker request quota on high-frequency pushes
/// (3 nodes × 0.5 req/s = 43K requests/day). Override with WICKLEE_CLOUD_URL env var.
pub(crate) const CLOUD_URL: &str = "https://vibrant-fulfillment-production-62c0.up.railway.app";

/// Normal push cadence, and the first backoff step.
const PUSH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

/// Ceiling on the retry interval. A node whose backend has gone away keeps
/// trying at this rate rather than giving up, because the backend coming back
/// is the expected case and nothing else would notice it had.
const MAX_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

/// How long to wait before the next attempt, after `failures` consecutive
/// failed pushes. Zero failures is the normal 2 s cadence; after that it
/// doubles — 2, 4, 8, 16, 32, 60, 60… — and stops at [`MAX_RETRY_INTERVAL`].
///
/// This exists because the previous behaviour was worse than no retry logic.
/// A failed POST deliberately left `last_pushed_state` stale so the next frame
/// would retry immediately after a network blip; the side effect was that
/// `state_changed` stayed true forever, which bypassed the 2 s throttle on
/// every 1 Hz frame. Against a backend that was gone rather than blipping,
/// that is one connect attempt per second indefinitely — twice the healthy
/// cadence, with nothing logged and no end.
pub(crate) fn retry_interval(failures: u32) -> std::time::Duration {
    if failures == 0 { return PUSH_INTERVAL; }
    let secs = PUSH_INTERVAL.as_secs().saturating_mul(1u64 << (failures - 1).min(16));
    std::time::Duration::from_secs(secs).min(MAX_RETRY_INTERVAL)
}

/// Spawn a background task that forwards live telemetry to the cloud every 2 s.
/// Subscribes to the existing broadcast channel (1 Hz metrics broadcaster) and
/// throttles pushes to 1 per 2 s so we don't hammer Railway.
/// Idles (skips pushes) while no session_token is set, e.g. after disconnect
/// or a 410-Gone, and resumes on its own once the node is re-paired.
///
/// When the backend is unreachable it backs off to one attempt a minute (see
/// [`retry_interval`]) and says so once, not once per attempt. It never gives
/// up: a node that outlives an outage reconnects by itself.
///
/// On non-musl targets, embeds the latest evaluated observations from the shared
/// ObservationCache into each push so the fleet dashboard gets pattern data
/// without needing its own evaluation logic.
#[cfg(not(target_env = "musl"))]
pub(crate) fn start_cloud_push(
    pairing_state: Arc<Mutex<PairingState>>,
    broadcast_tx:  tokio::sync::broadcast::Sender<String>,
    obs_cache:     crate::ObservationCache,
    profile:       Arc<Mutex<crate::DeploymentProfile>>,
) {
    start_cloud_push_inner(pairing_state, broadcast_tx, Some(obs_cache), profile);
}

#[cfg(target_env = "musl")]
pub(crate) fn start_cloud_push(
    pairing_state: Arc<Mutex<PairingState>>,
    broadcast_tx:  tokio::sync::broadcast::Sender<String>,
    profile:       Arc<Mutex<crate::DeploymentProfile>>,
) {
    start_cloud_push_inner(pairing_state, broadcast_tx, None, profile);
}

fn start_cloud_push_inner(
    pairing_state: Arc<Mutex<PairingState>>,
    broadcast_tx:  tokio::sync::broadcast::Sender<String>,
    #[cfg(not(target_env = "musl"))]
    obs_cache:     Option<crate::ObservationCache>,
    #[cfg(target_env = "musl")]
    _obs_cache:    Option<()>,
    profile:       Arc<Mutex<crate::DeploymentProfile>>,
) {
    use tokio::sync::broadcast::error::RecvError;
    use std::ops::ControlFlow;

    crate::supervisor::supervise_until("cloud-push", move || {
        let pairing_state = pairing_state.clone();
        let broadcast_tx  = broadcast_tx.clone();
        let profile       = profile.clone();
        #[cfg(not(target_env = "musl"))]
        let obs_cache     = obs_cache.clone();
        async move {
        let cloud  = std::env::var("WICKLEE_CLOUD_URL").unwrap_or_else(|_| CLOUD_URL.to_string());
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(3))
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_default();

        let mut rx                = broadcast_tx.subscribe();
        let mut last_push         = std::time::Instant::now()
            .checked_sub(std::time::Duration::from_secs(10))
            .unwrap_or_else(std::time::Instant::now);
        let mut consecutive_failures: u32 = 0;
        let mut last_pushed_state: Option<String> = None;

        loop {
            let frame = match rx.recv().await {
                Ok(json)                    => json,
                Err(RecvError::Closed)      => return ControlFlow::Break(()),
                Err(RecvError::Lagged(_))   => continue,
            };

            let parsed: Option<serde_json::Value> = serde_json::from_str(&frame).ok();
            let curr_state: Option<String> = parsed.as_ref()
                .and_then(|v| v["inference_state"].as_str().map(|s| s.to_string()));
            let state_changed = curr_state.as_deref() != last_pushed_state.as_deref();

            let interval = retry_interval(consecutive_failures);
            let may_bypass = state_changed && consecutive_failures == 0;
            if !may_bypass && last_push.elapsed() < interval { continue; }

            let (wk_id, session_token) = {
                let state = pairing_state.lock().unwrap();
                match &state.cloud_session_token {
                    Some(tok) => (state.node_id.clone(), tok.clone()),
                    None => continue,
                }
            };

            let patched = if let Some(mut val) = parsed {
                val["node_id"] = serde_json::json!(wk_id);
                let current_profile = profile.lock()
                    .map(|p| *p)
                    .unwrap_or(crate::DeploymentProfile::DedicatedServer);
                val["deployment_profile"] = serde_json::json!(current_profile.as_str());
                #[cfg(not(target_env = "musl"))]
                if let Some(ref cache) = obs_cache
                    && let Ok(obs) = cache.lock()
                        && !obs.is_empty() {
                            let enriched: Vec<serde_json::Value> = obs.iter().map(|o| {
                                let mut v = serde_json::to_value(o).unwrap_or_default();
                                if let Some(obj) = v.as_object_mut() {
                                    obj.insert("routing_hint".into(),
                                        serde_json::json!(crate::routing_hint_for(o.pattern_id, o.severity)));
                                }
                                v
                            }).collect();
                            val["observations"] = serde_json::to_value(&enriched).unwrap_or_default();
                        }
                val.to_string()
            } else {
                frame
            };

            last_push = std::time::Instant::now();
            let resp = client
                .post(format!("{cloud}/api/telemetry"))
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {session_token}"))
                .body(patched)
                .send()
                .await;
            match resp {
                Ok(r) if r.status().as_u16() == 410 => {
                    eprintln!("[cloud_push] 410 Gone — node removed from fleet. Clearing pairing state.");
                    consecutive_failures = 0;
                    if let Ok(mut ps) = pairing_state.lock()
                        && ps.cloud_session_token.as_deref() == Some(session_token.as_str()) {
                            ps.cloud_session_token = None;
                            ps.status = crate::PairingStatus::Unpaired;
                            crate::update_config(|cfg| {
                                cfg.fleet_url = None;
                                cfg.session_token = None;
                            });
                        }
                    continue;
                }
                Ok(r) if r.status().is_success() => {
                    if consecutive_failures > 0 {
                        eprintln!(
                            "[cloud_push] fleet backend reachable again after {consecutive_failures} failed push(es)",
                        );
                        consecutive_failures = 0;
                    }
                    last_pushed_state = curr_state;
                    if let Ok(body) = r.json::<serde_json::Value>().await
                        && let Some(desired) = body.get("desired_profile").and_then(|v| v.as_str())
                            && matches!(desired, "sovereign_dev" | "dedicated_server" | "production_fleet") {
                                let next = crate::DeploymentProfile::from_config(Some(desired));
                                let changed = profile.lock()
                                    .map(|mut p| if *p != next { *p = next; true } else { false })
                                    .unwrap_or(false);
                                if changed {
                                    let persisted = next.as_str().to_string();
                                    crate::update_config(move |cfg| {
                                        cfg.deployment_profile = Some(persisted);
                                    });
                                    eprintln!("[cloud_push] fleet config applied: deployment_profile → {desired}");
                                }
                            }
                }
                _ => {
                    consecutive_failures = consecutive_failures.saturating_add(1);
                    if consecutive_failures == 1 {
                        eprintln!(
                            "[cloud_push] fleet backend unreachable at {cloud} — backing off to one attempt per {}s until it answers",
                            MAX_RETRY_INTERVAL.as_secs(),
                        );
                    }
                }
            }
        }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_healthy_push_keeps_the_two_second_cadence() {
        assert_eq!(retry_interval(0), PUSH_INTERVAL);
    }

    #[test]
    fn failures_double_the_wait() {
        let secs: Vec<u64> = (1..=5).map(|n| retry_interval(n).as_secs()).collect();
        assert_eq!(secs, vec![2, 4, 8, 16, 32]);
    }

    #[test]
    fn the_wait_stops_at_a_minute() {
        for n in 6..=40 {
            assert_eq!(
                retry_interval(n), MAX_RETRY_INTERVAL,
                "failure {n} should be capped, not {:?}", retry_interval(n),
            );
        }
    }

    /// The shift is what overflows first, so the cap has to hold for a counter
    /// that has been incrementing once a minute for years rather than for the
    /// handful of failures a test would otherwise reach.
    #[test]
    fn a_very_long_outage_does_not_overflow_the_shift() {
        assert_eq!(retry_interval(u32::MAX), MAX_RETRY_INTERVAL);
        assert_eq!(retry_interval(1_000_000), MAX_RETRY_INTERVAL);
    }
}
