use axum::{
    body::Body,
    http::StatusCode,
    response::IntoResponse,
};
use std::sync::{Arc, Mutex};
use tokio_stream::wrappers::ReceiverStream;

/// Shared state between the proxy Axum app and the OllamaMetrics writer task.
pub(crate) struct ProxyState {
    pub(crate) ollama_port:    u16,
    pub(crate) bypass_if_down: bool,
    pub(crate) client:         reqwest::Client,
    /// Set to true the instant a request arrives; cleared via 35s window after last done packet.
    pub(crate) inference_active: std::sync::atomic::AtomicBool,
    /// Timestamp of last completed request (done packet received).
    pub(crate) last_done_ts:   Mutex<Option<std::time::Instant>>,
    /// Exact tok/s from the most recent done packet.
    pub(crate) exact_tps:      Mutex<Option<f32>>,
    /// Node ID for trace attribution.
    pub(crate) node_id: String,
    /// Channel sender for inference traces — writes to DuckDB via a consumer task.
    #[cfg(not(target_env = "musl"))]
    pub(crate) trace_tx: Option<tokio::sync::mpsc::UnboundedSender<crate::store::TraceRow>>,
}

/// Timeout for individual upstream chunks — if no data arrives for this long,
/// the proxy closes the stream with an error rather than hanging indefinitely.
const CHUNK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Proxy handler for /api/generate and /api/chat — streams request through and
/// inspects the final done packet for exact tok/s.
pub(crate) async fn proxy_ollama_streaming(
    axum::extract::State(state): axum::extract::State<Arc<ProxyState>>,
    req: axum::extract::Request,
) -> impl IntoResponse {
    use tokio_stream::StreamExt;

    let path = req.uri().path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_default();

    let method = req.method().clone();
    let headers = req.headers().clone();

    // Buffer request body (prompt JSON — typically <64 KB)
    let body_bytes = match axum::body::to_bytes(req.into_body(), 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return axum::http::Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .body(Body::from("request body too large"))
            .unwrap(),
    };

    // Extract model name and mark inference as active immediately
    let model = if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&body_bytes) {
        v["model"].as_str().unwrap_or("").to_string()
    } else {
        String::new()
    };
    state.inference_active.store(true, std::sync::atomic::Ordering::Relaxed);

    // Trace timing: capture request start and generate a unique trace ID.
    let req_ts_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let trace_id = uuid::Uuid::new_v4().to_string();

    // Forward to backend Ollama
    let backend_url = format!("http://127.0.0.1:{}{}", state.ollama_port, path);
    let upstream = state.client
        .request(method, &backend_url)
        .headers(headers)
        .body(body_bytes)
        .send()
        .await;

    let upstream_resp = match upstream {
        Ok(r) => r,
        Err(e) => {
            let hint = format!(
                "Wicklee proxy: cannot reach Ollama on :{} — {}\n\
                 Check that Ollama is running with OLLAMA_HOST=127.0.0.1:{}",
                state.ollama_port, e, state.ollama_port
            );
            if state.bypass_if_down {
                return axum::http::Response::builder()
                    .status(StatusCode::SERVICE_UNAVAILABLE)
                    .header("X-Wicklee-Hint", "backend-unreachable")
                    .body(Body::from(hint))
                    .unwrap();
            } else {
                return axum::http::Response::builder()
                    .status(StatusCode::BAD_GATEWAY)
                    .body(Body::from(hint))
                    .unwrap();
            }
        }
    };

    let status  = upstream_resp.status();
    let resp_headers = upstream_resp.headers().clone();

    // Stream response back, inspecting chunks for the done packet
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(64);
    let proxy_state = Arc::clone(&state);
    let trace_model = model.clone();
    let trace_id_clone = trace_id.clone();

    tokio::spawn(async move {
        let trace_id = trace_id_clone;
        let model = trace_model;
        let mut byte_stream = upstream_resp.bytes_stream();
        loop {
            match tokio::time::timeout(CHUNK_TIMEOUT, byte_stream.next()).await {
                Ok(Some(chunk)) => {
                    match chunk {
                        Ok(bytes) => {
                            // Scan for done packet — Ollama sends one JSON object per line (NDJSON).
                            // The done packet is the last line; it's small and rarely split across chunks.
                            if let Ok(text) = std::str::from_utf8(&bytes) {
                                for line in text.lines() {
                                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                                        if v["done"].as_bool() == Some(true) {
                                            if let (Some(ec), Some(ed)) = (
                                                v["eval_count"].as_u64(),
                                                v["eval_duration"].as_u64(),
                                            ) {
                                                let tps = ec as f64 / (ed as f64 / 1_000_000_000.0);
                                                *proxy_state.exact_tps.lock().unwrap() = Some(tps as f32);
                                                *proxy_state.last_done_ts.lock().unwrap() =
                                                    Some(std::time::Instant::now());
                                            }

                                            // Capture per-request timing for inference traces.
                                            let total_dur    = v["total_duration"].as_u64().unwrap_or(0);
                                            let prompt_dur   = v["prompt_eval_duration"].as_u64().unwrap_or(0);
                                            let eval_dur     = v["eval_duration"].as_u64().unwrap_or(0);
                                            let eval_cnt     = v["eval_count"].as_u64().unwrap_or(0);
                                            let latency_ms   = (total_dur / 1_000_000) as i64;
                                            let ttft_ms      = (prompt_dur / 1_000_000) as i64;
                                            let tpot_ms      = if eval_cnt > 0 {
                                                (eval_dur as f64 / eval_cnt as f64) / 1_000_000.0
                                            } else {
                                                0.0
                                            };

                                            #[cfg(not(target_env = "musl"))]
                                            if let Some(ref tx) = proxy_state.trace_tx {
                                                let _ = tx.send(crate::store::TraceRow {
                                                    id: trace_id.clone(),
                                                    ts_ms: req_ts_ms,
                                                    node_id: proxy_state.node_id.clone(),
                                                    model: model.clone(),
                                                    latency_ms,
                                                    ttft_ms,
                                                    tpot_ms,
                                                    status: status.as_u16() as i32,
                                                    eval_count: Some(eval_cnt as i64),
                                                    eval_duration_ns: Some(eval_dur as i64),
                                                });
                                            }
                                        }
                                    }
                                }
                            }
                            if tx.send(Ok(bytes)).await.is_err() {
                                break;
                            }
                        }
                        Err(e) => {
                            let _ = tx.send(Err(std::io::Error::new(std::io::ErrorKind::Other, e))).await;
                            break;
                        }
                    }
                }
                Ok(None) => break, // stream ended
                Err(_) => {
                    // Chunk timeout — notify client and close
                    let _ = tx.send(Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "upstream chunk timeout (60s)",
                    ))).await;
                    break;
                }
            }
        }
    });

    let stream_body = Body::from_stream(ReceiverStream::new(rx));
    let mut builder = axum::http::Response::builder().status(status);
    for (name, value) in &resp_headers {
        builder = builder.header(name, value);
    }
    builder.body(stream_body).unwrap_or_else(|_| {
        axum::http::Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Body::empty())
            .unwrap()
    })
}

/// Proxy passthrough for all other Ollama routes (/api/tags, /api/ps, /api/version, etc.).
/// Pure forwarding — no inspection needed.
pub(crate) async fn proxy_passthrough(
    axum::extract::State(state): axum::extract::State<Arc<ProxyState>>,
    req: axum::extract::Request,
) -> impl IntoResponse {
    use tokio_stream::StreamExt;

    let path = req.uri().path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_default();

    let method  = req.method().clone();
    let headers = req.headers().clone();
    let body_bytes = axum::body::to_bytes(req.into_body(), 64 * 1024 * 1024)
        .await
        .unwrap_or_default();

    let backend_url = format!("http://127.0.0.1:{}{}", state.ollama_port, path);
    let upstream = state.client
        .request(method, &backend_url)
        .headers(headers)
        .body(body_bytes)
        .send()
        .await;

    match upstream {
        Err(e) => axum::http::Response::builder()
            .status(StatusCode::BAD_GATEWAY)
            .body(Body::from(format!("Wicklee proxy: backend unreachable — {e}")))
            .unwrap(),
        Ok(resp) => {
            let status       = resp.status();
            let resp_headers = resp.headers().clone();
            let (tx, rx)     = tokio::sync::mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(64);
            tokio::spawn(async move {
                let mut s = resp.bytes_stream();
                loop {
                    match tokio::time::timeout(CHUNK_TIMEOUT, s.next()).await {
                        Ok(Some(c)) => {
                            match c {
                                Ok(b)  => { if tx.send(Ok(b)).await.is_err() { break; } }
                                Err(e) => { let _ = tx.send(Err(std::io::Error::new(std::io::ErrorKind::Other, e))).await; break; }
                            }
                        }
                        Ok(None) => break,
                        Err(_) => {
                            let _ = tx.send(Err(std::io::Error::new(
                                std::io::ErrorKind::TimedOut,
                                "upstream chunk timeout (60s)",
                            ))).await;
                            break;
                        }
                    }
                }
            });
            let mut builder = axum::http::Response::builder().status(status);
            for (name, value) in &resp_headers {
                builder = builder.header(name, value);
            }
            builder.body(Body::from_stream(ReceiverStream::new(rx))).unwrap_or_else(|_| {
                axum::http::Response::builder()
                    .status(StatusCode::INTERNAL_SERVER_ERROR)
                    .body(Body::empty())
                    .unwrap()
            })
        }
    }
}
