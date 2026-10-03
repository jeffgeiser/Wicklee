use axum::{
    body::Body,
    http::StatusCode,
    response::IntoResponse,
};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio_stream::wrappers::ReceiverStream;

/// Per-model proxy statistics accumulated from done packets.
pub(crate) struct ModelStats {
    pub(crate) last_tps:        f32,
    pub(crate) ttft_sum_ns:     u64,
    pub(crate) latency_sum_ns:  u64,
    pub(crate) request_count:   u64,
    pub(crate) last_done:       std::time::Instant,
}

/// Shared state between the proxy Axum app and the OllamaMetrics writer task.
pub(crate) struct ProxyState {
    pub(crate) ollama_port:    u16,
    pub(crate) bypass_if_down: bool,
    pub(crate) client:         reqwest::Client,
    /// Number of inference requests currently streaming through the proxy.
    /// >0 = inference active right now. Incremented when a request arrives,
    /// > decremented when its relay task ends (done packet, stream end, error,
    /// > timeout, or client disconnect — Drop guard covers them all). Replaces
    /// > a set-but-never-cleared AtomicBool that stuck "inference active" on
    /// > permanently after the first proxied request.
    pub(crate) in_flight: std::sync::atomic::AtomicU32,
    /// Timestamp of last completed request (done packet received).
    pub(crate) last_done_ts:   Mutex<Option<std::time::Instant>>,
    /// Node ID for trace attribution.
    pub(crate) node_id: String,
    /// Channel sender for inference traces — writes to DuckDB via a consumer task.
    #[cfg(not(target_env = "musl"))]
    pub(crate) trace_tx: Option<tokio::sync::mpsc::UnboundedSender<crate::store::TraceRow>>,
    /// Per-model proxy statistics keyed by model name (e.g. "llama3:8b").
    /// Updated on each done packet. Read by the harvester once per second.
    pub(crate) per_model: Mutex<HashMap<String, ModelStats>>,
}

/// Timeout for individual upstream chunks — if no data arrives for this long,
/// the proxy closes the stream with an error rather than hanging indefinitely.
const CHUNK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Max buffered request body for /api/generate and /api/chat (base64 images
/// in multimodal prompts make these far larger than plain-text prompts).
const MAX_INFERENCE_BODY: usize = 64 * 1024 * 1024;

fn body_too_large() -> axum::http::Response<Body> {
    axum::http::Response::builder()
        .status(StatusCode::PAYLOAD_TOO_LARGE)
        .body(Body::from(format!(
            "Wicklee proxy: request body exceeds {} MB limit for /api/generate and /api/chat",
            MAX_INFERENCE_BODY / (1024 * 1024),
        )))
        .unwrap()
}

/// True when a `to_bytes` failure was caused by the length limit (as opposed
/// to e.g. the client disconnecting mid-upload).
fn is_length_limit(e: &axum::Error) -> bool {
    let mut src: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(err) = src {
        if err.to_string().contains("length limit exceeded") {
            return true;
        }
        src = err.source();
    }
    false
}

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

    // Buffer request body so the model name can be parsed for tracing. Text
    // prompts are small, but multimodal requests carry base64 images, so the
    // cap is generous; anything larger gets an explicit 413.
    let declared_len = headers.get(axum::http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok());
    if declared_len.is_some_and(|n| n > MAX_INFERENCE_BODY) {
        return body_too_large();
    }
    let body_bytes = match axum::body::to_bytes(req.into_body(), MAX_INFERENCE_BODY).await {
        Ok(b) => b,
        Err(e) if is_length_limit(&e) => return body_too_large(),
        Err(e) => return axum::http::Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .body(Body::from(format!("Wicklee proxy: failed to read request body — {e}")))
            .unwrap(),
    };

    // Extract model name and mark inference as active immediately
    let model = if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&body_bytes) {
        v["model"].as_str().unwrap_or("").to_string()
    } else {
        String::new()
    };
    state.in_flight.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

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
            // Request never started streaming — release the in-flight slot.
            state.in_flight.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
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
        // Release the in-flight slot when the relay ends, on EVERY exit path
        // (done, stream end, upstream error, chunk timeout, client gone, panic).
        scopeguard::defer! {
            proxy_state.in_flight.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
        }
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
                                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line)
                                        && v["done"].as_bool() == Some(true) {
                                            let total_dur    = v["total_duration"].as_u64().unwrap_or(0);
                                            let prompt_dur   = v["prompt_eval_duration"].as_u64().unwrap_or(0);
                                            let eval_dur     = v["eval_duration"].as_u64().unwrap_or(0);
                                            let eval_cnt     = v["eval_count"].as_u64().unwrap_or(0);

                                            let tps = if eval_cnt > 0 && eval_dur > 0 {
                                                (eval_cnt as f64 / (eval_dur as f64 / 1_000_000_000.0)) as f32
                                            } else { 0.0 };

                                            let now = std::time::Instant::now();
                                            *proxy_state.last_done_ts.lock().unwrap() = Some(now);

                                            // Per-model accumulator update
                                            {
                                                let mut map = proxy_state.per_model.lock().unwrap();
                                                let entry = map.entry(model.clone()).or_insert(ModelStats {
                                                    last_tps: 0.0, ttft_sum_ns: 0, latency_sum_ns: 0,
                                                    request_count: 0, last_done: now,
                                                });
                                                entry.last_tps = tps;
                                                entry.ttft_sum_ns += prompt_dur;
                                                entry.latency_sum_ns += total_dur;
                                                entry.request_count += 1;
                                                entry.last_done = now;
                                            }

                                            // Per-request inference trace → DuckDB
                                            let latency_ms   = (total_dur / 1_000_000) as i64;
                                            let ttft_ms      = (prompt_dur / 1_000_000) as i64;
                                            let tpot_ms      = if eval_cnt > 0 {
                                                (eval_dur as f64 / eval_cnt as f64) / 1_000_000.0
                                            } else { 0.0 };

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
                            if tx.send(Ok(bytes)).await.is_err() {
                                break;
                            }
                        }
                        Err(e) => {
                            let _ = tx.send(Err(std::io::Error::other(e))).await;
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
    // Stream the body through unbuffered — /api/blobs/:digest carries whole
    // GGUF files, far beyond any sane in-memory cap.
    let body = reqwest::Body::wrap_stream(req.into_body().into_data_stream());

    let backend_url = format!("http://127.0.0.1:{}{}", state.ollama_port, path);
    let upstream = state.client
        .request(method, &backend_url)
        .headers(headers)
        .body(body)
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
                                Err(e) => { let _ = tx.send(Err(std::io::Error::other(e))).await; break; }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state(ollama_port: u16) -> Arc<ProxyState> {
        Arc::new(ProxyState {
            ollama_port,
            bypass_if_down: false,
            client:         reqwest::Client::new(),
            in_flight:      std::sync::atomic::AtomicU32::new(0),
            last_done_ts:   Mutex::new(None),
            node_id:        "test".into(),
            #[cfg(not(target_env = "musl"))]
            trace_tx:       None,
            per_model:      Mutex::new(HashMap::new()),
        })
    }

    async fn body_string(resp: axum::response::Response) -> String {
        let b = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        String::from_utf8(b.to_vec()).unwrap()
    }

    #[tokio::test]
    async fn inference_body_over_cap_is_413() {
        let state = test_state(1); // never contacted
        // Declared Content-Length over the cap → rejected before buffering.
        let req = axum::http::Request::post("/api/chat")
            .header("content-length", (MAX_INFERENCE_BODY + 1).to_string())
            .body(Body::empty()).unwrap();
        let resp = proxy_ollama_streaming(axum::extract::State(Arc::clone(&state)), req)
            .await.into_response();
        assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);

        // No Content-Length (chunked) → caught by the to_bytes limit.
        let big = vec![b'a'; MAX_INFERENCE_BODY + 1];
        let stream = tokio_stream::once(Ok::<_, std::io::Error>(axum::body::Bytes::from(big)));
        let req = axum::http::Request::post("/api/chat")
            .body(Body::from_stream(stream)).unwrap();
        let resp = proxy_ollama_streaming(axum::extract::State(state), req)
            .await.into_response();
        assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn passthrough_forwards_bodies_over_16mb() {
        // Mock backend that echoes the received body length.
        let app = axum::Router::new().fallback(|body: axum::body::Bytes| async move {
            body.len().to_string()
        }).layer(axum::extract::DefaultBodyLimit::disable());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let len = 20 * 1024 * 1024;
        let req = axum::http::Request::post("/api/blobs/sha256-abc")
            .body(Body::from(vec![0u8; len])).unwrap();
        let resp = proxy_passthrough(axum::extract::State(test_state(port)), req)
            .await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_string(resp).await, len.to_string());
    }
}
