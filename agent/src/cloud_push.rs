use crate::PairingState;
use std::sync::{Arc, Mutex};

pub(crate) const CLOUD_URL: &str = "https://wicklee.dev";

/// Spawn a background task that forwards live telemetry to the cloud every 2 s.
/// Subscribes to the existing broadcast channel (already runs at 10 Hz) and
/// throttles pushes to 1 per 2 s so we don't hammer Railway.
/// Stops automatically when the session_token is cleared (on disconnect).
///
/// On non-musl targets, embeds the latest evaluated observations from the shared
/// ObservationCache into each push so the fleet dashboard gets pattern data
/// without needing its own evaluation logic.
#[cfg(not(target_env = "musl"))]
pub(crate) fn start_cloud_push(
    pairing_state: Arc<Mutex<PairingState>>,
    broadcast_tx:  tokio::sync::broadcast::Sender<String>,
    obs_cache:     crate::ObservationCache,
) {
    start_cloud_push_inner(pairing_state, broadcast_tx, Some(obs_cache));
}

#[cfg(target_env = "musl")]
pub(crate) fn start_cloud_push(
    pairing_state: Arc<Mutex<PairingState>>,
    broadcast_tx:  tokio::sync::broadcast::Sender<String>,
) {
    start_cloud_push_inner(pairing_state, broadcast_tx, None);
}

fn start_cloud_push_inner(
    pairing_state: Arc<Mutex<PairingState>>,
    broadcast_tx:  tokio::sync::broadcast::Sender<String>,
    #[cfg(not(target_env = "musl"))]
    obs_cache:     Option<crate::ObservationCache>,
    #[cfg(target_env = "musl")]
    _obs_cache:    Option<()>,
) {
    use tokio::sync::broadcast::error::RecvError;

    tokio::spawn(async move {
        let cloud  = std::env::var("WICKLEE_CLOUD_URL").unwrap_or_else(|_| CLOUD_URL.to_string());
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(3))
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_default();

        let mut rx                = broadcast_tx.subscribe();
        let mut last_push         = std::time::Instant::now()
            .checked_sub(std::time::Duration::from_secs(10))  // push immediately on first tick
            .unwrap_or_else(std::time::Instant::now);
        let push_interval         = std::time::Duration::from_secs(2);
        // Track the last inference_state we pushed.  When it changes (e.g. idle-spd → live)
        // we bypass the 2s throttle so the fleet/cloud view reflects the transition in <100 ms
        // rather than up to 2s later — eliminating the local-LIVE / cloud-IDLE-SPD divergence.
        let mut last_pushed_state: Option<String> = None;

        loop {
            let frame = match rx.recv().await {
                Ok(json)                    => json,
                Err(RecvError::Closed)      => break,
                Err(RecvError::Lagged(_))   => continue,
            };

            // Extract inference_state for the bypass decision (one cheap JSON parse).
            let curr_state: Option<String> = serde_json::from_str::<serde_json::Value>(&frame)
                .ok()
                .and_then(|v| v["inference_state"].as_str().map(|s| s.to_string()));
            let state_changed = curr_state.as_deref() != last_pushed_state.as_deref();

            // Throttle regular metric updates to 1/2s; bypass immediately on state transition.
            if !state_changed && last_push.elapsed() < push_interval { continue; }

            // Only push when paired (session_token present).
            let (wk_id, session_token) = {
                let state = pairing_state.lock().unwrap();
                match &state.cloud_session_token {
                    Some(tok) => (state.node_id.clone(), tok.clone()),
                    None => continue,
                }
            };

            // Patch the JSON frame: replace node_id with the WK-XXXX identifier
            // so it matches the nodes table key. The `hostname` field is already
            // set correctly by the broadcast loop (System::host_name()) — do NOT
            // overwrite it.
            let patched = if let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&frame) {
                val["node_id"] = serde_json::json!(wk_id);
                // Embed current observations from the shared cache (non-musl only).
                // Empty array is omitted by the cloud's serde(default) — no overhead.
                #[cfg(not(target_env = "musl"))]
                if let Some(ref cache) = obs_cache {
                    if let Ok(obs) = cache.lock() {
                        if !obs.is_empty() {
                            val["observations"] = serde_json::to_value(&*obs).unwrap_or_default();
                        }
                    }
                }
                val.to_string()
            } else {
                frame
            };

            last_push = std::time::Instant::now();
            // Only advance last_pushed_state on a successful POST.
            // If the request fails (network blip, 5xx, timeout) last_pushed_state stays
            // at the old value — state_changed remains true on the next tick and we retry
            // immediately rather than waiting for the 2s throttle to expire.
            let resp = client
                .post(format!("{cloud}/api/telemetry"))
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {session_token}"))
                .body(patched)
                .send()
                .await;
            match resp {
                Ok(r) if r.status().as_u16() == 410 => {
                    // 410 Gone — node was removed from fleet. Clear pairing state.
                    eprintln!("[cloud_push] 410 Gone — node removed from fleet. Clearing pairing state.");
                    if let Ok(mut ps) = pairing_state.lock() {
                        ps.cloud_session_token = None;
                        ps.status = crate::PairingStatus::Unpaired;
                    }
                    break; // Stop the push loop entirely
                }
                Ok(r) if r.status().is_success() => {
                    last_pushed_state = curr_state;
                }
                _ => {} // Network error or non-2xx — retry next cycle
            }
        }
    });
}
