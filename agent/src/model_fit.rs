//! Model discovery & hardware fit: GGUF catalog types, fit scoring, HuggingFace catalog fetch, model candidates.
//! Split out of main.rs; items are pub(crate) and re-exported at the crate root.

use super::*;

// ── Model Discovery & Hardware Fit ────────────────────────────────────────────

/// A GGUF model variant from the HuggingFace catalog.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct CatalogVariant {
    pub(crate) filename: String,
    pub(crate) quant_level: String,
    pub(crate) file_size_bytes: u64,
}

/// Hardware profile for fit scoring — either live or simulated.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct HardwareProfile {
    pub(crate) vram_mb: u64,
    pub(crate) chip_name: Option<String>,
    pub(crate) power_budget_w: f32,
    pub(crate) thermal_state: String,
}

/// Result of scoring a single model variant against hardware.
#[derive(Serialize, Clone, Debug)]
pub(crate) struct FitResult {
    pub(crate) model_id: String,
    pub(crate) quant_level: String,
    pub(crate) file_size_mb: u64,
    pub(crate) vram_required_mb: u64,
    pub(crate) vram_available_mb: u64,
    pub(crate) vram_headroom_pct: f32,
    pub(crate) fit_score: u8,
    pub(crate) fit_label: String,
    pub(crate) estimated_wes: Option<f32>,
    pub(crate) recommendation: String,
}

/// Pure function: score a model variant against a hardware profile.
/// Returns 0-100 fit score with human-readable label and recommendation.
pub(crate) fn score_fit(
    model_id: &str,
    variant: &CatalogVariant,
    hw: &HardwareProfile,
    historical_wes: Option<f32>,
) -> FitResult {
    // All component math lives in the shared scoring module (mirrored
    // agent<->cloud by scripts/sync-scoring.mjs) so both dashboards grade
    // identically. This wrapper only adds the recommendation strings.
    let fit = scoring::fit_components(
        variant.file_size_bytes,
        hw.vram_mb,
        &hw.thermal_state,
        historical_wes,
    );
    let vram_required = fit.vram_required_mb;
    let vram_available = hw.vram_mb;
    let headroom_pct = fit.headroom_pct;
    let total = fit.total;

    let label = fit.label.to_string();
    let recommendation: String = match fit.label {
        "Won't Fit" => format!(
            "Requires {}G VRAM, you have {}G. Try a smaller quantization or a lower parameter model.",
            vram_required / 1024, vram_available / 1024
        ),
        "Excellent" => "Runs comfortably with headroom for context scaling.".into(),
        "Good"      => "Fits well. Monitor VRAM under long-context workloads.".into(),
        "Tight"     => "Will run but may thermal throttle under sustained load. Consider a lower quantization.".into(),
        _           => "Barely fits. Expect swap pressure and reduced throughput.".into(),
    };

    FitResult {
        model_id: model_id.to_string(),
        quant_level: variant.quant_level.clone(),
        file_size_mb: variant.file_size_bytes / (1024 * 1024),
        vram_required_mb: vram_required,
        vram_available_mb: vram_available,
        vram_headroom_pct: (headroom_pct * 10.0).round() / 10.0,
        fit_score: total,
        fit_label: label,
        estimated_wes: historical_wes,
        recommendation,
    }
}

/// Extract quant level from a GGUF filename.
/// Handles both dot-separated ("llama-2-7b.Q4_K_M.gguf") and
/// dash-separated ("gemma-4-26B-A4B-it-Q8_0.gguf", "model-UD-IQ3_S.gguf") patterns.
pub(crate) fn parse_quant_from_filename(filename: &str) -> Option<String> {
    let stem = filename.strip_suffix(".gguf")?;

    // Strategy: scan all segments (split by '.' and '-') for a token that looks like a quant level.
    // Check dot-separated segments first (higher priority), then dash-separated.
    let is_quant = |s: &str| -> bool {
        let u = s.to_ascii_uppercase();
        u.starts_with('Q') || u.starts_with("IQ") || u.starts_with('F') || u.starts_with("BF") || u.starts_with("MXFP")
    };

    // Try dot-separated: model.Q4_K_M
    for seg in stem.rsplit('.') {
        if is_quant(seg) { return Some(seg.to_ascii_uppercase()); }
    }

    // Try dash-separated: model-Q4_K_M or model-UD-IQ3_S
    // Walk from the end to find the quant token — may be preceded by "UD-" prefix
    let parts: Vec<&str> = stem.rsplit('-').collect();
    for (i, seg) in parts.iter().enumerate() {
        if is_quant(seg) {
            // Check if preceded by "UD" (ultra-dense) prefix: "UD-IQ3_S" → "UD-IQ3_S"
            let q = seg.to_ascii_uppercase();
            if i + 1 < parts.len() && parts[i + 1].eq_ignore_ascii_case("UD") {
                return Some(format!("UD-{q}"));
            }
            return Some(q);
        }
    }

    None
}

/// Returns true when this GGUF filename is an auxiliary file the catalog
/// should drop — multimodal projector, tokenizer-only, control vector,
/// imatrix calibration, LoRA adapter, draft model for speculative decoding.
///
/// Symptom this filter prevents: DavidAU's Qwen3.6-27B-Heretic repo
/// publishes a small auxiliary GGUF (~1.7 GB) alongside the actual
/// quantized 27B variants. Without this filter the small file gets
/// picked as the "best fit" because it trivially fits the VRAM budget —
/// every model in the repo shows up as "F32 · 1.7 GB · Excellent" no
/// matter the actual parameter count. Match cloud's parallel filter at
/// cloud/src/main.rs ~line 4609.
pub(crate) fn is_auxiliary_gguf(filename: &str) -> bool {
    let lower = filename.to_lowercase();
    lower.contains("mmproj")
        || lower.contains("projector")
        || lower.contains("imatrix")
        || lower.starts_with("tokenizer")
        || lower.contains(".draft.")
        || lower.contains("-draft-")
        || lower.contains("lora")
        || lower.contains("adapter")
        || lower.contains("control-vector")
        || lower.contains("embedding-only")
}

/// Fetch GGUF models from HuggingFace using `?full=true` to get file sizes in one call.
// Validates HuggingFace model IDs against the expected `owner/name` format.
// Blocks shell-injectable characters from appearing in constructed pull commands.
pub(crate) fn valid_hf_model_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 200 { return false; }
    let mut parts = id.splitn(2, '/');
    let (Some(owner), Some(name), true) = (parts.next(), parts.next(), true) else { return false; };
    let safe = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.');
    safe(owner) && safe(name)
}

// Percent-encodes a search term for use as a URL query parameter value.
pub(crate) fn pct_encode_query(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => {
                const HEX: &[u8; 16] = b"0123456789ABCDEF";
                out.push('%');
                out.push(HEX[(b >> 4) as usize] as char);
                out.push(HEX[(b & 0x0F) as usize] as char);
            }
        }
    }
    out
}

pub(crate) static HF_LAST_FETCH: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);

/// Returns (model_id, downloads, likes, variants: [(filename, quant_level, file_size_bytes)]).
#[cfg(not(target_env = "musl"))]
pub(crate) async fn fetch_hf_gguf(
    search: Option<&str>,
    limit: usize,
) -> Vec<(String, u64, u64, Vec<(String, String, u64)>)> {
    // Rate-limit HF fetches to 1 per second to avoid server-side IP bans.
    let delay = {
        let mut guard = HF_LAST_FETCH.lock().unwrap();
        let now = std::time::Instant::now();
        let d = guard.map(|t| {
            let since = now.saturating_duration_since(t);
            if since < Duration::from_secs(1) { Duration::from_secs(1) - since } else { Duration::ZERO }
        }).unwrap_or(Duration::ZERO);
        *guard = Some(now + d);
        d
    };
    if !delay.is_zero() { tokio::time::sleep(delay).await; }

    // Step 1: fetch model list (no full=true — HF never included size in siblings).
    let list_url = if let Some(term) = search {
        format!(
            "https://huggingface.co/api/models?filter=gguf&sort=downloads&direction=-1&limit={limit}&search={}",
            pct_encode_query(term)
        )
    } else {
        format!("https://huggingface.co/api/models?filter=gguf&sort=downloads&direction=-1&limit={limit}")
    };

    let hf_token = std::env::var("HUGGINGFACE_TOKEN").ok();
    let client = reqwest::Client::builder().timeout(Duration::from_secs(30)).build().unwrap_or_default();

    let mut list_req = client.get(&list_url);
    if let Some(ref tok) = hf_token { list_req = list_req.bearer_auth(tok.clone()); }
    let list_resp = match list_req.send().await {
        Ok(r) => r,
        Err(e) => { eprintln!("[model-discovery] HF list failed: {e}"); return Vec::new(); }
    };
    let model_list: Vec<serde_json::Value> = list_resp.json().await.unwrap_or_default();

    // Step 2: for each model, fetch /api/models/{id}/tree/main to get actual file sizes.
    // Tuple shape: (model_id, downloads, likes, variants[]).
    let mut results: Vec<(String, u64, u64, Vec<(String, String, u64)>)> = Vec::new();
    for model in &model_list {
        let model_id = model["id"].as_str().unwrap_or("");
        if !valid_hf_model_id(model_id) { continue; }
        let downloads = model["downloads"].as_u64().unwrap_or(0);
        let likes     = model["likes"].as_u64().unwrap_or(0);

        let tree_url = format!("https://huggingface.co/api/models/{model_id}/tree/main");
        let mut tree_req = client.get(&tree_url);
        if let Some(ref tok) = hf_token { tree_req = tree_req.bearer_auth(tok.clone()); }
        let tree_resp = match tree_req.send().await {
            Ok(r) => r,
            Err(e) => { eprintln!("[model-discovery] tree fetch failed for {model_id}: {e}"); continue; }
        };
        let files: Vec<serde_json::Value> = tree_resp.json().await.unwrap_or_default();

        // Variant filtering pipeline (mirrors cloud at cloud/src/main.rs:4609):
        //   1. .gguf extension + non-zero size
        //   2. Drop auxiliary GGUFs (mmproj/lora/projector/tokenizer/etc)
        //   3. Drop variants whose size is implausible for the declared
        //      quant — e.g. a "F32 · 1.7 GB" entry on a 27B model is
        //      almost certainly an embedding-only export mislabeled by
        //      the filename parser. Without this filter, those tiny files
        //      score "Excellent fit" because they trivially fit VRAM,
        //      then surface as the "best variant" — surfacing wrong-model
        //      data to the UI.
        let params_b = scoring::extract_params_b(model_id);
        let mut variants: Vec<(String, String, u64)> = Vec::new();
        for file in &files {
            let path = file["path"].as_str().unwrap_or("");
            if !path.ends_with(".gguf") { continue; }
            let size = file["size"].as_u64().unwrap_or(0);
            if size == 0 { continue; }
            let filename = path.rsplit('/').next().unwrap_or(path);
            if is_auxiliary_gguf(filename) { continue; }
            let quant = parse_quant_from_filename(filename).unwrap_or_else(|| "unknown".to_string());
            if !scoring::is_plausible_size_for_quant(params_b, &quant, size) { continue; }
            variants.push((filename.to_string(), quant, size));
        }
        // Sort variants largest-first (highest quality first)
        variants.sort_by_key(|a| std::cmp::Reverse(a.2));

        if !variants.is_empty() {
            results.push((model_id.to_string(), downloads, likes, variants));
        }

        // Brief pause between tree requests to be polite to HF
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    results
}

/// Fetch GGUF model catalog from HuggingFace and cache to DuckDB.
/// Called on first /api/model-candidates request if cache is stale, and by a 24h background task.
#[cfg(not(target_env = "musl"))]
pub(crate) async fn refresh_model_catalog(store: store::Store) {
    // 200 keeps the trending catalog broad enough that fleets with mixed
    // VRAM (e.g. a 64 GB Mac alongside an 8 GB Pi) still see plenty of
    // models even after per-node fit filtering. The /tree/main fan-out is
    // rate-limited to 1 req/sec server-side, so this refresh takes ~3–4
    // minutes — fine for a 24h background task, not on the request path.
    // Catalog cache size — tuned 200 → 100 after observing the larger limit
    // pulled in low-quality fine-tunes that crowded out useful results
    // without proportional UX benefit. 100 is ~3x more than the original
    // cap of 30 and refreshes in ~20s at 5-in-flight serial fetch.
    let models = fetch_hf_gguf(None, 100).await;
    if models.is_empty() { return; }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    let mut entries: Vec<(String, String, String, u64, u64, u64, i64)> = Vec::new();
    let models_count = models.len();

    for (model_id, downloads, likes, variants) in &models {
        for (filename, quant, file_size) in variants {
            entries.push((model_id.clone(), filename.clone(), quant.clone(), *file_size, *downloads, *likes, now));
        }
    }

    let count = entries.len();
    if let Err(e) = tokio::task::spawn_blocking(move || store.write_catalog(&entries)).await.unwrap_or(Err(duckdb::Error::InvalidQuery)) {
        eprintln!("[model-discovery] cache write failed: {e}");
    } else {
        println!("[model-discovery] cached {count} GGUF variants from {models_count} repos");
    }
}

/// GET /api/model-candidates — discover GGUF models that fit this hardware.
/// Query params: ?search=llama&limit=20
/// When search is provided, fetches live from HuggingFace (bypasses cache).
/// When no search, returns the cached trending catalog (default limit 20).
#[cfg(not(target_env = "musl"))]
pub(crate) async fn handle_model_candidates(
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
    axum::extract::Extension(store): axum::extract::Extension<store::Store>,
    axum::extract::Extension(node_id_ext): axum::extract::Extension<NodeId>,
    axum::extract::Extension(apple_m): axum::extract::Extension<Arc<Mutex<AppleSiliconMetrics>>>,
    axum::extract::Extension(nvidia_m): axum::extract::Extension<Arc<Mutex<NvidiaMetrics>>>,
    axum::extract::Extension(wes_m): axum::extract::Extension<Arc<Mutex<WesMetrics>>>,
) -> impl IntoResponse {
    let search = params.get("search").filter(|s| !s.trim().is_empty()).cloned();
    let limit: usize = params.get("limit").and_then(|v| v.parse().ok()).unwrap_or(20).min(200);

    // Build hardware profile from live metrics
    let apple = apple_m.lock().map(|g| g.clone()).unwrap_or_default();
    let nvidia = nvidia_m.lock().map(|g| g.clone()).unwrap_or_default();
    let wes   = wes_m.lock().map(|g| g.clone()).unwrap_or_default();

    let gpu_vram = nvidia.nvidia_vram_total_mb.unwrap_or(0)
        .max(apple.gpu_wired_limit_mb.unwrap_or(0));

    // Fallback for CPU-only nodes: use 75% of system RAM as the model budget
    let vram_mb = if gpu_vram == 0 {
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        (sys.total_memory() / 1024 / 1024) * 3 / 4
    } else {
        gpu_vram
    };

    let power_w = apple.soc_power_w.or(nvidia.nvidia_power_draw_w).unwrap_or(0.0);
    let penalty  = wes.penalty_avg.unwrap_or(1.0);
    let thermal  = if penalty < 1.1 { "Normal" } else if penalty < 1.3 { "Fair" } else if penalty < 1.8 { "Serious" } else { "Critical" };
    let chip     = apple.gpu_name.clone().or(nvidia.nvidia_gpu_name.clone());

    let hw = HardwareProfile {
        vram_mb,
        chip_name: chip.clone(),
        power_budget_w: power_w,
        thermal_state: thermal.to_string(),
    };

    // Fetch catalog: live HF search when a term is present, cached trending otherwise.
    // Tuple shape: (model_id, downloads, likes, variants[]).
    let catalog: Vec<(String, u64, u64, Vec<(String, String, u64)>)> = if let Some(ref term) = search {
        // Live search — always fresh from HF
        fetch_hf_gguf(Some(term), limit).await
    } else {
        // Trending — use DuckDB cache, refresh if stale
        // Blocking pool: the store mutex may be held by the hourly aggregation.
        let st = store.clone();
        let fresh = tokio::task::spawn_blocking(move || st.catalog_is_fresh(24)).await.unwrap_or(false);
        if !fresh {
            let st = store.clone();
            refresh_model_catalog(st).await;
        }
        let st = store.clone();
        let lim = limit as i64;
        tokio::task::spawn_blocking(move || st.query_catalog(None, lim))
            .await.unwrap_or(Ok(Vec::new())).unwrap_or_default()
    };

    let mut models: Vec<serde_json::Value> = Vec::new();
    for (model_id, downloads, likes, variants) in &catalog {
        if !valid_hf_model_id(model_id) { continue; }
        let mut scored_variants: Vec<serde_json::Value> = Vec::new();
        for (filename, quant, file_size) in variants {
            let cv = CatalogVariant {
                filename: filename.clone(),
                quant_level: quant.clone(),
                file_size_bytes: *file_size,
            };
            // None = neutral "no historical WES" (scores 10). `Some(0.0)` is NOT
            // neutral — fit_components matches it as a poor-WES signal (scores 5),
            // which silently docked 5 points from every candidate.
            let fit = score_fit(model_id, &cv, &hw, None);
            // Construct the Ollama HF pull command: `ollama pull hf.co/<model_id>:<quant>`
            let pull_cmd = format!("ollama pull hf.co/{model_id}:{quant}");
            scored_variants.push(serde_json::json!({
                "quant":            fit.quant_level,
                "filename":         filename,
                "file_size_mb":     fit.file_size_mb,
                "vram_required_mb": fit.vram_required_mb,
                "fit_score":        fit.fit_score,
                "fit_label":        fit.fit_label,
                "estimated_wes":    fit.estimated_wes,
                "vram_headroom_pct":fit.vram_headroom_pct,
                "recommendation":   fit.recommendation,
                "pull_cmd":         pull_cmd,
            }));
        }
        scored_variants.sort_by(|a, b| b["fit_score"].as_u64().cmp(&a["fit_score"].as_u64()));
        models.push(serde_json::json!({
            "model_id": model_id,
            "downloads": downloads,
            "likes": likes,
            "variants": scored_variants,
        }));
    }

    Json(serde_json::json!({
        "node_id":  node_id_ext.0.as_str(),
        "is_live_search": search.is_some(),
        "hardware": {
            "vram_mb":       vram_mb,
            "chip":          chip,
            "power_budget_w": (power_w * 10.0).round() / 10.0,
            "thermal_state": thermal,
        },
        "models": models,
    })).into_response()
}
