//! Energy / token integration over stored telemetry samples.
//!
//! `metrics_raw` holds one row per agent push, and the agent pushes every
//! ~2 s (cloud_push: 1 Hz frames throttled to ≥2 s, plus an immediate push on
//! every inference-state transition). It is NOT a 30 s series — 30 s is the
//! cloud writer's batch *flush* interval (`metrics_writer_task`) and the
//! Ollama probe cadence. Reports that credited every row with 30 s inflated
//! energy, tokens, and covered hours by 30 s ÷ real cadence (≈12–15×).
//!
//! The rule used everywhere instead: each sample holds until the same node's
//! next sample (`dt`), capped at [`MAX_SAMPLE_GAP_S`] so an offline gap is
//! never billed at the last reading. Energy = Σ watts·dt, and tokens =
//! Σ tok/s·dt over *live* samples only — between requests the agent keeps
//! reporting the probe's capability baseline (IDLE-SPD), which is not
//! generated tokens.
//!
//! The SQL fragments below are the single source of truth for the database
//! side; [`integrate_samples`] / [`rollup_bucket_integral`] mirror them in
//! Rust so the math is unit-testable without Postgres.

/// Longest span one sample may be credited with. Pushes arrive every ~2 s;
/// anything beyond this is an outage or a stopped agent.
pub(crate) const MAX_SAMPLE_GAP_S: f64 = 60.0;

/// `metrics_5min` bucket width (run_rollup floors to 300 s).
pub(crate) const ROLLUP_BUCKET_S: f64 = 300.0;

/// Per-row duration in seconds for `metrics_raw`, as a window expression.
/// Must be evaluated BEFORE any filter that removes rows of the same node
/// (window functions see only the rows of their FROM clause).
pub(crate) fn raw_dt_sql() -> String {
    format!(
        "GREATEST(LEAST(EXTRACT(EPOCH FROM (COALESCE(LEAD(ts) OVER (PARTITION BY tenant_id, node_id ORDER BY ts), NOW()) - ts))::float8, {MAX_SAMPLE_GAP_S:.1}), 0.0)::float8"
    )
}

/// Seconds a `metrics_5min` row covers. Rows written by the fixed rollup
/// carry `covered_s`; older rows only have `sample_count`, so the fallback
/// assumes a full bucket for any bucket with enough rows (true for a node
/// that was online the whole 5 min at any cadence ≤ 60 s).
pub(crate) fn rollup_covered_s_sql() -> String {
    format!("COALESCE(covered_s::float8, LEAST({ROLLUP_BUCKET_S:.1}, sample_count * {MAX_SAMPLE_GAP_S:.1}))")
}

/// kWh in a `metrics_5min` row (exact when energy_wh is present).
pub(crate) fn rollup_energy_kwh_sql() -> String {
    format!("(COALESCE(energy_wh::float8, COALESCE(watts_avg, 0) * {cov} / 3600.0) / 1000.0)::float8",
        cov = rollup_covered_s_sql())
}

/// kWh drawn while live in a `metrics_5min` row.
pub(crate) fn rollup_active_kwh_sql() -> String {
    format!("(COALESCE(live_energy_wh::float8, COALESCE(watts_avg, 0) * {cov} * COALESCE(inference_duty_pct, 0) / 100.0 / 3600.0) / 1000.0)::float8",
        cov = rollup_covered_s_sql())
}

/// Seconds live in a `metrics_5min` row.
pub(crate) fn rollup_live_s_sql() -> String {
    format!("(COALESCE(live_s::float8, {cov} * COALESCE(inference_duty_pct, 0) / 100.0))::float8",
        cov = rollup_covered_s_sql())
}

/// Estimated generated tokens in a `metrics_5min` row.
pub(crate) fn rollup_tokens_sql() -> String {
    format!("(COALESCE(tokens_est::float8, COALESCE(tok_s_avg, 0) * {cov} * COALESCE(inference_duty_pct, 0) / 100.0))::float8",
        cov = rollup_covered_s_sql())
}

/// Shared per-row base for chargeback + idle-waste: the 5-min rollup UNION
/// the raw rows that have not been rolled up yet. `$1` = tenant, `$2` =
/// window interval string ("30 days").
///
/// Columns: node_id, model, day, energy_kwh, active_kwh, live_hours,
/// hours_covered, tokens.
///
/// Raw rows are excluded when their 5-min bucket already exists in the
/// rollup (run_rollup INSERTs then DELETEs, so both can briefly coexist),
/// and raw rows older than 24 h that the hourly rollup hasn't reached yet
/// are included — the old `ts >= NOW() - 24h` split left that slice
/// (up to an hour per node) in neither half.
pub(crate) fn energy_base_cte() -> String {
    format!("
    WITH raw AS (
        SELECT node_id, ts, ollama_active_model, watts, tok_s, inference_state,
               {dt} AS dt_s
        FROM metrics_raw
        WHERE tenant_id = $1
          AND ts >= NOW() - ($2)::interval
    ),
    base AS (
        SELECT node_id,
               COALESCE(ollama_active_model, '(none)') AS model,
               date_trunc('day', ts) AS day,
               {energy} AS energy_kwh,
               {active} AS active_kwh,
               ({live_s} / 3600.0)::float8 AS live_hours,
               ({cov} / 3600.0)::float8 AS hours_covered,
               {tokens} AS tokens
        FROM metrics_5min
        WHERE tenant_id = $1
          AND ts >= NOW() - ($2)::interval
        UNION ALL
        SELECT r.node_id,
               COALESCE(r.ollama_active_model, '(none)'),
               date_trunc('day', r.ts),
               (COALESCE(r.watts, 0) * r.dt_s / 3600.0 / 1000.0)::float8,
               (CASE WHEN r.inference_state = 'live' THEN COALESCE(r.watts, 0) * r.dt_s / 3600.0 / 1000.0 ELSE 0.0 END)::float8,
               (CASE WHEN r.inference_state = 'live' THEN r.dt_s / 3600.0 ELSE 0.0 END)::float8,
               (r.dt_s / 3600.0)::float8,
               (CASE WHEN r.inference_state = 'live' THEN COALESCE(r.tok_s, 0) * r.dt_s ELSE 0.0 END)::float8
        FROM raw r
        WHERE r.ts >= NOW() - INTERVAL '24 hours'
           OR NOT EXISTS (
               SELECT 1 FROM metrics_5min m
               WHERE m.tenant_id = $1
                 AND m.node_id   = r.node_id
                 AND m.ts        = to_timestamp(floor(EXTRACT(EPOCH FROM r.ts) / 300) * 300))
    )",
        dt = raw_dt_sql(),
        energy = rollup_energy_kwh_sql(),
        active = rollup_active_kwh_sql(),
        live_s = rollup_live_s_sql(),
        cov = rollup_covered_s_sql(),
        tokens = rollup_tokens_sql(),
    )
}

// ── Rust mirror (unit-testable) ──────────────────────────────────────────────
// Test-only: the production path is the SQL above; this mirrors it so the
// math can be checked without a database.

#[cfg(test)]
pub(crate) mod mirror {
    use super::{MAX_SAMPLE_GAP_S, ROLLUP_BUCKET_S};


    /// One stored telemetry row for a single node.
    #[derive(Clone, Copy, Debug)]
    pub(crate) struct Sample {
        pub ts_s:  f64,
        pub watts: f64,
        pub tok_s: f64,
        pub live:  bool,
    }

    /// Integrated totals over a set of samples (or one rollup bucket).
    #[derive(Clone, Copy, Debug, Default, PartialEq)]
    pub(crate) struct Integral {
        pub covered_s:      f64,
        pub energy_wh:      f64,
        pub live_energy_wh: f64,
        pub live_s:         f64,
        pub tokens:         f64,
    }

    impl Integral {
        pub fn kwh(&self) -> f64 { self.energy_wh / 1000.0 }
            pub fn add(&mut self, o: &Integral) {
            self.covered_s += o.covered_s;
            self.energy_wh += o.energy_wh;
            self.live_energy_wh += o.live_energy_wh;
            self.live_s += o.live_s;
            self.tokens += o.tokens;
        }
    }

    /// Mirror of [`raw_dt_sql`].
    pub(crate) fn sample_dt_s(ts_s: f64, next_ts_s: Option<f64>, now_s: f64) -> f64 {
        (next_ts_s.unwrap_or(now_s) - ts_s).clamp(0.0, MAX_SAMPLE_GAP_S)
    }

    /// Mirror of the raw half of [`energy_base_cte`] / run_rollup's sums.
    /// `samples` must be one node's rows sorted by ts.
    pub(crate) fn integrate_samples(samples: &[Sample], now_s: f64) -> Integral {
        let mut out = Integral::default();
        for (i, s) in samples.iter().enumerate() {
            let dt = sample_dt_s(s.ts_s, samples.get(i + 1).map(|n| n.ts_s), now_s);
            out.covered_s += dt;
            out.energy_wh += s.watts * dt / 3600.0;
            if s.live {
                out.live_s += dt;
                out.live_energy_wh += s.watts * dt / 3600.0;
                out.tokens += s.tok_s * dt;
            }
        }
        out
    }

    /// What one `metrics_5min` row holds (the integral columns are NULL on
    /// rows written before the fix).
    #[derive(Clone, Copy, Debug)]
    pub(crate) struct RollupRow {
        pub watts_avg:    f64,
        pub tok_s_avg:    f64,
        pub duty_pct:     f64,
        pub sample_count: i64,
        pub stored:       Option<Integral>,
    }

    /// Mirror of the rollup half of [`energy_base_cte`].
    pub(crate) fn rollup_bucket_integral(r: &RollupRow) -> Integral {
        if let Some(i) = r.stored { return i; }
        let cov = (r.sample_count as f64 * MAX_SAMPLE_GAP_S).min(ROLLUP_BUCKET_S);
        let duty = r.duty_pct / 100.0;
        Integral {
            covered_s:      cov,
            energy_wh:      r.watts_avg * cov / 3600.0,
            live_energy_wh: r.watts_avg * cov * duty / 3600.0,
            live_s:         cov * duty,
            tokens:         r.tok_s_avg * cov * duty,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::mirror::*;

    const DAY: f64 = 86_400.0;

    /// The pre-fix formula: every row (or rollup sample) counted as 30 s,
    /// tokens counted regardless of state.
    fn legacy_30s(samples: &[Sample]) -> (f64, f64, f64) {
        let kwh: f64 = samples.iter().map(|s| s.watts * 30.0 / 3600.0 / 1000.0).sum();
        let tok: f64 = samples.iter().map(|s| s.tok_s * 30.0).sum();
        let hours = samples.len() as f64 * 30.0 / 3600.0;
        (kwh, tok, hours)
    }

    /// Real push cadence: 1 Hz frames throttled to ≥2 s means pushes land
    /// on a 2 s / 3 s mix; 2,2,3,2,3 ≈ 2.4 s mean — what the observed ~12.5×
    /// inflation implies (30 / 2.4 = 12.5).
    fn series(days: f64, watts: f64, tok_s: f64, live_every: usize) -> Vec<Sample> {
        let steps = [2.0, 2.0, 3.0, 2.0, 3.0];
        let mut out = Vec::new();
        let mut t = 0.0;
        let mut i = 0usize;
        while t < days * DAY {
            out.push(Sample { ts_s: t, watts, tok_s, live: live_every > 0 && i.is_multiple_of(live_every) });
            t += steps[i % steps.len()];
            i += 1;
        }
        out
    }

    #[test]
    fn reproduces_and_fixes_12x_energy_inflation() {
        // GeiserBMC: ~14.9 W steady, no tokens, 30 days.
        let s = series(30.0, 14.9, 0.0, 0);
        let now = s.last().unwrap().ts_s + 2.0;
        let (old_kwh, _, old_hours) = legacy_30s(&s);
        let new = integrate_samples(&s, now);

        // Correct: 14.9 W × 720 h = 10.73 kWh.
        assert!((new.kwh() - 10.728).abs() < 0.01, "kwh {}", new.kwh());
        assert!((new.covered_s / 3600.0 - 720.0).abs() < 0.1);
        // Old formula ~12.5× (≈134 kWh, matching the observed 134.92 kWh).
        let ratio = old_kwh / new.kwh();
        assert!((ratio - 12.5).abs() < 0.05, "ratio {ratio}");
        assert!(old_kwh > 130.0 && old_kwh < 140.0, "old {old_kwh}");
        assert!(old_hours > 8_900.0, "legacy covered hours {old_hours} for a 720 h window");
    }

    #[test]
    fn tokens_integrate_only_live_time() {
        // macmini: ~19.5 tok/s reported continuously (probe baseline while
        // idle), live 1 sample in 25 (4%).
        let s = series(30.0, 0.3, 19.5, 25);
        let now = s.last().unwrap().ts_s + 2.0;
        let (_, old_tok, _) = legacy_30s(&s);
        let new = integrate_samples(&s, now);
        // Old: ≈ 19.5 × 30 × rows ≈ 632M (observed 574M) — ~340 days of
        // nonstop generation inside a 30-day window.
        assert!(old_tok > 500e6, "old tokens {old_tok}");
        // Continuous tok/s × real time is the ceiling: 19.5 × 30 d ≈ 50.5M.
        let ceiling = 19.5 * 30.0 * DAY;
        assert!(new.tokens < ceiling);
        // Live share of samples is 4%; the live dt mix lands within 3–6%.
        let share = new.tokens / ceiling;
        assert!(share > 0.03 && share < 0.06, "live share {share}");
        assert!((new.live_s / new.covered_s - share).abs() < 1e-4);
    }

    #[test]
    fn offline_gap_is_capped_not_billed() {
        // 1 h online at 2 s, 10 h offline, 1 h online.
        let mut s: Vec<Sample> = (0..1800).map(|i| Sample { ts_s: i as f64 * 2.0, watts: 100.0, tok_s: 0.0, live: false }).collect();
        let resume = 11.0 * 3600.0;
        s.extend((0..1800).map(|i| Sample { ts_s: resume + i as f64 * 2.0, watts: 100.0, tok_s: 0.0, live: false }));
        let now = resume + 3600.0;
        let i = integrate_samples(&s, now);
        // 2 h × 100 W = 200 Wh, plus at most one capped 60 s gap (≈1.6 Wh).
        assert!(i.energy_wh >= 199.9 && i.energy_wh <= 201.8, "{}", i.energy_wh);
    }

    #[test]
    fn last_sample_credited_until_now_capped() {
        assert_eq!(sample_dt_s(100.0, Some(102.5), 1e9), 2.5);
        assert_eq!(sample_dt_s(100.0, None, 101.0), 1.0);
        assert_eq!(sample_dt_s(100.0, None, 1e9), MAX_SAMPLE_GAP_S);
        assert_eq!(sample_dt_s(100.0, Some(99.0), 1e9), 0.0); // never negative
    }

    #[test]
    fn duplicate_state_change_pushes_do_not_double_count() {
        // An immediate state-transition push 0.3 s after a regular push adds a
        // row; with dt-weighting it only splits the interval.
        let a = vec![
            Sample { ts_s: 0.0, watts: 50.0, tok_s: 0.0, live: false },
            Sample { ts_s: 2.0, watts: 50.0, tok_s: 0.0, live: false },
            Sample { ts_s: 4.0, watts: 50.0, tok_s: 0.0, live: false },
        ];
        let mut b = a.clone();
        b.insert(2, Sample { ts_s: 2.3, watts: 50.0, tok_s: 0.0, live: false });
        let (ia, ib) = (integrate_samples(&a, 6.0), integrate_samples(&b, 6.0));
        assert!((ia.energy_wh - ib.energy_wh).abs() < 1e-12);
    }

    #[test]
    fn rollup_bucket_new_rows_exact_and_legacy_rows_full_bucket() {
        // A full 5-min bucket at ~2.4 s cadence: 125 rows of 15 W.
        let s = series(300.0 / DAY, 15.0, 0.0, 0);
        assert_eq!(s.len(), 125);
        let exact = integrate_samples(&s, 300.0);
        assert!((exact.covered_s - 300.0).abs() < 1e-9);
        let row = RollupRow { watts_avg: 15.0, tok_s_avg: 0.0, duty_pct: 0.0, sample_count: 125, stored: Some(exact) };
        assert_eq!(rollup_bucket_integral(&row), exact);

        // Pre-fix row: no integral columns. Old math: 125 × 30 s = 3750 s
        // (12.5× a 300 s bucket). Fallback: one full bucket.
        let legacy = RollupRow { stored: None, ..row };
        let i = rollup_bucket_integral(&legacy);
        assert_eq!(i.covered_s, 300.0);
        assert!((i.energy_wh - 1.25).abs() < 1e-9); // 15 W × 5 min
        // A sparse bucket is bounded by the per-row cap.
        let sparse = RollupRow { sample_count: 2, ..legacy };
        assert_eq!(rollup_bucket_integral(&sparse).covered_s, 120.0);
    }

    #[test]
    fn thirty_days_of_legacy_rollups_match_raw_integral() {
        // 30 days of full legacy buckets for a 15 W node == 10.8 kWh.
        let buckets = (30.0 * DAY / ROLLUP_BUCKET_S) as usize;
        let row = RollupRow { watts_avg: 15.0, tok_s_avg: 0.0, duty_pct: 0.0, sample_count: 125, stored: None };
        let mut total = Integral::default();
        for _ in 0..buckets { total.add(&rollup_bucket_integral(&row)); }
        assert!((total.kwh() - 10.8).abs() < 1e-6, "{}", total.kwh());
        // Old: sample_count × 30 s → 135 kWh.
        let old = buckets as f64 * 15.0 * 125.0 * 30.0 / 3600.0 / 1000.0;
        assert!((old - 135.0).abs() < 1e-6);
    }

    #[test]
    fn sql_fragments_have_no_fixed_sample_period() {
        let base = energy_base_cte();
        assert!(!base.contains("* 30.0"), "fixed 30 s sample period crept back in");
        assert!(base.contains("LEAD(ts) OVER (PARTITION BY tenant_id, node_id ORDER BY ts)"));
        assert!(base.contains("NOT EXISTS"));
        assert!(raw_dt_sql().contains("60.0"));
        assert!(rollup_covered_s_sql().contains("LEAST(300.0, sample_count * 60.0)"));
    }
}

/// End-to-end check of the SQL against a real Postgres. Skipped unless
/// WICKLEE_TEST_DATABASE_URL points at a disposable database (CI has none);
/// e.g. `WICKLEE_TEST_DATABASE_URL=postgres://wk@localhost:55432/wk_test`.
/// Uses its own tenant id and deletes only that tenant's rows.
#[cfg(test)]
mod db_tests {
    use super::*;

    const TENANT: &str = "energy-db-test";

    async fn node_energy(pool: &sqlx::PgPool, window: &str) -> Vec<(String, f64, f64, f64)> {
        let sql = format!("{base}
            SELECT node_id, SUM(energy_kwh)::float8, SUM(tokens)::float8, SUM(hours_covered)::float8
            FROM base GROUP BY node_id ORDER BY node_id", base = energy_base_cte());
        sqlx::query_as(&sql).bind(TENANT).bind(window).fetch_all(pool).await.unwrap()
    }

    #[tokio::test]
    async fn reports_integrate_real_cadence_across_raw_and_rollup() {
        let Ok(url) = std::env::var("WICKLEE_TEST_DATABASE_URL") else {
            eprintln!("skipping: WICKLEE_TEST_DATABASE_URL not set");
            return;
        };
        let pool = sqlx::PgPool::connect(&url).await.unwrap();
        crate::run_pg_migrations(&pool).await;
        for t in ["metrics_raw", "metrics_5min"] {
            sqlx::query(&format!("DELETE FROM {t} WHERE tenant_id = $1"))
                .bind(TENANT).execute(&pool).await.unwrap();
        }

        // 26 h of raw rows at the real ~2.4 s push cadence:
        //   WK-A: 15 W idle (GeiserBMC-like), WK-B: 0.3 W, 19.5 tok/s, live 1 row in 25.
        sqlx::query(
            "INSERT INTO metrics_raw (ts, node_id, tenant_id, tok_s, watts, inference_state, ollama_active_model)
             SELECT NOW() - INTERVAL '26 hours' + make_interval(secs => g * 2.4), n.node_id, $1,
                    n.tok_s, n.watts,
                    CASE WHEN n.node_id = 'WK-B' AND g % 25 = 0 THEN 'live' ELSE 'idle-spd' END,
                    n.model
             FROM generate_series(0, (26 * 3600 / 2.4)::int - 1) g,
                  (VALUES ('WK-A', 0.0::real, 15.0::real, NULL::text),
                          ('WK-B', 19.5::real, 0.3::real, 'llama3.1:8b')) n(node_id, tok_s, watts, model)"
        ).bind(TENANT).execute(&pool).await.unwrap();

        // cost-by-model (fleet.rs) uses the same dt rule: WK-B's model ran
        // the trailing 24 h at 0.3 W → 24 h, 7.2 Wh (old: ~300 h).
        let cbm: Vec<(String, Option<f32>, Option<f32>, Option<f64>, Option<f64>, i64)> =
            sqlx::query_as(&crate::cost_by_model_sql())
                .bind(TENANT).bind("24 hours").fetch_all(&pool).await.unwrap();
        assert_eq!(cbm.len(), 1);
        let (hours, wh) = (cbm[0].3.unwrap(), cbm[0].4.unwrap());
        assert!((hours - 24.0).abs() < 0.01, "cost-by-model hours {hours}");
        assert!((wh - 7.2).abs() < 0.01, "cost-by-model Wh {wh}");

        let before = node_energy(&pool, "2 days").await;
        let a = &before[0];
        // 26 h × 15 W = 0.390 kWh (old 30 s math: ≈ 4.9 kWh).
        assert!((a.1 - 0.390).abs() < 0.002, "raw-only kWh {}", a.1);
        assert!((a.3 - 26.0).abs() < 0.01, "raw-only hours {}", a.3);

        // Roll up everything older than 24 h; totals must not change
        // (no gap, no double count across the raw/rollup boundary).
        crate::run_rollup(&pool).await;
        let rolled: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM metrics_5min WHERE tenant_id = $1 AND energy_wh IS NOT NULL")
            .bind(TENANT).fetch_one(&pool).await.unwrap();
        assert!(rolled >= 2 * 20, "expected new-format buckets, got {rolled}");
        let after = node_energy(&pool, "2 days").await;
        for (b, a) in before.iter().zip(&after) {
            assert!((b.1 - a.1).abs() < 0.001, "{} kWh {} → {}", b.0, b.1, a.1);
            assert!((b.2 - a.2).abs() / b.2.max(1.0) < 0.01, "{} tokens {} → {}", b.0, b.2, a.2);
            assert!((b.3 - a.3).abs() < 0.02, "{} hours {} → {}", b.0, b.3, a.3);
        }

        // Legacy (pre-fix) rollups for the rest of the 30 days: integral
        // columns NULL, 125 rows per bucket at ~2.4 s.
        sqlx::query(
            "INSERT INTO metrics_5min (ts, node_id, tenant_id, tok_s_avg, watts_avg, inference_duty_pct, sample_count, ollama_active_model)
             SELECT b, n.node_id, $1, n.tok_s, n.watts, n.duty, 125, n.model
             FROM generate_series(
                    to_timestamp(floor(EXTRACT(EPOCH FROM NOW() - INTERVAL '30 days') / 300) * 300 + 300),
                    (SELECT MIN(ts) FROM metrics_5min WHERE tenant_id = $1) - INTERVAL '5 minutes',
                    INTERVAL '5 minutes') b,
                  (VALUES ('WK-A', 0.0::real, 15.0::real, 0.0::real, NULL::text),
                          ('WK-B', 19.5::real, 0.3::real, 4.0::real, 'llama3.1:8b')) n(node_id, tok_s, watts, duty, model)"
        ).bind(TENANT).execute(&pool).await.unwrap();

        let month = node_energy(&pool, "30 days").await;
        let (a, b) = (&month[0], &month[1]);
        // 15 W × 720 h = 10.8 kWh — was 134.9 kWh in production.
        assert!((a.1 - 10.8).abs() < 0.02, "WK-A 30d kWh {}", a.1);
        assert!((a.3 - 720.0).abs() < 0.5, "WK-A 30d hours {}", a.3);
        // 0.3 W × 720 h = 0.216 kWh; tokens = 19.5 tok/s × ~4% of 30 d ≈ 2.0M
        // (old math counted the idle probe baseline at 30 s/row: ≈ 630M).
        assert!((b.1 - 0.216).abs() < 0.002, "WK-B 30d kWh {}", b.1);
        assert!(b.2 > 1.8e6 && b.2 < 2.2e6, "WK-B 30d tokens {}", b.2);

        // Idle-waste uses the same base: WK-B's loaded-but-idle model.
        let report = crate::compute_idle_waste(&pool, TENANT, 30, 0.16).await;
        let t = &report["totals"];
        let phantom_kwh = t["phantom_kwh"].as_f64().unwrap();
        assert!((phantom_kwh - 0.216 * 0.96).abs() < 0.003, "phantom kWh {phantom_kwh}");
        let action = &report["actions"][0];
        assert_eq!(action["model"], "llama3.1:8b");
        let idle_h = action["idle_hours"].as_f64().unwrap();
        assert!(idle_h > 680.0 && idle_h < 720.0, "idle hours {idle_h} (old math: ~9000)");

        for t in ["metrics_raw", "metrics_5min"] {
            sqlx::query(&format!("DELETE FROM {t} WHERE tenant_id = $1"))
                .bind(TENANT).execute(&pool).await.unwrap();
        }
    }
}
