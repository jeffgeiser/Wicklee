//! Cloud model catalog / discovery, Perplexity Tax quality lookup and fit scoring wrappers.

use crate::*;

// ── Model Discovery (Cloud) ──────────────────────────────────────────────────

/// Refresh the HuggingFace GGUF model catalog into Postgres.
/// Returns the number of variants successfully written to model_catalog.
pub(crate) async fn refresh_cloud_model_catalog(pool: &sqlx::PgPool) -> usize {
    let hf_token: Option<String> = std::env::var("HUGGINGFACE_TOKEN").ok()
        .filter(|t| !t.is_empty());

    // Step 1: List top GGUF repos by downloads
    // 200 gives heterogeneous fleets (mix of small + large nodes) enough
    // catalog depth that per-node fit filtering still surfaces a useful
    // number of models. Fan-out to /tree/main is concurrency-limited to
    // 5 in-flight below, so 100 repos costs ~20 s — fine for startup +
    // nightly refresh, never on the request path. Tuned 200 → 100 after
    // observing the larger limit pulled in many low-quality fine-tunes
    // that crowded out useful results without proportional UX benefit.
    let list_url = "https://huggingface.co/api/models?filter=gguf&sort=downloads&direction=-1&limit=100";
    let tok1 = hf_token.clone();
    let list_resp = match tokio::task::spawn_blocking(move || {
        let req = HTTP_AGENT.get(list_url);
        let req = if let Some(t) = tok1 { req.set("Authorization", &format!("Bearer {t}")) } else { req };
        req.call().map_err(Box::new)
    }).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => { eprintln!("[model-catalog] HF list failed: {e}"); return 0; }
        Err(e) => { eprintln!("[model-catalog] task join failed: {e}"); return 0; }
    };
    let body: String = match list_resp.into_string() {
        Ok(b) => b,
        Err(e) => { eprintln!("[model-catalog] HF read failed: {e}"); return 0; }
    };
    let models: Vec<serde_json::Value> = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => { eprintln!("[model-catalog] HF parse failed: {e}"); return 0; }
    };

    // Step 2: Fetch /tree/main for all repos concurrently (max 5 in-flight).
    // Sequential fetches take 30–60 s for 30 repos; parallel cuts it to ~6 s.
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(5));
    let mut tasks: Vec<tokio::task::JoinHandle<Option<(String, i64, i64, Vec<serde_json::Value>)>>> = Vec::new();

    for model in &models {
        let model_id = model["id"].as_str().unwrap_or("").to_string();
        if model_id.is_empty() { continue; }
        let downloads = model["downloads"].as_i64().unwrap_or(0);
        // HF "likes" — current bookmark interest; complements downloads (which
        // skew toward older models that have had time to accumulate volume).
        let likes     = model["likes"].as_i64().unwrap_or(0);
        let tok2      = hf_token.clone();
        let sem       = semaphore.clone();

        tasks.push(tokio::spawn(async move {
            let _permit  = sem.acquire_owned().await.ok()?;
            let tree_url = format!("https://huggingface.co/api/models/{model_id}/tree/main");
            let tree_resp = tokio::task::spawn_blocking(move || {
                let req = HTTP_AGENT.get(&tree_url);
                let req = if let Some(t) = tok2 { req.set("Authorization", &format!("Bearer {t}")) } else { req };
                req.call().map_err(Box::new)
            }).await.ok()?.ok()?;
            let tree_body  = tree_resp.into_string().ok()?;
            let files: Vec<serde_json::Value> = serde_json::from_str(&tree_body).ok()?;
            Some((model_id, downloads, likes, files))
        }));
    }

    let mut count      = 0usize;
    let mut repo_count = 0usize;
    for task in tasks {
        let Some((model_id, downloads, likes, files)) = task.await.unwrap_or(None) else { continue };
        repo_count += 1;

        // Wipe all existing rows for this model_id before re-inserting.
        // Required because the refresh logic changed (shards aggregated into
        // canonical filenames). Old per-shard rows from previous catalog runs
        // would otherwise persist alongside the new canonical rows.
        let _ = sqlx::query("DELETE FROM model_catalog WHERE model_id = $1")
            .bind(&model_id).execute(pool).await;

        // Group GGUF files by variant key so multi-part shards
        // (e.g. "model-Q4_K_M-00001-of-00003.gguf", "...00002-of-00003.gguf")
        // are summed into a single catalog entry representing the full model size.
        // Single-file variants pass through unchanged.
        // Variant key = filename with the "-NNNNN-of-MMMMM" suffix stripped.
        struct VariantAgg { canonical_filename: String, total_size: i64, quant: String }
        let mut variants: std::collections::HashMap<String, VariantAgg> = std::collections::HashMap::new();

        // Pre-compute per-repo param count so the plausibility check can
        // run against every variant in this batch. Both signals (param
        // count from model_id, quant from filename) must be present for
        // the filter to act — be conservative when either is missing.
        let params_b_for_repo = scoring::extract_params_b(&model_id);

        for file in &files {
            let path = file["path"].as_str().unwrap_or("");
            if !path.ends_with(".gguf") { continue; }
            let file_size = file["size"].as_i64().unwrap_or(0);
            if file_size == 0 { continue; }
            let filename = path.rsplit('/').next().unwrap_or(path).to_string();

            // Skip non-model GGUF files: mmproj (vision adapters), tokenizer-only,
            // imatrix calibration files, draft models for speculative decoding,
            // LoRA / adapter weights, and embedding-only exports. These ride
            // along inside many repos but aren't standalone runnable models.
            let lower = filename.to_lowercase();
            if lower.contains("mmproj")
                || lower.contains("projector")
                || lower.contains("imatrix")
                || lower.starts_with("tokenizer")
                || lower.contains(".draft.")
                || lower.contains("-draft-")
                || lower.contains("lora")
                || lower.contains("adapter")
                || lower.contains("control-vector")
                || lower.contains("embedding-only")
            { continue; }

            // Detect shard pattern: "...-NNNNN-of-MMMMM.gguf"
            // Returns Some(canonical_filename_without_shard_suffix) when sharded.
            let canonical = {
                let stem = filename.strip_suffix(".gguf").unwrap_or(&filename);
                if let Some(of_idx) = stem.rfind("-of-") {
                    let after_of = &stem[of_idx+4..];
                    let total_str: String = after_of.chars().take_while(|c| c.is_ascii_digit()).collect();
                    if !total_str.is_empty() {
                        let before_of = &stem[..of_idx];
                        if let Some(dash_idx) = before_of.rfind('-') {
                            let shard_str = &before_of[dash_idx+1..];
                            if shard_str.chars().all(|c| c.is_ascii_digit()) && !shard_str.is_empty() {
                                // Strip "-NNNNN-of-MMMMM" → use "<base>.gguf" as canonical
                                Some(format!("{}.gguf", &before_of[..dash_idx]))
                            } else { None }
                        } else { None }
                    } else { None }
                } else { None }
            };

            let key = canonical.clone().unwrap_or_else(|| filename.clone());
            let canonical_filename = canonical.unwrap_or_else(|| filename.clone());

            // Use the proper parser that handles BOTH dash- and dot-separated quant names.
            // The previous inline parser only handled dot-separated (model.Q4_K_M.gguf),
            // missing the dominant modern HF format (model-Q4_K_M.gguf) — leaving every
            // entry tagged "unknown" so the quant_quality_factor returned 1.0 (full credit)
            // and never penalized low-quality quants.
            let quant_owned = parse_gguf_quant(&canonical_filename);

            variants.entry(key)
                .and_modify(|v| v.total_size += file_size)
                .or_insert(VariantAgg {
                    canonical_filename: canonical_filename.clone(),
                    total_size: file_size,
                    quant: quant_owned,
                });
        }

        for (_key, v) in variants {
            // Plausibility check runs on the *aggregated* size so multi-shard
            // variants (each shard ~10 GB on a 27B model) aren't individually
            // judged too-small. Drops variants whose total size doesn't match
            // their declared quant — i.e. the "F32 · 1.7 GB · 27B model"
            // class of mislabeling that bypassed the auxiliary-filename
            // filter above.
            if !scoring::is_plausible_size_for_quant(params_b_for_repo, &v.quant, v.total_size.max(0) as u64) {
                continue;
            }
            match sqlx::query(
                "INSERT INTO model_catalog (model_id, filename, quant_level, file_size, downloads, likes)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (model_id, filename) DO UPDATE SET
                   file_size = EXCLUDED.file_size,
                   downloads = EXCLUDED.downloads,
                   likes     = EXCLUDED.likes,
                   fetched_at = NOW()"
            ).bind(&model_id).bind(&v.canonical_filename).bind(&v.quant)
              .bind(v.total_size).bind(downloads).bind(likes)
            .execute(pool).await {
                Ok(_)  => count += 1,
                Err(e) => eprintln!("[model-catalog] insert failed for {model_id}/{}: {e}", v.canonical_filename),
            }
        }
    }
    println!("[model-catalog] cached {count} GGUF variants from {repo_count} repos");
    count
}

/// Hardware simulation profiles for Pro tier "what if I had a 4090?" feature.
pub(crate) fn hardware_profile(name: &str) -> Option<(u64, f32)> {
    // (vram_mb, typical_power_w)
    match name {
        "m4"               => Some((16_384, 12.0)),
        "m4_pro_24gb"      => Some((24_576, 18.0)),
        "m4_max_36gb"      => Some((36_864, 25.0)),
        "m4_max_64gb"      => Some((65_536, 35.0)),
        "m4_ultra_128gb"   => Some((131_072, 60.0)),
        "nvidia_4060"      => Some((8_192, 115.0)),
        "nvidia_4070"      => Some((12_288, 200.0)),
        "nvidia_4080"      => Some((16_384, 320.0)),
        "nvidia_4090"      => Some((24_576, 450.0)),
        "nvidia_a100_40gb" => Some((40_960, 300.0)),
        "nvidia_a100_80gb" => Some((81_920, 300.0)),
        "nvidia_h100"      => Some((81_920, 700.0)),
        _ => None,
    }
}

// ── Perplexity Tax — empirical quality lookup ────────────────────────────────
//
// Single source of truth for quant quality cost.  The same JSON file ships
// to the frontend as a static asset and is embedded here at compile time,
// so cloud-side fleet matching and frontend Quant Sweet Spot tiles agree.
//
// Data is curated empirical KL divergence + perplexity delta vs FP16 from
// Unsloth Dynamic GGUF benchmarks and the llama.cpp perplexity discussions.
// Lookup falls back: exact family → "default" generic baseline → coarse
// hand-tuned heuristic when even the JSON failed to parse.

// Canonical perplexity baseline lives inside the cloud build context so
// the Railway Docker build can reach it (build context = cloud/, so
// ../../public/... is outside).  A pre-`npm run build` script in the
// frontend mirrors this file to public/perplexity_baseline.json so the
// browser receives the same data via static asset.  See `scripts/sync-perplexity.mjs`.
pub(crate) const PERPLEXITY_BASELINE_JSON: &str = include_str!("../data/perplexity_baseline.json");

#[derive(Debug, serde::Deserialize)]
pub(crate) struct PerplexityEntry {
    pub(crate) kld: f64,
    // `ppl_delta_pct` is also present in the JSON but unused server-side;
    // serde ignores unknown fields, so it is intentionally not declared.
}

#[derive(Debug, serde::Deserialize)]
pub(crate) struct PerplexityFamilyJson {
    pub(crate) quants: HashMap<String, PerplexityEntry>,
}

#[derive(Debug, serde::Deserialize)]
pub(crate) struct PerplexityBaselineJson {
    pub(crate) families: HashMap<String, PerplexityFamilyJson>,
}

pub(crate) static PERPLEXITY_BASELINE: std::sync::LazyLock<Option<PerplexityBaselineJson>> =
    std::sync::LazyLock::new(|| {
        match serde_json::from_str::<PerplexityBaselineJson>(PERPLEXITY_BASELINE_JSON) {
            Ok(b)  => Some(b),
            Err(e) => {
                eprintln!("[perplexity] failed to parse baseline JSON: {e}");
                None
            }
        }
    });

/// Map a free-form model id (e.g. "bartowski/Llama-3.1-8B-Instruct-GGUF") to a
/// canonical family key matching `perplexity_baseline.json`.  Mirrors the
/// frontend `normalizeModelFamily()` — both must agree to keep cloud + UI in
/// sync.  Returns None when no family token can be extracted.
pub(crate) fn normalize_model_family(name: &str) -> Option<String> {
    let stripped = name.split('/').next_back().unwrap_or(name);
    let lower    = stripped.to_lowercase().replace(".gguf", "");

    // Phi
    if lower.contains("phi-3-mini")   || lower.contains("phi3-mini")   || lower.starts_with("phi3:mini") { return Some("phi-3-mini".into()); }
    if lower.contains("phi-3-medium") || lower.contains("phi3-medium") { return Some("phi-3-medium".into()); }
    if lower.contains("phi-3-small")  || lower.contains("phi3-small")  { return Some("phi-3-small".into()); }

    // DeepSeek-R1 distill carries underlying model size.
    let dsr1_re = regex::Regex::new(r"deepseek-r1-distill-(llama|qwen)-(\d+(?:\.\d+)?)b").ok()?;
    if let Some(c) = dsr1_re.captures(&lower) {
        return Some(format!("deepseek-r1-distill-{}-{}b", &c[1], &c[2]));
    }

    // Mixtral MoE
    let mixtral_re = regex::Regex::new(r"mixtral-(\d+x\d+(?:\.\d+)?)b").ok()?;
    if let Some(c) = mixtral_re.captures(&lower) {
        return Some(format!("mixtral-{}b", &c[1]));
    }

    // <family>-<version>-<size>b
    let generic_re = regex::Regex::new(r"(llama|qwen|mistral|gemma|deepseek|yi|cohere|phi)[-_]?(\d+(?:\.\d+)?)[-_]?(\d+(?:\.\d+)?)b").ok()?;
    if let Some(c) = generic_re.captures(&lower) {
        return Some(format!("{}-{}-{}b", &c[1], &c[2], &c[3]));
    }

    // <family>-<size>b
    let family_size_re = regex::Regex::new(r"(llama|qwen|mistral|gemma|deepseek|yi|cohere|phi)[-_]?(\d+(?:\.\d+)?)b").ok()?;
    if let Some(c) = family_size_re.captures(&lower) {
        return Some(format!("{}-{}b", &c[1], &c[2]));
    }
    None
}

/// Canonical quant key matching `perplexity_baseline.json`.
pub(crate) fn normalize_quant_key(quant: &str) -> String {
    let mut q = quant.to_uppercase().replace(".GGUF", "");
    if q.starts_with("UD-") { q = q[3..].to_string(); }
    if q == "FP16" { q = "F16".into(); }
    if q == "FP32" { q = "F32".into(); }
    q
}

/// Look up empirical KLD for (model_id, quant). Falls back to the "default"
/// family. Returns None when no entry exists in either path.
pub(crate) fn lookup_kld(model_id: &str, quant: &str) -> Option<f64> {
    let baseline = PERPLEXITY_BASELINE.as_ref()?;
    let q = normalize_quant_key(quant);
    if let Some(family) = normalize_model_family(model_id)
        && let Some(fam) = baseline.families.get(&family)
            && let Some(e) = fam.quants.get(&q) { return Some(e.kld); }
    // Default family fallback.
    if let Some(def) = baseline.families.get("default")
        && let Some(e) = def.quants.get(&q) { return Some(e.kld); }
    None
}

pub(crate) fn quant_quality_factor(model_id: &str, quant: &str) -> f32 {
    if let Some(kld) = lookup_kld(model_id, quant) {
        let mult = (1.0 - (kld / 0.15)).clamp(0.0, 1.0) as f32;
        return mult;
    }
    // Heuristic fallback (legacy behaviour).
    let q = quant.to_lowercase();
    let q = q.strip_prefix("ud-").unwrap_or(&q);
    if q.starts_with("iq1") || q == "q1_k" || q == "q1" { return 0.0; }
    if q.starts_with("iq2") || q.starts_with("q2")      { return 0.4; }
    if q.starts_with("iq3") || q.starts_with("q3")      { return 0.7; }
    1.0
}

/// Fit score for a model variant on a given hardware profile — thin wrapper
/// over the shared scoring module (mirrored agent<->cloud by
/// scripts/sync-scoring.mjs), which owns the component math, the won't-fit
/// hard gate, and the 30% + 512 MB working-set estimate. Cloud has no
/// per-node history during simulation, so historical WES is None (neutral
/// 10/20 points). Used by fleet matching and Pro simulation.
pub(crate) fn cloud_fit_score(file_size_bytes: i64, vram_mb: u64, _power_w: f32, thermal: &str) -> (u8, String) {
    let fit = scoring::fit_components(file_size_bytes.max(0) as u64, vram_mb, thermal, None);
    (fit.total, fit.label.to_string())
}

/// Parse a quant level from a GGUF filename (mirrors agent-side logic).
///
/// Strict matching: prefix alone is not enough — must match a real quant pattern.
/// This avoids false positives like "FLASH" from `Flash-Heretic` or "QWEN3" from
/// `Qwen3.5-9B`. Recognised forms:
///   Q[1-9]            → Q1, Q2, ..., Q8 (with optional _K, _K_M, _0, _XL, _P, etc.)
///   IQ[1-9]           → IQ1, IQ2, ..., IQ4 (with optional _S, _M, _XS, _XXS, _NL)
///   F16 | F32         → half / full float
///   BF16 | BF32       → bfloat
///   MXFP[0-9]         → MXFP4_MOE, etc.
pub(crate) fn parse_gguf_quant(filename: &str) -> String {
    let stem = filename.strip_suffix(".gguf").unwrap_or(filename);
    let is_quant = |s: &str| -> bool {
        let u = s.to_ascii_uppercase();
        // Strict patterns: prefix MUST be followed by a digit or known marker.
        if u.starts_with("MXFP") && u.len() > 4 && u.as_bytes()[4].is_ascii_digit() { return true; }
        if u.starts_with("BF") && u.len() > 2 && u.as_bytes()[2].is_ascii_digit() { return true; }
        if u.starts_with("IQ") && u.len() > 2 && u.as_bytes()[2].is_ascii_digit() { return true; }
        if u.starts_with('Q') && u.len() > 1 && u.as_bytes()[1].is_ascii_digit() { return true; }
        if u == "F16" || u == "F32" { return true; }
        false
    };
    for seg in stem.rsplit('.') {
        if is_quant(seg) { return seg.to_ascii_uppercase(); }
    }
    let parts: Vec<&str> = stem.rsplit('-').collect();
    for (i, seg) in parts.iter().enumerate() {
        if is_quant(seg) {
            let q = seg.to_ascii_uppercase();
            if i + 1 < parts.len() && parts[i + 1].eq_ignore_ascii_case("UD") {
                return format!("UD-{q}");
            }
            return q;
        }
    }
    "unknown".to_string()
}

/// GET /api/fleet/model-candidates — JWT-authenticated fleet model discovery.
pub(crate) fn valid_hf_model_id_cloud(id: &str) -> bool {
    if id.is_empty() || id.len() > 200 { return false; }
    let mut parts = id.splitn(2, '/');
    let (Some(owner), Some(name)) = (parts.next(), parts.next()) else { return false; };
    let safe = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.');
    safe(owner) && safe(name)
}

/// Fetches GGUF models from HuggingFace and scores each against every online fleet node.
/// When search is provided: queries HF live (1h cache). Without search: trending top-20 (24h cache).
pub(crate) async fn handle_fleet_model_candidates(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({ "error": "Unauthorized" }))).into_response(),
    };
    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let (user_id, org_id) = match require_user_and_org(&token, &state.pool, &clerk_keys).await {
        Some(v) => v,
        None => return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({ "error": "Unauthorized" }))).into_response(),
    };
    let (tcol, tval) = tenant_scope(&user_id, &org_id);
    let node_ids: Vec<String> = sqlx::query_scalar(
        &format!("SELECT wk_id FROM nodes WHERE {tcol} = $1")
    ).bind(tval).fetch_all(&state.pool).await.unwrap_or_default();

    let search          = params.get("search").filter(|s| !s.trim().is_empty()).cloned();
    let limit: i32      = params.get("limit").and_then(|v| v.parse().ok()).unwrap_or(20_i32).min(200);
    // Optional: when set, results are ranked + filtered for this specific node_id.
    let filter_node_id  = params.get("node_id").filter(|s| !s.trim().is_empty()).cloned();

    // Query the Postgres model_catalog (populated by refresh_cloud_model_catalog at startup
    // + 3 AM nightly). This uses the correct HF tree API that includes actual file sizes —
    // unlike the old ?full=true approach which never included the size field in siblings.
    //
    // IMPORTANT: LIMIT is applied to variant *rows*, not model count. A single popular model
    // (e.g. Llama 3.2) can have 20+ quant variants, consuming the entire limit. We fetch
    // limit * 30 rows then cap at `limit` distinct models after grouping, ensuring we always
    // surface the requested number of models regardless of variant count.
    let row_limit: i32 = limit.saturating_mul(30).min(1200);
    let rows: Vec<(String, String, String, i64, i64, i64)> = if let Some(ref s) = search {
        sqlx::query_as(
            "SELECT model_id, filename, quant_level, file_size, downloads, likes FROM model_catalog
             WHERE LOWER(model_id) LIKE '%' || LOWER($2) || '%'
             ORDER BY downloads DESC LIMIT $1"
        ).bind(row_limit).bind(s).fetch_all(&state.pool).await.unwrap_or_default()
    } else {
        sqlx::query_as(
            "SELECT model_id, filename, quant_level, file_size, downloads, likes FROM model_catalog
             ORDER BY downloads DESC LIMIT $1"
        ).bind(row_limit).fetch_all(&state.pool).await.unwrap_or_default()
    };

    // Group flat rows by model_id → (downloads, likes, variants).
    // downloads + likes are repo-level (same for every variant of the same model_id),
    // so we just take the first one we see — the SELECT preserves repo order.
    let mut model_map: std::collections::HashMap<String, (u64, u64, Vec<(String, String, u64)>)> = std::collections::HashMap::new();
    for (model_id, filename, quant, file_size, downloads, likes) in &rows {
        if !valid_hf_model_id_cloud(model_id) { continue; }
        if *file_size <= 0 { continue; }
        let entry = model_map.entry(model_id.clone()).or_insert_with(|| (*downloads as u64, *likes as u64, Vec::new()));
        entry.2.push((filename.clone(), quant.clone(), *file_size as u64));
    }
    // Sort each model's variants by file size descending (largest first = highest quality first)
    for (_, _, variants) in model_map.values_mut() {
        variants.sort_by_key(|a| std::cmp::Reverse(a.2));
    }

    let hf_reachable = !model_map.is_empty();
    let hf_debug = if hf_reachable {
        format!("catalog: {} models, {} variants", model_map.len(), rows.len())
    } else {
        "model_catalog empty — catalog refresh may still be in progress (runs 5s after startup)".to_string()
    };
    eprintln!("[fleet-discovery] {hf_debug}");

    // Build hf_models sorted by downloads descending, capped at `limit` distinct models.
    let mut hf_models: Vec<(String, u64, u64, Vec<(String, String, u64)>)> = model_map
        .into_iter()
        .map(|(id, (dl, likes, vars))| (id, dl, likes, vars))
        .collect();
    hf_models.sort_by_key(|a| std::cmp::Reverse(a.1));
    hf_models.truncate(limit as usize);

    // Snapshot online fleet node hardware
    let now = now_ms();
    struct NodeHw { node_id: String, hostname: Option<String>, mem_mb: u64, power_w: f32, thermal: String, chip: Option<String> }
    let node_hw: Vec<NodeHw> = {
        let snap = state.metrics.read().unwrap();
        node_ids.iter().filter_map(|nid| {
            let e = snap.get(nid)?;
            if now.saturating_sub(e.last_seen_ms) >= ONLINE_THRESHOLD_MS { return None; }
            let m = e.metrics.as_ref()?;
            let vram      = m.nvidia_vram_total_mb.unwrap_or(0).max(m.gpu_wired_limit_mb.unwrap_or(0));
            let mem_mb    = if vram == 0 { m.total_memory_mb * 3 / 4 } else { vram };
            let power_w   = m.apple_soc_power_w.or(m.nvidia_power_draw_w).unwrap_or(0.0);
            let thermal   = m.thermal_state.clone().unwrap_or_else(|| "Normal".into());
            // Chip identifier used by the frontend's theoretical tok/s lookup
            // (chipBandwidth.ts). Apple Silicon reports a "chip_name" like
            // "Apple M4 Pro"; NVIDIA reports "gpu_name" like "NVIDIA H100".
            // Prefer chip_name (more specific to Apple), then gpu_name.
            let chip = m.chip_name.clone().or(m.gpu_name.clone());
            Some(NodeHw { node_id: nid.clone(), hostname: m.hostname.clone(), mem_mb, power_w, thermal, chip })
        }).collect()
    };
    let online_count = node_hw.len();

    // Score each model × each node
    let mut models: Vec<serde_json::Value> = Vec::new();
    for (model_id, downloads, likes, variants) in &hf_models {
        if !valid_hf_model_id_cloud(model_id) { continue; }
        let mut node_fits: Vec<serde_json::Value> = Vec::new();
        let mut fleet_best_score = 0u8;

        for hw in &node_hw {
            let mut best_score = 0u8;
            let mut best_label = "Won't Fit".to_string();
            let mut best_quant = String::new();
            let mut best_file_mb = 0u64;

            for (_filename, quant, file_size) in variants {
                let (raw_score, label) = cloud_fit_score(*file_size as i64, hw.mem_mb, hw.power_w, &hw.thermal);
                // Apply quant quality factor so IQ1/Q2 variants don't win over Q4+
                // just because they leave more VRAM headroom.
                let qf = quant_quality_factor(model_id, quant);
                let score = (raw_score as f32 * qf).round() as u8;
                let label = if qf == 0.0 { "Won't Fit".to_string() } else { label };
                // `score` and `best_score` BOTH already carry the quality
                // factor — compare directly. Recomputing qf on best_score
                // applied it twice to the incumbent, biasing selection
                // toward lower-quality quants whenever the incumbent's
                // qf < 1.
                if score > best_score {
                    best_score = score;
                    best_label = label;
                    best_quant = quant.clone();
                    best_file_mb = file_size / (1024 * 1024);
                }
            }

            if best_score > fleet_best_score { fleet_best_score = best_score; }

            node_fits.push(serde_json::json!({
                "node_id":      hw.node_id,
                "hostname":     hw.hostname,
                "mem_budget_gb": (hw.mem_mb as f64 / 1024.0 * 10.0).round() / 10.0,
                "thermal":      hw.thermal,
                "chip_name":    hw.chip,
                "fit_score":    best_score,
                "fit_label":    best_label,
                "best_quant":   best_quant,
                "file_size_mb": best_file_mb,
                "pull_cmd":     format!("ollama pull hf.co/{model_id}:{best_quant}"),
            }));
        }

        node_fits.sort_by(|a, b| b["fit_score"].as_u64().cmp(&a["fit_score"].as_u64()));

        models.push(serde_json::json!({
            "model_id":         model_id,
            "downloads":        downloads,
            "likes":            likes,
            "fleet_best_score": fleet_best_score,
            "nodes":            node_fits,
        }));
    }

    // Per-node view: keep only models the selected node can run (score > 0), ranked by that node's score.
    // All-nodes view: keep only models EVERY online node can run (intersection), ranked by fleet_best_score.
    //   This way "All nodes" is the safe overlap — models you can pull to any node without wasted bandwidth.
    if let Some(ref nid) = filter_node_id {
        let node_score = |m: &serde_json::Value| -> u64 {
            m["nodes"].as_array()
                .and_then(|nodes| nodes.iter().find(|n| n["node_id"].as_str() == Some(nid.as_str())))
                .and_then(|n| n["fit_score"].as_u64())
                .unwrap_or(0)
        };
        models.retain(|m| node_score(m) > 0);
        models.sort_by_key(|m| std::cmp::Reverse(node_score(m)));
    } else if online_count > 1 {
        // Intersection: all online nodes must have score >= 60 (Good or better).
        // Lower scores indicate "fits but tight" — don't show those in the trending list
        // since users expect models that will actually run well, not barely fit.
        models.retain(|m| {
            m["nodes"].as_array()
                .map(|arr| arr.iter().all(|n| n["fit_score"].as_u64().unwrap_or(0) >= 60))
                .unwrap_or(false)
        });
        models.sort_by(|a, b| b["fleet_best_score"].as_u64().cmp(&a["fleet_best_score"].as_u64()));
    } else {
        // Single node in fleet: rank by score, only show models scoring Good or better.
        models.retain(|m| m["fleet_best_score"].as_u64().unwrap_or(0) >= 60);
        models.sort_by(|a, b| b["fleet_best_score"].as_u64().cmp(&a["fleet_best_score"].as_u64()));
    }

    Json(serde_json::json!({
        "is_live_search": search.is_some(),
        "online_nodes":   online_count,
        "hf_reachable":   hf_reachable,
        "hf_debug":       hf_debug,
        "models":         models,
    })).into_response()
}

/// GET /api/v1/models/discover — model discovery for Pro/Team tiers.
/// Query params:
///   ?search=llama — filter by model name
///   ?limit=20 — max results
///   ?simulate_hw=nvidia_4090 — Pro: simulate against hardware profile
///   ?simulate_vram_mb=24576&simulate_power_w=350 — Pro: custom simulation
///   ?fleet=true&model_id=X — Team: which fleet nodes can run this model?
pub(crate) async fn handle_v1_models_discover(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let raw_key = match extract_api_key(&headers) {
        Some(k) => k,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing API key" }))).into_response(),
    };
    let (_key_id, user_id, key_org, tier) = match validate_api_key(&raw_key, &state.pool, &state.api_rate_limits).await {
        Some(r) => r,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid API key or rate limit exceeded" }))).into_response(),
    };
    let (tcol, tval) = tenant_scope(&user_id, &key_org);


    // ── Fleet matching (Team+) ────────────────────────────────────────────
    if params.get("fleet").map(|v| v == "true").unwrap_or(false) {
        if !is_team_or_above(&tier) {
            return upgrade_required("Fleet model matching", UpgradePlan::Team);
        }
        let model_id = params.get("model_id").cloned().unwrap_or_default();
        if model_id.is_empty() {
            return (StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "model_id required for fleet matching" }))).into_response();
        }
        // Get model variants from catalog
        let variants: Vec<(String, i64)> = sqlx::query_as(
            "SELECT quant_level, file_size FROM model_catalog WHERE model_id = $1 ORDER BY file_size"
        ).bind(&model_id).fetch_all(&state.pool).await.unwrap_or_default();

        if variants.is_empty() {
            return Json(serde_json::json!({ "error": "Model not found in catalog", "model_id": model_id })).into_response();
        }

        // Score each fleet node against the smallest fitting variant
        let node_ids: Vec<String> = sqlx::query_scalar(
            &format!("SELECT wk_id FROM nodes WHERE {tcol} = $1")
        ).bind(tval).fetch_all(&state.pool).await.unwrap_or_default();

        let metrics_map = state.metrics.read().unwrap();
        let now = now_ms();
        let mut node_scores: Vec<serde_json::Value> = Vec::new();

        for node_id in &node_ids {
            let entry = match metrics_map.get(node_id) {
                Some(e) if now.saturating_sub(e.last_seen_ms) < ONLINE_THRESHOLD_MS => e,
                _ => continue,
            };
            let m = match &entry.metrics { Some(m) => m, None => continue };
            let vram = m.nvidia_vram_total_mb.unwrap_or(0).max(m.gpu_wired_limit_mb.unwrap_or(0));
            let power = m.apple_soc_power_w.or(m.nvidia_power_draw_w).unwrap_or(0.0);
            let thermal = m.thermal_state.as_deref().unwrap_or("Normal");

            // Find the best-fitting variant for this node
            let mut best_score = 0u8;
            let mut best_quant = String::new();
            let mut best_label = String::new();
            for (quant, file_size) in &variants {
                let (raw_score, label) = cloud_fit_score(*file_size, vram, power, thermal);
                let qf = quant_quality_factor(&model_id, quant);
                let score = (raw_score as f32 * qf).round() as u8;
                let label = if qf == 0.0 { "Won't Fit".to_string() } else { label };
                // `score` and `best_score` BOTH already carry the quality
                // factor — compare directly. Recomputing qf on best_score
                // applied it twice to the incumbent, biasing selection
                // toward lower-quality quants whenever the incumbent's
                // qf < 1.
                if score > best_score {
                    best_score = score;
                    best_quant = quant.clone();
                    best_label = label;
                }
            }

            node_scores.push(serde_json::json!({
                "node_id": node_id,
                "hostname": m.hostname,
                "vram_mb": vram,
                "best_quant": best_quant,
                "fit_score": best_score,
                "fit_label": best_label,
            }));
        }
        node_scores.sort_by(|a, b| b["fit_score"].as_u64().cmp(&a["fit_score"].as_u64()));

        return Json(serde_json::json!({
            "model_id": model_id,
            "variant_count": variants.len(),
            "nodes": node_scores,
        })).into_response();
    }

    // ── Simulation (Pro+) or catalog browse ───────────────────────────────
    let simulate_hw = params.get("simulate_hw").cloned();
    let custom_vram: Option<u64> = params.get("simulate_vram_mb").and_then(|v| v.parse().ok());
    let custom_power: Option<f32> = params.get("simulate_power_w").and_then(|v| v.parse().ok());

    let (sim_vram, sim_power, sim_label) = if let Some(ref hw_name) = simulate_hw {
        if !is_pro_or_above(&tier) {
            return upgrade_required("Hardware simulation", UpgradePlan::Team);
        }
        match hardware_profile(hw_name) {
            Some((v, p)) => (v, p, Some(hw_name.clone())),
            None => return (StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "Unknown hardware profile", "available": [
                    "m4", "m4_pro_24gb", "m4_max_36gb", "m4_max_64gb", "m4_ultra_128gb",
                    "nvidia_4060", "nvidia_4070", "nvidia_4080", "nvidia_4090",
                    "nvidia_a100_40gb", "nvidia_a100_80gb", "nvidia_h100"
                ] }))).into_response(),
        }
    } else if custom_vram.is_some() || custom_power.is_some() {
        if !is_pro_or_above(&tier) {
            return upgrade_required("Hardware simulation", UpgradePlan::Team);
        }
        (custom_vram.unwrap_or(16_384), custom_power.unwrap_or(20.0), Some("custom".into()))
    } else {
        (0, 0.0, None) // No simulation — just return catalog
    };

    let search = params.get("search").cloned();
    let limit: i64 = params.get("limit").and_then(|v| v.parse().ok()).unwrap_or(20).min(50);

    // Query catalog
    let search_clause = if search.is_some() {
        "AND LOWER(model_id) LIKE '%' || LOWER($2) || '%'"
    } else { "" };
    let sql = format!(
        "SELECT model_id, filename, quant_level, file_size, downloads, likes FROM model_catalog
         WHERE TRUE {search_clause} ORDER BY downloads DESC LIMIT $1"
    );

    let rows: Vec<(String, String, String, i64, i64, i64)> = if let Some(ref s) = search {
        sqlx::query_as(&sql).bind(limit).bind(s).fetch_all(&state.pool).await.unwrap_or_default()
    } else {
        let sql_no_search = "SELECT model_id, filename, quant_level, file_size, downloads, likes FROM model_catalog ORDER BY downloads DESC LIMIT $1".to_string();
        sqlx::query_as(&sql_no_search).bind(limit).fetch_all(&state.pool).await.unwrap_or_default()
    };

    // Group by model_id and score
    let mut models: Vec<serde_json::Value> = Vec::new();
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    for (model_id, _filename, quant, file_size, downloads, likes) in &rows {
        let (vram, power) = if sim_label.is_some() {
            (sim_vram, sim_power)
        } else {
            (16_384u64, 20.0f32) // Default: 16GB / 20W (generic Apple Silicon)
        };
        let (score, label) = cloud_fit_score(*file_size, vram, power, "Normal");
        let vram_required = (*file_size as u64 / (1024 * 1024)) + ((*file_size as u64 / (1024 * 1024)) / 10).max(256);

        let variant = serde_json::json!({
            "quant": quant,
            "file_size_mb": *file_size / (1024 * 1024),
            "vram_required_mb": vram_required,
            "fit_score": score,
            "fit_label": label,
        });

        if let Some(&idx) = seen.get(model_id) {
            models[idx]["variants"].as_array_mut().unwrap().push(variant);
        } else {
            seen.insert(model_id.clone(), models.len());
            models.push(serde_json::json!({
                "model_id": model_id,
                "downloads": downloads,
                "likes": likes,
                "variants": [variant],
            }));
        }
    }

    // Sort variants within each model by fit_score desc
    for m in &mut models {
        if let Some(arr) = m["variants"].as_array_mut() {
            arr.sort_by(|a, b| b["fit_score"].as_u64().cmp(&a["fit_score"].as_u64()));
        }
    }

    let mut response = serde_json::json!({ "models": models });
    if let Some(ref label) = sim_label {
        response["simulation"] = serde_json::json!({
            "hardware": label,
            "vram_mb": sim_vram,
            "power_w": sim_power,
        });
    }
    Json(response).into_response()
}

#[cfg(test)]
mod fit_wrapper_tests {
    use super::*;

    // The component math, plausibility filter, and value-pinning regression
    // tests live in src/scoring.rs (shared module, mirrored agent<->cloud by
    // scripts/sync-scoring.mjs). These only cover the cloud-side wrapper.

    #[test]
    fn fit_score_wrapper_matches_shared_components() {
        // Llama 3.1 8B Q4_K_M (4.92 GB) on a 24 GB GPU, Normal thermal:
        // 40 vram + 20 thermal + 10 neutral WES + 16 capacity = 86.
        let (score, label) = cloud_fit_score(4_920_000_000, 24_576, 0.0, "Normal");
        assert_eq!(score, 86);
        assert_eq!(label, "Excellent");
    }

    #[test]
    fn fit_score_hard_gates_models_that_dont_fit() {
        let (score, label) = cloud_fit_score(16_070_000_000, 8_192, 0.0, "Normal");
        assert_eq!(score, 0);
        assert_eq!(label, "Won't Fit");
    }

    #[test]
    fn negative_file_sizes_clamp_safely() {
        let (score, label) = cloud_fit_score(-1, 24_576, 0.0, "Normal");
        // 0-byte clamp -> 512 MB floor still "fits"; just must not panic.
        assert!(score > 0, "{label}");
    }
}
