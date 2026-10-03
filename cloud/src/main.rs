// `type_complexity` is allowed crate-wide: the flagged sites are sqlx row
// tuples and axum handler signatures, where a named alias per call site adds
// indirection without adding meaning. Every other clippy lint is enforced
// (-D warnings in CI).
#![allow(clippy::type_complexity)]
// `result_large_err`: auth helpers return Err(axum Response) as an early
// return — the idiom throughout this file. Boxing the Response would ripple
// into every caller for no benefit on a cold path. (Fires on clippy ≥1.98.)
#![allow(clippy::result_large_err)]

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, Method, Request, StatusCode},
    middleware::{self, Next},
    response::{sse::{Event, KeepAlive, Sse}, IntoResponse, Response},
    routing::{delete, get, patch, post},
    Json, Router,
};
use sha2::{Sha256, Digest};
use std::convert::Infallible;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

mod scoring;

// Feature modules. Each does `use crate::*;`, so crate-root items (payload
// types, AppState, tier helpers) and every module's pub(crate) items are in
// scope everywhere through these glob imports.
mod migrations;
use migrations::*;
mod auth;
use auth::*;
mod outbound;
use outbound::*;
mod governance;
use governance::*;
mod v1_api;
use v1_api::*;
mod ingest;
use ingest::*;
mod fleet;
use fleet::*;
mod webhooks;
use webhooks::*;
mod stream;
use stream::*;
mod maintenance;
use maintenance::*;
mod catalog;
use catalog::*;
mod alerts;
use alerts::*;
mod energy;
use energy::*;
mod reports;
use reports::*;
mod slo;
use slo::*;
mod billing;
use billing::*;
mod observability;
use observability::*;
mod mcp;
use mcp::*;
#[cfg(test)]
mod tests;

use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use tokio::sync::mpsc;

// ── Shared payload shape — must stay in sync with the agent ──────────────────
//
// IMPORTANT: Every field the agent's MetricsPayload serializes must appear here.
// Serde silently drops unknown fields during deserialization — any field missing
// from this struct is lost before it reaches the in-memory cache and SSE stream.
// The SSE stream serves `entry.metrics` verbatim; the fleet frontend depends on
// receiving every field the agent sends.

/// Per-model live metrics — mirrors agent's ModelLiveMetrics.
#[derive(Deserialize, Serialize, Clone, Default, Debug)]
struct CloudModelLiveMetrics {
    model: String,
    #[serde(default)] size_gb: Option<f32>,
    #[serde(default)] quantization: Option<String>,
    #[serde(default)] vram_mb: Option<u64>,
    #[serde(default)] tok_s: Option<f32>,
    #[serde(default)] avg_ttft_ms: Option<f32>,
    #[serde(default)] avg_latency_ms: Option<f32>,
    #[serde(default)] request_count: u64,
    #[serde(default)] wes: Option<f32>,
}

#[derive(Deserialize, Serialize, Clone)]
struct MetricsPayload {
    node_id:                        String,
    #[serde(default)]
    hostname:                       Option<String>,
    /// Actual deployment profile the agent is running (fleet config mgmt —
    /// injected by cloud_push; compare against nodes.desired_profile).
    #[serde(default)]
    deployment_profile:             Option<String>,
    #[serde(default)]
    gpu_name:                       Option<String>,
    #[serde(default)]
    chip_name:                      Option<String>,
    cpu_usage_percent:              f32,
    total_memory_mb:                u64,
    used_memory_mb:                 u64,
    available_memory_mb:            u64,
    cpu_core_count:                 usize,
    timestamp_ms:                   u64,
    // Apple Silicon deep-metal
    #[serde(default)]
    gpu_wired_limit_mb:             Option<u64>,
    cpu_power_w:                    Option<f32>,
    ecpu_power_w:                   Option<f32>,
    pcpu_power_w:                   Option<f32>,
    /// GPU-only power from powermetrics "GPU Power:" line.
    #[serde(default)]
    apple_gpu_power_w:              Option<f32>,
    /// Total SoC power: Combined Power (CPU + GPU + ANE). Authoritative for WES.
    #[serde(default)]
    apple_soc_power_w:              Option<f32>,
    gpu_utilization_percent:        Option<f32>,
    memory_pressure_percent:        Option<f32>,
    thermal_state:                  Option<String>,
    // NVIDIA
    nvidia_gpu_utilization_percent: Option<f32>,
    nvidia_vram_used_mb:            Option<u64>,
    nvidia_vram_total_mb:           Option<u64>,
    nvidia_gpu_temp_c:              Option<u32>,
    nvidia_power_draw_w:            Option<f32>,
    // Ollama runtime
    #[serde(default)]
    ollama_running:       bool,
    #[serde(default)]
    ollama_active_model:  Option<String>,
    #[serde(default)]
    ollama_model_size_gb: Option<f32>,
    #[serde(default)]
    ollama_quantization:  Option<String>,
    #[serde(default)]
    ollama_tokens_per_second: Option<f32>,
    #[serde(default)]
    ollama_prompt_eval_tps: Option<f32>,
    #[serde(default)]
    ollama_ttft_ms: Option<f32>,
    #[serde(default)]
    ollama_load_duration_ms: Option<f32>,
    /// True when a user request completed within the last 35s (Tier 2 attribution).
    #[serde(default)]
    ollama_inference_active: Option<bool>,
    /// True when the Wicklee transparent proxy is active on :11434.
    #[serde(default)]
    ollama_proxy_active: Option<bool>,
    #[serde(default)]
    ollama_proxy_avg_ttft_ms: Option<f32>,
    #[serde(default)]
    ollama_proxy_avg_latency_ms: Option<f32>,
    #[serde(default)]
    ollama_proxy_request_count: Option<u64>,
    /// Per-model live metrics when multiple models are loaded concurrently.
    #[serde(default)]
    active_models: Option<Vec<CloudModelLiveMetrics>>,
    /// v0.9.0: true when the agent has runtime launch-config snapshots cached
    /// and available via its localhost /api/runtime-config endpoint. Lets the
    /// fleet UI render the "Config" affordance without round-tripping.
    #[serde(default)]
    runtime_config_available: Option<bool>,
    #[serde(default)]
    proxy_listen_port: Option<u16>,
    #[serde(default)]
    proxy_target_port: Option<u16>,
    #[serde(default)]
    runtime_port_overrides: Option<String>,
    /// True during probe and 40s afterward — frontend uses for IDLE-SPD display.
    #[serde(default)]
    ollama_is_probing: Option<bool>,
    // Ollama model architecture (from /api/show) — used for KV cache / context runway math.
    // These were previously dropped on cloud ingestion, causing Max CTX to always show —.
    #[serde(default)]
    ollama_context_length:  Option<u64>,
    #[serde(default)]
    ollama_parameter_count: Option<u64>,
    #[serde(default)]
    ollama_num_layers:      Option<u64>,
    #[serde(default)]
    ollama_kv_heads:        Option<u64>,
    #[serde(default)]
    ollama_num_heads:       Option<u64>,
    #[serde(default)]
    ollama_embedding_dim:   Option<u64>,
    #[serde(default)]
    os: Option<String>,
    /// CPU architecture: "x86_64" | "aarch64".
    #[serde(default)]
    arch: Option<String>,
    // vLLM runtime
    #[serde(default)]
    vllm_running:          bool,
    #[serde(default)]
    vllm_model_name:       Option<String>,
    #[serde(default)]
    vllm_max_model_len:    Option<u64>,
    /// Effective vLLM weight dtype/quant from the agent's process scanner
    /// (canonical tags: AWQ / GPTQ / FP8 / BF16 / ...). Passed through to
    /// the dashboard for weight-size estimation.
    #[serde(default)]
    vllm_dtype:            Option<String>,
    #[serde(default)]
    vllm_tokens_per_sec:   Option<f32>,
    #[serde(default)]
    vllm_cache_usage_perc: Option<f32>,
    #[serde(default)]
    vllm_requests_running: Option<u32>,
    #[serde(default)]
    vllm_requests_waiting: Option<u32>,
    #[serde(default)]
    vllm_requests_swapped: Option<u32>,
    #[serde(default)]
    vllm_avg_ttft_ms: Option<f32>,
    #[serde(default)]
    vllm_avg_e2e_latency_ms: Option<f32>,
    #[serde(default)]
    vllm_avg_queue_time_ms: Option<f32>,
    #[serde(default)]
    vllm_prompt_tokens_total: Option<u64>,
    #[serde(default)]
    vllm_generation_tokens_total: Option<u64>,
    // llama.cpp / llama-box runtime
    #[serde(default)]
    llamacpp_running:          bool,
    #[serde(default)]
    llamacpp_model_name:       Option<String>,
    #[serde(default)]
    llamacpp_tokens_per_sec:   Option<f32>,
    #[serde(default)]
    llamacpp_slots_processing: Option<u32>,
    // ── WES v2 thermal-penalty window ─────────────────────────────────────────
    #[serde(default)]
    penalty_avg:    Option<f32>,
    #[serde(default)]
    penalty_peak:   Option<f32>,
    #[serde(default)]
    thermal_source: Option<String>,
    #[serde(default)]
    sample_count:   Option<u32>,
    #[serde(default)]
    wes_version:    Option<u8>,
    // ── Deep Metal expansion (v0.4.30+) ───────────────────────────────────────
    #[serde(default)]
    swap_write_mb_s:     Option<f32>,
    #[serde(default)]
    clock_throttle_pct:  Option<f32>,
    #[serde(default)]
    pcie_link_width:     Option<u32>,
    #[serde(default)]
    pcie_link_max_width: Option<u32>,
    // ── Per-model WES baseline (v0.7.8+) ───────────────────────────────────────
    #[serde(default)]
    model_baseline_tps:     Option<f32>,
    #[serde(default)]
    model_baseline_wes:     Option<f32>,
    #[serde(default)]
    model_baseline_samples: Option<u32>,
    // ── Agent identity + state (v0.5.10+) ─────────────────────────────────────
    /// Compile-time agent version from Cargo.toml.
    #[serde(default)]
    agent_version:   Option<String>,
    /// Authoritative inference state: "live" | "idle-spd" | "busy" | "idle".
    /// SSOT — fleet frontend must display this directly, never re-derive.
    #[serde(default)]
    inference_state: Option<String>,
    // ── Live Activity events (v0.5.16+) ──────────────────────────────────────
    /// Ephemeral lifecycle events drained from the agent on each broadcast tick.
    /// Persisted to cloud `node_events` for fleet event history.
    #[serde(default)]
    live_activities: Vec<LiveActivityEventPayload>,
    // ── Agent-evaluated observations (v0.7.11+, Phase 7) ────────────────────
    /// Pattern observations evaluated by the agent against its local DuckDB buffer.
    /// Pushed to cloud for fleet dashboard rendering.  Empty for old agents.
    #[serde(default)]
    observations: Vec<AgentObservationPayload>,
}

/// An observation pushed by the agent.  Matches LocalObservation in agent/src/main.rs.
#[derive(Deserialize, Serialize, Clone)]
struct AgentObservationPayload {
    pattern_id:       String,
    severity:         String,
    title:            String,
    hook:             String,
    body:             String,
    recommendation:   String,
    #[serde(default)]
    resolution_steps: Vec<String>,
    action_id:        String,
    confidence:       String,
    #[serde(default)]
    confidence_ratio: f64,
    #[serde(default)]
    first_fired_ms:   i64,
    #[serde(default)]
    node_id:          Option<String>,
    #[serde(default)]
    hostname:         Option<String>,
}

/// A single Live Activity event as received from the agent's telemetry push.
#[derive(Deserialize, Serialize, Clone)]
struct LiveActivityEventPayload {
    message:      String,
    timestamp_ms: u64,
    #[serde(default)]
    level:        String,
    #[serde(default)]
    event_type:   Option<String>,
}

// ── Auth request / response types ────────────────────────────────────────────

#[derive(Deserialize)]
struct SignupRequest {
    email:     String,
    password:  String,
    full_name: String,
}

#[derive(Deserialize)]
struct LoginRequest {
    email:    String,
    password: String,
}

/// Shape that matches the frontend User interface in types.ts.
#[derive(Serialize, Clone)]
struct UserResponse {
    id:        String,
    email:     String,
    #[serde(rename = "fullName")]
    full_name: String,
    role:      String,
    #[serde(rename = "isPro")]
    is_pro:    bool,
}

#[derive(Serialize)]
struct AuthResponse {
    token: String,
    user:  UserResponse,
}

// ── Fleet request / response types ───────────────────────────────────────────

#[derive(Deserialize)]
struct ClaimRequest {
    /// 6-digit code displayed by the agent's --pair flow.
    code:      String,
    /// The agent's reachable local URL, e.g. "http://192.168.1.5:7700".
    fleet_url: String,
    /// WK-XXXX identity assigned by the agent at first run.
    node_id:   String,
}

#[derive(Serialize)]
struct ClaimResponse {
    session_token: String,
    node_id:       String,
}

/// In-memory telemetry snapshot.
#[derive(Clone)]
struct MetricsEntry {
    last_seen_ms: u64,
    metrics:      Option<MetricsPayload>,
    /// When this snapshot was last written to `nodes.last_telemetry_json`
    /// (0 = never). Ingest throttles that JSONB write to SNAPSHOT_PERSIST_MS.
    snapshot_saved_ms: u64,
}

/// One row of derived telemetry ready for Postgres ingest.
/// Built from MetricsPayload on every incoming frame; flushed in 30-second batches.
#[derive(Clone)]
struct MetricsRow {
    node_id:          String,
    ts_ms:            i64,
    tenant_id:        String,           // user_id; set after node lookup
    tok_s:            Option<f32>,
    watts:            Option<f32>,
    wes_raw:          Option<f32>,      // tok_s / watts, no penalty
    wes_penalized:    Option<f32>,      // tok_s / (watts × penalty)
    thermal_cost_pct: Option<f32>,
    thermal_penalty:  Option<f32>,      // 1.0 / 1.25 / 1.75 / 2.0
    thermal_state:    Option<String>,
    vram_used_mb:     Option<i32>,
    vram_total_mb:    Option<i32>,
    mem_pressure_pct: Option<f32>,
    gpu_pct:          Option<f32>,
    cpu_pct:          Option<f32>,
    inference_state:  Option<String>,    // "live" | "idle-spd" | "busy" | "idle"
    wes_version:      u8,               // incremented when WES formula changes
    swap_write:       Option<f32>,      // swap write MB/s — SSD degradation indicator
    ttft_ms:          Option<f32>,      // best-available TTFT (vLLM > proxy > Ollama probe)
    avg_latency_ms:   Option<f32>,      // best-available E2E latency (vLLM > proxy)
    queue_depth:      Option<i32>,      // vLLM requests_waiting
    ollama_active_model: Option<String>, // model name at the moment this row was captured
}

/// A Live Activity event destined for the `node_events` table.
#[derive(Clone)]
struct EventRow {
    ts_ms:      i64,
    node_id:    String,
    tenant_id:  String,
    level:      String,
    event_type: Option<String>,
    message:    String,
}

#[derive(Serialize)]
struct NodeSummary {
    node_id:      String,
    fleet_url:    String,
    last_seen_ms: u64,
    metrics:      Option<MetricsPayload>,
    restricted:   bool,
}

#[derive(Serialize)]
struct FleetResponse {
    nodes: Vec<NodeSummary>,
}

// ── Clerk JWKS types ──────────────────────────────────────────────────────────

/// A single RSA public key from the Clerk JWKS endpoint.
#[derive(Deserialize, Clone)]
struct JwkKey {
    kid: String,
    n:   String,   // base64url modulus
    e:   String,   // base64url exponent
}

#[derive(Deserialize)]
struct JwksResponse {
    keys: Vec<JwkKey>,
}

// ── App state ─────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct AppState {
    /// Postgres connection pool (replaces both SQLite and DuckDB).
    pool:             sqlx::PgPool,
    /// In-memory telemetry cache keyed by node_id.
    metrics:          Arc<RwLock<HashMap<String, MetricsEntry>>>,
    /// Cached Clerk public keys for JWT verification.  Refreshed every 6 h.
    /// Inner Arc: handlers snapshot the set per request with a refcount bump
    /// instead of deep-cloning every key; the refresher swaps the whole Arc.
    clerk_keys:       Arc<RwLock<Arc<Vec<JwkKey>>>>,
    /// Sliding-window rate-limit timestamps keyed by api_key key_id.
    api_rate_limits:  Arc<Mutex<HashMap<String, Vec<u64>>>>,
    /// IP-based rate-limit for auth endpoints (login/signup). 10 requests per 60s.
    auth_rate_limits: Arc<Mutex<HashMap<String, Vec<u64>>>>,
    /// Channel to the metrics writer task.  try_send drops rows if the writer
    /// falls behind; that's acceptable for telemetry.
    metrics_tx:       mpsc::Sender<MetricsRow>,
    /// Channel to the event writer task.  Persists Live Activity events
    /// for the fleet event history endpoint.
    events_tx:        mpsc::Sender<EventRow>,
}

// ── Tier constants ────────────────────────────────────────────────────────────

/// Maximum nodes per tier.
///
/// Team is sold in two sizes since Sept 2026 — `team_10` ($99, up to 10 nodes)
/// and `team` ($200, up to 25). Same features, different cap: the upgrade is
/// "more GPUs", never a feature unlock. `pro` and `business` are retired but
/// still resolve for grandfathered subscriptions.
const MAX_FREE_NODES:     usize = 3;
const MAX_PRO_NODES:      usize = 10;
const MAX_TEAM10_NODES:   usize = 10;
const MAX_TEAM_NODES:     usize = 25;
const MAX_BUSINESS_NODES: usize = 100;

/// The node cap for a tier string. Was copy-pasted as a four-way ladder at
/// three call sites (pairing, node listing, fleet stream); `team_10` would
/// have needed a fourth edit each time. `legacy_is_pro` is the old
/// `users.is_pro` flag / dev-account bypass that only the pairing path honours.
fn node_limit_for_tier(tier: &str, legacy_is_pro: bool) -> usize {
    if tier == "enterprise" { usize::MAX }
    else if is_business_or_above(tier) { MAX_BUSINESS_NODES }
    else if tier == "team_10" { MAX_TEAM10_NODES }
    else if is_team_or_above(tier) { MAX_TEAM_NODES }
    else if legacy_is_pro || is_pro_or_above(tier) { MAX_PRO_NODES }
    else { MAX_FREE_NODES }
}

/// Customer-facing plan name for a tier string (402 messages, logs).
fn plan_name_for_tier(tier: &str) -> &'static str {
    match tier {
        "enterprise" => "Enterprise",
        "business"   => "Business",
        "team"       => "Team (25 nodes)",
        "team_10"    => "Team (10 nodes)",
        "pro"        => "Pro",
        _            => "Community",
    }
}

/// Agent API v1 rate limits (requests per 60-second sliding window).
const API_RATE_COMMUNITY: usize = 60;
const API_RATE_TEAM:      usize = 600;

/// Flap-suppression quiet period after an alert resolves (milliseconds).
const ALERT_QUIET_PERIOD_MS: u64 = 300_000; // 5 minutes

/// Returns true if the account has Team or Enterprise tier (alerting unlocked).
/// Both Team sizes qualify — the size changes the node cap, not the features.
fn is_team_or_above(tier: &str) -> bool {
    matches!(tier, "team_10" | "team" | "business" | "enterprise")
}

fn is_pro_or_above(tier: &str) -> bool {
    matches!(tier, "pro" | "team_10" | "team" | "business" | "enterprise")
}

fn is_business_or_above(tier: &str) -> bool {
    matches!(tier, "business" | "enterprise")
}

/// The plan a tier gate asks the customer to upgrade to. Pro and Business are
/// retired (existing subscribers stay grandfathered via the `is_*_or_above`
/// ladders), so a gate only ever names one of the two plans currently sold:
/// Team for `is_pro_or_above` / `is_team_or_above` gates, Enterprise for
/// `is_business_or_above` gates.
#[derive(Clone, Copy)]
enum UpgradePlan { Team, Enterprise }

/// Uniform paywall response for tier-gated features: 402 Payment Required
/// with `{error, tier_required, upgrade: true}`. The caller keeps its own
/// tier predicate so grandfathered tiers keep working.
fn upgrade_required(feature: &str, plan: UpgradePlan) -> Response {
    let (name, key) = match plan {
        UpgradePlan::Team       => ("Team tier or above", "team"),
        UpgradePlan::Enterprise => ("Enterprise tier", "enterprise"),
    };
    (StatusCode::PAYMENT_REQUIRED, Json(serde_json::json!({
        "error": format!("{feature} requires {name}"),
        "tier_required": key,
        "upgrade": true,
    }))).into_response()
}

/// Pattern-to-tier allowlist. Community sees 9 community patterns + cloud
/// alerts; Pro+ sees all 20 (9 community + 10 Pro agent + 1 Pro cloud).
fn allowed_patterns_for_tier(tier: &str) -> Vec<String> {
    // Cloud alerts (always visible to all tiers)
    let cloud_alerts: Vec<&str> = vec![
        "zombied_engine", "thermal_redline", "oom_warning",
        "wes_cliff", "agent_version_mismatch", "fleet_load_imbalance",
    ];

    // Agent pattern IDs by tier
    let community_patterns: Vec<&str> = vec![
        "thermal_drain", "phantom_load", "swap_io_pressure", "pcie_lane_degradation",
        "wes_velocity_drop", "memory_trajectory", "power_jitter", "clock_drift",
        "vram_overcommit",
    ];
    let pro_patterns: Vec<&str> = vec![
        "power_gpu_decoupling", "bandwidth_saturation", "efficiency_drag",
        "vllm_kv_cache_saturation", "nvidia_thermal_redline",
        "ttft_regression", "latency_spike", "vllm_queue_saturation",
        "bandwidth_ceiling_reached", "wes_long_term_drift",
    ];

    let mut allowed: Vec<String> = cloud_alerts.into_iter().map(String::from).collect();
    allowed.extend(community_patterns.into_iter().map(String::from));
    if is_pro_or_above(tier) {
        allowed.extend(pro_patterns.into_iter().map(String::from));
    }
    allowed
}

/// Nodes not seen within this window are considered offline.
const ONLINE_THRESHOLD_MS: u64 = 30_000;

/// If DEV_ACCOUNT_EMAIL env var is set, that account gets isPro=true and no
/// node limit — useful for internal testing without hitting the free wall.
fn is_dev_account(email: &str) -> bool {
    std::env::var("DEV_ACCOUNT_EMAIL")
        .map(|e| e.trim().to_lowercase() == email.trim().to_lowercase())
        .unwrap_or(false)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn mint_node_token(_node_id: &str) -> String {
    // CSPRNG, not timestamp+node_id. The old `wk_{millis:x}_{node_id}` form
    // was guessable: node_id is not secret and the mint time is narrow, so an
    // attacker who knew a node_id could forge its telemetry token.
    format!("wk_{}", Uuid::new_v4().simple())
}

/// Node session tokens are stored hashed (`sha256:<hex>`), like API keys, so a
/// database read doesn't hand out working telemetry credentials. Tokens
/// minted before hashing are still plaintext rows; ingest accepts them and
/// rewrites them hashed on first use.
fn hash_node_token(token: &str) -> String {
    use sha2::Digest;
    format!("sha256:{}", hex::encode(sha2::Sha256::digest(token.as_bytes())))
}

/// Constant-time check of a presented node token against the stored value.
/// Returns `Some(true)` when the stored value is a legacy plaintext token
/// that should be re-stored hashed.
fn node_token_check(stored: &str, presented: &str) -> Option<bool> {
    use subtle::ConstantTimeEq;
    if stored.starts_with("sha256:") {
        let ok: bool = stored.as_bytes().ct_eq(hash_node_token(presented).as_bytes()).into();
        ok.then_some(false)
    } else {
        let ok: bool = stored.as_bytes().ct_eq(presented.as_bytes()).into();
        ok.then_some(true)
    }
}

fn extract_bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_owned())
}

// ── Agent API v1 helpers ──────────────────────────────────────────────────────

fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    format!("{:x}", h.finalize())
}

fn thermal_penalty_for(state: Option<&str>) -> f32 {
    match state.unwrap_or("Normal") {
        "Fair"     => 1.25,
        "Serious"  => 1.75,
        "Critical" => 2.0,
        _          => 1.0,
    }
}

fn wes_for_payload(m: &MetricsPayload) -> Option<f32> {
    let tok_s = if m.vllm_running {
        m.vllm_tokens_per_sec?
    } else {
        m.ollama_tokens_per_second?
    };
    if tok_s <= 0.0 { return None; }
    // Same power-resolution order as the persistence path
    // (metrics_row_from_payload): NVIDIA → Apple SoC → CPU. Skipping
    // apple_soc_power_w fell back to the CPU-cluster reading on Apple
    // Silicon, inflating live WES (and the wes_drop/thermal alerts built on
    // it) versus the wes_penalized stored for history charts.
    let watts = m.nvidia_power_draw_w.or(m.apple_soc_power_w).or(m.cpu_power_w)?;
    if watts <= 0.0 { return None; }
    let penalty = thermal_penalty_for(m.thermal_state.as_deref());
    let raw = tok_s / (watts * penalty);
    Some((raw * 10.0).round() / 10.0)  // round to 1 decimal place
}

/// Validate a raw API key, enforce the per-key rate limit, and return
/// `(key_id, user_id, org_id, tier)`.
///
/// `org_id` is the key's OWN org column (NULL = personal key) — an org key
/// scopes the V1 API to the org's fleet regardless of which admin minted it.
/// `tier` is resolved through `resolve_tier` (org subscription for org keys,
/// the minting user's otherwise) — the same authority every JWT-side gate
/// uses, replacing the legacy `users.is_pro` flag for rate limiting.
async fn validate_api_key(
    raw_key: &str,
    pool: &sqlx::PgPool,
    rate_limits: &Arc<Mutex<HashMap<String, Vec<u64>>>>,
) -> Option<(String, String, Option<String>, String)> {
    let hash = sha256_hex(raw_key);
    let row = sqlx::query_as::<_, (String, String, Option<String>)>(
        "SELECT key_id, user_id, org_id FROM api_keys WHERE key_hash = $1"
    ).bind(&hash).fetch_one(pool).await.ok()?;

    let (key_id, user_id, org_id) = row;
    let tier = resolve_tier(&user_id, &org_id, pool).await;
    let limit = if tier != "community" { API_RATE_TEAM } else { API_RATE_COMMUNITY };
    let now = now_ms();
    let window_start = now.saturating_sub(60_000);
    {
        let mut rl = rate_limits.lock().unwrap();
        let calls = rl.entry(key_id.clone()).or_default();
        calls.retain(|&t| t >= window_start);
        if calls.len() >= limit {
            return None;
        }
        calls.push(now);
    }

    let _ = sqlx::query("UPDATE api_keys SET last_used_ms = $1 WHERE key_id = $2")
        .bind(now as i64).bind(&key_id)
        .execute(pool).await;

    Some((key_id, user_id, org_id, tier))
}

const AUTH_RATE_LIMIT: usize = 10; // max attempts per 60s per IP

/// How long a 6-digit pairing code stays redeemable after the agent claims it.
/// The agent UI shows a 5-minute countdown; the cloud allows 10 so a code
/// entered at the deadline still works. Codes are single-use (NULLed on
/// activation) — this TTL covers codes that were issued but never redeemed.
const PAIR_CODE_TTL_MS: u64 = 10 * 60_000;

/// IP-based sliding-window rate limiter for auth endpoints.
/// Returns true if the request is allowed, false if rate-limited.
fn check_auth_rate_limit(
    ip: &str,
    rate_limits: &Arc<Mutex<HashMap<String, Vec<u64>>>>,
) -> bool {
    let now = now_ms();
    let window_start = now.saturating_sub(60_000);
    let mut rl = rate_limits.lock().unwrap();
    let calls = rl.entry(ip.to_string()).or_default();
    calls.retain(|&t| t >= window_start);
    if calls.len() >= AUTH_RATE_LIMIT {
        return false;
    }
    calls.push(now);
    true
}

/// Every sliding-window limiter (auth, API key, MCP) uses a 60 s window.
const RATE_LIMIT_WINDOW_MS: u64 = 60_000;

/// Drop rate-limit keys with no call inside the window. The limiters only
/// trim a key's timestamps when that key is hit again, so every distinct IP,
/// API key, or user that ever called kept an entry forever.
fn prune_rate_limits(map: &mut HashMap<String, Vec<u64>>, now: u64) {
    let window_start = now.saturating_sub(RATE_LIMIT_WINDOW_MS);
    map.retain(|_, calls| {
        calls.retain(|&t| t >= window_start);
        !calls.is_empty()
    });
}

/// Unowned claims older than this can never be activated (activate requires
/// `paired_at >= now - PAIR_CODE_TTL_MS`), so they are deleted. The margin
/// keeps the sweep clear of a claim that is mid-activation at the boundary.
const UNOWNED_NODE_TTL_MS: u64 = PAIR_CODE_TTL_MS + 10 * 60_000;

/// Periodic sweep of in-memory maps that otherwise only grow, plus the
/// unowned `nodes` rows behind them. `/api/pair/claim` is unauthenticated, so
/// abandoned or spammed claims left a DB row and a metrics-map entry each,
/// forever. Deleting one is harmless for a still-running agent: its next
/// push gets 410 and it drops back to unpaired (its code expired anyway), and
/// a re-claim recreates the row.
async fn sweep_memory_and_claims(state: &AppState) {
    let now = now_ms();
    prune_rate_limits(&mut state.auth_rate_limits.lock().unwrap(), now);
    prune_rate_limits(&mut state.api_rate_limits.lock().unwrap(), now);

    let cutoff = now.saturating_sub(UNOWNED_NODE_TTL_MS) as i64;
    let removed: Vec<String> = match sqlx::query_scalar(
        "DELETE FROM nodes WHERE user_id IS NULL AND paired_at < $1 RETURNING wk_id"
    ).bind(cutoff).fetch_all(&state.pool).await {
        Ok(ids) => ids,
        Err(e) => { eprintln!("[cleanup] unowned node sweep failed: {e}"); return; }
    };
    if !removed.is_empty() {
        let mut map = state.metrics.write().unwrap();
        for id in &removed { map.remove(id); }
        drop(map);
        println!("[cleanup] removed {} abandoned unowned node claim(s)", removed.len());
    }
}

/// Client IP for rate limiting, from X-Forwarded-For.
///
/// Read from the RIGHT: each proxy appends the address it saw, so the
/// rightmost entries are written by our own infrastructure while everything
/// to their left is whatever the client sent. The old first-entry read let a
/// client pick a fresh "IP" per request and walk straight past the auth rate
/// limiter. `TRUSTED_PROXY_HOPS` (default 1) is how many of our proxies
/// append to the header; the client address is the entry that many from the
/// right.
fn client_ip(headers: &HeaderMap) -> String {
    static HOPS: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let hops = *HOPS.get_or_init(|| {
        std::env::var("TRUSTED_PROXY_HOPS").ok()
            .and_then(|v| v.trim().parse::<usize>().ok())
            .filter(|&n| n >= 1)
            .unwrap_or(1)
    });
    client_ip_from_xff(headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()), hops)
}

fn client_ip_from_xff(xff: Option<&str>, hops: usize) -> String {
    let entries: Vec<&str> = xff.unwrap_or("")
        .split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
    if entries.is_empty() {
        return "unknown".to_string();
    }
    // Fewer entries than hops: the leftmost is still proxy-written.
    entries[entries.len().saturating_sub(hops)].to_string()
}

/// GET /health
async fn handle_health(State(state): State<AppState>) -> impl IntoResponse {
    // Unauthenticated liveness probe (Railway healthcheckPath = /health).
    // Verifies DB connectivity but deliberately exposes NO platform stats —
    // an earlier version returned fleet-wide metrics_raw row counts and the
    // open-observation count, leaking total fleet size and activity to anyone.
    let db_ok = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.pool).await.is_ok();

    let status = if db_ok { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
    if is_self_hosted() {
        // Deployment config only — still no platform stats.
        return (status, Json(serde_json::json!({
            "status": if db_ok { "ok" } else { "degraded" },
            "self_hosted": true,
            "licensed": std::env::var("WICKLEE_LICENSE_KEY").map(|k| !k.trim().is_empty()).unwrap_or(false),
        }))).into_response();
    }
    (status, Json(serde_json::json!({
        "status": if db_ok { "ok" } else { "degraded" },
    }))).into_response()
}

/// GET /api/agent/version
async fn handle_agent_version(
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let platform = params.get("platform").cloned().unwrap_or_default();

    let asset_name = match platform.as_str() {
        "darwin-aarch64"      => "wicklee-agent-darwin-aarch64",
        "linux-x86_64"        => "wicklee-agent-linux-x86_64",
        "linux-aarch64"       => "wicklee-agent-linux-aarch64",
        "linux-x86_64-nvidia" => "wicklee-agent-linux-x86_64-nvidia",
        "windows-x86_64"      => "wicklee-agent-windows-x86_64.exe",
        _ => return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "unrecognised platform" }))).into_response(),
    };

    let result = tokio::task::spawn_blocking(move || -> Result<(String, String), String> {
        let resp = HTTP_AGENT.get("https://api.github.com/repos/jeffgeiser/Wicklee/releases/latest")
            .set("User-Agent", "wicklee-cloud/1.0")
            .set("Accept", "application/vnd.github+json")
            .call()
            .map_err(|e| format!("github api request failed: {e}"))?;
        let body: serde_json::Value = resp.into_json()
            .map_err(|e| format!("github api json parse failed: {e}"))?;
        let tag = body["tag_name"].as_str()
            .ok_or_else(|| "missing tag_name".to_string())?.to_string();
        let download_url = format!("https://github.com/jeffgeiser/Wicklee/releases/download/{tag}/{asset_name}");
        Ok((tag, download_url))
    }).await;

    match result {
        Ok(Ok((latest, download_url))) => (StatusCode::OK,
            Json(serde_json::json!({ "latest": latest, "download_url": download_url }))).into_response(),
        Ok(Err(e)) => {
            eprintln!("[agent-version] upstream error: {e}");
            (StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "error": "could not fetch latest release" }))).into_response()
        }
        Err(e) => {
            eprintln!("[agent-version] task error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "internal error" }))).into_response()
        }
    }
}

// ── CORS middleware ───────────────────────────────────────────────────────────

/// Restrictive CORS for dashboard routes — only wicklee.dev and localhost dev server.
async fn cors_dashboard(req: Request<Body>, next: Next) -> Response {
    let origin = req.headers().get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let allowed = matches!(origin.as_str(),
        "https://wicklee.dev" | "http://localhost:3000" | "http://localhost:5173"
    );
    let allow_origin = if allowed { origin.as_str() } else { "https://wicklee.dev" };
    let origin_owned = allow_origin.to_string();

    if req.method() == Method::OPTIONS {
        return (
            StatusCode::OK,
            [
                (header::ACCESS_CONTROL_ALLOW_ORIGIN,  origin_owned.as_str()),
                (header::ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, PATCH, DELETE, OPTIONS"),
                (header::ACCESS_CONTROL_ALLOW_HEADERS, "content-type, authorization"),
            ],
        ).into_response();
    }

    let mut res = next.run(req).await;
    if let Ok(v) = header::HeaderValue::from_str(&origin_owned) {
        res.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
    }
    res
}

/// Permissive CORS for v1 API routes (external consumers) and agent endpoints.
async fn cors_open(req: Request<Body>, next: Next) -> Response {
    if req.method() == Method::OPTIONS {
        return (
            StatusCode::OK,
            [
                (header::ACCESS_CONTROL_ALLOW_ORIGIN,  "*"),
                (header::ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, DELETE, OPTIONS"),
                (header::ACCESS_CONTROL_ALLOW_HEADERS, "content-type, authorization, x-api-key"),
            ],
        ).into_response();
    }

    let mut res = next.run(req).await;
    res.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN,
        header::HeaderValue::from_static("*"));
    res
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    // Connect to Postgres. DATABASE_URL must be set.
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL env var must be set (e.g. postgres://user:pass@host/db)");

    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(20)
        .connect(&database_url)
        .await
        .expect("Cannot connect to Postgres");

    println!("  PG  \u{2192} connected");

    run_pg_migrations(&pool).await;

    // RESET_NODES (a "one-shot" DELETE FROM nodes that in fact ran on every
    // boot while the variable stayed set) was removed. Purge by hand in SQL.
    if std::env::var("RESET_NODES").is_ok() {
        eprintln!("  RESET_NODES is set but no longer does anything \u{2014} unset it.");
    }

    // Pre-load known nodes. If last_telemetry_json is available, seed the in-memory cache.
    let seed_metrics: HashMap<String, MetricsEntry> = {
        let rows: Vec<(String, i64, Option<serde_json::Value>)> = sqlx::query_as(
            "SELECT wk_id, last_seen, last_telemetry_json FROM nodes"
        ).fetch_all(&pool).await.unwrap_or_default();
        rows.into_iter()
            .map(|(node_id, last_seen, json_opt)| {
                let metrics = json_opt.and_then(|j| serde_json::from_value::<MetricsPayload>(j).ok());
                (node_id, MetricsEntry { last_seen_ms: last_seen as u64, metrics, snapshot_saved_ms: 0 })
            })
            .collect()
    };

    // Fetch Clerk JWKS on startup.
    let jwks_url = std::env::var("CLERK_JWKS_URL").ok();
    let initial_keys = if let Some(ref url) = jwks_url {
        let url2 = url.clone();
        tokio::task::spawn_blocking(move || fetch_jwks(&url2)).await.unwrap_or_default()
    } else {
        eprintln!("[jwks] CLERK_JWKS_URL not set \u{2014} Clerk JWT auth disabled");
        vec![]
    };
    if !initial_keys.is_empty() {
        println!("  JWKS \u{2192} {} key(s) loaded", initial_keys.len());
    }
    let clerk_keys = Arc::new(RwLock::new(Arc::new(initial_keys)));

    let (metrics_tx, metrics_rx) = mpsc::channel::<MetricsRow>(8_192);
    let (events_tx,  events_rx)  = mpsc::channel::<EventRow>(1_024);

    let state = AppState {
        pool:            pool.clone(),
        metrics:         Arc::new(RwLock::new(seed_metrics)),
        clerk_keys:      clerk_keys.clone(),
        api_rate_limits:  Arc::new(Mutex::new(HashMap::new())),
        auth_rate_limits: Arc::new(Mutex::new(HashMap::new())),
        metrics_tx,
        events_tx,
    };

    // Spawn background tasks.
    tokio::spawn(metrics_writer_task(metrics_rx, pool.clone()));
    tokio::spawn(events_writer_task(events_rx, pool.clone()));
    tokio::spawn(rollup_task(pool.clone()));
    tokio::spawn(nightly_task(pool.clone()));
    // Populate model_catalog on startup so fleet discovery works immediately
    // after a fresh Railway deploy (nightly task only runs at 3 AM UTC).
    // Always runs — schema/aggregation logic can change between deploys, and the
    // refresh loop wipes per-repo rows before re-inserting (DELETE + INSERT).
    tokio::spawn({
        let pool2 = pool.clone();
        async move {
            // Short delay so the server is fully up before hitting HF.
            tokio::time::sleep(Duration::from_secs(5)).await;
            let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM model_catalog")
                .fetch_one(&pool2).await.unwrap_or(0);
            eprintln!("[startup] model_catalog has {existing} entries — running refresh to apply latest aggregation logic");
            let inserted = refresh_cloud_model_catalog(&pool2).await;
            // Retry if no rows were written (HF rate-limit or pool contention at startup).
            if inserted == 0 {
                eprintln!("[startup] 0 variants written — retrying catalog fetch in 90s");
                tokio::time::sleep(Duration::from_secs(90)).await;
                refresh_cloud_model_catalog(&pool2).await;
            }
        }
    });
    tokio::spawn(node_offline_alert_task(state.clone()));
    tokio::spawn(fleet_alert_evaluator_task(state.clone()));
    tokio::spawn(wes_long_term_drift_evaluator_task(state.clone()));
    tokio::spawn(audit_drain_task(pool.clone()));
    tokio::spawn(slo_evaluator_task(pool.clone()));
    tokio::spawn(idle_digest_task(pool.clone()));
    tokio::spawn(otel_exporter_task(state.clone()));

    // Self-hosted control plane: announce mode + license state at boot.
    if is_self_hosted() {
        match std::env::var("WICKLEE_LICENSE_KEY").ok().filter(|k| !k.trim().is_empty()) {
            Some(key) => {
                let tail: String = key.chars().rev().take(4).collect::<String>().chars().rev().collect();
                println!("[self-hosted] control plane licensed (key …{tail}) — all tenants resolve to enterprise tier");
            }
            None => {
                println!("[self-hosted] EVALUATION MODE — no WICKLEE_LICENSE_KEY set.");
                println!("[self-hosted] Production self-hosting requires an Enterprise license: sales@wicklee.dev");
            }
        }
    }

    // Refresh JWKS every 6 hours.
    if let Some(url) = jwks_url {
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
                let url2 = url.clone();
                let new_keys = tokio::task::spawn_blocking(move || fetch_jwks(&url2))
                    .await.unwrap_or_default();
                if !new_keys.is_empty() {
                    *clerk_keys.write().unwrap() = Arc::new(new_keys);
                    println!("[jwks] refreshed");
                }
            }
        });
    }

    // Purge expired stream tokens, stale rate-limit keys, and abandoned
    // pairing claims every 5 minutes.
    let state_cleanup = state.clone();
    tokio::spawn(async move {
        let pool_cleanup = state_cleanup.pool.clone();
        loop {
            tokio::time::sleep(Duration::from_secs(300)).await;
            let now = now_ms() as i64;
            let _ = sqlx::query("DELETE FROM stream_tokens WHERE expires_ms < $1")
                .bind(now).execute(&pool_cleanup).await;
            let _ = sqlx::query("DELETE FROM sessions WHERE created_at < $1")
                .bind(legacy_session_cutoff()).execute(&pool_cleanup).await;
            sweep_memory_and_claims(&state_cleanup).await;
        }
    });

    // Dashboard routes — restrictive CORS (wicklee.dev + localhost dev only).
    let dashboard_routes = Router::new()
        .route("/api/auth/signup",       post(handle_signup))
        .route("/api/auth/login",        post(handle_login))
        .route("/api/auth/me",           get(handle_me))
        .route("/api/auth/stream-token", get(handle_stream_token).delete(handle_revoke_stream_tokens))
        .route("/api/pair/claim",    post(handle_claim))
        .route("/api/pair/activate", post(handle_activate))
        .route("/api/nodes/:node_id",     delete(handle_delete_node))
        .route("/api/fleet",              get(handle_fleet))
        .route("/api/fleet/stream",       get(handle_fleet_stream))
        .route("/api/fleet/wes-history",          get(handle_wes_history))
        .route("/api/v1/thermal-budget",          get(handle_thermal_budget))
        .route("/api/v1/webhooks",                axum::routing::post(handle_webhook_create))
        .route("/api/v1/webhooks",                get(handle_webhook_list))
        .route("/api/v1/webhooks/:id",            axum::routing::delete(handle_webhook_delete))
        .route("/api/v1/webhooks/:id/test",       axum::routing::post(handle_webhook_test))
        .route("/api/fleet/metrics-history",      get(handle_metrics_history))
        .route("/api/fleet/duty",                 get(handle_fleet_duty))
        .route("/api/fleet/events/history",       get(handle_fleet_events_history))
        .route("/api/fleet/export",               get(handle_fleet_export))
        .route("/api/fleet/model-candidates",     get(handle_fleet_model_candidates))
        .route("/api/v1/fleet/model-comparison",  get(handle_fleet_model_comparison))
        .route("/api/v1/fleet/model-switches",    get(handle_fleet_model_switches))
        .route("/api/v1/fleet/cost-by-model",     get(handle_fleet_cost_by_model))
        .route("/api/fleet/observations",            get(handle_fleet_observations).post(handle_submit_observation))
        .route("/api/fleet/observations/:id/acknowledge", post(handle_acknowledge_observation))
        .route("/api/fleet/observations/:id/resolve",     post(handle_resolve_observation))
        .route("/api/alerts/channels",          post(handle_create_channel))
        .route("/api/alerts/channels",          get(handle_list_channels))
        .route("/api/alerts/channels/:id",      delete(handle_delete_channel))
        .route("/api/alerts/channels/:id/test", post(handle_test_channel))
        .route("/api/alerts/rules",             post(handle_create_rule))
        .route("/api/alerts/rules",             get(handle_list_rules))
        .route("/api/alerts/rules/:id",         delete(handle_delete_rule))
        .route("/api/alerts/silences",          post(handle_create_silence).get(handle_list_silences))
        .route("/api/alerts/silences/:id",      delete(handle_delete_silence))
        .route("/api/fleet/config",             post(handle_fleet_config_apply))
        .route("/api/v1/fleet/chargeback",      get(handle_fleet_chargeback))
        .route("/api/v1/fleet/idle-waste",      get(handle_idle_waste))
        .route("/api/digest",                   get(handle_get_digest).put(handle_put_digest))
        .route("/api/v1/fleet/capacity",           get(handle_fleet_capacity))
        .route("/api/v1/fleet/migration-advisor",  get(handle_migration_advisor))
        .route("/api/slo",                      post(handle_create_slo).get(handle_list_slos))
        .route("/api/slo/:id",                  delete(handle_delete_slo))
        .route("/api/nodes/:node_id",    patch(handle_update_node))
        .route("/api/billing/config",    get(handle_billing_config))
        .route("/api/billing/status",    get(handle_billing_status)) // public — no auth
        .route("/api/webhooks/paddle",   post(handle_paddle_webhook))
        .route("/api/otel/config",       get(handle_get_otel_config).put(handle_put_otel_config))
        .route("/api/audit-log",         get(handle_audit_log))
        .route("/api/audit-log/export",  get(handle_audit_log_export))
        .route("/api/audit-log/drain",   get(handle_get_audit_drain).put(handle_put_audit_drain).delete(handle_delete_audit_drain))
        // Model governance (Enterprise). Violations are listed on a distinct
        // path registered BEFORE the :id delete route so it can't be captured
        // as an id.
        .route("/api/model-policy/violations", get(handle_model_policy_violations))
        .route("/api/model-policy",            get(handle_model_policy_list).post(handle_model_policy_create))
        // ":id", not "{id}" — axum 0.7 path-parameter syntax. Braces are a
        // LITERAL segment in 0.7, so "{id}" silently matched nothing.
        .route("/api/model-policy/:id",        axum::routing::delete(handle_model_policy_delete))
        .with_state(state.clone())
        .layer(middleware::from_fn(cors_dashboard));

    // Open routes — permissive CORS. V1 API (external consumers), agent telemetry, health.
    let open_routes = Router::new()
        .route("/health",                  get(handle_health))
        .route("/api/agent/version",       get(handle_agent_version))
        .route("/api/telemetry",           post(handle_telemetry))
        .route("/api/telemetry/install",   post(handle_install_telemetry))
        .route("/api/events/poll",         get(handle_event_poll))
        .route("/api/v1/keys",           post(handle_v1_create_key))
        .route("/api/v1/keys",           get(handle_v1_list_keys))
        .route("/api/v1/keys/:key_id",   delete(handle_v1_delete_key))
        .route("/api/v1/fleet",          get(handle_v1_fleet))
        .route("/api/v1/fleet/wes",      get(handle_v1_fleet_wes))
        .route("/api/v1/nodes/:id",      get(handle_v1_node))
        .route("/api/v1/route/best",     get(handle_v1_route_best))
        .route("/api/v1/insights/latest", get(handle_v1_insights_latest))
        .route("/api/v1/models/discover", get(handle_v1_models_discover))
        .route("/mcp",                      post(handle_cloud_mcp))
        .route("/mcp/manifest",             get(handle_cloud_mcp_manifest))
        .route("/metrics",                  get(handle_prometheus_metrics))
        .with_state(state)
        .layer(middleware::from_fn(cors_open));

    let app = dashboard_routes.merge(open_routes)
        .layer(axum::extract::DefaultBodyLimit::max(2 * 1024 * 1024)); // 2 MB global limit

    let port: u16 = std::env::var("PORT")
        .ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    let addr = format!("0.0.0.0:{port}");

    let listener = tokio::net::TcpListener::bind(&addr).await.expect("Failed to bind");

    println!("  Wicklee Cloud — Postgres listening on {addr}");

    axum::serve(listener, app).await.expect("Server exited unexpectedly");
}

#[cfg(test)]
mod route_syntax_tests {
    /// Every `.route("…")` path must use axum 0.7's `:param` syntax.
    ///
    /// axum 0.8 switched to `{param}`, and in 0.7 braces are just literal
    /// characters — so a `{id}` path compiles, passes every unit test, and then
    /// matches nothing at runtime. `/api/model-policy/{id}` shipped exactly that
    /// way: the handler was unreachable and DELETE returned 404 for every real
    /// id. Nothing else in the suite exercises the router, so this scans the
    /// source instead.
    ///
    /// If axum is upgraded to 0.8+, invert this assertion rather than deleting
    /// it — the same class of silent breakage exists in the other direction.
    #[test]
    fn route_paths_use_axum_07_param_syntax() {
        let src = include_str!("main.rs");
        let mut offenders = Vec::new();
        for line in src.lines() {
            let t = line.trim_start();
            let Some(rest) = t.strip_prefix(".route(\"") else { continue };
            let Some(end) = rest.find('"') else { continue };
            let path = &rest[..end];
            if path.contains('{') || path.contains('}') {
                offenders.push(path.to_string());
            }
        }
        assert!(
            offenders.is_empty(),
            "axum 0.7 uses :param, not {{param}} — these paths match nothing at runtime: {offenders:?}"
        );
    }

    /// Guard the assumption the test above depends on.
    #[test]
    fn axum_is_still_0_7() {
        let toml = include_str!("../Cargo.toml");
        let line = toml.lines().find(|l| l.trim_start().starts_with("axum"))
            .expect("axum dependency not found in Cargo.toml");
        assert!(
            line.contains("0.7"),
            "axum version changed ({line}) — revisit route param syntax and the test above"
        );
    }
}

#[cfg(test)]
mod tier_gate_tests {
    use super::*;

    async fn body(r: Response) -> serde_json::Value {
        let b = axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&b).unwrap()
    }

    #[tokio::test]
    async fn upgrade_required_is_a_uniform_402() {
        let r = upgrade_required("Alerting", UpgradePlan::Team);
        assert_eq!(r.status(), StatusCode::PAYMENT_REQUIRED);
        let j = body(r).await;
        assert_eq!(j["error"], "Alerting requires Team tier or above");
        assert_eq!(j["tier_required"], "team");
        assert_eq!(j["upgrade"], true);

        let r = upgrade_required("Audit logging", UpgradePlan::Enterprise);
        assert_eq!(r.status(), StatusCode::PAYMENT_REQUIRED);
        let j = body(r).await;
        assert_eq!(j["error"], "Audit logging requires Enterprise tier");
        assert_eq!(j["tier_required"], "enterprise");
    }
}
