//! Runtime Config Surface (v0.9.0).
//!
//! Captures the launch-time configuration of each detected inference runtime
//! and exposes it via `GET /api/runtime-config?model=<name>`. Three runtimes:
//!
//! - **Ollama**: `POST /api/show` returns model_info, template, system prompt
//! - **vLLM**: `GET /v1/server_info` (vLLM 0.5.0+), fallback to `ps aux`
//! - **llama.cpp**: `GET /props` (llama-server), fallback to `ps aux`
//!
//! Cache is `Arc<Mutex<HashMap<model_name, RuntimeConfig>>>` shared with the
//! HTTP handler. Populated by the existing Ollama harvester on model change
//! and by dedicated vLLM / llama.cpp harvester tasks polled every 5 minutes.
//!
//! The full config payload is fetched on demand to keep the 1Hz SSE stream
//! small. The MetricsPayload only carries a `runtime_config_available: bool`
//! flag so the frontend knows whether to render the "Config" affordance.
//!
//! Privacy note: system prompts and templates can contain proprietary content.
//! v0.9.0 keeps this data local-only — the cloud push path will NOT ship the
//! `template` or `system_prompt` fields by default. Users who want to share
//! full configs across the fleet can opt in via config.toml.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Snapshot of a runtime's launch-time configuration for one model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RuntimeConfig {
    /// Model identifier as known to the runtime (e.g. "llama3.2:8b" for Ollama,
    /// "meta-llama/Llama-3.1-8B" for vLLM, full path for llama.cpp).
    pub model: String,
    /// Which runtime captured this config: "ollama" | "vllm" | "llamacpp".
    pub runtime: String,
    /// Unix ms timestamp when this snapshot was captured. Lets the frontend
    /// show "captured 3 min ago" and gauge staleness.
    pub captured_at_ms: i64,

    // ── Cross-runtime common fields (best-effort, may be None) ──────────
    /// Context window size in tokens.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u64>,
    /// Number of model layers offloaded to GPU. 0 = CPU only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub n_gpu_layers: Option<u32>,
    /// Quantization label (e.g. "Q4_K_M", "F16", "AWQ-INT4"). Best-effort.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantization: Option<String>,
    /// Parameter count if known (e.g. 8_030_261_312 for Llama 3.1 8B).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameter_count: Option<u64>,

    // ── Ollama-specific fields ─────────────────────────────────────────
    /// Prompt template — Ollama only. Stays local; not pushed to cloud.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// System prompt — Ollama only. Stays local; not pushed to cloud.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,

    // ── vLLM / llama.cpp-specific fields ───────────────────────────────
    /// Full command-line process args. Populated for vLLM / llama.cpp via
    /// either the runtime's introspection endpoint or `ps aux` fallback.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_args: Option<Vec<String>>,

    /// Full raw response from the runtime's introspection endpoint. Lets
    /// power users see the unfiltered config; surfaced as collapsed JSON
    /// in the frontend modal.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<serde_json::Value>,
}

/// Shared cache of model name → RuntimeConfig. Populated by harvesters,
/// read by the HTTP handler for `/api/runtime-config`.
pub(crate) type RuntimeConfigCache = Arc<Mutex<HashMap<String, RuntimeConfig>>>;

/// Helper to build a fresh empty cache for the agent's shared state.
pub(crate) fn new_cache() -> RuntimeConfigCache {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Build a RuntimeConfig from Ollama's `/api/show` response.
///
/// Caller is responsible for invoking this when the active model changes.
/// Parses model_info, parameters, template, and system. All fields are
/// best-effort — Ollama versions vary in which keys are present.
pub(crate) fn build_ollama_config(
    model: &str,
    show_json: &serde_json::Value,
) -> RuntimeConfig {
    let mi = &show_json["model_info"];
    let context_length = mi["general.context_length"].as_u64()
        .or_else(|| mi["llama.context_length"].as_u64());
    let parameter_count = mi["general.parameter_count"].as_u64()
        .or_else(|| mi["llama.parameter_count"].as_u64());

    // Quantization heuristic — Ollama exposes it in details.quantization_level
    // (e.g. "Q4_K_M"). Some older builds use file_type from model_info.
    let quantization = show_json["details"]["quantization_level"]
        .as_str().map(String::from)
        .or_else(|| mi["general.file_type"].as_str().map(String::from));

    // Template + system prompt come at the top level of /api/show output.
    let template = show_json["template"].as_str().map(String::from);
    let system_prompt = show_json["system"].as_str().map(String::from);

    // n_gpu_layers isn't directly in /api/show, but it's in the parameters
    // string if the user set it explicitly. Best-effort parse.
    let n_gpu_layers = show_json["parameters"]
        .as_str()
        .and_then(|p| {
            p.lines()
                .find(|l| l.trim().starts_with("num_gpu"))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|n| n.parse::<u32>().ok())
        });

    RuntimeConfig {
        model: model.to_string(),
        runtime: "ollama".to_string(),
        captured_at_ms: now_ms(),
        context_length,
        n_gpu_layers,
        quantization,
        parameter_count,
        template,
        system_prompt,
        process_args: None,
        raw: Some(show_json.clone()),
    }
}

/// Try to fetch vLLM's launch config. Order:
///   1. `GET /v1/server_info` (vLLM 0.5.0+)
///   2. Fallback: parse `ps aux | grep vllm` command line
///
/// Returns Ok(config) on success, Err(reason) for diagnostic logging.
pub(crate) async fn fetch_vllm_config(
    client: &reqwest::Client,
    base_url: &str,
) -> Result<RuntimeConfig, String> {
    // Attempt #1: /v1/server_info (structured response)
    if let Ok(resp) = client
        .get(format!("{base_url}/v1/server_info"))
        .timeout(Duration::from_secs(2))
        .send().await
        && resp.status().is_success()
            && let Ok(json) = resp.json::<serde_json::Value>().await {
                let model = json["model_name"].as_str()
                    .or_else(|| json["served_model_name"].as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let context_length = json["max_model_len"].as_u64();
                let quantization = json["quantization"].as_str().map(String::from);
                let n_gpu_layers = json.get("tensor_parallel_size").and_then(|v| v.as_u64()).map(|n| n as u32);
                return Ok(RuntimeConfig {
                    model,
                    runtime: "vllm".to_string(),
                    captured_at_ms: now_ms(),
                    context_length,
                    n_gpu_layers,
                    quantization,
                    parameter_count: None,
                    template: None,
                    system_prompt: None,
                    process_args: None,
                    raw: Some(json),
                });
            }

    // Attempt #2: ps aux fallback — finds the vllm process and parses args
    let args = parse_process_args("vllm").await
        .map_err(|e| format!("vllm probe: server_info missing AND ps aux failed: {e}"))?;
    if args.is_empty() {
        return Err("vllm probe: no /v1/server_info, no vllm process found via ps aux".into());
    }

    // Heuristic extraction from CLI args
    let model = extract_arg(&args, &["--model", "-m"]).unwrap_or_else(|| "unknown".to_string());
    let context_length = extract_arg(&args, &["--max-model-len"])
        .and_then(|s| s.parse::<u64>().ok());
    let quantization = extract_arg(&args, &["--quantization"]);
    let n_gpu_layers = extract_arg(&args, &["--tensor-parallel-size"])
        .and_then(|s| s.parse::<u32>().ok());

    Ok(RuntimeConfig {
        model,
        runtime: "vllm".to_string(),
        captured_at_ms: now_ms(),
        context_length,
        n_gpu_layers,
        quantization,
        parameter_count: None,
        template: None,
        system_prompt: None,
        process_args: Some(args),
        raw: None,
    })
}

/// Try to fetch llama-server's launch config. Order:
///   1. `GET /props` (llama-server only)
///   2. Fallback: parse `ps aux | grep -E 'llama-server|llama.cpp'`
pub(crate) async fn fetch_llamacpp_config(
    client: &reqwest::Client,
    base_url: &str,
) -> Result<RuntimeConfig, String> {
    // Attempt #1: /props (llama-server's structured introspection)
    if let Ok(resp) = client
        .get(format!("{base_url}/props"))
        .timeout(Duration::from_secs(2))
        .send().await
        && resp.status().is_success()
            && let Ok(json) = resp.json::<serde_json::Value>().await {
                let model = json["default_generation_settings"]["model"].as_str()
                    .or_else(|| json["model"].as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let context_length = json["default_generation_settings"]["n_ctx"].as_u64()
                    .or_else(|| json["n_ctx"].as_u64());
                let n_gpu_layers = json["default_generation_settings"]["n_gpu_layers"].as_u64()
                    .map(|n| n as u32);
                let system_prompt = json["default_generation_settings"]["system_prompt"]
                    .as_str().map(String::from);
                return Ok(RuntimeConfig {
                    model,
                    runtime: "llamacpp".to_string(),
                    captured_at_ms: now_ms(),
                    context_length,
                    n_gpu_layers,
                    quantization: None,
                    parameter_count: None,
                    template: None,
                    system_prompt,
                    process_args: None,
                    raw: Some(json),
                });
            }

    // Attempt #2: ps aux fallback. Try llama-server first (the common
    // serving binary), then raw llama.cpp (less common, batch use).
    let args = match parse_process_args("llama-server").await {
        Ok(a) if !a.is_empty() => a,
        _ => parse_process_args("llama.cpp").await
            .map_err(|e| format!("llama.cpp probe: /props missing AND ps aux failed: {e}"))?,
    };
    if args.is_empty() {
        return Err("llama.cpp probe: no /props, no llama-server/llama.cpp process found".into());
    }

    // Heuristic extraction
    let model = extract_arg(&args, &["--model", "-m"])
        .or_else(|| extract_arg(&args, &["-mli"]))
        .unwrap_or_else(|| "unknown".to_string());
    let context_length = extract_arg(&args, &["--ctx-size", "-c"])
        .and_then(|s| s.parse::<u64>().ok());
    let n_gpu_layers = extract_arg(&args, &["--n-gpu-layers", "-ngl"])
        .and_then(|s| s.parse::<u32>().ok());

    Ok(RuntimeConfig {
        model,
        runtime: "llamacpp".to_string(),
        captured_at_ms: now_ms(),
        context_length,
        n_gpu_layers,
        quantization: None,
        parameter_count: None,
        template: None,
        system_prompt: None,
        process_args: Some(args),
        raw: None,
    })
}

// ── Helpers ────────────────────────────────────────────────────────────

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Find the first matching `--flag` and return the value that follows it.
/// Searches multiple aliases so callers can write `extract_arg(&args, &["--model", "-m"])`.
fn extract_arg(args: &[String], flags: &[&str]) -> Option<String> {
    for (i, arg) in args.iter().enumerate() {
        // Handle `--flag=value`
        for &flag in flags {
            if let Some(rest) = arg.strip_prefix(&format!("{flag}=")) {
                return Some(rest.to_string());
            }
            if arg == flag {
                return args.get(i + 1).cloned();
            }
        }
    }
    None
}

/// Run `ps aux` and return the args of the first process matching `name_pattern`.
/// Best-effort — returns empty Vec if nothing matched. Uses a 2s timeout to
/// avoid blocking the harvester loop on a wedged ps.
async fn parse_process_args(name_pattern: &str) -> Result<Vec<String>, String> {
    let output = tokio::time::timeout(
        Duration::from_secs(2),
        tokio::process::Command::new("ps")
            .args(["-eo", "pid,args"])
            .output(),
    )
    .await
    .map_err(|_| "ps aux timed out".to_string())?
    .map_err(|e| format!("ps aux failed: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        // Skip ps's own header
        if line.trim().starts_with("PID") {
            continue;
        }
        // Skip our own grep / Wicklee process to avoid self-match
        if line.contains("grep") || line.contains("wicklee") {
            continue;
        }
        if line.contains(name_pattern) {
            // First token is PID, rest is the command + args
            let mut tokens = line.split_whitespace();
            let _pid = tokens.next();
            let args: Vec<String> = tokens.map(|s| s.to_string()).collect();
            return Ok(args);
        }
    }
    Ok(Vec::new())
}
