//! Rollups and nightly maintenance tasks.

use crate::*;

// ── Rollup & maintenance ─────────────────────────────────────────────────────

pub(crate) async fn run_rollup(pool: &sqlx::PgPool) {
    // Aggregate metrics_raw rows older than 24h into 5-minute buckets.
    let result = sqlx::query(&rollup_sql()).execute(pool).await;

    match result {
        Ok(r) => println!("[rollup] inserted {} 5-min aggregates", r.rows_affected()),
        Err(e) => eprintln!("[rollup] insert failed: {e}"),
    }

    delete_rolled_up_raw(pool).await;
    println!("[rollup] complete");
}

/// The rollup INSERT. Besides the per-bucket averages it stores the
/// time-integrated totals (covered_s, energy_wh, live_energy_wh, live_s,
/// tokens_est) — each raw row weighted by its real duration (energy::
/// raw_dt_sql: time to the node's next row, capped). `sample_count` is a row
/// count at the ~2 s push cadence, NOT a count of 30 s periods.
pub(crate) fn rollup_sql() -> String {
    format!(
        "INSERT INTO metrics_5min (ts, node_id, tenant_id,
            tok_s_avg, tok_s_p50, tok_s_p95,
            watts_avg, wes_raw_avg, wes_penalized_avg, wes_penalized_min,
            thermal_cost_pct_avg, thermal_cost_pct_max, thermal_state_worst,
            mem_pressure_pct_avg, mem_pressure_pct_max, gpu_pct_avg,
            inference_duty_pct, swap_write_avg,
            sample_count, wes_version, wes_version_count, agent_version,
            ollama_active_model,
            covered_s, energy_wh, live_energy_wh, live_s, tokens_est)
        SELECT
            to_timestamp(floor(EXTRACT(EPOCH FROM ts) / 300) * 300) AS bucket,
            node_id, tenant_id,
            AVG(tok_s),
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY tok_s),
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY tok_s),
            AVG(watts), AVG(wes_raw), AVG(wes_penalized), MIN(wes_penalized),
            AVG(thermal_cost_pct), MAX(thermal_cost_pct),
            CASE MAX(CASE thermal_state
                     WHEN 'Critical' THEN 3
                     WHEN 'Serious'  THEN 2
                     WHEN 'Fair'     THEN 1
                     ELSE 0 END)
                WHEN 3 THEN 'Critical'
                WHEN 2 THEN 'Serious'
                WHEN 1 THEN 'Fair'
                ELSE 'Normal' END,
            AVG(mem_pressure_pct), MAX(mem_pressure_pct), AVG(gpu_pct),
            (SUM(CASE WHEN inference_state = 'live' THEN 1 ELSE 0 END)::real / NULLIF(COUNT(*), 0)::real * 100.0),
            AVG(swap_write),
            COUNT(*)::smallint,
            MIN(wes_version)::smallint,
            COUNT(DISTINCT wes_version)::smallint,
            MIN(agent_version),
            -- Last non-null model name observed in the 5-minute window.
            (array_agg(ollama_active_model ORDER BY ts DESC) FILTER (WHERE ollama_active_model IS NOT NULL))[1],
            SUM(dt_s)::real,
            (SUM(COALESCE(watts, 0) * dt_s) / 3600.0)::real,
            (SUM(CASE WHEN inference_state = 'live' THEN COALESCE(watts, 0) * dt_s ELSE 0 END) / 3600.0)::real,
            SUM(CASE WHEN inference_state = 'live' THEN dt_s ELSE 0 END)::real,
            SUM(CASE WHEN inference_state = 'live' THEN COALESCE(tok_s, 0) * dt_s ELSE 0 END)::real
        -- dt is computed over a slightly wider slice than the cutoff so each
        -- bucket's last row sees its successor.
        FROM (
            SELECT r.*, {dt} AS dt_s
            FROM metrics_raw r
            WHERE ts < to_timestamp(floor(EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours') / 300) * 300)
                       + make_interval(secs => {gap})
        ) metrics_raw
        -- Cutoff floored to a 5-min bucket boundary so only COMPLETE buckets
        -- are aggregated. With a raw NOW()-24h cutoff, the straddling bucket
        -- was inserted from partial data; an hour later its remaining rows
        -- aged past the cutoff, the re-insert hit ON CONFLICT DO NOTHING,
        -- and the DELETE below removed them un-aggregated — one
        -- systematically undercounted bucket per node per run.
        WHERE ts < to_timestamp(floor(EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours') / 300) * 300)
        GROUP BY bucket, node_id, tenant_id
        ON CONFLICT DO NOTHING",
        dt = raw_dt_sql(),
        gap = MAX_SAMPLE_GAP_S,
    )
}

async fn delete_rolled_up_raw(pool: &sqlx::PgPool) {
    // Delete rolled-up raw rows. TimescaleDB retention policy also handles this,
    // but explicit deletion ensures data is rolled up first.
    let _ = sqlx::query(
        "DELETE FROM metrics_raw
         WHERE ts < to_timestamp(floor(EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours') / 300) * 300)
           AND EXISTS (
               SELECT 1 FROM metrics_5min m
               WHERE m.tenant_id = metrics_raw.tenant_id
                 AND m.node_id   = metrics_raw.node_id
                 AND m.ts        = to_timestamp(floor(EXTRACT(EPOCH FROM metrics_raw.ts) / 300) * 300)
           )"
    ).execute(pool).await;
}

/// Nightly maintenance: prune old data, VACUUM ANALYZE.
/// On TimescaleDB, retention policies handle metrics_raw/node_events/metrics_5min
/// automatically. These DELETEs are a fallback for stock Postgres without TimescaleDB.
pub(crate) async fn run_nightly_maintenance(pool: &sqlx::PgPool) {
    let now = now_ms() as i64;

    // Prune metrics_raw older than 2 days (fallback — TimescaleDB retention handles this if active).
    let _ = sqlx::query("DELETE FROM metrics_raw WHERE ts < to_timestamp($1::float8 / 1000.0)")
        .bind(now - 2 * 86_400_000).execute(pool).await;

    // Prune node_events older than 30 days.
    let _ = sqlx::query("DELETE FROM node_events WHERE ts < to_timestamp($1::float8 / 1000.0)")
        .bind(now - 30 * 86_400_000).execute(pool).await;

    // Prune metrics_5min older than 365 days (Business tier gets full year).
    let _ = sqlx::query("DELETE FROM metrics_5min WHERE ts < to_timestamp($1::float8 / 1000.0)")
        .bind(now - 365 * 86_400_000).execute(pool).await;

    // Prune resolved/acknowledged observations older than 30 days.
    let _ = sqlx::query(
        "DELETE FROM fleet_observations WHERE state != 'open' AND fired_at_ms < $1"
    ).bind(now - 30 * 86_400_000).execute(pool).await;

    // ANALYZE key tables for query planner.
    let _ = sqlx::query("ANALYZE metrics_raw").execute(pool).await;
    let _ = sqlx::query("ANALYZE metrics_5min").execute(pool).await;
    let _ = sqlx::query("ANALYZE node_events").execute(pool).await;
    let _ = sqlx::query("ANALYZE fleet_observations").execute(pool).await;

    // Refresh HuggingFace GGUF model catalog (24h cycle).
    let _ = refresh_cloud_model_catalog(pool).await;

    println!("[nightly] maintenance complete — pruned + ANALYZE + catalog refresh");
}

pub(crate) async fn rollup_task(pool: sqlx::PgPool) {
    tokio::time::sleep(Duration::from_secs(60)).await;
    run_rollup(&pool).await;

    let mut interval = tokio::time::interval(Duration::from_secs(3600));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    interval.tick().await;
    loop {
        interval.tick().await;
        run_rollup(&pool).await;
    }
}

pub(crate) async fn nightly_task(pool: sqlx::PgPool) {
    loop {
        let now_s = SystemTime::now()
            .duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        let secs_in_day   = now_s % 86400;
        let target_in_day = 3 * 3600_u64;
        let sleep_secs = if secs_in_day < target_in_day {
            target_in_day - secs_in_day
        } else {
            86400 - secs_in_day + target_in_day
        };
        tokio::time::sleep(Duration::from_secs(sleep_secs)).await;
        run_nightly_maintenance(&pool).await;
    }
}
